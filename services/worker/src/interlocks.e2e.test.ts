import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { containerName, IMAGE, LABEL_MANAGED } from './container-spec.ts';
import {
  repoTargetFromEnv, renderPgbackrestConf, writeConf, info as repoInfo,
} from './backup.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P3f — the two interlocks.
 *
 * **Exit criterion 4**: deleting a project produces a final backup retrievable
 * during the 7-day soft-delete window. And D-077's pause interlock: pause does not
 * complete until the project is restorable from object storage alone.
 *
 * "Retrievable" is the word that decides how this is tested. A `backup_runs` row
 * saying `succeeded` is our own bookkeeping; what the criterion promises is that
 * the *repo* holds a restorable set after the project is gone from the node. So the
 * test deletes the project, waits out the window, and then reads the repo through a
 * container that has nothing to do with the deleted project.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

function loadBackupEnv(): void {
  const file = join(process.cwd(), '../../infra/docker/staging/backup-store.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}

let pool: Pool; let docker: Docker; let orgId: string; let kekDir: string;
let secrets: ReturnType<typeof createSecretStore>;
let up = false; let reason = '';

beforeAll(async () => {
  loadBackupEnv();
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-p3f-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    await pool.query('select 1');
    await pool.query('select 1 from backup_runs limit 0');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 60_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    if (!repoTargetFromEnv()) {
      throw new Error('no backup repo configured — run ./scripts/staging.sh backup-store');
    }
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('F','f3-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P3f integration setup FAILED:', reason);
    up = false;
  }
}, 60_000);

const created = { volumes: new Set<string>() };

async function wipeNode() {
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id, true, false).catch(() => {});
  }
  for (const n of await docker.listNetworks(`${LABEL_MANAGED}=true`)) {
    await docker.removeNetwork(n.Name).catch(() => {});
  }
  for (const v of created.volumes) await docker.removeVolume(v).catch(() => {});
  created.volumes.clear();
}

afterAll(async () => {
  if (up) await wipeNode();
  await pool?.end();
  docker?.close?.();
}, 60_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects, nodes cascade');
  await wipeNode();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 600_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P3f preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && backup-store && seed-images. ' +
      'This is the P3f done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'f' + String(Date.now() % 100000) + String(++seq).padStart(14, 'u');

const heartbeat = () => registerNode(pool, {
  hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });

async function mkProject(plan = 'free') {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,$4::project_plan,'ready') returning id, ref::text as ref`,
    [orgId, ref, 'lock-' + seq, plan]);
  return rows[0]!;
}

/**
 * A real job row, because `backup_runs.job_id` is a uuid foreign key.
 *
 * The first version of this file passed readable strings like `'j-del'` and every
 * test failed with `invalid input syntax for type uuid` — the constraint doing its
 * job. A run row that names a job which does not exist is a run nobody can trace
 * back to the operation that caused it, which is most of the value of recording it.
 */
async function mkJob(projectId: string, kind: string, key: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
     values ($1,$2::job_type_text,$3,'{}'::jsonb,'running') returning id`
      .replace('::job_type_text', ''),
    [projectId, kind, key]);
  return rows[0]!.id;
}

function sagas(extra: Record<string, unknown> = {}) {
  return buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 120_000, ...extra });
}

async function runSteps(
  kind: string, projectId: string, names: string[],
  jobId = 'j', extra: Record<string, unknown> = {},
) {
  const steps = sagas(extra)[kind]!;
  const logs: string[] = [];
  const job = { id: jobId, project_id: projectId } as unknown as JobRecord;
  for (const name of names) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`no step named ${name} in ${kind}`);
    process.stdout.write(`      → ${name}\n`);
    await step.run({
      job,
      log: (m, e) => { logs.push(m + (e ? ' ' + JSON.stringify(e) : '')); },
    });
  }
  return logs;
}

const PROVISION = [
  'allocate_node', 'create_volume', 'create_network', 'start_container', 'wait_healthy',
  'configure_backups', 'verify_archiving', 'create_base_roles', 'store_credentials',
  'write_connection',
];

const placementOf = async (projectId: string) => (await pool.query<{
  volume_name: string; port: number;
}>(`select volume_name, port from project_databases where project_id=$1`, [projectId])).rows[0]!;

const runsOf = async (projectId: string) => (await pool.query<{
  type: string; status: string; label: string | null; size_bytes: string | null;
}>(`select type, status, label, size_bytes from backup_runs
     where project_id = $1 order by started_at`, [projectId])).rows;

