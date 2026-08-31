import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { createRedis, createQueue, type Redis, type Queue, type ProvisioningJobData } from '@corebase/queue';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode, volumeNameFor } from './placement.ts';
import { buildContainerSpec, containerName, IMAGE, LABEL_MANAGED } from './container-spec.ts';
import { createPurgeScan } from './purge-scan.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * T7 integration: deletion is two operations with a recovery window between
 * them, and the interesting assertions are about what is *still there* after the
 * reversible phase and what is *gone* after the irreversible one.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const REDIS = process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

let pool: Pool; let docker: Docker; let orgId: string; let kekDir: string;
let redis: Redis; let queue: Queue<ProvisioningJobData>;
let secrets: ReturnType<typeof createSecretStore>;
let up = false; let reason = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-t7-'));
  writeFileSync(join(kekDir, 'kek_2026_08.key'), randomBytes(32));
  try {
    await pool.query('select 1');
    await pool.query(`select 1 from provisioning_jobs where job_type = 'purge_project' limit 0`);
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    redis = createRedis(REDIS); await redis.ping();
    queue = createQueue(redis);
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('T','t7-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('T7 integration setup FAILED:', reason);
    up = false;
  }
}, 40_000);

afterAll(async () => {
  if (up) {
    for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
      await docker.removeContainer(c.Id).catch(() => {});
    }
    await queue?.close(); await redis?.quit();
  }
  await pool?.end();
  rmSync(kekDir, { recursive: true, force: true });
}, 90_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query(
    'truncate provisioning_jobs, project_secrets, project_databases, projects, nodes cascade');
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id).catch(() => {});
  }
  for (const v of await listProjectVolumes()) await docker.removeVolume(v).catch(() => {});
  await queue.obliterate({ force: true }).catch(() => {});
}, 90_000);

const t = (n: string, fn: () => Promise<void>, ms = 120_000) =>
  it(n, async () => {
    if (!up) throw new Error(
      `staging not ready (${reason}) — run ./scripts/staging.sh up, ./scripts/migrate-staging.sh ` +
      'and ./scripts/staging.sh seed-images. T7 done-signal; must not skip silently.');
    await fn();
  }, ms);

/** Every cb-* volume on the node, via the raw Engine API list. */
async function listProjectVolumes(): Promise<string[]> {
  const seen: string[] = [];
  for (const c of await docker.listContainers()) {
    void c;
  }
  // The client has no list-volumes call (nothing in the saga needs one), so probe
  // the names this suite could have created.
  const { rows } = await pool.query<{ ref: string }>(`select ref::text as ref from projects`);
  for (const r of rows) {
    if (await docker.volumeExists(volumeNameFor(r.ref))) seen.push(volumeNameFor(r.ref));
  }
  return seen;
}

/** A minimal spec for standing a container back up in the residue test. */
const buildSpecFor = (ref: string, projectId: string) => buildContainerSpec({
  ref, projectId, volumeName: volumeNameFor(ref), hostPort: 5462,
  ramLimitMb: 512, bootstrapSecret: SECRET,
});

let seq = 0;
const mkRef = () => 't' + String(Date.now() % 100000) + String(++seq).padStart(14, 'x');

