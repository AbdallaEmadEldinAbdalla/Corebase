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
import { repoTargetFromEnv, backup as takeBackup } from './backup.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P3d — **exit criterion 1**: PITR to an arbitrary timestamp within retention,
 * proven by restoring a project and finding a row written at a known time.
 *
 * The proof has two halves and the second is the one that matters. Finding the
 * early row shows the restore brought data back. Finding that the *late* row is
 * absent shows it stopped where it was told — a restore that replayed everything
 * would pass the first half and be useless as point-in-time recovery, and a
 * restore that replayed nothing past the base backup would also pass the first
 * half while quietly holding the wrong day.
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
  pool = new Pool({ connectionString: DB, max: 8, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-p3d-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    await pool.query('select 1');
    await pool.query('select 1 from project_restores limit 0');   // P3d migration?
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 120_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    if (!repoTargetFromEnv()) {
      throw new Error('no backup repo configured — run ./scripts/staging.sh backup-store');
    }
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('R','r3-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P3d integration setup FAILED:', reason);
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
}, 90_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects, nodes cascade');
  await wipeNode();
}, 90_000);

/**
 * Fifteen minutes, and not because a restore takes that long.
 *
 * A restore of a small database is seconds of real work. What this has to survive
 * is a loaded developer machine: the same provisioning step that takes 7 s on an
 * idle laptop took 33 s at load average 12, and a test whose budget assumes the
 * idle number reports a product failure when what actually happened is that
 * something else was compiling. The generous ceiling costs nothing on a quiet
 * machine — these tests finish in well under a minute — and it stops a red suite
 * from meaning "your laptop was busy".
 */
const t = (n: string, fn: () => Promise<void>, ms = 900_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P3d preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && backup-store && seed-images. ' +
      'This is the P3d done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'r' + String(Date.now() % 100000) + String(++seq).padStart(14, 'v');

async function mkProject(plan = 'free', status = 'ready') {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,$4::project_plan,$5::project_status) returning id, ref::text as ref`,
    [orgId, ref, 'res-' + seq, plan, status]);
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
    // Printed as it goes, not collected and returned. A restore hung inside
    // `recover_to_target` for sixteen minutes and the only thing the failure said
    // was "timed out" — every log line the saga had emitted was sitting in an array
    // this function had not returned yet.
    const t0 = Date.now();
    process.stdout.write(`      → ${name}\n`);
    await step.run({
      job,
      log: (m, e) => {
        logs.push(m + (e ? ' ' + JSON.stringify(e) : ''));
        process.stdout.write(`        ${m}${e ? ' ' + JSON.stringify(e) : ''}\n`);
      },
    });
    process.stdout.write(`      ✓ ${name} (${Date.now() - t0}ms)\n`);
  }
  return logs;
}

const PROVISION = [
  'allocate_node', 'create_volume', 'create_network', 'start_container', 'wait_healthy',
  'configure_backups', 'verify_archiving', 'create_base_roles', 'store_credentials',
  'write_connection',
];
const RESTORE = [
  'allocate_node', 'create_volume', 'create_network', 'restore_into_volume',
  'recover_to_target', 'reset_restored_credentials', 'configure_backups',
  'verify_archiving', 'write_connection', 'mark_restored',
];

const placementOf = async (projectId: string) => (await pool.query<{
  volume_name: string; port: number;
}>(`select volume_name, port from project_databases where project_id=$1`, [projectId])).rows[0]!;

async function adminOn(projectId: string) {
  const place = await placementOf(projectId);
  const c = new Client({
    host: '127.0.0.1', port: place.port, user: 'postgres', database: 'postgres',
    password: (await secrets.get(projectId, SECRET_NAMES.postgres))!,
    connectionTimeoutMillis: 10_000,
  });
  await c.connect();
  return c;
}

/**
 * Re-register the node, which is what a running worker's heartbeat does.
 *
 * Called before every placement, and it is not test scaffolding for its own sake:
 * placement refuses a node whose `last_seen_at` is older than 900 s (D-254), and
 * this suite registers the node itself because no worker process is running. The
 * first version registered once at the start, and the restore's `allocate_node`
 * then failed with *"every active node in eu-central is stale — the freshest was
 * last seen 1019s ago"* — the guard working exactly as designed, against a test
 * that had been running for seventeen minutes with nothing heartbeating.
 */
const heartbeat = () => registerNode(pool, {
  hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });

async function provision(plan = 'free') {
  await heartbeat();
  const p = await mkProject(plan);
  await runSteps('provision_project', p.id, PROVISION);
  created.volumes.add((await placementOf(p.id)).volume_name);
  return p;
}

/** Create the restore's project row and lineage, the way the API's store does. */
async function requestRestore(source: { id: string; ref: string }, targetTime: Date | null) {
  await heartbeat();
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,'free','restoring') returning id, ref::text as ref`,
    [orgId, ref, 'restore-' + seq]);
  const p = rows[0]!;
  await pool.query(
    `insert into project_restores (project_id, source_project_id, source_ref, target_time)
     values ($1,$2,$3,$4)`, [p.id, source.id, source.ref, targetTime]);
  return p;
}

