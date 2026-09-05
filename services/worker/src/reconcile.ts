import type { Pool } from 'pg';
import type { Queue, ProvisioningJobData } from '@corebase/queue';
import { enqueueProvisioning } from '@corebase/queue';
import type { Docker } from './docker.ts';
import { containerName, LABEL_MANAGED, LABEL_REF, LABEL_ROLE } from './container-spec.ts';
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
/**
 * Long enough that a slow provision is not called stuck — the longest saga here
 * is a provision at a few seconds, and a node under load could take far longer —
 * and short enough that a human hears about it the same working day.
 */
export const STUCK_TRANSITION_MINUTES = 15;

export interface ReconcileOptions {
  pool: Pool;
  /** How long a transitional status may persist with no job before it is drift. */
  stuckAfterMinutes?: number;
  docker: Docker;
  queue: Queue<ProvisioningJobData>;
  hostname?: string;
  repairLimitPerHour?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface Drift {
  class: 'container_not_running' | 'zombie_container' | 'orphan_container'
    | 'pooler_not_running' | 'postgrest_not_running' | 'unknown_container_role'
    | 'stuck_transition'
    | 'orphan_volume' | 'orphan_network' | 'reservation_drift';
  ref?: string;
  detail: string;
  action: 'repair_enqueued' | 'stopped' | 'alert_only' | 'recomputed'
    | 'repair_limit_reached'
    /** Drift is real, but a saga is already working on it — nothing was enqueued. */
    | 'deferred_saga_running';
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
  const stuckAfterMinutes = opts.stuckAfterMinutes ?? STUCK_TRANSITION_MINUTES;
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
      //
      // Reported as deferred, not as enqueued. Saying "repair_enqueued" here was
      // a small lie in the one artefact an operator reads to find out what the
      // sweep actually did — and the two cases need different responses: an
      // enqueued repair should converge, a deferred one means look at the job
      // that is already running.
      return 'deferred_saga_running';
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
        postgrest_port: number | null; node_hostname: string | null;
      }>(`SELECT p.id, p.ref::text AS ref, p.status::text AS status, p.plan::text AS plan,
                 d.container_id, d.postgrest_port, n.hostname AS node_hostname
            FROM projects p
            LEFT JOIN project_databases d ON d.project_id = p.id
            LEFT JOIN nodes n ON n.id = d.node_id
           WHERE p.status <> 'deleted' OR d.project_id IS NOT NULL`);

