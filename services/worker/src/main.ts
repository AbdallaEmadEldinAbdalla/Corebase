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
import { createReconciler } from './reconcile.ts';
import {
  startMetricsServer, registerControlPlaneCollectors,
  jobSeconds, stepSeconds, jobsTotal, reconcileDriftTotal, reconcilePassSeconds,
} from './metrics.ts';

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
const nodeRegistration = {
  hostname: process.env.CB_NODE_HOSTNAME ?? 'data-node-local',
  ramTotalMb: Number(process.env.CB_NODE_RAM_MB ?? 4096),
  diskTotalGb: Number(process.env.CB_NODE_DISK_GB ?? 100),
  // How the control plane reaches this node's project ports. Defaults to the
  // Docker host because in every current topology the Engine API and the project
  // ports live on the same address.
  address: process.env.CB_NODE_ADDRESS ?? process.env.CB_DOCKER_HOST ?? '127.0.0.1',
  labels: { managed_by: 'worker', environment: process.env.CB_ENV ?? 'staging' },
};
const nodeId = await registerNode(pool, nodeRegistration);
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
  onStep: (jobType, step, seconds) => stepSeconds.observe({ job_type: jobType, step }, seconds),
  onJob: (jobType, outcome, seconds) => {
    jobSeconds.observe({ job_type: jobType, outcome }, seconds);
    jobsTotal.inc({ job_type: jobType, outcome });
  },
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

// Node reconciliation (D-065/D-173): 5 minutes, jittered so a fleet of workers
// does not hit every node's Engine API at the same second. Container crashes are
// Docker's restart policy to handle; this is the backstop that catches what the
// policy did not, plus everything the control plane and the node disagree about.
const reconcileMs = Number(process.env.CB_RECONCILE_INTERVAL_MS ?? 300_000);
let reconcileTimer: NodeJS.Timeout | undefined;
if (docker) {
  const reconciler = createReconciler({
    pool, docker, queue,
    hostname: process.env.CB_NODE_HOSTNAME ?? 'data-node-local',
    log: (l, m, e) => log(l, m, e),
  });
  const jitter = () => reconcileMs * (0.85 + Math.random() * 0.3);
  const schedule = () => {
    reconcileTimer = setTimeout(() => {
      const started = Date.now();
      // Re-assert the node's own row first. registerNode is an upsert, so this is
      // one cheap statement — and without it a worker whose node row disappears
      // (a bad restore, an operator's DELETE, a truncated control plane) stays up
      // while placement is blind to it forever, which looks like "provisioning
      // hangs" and reads like anything but the cause.
      void registerNode(pool, nodeRegistration)
        .catch((e) => log('error', 're-registration failed', { error: (e as Error).message }))
        .then(() => reconciler.reconcileOnce())
        .then((report) => {
          reconcilePassSeconds.observe({ node: report.node }, (Date.now() - started) / 1000);
          for (const d of report.drift) {
            reconcileDriftTotal.inc({ class: d.class, action: d.action });
          }
        })
        .catch((e) => log('error', 'reconcile failed', { error: (e as Error).message }))
        .finally(schedule);
    }, jitter());
  };
  schedule();
} else {
  log('warn', 'no Docker client — node reconciliation disabled', {});
}

registerControlPlaneCollectors(pool);
const metricsPort = Number(process.env.CB_METRICS_PORT ?? 9101);
const metricsServer = startMetricsServer(metricsPort);

log('info', 'worker started', { sweepMs, purgeMs, reconcileMs, metricsPort });

const shutdown = async (signal: string) => {
  log('info', 'shutting down', { signal });
  clearInterval(sweepTimer);
  clearInterval(purgeTimer);
  if (reconcileTimer) clearTimeout(reconcileTimer);
  metricsServer.close();
  await worker.close();          // finishes in-flight work before exiting
  await redis.quit();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
