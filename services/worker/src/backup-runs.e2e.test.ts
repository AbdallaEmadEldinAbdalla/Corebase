import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { createRedis, createQueue } from '@corebase/queue';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { containerName, IMAGE, LABEL_MANAGED } from './container-spec.ts';
import { createBackupScan } from './backup-scan.ts';
import {
  repoTargetFromEnv, info as repoInfo, pgbackrest, STANZA,
} from './backup.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';
import { loadBackupEnv } from './staging-env.ts';

/**
 * P3c integration: scheduled base backups, the record of them, and retention.
 *
 * Still nothing here claims a project is protected — that is P3d's and P3e's job,
 * and the phase's rule stands: an unrestored backup does not exist. What this
 * proves is that backups happen on their own, that failures are visible, and that
 * old ones go away.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const REDIS = process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';
const ALWAYS = { startHour: 0, endHour: 24 };


let pool: Pool; let docker: Docker; let orgId: string; let kekDir: string;
let secrets: ReturnType<typeof createSecretStore>;
let redis: ReturnType<typeof createRedis>;
let queue: ReturnType<typeof createQueue>;
let up = false; let reason = '';

beforeAll(async () => {
  loadBackupEnv();
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-p3c-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    await pool.query('select 1');
    await pool.query('select 1 from backup_runs limit 0');    // P3c migration?
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 60_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    if (!repoTargetFromEnv()) {
      throw new Error('no backup repo configured — run ./scripts/staging.sh backup-store');
    }
    redis = createRedis(REDIS);
    queue = createQueue(redis);
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('S','s3-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P3c integration setup FAILED:', reason);
    up = false;
  }
}, 60_000);

const created = { volumes: new Set<string>() };

async function wipeNode() {
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id).catch(() => {});
  }
  for (const n of await docker.listNetworks(`${LABEL_MANAGED}=true`)) {
    await docker.removeNetwork(n.Name).catch(() => {});
  }
  for (const v of created.volumes) await docker.removeVolume(v).catch(() => {});
  created.volumes.clear();
}

afterAll(async () => {
  if (up) await wipeNode();
  await redis?.quit().catch(() => {});
  await pool?.end();
  docker?.close?.();
}, 60_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects, nodes cascade');
  await wipeNode();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 300_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P3c preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && backup-store && seed-images. ' +
      'This is the P3c done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 's' + String(Date.now() % 100000) + String(++seq).padStart(14, 'q');

async function mkProject(plan = 'free') {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,$4::project_plan,'ready') returning id, ref::text as ref`,
    [orgId, ref, 'sch-' + seq, plan]);
  return rows[0]!;
}

function sagas() {
  return buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 90_000 });
}

async function runSteps(kind: string, projectId: string, names: string[], jobId = 'j') {
  const steps = sagas()[kind]!;
  const logs: string[] = [];
  const job = { id: jobId, project_id: projectId } as unknown as JobRecord;
  for (const name of names) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`no step named ${name} in ${kind}`);
    await step.run({ job, log: (m, e) => logs.push(m + (e ? ' ' + JSON.stringify(e) : '')) });
  }
  return logs;
}

const PROVISION = [
  'allocate_node', 'create_volume', 'create_network', 'start_container', 'wait_healthy',
  'configure_backups', 'verify_archiving', 'create_base_roles', 'store_credentials',
];

const runs = async (projectId: string) => (await pool.query<{
  type: string; status: string; label: string | null; size_bytes: string | null;
  wal_start: string | null; wal_stop: string | null; error: string | null;
  finished_at: Date | null;
}>(`select type, status, label, size_bytes, wal_start, wal_stop, error, finished_at
      from backup_runs where project_id = $1 order by started_at`, [projectId])).rows;

async function provision(plan = 'free') {
  await registerNode(pool, {
    hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
  const p = await mkProject(plan);
  await runSteps('provision_project', p.id, PROVISION);
  const { rows } = await pool.query<{ volume_name: string; port: number }>(
    `select volume_name, port from project_databases where project_id=$1`, [p.id]);
  created.volumes.add(rows[0]!.volume_name);
  return { ...p, port: rows[0]!.port, container: containerName(p.ref) };
}

/** A job row for the backup saga, so the run row can be tied to it. */
async function mkJob(projectId: string, key: string) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
     values ($1,'backup_project',$2,'{}'::jsonb,'running') returning id`, [projectId, key]);
  return rows[0]!.id;
}

describe('P3c — the scan schedules work', () => {
  t('a freshly provisioned project is due a full immediately', async () => {
    // Not at 03:00 tomorrow. A project created at midday would otherwise have no
    // base backup for eighteen hours.
    const p = await provision('free');
    const scan = createBackupScan({ pool, queue, window: ALWAYS });
    const r = await scan.scanOnce();
    expect(r.created).toBe(1);
    expect(r.due[0]!.type).toBe('full');
    expect(r.due[0]!.reason).toContain('ever succeeded');

    const { rows } = await pool.query<{ job_type: string; idempotency_key: string }>(
      `select job_type, idempotency_key from provisioning_jobs where job_type='backup_project'`);
    expect(rows).toHaveLength(1);
    // Day-keyed, so a sweep every five minutes does not enqueue the same nightly
    // backup twelve times an hour.
    expect(rows[0]!.idempotency_key).toMatch(/^backup_[0-9a-f-]+_full_\d{4}-\d{2}-\d{2}$/);
  });

  t('scanning again the same day schedules nothing more', async () => {
    const p = await provision('free');
    const scan = createBackupScan({ pool, queue, window: ALWAYS });
    expect((await scan.scanOnce()).created).toBe(1);
    const second = await scan.scanOnce();
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    void p;
  });

  t('a paused project is skipped entirely', async () => {
    // Nothing to back up: pause removes the containers (D-008), and the final
    // backup taken at pause is already pinned against expiry (D-077). Trying
    // anyway would write a failed run row every sweep for every paused project —
    // most of the fleet, if the pause economics work — and bury the failures that
    // mean something.
    const p = await provision('free');
    await pool.query(
      `update project_databases set status = 'paused' where project_id = $1`, [p.id]);
    const scan = createBackupScan({ pool, queue, window: ALWAYS });
    const r = await scan.scanOnce();
    expect(r.considered).toBe(0);
    expect(r.created).toBe(0);
  });

  t('a project with a backup already in flight is not given a second one', async () => {
    const p = await provision('free');
    await pool.query(
      `insert into backup_runs (project_id, type, status) values ($1,'full','running')`, [p.id]);
    const r = await createBackupScan({ pool, queue, window: ALWAYS }).scanOnce();
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(1);
  });

  t('an abandoned run stops blocking the schedule after six hours', async () => {
    // The row stays for the record — a `running` row that never finished is what a
    // killed worker leaves, and that is worth seeing — but it must not freeze the
    // project's backups forever.
    const p = await provision('free');
    await pool.query(
      `insert into backup_runs (project_id, type, status, started_at)
       values ($1,'full','running', now() - interval '7 hours')`, [p.id]);
    const r = await createBackupScan({ pool, queue, window: ALWAYS }).scanOnce();
    expect(r.created).toBe(1);
  });
});

describe('P3c — the saga takes it and records what happened', () => {
  t('a full backup is taken and the run row matches the repo', async () => {
    const p = await provision('free');

    // Something to back up, so "succeeded" is not a statement about nothing.
    const admin = new Client({
      host: '127.0.0.1', port: p.port, user: 'postgres', database: 'postgres',
      password: (await secrets.get(p.id, SECRET_NAMES.postgres))!,
      connectionTimeoutMillis: 8000,
    });
    await admin.connect();
    await admin.query(`create table paid (id int primary key, payload text)`);
    await admin.query(`insert into paid select g, md5(g::text) from generate_series(1,2000) g`);
    await admin.end();

    const jobId = await mkJob(p.id, 'p3c-run-1');
    const logs = await runSteps('backup_project', p.id, ['plan_backup', 'take_backup'], jobId);
    expect(logs.join('\n')).toContain('backup planned');
    expect(logs.join('\n')).toContain('backup complete');

    const [run] = await runs(p.id);
    expect(run!.status).toBe('succeeded');
    expect(run!.type).toBe('full');
    expect(run!.finished_at).not.toBeNull();
    expect(run!.label).toMatch(/^\d{8}-\d{6}F$/);
    expect(Number(run!.size_bytes)).toBeGreaterThan(0);
    // The WAL range is what answers "can I restore to time T" without asking the
    // repo, and a backup whose WAL never arrived has no stop.
    expect(run!.wal_start).toBeTruthy();
    expect(run!.wal_stop).toBeTruthy();

    // Read back from the repo: the row has to agree with what a restore will see.
    const repo = await repoInfo(docker, p.container);
    expect(repo.labels).toContain(run!.label);
  });

  t('a failed backup is recorded as failed, with the reason, and does not vanish', async () => {
    // The whole point of the table: the repo records what exists, so a project
    // whose nightly full has failed for six days looks identical through `info` to
    // one whose retention window starts six days ago.
    const p = await provision('free');
    await pgbackrest(docker, p.container, ['stop']);   // makes pgBackRest refuse to run
    try {
      const jobId = await mkJob(p.id, 'p3c-run-fail');
      await expect(runSteps('backup_project', p.id, ['plan_backup', 'take_backup'], jobId))
        .rejects.toThrow();

      const [run] = await runs(p.id);
      expect(run!.status).toBe('failed');
      expect(run!.finished_at).not.toBeNull();
      expect(run!.error).toBeTruthy();
      expect(run!.label).toBeNull();
    } finally {
      await pgbackrest(docker, p.container, ['start']);
    }
  });

  t('replaying the saga reuses the run row rather than logging a phantom attempt',
    async () => {
      const p = await provision('free');
      const jobId = await mkJob(p.id, 'p3c-run-replay');
      await runSteps('backup_project', p.id, ['plan_backup'], jobId);
      await runSteps('backup_project', p.id, ['plan_backup'], jobId);
      expect(await runs(p.id)).toHaveLength(1);
    });
});

describe('P3c — retention actually expires things', () => {
  t('EXIT-CRITERION SUPPORT: an expired full is removed from the repo', async () => {
    // Time-based retention is what production uses (days per plan), and it cannot
    // be exercised here without faking a calendar: pgBackRest decides from the
    // timestamps in the repo. So this proves the *mechanism* — that `expire` runs
    // as part of `backup` and removes exactly what the policy says — using a
    // count-based override on the command line. The production policy is asserted
    // separately in backup.test.ts, which pins `retention-full-type=time` and the
    // per-plan day counts.
    const p = await provision('free');

    const takeFull = () => pgbackrest(docker, p.container, [
      '--type=full', '--repo1-retention-full-type=count', '--repo1-retention-full=1',
      'backup',
    ]);

    const first = await takeFull();
    expect(first.exitCode).toBe(0);
    const afterFirst = await repoInfo(docker, p.container);
    expect(afterFirst.labels).toHaveLength(1);
    const oldest = afterFirst.labels[0]!;

    const second = await takeFull();
    expect(second.exitCode).toBe(0);
    const afterSecond = await repoInfo(docker, p.container);

    // One retained, and it is the new one — expiry removed the older full rather
    // than the newer, which is the direction that matters.
    expect(afterSecond.labels).toHaveLength(1);
    expect(afterSecond.labels).not.toContain(oldest);
  });

  t('the stanza name is still `main` for every project, so retention is per-path',
    async () => {
      // Retention is a property of the repo path, and every project's path is its
      // own — two projects sharing a stanza name do not share a policy.
      const p = await provision('free');
      const r = await pgbackrest(docker, p.container, ['info', '--output=json']);
      expect(r.stdout).toContain(`"name":"${STANZA}"`);
    });
});
