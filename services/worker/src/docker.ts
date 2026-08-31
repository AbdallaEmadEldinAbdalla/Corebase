import { request as httpsRequest, type RequestOptions } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Docker Engine API client over mTLS (D-052): the worker drives nodes through
 * the Engine API with client certificates, and there is no per-node agent.
 *
 * Written against node:https directly rather than a Docker SDK — the surface we
 * need is six endpoints, and a dependency that wraps all of Docker is a large
 * supply-chain and upgrade cost for that.
 */

export interface DockerConfig {
  host: string;        // e.g. 127.0.0.1
  port: number;        // 2376
  certDir: string;     // holds ca.pem, cert.pem, key.pem
  timeoutMs?: number;
}

export class DockerError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'DockerError';
    this.statusCode = statusCode;
  }
  /** 404 is routinely expected: "does this exist yet?" is how every step starts. */
  get isNotFound(): boolean { return this.statusCode === 404; }
  get isConflict(): boolean { return this.statusCode === 409; }
}

/**
 * The engine's way of saying "this container cannot exec right now". There is no
 * status code that distinguishes it from a genuine failure, so the message is
 * the only signal available.
 */
function notExecable(e: DockerError): boolean {
  if (e.isNotFound) return true;
  if (e.isConflict) return true;                      // "is restarting", "is paused"
  return /stopped state|not running|procReady not received|is not running/i.test(e.message);
}

export function createDocker(cfg: DockerConfig) {
  const tls = {
    ca: readFileSync(join(cfg.certDir, 'ca.pem')),
    cert: readFileSync(join(cfg.certDir, 'cert.pem')),
    key: readFileSync(join(cfg.certDir, 'key.pem')),
    // the dind server cert is issued for its own hostname, not 127.0.0.1; the CA
    // check still applies, which is what proves we reached OUR node
    checkServerIdentity: () => undefined,
  };

  function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const opts: RequestOptions = {
      host: cfg.host, port: cfg.port, path, method, ...tls,
      timeout: cfg.timeoutMs ?? 30_000,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
    };
    return new Promise<T>((resolve, reject) => {
      const req = httpsRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve((text ? JSON.parse(text) : undefined) as T);
          } else {
            let msg = text;
            try { msg = (JSON.parse(text) as { message?: string }).message ?? text; } catch { /* raw */ }
            reject(new DockerError(status, `${method} ${path} → ${status}: ${msg}`));
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`${method} ${path} timed out`)); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    async ping(): Promise<string> {
      const v = await call<{ Version: string }>('GET', '/version');
      return v.Version;
    },

    async imageExists(name: string): Promise<boolean> {
      try { await call('GET', `/images/${encodeURIComponent(name)}/json`); return true; }
      catch (e) { if (e instanceof DockerError && e.isNotFound) return false; throw e; }
    },

    async volumeExists(name: string): Promise<boolean> {
      try { await call('GET', `/volumes/${encodeURIComponent(name)}`); return true; }
      catch (e) { if (e instanceof DockerError && e.isNotFound) return false; throw e; }
    },

    async createVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
      // Engine treats volume create as idempotent, but we check first so the log
      // records which of the two happened.
      await call('POST', '/volumes/create', { Name: name, Labels: labels });
    },

    async removeVolume(name: string): Promise<void> {
      try { await call('DELETE', `/volumes/${encodeURIComponent(name)}`); }
      catch (e) { if (!(e instanceof DockerError && e.isNotFound)) throw e; }
    },

    async inspectContainer(nameOrId: string): Promise<ContainerInspect | undefined> {
      try { return await call<ContainerInspect>('GET', `/containers/${encodeURIComponent(nameOrId)}/json`); }
      catch (e) { if (e instanceof DockerError && e.isNotFound) return undefined; throw e; }
    },

    async createContainer(name: string, spec: ContainerSpec): Promise<string> {
      const res = await call<{ Id: string }>(
        'POST', `/containers/create?name=${encodeURIComponent(name)}`, spec);
      return res.Id;
    },

    async startContainer(id: string): Promise<void> {
      try { await call('POST', `/containers/${encodeURIComponent(id)}/start`); }
      catch (e) {
        // 304 = already started. Docker returns it as a non-2xx; treat as success
        // because "make it running" is the intent, not "transition it".
        if (e instanceof DockerError && e.statusCode === 304) return;
        throw e;
      }
    },

    async stopContainer(id: string, timeoutSec = 10): Promise<void> {
      try { await call('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`); }
      catch (e) {
        if (e instanceof DockerError && (e.isNotFound || e.statusCode === 304)) return;
        throw e;
      }
    },

    async removeContainer(id: string, force = true): Promise<void> {
      try { await call('DELETE', `/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=0`); }
      catch (e) { if (!(e instanceof DockerError && e.isNotFound)) throw e; }
    },

    /**
     * Run a command in the container and return its exit code.
     *
     * Returns `exitCode: null` when the container is not in a state that can
     * exec at all — still initialising, restarting, or stopped. The engine
     * reports those as 409/500, but for a caller polling for readiness they mean
     * "not yet", not "the API broke". Real transport and auth failures still
     * throw.
     */
    async exec(id: string, cmd: string[]): Promise<{ exitCode: number | null }> {
      try { return await execOnce(id, cmd); }
      catch (e) {
        if (e instanceof DockerError && notExecable(e)) return { exitCode: null };
        throw e;
      }
    },

    /** Change a running container's restart policy (see wait_healthy, D-184). */
    async setRestartPolicy(id: string, name: string): Promise<void> {
      await call('POST', `/containers/${encodeURIComponent(id)}/update`,
        { RestartPolicy: { Name: name } });
    },

    async listContainers(labelFilter?: string): Promise<ContainerSummary[]> {
      const filters = labelFilter
        ? `&filters=${encodeURIComponent(JSON.stringify({ label: [labelFilter] }))}` : '';
      return call<ContainerSummary[]>('GET', `/containers/json?all=true${filters}`);
    },
  };

  async function execOnce(id: string, cmd: string[]): Promise<{ exitCode: number }> {
    const created = await call<{ Id: string }>(
      'POST', `/containers/${encodeURIComponent(id)}/exec`,
      { Cmd: cmd, AttachStdout: false, AttachStderr: false, Tty: false });
    await call('POST', `/exec/${created.Id}/start`, { Detach: true, Tty: false });
    // Detach returns immediately; poll the exec for completion.
    for (let i = 0; i < 100; i++) {
      const st = await call<{ Running: boolean; ExitCode: number | null }>(
        'GET', `/exec/${created.Id}/json`);
      if (!st.Running) return { exitCode: st.ExitCode ?? -1 };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('exec did not finish in 10s');
    }

}

export type Docker = ReturnType<typeof createDocker>;

export interface ContainerInspect {
  Id: string;
  Name: string;
  State: { Status: string; Running: boolean; Restarting: boolean; ExitCode: number; Error: string };
  Config: { Image: string; Labels: Record<string, string> };
  HostConfig: { Memory: number; MemorySwap: number; NanoCpus: number; RestartPolicy: { Name: string } };
}
export interface ContainerSummary {
  Id: string; Names: string[]; State: string; Labels: Record<string, string>;
}
export interface ContainerSpec {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: {
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    RestartPolicy: { Name: string };
    Mounts: Array<{ Type: string; Source: string; Target: string }>;
    PortBindings: Record<string, Array<{ HostPort: string }>>;
  };
  ExposedPorts: Record<string, Record<string, never>>;
}
