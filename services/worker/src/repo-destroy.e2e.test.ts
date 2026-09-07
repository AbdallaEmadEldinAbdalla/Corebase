import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createS3, s3FromEnv, type S3 } from '@corebase/s3';
import { createRepoDestroy, REPO_RETENTION_DAYS } from './repo-destroy.ts';
import { repoPathFor } from './backup.ts';
import { loadBackupEnv } from './staging-env.ts';

/**
 * P3g — a purged project's backup repo is destroyed, provably (D-038, D-066).
 *
 * Real objects in the real store, because the claim is about object storage rather
 * than about our bookkeeping. The sweep writes rows and the rows are worth
 * checking, but a test that only checked rows would pass over a bucket it never
 * touched — which is exactly the state this step was written to end.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';


let pool: Pool; let s3: S3; let orgId: string;
let up = false; let reason = '';

beforeAll(async () => {
  loadBackupEnv();
  pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1 from project_repos limit 0');   // P3g migration?
    const cfg = s3FromEnv();
    if (!cfg) throw new Error('no object store configured — ./scripts/staging.sh backup-store');
    s3 = createS3(cfg);
    // Proves the control plane's own path to the store, which is a *different*
    // address from the projects' (see s3FromEnv). A test that assumed one endpoint
    // works for both would fail thirty seconds later with a timeout that reads
    // like a wrong secret.
    await s3.list('probe-that-matches-nothing/');
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('G','g3-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P3g integration setup FAILED:', reason);
    up = false;
  }
}, 40_000);

afterAll(async () => { await pool?.end(); });

/** Refs of projects this file created, so its own residue is removable. */
const mine: string[] = [];

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, project_repos, projects cascade');
});

