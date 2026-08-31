import { Pool } from 'pg';
import { createRedis, createQueue, createWorker } from '@corebase/queue';
import { createJobRepo } from './jobs/repo.ts';
import { createRunner } from './jobs/runner.ts';
import { sagas } from './jobs/sagas.ts';
import { createSweeper } from './sweeper.ts';

const dbUrl = process.env.CB_CONTROL_DATABASE_URL;
const redisUrl = process.env.CB_REDIS_URL;
if (!dbUrl || !redisUrl) {
  console.error('CB_CONTROL_DATABASE_URL and CB_REDIS_URL are both required.');
  process.exit(2);
}

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, service: 'worker', msg, ...extra }));

const pool = new Pool({ connectionString: dbUrl, max: 10 });
const redis = createRedis(redisUrl);
const queue = createQueue(redis);
const repo = createJobRepo(pool);
const runner = createRunner({ repo, sagas, log: (l, m, e) => log(l, m, e) });
const sweeper = createSweeper({ repo, queue, log: (m, e) => log('info', m, e) });

const worker = createWorker(redis, async (data) => { await runner.execute(data); });
worker.on('failed', (job, err) => log('warn', 'delivery failed', { id: job?.id, error: err.message }));
worker.on('completed', (job) => log('info', 'delivery completed', { id: job.id }));

// 10s locally; production runs the 5-minute reconciliation cadence of D-173
const sweepMs = Number(process.env.CB_SWEEP_INTERVAL_MS ?? 10_000);
const sweepTimer = setInterval(() => { void sweeper.sweepOnce().catch((e) =>
  log('error', 'sweep failed', { error: (e as Error).message })); }, sweepMs);

log('info', 'worker started', { sweepMs });

const shutdown = async (signal: string) => {
  log('info', 'shutting down', { signal });
  clearInterval(sweepTimer);
  await worker.close();          // finishes in-flight work before exiting
  await redis.quit();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
