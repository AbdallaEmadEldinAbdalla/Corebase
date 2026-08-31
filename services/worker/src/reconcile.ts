import type { Pool } from 'pg';
import type { Queue, ProvisioningJobData } from '@corebase/queue';
import { enqueueProvisioning } from '@corebase/queue';
import type { Docker } from './docker.ts';
import { containerName, LABEL_MANAGED, LABEL_REF } from './container-spec.ts';
import { PLAN_RAM_MB, volumeNameFor } from './placement.ts';

/**
 * Node reconciliation (D-053, D-065): compare desired state in the control plane
 * against what is actually on the node, and repair toward desired.
 *
 * Two rules govern everything here.
 *
 * **It repairs toward desired state; it never invents desired state.** A
 * container the control plane has no row for is not evidence that a project
 * exists — it is drift to be reported.
 *
 * **Data-destroying repairs are never automatic** (D-002's priority stack:
 * durability above cost). A stray container can be stopped, because that is
 * reversible. An orphaned volume is somebody's data with a missing row, and the
 * right response is an alert, not a deletion. Getting this backwards once costs
 * a customer their database.
 */

/** Statuses whose containers are supposed to be running. */
const SHOULD_RUN = new Set(['ready', 'configuring', 'resuming']);
/** Statuses whose containers must NOT be running — a running one bills and exposes. */
const SHOULD_NOT_RUN = new Set(['soft_deleted', 'deleted', 'paused', 'pausing']);

export const REPAIR_LIMIT_PER_HOUR = 3;

