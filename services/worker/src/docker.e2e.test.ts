import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { createDocker, DockerError, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import {
  containerName, bootstrapPassword, IMAGE, LABEL_MANAGED, PIDS_LIMIT,
} from './container-spec.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * T5d integration: the provisioning saga against the real data node.
 *
 * This is the first sub-step where a step reaches outside Postgres, so the
 * interesting assertions are the failure modes — a container that exits while
 * starting, a step re-run after a partial success, cgroup limits that must
 * actually be on the container and not just in the spec object.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const CERT_DIR = process.env.SH_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.SH_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SH_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

let pool: Pool; let docker: Docker; let orgId: string;
let up = false; let reason = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('D','d-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('T5d integration setup FAILED:', reason);
    up = false;
  }
}, 40_000);

/** Everything this suite creates on the node, so a failed run cannot leak state. */
const created = { containers: new Set<string>(), volumes: new Set<string>() };

afterAll(async () => {
  if (up) {
    for (const c of created.containers) await docker.removeContainer(c).catch(() => {});
    for (const v of created.volumes) await docker.removeVolume(v).catch(() => {});
  }
  await pool?.end();
  // Release the client's keep-alive sockets. Each test file builds its own Docker
  // client, so without this every file leaves up to maxSockets parked connections
  // to the node for the rest of the run — which is how the node's listener ended
  // up wedged even after the agent was bounded (D-230).
  docker?.close?.();
}, 60_000);