async function mkProject(plan = 'free') {
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan)
     values ($1,$2,$3,$4::project_plan) returning id, ref::text as ref`,
    [orgId, mkRef(), 'proj-' + seq, plan]);
  return rows[0]!;
}

const PROVISION = [
  'allocate_node', 'create_volume', 'start_container', 'wait_healthy',
  'create_base_roles', 'store_credentials', 'write_connection', 'mark_ready',
];
const DELETE = ['disable_api', 'disable_writes', 'final_backup', 'stop_container', 'mark_soft_deleted'];
const PURGE = ['verify_purgeable', 'remove_container', 'remove_volume',
  'delete_credentials', 'release_capacity', 'verify_gone', 'mark_deleted'];

async function runSteps(
  jobType: 'provision_project' | 'delete_project' | 'purge_project',
  projectId: string, names: string[], extra: Record<string, unknown> = {},
) {
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 60_000,
    projectDomain: 'corebase.test', softDeleteWindow: '7 days', ...extra,
  });
  const steps = sagas[jobType]!;
  const logs: string[] = [];
  const job = { id: 'j', project_id: projectId } as unknown as JobRecord;
  for (const name of names) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`no step named ${name} in ${jobType}`);
    await step.run({ job, log: (m, e) => logs.push(m + (e ? ' ' + JSON.stringify(e) : '')) });
  }
  return logs;
}

async function provisioned(plan = 'free') {
  await registerNode(pool, {
    hostname: 'data-1', ramTotalMb: 16384, diskTotalGb: 200, address: HOST,
  });
  const p = await mkProject(plan);
  await runSteps('provision_project', p.id, PROVISION);
  return p;
}

const state = async (projectId: string) => (await pool.query<{
  status: string; deleted_at: string | null; purge_after: string | null;
  db_status: string | null; placements: number; secrets: number; booked: number;
}>(`SELECT p.status::text AS status, p.deleted_at, p.purge_after,
           (SELECT status::text FROM project_databases WHERE project_id = p.id) AS db_status,
           (SELECT count(*)::int FROM project_databases WHERE project_id = p.id) AS placements,
           (SELECT count(*)::int FROM project_secrets WHERE project_id = p.id) AS secrets,
           (SELECT ram_reserved_mb FROM nodes ORDER BY created_at LIMIT 1) AS booked
      FROM projects p WHERE p.id = $1`, [projectId])).rows[0]!;

/** Force the recovery window shut, as the passage of seven days would. */
const expireWindow = (projectId: string) =>
  pool.query(`update projects set purge_after = now() - interval '1 second' where id = $1`, [projectId]);

describe('T7 — soft delete keeps the data', () => {
  t('stops the container, keeps the volume, and opens a recovery window', async () => {
    const p = await provisioned();
    const before = await state(p.id);
    expect(before.status).toBe('ready');

    const logs = await runSteps('delete_project', p.id, DELETE);
    const after = await state(p.id);

    expect(after.status).toBe('soft_deleted');
    expect(after.deleted_at).not.toBeNull();
    expect(after.purge_after).not.toBeNull();
    // The whole point of D-038: the data is still there.
    expect(await docker.volumeExists(volumeNameFor(p.ref))).toBe(true);
    expect(after.placements).toBe(1);
    expect(after.secrets).toBe(3);
    expect(after.booked).toBe(350);      // capacity still booked; nothing reclaimed yet

    const inspect = await docker.inspectContainer(containerName(p.ref));
    expect(inspect).toBeDefined();
    expect(inspect!.State.Running).toBe(false);
    expect(logs.join('\n')).toContain('volume kept');
  });

  t('clears the restart policy so the container stays stopped (D-184)', async () => {
    // unless-stopped would bring the container straight back and make the
    // "stopped" state a fiction.
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    const inspect = await docker.inspectContainer(containerName(p.ref));
    expect(inspect!.HostConfig.RestartPolicy.Name).toBe('no');
    await new Promise((r) => setTimeout(r, 1500));
    expect((await docker.inspectContainer(containerName(p.ref)))!.State.Running).toBe(false);
  });

  t('makes the database read-only before the final backup would be taken', async () => {
    const p = await provisioned();
    const devPw = (await secrets.get(p.id, SECRET_NAMES.developer))!;
    const { rows } = await pool.query<{ port: number }>(
      `select port from project_databases where project_id = $1`, [p.id]);
    const port = rows[0]!.port;

    await runSteps('delete_project', p.id, ['disable_api', 'disable_writes']);

    // Container is still running at this point; a client with a live direct
    // connection must not be able to write data the final backup would miss.
    const c = new Client({ host: HOST, port, user: 'developer', password: devPw, database: 'postgres' });
    await c.connect();
    try {
      await expect(c.query('create table late (id int)')).rejects.toThrow(/read-only/);
    } finally { await c.end(); }
  });

  t('re-running the delete saga does not slide the recovery window forward', async () => {
    // A retry a day later must not give the customer a fresh 7 days: the clock
    // starts when they asked.
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    const first = String((await state(p.id)).purge_after);
    await pool.query(
      `update projects set deleted_at = now() - interval '3 days',
              purge_after = now() + interval '4 days' where id = $1`, [p.id]);
    const moved = String((await state(p.id)).purge_after);

    await runSteps('delete_project', p.id, DELETE);
    const second = String((await state(p.id)).purge_after);
    expect(second).toBe(moved);
    expect(second).not.toBe(first);
  });

  t('refuses to delete without a final backup when the gate is on (D-066)', async () => {
    const p = await provisioned();
    await expect(runSteps('delete_project', p.id, DELETE, { requireFinalBackup: true }))
      .rejects.toThrow(/verified final backup is required/);
    // And it fails *before* the container is stopped, so nothing is half-done.
    expect((await docker.inspectContainer(containerName(p.ref)))!.State.Running).toBe(true);
    expect((await state(p.id)).status).toBe('ready');
  });

  t('soft-deleting a project with no container is not an error', async () => {
    // The provisioning-failed case: a customer deleting a project that never got
    // as far as a container must still be able to.
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 16384, diskTotalGb: 200, address: HOST });
    const p = await mkProject();
    await runSteps('provision_project', p.id, ['allocate_node']);
    const logs = await runSteps('delete_project', p.id, DELETE);
    expect((await state(p.id)).status).toBe('soft_deleted');
    expect(logs.join('\n')).toContain('nothing to stop');
  });
});

describe('T7 — purge destroys it', () => {
  t('refuses to purge inside the recovery window', async () => {
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    // The guard that gives D-038 its meaning. Everything after verify_purgeable
    // is irreversible.
    await expect(runSteps('purge_project', p.id, PURGE))
      .rejects.toThrow(/refusing to purge before the recovery window closes/);
    expect(await docker.volumeExists(volumeNameFor(p.ref))).toBe(true);
    expect((await state(p.id)).status).toBe('soft_deleted');
  });

  t('refuses to purge a project that was never soft-deleted', async () => {
    const p = await provisioned();
    await expect(runSteps('purge_project', p.id, PURGE))
      .rejects.toThrow(/refusing to purge a project in status ready/);
    expect(await docker.volumeExists(volumeNameFor(p.ref))).toBe(true);
  });

  t('removes the container, the volume, the credentials and the booking', async () => {
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    await expireWindow(p.id);

    const logs = await runSteps('purge_project', p.id, PURGE);
    const after = await state(p.id);

    expect(after.status).toBe('deleted');
    expect(await docker.inspectContainer(containerName(p.ref))).toBeUndefined();
    expect(await docker.volumeExists(volumeNameFor(p.ref))).toBe(false);
    expect(after.secrets).toBe(0);
    expect(after.placements).toBe(0);   // the port is reusable again
    expect(after.booked).toBe(0);       // capacity returned to the node
    expect(logs.join('\n')).toContain('no container, no volume, no credentials');
  });

  t('verify_gone fails rather than reporting a clean purge', async () => {
    // The step exists so "delete leaves no residue" is a property of the code and
    // not of a test, which is worth nothing unless the check can actually fail.
    // Purge fully, then put a container back with the project's label.
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    await expireWindow(p.id);
    await runSteps('purge_project', p.id, PURGE);

    await docker.createVolume(volumeNameFor(p.ref), {});
    const id = await docker.createContainer(containerName(p.ref), buildSpecFor(p.ref, p.id));
    try {
      await expect(runSteps('purge_project', p.id, ['verify_gone']))
        .rejects.toThrow(/container\(s\) still present/);
    } finally {
      await docker.removeContainer(id);
      await docker.removeVolume(volumeNameFor(p.ref));
    }
  });

  t('re-running the purge is a no-op', async () => {
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    await expireWindow(p.id);
    await runSteps('purge_project', p.id, PURGE);
    const first = await state(p.id);

    await runSteps('purge_project', p.id, PURGE);
    const second = await state(p.id);
    expect(second).toEqual(first);
    expect(second.booked).toBe(0);      // released once, not twice
  });

  t('removes a container the control plane lost track of', async () => {
    // The T5d crash window, seen from the other end: a container created just
    // before a crash, with no id recorded. The purge must find it by name or it
    // is a leak nothing will ever clean up.
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    await expireWindow(p.id);
    await pool.query(
      `update project_databases set container_id = null where project_id = $1`, [p.id]);

    await runSteps('purge_project', p.id, PURGE);
    expect(await docker.inspectContainer(containerName(p.ref))).toBeUndefined();
    expect((await state(p.id)).status).toBe('deleted');
  });

  t('frees the port for the next project', async () => {
    const p1 = await provisioned();
    const { rows: r1 } = await pool.query<{ port: number }>(
      `select port from project_databases where project_id = $1`, [p1.id]);
    await runSteps('delete_project', p1.id, DELETE);
    await expireWindow(p1.id);
    await runSteps('purge_project', p1.id, PURGE);

    const p2 = await mkProject();
    await runSteps('provision_project', p2.id, ['allocate_node']);
    const { rows: r2 } = await pool.query<{ port: number }>(
      `select port from project_databases where project_id = $1`, [p2.id]);
    // Same port, which is only possible because the placement row was deleted:
    // UNIQUE (node_id, port) would otherwise hold it forever.
    expect(r2[0]!.port).toBe(r1[0]!.port);
  });
});

describe('T7 — the purge scan', () => {
  t('schedules nothing while windows are open', async () => {
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    const scan = createPurgeScan({ pool, queue });
    expect(await scan.scanOnce()).toEqual({ due: 0, created: 0, enqueued: 0 });
  });

  t('schedules a purge once the window closes, exactly once', async () => {
    const p = await provisioned();
    await runSteps('delete_project', p.id, DELETE);
    await expireWindow(p.id);

    const scan = createPurgeScan({ pool, queue });
    const first = await scan.scanOnce();
    expect(first).toEqual({ due: 1, created: 1, enqueued: 1 });

    // Two workers, or an hourly scan running twice, must not purge twice.
    const second = await scan.scanOnce();
    expect(second.due).toBe(1);
    expect(second.created).toBe(0);

    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from provisioning_jobs where job_type = 'purge_project'`);
    expect(rows[0]!.n).toBe(1);
    expect(await queue.getJob(`purge_${p.id}`)).toBeTruthy();
  });

  t('ignores projects that are merely deleting, not soft-deleted', async () => {
    const p = await provisioned();
    await pool.query(`update projects set status = 'deleting' where id = $1`, [p.id]);
    const scan = createPurgeScan({ pool, queue });
    expect((await scan.scanOnce()).due).toBe(0);
  });
});