export interface ReconcileOptions {
  pool: Pool;
  docker: Docker;
  queue: Queue<ProvisioningJobData>;
  hostname?: string;
  repairLimitPerHour?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface Drift {
  class: 'container_not_running' | 'zombie_container' | 'orphan_container'
    | 'orphan_volume' | 'reservation_drift';
  ref?: string;
  detail: string;
  action: 'repair_enqueued' | 'stopped' | 'alert_only' | 'recomputed' | 'repair_limit_reached';
}

export interface ReconcileReport {
  at: string;
  node: string;
  projects_checked: number;
  containers_seen: number;
  drift: Drift[];
  clean: boolean;
}

export function createReconciler(opts: ReconcileOptions) {
  const log = opts.log ?? (() => {});
  const limit = opts.repairLimitPerHour ?? REPAIR_LIMIT_PER_HOUR;

  /**
   * Ask the provisioning saga to converge this project. Cheaper than
   * reimplementing container creation here, and correct for free: every step is
   * check-then-act, so a project whose container merely stopped fast-forwards to
   * `start_container`, and one whose container is gone gets a new one.
   */
  async function enqueueRepair(projectId: string, ref: string): Promise<Drift['action']> {
    const { rows: busy } = await opts.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provisioning_jobs
        WHERE project_id = $1 AND state IN ('pending','enqueued','running')`, [projectId]);
    if ((busy[0]?.n ?? 0) > 0) {
      // Something is already working on this project. Reconciliation must not
      // race the saga it would be duplicating.
      return 'repair_enqueued';
    }

    const { rows: recent } = await opts.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provisioning_jobs
        WHERE project_id = $1 AND idempotency_key LIKE 'repair_%'
          AND created_at > now() - interval '1 hour'`, [projectId]);
    const attempts = recent[0]?.n ?? 0;
    if (attempts >= limit) {
      // Bounded auto-repair (D-065). A container that will not stay up is a
      // problem to escalate, not to restart forever — an endless repair loop
      // hides the fault and burns the node.
      await opts.pool.query(
        `UPDATE projects SET status = 'failed' WHERE id = $1 AND status <> 'failed'`, [projectId]);
      log('error', 'repair limit reached — project marked failed', { ref, attempts, limit });
      return 'repair_limit_reached';
    }

    const key = `repair_${projectId}_${attempts}`;
    const { rows } = await opts.pool.query<{ id: string }>(
      `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
       VALUES ($1, 'provision_project', $2, $3::jsonb, 'pending')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [projectId, key, JSON.stringify({ project_id: projectId, ref, reason: 'reconcile' })]);
    const jobId = rows[0]?.id;
    if (!jobId) return 'repair_enqueued';

    await enqueueProvisioning(opts.queue, {
      job_row_id: jobId, idempotency_key: key,
      job_type: 'provision_project', project_id: projectId,
    }).catch(() => { /* the row exists; the sweeper will deliver it */ });
    log('warn', 'drift repaired: convergence enqueued', { ref, job: jobId, attempt: attempts + 1 });
    return 'repair_enqueued';
  }

  return {
    async reconcileOnce(): Promise<ReconcileReport> {
      const drift: Drift[] = [];

      // ── desired state ────────────────────────────────────────────────────
      const { rows: desired } = await opts.pool.query<{
        id: string; ref: string; status: string; plan: string; container_id: string | null;
        node_hostname: string | null;
      }>(`SELECT p.id, p.ref::text AS ref, p.status::text AS status, p.plan::text AS plan,
                 d.container_id, n.hostname AS node_hostname
            FROM projects p
            LEFT JOIN project_databases d ON d.project_id = p.id
            LEFT JOIN nodes n ON n.id = d.node_id
           WHERE p.status <> 'deleted' OR d.project_id IS NOT NULL`);

      // ── actual state ─────────────────────────────────────────────────────
      const containers = await opts.docker.listContainers(`${LABEL_MANAGED}=true`);
      const byRef = new Map<string, { running: boolean; id: string }>();
      for (const c of containers) {
        const ref = c.Labels?.[LABEL_REF];
        if (ref) byRef.set(ref, { running: c.State === 'running', id: c.Id });
      }

      // ── diff, project by project ─────────────────────────────────────────
      for (const p of desired) {
        const actual = byRef.get(p.ref);

        if (SHOULD_RUN.has(p.status) && (!actual || !actual.running)) {
          const action = await enqueueRepair(p.id, p.ref);
          drift.push({
            class: 'container_not_running', ref: p.ref, action,
            detail: actual
              ? `project is ${p.status} but its container is not running`
              : `project is ${p.status} and has no container on the node`,
          });
        }

        if (SHOULD_NOT_RUN.has(p.status) && actual?.running) {
          // A billing and security leak: the customer is not paying for this and
          // has been told it is gone. Stopping is reversible, so it is automatic.
          await opts.docker.setRestartPolicy(actual.id, 'no').catch(() => {});
          await opts.docker.stopContainer(actual.id);
          log('warn', 'drift repaired: zombie container stopped', { ref: p.ref, status: p.status });
          drift.push({
            class: 'zombie_container', ref: p.ref, action: 'stopped',
            detail: `container was running while the project is ${p.status}`,
          });
        }
      }

      // ── things on the node the control plane knows nothing about ──────────
      const knownRefs = new Set(desired.map((d) => d.ref));
      for (const [ref, actual] of byRef) {
        if (knownRefs.has(ref)) continue;
        // Alert only. A container with no row might be the visible half of a
        // project row that a bad migration dropped, and removing it would turn a
        // recoverable inconsistency into lost data.
        log('error', 'drift found: orphan container — NOT removed, needs an operator', {
          ref, container: actual.id.slice(0, 12), running: actual.running,
        });
        drift.push({
          class: 'orphan_container', ref, action: 'alert_only',
          detail: `container ${containerName(ref)} has no project row (running: ${actual.running})`,
        });
      }

      // Every volume, not just the labelled ones. An anonymous volume — what a
      // container started without a mount leaves behind, since the project image
      // declares a VOLUME — carries no labels at all and was therefore invisible
      // to a filtered list, while still occupying disk forever. On a dedicated
      // data node nothing legitimate creates one.
      const volumes = await opts.docker.listVolumes();
      const placedRefs = new Set(desired.filter((d) => d.container_id !== undefined).map((d) => d.ref));
      const { rows: placements } = await opts.pool.query<{ ref: string }>(
        `SELECT p.ref::text AS ref FROM project_databases d JOIN projects p ON p.id = d.project_id`);
      for (const r of placements) placedRefs.add(r.ref);
      for (const v of volumes) {
        const ref = v.Labels?.[LABEL_REF];
        if (ref && placedRefs.has(ref)) continue;
        if (!ref && !v.Name.startsWith('cb-')) {
          // Unlabelled and not ours by name. Reported, never removed — it is
          // still somebody's bytes, and the point of this class is that a human
          // decides.
          log('error', 'drift found: unlabelled volume — NOT removed, needs an operator', {
            volume: v.Name,
          });
          drift.push({
            class: 'orphan_volume', action: 'alert_only',
            detail: `volume ${v.Name} has no Corebase label and no matching name — ` +
              'likely a container started without a mount; occupies disk forever',
          });
          continue;
        }
        // Never auto-delete (D-065). This is someone's database.
        log('error', 'drift found: orphan volume — NOT removed, needs an operator', {
          volume: v.Name, ref: ref ?? 'unlabelled',
        });
        drift.push({
          class: 'orphan_volume', ...(ref ? { ref } : {}), action: 'alert_only',
          detail: `volume ${v.Name} has no placement row — contains data, removal is a human decision`,
        });
      }

      // ── arithmetic: does the node's booking match its rows? ───────────────
      const { rows: nodes } = await opts.pool.query<{
        id: string; hostname: string; ram_reserved_mb: number;
      }>(`SELECT id, hostname, ram_reserved_mb FROM nodes
           WHERE ($1::text IS NULL OR hostname = $1)`, [opts.hostname ?? null]);
      for (const node of nodes) {
        const { rows: rowsOnNode } = await opts.pool.query<{ plan: string }>(
          `SELECT p.plan::text AS plan FROM project_databases d
             JOIN projects p ON p.id = d.project_id
            WHERE d.node_id = $1`, [node.id]);
        const expected = rowsOnNode.reduce(
          (sum, r) => sum + (PLAN_RAM_MB[r.plan] ?? PLAN_RAM_MB['free']!), 0);
        if (expected !== node.ram_reserved_mb) {
          // Pure arithmetic with an unambiguous right answer, so repairing is
          // safe. Left alone it drifts one way only — capacity the node has but
          // will not use.
          await opts.pool.query(
            `UPDATE nodes SET ram_reserved_mb = $2 WHERE id = $1`, [node.id, expected]);
          log('warn', 'drift repaired: reservation recomputed from rows', {
            node: node.hostname, was: node.ram_reserved_mb, now: expected,
          });
          drift.push({
            class: 'reservation_drift', action: 'recomputed',
            detail: `node ${node.hostname} booked ${node.ram_reserved_mb} MB, rows sum to ${expected} MB`,
          });
        }
      }

      const report: ReconcileReport = {
        at: new Date().toISOString(),
        node: opts.hostname ?? 'all',
        projects_checked: desired.length,
        containers_seen: containers.length,
        drift,
        clean: drift.length === 0,
      };

      // Recorded on the node, not only in the log: "is reconciliation running at
      // all" should be answerable with one SELECT, and outlive log retention.
      await opts.pool.query(
        `UPDATE nodes SET last_reconcile_at = now(), last_reconcile = $2::jsonb
          WHERE ($1::text IS NULL OR hostname = $1)`,
        [opts.hostname ?? null, JSON.stringify(report)]);

      if (drift.length > 0) {
        log('info', 'reconcile complete with drift', {
          drift: drift.length, classes: [...new Set(drift.map((d) => d.class))].join(','),
        });
      }
      return report;
    },
  };
}
