import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  createRedis, createQueue, enqueueProvisioning, enqueueRecovery, recoveryJobId,
  type Redis, type Queue, type ProvisioningJobData,
} from '@steadhold/queue';
import { createJobRepo } from './jobs/repo.ts';
import { createRunner } from './jobs/runner.ts';
import { createSweeper } from './sweeper.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * T5b integration: real Postgres + real Redis from the T2 staging stack.
 * Skipped when either is unreachable; the T5b done-signal requires them.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const REDIS = process.env.SH_REDIS_URL ?? 'redis://127.0.0.1:56379';

let pool: Pool; let redis: Redis; let queue: Queue<ProvisioningJobData>;
let repo: ReturnType<typeof createJobRepo>; let orgId: string; let up = false;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1');
    redis = createRedis(REDIS); await redis.ping();
    queue = createQueue(redis);
    // A worker connected to the same Redis will consume the deliveries these
    // tests assert on, and the failure looks like a queue bug rather than a
    // second consumer. This has cost debugging time twice; name it instead.
    const rival = await queue.getWorkers();
    if (rival.length > 0) {
      throw new Error(
        `${rival.length} worker(s) are already consuming this queue — stop scripts/dev.sh ` +
        '(or any bench harness) before running the suite; they will eat the deliveries ' +
        'these tests are asserting on.');
    }
    repo = createJobRepo(pool);
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('W','w-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    // Never swallow this: a silent skip looks like a pass and hides real breakage.
    console.error('T5b integration setup FAILED:', (err as Error).message);
    up = false;
  }
}, 20_000);

afterAll(async () => { await queue?.close(); await redis?.quit(); await pool?.end(); });

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects cascade');
  await queue.obliterate({ force: true });
});

const t = (n: string, fn: () => Promise<void>, ms = 15_000) =>
  it(n, async () => {
    if (!up) throw new Error(
      'staging PG/Redis not reachable — bring it up with ./scripts/staging.sh up. ' +
      'These tests are the T5b done-signal and must not be skipped silently.');
    await fn();
  }, ms);

let n = 0;
const ref = () => 'w' + 'abcdefghijklmnopqrstuvwxyz234567'.slice(0, 3) + String(++n).padStart(16, 'x');

async function seedJob(key: string, state = 'pending') {
  const p = await pool.query<{ id: string }>(
    `insert into projects (organization_id, ref, name) values ($1,$2,$3) returning id`,
    [orgId, ref(), 'p-' + key]);
  const j = await pool.query<{ id: string }>(
    `insert into provisioning_jobs (project_id, job_type, idempotency_key, state)
     values ($1,'provision_project',$2,$3::job_state) returning id`,
    [p.rows[0]!.id, key, state]);
  return { projectId: p.rows[0]!.id, jobId: j.rows[0]!.id };
}
const okStep = (name: string): SagaStep<SagaContext> => ({ name, async run() {} });

describe('T5b — worker on real Postgres + Redis', () => {
  t('processes a delivery and drives the row to succeeded', async () => {
    const { jobId } = await seedJob('e2e-key-1');
    const runner = createRunner({ repo, sagas: { provision_project: [okStep('a'), okStep('b')] } });
    const res = await runner.execute({ job_row_id: jobId, idempotency_key: 'e2e-key-1',
      job_type: 'provision_project', project_id: null });
    expect(res.outcome).toBe('succeeded');
    const { rows } = await pool.query(
      `select state::text, attempts, checkpoint, finished_at from provisioning_jobs where id=$1`, [jobId]);
    expect(rows[0]!.state).toBe('succeeded');
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.checkpoint).toEqual({ completed: ['a', 'b'] });
    expect(rows[0]!.finished_at).not.toBeNull();
  });

  t('two workers racing one delivery: exactly one runs it', async () => {
    const { jobId } = await seedJob('e2e-key-race');
    let runs = 0;
    const mk = () => createRunner({ repo, sagas: { provision_project: [
      { name: 'once', run: async () => { runs++; await new Promise((r) => setTimeout(r, 300)); } } ] } });
    const d = { job_row_id: jobId, idempotency_key: 'e2e-key-race',
      job_type: 'provision_project', project_id: null };
    const [a, b] = await Promise.all([mk().execute(d), mk().execute(d)]);
    expect(runs).toBe(1);                                   // the claim UPDATE is the lock
    expect([a.outcome, b.outcome].sort()).toEqual(['skipped', 'succeeded']);
  });

  t('sweeper re-enqueues a row that was never delivered (API died after COMMIT)', async () => {
    await seedJob('e2e-key-orphan', 'pending');
    const sweeper = createSweeper({ repo, queue });
    const first = await sweeper.sweepOnce();
    expect(first.found).toBe(1);
    expect(first.reEnqueued).toBe(1);
    expect(await queue.getJob('e2e-key-orphan')).toBeTruthy();
    const { rows } = await pool.query(`select state::text from provisioning_jobs where idempotency_key='e2e-key-orphan'`);
    expect(rows[0]!.state).toBe('enqueued');
    // second sweep must not double-enqueue
    expect((await sweeper.sweepOnce()).reEnqueued).toBe(0);
  });

  t('sweeper reclaims a job whose worker died mid-run (stale heartbeat)', async () => {
    const { jobId } = await seedJob('e2e-key-dead', 'pending');
    await pool.query(
      `update provisioning_jobs set state='running', heartbeat_at = now() - interval '10 minutes' where id=$1`, [jobId]);
    const sweeper = createSweeper({ repo, queue, staleAfterMs: 60_000 });
    expect((await sweeper.sweepOnce()).found).toBe(1);
    // and it is claimable again despite being 'running'
    const claimed = await repo.claim(jobId, 60_000);
    expect(claimed).toBeTruthy();
  });

  t('enqueueing the same idempotency key twice yields one delivery', async () => {
    await seedJob('e2e-key-dupe');
    const d = { job_row_id: 'x', idempotency_key: 'e2e-key-dupe',
      job_type: 'provision_project', project_id: null };
    expect((await enqueueProvisioning(queue, d)).enqueued).toBe(true);
    expect((await enqueueProvisioning(queue, d)).enqueued).toBe(false);
    expect(await queue.getJobCountByTypes('waiting')).toBe(1);
  });
});

