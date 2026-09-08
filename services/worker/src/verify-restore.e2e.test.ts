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
import { repoTargetFromEnv, backup as takeBackup, repoPathFor } from './backup.ts';
import { createVerifier, floorFor, VERIFY_FLOOR_DAYS } from './verify-restore.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P3h — **exit criterion 2**: restore verification runs and alerts on failure,
 * tested by sabotaging a backup.
 *
 * The sabotage is the half that matters. A verifier that passes on healthy
 * backups and also passes on broken ones is worse than no verifier, because it
 * manufactures the confidence the whole phase is built to earn — and "a backup
 * that has not been restore-tested is treated as not existing" becomes a sentence
 * about a test that cannot fail.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const CERT_DIR = process.env.SH_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.SH_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SH_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';
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
  kekDir = mkdtempSync(join(tmpdir(), 'sh-kek-p3h-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    await pool.query('select 1 from restore_verifications limit 0');   // P3h migration?
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
      `insert into organizations (name, slug) values ('V','v3-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P3h integration setup FAILED:', reason);
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
  // `nodes` too. Without it a stale row from another suite survives — one that
  // never had an `address` recorded — and the bin-packer picks it on fill ratio,
  // because an empty node is the emptiest node. The provision then fails nine
  // steps later with "no address recorded", non-deterministically, depending on
  // which suite ran first.
  await pool.query(
    'truncate provisioning_jobs, project_databases, project_repos, projects, nodes cascade');
  await wipeNode();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 600_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P3h preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && backup-store && seed-images. ' +
      'This is the P3h done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'v' + String(Date.now() % 100000) + String(++seq).padStart(14, 's');

const heartbeat = () => registerNode(pool, {
  hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });

async function runSteps(projectId: string, names: string[]) {
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 120_000 });
  const steps = sagas['provision_project']!;
  const job = { id: 'j', project_id: projectId } as unknown as JobRecord;
  for (const name of names) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`no step named ${name}`);
    await step.run({ job, log: () => {} });
  }
}

const PROVISION = [
  'allocate_node', 'create_volume', 'create_network', 'start_container', 'wait_healthy',
  'configure_backups', 'verify_archiving', 'create_base_roles', 'store_credentials',
  'write_connection',
];

/** A project with a real table, a real backup, and its port for live queries. */
async function projectWithBackup(rows = 400) {
  await heartbeat();
  const ref = mkRef();
  const { rows: pr } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,'free','ready') returning id, ref::text as ref`,
    [orgId, ref, 'ver-' + seq]);
  const p = pr[0]!;
  await runSteps(p.id, PROVISION);
  const { rows: place } = await pool.query<{ volume_name: string; port: number }>(
    `select volume_name, port from project_databases where project_id=$1`, [p.id]);
  created.volumes.add(place[0]!.volume_name);

  const admin = new Client({
    host: '127.0.0.1', port: place[0]!.port, user: 'postgres', database: 'postgres',
    password: (await secrets.get(p.id, SECRET_NAMES.postgres))!,
    connectionTimeoutMillis: 10_000,
  });
  await admin.connect();
  await admin.query(`create table invoices (id int primary key, amount numeric, note text)`);
  await admin.query(
    `insert into invoices select g, g * 1.5, md5(g::text) from generate_series(1, ${rows}) g`);
  await admin.query(`analyze invoices`);
  await admin.end();

  await takeBackup(docker, containerName(p.ref), 'full');
  return { ...p, port: place[0]!.port };
}

const cipherFor = (projectId: string) =>
  secrets.get(projectId, SECRET_NAMES.backupCipherPass).then((v) => v!);

describe('P3h — verifying a healthy backup', () => {
  t('restores it into a scratch instance, runs every check, and passes', async () => {
    const p = await projectWithBackup();
    const verifier = createVerifier({ pool, docker });

    // The expectation comes from the *live* project, not from the restore — a
    // sanity check compares two databases and is meaningless if both sides came
    // from the thing being tested.
    const expect_ = await verifier.expectationFrom(
      '127.0.0.1', p.port, (await secrets.get(p.id, SECRET_NAMES.postgres))!);
    expect(expect_?.nonEmptyTables).toContain('invoices');

    const outcome = await verifier.verify({
      projectId: p.id, ref: p.ref, plan: 'free',
      cipherPass: await cipherFor(p.id), expect: expect_,
    });

    // Printed, not just asserted: a failed check's reason is the only thing that
    // says *why*, and vitest truncates it inside a diff.
    process.stdout.write(`      outcome: ${JSON.stringify(outcome, null, 1)}\n`);
    expect(outcome.reason ?? '').toBe('');
    expect(outcome.passed).toBe(true);
    expect(outcome.backupLabel).toMatch(/^\d{8}-\d{6}F$/);
    // Measured restore time, which is what feeds the RTO table with numbers
    // instead of aspirations.
    expect(outcome.restoreMs).toBeGreaterThan(0);
    expect(outcome.bytesRestored).toBeGreaterThan(0);
  });

  t('leaves nothing behind on the verification node', async () => {
    // A verifier that leaked a container and a volume per run would fill the node
    // exactly when the fleet is having its worst day.
    const before = (await docker.listVolumes()).length;
    const p = await projectWithBackup(100);
    await createVerifier({ pool, docker }).verify({
      projectId: p.id, ref: p.ref, plan: 'free', cipherPass: await cipherFor(p.id) });

    const scratch = (await docker.listContainers())
      .filter((c) => c.Names.some((n) => n.includes('sh-verify-')));
    expect(scratch).toEqual([]);
    // The project's own volume remains; the scratch one does not.
    expect((await docker.listVolumes()).length).toBe(before + 1);
  });
});