async function wipeNode() {
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id).catch(() => {});
  }
    // Networks too (P2a). Containers and volumes were already cleaned here;
    // a leaked network is quieter and worse in one specific way — each bridge
    // network holds a subnet from Docker's address pool, and eighteen leaked ones
    // from failed runs is how a node stops being able to create the next project.
    for (const n of await docker.listNetworks(`${LABEL_MANAGED}=true`)) {
      await docker.removeNetwork(n.Name).catch(() => {});
    }
  for (const v of created.volumes) await docker.removeVolume(v).catch(() => {});
  created.volumes.clear();
}

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects, nodes cascade');
  // Containers outlive the control-plane rows: they hold the host port, so a
  // truncate alone leaves the next test unable to bind. (Cleaning this up for
  // real projects is T8's reconciliation sweep.)
  await wipeNode();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 90_000) =>
  it(n, async () => {
    if (!up) throw new Error(
      `data node or staging PG not reachable (${reason}) — run ./scripts/staging.sh up && ` +
      './scripts/staging.sh seed-images. These tests are the T5d done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'd' + String(Date.now() % 100000) + String(++seq).padStart(14, 'x');

async function mkProject(plan = 'free') {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan)
     values ($1,$2,$3,$4::project_plan) returning id, ref::text as ref`,
    [orgId, ref, 'proj-' + seq, plan]);
  created.containers.add(containerName(ref));
  return rows[0]!;
}

/** Run named steps of the provisioning saga directly — the runner is T5b's job. */
async function runSteps(projectId: string, names: string[], extra: Record<string, unknown> = {}) {
  const sagas = buildSagas({ pool, docker, bootstrapSecret: SECRET, healthTimeoutMs: 60_000, ...extra });
  const steps = sagas['provision_project']!;
  const logs: string[] = [];
  const job = { id: 'j', project_id: projectId } as unknown as JobRecord;
  for (const name of names) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`no step named ${name}`);
    await step.run({ job, log: (m, e) => logs.push(m + (e ? ' ' + JSON.stringify(e) : '')) });
  }
  return logs;
}

const placement = async (projectId: string) => (await pool.query<{
  volume_name: string; container_id: string | null; port: number; ram_limit_mb: number; status: string;
}>(`select volume_name, container_id, port, ram_limit_mb, status
      from project_databases where project_id = $1`, [projectId])).rows[0]!;

describe('T5d — Docker Engine API client', () => {
  t('answers over mTLS and reports the engine version', async () => {
    expect(await docker.ping()).toMatch(/^\d+\.\d+/);
  }, 20_000);

  t('the node rejects a caller that presents no client certificate', async () => {
    // Proves the mTLS wall is real and not merely configured: same host, same
    // port, our CA trusted, but no client identity — the engine must refuse.
    // (createDocker cannot express this; it requires a cert to construct, which
    // is itself the behaviour we want.)
    const err = await new Promise<Error | undefined>((resolve) => {
      const req = httpsRequest({
        host: HOST, port: PORT, path: '/version', method: 'GET', timeout: 5_000,
        ca: readFileSync(join(CERT_DIR, 'ca.pem')),
        checkServerIdentity: () => undefined,
      }, (res) => resolve(new Error(`answered without a client cert: ${res.statusCode}`)));
      req.on('error', (e) => resolve(e));
      req.on('timeout', () => { req.destroy(new Error('timed out')); });
      req.end();
    });
    expect(err).toBeDefined();
    expect(err!.message).not.toMatch(/answered without a client cert/);
  }, 20_000);

  t('a client built on a missing cert directory fails loudly at construction', async () => {
    // Misconfiguration must surface at startup, not as a mysterious provisioning
    // failure on the first job.
    expect(() => createDocker({ host: HOST, port: PORT, certDir: '/nonexistent' }))
      .toThrow(/ca\.pem/);
  }, 20_000);

  t('reports missing images and volumes as absent, not as errors', async () => {
    expect(await docker.imageExists(IMAGE)).toBe(true);
    expect(await docker.imageExists('steadhold/definitely-not-here:0')).toBe(false);
    expect(await docker.volumeExists('sh-vol-does-not-exist')).toBe(false);
    expect(await docker.inspectContainer('sh-not-a-container')).toBeUndefined();
  }, 20_000);

  t('surfaces non-404 engine failures as DockerError', async () => {
    // An invalid spec is a 400/500 from the engine — it must not be swallowed
    // into a false "does not exist".
    const err = await docker
      .createContainer('sh-bad-spec', { Image: '' } as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).isNotFound).toBe(false);
  }, 20_000);

  t('volume create then remove is idempotent in both directions', async () => {
    const name = 'sh-vol-idem-test';
    created.volumes.add(name);
    await docker.createVolume(name, { [LABEL_MANAGED]: 'true' });
    await docker.createVolume(name, { [LABEL_MANAGED]: 'true' }); // again: no throw
    expect(await docker.volumeExists(name)).toBe(true);
    await docker.removeVolume(name);
    await docker.removeVolume(name);                              // again: no throw
    expect(await docker.volumeExists(name)).toBe(false);
  }, 30_000);
});

describe('T5d — container steps of the provisioning saga', () => {
  t('provisions a project database that accepts connections', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();

    const logs = await runSteps(p.id, ['allocate_node', 'create_volume', 'start_container', 'wait_healthy']);

    const row = await placement(p.id);
    created.volumes.add(row.volume_name);
    expect(row.container_id).toBeTruthy();
    expect(row.status).toBe('running');

    const inspect = await docker.inspectContainer(row.container_id!);
    expect(inspect!.State.Running).toBe(true);
    expect(inspect!.Config.Image).toBe(IMAGE);
    expect(logs.join('\n')).toContain('database accepting connections');
  });

  t('applies the plan cgroup limits to the running container', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node', 'create_volume', 'start_container']);
    const row = await placement(p.id);
    created.volumes.add(row.volume_name);

    const inspect = await docker.inspectContainer(row.container_id!);
    expect(inspect!.HostConfig.Memory).toBe(row.ram_limit_mb * 1024 * 1024);
    expect(inspect!.HostConfig.NanoCpus).toBeGreaterThan(0);
    // Swap disabled: a project that exceeds its RAM must be OOM-killed, not
    // allowed to thrash the whole node's disk (D-069).
    expect(inspect!.HostConfig.MemorySwap).toBe(row.ram_limit_mb * 1024 * 1024);

    // ...and the same numbers read back from the kernel, on the container the
    // saga actually provisioned (P2f). Everything above is `docker inspect`
    // echoing the HostConfig we sent, which cannot distinguish "applied" from
    // "accepted and ignored" — the I/O weight was accepted by create and then
    // refused by runc at start, and no inspect-based assertion could have seen
    // it. cgroups.e2e.test.ts covers the walls in depth; this pins that the
    // provisioning path, not just a hand-built spec, ends up behind them.
    const cg = async (f: string) => (await docker.execCapture(
      row.container_id!, ['sh', '-c', `cat /sys/fs/cgroup/${f} 2>/dev/null`])).stdout.trim();
    expect(await cg('memory.max')).toBe(String(row.ram_limit_mb * 1024 * 1024));
    expect(await cg('memory.swap.max')).toBe('0');
    expect(await cg('pids.max')).toBe(String(PIDS_LIMIT));
  });

  t('the restart policy is only attached once the database answers (D-184)', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node', 'create_volume', 'start_container']);
    const row = await placement(p.id);
    created.volumes.add(row.volume_name);

    // Before the health gate: no policy, so a container that cannot initialise
    // dies once and stays dead instead of flapping.
    expect((await docker.inspectContainer(row.container_id!))!.HostConfig.RestartPolicy.Name)
      .toBe('no');

    await runSteps(p.id, ['wait_healthy']);
    expect((await docker.inspectContainer(row.container_id!))!.HostConfig.RestartPolicy.Name)
      .toBe('unless-stopped');
  });

  t('the bootstrap password is recoverable from the secret after a crash', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node', 'create_volume', 'start_container', 'wait_healthy']);
    const row = await placement(p.id);
    created.volumes.add(row.volume_name);

    // Nothing persisted this password — it is derived. A worker that died before
    // T5e stored credentials must still be able to log in and finish the job.
    const pw = bootstrapPassword(SECRET, p.id);
    const { exitCode } = await docker.exec(row.container_id!,
      ['psql', `postgresql://postgres:${pw}@127.0.0.1:5432/postgres`, '-tAc', 'select 1']);
    expect(exitCode).toBe(0);

    // The negative half matters more than the positive one: loopback inside the
    // container must not be a password-free superuser login (D-185).
    const wrong = await docker.exec(row.container_id!,
      ['psql', 'postgresql://postgres:not-the-password@127.0.0.1:5432/postgres', '-tAc', 'select 1']);
    expect(wrong.exitCode).not.toBe(0);
  });

  t('the provisioned database grants trust authentication to nobody (D-185)', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node', 'create_volume', 'start_container', 'wait_healthy']);
    const row = await placement(p.id);
    created.volumes.add(row.volume_name);

    const trust = await docker.exec(row.container_id!, ['sh', '-c',
      "psql -U postgres -tAc \"select count(*) from pg_hba_file_rules where auth_method='trust'\" | grep -qx 0"]);
    expect(trust.exitCode).toBe(0);
  });

  t('re-running every container step is a no-op on the same container', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node', 'create_volume', 'start_container', 'wait_healthy']);
    const first = await placement(p.id);
    created.volumes.add(first.volume_name);

    const logs = await runSteps(p.id, ['create_volume', 'start_container', 'wait_healthy']);
    const second = await placement(p.id);

    expect(second.container_id).toBe(first.container_id);
    expect(logs.join('\n')).toContain('volume already exists');
    expect(logs.join('\n')).toContain('container already running');
    const all = await docker.listContainers(`${LABEL_MANAGED}=true`);
    expect(all.filter((c) => c.Names.some((n) => n === '/' + containerName(p.ref)))).toHaveLength(1);
  });

  t('start_container resumes a container that was created but never started', async () => {
    // The crash window between create and start. The step must find the existing
    // container and start it, not create a second one and not fail on the name
    // conflict.
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node', 'create_volume']);
    const row0 = await placement(p.id);
    created.volumes.add(row0.volume_name);

    const spec = (await import('./container-spec.ts')).buildContainerSpec({
      ref: p.ref, projectId: p.id, volumeName: row0.volume_name,
      hostPort: row0.port, ramLimitMb: row0.ram_limit_mb, bootstrapSecret: SECRET,
    });
    const orphanId = await docker.createContainer(containerName(p.ref), spec);
    expect((await docker.inspectContainer(orphanId))!.State.Running).toBe(false);

    const logs = await runSteps(p.id, ['start_container']);
    const row = await placement(p.id);
    expect(row.container_id).toBe(orphanId);
    expect((await docker.inspectContainer(orphanId))!.State.Running).toBe(true);
    expect(logs.join('\n')).toContain('container already exists');
  });

  t('wait_healthy fails fast when the container exits while starting', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node', 'create_volume']);
    const row0 = await placement(p.id);
    created.volumes.add(row0.volume_name);

    // A container with no bootstrap password: the Postgres entrypoint refuses to
    // initialise and exits. wait_healthy must report that, not poll to the
    // timeout — the difference between a 3s failure and a 60s one.
    const id = await docker.createContainer(containerName(p.ref), {
      Image: IMAGE, Env: ['PGDATA=/var/lib/postgresql/data/pgdata'],
      Labels: { [LABEL_MANAGED]: 'true' },
      HostConfig: {
        Memory: 268435456, MemorySwap: 268435456, NanoCpus: 500000000,
        RestartPolicy: { Name: 'no' }, Mounts: [], PortBindings: {},
      },
      ExposedPorts: {},
    });
    await docker.startContainer(id);
    await pool.query(`update project_databases set container_id=$2 where project_id=$1`, [p.id, id]);

    // Wait for it to be *actually* gone before probing, which removes a race this
    // test used to depend on. `exec` against an exited container throws rather
    // than returning a non-zero code, so whether wait_healthy saw a failed probe
    // or an Engine error came down to which happened first — the probe locally,
    // the exit on a faster CI runner. That made the same assertion pass on one
    // machine and fail on the other, and hid a real bug: the raw `POST /exec/…`
    // error escaped the health loop and became the step's failure, so an operator
    // saw an Engine URL instead of "container exited while starting".
    //
    // Pinning the harder case rather than the convenient one: every machine now
    // takes the path where the probe cannot run at all.
    for (let i = 0; i < 60; i++) {
      const st = await docker.inspectContainer(id);
      if (st && !st.State.Running) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect((await docker.inspectContainer(id))!.State.Running).toBe(false);

    const started = Date.now();
    await expect(runSteps(p.id, ['wait_healthy'], { healthTimeoutMs: 60_000 }))
      .rejects.toThrow(/exited while starting/);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect((await placement(p.id)).status).toBe('provisioning');
  });

  t('wait_healthy reports the container, not the Engine, when the probe cannot run',
    async () => {
      await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
      const p = await mkProject();
      await runSteps(p.id, ['allocate_node', 'create_volume']);
      created.volumes.add((await placement(p.id)).volume_name);

      const id = await docker.createContainer(containerName(p.ref), {
        Image: IMAGE, Env: ['PGDATA=/var/lib/postgresql/data/pgdata'],
        Labels: { [LABEL_MANAGED]: 'true' },
        HostConfig: {
          Memory: 268435456, MemorySwap: 268435456, NanoCpus: 500000000,
          RestartPolicy: { Name: 'no' }, Mounts: [], PortBindings: {},
        },
        ExposedPorts: {},
      });
      await docker.startContainer(id);
      await pool.query(
        `update project_databases set container_id=$2 where project_id=$1`, [p.id, id]);

      // An `exec` that throws the way the Engine does when the container is
      // already gone. Injected rather than provoked, because **this machine's
      // Engine will not do it**: Docker Desktop returns a non-zero exit code for
      // an exec against an exited container while the CI runner's Engine answers
      // `POST /exec/<id>/start` with an error. That difference is exactly how the
      // bug survived — the test above passed here and failed there — so the only
      // honest way to pin the behaviour on every machine is to inject the failure
      // rather than hope for it.
      //
      // What must happen: the loop treats a throw as a failed probe and lets
      // `inspect` say why, so the operator is told the container exited and not
      // handed an Engine URL.
      const failing = {
        ...docker,
        exec: async () => { throw new Error('POST /exec/deadbeef/start failed: 409'); },
      };
      await expect(runSteps(p.id, ['wait_healthy'], { docker: failing, healthTimeoutMs: 20_000 }))
        .rejects.toThrow(/exited while starting/);
    });

  t('start_container refuses to proceed when the node lacks the image', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node', 'create_volume']);
    created.volumes.add((await placement(p.id)).volume_name);

    // Point the step at an image the node genuinely does not have, via a docker
    // client whose imageExists always answers false for it.
    const blind = { ...docker, imageExists: async () => false } as Docker;
    await expect(runSteps(p.id, ['start_container'], { docker: blind }))
      .rejects.toThrow(/image is not present/);
    expect((await placement(p.id)).container_id).toBeNull();
  });

  t('container steps refuse to run before placement exists', async () => {
    const p = await mkProject();
    await expect(runSteps(p.id, ['create_volume'])).rejects.toThrow(/allocate_node must run first/);
  }, 20_000);
});
