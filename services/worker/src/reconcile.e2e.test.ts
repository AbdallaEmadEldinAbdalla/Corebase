import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore } from '@corebase/secrets';
import { createRedis, createQueue, type Redis, type Queue, type ProvisioningJobData } from '@corebase/queue';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode, volumeNameFor } from './placement.ts';
import { buildContainerSpec, containerName, IMAGE, LABEL_MANAGED, LABEL_REF } from './container-spec.ts';
import { createReconciler, REPAIR_LIMIT_PER_HOUR } from './reconcile.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * T8 integration: one test per drift class in the state machine's table, plus the
 * two that must NOT be auto-repaired. The second group matters more — a
 * reconciler that deletes an orphaned volume is worse than no reconciler.
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
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-t8-'));
  writeFileSync(join(kekDir, 'kek_2026_08.key'), randomBytes(32));
  try {
    await pool.query('select last_reconcile from nodes limit 0');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    redis = createRedis(REDIS); await redis.ping();
    queue = createQueue(redis);
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('R','t8-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('T8 integration setup FAILED:', reason);
    up = false;
  }
}, 40_000);

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
  // Every volume, not just the labelled ones: the reconciler reports unlabelled
  // volumes too (a container started without a mount leaves one behind), so a
  // fixture that only clears labelled volumes leaves drift the "clean report"
  // tests would rightly fail on. The staging data node holds nothing else.
  for (const v of await docker.listVolumes()) {
    await docker.removeVolume(v.Name).catch(() => {});
  }
}

afterAll(async () => {
  if (up) { await wipeNode(); await queue?.close(); await redis?.quit(); }
  await pool?.end();
  rmSync(kekDir, { recursive: true, force: true });
}, 90_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query(
    'truncate provisioning_jobs, project_secrets, project_databases, projects, nodes cascade');
  await wipeNode();
  await queue.obliterate({ force: true }).catch(() => {});
}, 90_000);

const t = (n: string, fn: () => Promise<void>, ms = 120_000) =>
  it(n, async () => {
    if (!up) throw new Error(
      `staging not ready (${reason}) — run ./scripts/staging.sh up, ./scripts/migrate-staging.sh ` +
      'and ./scripts/staging.sh seed-images. T8 done-signal; must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'r' + String(Date.now() % 100000) + String(++seq).padStart(14, 'x');

const PROVISION = [
  'allocate_node', 'create_volume', 'start_container', 'wait_healthy',
  'create_base_roles', 'store_credentials', 'generate_api_keys', 'write_connection', 'mark_ready',
];

async function runSteps(jobType: string, projectId: string, names: string[]) {
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 60_000,
    projectDomain: 'corebase.test',
  });
  const steps = sagas[jobType]!;
  const job = { id: 'j', project_id: projectId } as unknown as JobRecord;
  for (const name of names) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`no step ${name} in ${jobType}`);
    await step.run({ job, log: () => {} });
  }
}

