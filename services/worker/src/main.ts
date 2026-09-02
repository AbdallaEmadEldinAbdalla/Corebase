import { Pool } from 'pg';
import { createRedis, createQueue, createWorker } from '@corebase/queue';
import { createJobRepo } from './jobs/repo.ts';
import { createRunner } from './jobs/runner.ts';
import { buildSagas, superuserCandidates } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { createDocker } from './docker.ts';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { createSweeper } from './sweeper.ts';
import { createPurgeScan } from './purge-scan.ts';
import { createIdleScan } from './idle-scan.ts';
import { createDiskScan } from './disk-scan.ts';
import { createWalScan } from './wal-scan.ts';
import { createBackupScan } from './backup-scan.ts';
import { createRestoreExpiry, restoreTtlHours } from './restore-expiry.ts';
import { createRepoDestroy, REPO_RETENTION_DAYS } from './repo-destroy.ts';
import { createReconciler } from './reconcile.ts';
import {
  startMetricsServer, registerControlPlaneCollectors,
  jobSeconds, stepSeconds, jobsTotal, reconcileDriftTotal, reconcilePassSeconds,
  backupWalArchiveLagSeconds, backupWalPending, backupLastSuccessTs, backupCheckOk,
  backupWalLastArchivedTs,
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
  ...(process.env.CB_JWT_ISSUER ? { jwtIssuer: process.env.CB_JWT_ISSUER } : {}),
  ...(docker ? { docker } : {}),
  bootstrapSecret: process.env.CB_BOOTSTRAP_SECRET ?? '',
  healthTimeoutMs: Number(process.env.CB_HEALTH_TIMEOUT_MS ?? 60_000),
  // D-038's recovery window. Shortened only in tests; a production value that
  // drifts short quietly removes the customer's ability to undo a deletion.
  softDeleteWindow: process.env.CB_SOFT_DELETE_WINDOW ?? '7 days',
  /**
   * On by default now that a final backup is real (P3f).
   *
   * D-066's rule is that the one moment a backup absolutely must work is when
   * everything else is about to be deleted, and until P3f this flag could only
   * make deletion *fail* because there was no backup system to succeed with. It
   * defaults on because the failure it prevents is invisible: a recovery window
   * with nothing behind it looks exactly like a recovery window, right up to the
   * moment someone needs it. `CB_REQUIRE_FINAL_BACKUP=false` is the deliberate
   * opt-out for a fleet with no object storage.
   */
  requireFinalBackup: process.env.CB_REQUIRE_FINAL_BACKUP !== 'false',
  requireBackups: process.env.CB_REQUIRE_BACKUPS === 'true',
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

// The idle scan (P2c, D-008/D-072): what turns "nobody has used this in a week"
// into a paused project. Hourly by default, for the same reason as the purge —
// the window is days, so scanning faster only costs connections to every project.
//
// It needs the secret store to read each project's developer password, because it
// asks the project's own database who is connected. Without a store it does not
// run at all rather than running blind: a scan that cannot tell active from idle
// would pause projects that are in use.
const idleDays = Number(process.env.CB_IDLE_PAUSE_DAYS ?? 7);
const idleMs = Number(process.env.CB_IDLE_SCAN_MS ?? 3_600_000);
let idleTimer: NodeJS.Timeout | undefined;
if (secrets) {
  const idleScan = createIdleScan({
    pool, queue, idleDays, log: (m, e) => log('info', m, e),
    ...(docker ? { docker } : {}),
  });
  const store = secrets;
  idleTimer = setInterval(() => {
    void idleScan.scanOnce({
      secretFor: (projectId) => store.get(projectId, SECRET_NAMES.developer),
      poolerSecretFor: (projectId) => store.get(projectId, SECRET_NAMES.poolerAuth),
    }).catch((e) => log('error', 'idle scan failed', { error: (e as Error).message }));
  }, idleMs);
}

// The disk ladder (P2e, D-073). Every 10 minutes by default: the billing sample is
// six-hourly, but the ladder is a safety mechanism and a project can fill 500 MB in
// far less than six hours. Cheap — one query per project.
const diskMs = Number(process.env.CB_DISK_SCAN_MS ?? 600_000);
let diskTimer: NodeJS.Timeout | undefined;
if (secrets) {
  const store = secrets;
  const diskScan = createDiskScan({ pool, log: (l, m, e) => log(l, m, e) });
  diskTimer = setInterval(() => {
    void diskScan.scanOnce({
      developerSecretFor: (projectId) => store.get(projectId, SECRET_NAMES.developer),
      superuserPasswordsFor: (projectId) => superuserCandidates(
        { pool, secrets: store, bootstrapSecret: process.env.CB_BOOTSTRAP_SECRET } as never,
        projectId),
    }).catch((e) => log('error', 'disk scan failed', { error: (e as Error).message }));
  }, diskMs);
}

/**
 * WAL-archive lag (P3b). Every 2 minutes by default.
 *
 * More often than the disk ladder, because the thing being watched moves faster and
 * matters sooner: the alert fires at 5 minutes of lag, and a sweep interval near
 * the threshold means the alert learns about it up to a full interval late. Two
 * minutes gives the >5-min warn two samples before it can be true.
 *
 * The `pgbackrest check` inside it is spent on its own 15-minute schedule per
 * project (backups §1) rather than every sweep — it costs a WAL switch, and paying
 * that every two minutes for every project would be the monitoring generating most
 * of the WAL it monitors.
 */
const walMs = Number(process.env.CB_WAL_SCAN_MS ?? 120_000);
let walTimer: NodeJS.Timeout | undefined;
if (secrets) {
  const store = secrets;
  const walScan = createWalScan({
    pool, docker,
    checkIntervalMs: Number(process.env.CB_BACKUP_CHECK_MS ?? 900_000),
    log: (l, m, e) => log(l, m, e),
    onSample: ({ ref, node, sample, state }) => {
      backupWalArchiveLagSeconds.set({ node, project_ref: ref }, sample.lagSeconds);
      backupWalPending.set({ node, project_ref: ref }, sample.pending);
      if (sample.lastArchivedAt) {
        backupWalLastArchivedTs.set(
          { node, project_ref: ref }, Math.floor(sample.lastArchivedAt.getTime() / 1000));
      }
      void state;
    },
  });
  walTimer = setInterval(() => {
    void walScan.scanOnce({
      superuserPasswordsFor: (projectId) => superuserCandidates(
        { pool, secrets: store, bootstrapSecret: process.env.CB_BOOTSTRAP_SECRET } as never,
        projectId),
    }).then((r) => {
      // The gauge is set from the row rather than the check's return value so it
      // also covers projects whose check was not due this sweep — otherwise a
      // project's `check_ok` series would flap to nothing between checks and the
      // alert would read the gap as recovery.
      void r;
      return pool.query<{ ref: string; hostname: string; ok: boolean | null }>(
        `SELECT p.ref::text AS ref, n.hostname, d.backup_check_ok AS ok
           FROM projects p JOIN project_databases d ON d.project_id = p.id
           JOIN nodes n ON n.id = d.node_id
          WHERE d.status = 'running' AND d.backup_check_ok IS NOT NULL`);
    }).then((res) => {
      for (const row of res.rows) {
        backupCheckOk.set({ node: row.hostname, project_ref: row.ref }, row.ok ? 1 : 0);
      }
    }).catch((e) => log('error', 'wal scan failed', { error: (e as Error).message }));
  }, walMs);
}

/**
 * Scheduled base backups (P3c). Every five minutes.
 *
 * The sweep is cheap — one query for the whole batch — and it has to run often
 * enough to land inside a project's half-hour slot in the nightly window. The
 * schedule itself is the day-keyed idempotency key, not this interval: looking
 * twelve times an hour and enqueueing once a day is the point.
 */
const backupScanMs = Number(process.env.CB_BACKUP_SCAN_MS ?? 300_000);
let backupTimer: NodeJS.Timeout | undefined;
{
  const backupScan = createBackupScan({
    pool, queue,
    ...(process.env.CB_BACKUP_WINDOW_ALWAYS === 'true'
      ? { window: { startHour: 0, endHour: 24 } } : {}),
    log: (m, e) => log('info', m, e),
  });
  backupTimer = setInterval(() => {
    void backupScan.scanOnce()
      .catch((e) => log('error', 'backup scan failed', { error: (e as Error).message }));
  }, backupScanMs);
}

/**
 * The base-backup gauges, refreshed from `backup_runs` on the same cadence.
 *
 * Read from the table rather than set when a backup finishes, for the reason the
 * control-plane collectors exist: a value cached in this process is a second source
 * of truth, and its failure mode is a dashboard that looks healthy because the
 * process that would have updated it is the one that died.
 */
const backupGaugeTimer = setInterval(() => {
  void pool.query<{ ref: string; hostname: string; last_success: string | null }>(
    `SELECT p.ref::text AS ref, n.hostname,
            extract(epoch FROM max(r.finished_at))::text AS last_success
       FROM projects p
       JOIN project_databases d ON d.project_id = p.id
       JOIN nodes n ON n.id = d.node_id
       LEFT JOIN backup_runs r
              ON r.project_id = p.id AND r.status = 'succeeded' AND r.type = 'full'
      WHERE d.status = 'running'
      GROUP BY p.ref, n.hostname`)
    .then((res) => {
      for (const row of res.rows) {
        if (row.last_success === null) continue;
        backupLastSuccessTs.set(
          { node: row.hostname, project_ref: row.ref }, Number(row.last_success));
      }
    })
    .catch((e) => log('error', 'backup gauge refresh failed', { error: (e as Error).message }));
}, 60_000);

/**
 * Restored copies past their deadline (P3e). Every ten minutes.
 *
 * Not more often: the deadline is measured in days, so a few minutes of slack
 * either side is invisible to a customer and the sweep is one indexed query. Not
 * less often either — a copy that outlives its deadline by hours is capacity spent
 * on a database nobody queries, which is the thing the deadline exists to stop.
 */
const restoreExpiryMs = Number(process.env.CB_RESTORE_EXPIRY_SCAN_MS ?? 600_000);
const restoreExpiry = createRestoreExpiry({
  pool, queue, log: (m, e) => log('info', m, e) });
const restoreExpiryTimer = setInterval(() => {
  void restoreExpiry.scanOnce()
    .catch((e) => log('error', 'restore expiry sweep failed', { error: (e as Error).message }));
}, restoreExpiryMs);

/**
 * Destroying purged projects' backup repos (P3g, D-038/D-066). Hourly.
 *
 * The deadline is measured in days, so an hour of slack is invisible — and an
 * hourly sweep means a repo that *cannot* be destroyed is retried often enough for
 * its stored error to be current when someone looks.
 */
const repoDestroyMs = Number(process.env.CB_REPO_DESTROY_SCAN_MS ?? 3_600_000);
const repoDestroy = createRepoDestroy({ pool, log: (l, m, e) => log(l, m, e) });
const repoDestroyTimer = setInterval(() => {
  void repoDestroy.scanOnce()
    .catch((e) => log('error', 'repo destruction sweep failed', { error: (e as Error).message }));
}, repoDestroyMs);

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

log('info', 'worker started', {
  sweepMs, purgeMs, reconcileMs, metricsPort,
  idle: idleTimer ? { scanMs: idleMs, days: idleDays } : 'disabled (no secret store)',
  disk: diskTimer ? { scanMs: diskMs } : 'disabled (no secret store)',
  wal: walTimer ? { scanMs: walMs } : 'disabled (no secret store)',
  backups: { scanMs: backupScanMs },
  restore_expiry: { scanMs: restoreExpiryMs, ttlHours: restoreTtlHours() },
  repo_destruction: { scanMs: repoDestroyMs, retentionDays: REPO_RETENTION_DAYS },
});

const shutdown = async (signal: string) => {
  log('info', 'shutting down', { signal });
  // Every timer, not just the first two.
  //
  // The awaits below yield, so an interval that fires during shutdown runs against
  // a pool that is closing or closed — and the error it logs on the way out points
  // at the query rather than at the shutdown, which is a confusing last line in a
  // log. `process.exit` made this survivable rather than correct.
  clearInterval(sweepTimer);
  clearInterval(purgeTimer);
  clearInterval(backupGaugeTimer);
  clearInterval(restoreExpiryTimer);
  clearInterval(repoDestroyTimer);
  if (idleTimer) clearInterval(idleTimer);
  if (diskTimer) clearInterval(diskTimer);
  if (walTimer) clearInterval(walTimer);
  if (backupTimer) clearInterval(backupTimer);
  if (reconcileTimer) clearTimeout(reconcileTimer);
  metricsServer.close();
  await worker.close();          // finishes in-flight work before exiting
  await redis.quit();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
