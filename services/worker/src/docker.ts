import { Agent, request as httpsRequest, type RequestOptions } from 'node:https';
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
/**
 * Split a Docker stdcopy stream into stdout and stderr.
 *
 * Frames are `[stream, 0, 0, 0, len32be]` then `len` bytes. A stream that is not
 * framed at all (a TTY exec, which we never ask for) has no headers, so a buffer
 * whose first byte is not 1 or 2 is returned verbatim on stdout rather than
 * silently decoded as garbage.
 */
export function demux(buf: Buffer): { stdout: string; stderr: string } {
  if (buf.length === 0) return { stdout: '', stderr: '' };
  if (buf[0] !== 1 && buf[0] !== 2) return { stdout: buf.toString('utf8'), stderr: '' };
  const out: Buffer[] = []; const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const stream = buf[i];
    const len = buf.readUInt32BE(i + 4);
    const start = i + 8;
    const end = Math.min(start + len, buf.length);
    (stream === 2 ? err : out).push(buf.subarray(start, end));
    i = end;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

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

  /**
   * One pooled agent per client, with a hard socket ceiling.
   *
   * Without this, every call goes through Node's *global* https agent — which has
   * had `keepAlive: true` on by default since Node 19 — so a burst of calls opens
   * an unbounded number of TLS connections to the node and leaves them parked.
   * A test suite doing ~130 provisioning operations was enough to break the
   * node's listener for good: every subsequent connection was reset, from our
   * client *and* from the `docker` CLI, until the whole engine was restarted.
   *
   * Two reasons this is the right fix rather than a workaround for one flaky
   * local setup. A mTLS handshake per call is real CPU on both ends, and the
   * worker talks to its nodes constantly — reuse is the point of keepAlive. And a
   * control plane that can open unbounded connections to a data node is a control
   * plane that can take that node down by accident; the ceiling means a runaway
   * loop queues instead of exhausting the far side.
   *
   * `maxSockets` is deliberately small: the saga is step-serial per project, and
   * the concurrency that matters is across projects, which is bounded by the
   * worker's own job concurrency well below this.
   */
  const agent = new Agent({
    keepAlive: true,
    keepAliveMsecs: 10_000,
    maxSockets: 8,
    maxFreeSockets: 4,
    timeout: cfg.timeoutMs ?? 30_000,
    ...tls,
  });

  function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const opts: RequestOptions = {
      host: cfg.host, port: cfg.port, path, method, ...tls, agent,
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

  /**
   * Same request, body returned as bytes instead of parsed JSON.
   *
   * Needed for the hijacked exec stream, which is not JSON and whose framing has
   * to survive intact — decoding it as UTF-8 first would mangle the binary
   * headers before `demux` ever sees them.
   */
  function callRaw(method: string, path: string, body?: unknown): Promise<Buffer> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const opts: RequestOptions = {
      host: cfg.host, port: cfg.port, path, method, ...tls, agent,
      timeout: cfg.timeoutMs ?? 30_000,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
    };
    return new Promise<Buffer>((resolve, reject) => {
      const req = httpsRequest(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve(buf);
          else reject(new DockerError(status, `${method} ${path} → ${status}: ${buf.toString('utf8')}`));
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`${method} ${path} timed out`)); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    /**
     * Close parked keep-alive sockets. Tests call it in afterAll; a long-running
     * worker never needs to, which is why it is not a lifecycle requirement.
     */
    close(): void { agent.destroy(); },

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

    /** Every volume on the node, optionally filtered by label. */
    async listVolumes(labelFilter?: string): Promise<VolumeSummary[]> {
      const filters = labelFilter
        ? `?filters=${encodeURIComponent(JSON.stringify({ label: [labelFilter] }))}` : '';
      const res = await call<{ Volumes: VolumeSummary[] | null }>('GET', `/volumes${filters}`);
      return res.Volumes ?? [];
    },

    async removeVolume(name: string): Promise<void> {
      try { await call('DELETE', `/volumes/${encodeURIComponent(name)}`); }
      catch (e) { if (!(e instanceof DockerError && e.isNotFound)) throw e; }
    },

    /**
     * A project's private network.
     *
     * Idempotent by catching 409: two workers racing the same provision must not
     * turn "it already exists" into a failure, and the Engine has no
     * create-if-absent. `CheckDuplicate` is not enough on its own — it races.
     */
    async createNetwork(name: string, labels: Record<string, string> = {}): Promise<void> {
      try {
        await call('POST', '/networks/create', {
          Name: name,
          // bridge is the only driver a single node needs; overlay would require
          // swarm mode, which this architecture deliberately does not use (D-052).
          Driver: 'bridge',
          CheckDuplicate: true,
          Labels: labels,
          // Internal would block egress from the project's containers entirely.
          // Postgres needs none, but PostgREST and the pooler are on this network
          // too and a project that cannot reach a DNS server is a support ticket.
          Internal: false,
        });
      } catch (e) {
        if (e instanceof DockerError && e.statusCode === 409) return;   // already there
        throw e;
      }
    },

    async networkExists(name: string): Promise<boolean> {
      try { await call('GET', `/networks/${encodeURIComponent(name)}`); return true; }
      catch (e) { if (e instanceof DockerError && e.isNotFound) return false; throw e; }
    },

    async inspectNetwork(name: string): Promise<NetworkInspect | undefined> {
      try { return await call<NetworkInspect>('GET', `/networks/${encodeURIComponent(name)}`); }
      catch (e) { if (e instanceof DockerError && e.isNotFound) return undefined; throw e; }
    },

    /** Every network on the node, optionally filtered by label. */
    async listNetworks(labelFilter?: string): Promise<NetworkSummary[]> {
      const filters = labelFilter
        ? `?filters=${encodeURIComponent(JSON.stringify({ label: [labelFilter] }))}` : '';
      return await call<NetworkSummary[]>('GET', `/networks${filters}`);
    },

    /**
     * Remove a network. A 403 means containers are still attached, which is a
     * real condition the purge saga has to see rather than swallow — silently
     * succeeding would leave the network behind and report it gone.
     */
    async removeNetwork(name: string): Promise<void> {
      try { await call('DELETE', `/networks/${encodeURIComponent(name)}`); }
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

    /**
     * Remove a container. `v=0` — anonymous volumes are kept — is the default and
     * is not negotiable for project containers: `corebase/postgres` declares
     * `VOLUME /var/lib/postgresql/data`, so `v=1` on a project would delete a
     * customer's database along with the container.
     *
     * `withAnonymousVolumes` exists for the opposite case, which that same
     * `VOLUME` declaration creates: a container started from the image with **no**
     * mount gets an anonymous volume, and with `v=0` that volume outlives it
     * forever. The capability probe and the cgroup suite both do exactly that, and
     * each run left a 64-hex volume behind — which reconciliation then reported,
     * correctly, as an orphan occupying disk with no owner. Only ever pass true for
     * a container you created with no mounts.
     */
    async removeContainer(
      id: string, force = true, withAnonymousVolumes = false,
    ): Promise<void> {
      const v = withAnonymousVolumes ? 1 : 0;
      try {
        await call('DELETE',
          `/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=${v}`);
      } catch (e) { if (!(e instanceof DockerError && e.isNotFound)) throw e; }
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

    /**
     * Exec, with the command's output.
     *
     * `exec` above returns only an exit code, which is all a readiness poll
     * needs. Verifying cgroup limits needs the *value* the kernel is actually
     * enforcing, not a claim from `docker inspect` — inspect echoes what we
     * asked for whether or not the engine applied it, so it can only ever confirm
     * our own request. `/sys/fs/cgroup/...` is the kernel's answer.
     *
     * The engine hijacks the connection for a non-detached start and sends
     * stdcopy frames: an 8-byte header per chunk whose first byte is the stream
     * (1 stdout, 2 stderr) and whose last four are a big-endian length.
     */
    async execCapture(
      id: string, cmd: string[],
    ): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
      let created: { Id: string };
      try {
        created = await call<{ Id: string }>(
          'POST', `/containers/${encodeURIComponent(id)}/exec`,
          { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
      } catch (e) {
        if (e instanceof DockerError && notExecable(e)) return { exitCode: null, stdout: '', stderr: '' };
        throw e;
      }
      const raw = await callRaw('POST', `/exec/${created.Id}/start`,
        { Detach: false, Tty: false });
      const { stdout, stderr } = demux(raw);
      // The engine reports a runtime failure to *launch* the exec on the stream
      // itself, with a 200 — so a caller that trusts stdout reads
      //   "OCI runtime exec failed: ... unable to spawn stage-1: Resource
      //    temporarily unavailable"
      // as the command's output. That is not a hypothetical: a container sitting
      // at its `pids.max` cannot fork, so every exec into it fails this way, and
      // a test asserting on a cgroup value happily asserted against the error
      // text instead. An error that arrives as data is worse than an error.
      if (/^OCI runtime exec failed/.test(stdout) || /^OCI runtime exec failed/.test(stderr)) {
        throw new DockerError(500, `exec ${cmd.join(' ')}: ${(stdout || stderr).trim()}`);
      }
      const st = await call<{ ExitCode: number | null }>('GET', `/exec/${created.Id}/json`);
      return { exitCode: st.ExitCode ?? -1, stdout, stderr };
    },

    /**
     * One memory/CPU sample for a container.
     *
     * `one-shot` on purpose. Without it the engine holds the request open for a
     * second so it can compute a CPU delta for you, which at two containers per
     * project and a hundred projects is over three minutes of waiting to read two
     * hundred numbers. CPU is cumulative in the payload, so two one-shot samples
     * a known interval apart give the same delta without the engine pausing for
     * each one.
     *
     * On cgroup v2 `usage` includes page cache, which is the wrong number for
     * "what does a project cost" — cache is reclaimable, and a node under
     * pressure gets it back. `stats.anon` is the working set that cannot be
     * reclaimed, and it is what M-001 measured, so it stays comparable.
     */
    async containerStats(id: string): Promise<ContainerStats> {
      return call<ContainerStats>(
        'GET', `/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=true`);
    },

    /**
     * A stopped container's output. Same stdcopy framing as exec.
     *
     * Used by the node capability probe, which needs a value out of a container
     * that has already exited — `exec` cannot reach one, and an exit code alone
     * cannot carry an answer that is not boolean forever.
     */
    async containerLogs(id: string): Promise<string> {
      const raw = await callRaw(
        'GET', `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=20`);
      const { stdout, stderr } = demux(raw);
      return stdout + stderr;
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
  /** Per-network endpoint details; `IPAddress` is how we identify a container's
   *  own connections in a database's `pg_stat_activity` (P2c). */
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  Config: { Image: string; Labels: Record<string, string> };
  HostConfig: {
    Memory: number; MemorySwap: number; NanoCpus: number;
    PidsLimit?: number; BlkioWeight?: number;
    RestartPolicy: { Name: string };
  };
}
/** The subset of Docker's stats payload this codebase reads. */
export interface ContainerStats {
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: Record<string, number>;
  };
  cpu_stats?: { cpu_usage?: { total_usage?: number } };
  pids_stats?: { current?: number };
}
export interface VolumeSummary {
  Name: string; Labels: Record<string, string> | null;
}
export interface ContainerSummary {
  Id: string; Names: string[]; State: string; Labels: Record<string, string>;
}
export interface ContainerSpec {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  /** Optional: `Cmd` for containers whose image needs an argument list. */
  Cmd?: string[];
  HostConfig: {
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    /**
     * The rest of D-055's control set (P2f). Optional in the type but not in
     * practice — `buildContainerSpec` always sets them; a caller that wants a
     * container without a wall has to say so, rather than getting one by
     * forgetting a field.
     */
    PidsLimit?: number;
    BlkioWeight?: number;
    BlkioDeviceReadBps?: Array<{ Path: string; Rate: number }>;
    BlkioDeviceWriteBps?: Array<{ Path: string; Rate: number }>;
    /**
     * Run a real init as PID 1 (Docker ships tini) instead of the entrypoint.
     *
     * Not a nicety. Without it the postmaster *is* PID 1, so it inherits every
     * orphaned process in the namespace — and pgBackRest's async archiver
     * double-forks, which reparents its worker to the postmaster. A worker that
     * exits non-zero then reads to Postgres as one of its own backends crashing,
     * and Postgres does what it must on a backend crash: kills every session and
     * reinitialises the cluster (P3b, D-270).
     */
    Init?: boolean;
    RestartPolicy: { Name: string };
    Mounts: Array<{ Type: string; Source: string; Target: string }>;
    PortBindings: Record<string, Array<{ HostPort: string }>>;
  };
  ExposedPorts: Record<string, Record<string, never>>;
  /**
   * Joining the network at *create* time rather than connecting afterwards. A
   * container that starts before it is attached can resolve nothing for the first
   * moments of its life, and for the pooler that window is exactly when it tries
   * to reach `db`.
   */
  NetworkingConfig?: {
    EndpointsConfig: Record<string, { Aliases?: string[] }>;
  };
}

export interface NetworkSummary {
  Name: string;
  Id: string;
  Labels: Record<string, string> | null;
}

export interface NetworkInspect {
  Name: string;
  Id: string;
  Labels: Record<string, string> | null;
  Containers?: Record<string, { Name: string }>;
}