async function provisioned() {
  await registerNode(pool, {
    hostname: 'data-1', ramTotalMb: 16384, diskTotalGb: 200, address: HOST,
  });
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name) values ($1,$2,$3)
     returning id, ref::text as ref`, [orgId, mkRef(), 'proj-' + seq]);
  const p = rows[0]!;
  await runSteps('provision_project', p.id, PROVISION);
  return p;
}

const reconciler = () => createReconciler({
  pool, docker, queue, hostname: 'data-1', log: () => {},
});

const statusOf = async (id: string) => (await pool.query<{ status: string }>(
  `select status::text as status from projects where id = $1`, [id])).rows[0]!.status;

describe('T8 — a converged node reports no drift', () => {
  t('a freshly provisioned project produces a clean report', async () => {
    await provisioned();
    const report = await reconciler().reconcileOnce();
    expect(report.clean).toBe(true);
    expect(report.drift).toEqual([]);
    expect(report.projects_checked).toBe(1);
    expect(report.containers_seen).toBe(1);
  });

  t('records the report on the node so "is it running" is one SELECT', async () => {
    await provisioned();
    await reconciler().reconcileOnce();
    const { rows } = await pool.query<{ at: string | null; report: { clean: boolean } }>(
      `select last_reconcile_at as at, last_reconcile as report from nodes where hostname = 'data-1'`);
    expect(rows[0]!.at).not.toBeNull();
    expect(rows[0]!.report.clean).toBe(true);
  });
});

describe('T8 — drift it repairs', () => {
  t('a stopped container under a ready project is repaired', async () => {
    const p = await provisioned();
    await docker.setRestartPolicy(containerName(p.ref), 'no');
    await docker.stopContainer(containerName(p.ref));

    const report = await reconciler().reconcileOnce();
    const d = report.drift.find((x) => x.class === 'container_not_running');
    expect(d).toBeDefined();
    expect(d!.action).toBe('repair_enqueued');
    // Repair is the provisioning saga, enqueued — not a bespoke restart path, so
    // it converges through the same idempotent steps everything else uses.
    const { rows } = await pool.query<{ key: string; job_type: string }>(
      `select idempotency_key as key, job_type from provisioning_jobs where project_id = $1`, [p.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.job_type).toBe('provision_project');
    expect(rows[0]!.key).toMatch(/^repair_/);
    expect(await queue.getJob(rows[0]!.key)).toBeTruthy();
  });

  t('a missing container under a ready project is repaired, and the repair works', async () => {
    const p = await provisioned();
    await docker.removeContainer(containerName(p.ref));
    expect(await docker.inspectContainer(containerName(p.ref))).toBeUndefined();

    const report = await reconciler().reconcileOnce();
    expect(report.drift.map((d) => d.class)).toContain('container_not_running');

    // Run what the repair job would run. The volume survived, so the database
    // comes back with its data rather than as a fresh one.
    await runSteps('provision_project', p.id, PROVISION);
    const back = await docker.inspectContainer(containerName(p.ref));
    expect(back!.State.Running).toBe(true);
    expect(await reconciler().reconcileOnce()).toMatchObject({ clean: true });
  });

  t('a zombie container under a soft-deleted project is stopped', async () => {
    const p = await provisioned();
    await pool.query(
      `update projects set status='soft_deleted', deleted_at=now(),
              purge_after=now()+interval '7 days' where id = $1`, [p.id]);

    const report = await reconciler().reconcileOnce();
    const d = report.drift.find((x) => x.class === 'zombie_container');
    expect(d).toBeDefined();
    expect(d!.action).toBe('stopped');
    // Billing and security leak: the customer was told it was gone.
    expect((await docker.inspectContainer(containerName(p.ref)))!.State.Running).toBe(false);
    // And it stays stopped — the restart policy is cleared, not just the state.
    await new Promise((r) => setTimeout(r, 1200));
    expect((await docker.inspectContainer(containerName(p.ref)))!.State.Running).toBe(false);
  });

  t('a booking that disagrees with the rows is recomputed', async () => {
    const p = await provisioned();
    await pool.query(`update nodes set ram_reserved_mb = 4321 where hostname = 'data-1'`);

    const report = await reconciler().reconcileOnce();
    const d = report.drift.find((x) => x.class === 'reservation_drift');
    expect(d).toBeDefined();
    expect(d!.action).toBe('recomputed');
    const { rows } = await pool.query<{ booked: number }>(
      `select ram_reserved_mb as booked from nodes where hostname = 'data-1'`);
    expect(rows[0]!.booked).toBe(350);        // one Free project
    void p;
  });

  t('drift left by a lost release is recomputed downward too', async () => {
    // The leak direction: capacity booked for a project that no longer has a
    // placement row. Left alone, a node slowly refuses work it has room for.
    await provisioned();
    await pool.query(`truncate project_databases cascade`);
    await reconciler().reconcileOnce();
    const { rows } = await pool.query<{ booked: number }>(
      `select ram_reserved_mb as booked from nodes where hostname = 'data-1'`);
    expect(rows[0]!.booked).toBe(0);
  });
});

describe('T8 — drift it refuses to repair', () => {
  t('an orphan container is reported and left alone', async () => {
    const p = await provisioned();
    // The project row vanishes — a bad migration, a manual delete, a restore of
    // an older control-plane backup.
    await pool.query(`delete from project_databases where project_id = $1`, [p.id]);
    await pool.query(`delete from projects where id = $1`, [p.id]);

    const report = await reconciler().reconcileOnce();
    const d = report.drift.find((x) => x.class === 'orphan_container');
    expect(d).toBeDefined();
    expect(d!.action).toBe('alert_only');
    expect(d!.ref).toBe(p.ref);
    // Still there. Removing it would turn a recoverable inconsistency into lost
    // data, and the container is the only remaining evidence of what existed.
    expect(await docker.inspectContainer(containerName(p.ref))).toBeDefined();
  });

  t('an orphan volume is reported and never deleted', async () => {
    const p = await provisioned();
    await docker.removeContainer(containerName(p.ref));
    await pool.query(`delete from project_databases where project_id = $1`, [p.id]);
    await pool.query(`delete from projects where id = $1`, [p.id]);

    const report = await reconciler().reconcileOnce();
    const d = report.drift.find((x) => x.class === 'orphan_volume');
    expect(d).toBeDefined();
    expect(d!.action).toBe('alert_only');
    // This is a customer's database. Durability above cost (D-002).
    expect(await docker.volumeExists(volumeNameFor(p.ref))).toBe(true);
  });

  t('repeated sweeps keep reporting the same orphan rather than escalating to deletion', async () => {
    const p = await provisioned();
    await pool.query(`delete from project_databases where project_id = $1`, [p.id]);
    await pool.query(`delete from projects where id = $1`, [p.id]);
    const r = reconciler();
    for (let i = 0; i < 3; i++) {
      const report = await r.reconcileOnce();
      expect(report.drift.some((x) => x.class === 'orphan_container')).toBe(true);
    }
    expect(await docker.inspectContainer(containerName(p.ref))).toBeDefined();
    expect(await docker.volumeExists(volumeNameFor(p.ref))).toBe(true);
  });
});

describe('T8 — bounded repair (D-065)', () => {
  t('stops repairing after the hourly limit and marks the project failed', async () => {
    const p = await provisioned();
    await docker.setRestartPolicy(containerName(p.ref), 'no');
    await docker.stopContainer(containerName(p.ref));

    const r = createReconciler({
      pool, docker, queue, hostname: 'data-1', repairLimitPerHour: 2, log: () => {},
    });
    // Each sweep would enqueue, but a pending job blocks the next one — so the
    // jobs are retired between sweeps to simulate repairs that ran and failed.
    for (let i = 0; i < 2; i++) {
      await r.reconcileOnce();
      await pool.query(`update provisioning_jobs set state = 'failed' where project_id = $1`, [p.id]);
    }
    const report = await r.reconcileOnce();
    const d = report.drift.find((x) => x.class === 'container_not_running');
    expect(d!.action).toBe('repair_limit_reached');
    // A container that will not stay up is an escalation, not an endless loop.
    expect(await statusOf(p.id)).toBe('failed');
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from provisioning_jobs where project_id = $1`, [p.id]);
    expect(rows[0]!.n).toBe(2);
  });

  t('does not race a saga already working on the project', async () => {
    const p = await provisioned();
    await docker.setRestartPolicy(containerName(p.ref), 'no');
    await docker.stopContainer(containerName(p.ref));
    await pool.query(
      `insert into provisioning_jobs (project_id, job_type, idempotency_key, state)
       values ($1, 'provision_project', $2, 'running')`, [p.id, `inflight_${p.id}`]);

    await reconciler().reconcileOnce();
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from provisioning_jobs where project_id = $1`, [p.id]);
    expect(rows[0]!.n).toBe(1);        // no second job piled on
  });

  it('has a default limit of three per hour', () => {
    // Pure constant — no staging needed, so it uses `it` rather than the
    // staging-gated `t`.
    expect(REPAIR_LIMIT_PER_HOUR).toBe(3);
  });
});

describe('T8 — unlabelled residue', () => {
  t('reports a labelled volume with no row', async () => {
    // Volumes created before the label existed, or by hand during an incident.
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 16384, diskTotalGb: 200, address: HOST });
    const stray = 'cb-stray-manual-pgdata';
    await docker.createVolume(stray, { [LABEL_MANAGED]: 'true' });
    try {
      const report = await reconciler().reconcileOnce();
      const d = report.drift.find((x) => x.class === 'orphan_volume');
      expect(d).toBeDefined();
      expect(d!.detail).toContain(stray);
      expect(await docker.volumeExists(stray)).toBe(true);
    } finally {
      await docker.removeVolume(stray);
    }
  });

  t('reports an unlabelled volume, which a filtered list could not see', async () => {
    // What a container started without a mount leaves behind: the project image
    // declares a VOLUME, so Docker creates an anonymous volume with no labels at
    // all. It occupies disk forever and was invisible to a label-filtered list —
    // found by noticing four of them accumulating in staging.
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 16384, diskTotalGb: 200, address: HOST });
    const anon = 'aaaa1111bbbb2222cccc3333dddd4444';
    await docker.createVolume(anon, {});
    try {
      const report = await reconciler().reconcileOnce();
      const d = report.drift.find((x) => x.class === 'orphan_volume');
      expect(d).toBeDefined();
      expect(d!.action).toBe('alert_only');
      expect(d!.detail).toContain(anon);
      expect(await docker.volumeExists(anon)).toBe(true);
    } finally {
      await docker.removeVolume(anon);
    }
  });

  t('ignores containers it does not manage', async () => {
    // Someone else's container on the node is not our drift to report.
    const name = 'not-ours';
    const id = await docker.createContainer(name, {
      ...buildContainerSpec({
        ref: 'zzzzzzzzzzzzzzzzzzzz', projectId: '00000000-0000-0000-0000-000000000000',
        volumeName: 'unused-vol', hostPort: 5461, ramLimitMb: 256, bootstrapSecret: SECRET,
      }),
      Labels: {},
    });
    try {
      const report = await reconciler().reconcileOnce();
      expect(report.drift.filter((d) => d.class === 'orphan_container')).toHaveLength(0);
      expect(report.containers_seen).toBe(0);
    } finally {
      await docker.removeContainer(id);
      await docker.removeVolume('unused-vol').catch(() => {});
    }
  });
});
