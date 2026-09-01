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
  repoTargetFromEnv, renderPgbackrestConf, repoPathFor, STANZA,
  info as repoInfo, backup as takeBackup, check as archiveCheck,
} from './backup.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P3a integration: a project gets a real pgBackRest repo in real object storage.
 *
 * The operating rule of the whole phase is that a backup which has not been
 * restore-tested does not exist, so nothing here claims a project is protected.
 * What it proves is narrower and is the precondition for P3d: the repo exists, it
 * is reachable from inside the project's own private network, WAL actually lands
 * in it, and what lands is encrypted.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

/**
 * The repo target comes from the same file `./scripts/staging.sh backup-store`
 * writes, loaded here rather than required in the environment: a suite that only
 * runs when someone remembered to export four variables is a suite that silently
 * stops running.
 */
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
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-p3a-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    await pool.query('select 1');
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
      `insert into organizations (name, slug) values ('B','b3-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P3a integration setup FAILED:', reason);
    up = false;
  }
}, 60_000);

const created = { containers: new Set<string>(), volumes: new Set<string>() };

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

const t = (n: string, fn: () => Promise<void>, ms = 180_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P3a preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && ./scripts/staging.sh backup-store && seed-images. ' +
      'This is the P3a done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'b' + String(Date.now() % 100000) + String(++seq).padStart(14, 'y');

async function mkProject(plan = 'free') {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan)
     values ($1,$2,$3,$4::project_plan) returning id, ref::text as ref`,
    [orgId, ref, 'bk-' + seq, plan]);
  created.containers.add(containerName(ref));
  return rows[0]!;
}

async function runSteps(projectId: string, names: string[], extra: Record<string, unknown> = {}) {
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 90_000, ...extra });
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

const UP_TO_BACKUPS = [
  'allocate_node', 'create_volume', 'create_network', 'start_container', 'wait_healthy',
  'configure_backups', 'verify_archiving',
];

const placement = async (projectId: string) => (await pool.query<{
  volume_name: string; container_id: string | null; port: number;
}>(`select volume_name, container_id, port from project_databases where project_id=$1`,
  [projectId])).rows[0]!;