describe('T6 — crash recovery delivery (D-194)', () => {
  t('a recovery delivery does not collide with the dead worker\'s job', async () => {
    const { jobId } = await seedJob('e2e-key-recover');
    const d = { job_row_id: jobId, idempotency_key: 'e2e-key-recover',
      job_type: 'provision_project', project_id: null };

    // The original delivery, as the API would create it.
    expect((await enqueueProvisioning(queue, d)).enqueued).toBe(true);
    // A plain re-enqueue is a no-op — correct for the producer, and exactly what
    // left crashed provisions stuck forever when the sweeper used it.
    expect((await enqueueProvisioning(queue, d)).enqueued).toBe(false);

    // The sweeper's recovery delivery lands regardless, under its own id.
    const r = await enqueueRecovery(queue, d, 1);
    expect(r.enqueued).toBe(true);
    expect(r.jobId).toBe('e2e-key-recover#recover-1');
    expect(await queue.getJobCountByTypes('waiting')).toBe(2);
  });

  t('a row that was never delivered gets the plain key, not a recovery id', async () => {
    // The API-died-after-COMMIT class. Nothing crashed mid-flight, so this is
    // the first delivery and should look like one.
    const { jobId } = await seedJob('e2e-key-first-delivery');
    const r = await enqueueRecovery(queue, {
      job_row_id: jobId, idempotency_key: 'e2e-key-first-delivery',
      job_type: 'provision_project', project_id: null }, 0);
    expect(r.jobId).toBe('e2e-key-first-delivery');
    expect(await queue.getJob('e2e-key-first-delivery')).toBeTruthy();
  });

  t('two sweeps before pickup produce one recovery delivery, not two', async () => {
    const { jobId } = await seedJob('e2e-key-recover-twice');
    const d = { job_row_id: jobId, idempotency_key: 'e2e-key-recover-twice',
      job_type: 'provision_project', project_id: null };
    await enqueueProvisioning(queue, d);                    // the dead worker's delivery
    expect((await enqueueRecovery(queue, d, 1)).jobId).toBe('e2e-key-recover-twice#recover-1');
    expect((await enqueueRecovery(queue, d, 1)).enqueued).toBe(false);
    // A second crash advances the attempt, so it gets its own delivery rather
    // than colliding with the first recovery.
    expect((await enqueueRecovery(queue, d, 2)).enqueued).toBe(true);
    expect(await queue.getJobCountByTypes('waiting')).toBe(3);
  });

  t('the sweeper re-delivers a row a dead worker left running', async () => {
    // The T6 scenario in miniature: a claimed row whose heartbeat stopped, with
    // Redis still holding the original delivery.
    const { jobId } = await seedJob('e2e-key-orphan-running');
    const d = { job_row_id: jobId, idempotency_key: 'e2e-key-orphan-running',
      job_type: 'provision_project', project_id: null };
    await enqueueProvisioning(queue, d);
    await pool.query(
      `update provisioning_jobs
          set state = 'running', attempts = 1, heartbeat_at = now() - interval '5 minutes'
        where id = $1`, [jobId]);

    const sweeper = createSweeper({ repo, queue, staleAfterMs: 30_000 });
    const swept = await sweeper.sweepOnce();
    expect(swept.found).toBe(1);
    expect(swept.reEnqueued).toBe(1);
    expect(await queue.getJob(recoveryJobId('e2e-key-orphan-running', 1))).toBeTruthy();
  });
});