const restoreRow = async (projectId: string) => (await pool.query<{
  status: string; target_time: Date | null; reached_time: Date | null;
  reached_lsn: string | null; backup_label: string | null; error: string | null;
}>(`select status, target_time, reached_time, reached_lsn, backup_label, error
      from project_restores where project_id = $1`, [projectId])).rows[0]!;

describe('P3d — EXIT CRITERION: point-in-time recovery', () => {
  t('restores to a chosen second: the early row is there, the late row is not',
    async () => {
      const source = await provision('free');
      const container = containerName(source.ref);

      // ── build a history with a known instant in the middle ────────────────
      const admin = await adminOn(source.id);
      let target: Date;
      try {
        await admin.query(`create table ledger (id int primary key, note text, at timestamptz)`);
        await admin.query(`insert into ledger values (1, 'before the mistake', now())`);
        // A base backup *before* the target, so the restore has to replay WAL to
        // get to it rather than simply landing on a backup boundary. A test whose
        // target coincides with a base backup proves the base backup works.
        await takeBackup(docker, container, 'full');
        // A real gap after the backup before the target is chosen. pgBackRest needs
        // a base whose *stop time* is strictly before the target and compares at
        // second granularity, so a target in the same second as the backup's
        // completion is unrestorable:
        //   ERROR: [075]: unable to find backup set with stop time less than '…'
        // Which is also true of the product: nobody restores to the instant their
        // base backup finished, but the test was doing exactly that.
        await new Promise((r) => setTimeout(r, 2500));
        await admin.query(`insert into ledger values (2, 'also before', now())`);

        // The instant to come back to, read from the database's own clock — not the
        // test process's. A restore target is compared against WAL timestamps
        // generated by the server, and a laptop clock a second off would make this
        // test flap for a reason that has nothing to do with the code.
        //
        // Rounded **up** to the next whole millisecond, and that is the fix for a
        // real intermittent failure (`expected [ 1 ] to include 2`). Postgres's
        // `now()` has microsecond precision; a JS `Date` and `toISOString()` have
        // millisecond precision, so the target loses its microseconds on the way
        // into the restore request — and truncation moves a target *backwards*.
        // When row 2 committed at `…22.123456` and `now()` returned `…22.123789`,
        // the target became `…22.123`, which is before row 2's commit, and the
        // restore correctly came back one transaction short.
        //
        // This is D-295 one order of magnitude down: the same class of bug, where
        // trimming a target's precision silently discards a committed
        // transaction. Rounding up cannot: the result is strictly after anything
        // committed before this query, and still two seconds clear of row 3.
        const { rows } = await admin.query<{ now: Date }>(
          `select date_trunc('milliseconds', now()) + interval '1 millisecond' as now`);
        target = rows[0]!.now;

        // Everything after this must NOT survive the restore. Two seconds of gap so
        // the target is unambiguously between them at WAL granularity.
        await new Promise((r) => setTimeout(r, 2000));
        await admin.query(`insert into ledger values (3, 'THE MISTAKE', now())`);
        await admin.query(`drop table if exists ledger_keepme`);
        await admin.query(`insert into ledger values (4, 'after the mistake', now())`);
        // Force the WAL holding all of this into the repo: without a switch the
        // segment sits open on the source and the restore genuinely cannot reach
        // the target — which would be a real failure, just not the one under test.
        await admin.query(`select pg_switch_wal()`);
      } finally { await admin.end().catch(() => {}); }

      // pgBackRest pushes asynchronously; give the segment time to land.
      await new Promise((r) => setTimeout(r, 4000));

      // ── restore to that instant, as a new project ────────────────────────
      const copy = await requestRestore(source, target);
      const logs = await runSteps('restore_project', copy.id, RESTORE);
      created.volumes.add((await placementOf(copy.id)).volume_name);

      expect(logs.join('\n')).toContain('volume restored from the source repo');
      expect(logs.join('\n')).toContain('recovery paused at the target');
      expect(logs.join('\n')).toContain('out of recovery and writable');

      const row = await restoreRow(copy.id);
      expect(row.status).toBe('succeeded');
      expect(row.backup_label).toBeTruthy();
      // The LSN is the load-bearing one: a non-null replay LSN means recovery
      // actually replayed WAL rather than starting from the base backup and
      // stopping.
      expect(row.reached_lsn).toBeTruthy();
      // `reached_time` comes from `pg_last_xact_replay_timestamp()`, which is
      // informational and legitimately NULL — it reports the last *transaction*
      // replayed, and recovery can reach its target having replayed none. So it is
      // recorded when available and asserted only when present. What recovery
      // reached must never be *after* what was asked for; before is expected, since
      // replay stops at the last transaction at or before the target.
      if (row.reached_time) {
        expect(row.reached_time.getTime()).toBeLessThanOrEqual(target.getTime() + 1000);
      }

      // ── the proof ────────────────────────────────────────────────────────
      const restored = await adminOn(copy.id);
      try {
        const { rows } = await restored.query<{ id: number; note: string }>(
          `select id, note from ledger order by id`);
        const ids = rows.map((r) => r.id);

        // Postgres says, in one line, exactly where recovery stopped:
        //   LOG: recovery stopping before commit of transaction N, time ...
        // Printed unconditionally rather than only on failure, because "which
        // transaction was the boundary" is the only question worth asking about a
        // PITR result and reading it after the fact needs the container to still
        // exist.
        const clusterLog = await docker.containerLogs(containerName(copy.ref))
          .catch(() => '');
        const boundary = clusterLog.split('\n')
          .filter((l) => /recovery stopping|last completed transaction|consistent recovery/i.test(l));
        process.stdout.write(
          `        rows restored: [${ids.join(', ')}]  target ${target.toISOString()}\n` +
          boundary.map((l) => `        ${l.trim()}\n`).join(''));
        // Written before the target: present.
        expect(ids).toContain(1);
        expect(ids).toContain(2);
        // Written after the target: gone. This is the half that makes it PITR
        // rather than "a restore".
        expect(ids).not.toContain(3);
        expect(ids).not.toContain(4);
        expect(rows.find((r) => r.note === 'THE MISTAKE')).toBeUndefined();

        // And it is a real, writable database rather than a paused replica.
        await restored.query(`insert into ledger values (99, 'written after restore', now())`);
        const after = await restored.query<{ n: number }>(
          `select count(*)::int as n from ledger where id = 99`);
        expect(after.rows[0]!.n).toBe(1);
      } finally { await restored.end().catch(() => {}); }

      // ── and the original is untouched ────────────────────────────────────
      // Production is never overwritten (proposal §36). If a restore could damage
      // the source, it would be the most dangerous operation in the product.
      const original = await adminOn(source.id);
      try {
        const { rows } = await original.query<{ n: number }>(
          `select count(*)::int as n from ledger`);
        expect(rows[0]!.n).toBe(4);
        const still = await original.query<{ note: string }>(
          `select note from ledger where id = 3`);
        expect(still.rows[0]!.note).toBe('THE MISTAKE');
      } finally { await original.end().catch(() => {}); }
    });

  t('the restored copy has its own credentials, and the source\'s no longer open it',
    async () => {
      // Without this the copy is reachable with the original's connection string:
      // one password opening two databases, and a rotation on the original that
      // silently does not cover the copy.
      const source = await provision('free');
      await takeBackup(docker, containerName(source.ref), 'full');
      await new Promise((r) => setTimeout(r, 2000));

      const copy = await requestRestore(source, null);
      await runSteps('restore_project', copy.id, RESTORE);
      created.volumes.add((await placementOf(copy.id)).volume_name);

      const sourcePw = (await secrets.get(source.id, SECRET_NAMES.developer))!;
      const copyPw = (await secrets.get(copy.id, SECRET_NAMES.developer))!;
      expect(copyPw).not.toBe(sourcePw);

      const place = await placementOf(copy.id);
      const withSourcePw = new Client({
        host: '127.0.0.1', port: place.port, user: 'developer', database: 'postgres',
        password: sourcePw, connectionTimeoutMillis: 8000,
      });
      await expect(withSourcePw.connect()).rejects.toThrow(/password|authentication/i);
      await withSourcePw.end().catch(() => {});

      const withOwnPw = new Client({
        host: '127.0.0.1', port: place.port, user: 'developer', database: 'postgres',
        password: copyPw, connectionTimeoutMillis: 8000,
      });
      await withOwnPw.connect();
      await withOwnPw.end();
    });

  t('the copy is `restored`, not `ready`, and gets a repo of its own', async () => {
    const source = await provision('free');
    await takeBackup(docker, containerName(source.ref), 'full');
    await new Promise((r) => setTimeout(r, 2000));

    const copy = await requestRestore(source, null);
    await runSteps('restore_project', copy.id, RESTORE);
    created.volumes.add((await placementOf(copy.id)).volume_name);

    const { rows } = await pool.query<{ status: string }>(
      `select status::text as status from projects where id = $1`, [copy.id]);
    // `ready` would make the copy indistinguishable from production in every list,
    // badge and API response — the confusion that ends with writes in the wrong one.
    expect(rows[0]!.status).toBe('restored');

    // Its own repo, not the source's: two projects archiving into one prefix would
    // interleave their WAL and make both unrestorable.
    const { rows: r2 } = await pool.query<{ n: number }>(
      `select count(*)::int as n from project_secrets
        where project_id = $1 and name = $2`, [copy.id, SECRET_NAMES.backupCipherPass]);
    expect(r2[0]!.n).toBe(1);
    const sourcePass = await secrets.get(source.id, SECRET_NAMES.backupCipherPass);
    expect(await secrets.get(copy.id, SECRET_NAMES.backupCipherPass)).not.toBe(sourcePass);
  });
});

