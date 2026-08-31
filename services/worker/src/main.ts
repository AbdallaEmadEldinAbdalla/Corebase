import { Pool } from 'pg';
import { createRedis, createQueue, createWorker } from '@corebase/queue';
import { createJobRepo } from './jobs/repo.ts';
import { createRunner } from './jobs/runner.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
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
/**
 * M0 runs one worker managing one data node, so the worker registers it at
 * startup. P2 moves registration to the node's own bootstrap.
 */
const nodeId = await registerNode(pool, {
  hostname: process.env.CB_NODE_HOSTNAME ?? 'data-node-local',
  ramTotalMb: Number(process.env.CB_NODE_RAM_MB ?? 4096),
  diskTotalGb: Number(process.env.CB_NODE_DISK_GB ?? 100),
  labels: { managed_by: 'worker', environment: process.env.CB_ENV ?? 'staging' },
});
log('info', 'node registered', { nodeId, hostname: process.env.CB_NODE_HOSTNAME ?? 'data-node-local' });

const sagas = buildSagas({ pool });
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
