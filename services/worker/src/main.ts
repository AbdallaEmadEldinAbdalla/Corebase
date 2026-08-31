import { Pool } from 'pg';
import { createRedis, createQueue, createWorker } from '@corebase/queue';
import { createJobRepo } from './jobs/repo.ts';
import { createRunner } from './jobs/runner.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { createDocker } from './docker.ts';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore } from '@corebase/secrets';
import { createSweeper } from './sweeper.ts';
import { createPurgeScan } from './purge-scan.ts';

const dbUrl = process.env.CB_CONTROL_DATABASE_URL;
const redisUrl = process.env.CB_REDIS_URL;
if (!dbUrl || !redisUrl) {
  console.error('CB_CONTROL_DATABASE_URL and CB_REDIS_URL are both required.');
  process.exit(2);
}

// A log line without a time is half a log line: every question about a crash
// recovery is a question about ordering and gaps, and T6's 60s mystery was read
// straight off these timestamps.
const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'worker', msg, ...extra }));

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
  // How the control plane reaches this node's project ports. Defaults to the
  // Docker host because in every current topology the Engine API and the project
  // ports live on the same address.
  address: process.env.CB_NODE_ADDRESS ?? process.env.CB_DOCKER_HOST ?? '127.0.0.1',
  labels: { managed_by: 'worker', environment: process.env.CB_ENV ?? 'staging' },
});
log('info', 'node registered', { nodeId, hostname: process.env.CB_NODE_HOSTNAME ?? 'data-node-local' });

const dockerHost = process.env.CB_DOCKER_HOST;
const dockerCertDir = process.env.CB_DOCKER_CERT_DIR;
const docker = dockerHost && dockerCertDir
  ? createDocker({
      host: dockerHost,
      port: Number(process.env.CB_DOCKER_PORT ?? 2376),
      certDir: dockerCertDir,
    })
  : undefined;
if (docker) {
  const version = await docker.ping();
  log('info', 'connected to the data node over mTLS', { engine: version });
} else {
  log('warn', 'no Docker client configured — container steps will fail', {});
}

// The KEK is not optional: without it, credentials cannot be stored, and a
// project provisioned without credentials is a project nobody can connect to.
const kekDir = process.env.CB_KEK_DIR;
if (!kekDir) {
  throw new Error(
    'CB_KEK_DIR is required — the control plane cannot store project credentials ' +
    'without its master key (D-035/D-075)');
}
const envelope = createEnvelope({
  kekDir,
  ...(process.env.CB_KEK_ID ? { kekId: process.env.CB_KEK_ID } : {}),
});
log('info', 'master key loaded', { kek_id: envelope.kekId });
const secrets = createSecretStore(pool, envelope);

const sagas = buildSagas({
  pool,
  secrets,
  ...(process.env.CB_PROJECT_DOMAIN ? { projectDomain: process.env.CB_PROJECT_DOMAIN } : {}),
  ...(docker ? { docker } : {}),
  bootstrapSecret: process.env.CB_BOOTSTRAP_SECRET ?? '',
  healthTimeoutMs: Number(process.env.CB_HEALTH_TIMEOUT_MS ?? 60_000),
  // D-038's recovery window. Shortened only in tests; a production value that
  // drifts short quietly removes the customer's ability to undo a deletion.
  softDeleteWindow: process.env.CB_SOFT_DELETE_WINDOW ?? '7 days',
  requireFinalBackup: process.env.CB_REQUIRE_FINAL_BACKUP === 'true',
});
const runner = createRunner({
  repo, sagas,
  staleAfterMs: Number(process.env.CB_STALE_AFTER_MS ?? 30_000),
  log: (l, m, e) => log(l, m, e),
});
// The sweeper's stale threshold must match the runner's, or the two disagree
// about whether a row is orphaned: a sweeper that sweeps sooner re-delivers work
// the runner will refuse to claim.
const sweeper = createSweeper({
  repo, queue,
  staleAfterMs: Number(process.env.CB_STALE_AFTER_MS ?? 30_000),
  log: (m, e) => log('info', m, e),
});

const worker = createWorker(redis, async (data) => { await runner.execute(data); });
worker.on('failed', (job, err) => log('warn', 'delivery failed', { id: job?.id, error: err.message }));
worker.on('completed', (job) => log('info', 'delivery completed', { id: job.id }));

// 10s locally; production runs the 5-minute reconciliation cadence of D-173
const sweepMs = Number(process.env.CB_SWEEP_INTERVAL_MS ?? 10_000);
const sweepTimer = setInterval(() => { void sweeper.sweepOnce().catch((e) =>
  log('error', 'sweep failed', { error: (e as Error).message })); }, sweepMs);

// The purge scan closes expired recovery windows (D-038). Hourly in production:
// the window is measured in days, so scanning faster buys nothing and a slow
// scan only delays reclaiming disk.
const purgeScan = createPurgeScan({ pool, queue, log: (m, e) => log('info', m, e) });
const purgeMs = Number(process.env.CB_PURGE_SCAN_MS ?? 3_600_000);
const purgeTimer = setInterval(() => { void purgeScan.scanOnce().catch((e) =>
  log('error', 'purge scan failed', { error: (e as Error).message })); }, purgeMs);

log('info', 'worker started', { sweepMs, purgeMs });

const shutdown = async (signal: string) => {
  log('info', 'shutting down', { signal });
  clearInterval(sweepTimer);
  clearInterval(purgeTimer);
  await worker.close();          // finishes in-flight work before exiting
  await redis.quit();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