/** What the object store actually holds under a prefix, via mc inside MinIO. */
async function objectsUnder(prefix: string): Promise<string[]> {
  const bucket = process.env['CB_BACKUP_S3_BUCKET']!;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  // `--insecure`: the store serves TLS with a self-signed certificate, and mc
  // without this flag fails silently into an empty listing — which reads as "the
  // backup did not land" rather than "the listing could not be made".
  const { stdout } = await run('docker', ['exec', 'cb-object-store',
    'mc', '--insecure', 'ls', '--recursive', `local/${bucket}${prefix}`])
    .catch((e: Error) => { throw new Error(`mc ls failed: ${e.message.slice(0, 300)}`); });
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

describe('P3a — the repo exists and is the project\'s own', () => {
  t('provisioning creates a stanza and verifies archiving end to end', async () => {
    await registerNode(pool, { hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
    const p = await mkProject('free');
    const logs = await runSteps(p.id, UP_TO_BACKUPS);
    created.volumes.add((await placement(p.id)).volume_name);

    expect(logs.join('\n')).toContain('stanza created');
    // The claim that matters: `pgbackrest check` forces a WAL switch and confirms
    // the segment arrived, so this line means the whole path works — config,
    // cipher-pass, S3 credentials, and NAT egress out of a private network.
    expect(logs.join('\n')).toContain('archiving verified end to end');

    const container = containerName(p.ref);
    const repo = await repoInfo(docker, container);
    expect(repo.status).toMatch(/no valid backups|ok/i);
  });

  t('the cipher-pass is stored envelope-encrypted, not in the container environment', async () => {
    await registerNode(pool, { hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
    const p = await mkProject('free');
    await runSteps(p.id, UP_TO_BACKUPS);
    created.volumes.add((await placement(p.id)).volume_name);

    const pass = await secrets.get(p.id, SECRET_NAMES.backupCipherPass);
    expect(pass).toBeTruthy();
    expect(pass!.length).toBeGreaterThanOrEqual(32);

    // Ciphertext at rest.
    const { rows } = await pool.query<{ ciphertext: Buffer }>(
      `select ciphertext from project_secrets where project_id=$1 and name=$2`,
      [p.id, SECRET_NAMES.backupCipherPass]);
    expect(rows[0]!.ciphertext.toString('utf8')).not.toContain(pass!);

    // And not in the container's environment, which `docker inspect` shows to
    // anyone who can reach the Engine API — i.e. the whole control plane. This is
    // why the config is written with exec rather than passed as an env var.
    const inspect = await docker.inspectContainer(containerName(p.ref));
    const env = JSON.stringify((inspect as unknown as { Config: { Env?: string[] } }).Config.Env ?? []);
    expect(env).not.toContain(pass!);
  });

  t('a full backup lands in object storage under the project\'s own prefix', async () => {
    await registerNode(pool, { hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
    const p = await mkProject('free');
    await runSteps(p.id, [...UP_TO_BACKUPS, 'create_base_roles', 'store_credentials']);
    const place = await placement(p.id);
    created.volumes.add(place.volume_name);
    const container = containerName(p.ref);

    // Something to back up, so "the backup succeeded" is not a statement about an
    // empty database.
    const admin = new Client({
      host: '127.0.0.1', port: place.port, user: 'postgres', database: 'postgres',
      password: (await secrets.get(p.id, SECRET_NAMES.postgres))!,
      connectionTimeoutMillis: 8000,
    });
    await admin.connect();
    await admin.query(`create table p3a (id int primary key, payload text)`);
    await admin.query(`insert into p3a select g, md5(g::text) from generate_series(1,1000) g`);
    await admin.end();

    await takeBackup(docker, container, 'full');
    const repo = await repoInfo(docker, container);
    expect(repo.labels).toHaveLength(1);
    expect(repo.labels[0]).toMatch(/^\d{8}-\d{6}F$/);
    expect(repo.repoBytes).toBeGreaterThan(0);

    // In the bucket, under this project's path and nowhere else.
    const mine = await objectsUnder(repoPathFor(p.id));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.join('\n')).toContain('backup');
  });

  t('two projects get separate repo paths and separate cipher-passes', async () => {
    await registerNode(pool, { hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
    const a = await mkProject('free');
    const b = await mkProject('free');
    await runSteps(a.id, UP_TO_BACKUPS);
    created.volumes.add((await placement(a.id)).volume_name);
    await runSteps(b.id, UP_TO_BACKUPS);
    created.volumes.add((await placement(b.id)).volume_name);

    expect(repoPathFor(a.id)).not.toBe(repoPathFor(b.id));
    const passA = await secrets.get(a.id, SECRET_NAMES.backupCipherPass);
    const passB = await secrets.get(b.id, SECRET_NAMES.backupCipherPass);
    expect(passA).not.toBe(passB);

    // Both stanzas are called `main`; isolation is the prefix, not the name.
    // Reading A's repo with B's config must therefore find nothing of A's.
    const infoB = await repoInfo(docker, containerName(b.ref));
    expect(infoB.labels).toEqual([]);
  });

  t('re-running both steps is a no-op, so a replayed saga is safe', async () => {
    await registerNode(pool, { hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
    const p = await mkProject('free');
    await runSteps(p.id, UP_TO_BACKUPS);
    created.volumes.add((await placement(p.id)).volume_name);
    const passFirst = await secrets.get(p.id, SECRET_NAMES.backupCipherPass);

    const again = await runSteps(p.id, ['configure_backups', 'verify_archiving']);
    expect(again.join('\n')).toContain('stanza already present');
    expect(again.join('\n')).toContain('repo cipher-pass reused');
    // A regenerated cipher-pass would orphan every object already written — the
    // repo would be full of history nobody can decrypt, discovered at restore time.
    expect(await secrets.get(p.id, SECRET_NAMES.backupCipherPass)).toBe(passFirst);
  });

  t('a project with no repo configured provisions, loudly, unless backups are required', async () => {
    await registerNode(pool, { hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
    const saved = process.env['CB_BACKUP_S3_ENDPOINT'];
    delete process.env['CB_BACKUP_S3_ENDPOINT'];
    try {
      const p = await mkProject('free');
      const logs = await runSteps(p.id, UP_TO_BACKUPS);
      created.volumes.add((await placement(p.id)).volume_name);
      expect(logs.join('\n')).toContain('NO BACKUP REPO CONFIGURED');

      // ...and with the gate on it refuses, rather than creating a project whose
      // PITR silently does not exist.
      await expect(runSteps(p.id, ['configure_backups'], { requireBackups: true }))
        .rejects.toThrow(/backups are required/);
    } finally {
      if (saved) process.env['CB_BACKUP_S3_ENDPOINT'] = saved;
    }
  });
});

describe('P3a — the config itself', () => {
  t('data checksums are on, which restore verification depends on', async () => {
    // Provisioning §3 says initdb runs with --data-checksums and backups §7's
    // verification requires it. The flag was missing from the image, and its
    // absence is invisible in both directions: page corruption goes undetected and
    // a verification pass reports a healthy restore of a rotting cluster.
    await registerNode(pool, { hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
    const p = await mkProject('free');
    await runSteps(p.id, ['allocate_node', 'create_volume', 'create_network',
      'start_container', 'wait_healthy']);
    const place = await placement(p.id);
    created.volumes.add(place.volume_name);
    const r = await docker.execCapture(containerName(p.ref),
      ['psql', '-U', 'postgres', '-tAc', 'show data_checksums']);
    expect(r.stdout.trim()).toBe('on');
  });

  t('the archive command routes WAL to pgBackRest, with one stanza name fleet-wide', async () => {
    await registerNode(pool, { hostname: 'data-node-local', ramTotalMb: 8192, diskTotalGb: 200, address: '127.0.0.1' });
    const p = await mkProject('free');
    await runSteps(p.id, UP_TO_BACKUPS);
    created.volumes.add((await placement(p.id)).volume_name);
    const r = await docker.execCapture(containerName(p.ref),
      ['psql', '-U', 'postgres', '-tAc', 'show archive_command']);
    expect(r.stdout.trim()).toBe(`pgbackrest --stanza=${STANZA} archive-push %p`);
    // A per-project stanza name would need a per-project postgresql.conf, which is
    // the drift D-186 removed. Isolation is repo1-path, asserted above.
    const check = await archiveCheck(docker, containerName(p.ref));
    expect(check.ok).toBe(true);
  });
});
