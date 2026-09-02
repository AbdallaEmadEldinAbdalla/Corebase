import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createRedis, createQueue } from '@corebase/queue';
import { createRestoreExpiry } from './restore-expiry.ts';

/**
 * P3e integration: a restored copy past its deadline is handed to the deletion
 * pipeline, and nothing else is.
 *
 * Deliberately does *not* provision anything. The sweep's job is a decision over
 * control-plane rows — which projects are due, and which must be left alone — and
 * that is entirely SQL. Provisioning five databases to test a `WHERE` clause is
 * how the P3d suite became too heavy to finish under load; this one runs in
 * milliseconds and covers the cases that matter, including the ones a
 * container-based test would have made too slow to bother writing.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const REDIS = process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379';

let pool: Pool; let orgId: string;
let redis: ReturnType<typeof createRedis>;
let queue: ReturnType<typeof createQueue>;
let up = false; let reason = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select expires_at from project_restores limit 0');   // P3e migration?
    redis = createRedis(REDIS);
    queue = createQueue(redis);
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('X','x3-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P3e integration setup FAILED:', reason);
    up = false;
  }
}, 30_000);

afterAll(async () => {
  await redis?.quit().catch(() => {});
  await pool?.end();
});

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects cascade');
});

const t = (n: string, fn: () => Promise<void>, ms = 30_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P3e preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && ./scripts/migrate-staging.sh. ' +
      'This is the P3e done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'x' + String(Date.now() % 100000) + String(++seq).padStart(14, 'w');

/** A project row plus, optionally, the restore row that makes it a copy. */
async function mkCopy(opts: {
  status: string;
  restoreStatus?: string;
  expiresInHours?: number | null;
}) {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,'free',$4::project_status) returning id, ref::text as ref`,
    [orgId, ref, 'exp-' + seq, opts.status]);
  const p = rows[0]!;
  if (opts.restoreStatus !== undefined) {
    await pool.query(
      `insert into project_restores
         (project_id, source_project_id, source_ref, status, expires_at)
       values ($1, NULL, $2, $3,
               -- make_interval takes hours as an int, not numeric: there is no
               -- numeric overload, and passing one fails at plan time.
               case when $4::int is null then null
                    else now() + make_interval(hours => $4::int) end)`,
      [p.id, 'source-' + seq, opts.restoreStatus, opts.expiresInHours ?? null]);
  }
  return p;
}

const jobsFor = async (projectId: string) => (await pool.query<{
  job_type: string; idempotency_key: string; payload: string;
}>(`select job_type, idempotency_key, payload::text as payload
      from provisioning_jobs where project_id = $1`, [projectId])).rows;

const statusOf = async (projectId: string) => (await pool.query<{ status: string }>(
  `select status::text as status from projects where id = $1`, [projectId])).rows[0]!.status;

describe('P3e — a copy past its deadline', () => {
  t('is handed to the deletion pipeline, not to a bespoke expiry path', async () => {
    // The normal pipeline soft-deletes, keeps the data for the recovery window,
    // and takes a final backup on the way. A special "expire" saga would have to
    // reimplement all three, and the third is the reason an expiry the customer
    // did not want is not a loss they cannot undo.
    const copy = await mkCopy({ status: 'restored', restoreStatus: 'succeeded', expiresInHours: -1 });
    const r = await createRestoreExpiry({ pool, queue }).scanOnce();
    expect(r.due).toBe(1);
    expect(r.created).toBe(1);

    const jobs = await jobsFor(copy.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job_type).toBe('delete_project');
    // The reason travels with the job, so a deletion nobody asked for is
    // explicable from the row rather than from a timestamp coincidence.
    expect(jobs[0]!.payload).toContain('restore_expired');
    // And the project stops describing itself as validatable immediately, rather
    // than when the saga gets round to it.
    expect(await statusOf(copy.id)).toBe('deleting');
  });

  t('is not swept twice, however often the sweep runs', async () => {
    const copy = await mkCopy({ status: 'restored', restoreStatus: 'succeeded', expiresInHours: -2 });
    const sweep = createRestoreExpiry({ pool, queue });
    expect((await sweep.scanOnce()).created).toBe(1);
    // Second pass: the project is `deleting` now, so it is not even a candidate —
    // and the idempotency key would refuse a duplicate even if it were.
    const second = await sweep.scanOnce();
    expect(second.due).toBe(0);
    expect(await jobsFor(copy.id)).toHaveLength(1);
  });
});

describe('P3e — what the sweep must leave alone', () => {
  t('a copy still inside its window', async () => {
    const copy = await mkCopy({ status: 'restored', restoreStatus: 'succeeded', expiresInHours: 48 });
    expect((await createRestoreExpiry({ pool, queue }).scanOnce()).due).toBe(0);
    expect(await statusOf(copy.id)).toBe('restored');
  });

  t('a copy still being built', async () => {
    // Mid-saga, and expiring one would race the job constructing it. A `restoring`
    // project has no deadline it could have passed.
    const copy = await mkCopy({ status: 'restoring', restoreStatus: 'running', expiresInHours: -5 });
    expect((await createRestoreExpiry({ pool, queue }).scanOnce()).due).toBe(0);
    expect(await statusOf(copy.id)).toBe('restoring');
  });

  t('a restore that failed — that is not the clock\'s to clean up', async () => {
    const copy = await mkCopy({ status: 'failed', restoreStatus: 'failed', expiresInHours: -5 });
    expect((await createRestoreExpiry({ pool, queue }).scanOnce()).due).toBe(0);
    expect(await statusOf(copy.id)).toBe('failed');
  });

  t('an ordinary project, which has no restore row and no deadline', async () => {
    // The one that would be catastrophic. A `WHERE` clause that reached production
    // projects would delete customers' live databases on a timer.
    const live = await mkCopy({ status: 'ready' });
    expect((await createRestoreExpiry({ pool, queue }).scanOnce()).due).toBe(0);
    expect(await jobsFor(live.id)).toHaveLength(0);
    expect(await statusOf(live.id)).toBe('ready');
  });

  t('a copy whose deadline is null, rather than treating null as "already due"',
    async () => {
      // SQL comparisons against NULL are false, so this passes by construction —
      // which is exactly why it is worth a test. The next person to rewrite this
      // query with COALESCE or a date function is one keystroke from making every
      // deadline-less copy instantly expired.
      const copy = await mkCopy({
        status: 'restored', restoreStatus: 'succeeded', expiresInHours: null });
      expect((await createRestoreExpiry({ pool, queue }).scanOnce()).due).toBe(0);
      expect(await statusOf(copy.id)).toBe('restored');
    });
});