      // ── actual state ─────────────────────────────────────────────────────
      //
      // A project has *two* containers now: its database and its pooler (P2b).
      // Keying only on the ref, as this did, silently conflated them — whichever
      // came last in the listing won, so a stopped database read as healthy for as
      // long as its pooler was up. That is the worst possible direction for this
      // bug: reconciliation exists to notice exactly that.
      //
      // The role label is the discriminator. Containers created before P2b carry
      // no role label, and those are databases — the pooler did not exist then.
      const containers = await opts.docker.listContainers(`${LABEL_MANAGED}=true`);
      const byRef = new Map<string, { running: boolean; id: string }>();
      const poolerByRef = new Map<string, { running: boolean; id: string }>();
      const postgrestByRef = new Map<string, { running: boolean; id: string }>();
      for (const c of containers) {
        const ref = c.Labels?.[LABEL_REF];
        if (!ref) continue;
        const entry = { running: c.State === 'running', id: c.Id };
        // Explicit per role, with no `else` catch-all. This used to read "pooler,
        // or otherwise the database", and P5b's third container would have landed
        // in the database bucket — reconciliation would then have compared a
        // PostgREST against what it expects of a Postgres, and which of the two
        // won the map would have depended on iteration order.
        //
        // The role label is missing only on containers predating it, which is why
        // an absent role still counts as the database; anything *named* and
        // unrecognised is drift, and saying so is the point.
        const role = c.Labels?.[LABEL_ROLE];
        if (role === 'pooler') poolerByRef.set(ref, entry);
        else if (role === 'postgrest') postgrestByRef.set(ref, entry);
        else if (role === 'database' || role === undefined) byRef.set(ref, entry);
        else {
          drift.push({
            // `alert_only`: an unrecognised role is a thing a human added or a
            // version skew between this reconciler and the node's images, and
            // neither is safe to repair automatically.
            class: 'unknown_container_role', ref, action: 'alert_only',
            detail: `container ${c.Id.slice(0, 12)} carries role "${role}", which this `
              + 'reconciler does not know — it is neither repaired nor removed',
          });
        }
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

        // The pooler is not optional: DATABASE_URL is the string the docs tell
        // every application to use, so a ready project with a dead pooler is a
        // broken project even though its database is fine. Repaired the same way
        // as a missing database — by re-running the provisioning saga, which is
        // idempotent and already knows how to start a pooler (D-200).
        if (SHOULD_RUN.has(p.status) && actual?.running) {
          const pooler = poolerByRef.get(p.ref);
          if (!pooler || !pooler.running) {
            const action = await enqueueRepair(p.id, p.ref);
            drift.push({
              class: 'pooler_not_running', ref: p.ref, action,
              detail: pooler
                ? `project is ${p.status} but its pooler is not running — DATABASE_URL is dead`
                : `project is ${p.status} and has no pooler on the node — DATABASE_URL is dead`,
            });
          }
        }

        // The data API is not optional either, and for a stronger reason than the
        // pooler: `/rest/v1` is the surface a customer's *frontend* calls, so a
        // ready project with a dead PostgREST is an application that is down for
        // its users while the dashboard says everything is fine.
        if (SHOULD_RUN.has(p.status) && actual?.running) {
          const rest = postgrestByRef.get(p.ref);
          // Only for projects that have ports for one: a project provisioned
          // before P5b legitimately has no data API, and reporting drift for it
          // every five minutes would be a permanent false alarm.
          if (p.postgrest_port !== null && (!rest || !rest.running)) {
            const action = await enqueueRepair(p.id, p.ref);
            drift.push({
              class: 'postgrest_not_running', ref: p.ref, action,
              detail: rest
                ? `project is ${p.status} but its data API is not running — /rest/v1 is dead`
                : `project is ${p.status} and has no data API on the node — /rest/v1 is dead`,
            });
          }
        }

        if (SHOULD_NOT_RUN.has(p.status) && postgrestByRef.get(p.ref)?.running) {
          // Same reasoning as the zombie pooler below, and the same repair: a data
          // API outliving its project answers requests and then fails them against
          // a database that is gone, which reads as "the API is broken" rather
          // than "the project was deleted". Stopping is reversible, so automatic.
          const rest = postgrestByRef.get(p.ref)!;
          await opts.docker.setRestartPolicy(rest.id, 'no').catch(() => {});
          await opts.docker.stopContainer(rest.id);
          log('warn', 'drift repaired: zombie data api stopped',
            { ref: p.ref, status: p.status });
          drift.push({
            class: 'zombie_container', ref: p.ref, action: 'stopped',
            detail: `the data api was running while the project is ${p.status}`,
          });
        }

        if (SHOULD_NOT_RUN.has(p.status) && poolerByRef.get(p.ref)?.running) {
          // A pooler outliving its project answers connections and then fails
          // them, which reads as "the database is broken" rather than "the project
          // is gone". Stopping is reversible, so it is automatic.
          const pooler = poolerByRef.get(p.ref)!;
          await opts.docker.setRestartPolicy(pooler.id, 'no').catch(() => {});
          await opts.docker.stopContainer(pooler.id);
          log('warn', 'drift repaired: zombie pooler stopped', { ref: p.ref, status: p.status });
          drift.push({
            class: 'zombie_container', ref: p.ref, action: 'stopped',
            detail: `pooler was running while the project is ${p.status}`,
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
      for (const [ref, actual] of [...byRef, ...poolerByRef]) {
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

      // ── stuck transitions ─────────────────────────────────────────────────
      //
      // A transitional status is a promise that something is working on it. When
      // the job behind it dies permanently the promise is silently broken, and
      // `pausing` is the worst case: it is in SHOULD_NOT_RUN, its containers are
      // already stopped, so the sweep above finds nothing wrong and the project
      // reads "pausing" to its owner forever. `resuming` at least escalates to
      // `failed` through the repair limit.
      //
      // Reported rather than resolved. Which way to resolve it depends on how far
      // the dead saga got — a half-paused project might need the pause finishing
      // or reverting — and guessing is how a project ends up in a state no code
      // path expects. What matters is that it stops being invisible.
      const { rows: stuck } = await opts.pool.query<{
        ref: string; status: string; minutes: number; jobs: number;
      }>(
        `SELECT p.ref::text AS ref, p.status::text AS status,
                (EXTRACT(EPOCH FROM (now() - p.updated_at)) / 60)::int AS minutes,
                (SELECT count(*)::int FROM provisioning_jobs j
                  WHERE j.project_id = p.id
                    AND j.state IN ('pending','enqueued','running')) AS jobs
           FROM projects p
          WHERE p.status IN ('creating', 'provisioning', 'configuring',
                             'pausing', 'resuming', 'deleting')
            AND p.updated_at < now() - ($1 || ' minutes')::interval`,
        [String(stuckAfterMinutes)]);
      for (const t of stuck) {
        if (t.jobs > 0) continue;           // still being worked on; not stuck
        log('error', 'drift found: project stuck mid-transition with no job running', {
          ref: t.ref, status: t.status, minutes: t.minutes,
        });
        drift.push({
          class: 'stuck_transition', ref: t.ref, action: 'alert_only',
          detail: `project has been ${t.status} for ${t.minutes} minutes with no job ` +
            'running — the saga behind the transition died and nothing will finish it',
        });
      }

      // ── orphan networks (P2a) ─────────────────────────────────────────────
      // Unlike a volume, a leaked network holds no data — so unlike a volume, it
      // is safe to say so plainly and it is *not* a human decision in the same
      // sense. It is still reported rather than removed, for one reason: a network
      // that outlives its project is usually a purge that stopped half-way, and
      // deleting the evidence makes the underlying failure harder to find. What
      // makes it worth reporting at all is exhaustion — each bridge network takes
      // a subnet from Docker's address pool, and a node that has run out cannot
      // create the next project's network at all.
      const networks = await opts.docker.listNetworks(`${LABEL_MANAGED}=true`);
      for (const n of networks) {
        const ref = n.Labels?.[LABEL_REF];
        if (ref && placedRefs.has(ref)) continue;
        log('error', 'drift found: orphan network — NOT removed, needs an operator', {
          network: n.Name, ref: ref ?? 'unlabelled',
        });
        drift.push({
          class: 'orphan_network', ...(ref ? { ref } : {}), action: 'alert_only',
          detail: `network ${n.Name} has no placement row — usually a purge that ` +
            'stopped half-way; each bridge network consumes a subnet from the node pool',
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