const t = (n: string, fn: () => Promise<void>, ms = 90_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P3g preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && backup-store && ./scripts/migrate-staging.sh. ' +
      'This is the P3g done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'g' + String(Date.now() % 100000) + String(++seq).padStart(14, 't');

async function mkPurged(): Promise<{ id: string; ref: string }> {
  const ref = mkRef();
  // `deleted_at` is not optional here: the projects table has a CHECK tying the
  // deleted statuses to a deletion timestamp, and it is right to — a project
  // recorded as deleted with no record of when is a row nobody can reason about.
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status, deleted_at)
     values ($1,$2,$3,'free','deleted', now() - interval '31 days')
     returning id, ref::text as ref`,
    [orgId, ref, 'purged-' + seq]);
  mine.push(ref);
  return rows[0]!;
}

/** Put objects under a project's repo prefix, the way pgBackRest would. */
async function seedRepo(projectId: string, count: number): Promise<string> {
  const prefix = repoPathFor(projectId).replace(/^\//, '') + '/';
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const bucket = process.env['CB_BACKUP_S3_BUCKET']!;
  // Written through mc rather than the client under test: seeding with the same
  // code path that is being verified would let a broken client produce a bucket
  // that looks correct to itself.
  const script = Array.from({ length: count }, (_, i) =>
    `echo "segment ${i}" > /tmp/o${i} && mc --insecure cp /tmp/o${i} ` +
    `local/${bucket}/${prefix}backup/x${i}.zst >/dev/null`).join(' && ');
  await run('docker', ['exec', 'cb-object-store', 'sh', '-c', script]);
  return prefix;
}

const repoRow = async (projectId: string) => (await pool.query<{
  repo_path: string; destroy_after: Date | null; destroyed_at: Date | null;
  objects_deleted: number | null; last_error: string | null; attempts: number;
}>(`select repo_path, destroy_after, destroyed_at, objects_deleted, last_error, attempts
      from project_repos where project_id = $1`, [projectId])).rows[0]!;

describe('P3g — destruction after the 30-day window', () => {
  t('deletes every object under the prefix and proves the prefix is empty', async () => {
    const p = await mkPurged();
    const prefix = await seedRepo(p.id, 7);
    expect((await s3.list(prefix)).length).toBe(7);

    const sweep = createRepoDestroy({ pool, s3 });
    await sweep.schedule(p.id, process.env['CB_BACKUP_S3_BUCKET']!);
    // The window has not passed, so nothing happens yet — the 30 days are the
    // point of the feature, not an implementation detail.
    expect((await sweep.scanOnce()).due).toBe(0);
    expect((await s3.list(prefix)).length).toBe(7);

    // Move the deadline into the past, the way thirty real days would.
    await pool.query(
      `update project_repos set destroy_after = now() - interval '1 hour'
        where project_id = $1`, [p.id]);

    const r = await sweep.scanOnce();
    expect(r.due).toBe(1);
    expect(r.destroyed).toBe(1);
    expect(r.objectsDeleted).toBe(7);

    // The claim, checked against the store rather than the row.
    expect(await s3.list(prefix)).toEqual([]);

    const row = await repoRow(p.id);
    expect(row.destroyed_at).not.toBeNull();
    expect(row.objects_deleted).toBe(7);
    expect(row.last_error).toBeNull();
  });

  t('writes an audit row, because "provable" means someone can be shown the proof',
    async () => {
      const p = await mkPurged();
      await seedRepo(p.id, 2);
      const sweep = createRepoDestroy({ pool, s3 });
      await sweep.schedule(p.id, process.env['CB_BACKUP_S3_BUCKET']!);
      await pool.query(
        `update project_repos set destroy_after = now() - interval '1 hour'
          where project_id = $1`, [p.id]);
      await sweep.scanOnce();

      const { rows } = await pool.query<{ action: string; resource_id: string; metadata: string }>(
        `select action, resource_id, metadata::text as metadata from audit_logs
          where action = 'project.backup_repo_destroyed' and project_id = $1`, [p.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.resource_id).toBe(p.ref);
      expect(rows[0]!.metadata).toContain('objects_deleted');
      expect(rows[0]!.metadata).toContain(repoPathFor(p.id));
    });

  t('is idempotent: a second sweep finds nothing left to do', async () => {
    const p = await mkPurged();
    const prefix = await seedRepo(p.id, 3);
    const sweep = createRepoDestroy({ pool, s3 });
    await sweep.schedule(p.id, process.env['CB_BACKUP_S3_BUCKET']!);
    await pool.query(
      `update project_repos set destroy_after = now() - interval '1 hour'
        where project_id = $1`, [p.id]);
    expect((await sweep.scanOnce()).destroyed).toBe(1);
    // destroyed_at excludes it from the candidate query, so a second pass is not
    // a second delete and not a second audit row.
    expect((await sweep.scanOnce()).due).toBe(0);
    expect(await s3.list(prefix)).toEqual([]);
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from audit_logs
        where action = 'project.backup_repo_destroyed' and project_id = $1`, [p.id]);
    expect(rows[0]!.n).toBe(1);
  });

  t('handles a repo that is already empty', async () => {
    // The ordinary case for a project deleted before it ever backed anything up.
    const p = await mkPurged();
    const sweep = createRepoDestroy({ pool, s3 });
    await sweep.schedule(p.id, process.env['CB_BACKUP_S3_BUCKET']!);
    await pool.query(
      `update project_repos set destroy_after = now() - interval '1 hour'
        where project_id = $1`, [p.id]);
    const r = await sweep.scanOnce();
    expect(r.destroyed).toBe(1);
    expect(r.objectsDeleted).toBe(0);
    expect((await repoRow(p.id)).destroyed_at).not.toBeNull();
  });

  t('touches only the project it was asked about', async () => {
    // The one that would be unrecoverable. A prefix bug here deletes a live
    // customer's backups, and the shape of it — `projects/<uuid>` against
    // `projects/<uuid>` — is exactly the kind that a substring match gets wrong.
    const doomed = await mkPurged();
    const bystander = await mkPurged();
    const doomedPrefix = await seedRepo(doomed.id, 4);
    const bystanderPrefix = await seedRepo(bystander.id, 4);

    const sweep = createRepoDestroy({ pool, s3 });
    await sweep.schedule(doomed.id, process.env['CB_BACKUP_S3_BUCKET']!);
    await sweep.schedule(bystander.id, process.env['CB_BACKUP_S3_BUCKET']!);
    await pool.query(
      `update project_repos set destroy_after = now() - interval '1 hour'
        where project_id = $1`, [doomed.id]);

    const r = await sweep.scanOnce();
    expect(r.destroyed).toBe(1);
    expect(await s3.list(doomedPrefix)).toEqual([]);
    expect((await s3.list(bystanderPrefix)).length).toBe(4);

    // Clean up the bystander so this file leaves the bucket as it found it.
    await pool.query(
      `update project_repos set destroy_after = now() - interval '1 hour'
        where project_id = $1`, [bystander.id]);
    await sweep.scanOnce();
    expect(await s3.list(bystanderPrefix)).toEqual([]);
  });
});