describe('P3h — EXIT CRITERION: sabotage a backup and the verification fails', () => {
  t('a corrupted backup file is caught, not passed', async () => {
    // The half that matters. A verifier that passes healthy backups and also
    // passes broken ones manufactures exactly the confidence this phase exists to
    // earn.
    const p = await projectWithBackup(200);

    // Overwrite a file inside the backup set with garbage — bit-rot, as it would
    // actually arrive. Written with `mc` rather than the control plane's own S3
    // client on purpose: that client has no PUT, because delete rights are the
    // only write rights the control plane is supposed to hold (backups §6), and
    // adding one to sabotage a test would have broken the access model it
    // documents.
    const bucket = process.env['SH_BACKUP_S3_BUCKET']!;
    const prefix = repoPathFor(p.id).replace(/^\//, '');
    const { stdout: listing } = await run('docker', ['exec', 'sh-object-store',
      'mc', '--insecure', 'ls', '--recursive', `local/${bucket}/${prefix}/backup`]);
    const target = listing.split('\n').map((l) => l.trim().split(/\s+/).pop() ?? '')
      .filter((k) => k.endsWith('.zst') || k.endsWith('.gz'))[0];
    expect(target, 'no backup data file found to sabotage').toBeTruthy();

    await run('docker', ['exec', 'sh-object-store', 'sh', '-c',
      `head -c 4096 /dev/urandom > /tmp/garbage && mc --insecure cp /tmp/garbage ` +
      `local/${bucket}/${prefix}/backup/${target} >/dev/null`]);

    const outcome = await createVerifier({ pool, docker }).verify({
      projectId: p.id, ref: p.ref, plan: 'free', cipherPass: await cipherFor(p.id) });

    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toBeTruthy();
    // And it says which check caught it, so a pattern across the fleet is visible
    // without reading every reason string.
    expect(['restore', 'recovery', 'checksums', 'amcheck', 'sanity'])
      .toContain(outcome.failedCheck);
  });

  t('an empty repo fails rather than reporting a vacuous pass', async () => {
    // A project whose repo holds nothing has not been verified — it has been found
    // to have nothing to verify, and those must not report the same way.
    await heartbeat();
    const ref = mkRef();
    const { rows } = await pool.query<{ id: string; ref: string }>(
      `insert into projects (organization_id, ref, name, plan, status)
       values ($1,$2,$3,'free','ready') returning id, ref::text as ref`,
      [orgId, ref, 'empty-' + seq]);
    const p = rows[0]!;
    await runSteps(p.id, PROVISION);
    const { rows: place } = await pool.query<{ volume_name: string }>(
      `select volume_name from project_databases where project_id=$1`, [p.id]);
    created.volumes.add(place[0]!.volume_name);

    const outcome = await createVerifier({ pool, docker }).verify({
      projectId: p.id, ref: p.ref, plan: 'free', cipherPass: await cipherFor(p.id) });
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toMatch(/no backups/);
  });

  t('a wrong cipher-pass fails rather than restoring nothing quietly', async () => {
    const p = await projectWithBackup(100);
    const outcome = await createVerifier({ pool, docker }).verify({
      projectId: p.id, ref: p.ref, plan: 'free', cipherPass: 'x'.repeat(48) });
    expect(outcome.passed).toBe(false);
    expect(outcome.failedCheck).toBeTruthy();
  });
});

describe('P3h — the per-plan floors (D-176)', () => {
  it('verifies Free every 90 days and paid plans every 30', () => {
    expect(VERIFY_FLOOR_DAYS['free']).toBe(90);
    expect(VERIFY_FLOOR_DAYS['pro']).toBe(30);
    expect(VERIFY_FLOOR_DAYS['team']).toBe(30);
    // An unknown plan gets the *loosest* floor, which is the only safe direction:
    // the alternative is a new plan silently getting verified every 30 days and
    // multiplying the verification load without anyone choosing that.
    expect(floorFor('invented')).toBe(90);
  });
});

describe('P3h — the scheduler picks the right project (D-176)', () => {
  /**
   * The candidate query, without running any restores.
   *
   * `batchSize: 0` would be a different code path, so the ordering and the floors
   * are checked by asking the same SQL the sweep asks. What is under test here is
   * *which* project gets verified and when — a decision over rows, which is why it
   * does not need a container and should not have one: the verifier itself is
   * covered above, and provisioning a project per case is what made the P3d suite
   * unable to finish under load.
   */
  const candidates = async (limit = 5) => (await pool.query<{
    ref: string; plan: string; last_passed: Date | null;
  }>(
    `SELECT p.ref::text AS ref, p.plan::text AS plan, v.last_passed
       FROM projects p
       JOIN project_databases d ON d.project_id = p.id
       JOIN nodes n ON n.id = d.node_id
       LEFT JOIN LATERAL (
         SELECT max(finished_at) AS last_passed FROM restore_verifications rv
          WHERE rv.project_id = p.id AND rv.result = 'passed'
       ) v ON true
      WHERE p.status IN ('ready', 'paused')
        AND (v.last_passed IS NULL
             OR v.last_passed < now() - make_interval(days =>
                  CASE p.plan::text WHEN 'free' THEN 90 ELSE 30 END))
      ORDER BY v.last_passed ASC NULLS FIRST
      LIMIT $1`, [limit])).rows;

  /** A project row with a placement, but no containers — rows are all this needs. */
  async function fakeProject(plan: string, status = 'ready') {
    await heartbeat();
    const ref = mkRef();
    const { rows } = await pool.query<{ id: string; ref: string }>(
      `insert into projects (organization_id, ref, name, plan, status)
       values ($1,$2,$3,$4::project_plan,$5::project_status) returning id, ref::text as ref`,
      [orgId, ref, 'sched-' + seq, plan, status]);
    const p = rows[0]!;
    const { rows: n } = await pool.query<{ id: string }>(`select id from nodes limit 1`);
    await pool.query(
      `insert into project_databases
         (project_id, node_id, volume_name, port, pooler_port, ram_limit_mb,
          ram_booked_mb, disk_limit_mb, status)
       values ($1,$2,$3,$4,$5,512,350,500,'running')`,
      [p.id, n[0]!.id, 'sh-' + ref + '-pgdata', 15000 + seq, 16000 + seq]);
    return p;
  }

  const recordVerification = (projectId: string, daysAgo: number, result = 'passed') =>
    pool.query(
      `insert into restore_verifications (project_id, result, finished_at)
       values ($1, $2, now() - make_interval(days => $3::int))`,
      [projectId, result, daysAgo]);

  t('puts a never-verified project first, not last', async () => {
    // The half a longest-unverified ordering gets exactly backwards. A project
    // nobody has ever verified is the likeliest to be broken in a way nobody has
    // noticed — a misconfigured repo, a cipher-pass that never matched, a schedule
    // that never fired — and it has no timestamp to be old, so it sorts last.
    const old = await fakeProject('free');
    await recordVerification(old.id, 120);
    const never = await fakeProject('free');

    const order = (await candidates()).map((r) => r.ref);
    expect(order[0]).toBe(never.ref);
    expect(order).toContain(old.ref);
  });

  t('leaves a project verified inside its own floor alone', async () => {
    const freeFresh = await fakeProject('free');
    await recordVerification(freeFresh.id, 60);      // inside 90
    const proStale = await fakeProject('pro');
    await recordVerification(proStale.id, 60);       // outside 30

    const refs = (await candidates()).map((r) => r.ref);
    expect(refs).not.toContain(freeFresh.ref);
    // Same age, different plan, different answer — which is the whole point of
    // per-plan floors rather than one fleet-wide interval.
    expect(refs).toContain(proStale.ref);
  });

  t('does not count a failed verification as a verification', async () => {
    // D-176's rule that a failure treats the backups as nonexistent, expressed as
    // scheduling: the project stays at the front of the queue until one passes.
    const p = await fakeProject('free');
    await recordVerification(p.id, 1, 'failed');
    expect((await candidates()).map((r) => r.ref)).toContain(p.ref);
  });

  t('includes paused projects, which need it most', async () => {
    // A paused project has no running Postgres, so its backup is its only life
    // (D-077). Excluding it from verification would leave the fleet's least
    // observable projects entirely unchecked.
    const paused = await fakeProject('free', 'paused');
    expect((await candidates()).map((r) => r.ref)).toContain(paused.ref);
  });

  t('ignores projects that are gone or still being built', async () => {
    const deleting = await fakeProject('free', 'deleting');
    const creating = await fakeProject('free', 'creating');
    const refs = (await candidates(20)).map((r) => r.ref);
    expect(refs).not.toContain(deleting.ref);
    expect(refs).not.toContain(creating.ref);
  });
});