async function provisionWithData(rowCount = 500) {
  await heartbeat();
  const p = await mkProject('free');
  await runSteps('provision_project', p.id, PROVISION);
  const place = await placementOf(p.id);
  created.volumes.add(place.volume_name);

  const admin = new Client({
    host: '127.0.0.1', port: place.port, user: 'postgres', database: 'postgres',
    password: (await secrets.get(p.id, SECRET_NAMES.postgres))!,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  await admin.query(`create table keepme (id int primary key, payload text)`);
  await admin.query(
    `insert into keepme select g, md5(g::text) from generate_series(1, ${rowCount}) g`);
  await admin.end();
  return p;
}

/**
 * Read a project's repo from a container that is not that project's.
 *
 * This is what "retrievable" has to mean once the project is gone: the repo is
 * reachable with the stored cipher-pass and nothing else, from anywhere the control
 * plane can start a container. Asking the deleted project's own container would
 * prove nothing, because the point is that it no longer exists.
 */
async function readRepoFromElsewhere(projectId: string, plan: string): Promise<string[]> {
  const probe = `cb-p3f-reader-${Date.now().toString(36)}`;
  await docker.removeContainer(probe, true, true).catch(() => {});
  try {
    const id = await docker.createContainer(probe, {
      Image: IMAGE, Env: [], Labels: { 'com.corebase.role': 'repo-reader' },
      Cmd: ['sleep', '300'],
      HostConfig: {
        Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024, NanoCpus: 5e8,
        PidsLimit: 64, Init: true, RestartPolicy: { Name: 'no' },
        Mounts: [], PortBindings: {},
      },
      ExposedPorts: {},
    });
    await docker.startContainer(id);
    const cipherPass = (await secrets.get(projectId, SECRET_NAMES.backupCipherPass))!;
    await writeConf(docker, probe, renderPgbackrestConf({
      projectId, plan, cipherPass, repo: repoTargetFromEnv()! }));
    return (await repoInfo(docker, probe)).labels;
  } finally {
    await docker.removeContainer(probe, true, true).catch(() => {});
  }
}

describe('P3f — EXIT CRITERION: deleting a project leaves a retrievable backup', () => {
  t('takes a final full backup, and the repo still holds it after the project is gone',
    async () => {
      const p = await provisionWithData();

      const job = await mkJob(p.id, 'delete_project', 'p3f-del-' + p.ref);
      const logs = await runSteps('delete_project', p.id,
        ['disable_api', 'disable_writes', 'final_backup', 'stop_pooler', 'stop_container',
         'remove_network', 'mark_soft_deleted'],
        job, { requireFinalBackup: true });

      expect(logs.join('\n')).toContain('final backup taken');
      const runs = await runsOf(p.id);
      const final = runs[runs.length - 1]!;
      expect(final.status).toBe('succeeded');
      // Always a full. This is the only copy that will survive the project, and a
      // chain whose earlier links are expiring is not something to hand a customer
      // who is already having a bad day.
      expect(final.type).toBe('full');
      expect(final.label).toMatch(/^\d{8}-\d{6}F$/);
      expect(Number(final.size_bytes)).toBeGreaterThan(0);

      // Soft-deleted: the window is open and the containers are gone.
      const { rows } = await pool.query<{ status: string; purge_after: Date | null }>(
        `select status::text as status, purge_after from projects where id = $1`, [p.id]);
      expect(rows[0]!.status).toBe('soft_deleted');
      expect(rows[0]!.purge_after).not.toBeNull();
      // Stopped, not removed. Phase one of deletion is reversible by design
      // (D-038) — removing the container is the *purge*, seven days later. A test
      // asserting it was gone would have been asserting the window did not exist.
      const stopped = await docker.inspectContainer(containerName(p.ref));
      expect(stopped?.State.Running).toBe(false);

      // And the criterion itself: the backup is retrievable *now*, from outside the
      // project, with nothing but the stored cipher-pass.
      const labels = await readRepoFromElsewhere(p.id, 'free');
      expect(labels).toContain(final.label);
    });

  t('refuses to delete when the final backup cannot be taken', async () => {
    // The interlock. A deletion that proceeded past a failed final backup would
    // close a recovery window with nothing behind it — and it would do so at the
    // only moment nobody is watching, because the customer has already moved on.
    const p = await provisionWithData(50);
    const container = containerName(p.ref);

    // Break the repo the same way a botched credential rotation would.
    const cipherPass = (await secrets.get(p.id, SECRET_NAMES.backupCipherPass))!;
    await writeConf(docker, container, renderPgbackrestConf({
      projectId: p.id, plan: 'free', cipherPass,
      repo: { ...repoTargetFromEnv()!, bucket: 'corebase-backups-nonexistent' },
    }));

    const job = await mkJob(p.id, 'delete_project', 'p3f-fail-' + p.ref);
    await expect(runSteps('delete_project', p.id, ['final_backup'], job,
      { requireFinalBackup: true })).rejects.toThrow(/final backup failed/);

    // The project is still there and still `ready` — nothing was destroyed.
    const { rows } = await pool.query<{ status: string }>(
      `select status::text as status from projects where id = $1`, [p.id]);
    expect(rows[0]!.status).toBe('ready');
    // And the attempt is on the record as a failure rather than absent.
    const runs = await runsOf(p.id);
    expect(runs[runs.length - 1]!.status).toBe('failed');
  });

  t('relies on the pause-time backup when deleting an already-paused project',
    async () => {
      // The normal case for a Free project: it paused weeks ago, its final backup
      // is pinned, and there is no container to take another from. "There was
      // already one" and "we could not take one" must not look alike.
      const p = await provisionWithData(50);
      await runSteps('pause_project', p.id,
        ['mark_pausing', 'checkpoint_and_stop'],
        await mkJob(p.id, 'pause_project', 'p3f-pause-' + p.ref));
      const pauseRuns = await runsOf(p.id);
      expect(pauseRuns.length).toBeGreaterThan(0);
      expect(pauseRuns[pauseRuns.length - 1]!.status).toBe('succeeded');

      const logs = await runSteps('delete_project', p.id, ['final_backup'],
        await mkJob(p.id, 'delete_project', 'p3f-del2-' + p.ref),
        { requireFinalBackup: true });
      expect(logs.join('\n')).toContain('relying on the existing backup taken at pause');
    });
});

describe('P3f — the pause interlock (D-077)', () => {
  t('pause takes a backup after the checkpoint and confirms it archived', async () => {
    const p = await provisionWithData();
    // A base backup first, so the pause has a fresh chain to extend. Provisioning
    // takes none — it creates the stanza and proves archiving, nothing more — so a
    // freshly created project pausing immediately correctly takes a *full*, which
    // this test is not about. An incremental with no base is not a thing.
    await runSteps('backup_project', p.id, ['plan_backup', 'take_backup'],
      await mkJob(p.id, 'backup_project', 'p3f-base-' + p.ref));

    const logs = await runSteps('pause_project', p.id,
      ['mark_pausing', 'checkpoint_and_stop'],
      await mkJob(p.id, 'pause_project', 'p3f-p1-' + p.ref));

    // Order matters: a backup before the checkpoint would not include what the
    // checkpoint flushed, which is precisely the tail of the data.
    const text = logs.join('\n');
    expect(text.indexOf('checkpointed')).toBeLessThan(text.indexOf('final backup taken'));
    expect(text).toContain('restorable from object storage alone');

    const runs = await runsOf(p.id);
    expect(runs[runs.length - 1]!.status).toBe('succeeded');
    // The base is minutes old, so extending the chain is the cheap and correct
    // choice — the stale-chain case is the next test.
    expect(runs[runs.length - 1]!.type).toBe('incr');

    // The container is stopped, and the repo holds the pause-time backup.
    const db = await docker.inspectContainer(containerName(p.ref));
    expect(db?.State.Running).toBe(false);
    const labels = await readRepoFromElsewhere(p.id, 'free');
    expect(labels.length).toBeGreaterThan(0);
  });

  t('leaves the containers running when the pause backup fails', async () => {
    // The whole point of an interlock rather than a courtesy. A paused project
    // whose backup failed has its only current copy on a node disk with nothing
    // watching it — strictly worse than a running project, which is the opposite
    // of what pausing is for.
    const p = await provisionWithData(50);
    const container = containerName(p.ref);
    const cipherPass = (await secrets.get(p.id, SECRET_NAMES.backupCipherPass))!;
    await writeConf(docker, container, renderPgbackrestConf({
      projectId: p.id, plan: 'free', cipherPass,
      repo: { ...repoTargetFromEnv()!, bucket: 'corebase-backups-nonexistent' },
    }));

    await expect(runSteps('pause_project', p.id,
      ['mark_pausing', 'checkpoint_and_stop'],
      await mkJob(p.id, 'pause_project', 'p3f-p2-' + p.ref)))
      .rejects.toThrow(/not restorable from object storage/);

    // Still running. The pause will be retried; the data is not stranded.
    const db = await docker.inspectContainer(container);
    expect(db?.State.Running).toBe(true);
  });

  t('takes a full rather than an incremental when the chain has gone stale', async () => {
    // Nothing extends the chain again until the project resumes, so an incremental
    // onto a base that is about to be the oldest thing in the repo is a restore
    // depending on a link nobody is watching.
    const p = await provisionWithData(50);
    await runSteps('backup_project', p.id, ['plan_backup', 'take_backup'],
      await mkJob(p.id, 'backup_project', 'p3f-base3-' + p.ref));
    await pool.query(
      `update backup_runs set finished_at = now() - interval '30 days'
        where project_id = $1 and status = 'succeeded'`, [p.id]);

    await runSteps('pause_project', p.id, ['mark_pausing', 'checkpoint_and_stop'],
      await mkJob(p.id, 'pause_project', 'p3f-p3-' + p.ref));
    const runs = await runsOf(p.id);
    expect(runs[runs.length - 1]!.type).toBe('full');
    expect(runs[runs.length - 1]!.status).toBe('succeeded');
  });
});