describe('P3g — what must never be destroyed', () => {
  t('a repo with no deadline, rather than treating null as "already due"', async () => {
    // A row with no deadline is one nothing has decided about — a fleet that gained
    // object storage after a project was purged, for instance. SQL comparisons
    // against NULL are false so this passes by construction, which is precisely
    // why it is worth pinning: the next rewrite with COALESCE would destroy every
    // undecided repo on its first sweep.
    const p = await mkPurged();
    const prefix = await seedRepo(p.id, 2);
    await pool.query(
      `insert into project_repos (project_id, repo_path, bucket, destroy_after)
       values ($1, $2, 'b', NULL)`, [p.id, repoPathFor(p.id)]);
    const r = await createRepoDestroy({ pool, s3 }).scanOnce();
    expect(r.due).toBe(0);
    expect((await s3.list(prefix)).length).toBe(2);
    // Leave nothing behind.
    await pool.query(`update project_repos set destroy_after = now() - interval '1h'
                       where project_id = $1`, [p.id]);
    await createRepoDestroy({ pool, s3 }).scanOnce();
  });

  t('refuses to mark a repo destroyed while objects remain', async () => {
    // The proof step, tested by making the proof fail. A sweep that deleted and
    // assumed would mark this destroyed and move on, and the objects would be
    // retained forever with a row asserting they were gone.
    const p = await mkPurged();
    const prefix = await seedRepo(p.id, 2);
    await createRepoDestroy({ pool, s3 }).schedule(p.id, 'b');
    await pool.query(
      `update project_repos set destroy_after = now() - interval '1 hour'
        where project_id = $1`, [p.id]);

    // An S3 whose deletes do nothing: list keeps reporting the objects.
    //
    // Built by starting from *every* method the real client has and replacing
    // each with a thrower, then overriding the three this path uses. Two reasons
    // it is done that way round: the standing assertion survives — repo
    // destruction lists and deletes, and touching anything else fails loudly
    // rather than quietly exercising a path nobody meant it to have — and adding
    // a method to the S3 client no longer breaks this file's types, which it did
    // three times while the storage module was being built.
    const unreachable = (op: string) => () => {
      throw new Error(`repo destruction called ${op}, which it has no business doing`);
    };
    const lying = {
      ...Object.fromEntries(Object.keys(s3).map((k) => [k, unreachable(k)])),
      list: (pfx: string) => s3.list(pfx),
      deleteBatch: async () => [],
      deleteObject: async () => {},
    } as unknown as S3;
    const r = await createRepoDestroy({ pool, s3: lying }).scanOnce();
    expect(r.destroyed).toBe(0);
    expect(r.failed).toBe(1);

    const row = await repoRow(p.id);
    expect(row.destroyed_at).toBeNull();
    expect(row.last_error).toMatch(/objects still under/);
    expect(row.attempts).toBe(1);

    // Still due, so the next sweep tries again — and with a working client it
    // succeeds, which is what makes the failure a retry rather than a dead end.
    const good = await createRepoDestroy({ pool, s3 }).scanOnce();
    expect(good.destroyed).toBe(1);
    expect(await s3.list(prefix)).toEqual([]);
  });

  t('says so loudly when it has no credentials at all', async () => {
    // A fleet silently retaining data it promised to destroy is the worst version
    // of this failing, so the disabled case is a logged error on every sweep
    // rather than a quiet return.
    const messages: string[] = [];
    // `null`, not `undefined`: undefined means "read the environment", which in a
    // test environment finds credentials and would make this assert nothing.
    const r = await createRepoDestroy({
      pool, s3: null, log: (_l, m) => messages.push(m),
    }).scanOnce();
    expect(r.due).toBe(0);
    expect(messages.join(' ')).toContain('REPO DESTRUCTION DISABLED');
    expect(messages.join(' ')).toContain('retained indefinitely');
  });

  t('keeps the retention window at the documented 30 days', () => {
    expect(REPO_RETENTION_DAYS).toBe(30);
    return Promise.resolve();
  });
});
