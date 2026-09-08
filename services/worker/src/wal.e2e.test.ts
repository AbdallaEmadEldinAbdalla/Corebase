import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createEnvelope } from '@steadhold/crypto';
import { createSecretStore, SECRET_NAMES } from '@steadhold/secrets';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { containerName, IMAGE, LABEL_MANAGED } from './container-spec.ts';
import { createWalScan, ARCHIVE_LADDER, type ArchiveState } from './wal-scan.ts';
import { repoTargetFromEnv, renderPgbackrestConf, writeConf } from './backup.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P3b integration: WAL-archive lag, proven by breaking archiving on purpose.
 *
 * Phase 3's third exit criterion is *"WAL-archive lag is monitored and alerts fire
 * (tested)"*, and it takes two different proofs. The alert expressions are asserted
 * against synthetic series by `promtool test rules`
 * (infra/docker/staging/monitoring/rules.test.yml) — that is what proves an alert
 * *fires*. This file proves the other half: that the number the alert reads moves
 * when archiving actually breaks, and goes back when it is fixed. A monitored
 * metric that never changes is indistinguishable from a healthy fleet.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const CERT_DIR = process.env.SH_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.SH_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SH_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';
const MONITORING = join(process.cwd(), '../../infra/docker/staging/monitoring');
const run = promisify(execFile);

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
  kekDir = mkdtempSync(join(tmpdir(), 'sh-kek-p3b-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    await pool.query('select 1');
    await pool.query('select archive_state from project_databases limit 0');  // P3b migration?
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 30_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    if (!repoTargetFromEnv()) {
      throw new Error('no backup repo configured — run ./scripts/staging.sh backup-store');
    }
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('W','w3-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P3b integration setup FAILED:', reason);
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
  await pool?.end();
  docker?.close?.();
}, 60_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects, nodes cascade');
  await wipeNode();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 240_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P3b preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && backup-store && seed-images. ' +
      'This is the P3b done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'w' + String(Date.now() % 100000) + String(++seq).padStart(14, 'z');

async function mkProject(plan = 'free') {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,$4::project_plan,'ready') returning id, ref::text as ref`,
    [orgId, ref, 'wal-' + seq, plan]);
  return rows[0]!;
}

async function runSteps(projectId: string, names: string[]) {
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 90_000 });
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

const FULL = [
  'allocate_node', 'create_volume', 'create_network', 'start_container', 'wait_healthy',
  'configure_backups', 'verify_archiving', 'create_base_roles', 'store_credentials',
];

const row = async (projectId: string) => (await pool.query<{
  port: number; volume_name: string;
  wal_archive_lag_seconds: number | null; wal_archive_pending: number | null;
  wal_last_archived_at: Date | null; wal_archive_failed_count: string | null;
  archive_state: ArchiveState; backup_check_ok: boolean | null;
  backup_check_error: string | null; backup_checked_at: Date | null;
}>(`select port, volume_name, wal_archive_lag_seconds, wal_archive_pending,
           wal_last_archived_at, wal_archive_failed_count, archive_state::text as archive_state,
           backup_check_ok, backup_check_error, backup_checked_at
      from project_databases where project_id = $1`, [projectId])).rows[0]!;

const superuserPasswordsFor = async (projectId: string) => {
  const stored = await secrets.get(projectId, SECRET_NAMES.postgres);
  return stored ? [stored] : [];
};

/** Provision a project and hand back what the test needs to talk to it. */
async function provision() {
  await registerNode(pool, {
    hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
  const p = await mkProject('free');
  await runSteps(p.id, FULL);
  const r = await row(p.id);
  created.volumes.add(r.volume_name);
  return { ...p, port: r.port, container: containerName(p.ref) };
}

async function adminClient(port: number, projectId: string) {
  const c = new Client({
    host: '127.0.0.1', port, user: 'postgres', database: 'postgres',
    password: (await secrets.get(projectId, SECRET_NAMES.postgres))!,
    connectionTimeoutMillis: 8000,
  });
  await c.connect();
  return c;
}

/**
 * Close some WAL segments with real content in them.
 *
 * `pg_switch_wal()` alone can be a no-op when the current segment is untouched, so
 * each switch is preceded by writes. Segments that are closed become `.ready` in
 * the archive status directory, which is what lag is measured from.
 */
async function produceWal(c: Client, switches = 3) {
  await c.query(`create table if not exists wal_churn (id serial primary key, payload text)`);
  for (let i = 0; i < switches; i++) {
    await c.query(`insert into wal_churn (payload)
                   select md5(random()::text) from generate_series(1, 20000)`);
    await c.query(`select pg_switch_wal()`);
  }
  await c.query(`checkpoint`);
}

/**
 * Poll until the project's archive has drained, or give up.
 *
 * Generous on purpose. Postgres' archiver backs off to a 60-second wake interval
 * after repeated `archive_command` failures, so a project whose config was just
 * repaired can sit with segments pending for up to a minute through no fault of
 * anything — and a test that waited less would report a permanent failure for a
 * transient one. Returns the last row either way so the assertion, not the helper,
 * decides what counts.
 */
async function waitForDrain(projectId: string, scan: { scanOnce: (d: {
  superuserPasswordsFor: (id: string) => Promise<string[]>;
}) => Promise<unknown> }, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs;
  let last = await row(projectId);
  while (Date.now() < deadline) {
    await scan.scanOnce({ superuserPasswordsFor });
    last = await row(projectId);
    if (last.wal_archive_pending === 0 && last.archive_state === 'ok') return last;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}

describe('P3b — lag is measured, and measured correctly', () => {
  t('a healthy project reports zero lag, not one archive_timeout of it', async () => {
    // The whole reason this metric is defined the way it is. Under "time since the
    // last successful archive", an idle Free project sits at up to 300s
    // permanently — exactly the warn threshold — and the alert fires forever for
    // the entire free tier.
    const p = await provision();
    const scan = createWalScan({ pool, docker });
    const result = await scan.scanOnce({ superuserPasswordsFor });
    expect(result.unreachable).toBe(0);
    expect(result.checked).toBe(1);

    // Not asserted immediately: `archive-async=y` batches pushes, so a project
    // that has just written WAL routinely has a segment or two waiting for a
    // second. The claim is that it *drains* — an archive that never empties is the
    // failure this whole step exists to see.
    const r = await waitForDrain(p.id, scan, 60_000);
    expect(r.wal_archive_pending).toBe(0);
    expect(r.wal_archive_lag_seconds).toBe(0);
    expect(r.archive_state).toBe('ok');
    // ...and it did not get there by never having archived anything.
    expect(r.wal_last_archived_at).not.toBeNull();
    expect(r.backup_check_ok).toBe(true);
  });

  t('a project nothing has sampled is `unknown`, never `ok`', async () => {
    // Defaulting to healthy is how a fleet reports green for projects it has never
    // looked at, which is the same class of lie as an untested backup.
    const p = await provision();
    expect((await row(p.id)).archive_state).toBe('unknown');
  });
});

describe('P3b — EXIT CRITERION: break archiving and watch the number move', () => {
  t('sabotaged archiving produces pending segments, rising lag, and a failed check',
    async () => {
      const p = await provision();

      // Healthy first, on the real thresholds, so the sabotage is the only
      // difference. The production ladder is used throughout below; an earlier
      // version of this test lowered it to 2s/5s and the *healthy* baseline came
      // back `critical`, because `archive-async=y` batches pushes and a project
      // that just wrote WAL routinely has a second or two pending. That is worth
      // knowing on its own: it means any threshold near zero is noise, which is a
      // second independent reason the catalog's warn line sits at five minutes.
      const scan = createWalScan({ pool, docker });
      await scan.scanOnce({ superuserPasswordsFor });
      expect((await row(p.id)).archive_state).toBe('ok');

      // The sabotage: point the repo at a bucket that does not exist. Realistic —
      // it is what a botched credential or bucket rename looks like — per-project,
      // and reversible, which a stopped object store would not be.
      const repo = repoTargetFromEnv()!;
      const cipherPass = (await secrets.get(p.id, SECRET_NAMES.backupCipherPass))!;
      await writeConf(docker, p.container, renderPgbackrestConf({
        projectId: p.id, plan: 'free', cipherPass,
        repo: { ...repo, bucket: 'steadhold-backups-that-do-not-exist' },
      }));

      const c = await adminClient(p.port, p.id);
      try {
        await produceWal(c, 3);
      } catch (err) {
        const logs = await docker.containerLogs(p.container).catch(() => '(no logs)');
        throw new Error(`produceWal failed: ${(err as Error).message}\n--- container ---\n` +
          logs.split('\n').slice(-25).join('\n'));
      } finally { await c.end().catch(() => {}); }

      // Give the async archiver time to try and fail. `archive_command` retries on
      // Postgres' own schedule, so the segments stay `.ready` and keep ageing.
      await new Promise((r) => setTimeout(r, 6000));

      await scan.scanOnce({ superuserPasswordsFor });
      const broken = await row(p.id);

      // Segments are waiting: the direct evidence that WAL is not reaching the repo.
      expect(broken.wal_archive_pending!).toBeGreaterThan(0);
      expect(broken.wal_archive_lag_seconds!).toBeGreaterThan(0);
      // The repo check is the second, independent signal, and it fails too.
      expect(broken.backup_check_ok).toBe(false);
      expect(broken.backup_check_error).toBeTruthy();
      // Postgres' own counter has moved, which is the signal that survives even
      // when a failed push is retried successfully inside one sweep window.
      expect(Number(broken.wal_archive_failed_count)).toBeGreaterThan(0);

      // On the production ladder this is still `ok`, and correctly so — six
      // seconds of lag is not five minutes of it. The rung transition is proven by
      // running one sweep with the warn line moved *below* the lag we just
      // created, which isolates the ladder from the wall clock without pretending
      // a healthy project would ever be measured that way.
      expect(broken.archive_state).toBe('ok');
      const tight = createWalScan({ pool, docker, ladder: { warn: 1, critical: 1_000_000 } });
      await tight.scanOnce({ superuserPasswordsFor });
      expect((await row(p.id)).archive_state).toBe('warn');

      // ── and it recovers ────────────────────────────────────────────────────
      // A metric that rises and never falls is an alert that cannot clear, so the
      // repair half is as much of the criterion as the break.
      await writeConf(docker, p.container, renderPgbackrestConf({
        projectId: p.id, plan: 'free', cipherPass, repo,
      }));
      const recovered = await waitForDrain(p.id, scan);
      expect(recovered.wal_archive_pending).toBe(0);
      expect(recovered.wal_archive_lag_seconds).toBe(0);
      expect(recovered.archive_state).toBe('ok');
      expect(recovered.backup_check_ok).toBe(true);
      // The error text is cleared rather than left behind to be read as current.
      expect(recovered.backup_check_error).toBeNull();
    }, 300_000);

  t('an unreachable project keeps its previous rung instead of being called healthy',
    async () => {
      const p = await provision();
      const scan = createWalScan({ pool, docker });
      await scan.scanOnce({ superuserPasswordsFor });
      expect((await row(p.id)).archive_state).toBe('ok');

      // No password ⇒ no sample. "Cannot measure" is not "measured as fine": a
      // scan that treats an unreachable project as healthy reports a green fleet
      // during exactly the incident it exists to catch.
      await pool.query(
        `update project_databases set archive_state = 'critical' where project_id = $1`, [p.id]);
      const r = await scan.scanOnce({ superuserPasswordsFor: async () => [] });
      expect(r.unreachable).toBe(1);
      expect(r.checked).toBe(0);
      expect((await row(p.id)).archive_state).toBe('critical');
    });
});

describe('P3b — the alert rules themselves', () => {
  t('promtool agrees the rules parse and fire on the catalog thresholds', async () => {
    // The other half of the criterion. A rule file that parses proves nothing about
    // whether it fires; these drive synthetic series through the real expressions.
    const { stdout } = await run('docker', [
      'run', '--rm', '-v', `${MONITORING}:/w:ro`, '-w', '/w',
      '--entrypoint', 'promtool', 'prom/prometheus:v3.1.0',
      'test', 'rules', 'rules.test.yml',
    ]);
    expect(stdout).toContain('SUCCESS');
  }, 180_000);

  t('the thresholds in the rules are the ones the code uses', async () => {
    // Two places hold these numbers — the scan and the alert file — and they have
    // to agree or the dashboard and the pager tell different stories.
    const rules = readFileSync(join(MONITORING, 'rules.yml'), 'utf8');
    expect(rules).toContain(`steadhold_backup_wal_archive_lag_seconds > ${ARCHIVE_LADDER.warn}`);
    expect(rules).toContain(`steadhold_backup_wal_archive_lag_seconds > ${ARCHIVE_LADDER.critical}`);
  });
});
