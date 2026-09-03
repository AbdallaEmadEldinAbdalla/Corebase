import { createServer, type Server } from 'node:http';
import type { Pool } from 'pg';
import { Registry, Counter, Gauge, Histogram } from '@corebase/metrics';

/**
 * The worker's metrics (D-146's inventory, seeded in T9).
 *
 * Two rules from D-146 are enforced here by what is *absent*: no metric carries
 * `project_ref`, because at 10k projects that label is a ×10,000 multiplier and
 * the two histograms below would become 600k series on their own; and per-project
 * questions go to logs, which is why the log lines carry `ref` and these do not.
 */

export const registry = new Registry();

/**
 * Buckets span 100 ms to 5 minutes. A cold create is ~2.5 s (M-002) and the plan
 * budget is 60 s, so the interesting resolution is 1–10 s with enough tail to see
 * a create that is going badly rather than clipping it into +Inf.
 */
export const jobSeconds = registry.register(new Histogram({
  name: 'corebase_provisioning_job_seconds',
  help: 'End-to-end duration of a provisioning job, by type and outcome.',
  labelNames: ['job_type', 'outcome'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
}));

/** Per-step durations: the distribution across steps is what makes a saga tunable. */
export const stepSeconds = registry.register(new Histogram({
  name: 'corebase_provisioning_step_seconds',
  help: 'Duration of one saga step.',
  labelNames: ['job_type', 'step'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 30, 60],
}));

/**
 * The plan calls for a "job failure counter"; this is that, with successes in the
 * same family. A failures-only counter cannot answer "what fraction", which is
 * the question every alert on it actually asks.
 */
export const jobsTotal = registry.register(new Counter({
  name: 'corebase_provisioning_jobs_total',
  help: 'Provisioning jobs finished, by type and outcome.',
  labelNames: ['job_type', 'outcome'],
}));

export const nodeRamReservedRatio = registry.register(new Gauge({
  name: 'corebase_node_ram_reserved_ratio',
  help: 'Fraction of a node\'s RAM booked by placement (D-090 stops at 0.85).',
  labelNames: ['node'],
}));

export const nodeRamReservedMb = registry.register(new Gauge({
  name: 'corebase_node_ram_reserved_mb',
  help: 'Absolute RAM booked by placement on a node.',
  labelNames: ['node'],
}));

/**
 * Age of the oldest job that has not reached a terminal state.
 *
 * Exists so the alert catalog's "provisioning job stuck >10 min" is one
 * comparison rather than a subquery over states and timestamps. A single gauge
 * also degrades honestly: if the worker is dead the series goes stale, and stale
 * is itself the alert.
 */
export const oldestNonterminalJobSeconds = registry.register(new Gauge({
  name: 'corebase_provisioning_oldest_nonterminal_job_seconds',
  help: 'Age of the oldest job still pending, enqueued or running (0 if none).',
}));

export const jobsInState = registry.register(new Gauge({
  name: 'corebase_provisioning_jobs_in_state',
  help: 'Job rows by state — queue depth, dead letters, and everything between.',
  labelNames: ['state'],
}));

export const reconcileLastSuccess = registry.register(new Gauge({
  name: 'corebase_reconcile_last_success_timestamp_seconds',
  help: 'Unix time of the last completed reconciliation sweep for a node.',
  labelNames: ['node'],
}));

export const reconcileDriftTotal = registry.register(new Counter({
  name: 'corebase_reconcile_drift_total',
  help: 'Drift items found by reconciliation, by class and the action taken.',
  labelNames: ['class', 'action'],
}));

/**
 * WAL-archive lag, per project (P3b). The pair the alert catalog names.
 *
 * `project_ref` is a ×N label and D-146's cardinality budget counts it — these two
 * are on the budget's ✅ list precisely because they page: a fleet-level average
 * archive lag is useless, since one project's PITR rotting is invisible in an
 * average of ten thousand healthy ones.
 *
 * Lag is the age of the oldest WAL segment closed but not yet archived, **not**
 * time since the last successful push. With `archive_timeout` forcing a switch
 * every 300s on Free, the naive definition puts every healthy idle project
 * permanently at the 5-minute warn line.
 */
export const backupWalArchiveLagSeconds = registry.register(new Gauge({
  name: 'corebase_backup_wal_archive_lag_seconds',
  help: 'Age of the oldest WAL segment closed but not yet archived (0 if none waiting).',
  labelNames: ['node', 'project_ref'],
}));

/**
 * Unix time of the last successful **base backup** — not the last archived WAL.
 *
 * P3b wired this to the WAL timestamp, and that was wrong in a way the metric name
 * hides. The alert on it is "last-success age > 26h → page", which exists to catch
 * a nightly full that has been failing; pointed at WAL archiving it would stay
 * green for a project whose base backup had not succeeded in a week, because WAL
 * was flowing perfectly the whole time. Two healthy-looking signals, one missing
 * backup — the exact shape of an alert that cannot fire (P3c, D-277).
 *
 * WAL now has its own timestamp gauge below.
 */
export const backupLastSuccessTs = registry.register(new Gauge({
  name: 'corebase_backup_last_success_ts',
  help: 'Unix time of the last successful base backup for a project.',
  labelNames: ['node', 'project_ref'],
}));

export const backupWalLastArchivedTs = registry.register(new Gauge({
  name: 'corebase_backup_wal_last_archived_ts',
  help: 'Unix time of the last WAL segment successfully archived for a project.',
  labelNames: ['node', 'project_ref'],
}));

/** Base-backup attempts, by type and outcome. Failures are the interesting rows. */
export const backupRunsTotal = registry.register(new Counter({
  name: 'corebase_backup_runs_total',
  help: 'Base-backup runs finished, by type (full/incr) and outcome.',
  labelNames: ['type', 'outcome'],
}));

/**
 * Whether the project's repo would accept a backup at all — a different question
 * from whether WAL is flowing, and one a lag gauge cannot answer: a project can
 * have nothing waiting and a repo whose credentials expired last week.
 */
export const backupCheckOk = registry.register(new Gauge({
  name: 'corebase_backup_check_ok',
  help: '1 if the last pgbackrest check for this project succeeded, 0 if it failed.',
  labelNames: ['node', 'project_ref'],
}));

/** Segments waiting. Distinguishes a slow push from a repo that stopped accepting. */
export const backupWalPending = registry.register(new Gauge({
  name: 'corebase_backup_wal_pending_segments',
  help: 'WAL segments closed and waiting to be pushed to the repo.',
  labelNames: ['node', 'project_ref'],
}));

/**
 * Restore verifications, by result and by which check failed (P3h).
 *
 * No `project_ref`, deliberately, against D-146's cardinality budget: the alert on
 * this is "any verification failure pages", so the *count* is what fires it, and
 * which project it was lives in the log line and the `restore_verifications` row.
 * A per-project counter would multiply by 10,000 to answer a question that is
 * already answered.
 */
export const restoreVerificationsTotal = registry.register(new Counter({
  name: 'corebase_restore_verifications_total',
  help: 'Restore verifications finished, by result and the check that failed.',
  labelNames: ['result', 'failed_check'],
}));

/**
 * The standing SLO from backups §7: the fraction of projects with a passing
 * verification inside their own plan's floor.
 *
 * One number, because "are our backups real" is one question. An average of
 * per-project verification ages would hide the only case that matters — a single
 * project at 200 days is the whole story.
 */
export const projectsVerifiedRatio = registry.register(new Gauge({
  name: 'corebase_projects_restore_verified_ratio',
  help: 'Fraction of live projects whose backups passed verification within their plan floor.',
}));

export const reconcilePassSeconds = registry.register(new Histogram({
  name: 'corebase_reconcile_pass_seconds',
  help: 'Duration of one reconciliation sweep.',
  labelNames: ['node'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 15, 60],
}));

/**
 * Gauges whose truth lives in the control plane are read at scrape time, never
 * cached. A cached copy is a second source of truth, and the failure mode is a
 * dashboard that looks healthy because the process that would have updated it is
 * the one that died.
 */
export function registerControlPlaneCollectors(pool: Pool): void {
  registry.addCollector(async () => {
    const { rows: nodes } = await pool.query<{
      hostname: string; reserved: number; total: number;
    }>(`SELECT hostname, ram_reserved_mb AS reserved, ram_total_mb AS total,
               last_reconcile_at
          FROM nodes WHERE status <> 'retired'`);
    nodeRamReservedRatio.reset();
    nodeRamReservedMb.reset();
    for (const n of nodes) {
      nodeRamReservedRatio.set({ node: n.hostname }, n.total > 0 ? n.reserved / n.total : 0);
      nodeRamReservedMb.set({ node: n.hostname }, n.reserved);
    }

    const { rows: reconciles } = await pool.query<{ hostname: string; at: Date | null }>(
      `SELECT hostname, last_reconcile_at AS at FROM nodes WHERE last_reconcile_at IS NOT NULL`);
    reconcileLastSuccess.reset();
    for (const r of reconciles) {
      reconcileLastSuccess.set({ node: r.hostname }, Math.floor(r.at!.getTime() / 1000));
    }

    const { rows: states } = await pool.query<{ state: string; n: number }>(
      `SELECT state::text AS state, count(*)::int AS n FROM provisioning_jobs GROUP BY state`);
    jobsInState.reset();
    // Zero-fill: a state that vanishes from the GROUP BY would otherwise leave a
    // stale series, and `dead_letter == 0` is a fact worth stating.
    for (const s of ['pending', 'enqueued', 'running', 'succeeded', 'failed', 'dead_letter']) {
      jobsInState.set({ state: s }, states.find((r) => r.state === s)?.n ?? 0);
    }

    const { rows: oldest } = await pool.query<{ age: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::float AS age
         FROM provisioning_jobs
        WHERE state IN ('pending', 'enqueued', 'running')`);
    oldestNonterminalJobSeconds.set(Math.max(0, oldest[0]?.age ?? 0));
  });
}

/**
 * A dedicated HTTP listener rather than a route on the API: the worker has no
 * HTTP surface otherwise, and a scrape target that shares a port with customer
 * traffic is a scrape target that gets firewalled off by accident.
 */
export function startMetricsServer(port: number): Server {
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end('only /metrics is served here\n');
      return;
    }
    registry.metricsText().then(
      (text) => { res.writeHead(200, { 'content-type': Registry.CONTENT_TYPE }).end(text); },
      (err: Error) => {
        // A scrape that fails loudly is better than one that returns a partial
        // exposition Prometheus would silently accept.
        res.writeHead(500, { 'content-type': 'text/plain' })
          .end(`collector failed: ${err.message}\n`);
      });
  });
  server.listen(port, '0.0.0.0');
  return server;
}

// ── auth email (P4d) ────────────────────────────────────────────────────────

/**
 * Sends, by template and outcome.
 *
 * `template` and not `project_ref`, deliberately. The email doc wants per-project
 * deliverability metrics, and per-project labels on a fleet-wide counter is
 * exactly the cardinality mistake D-146's budget exists to prevent — one series
 * per project per template per outcome. Per-project numbers belong in
 * `email_sends`, which is a table that can be queried and does not live in
 * Prometheus's memory; what this answers is the platform question, which is the
 * one that pages somebody: is our shared sending domain still working.
 */
export const emailSendsTotal = registry.register(new Counter({
  name: 'corebase_email_sends_total',
  help: 'Auth emails handled, by template and outcome (sent/failed/dead_lettered).',
  labelNames: ['template', 'outcome'],
}));

/**
 * Whether a failure was worth retrying.
 *
 * Separate from the counter above because the ratio is the signal: a rise in
 * retryable failures is a provider or network problem, and a rise in
 * non-retryable ones is a bug in us or bad data from a project. Same total, two
 * completely different responses.
 */
export const emailFailuresTotal = registry.register(new Counter({
  name: 'corebase_email_failures_total',
  help: 'Auth email send failures, by template and whether they were retryable.',
  labelNames: ['template', 'retryable'],
}));