describe('P3d — a restore that cannot reach its target fails loudly', () => {
  t('refuses to serve an earlier point when the target is before any backup',
    async () => {
      // The failure the doc forbids by name: "never silently serve an earlier
      // point". A target before the oldest base backup has no WAL to replay from,
      // so recovery cannot stop where it was told — and the only wrong answer is a
      // healthy-looking database holding the wrong day.
      const source = await provision('free');
      await takeBackup(docker, containerName(source.ref), 'full');
      await new Promise((r) => setTimeout(r, 2000));

      // A year before the repo existed.
      const impossible = new Date(Date.now() - 365 * 86_400_000);
      const copy = await requestRestore(source, impossible);
      await expect(runSteps('restore_project', copy.id, RESTORE)).rejects.toThrow();
      const place = await placementOf(copy.id).catch(() => undefined);
      if (place) created.volumes.add(place.volume_name);

      // And it did not end up marked as a usable copy.
      const { rows } = await pool.query<{ status: string }>(
        `select status::text as status from projects where id = $1`, [copy.id]);
      expect(rows[0]!.status).not.toBe('restored');
    });

  t('refuses when the source project is gone, rather than restoring nothing', async () => {
    const source = await provision('free');
    const copy = await requestRestore(source, null);
    // ON DELETE SET NULL: deleting the source must not delete the restore, which
    // may be the only surviving copy — but a restore that has not run yet then has
    // nothing to read, and saying so beats an empty database.
    await pool.query(`update project_restores set source_project_id = NULL where project_id = $1`,
      [copy.id]);
    await expect(runSteps('restore_project', copy.id,
      ['allocate_node', 'create_volume', 'create_network', 'restore_into_volume']))
      .rejects.toThrow(/source project .* is gone/);
    const place = await placementOf(copy.id).catch(() => undefined);
    if (place) created.volumes.add(place.volume_name);
  });
});
