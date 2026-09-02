import type { Pool } from 'pg';
import type { Queue, ProvisioningJobData } from '@corebase/queue';
import { enqueueProvisioning } from '@corebase/queue';

/**
 * A restored copy has a deadline (P3e, backups §4 step 7).
 *
 * ## Why it must expire
 *
 * A restored instance is a second full dataset with a second RAM booking and a
 * second disk booking, serving no traffic. Nothing about it ever finishes: the
 * customer validated their data on Tuesday, and without a deadline the copy is
 * still on the node in March. At 100 projects per node (M-008) a handful of
 * forgotten copies is a node's worth of capacity spent on databases nobody
 * queries.
 *
 * ## Why it soft-deletes rather than purges
 *
 * This is the part worth being careful about. Automatic deletion of a database is
 * exactly the operation you do not want to get wrong, and the situation is the
 * worst possible one for it: the customer restored *because they lost data*, so
 * the copy may be the only surviving version of something. Expiry therefore hands
 * the project to the normal deletion pipeline, which soft-deletes it and keeps the
 * data for the seven-day recovery window (D-038) before anything is destroyed.
 *
 * So the deadline the customer sees is not a data-destruction deadline; it is when
 * the copy stops running. There is a second window behind it, and a project that
 * expired by accident is recoverable for a week.
 */

/** Default life of a restored copy, in hours. */
export const RESTORE_TTL_HOURS_DEFAULT = 48;

/**
 * The ceiling. A restored copy is never kept longer than a week, whatever the
 * configuration says.
 *
 * A ceiling rather than a plain setting because the failure mode of a too-long TTL
 * is silent and cumulative — nobody notices capacity being consumed by copies, and
 * by the time they do it is a fleet-wide problem rather than a project-level one.
 * An operator who wants a copy for longer should promote it, which is the operation
 * that actually says "this is production now".
 */
export const RESTORE_TTL_HOURS_MAX = 168;

/**
 * How long a copy gets, clamped.
 *
 * Clamps rather than rejects: this is read from the environment at startup, and a
 * fleet that refuses to boot because someone typed 200 is worse than one that keeps
 * copies for a week and says so. Values below an hour are clamped up for the same
 * reason in the other direction — a TTL of zero would delete every restore before
 * the customer could look at it, which is indistinguishable from the feature being
 * broken.
 */
export function restoreTtlHours(raw: string | undefined = process.env['CB_RESTORE_TTL_HOURS']): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return RESTORE_TTL_HOURS_DEFAULT;
  return Math.min(RESTORE_TTL_HOURS_MAX, Math.max(1, Math.floor(parsed)));
}

/** When a copy created now should expire. */
export const expiryFor = (now: Date, hours = restoreTtlHours()): Date =>
  new Date(now.getTime() + hours * 3_600_000);

export interface RestoreExpiryOptions {
  pool: Pool;
  queue: Queue<ProvisioningJobData>;
  batchSize?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface RestoreExpiryResult {
  due: number;
  created: number;
  enqueued: number;
}

export function createRestoreExpiry(opts: RestoreExpiryOptions) {
  const batchSize = opts.batchSize ?? 20;
  const log = opts.log ?? (() => {});

  return {
    async scanOnce(): Promise<RestoreExpiryResult> {
      /**
       * Only `restored` projects, and only ones whose restore actually succeeded.
       *
       * A copy still in `restoring` is mid-saga and has no deadline yet — expiring
       * one would race the job that is building it. A failed restore is cleaned up
       * by whatever failed it, not by a clock.
       */
      const { rows: due } = await opts.pool.query<{
        id: string; ref: string; expires_at: Date; source_ref: string;
      }>(
        `SELECT p.id, p.ref::text AS ref, r.expires_at, r.source_ref
           FROM projects p
           JOIN project_restores r ON r.project_id = p.id
          WHERE p.status = 'restored'
            AND r.status = 'succeeded'
            AND r.expires_at IS NOT NULL
            AND r.expires_at <= now()
          ORDER BY r.expires_at
          LIMIT $1`, [batchSize]);
      if (due.length === 0) return { due: 0, created: 0, enqueued: 0 };

      let created = 0, enqueued = 0;
      for (const project of due) {
        // The normal deletion pipeline, not a special path. It soft-deletes, keeps
        // the data for the recovery window, and takes a final backup on the way —
        // all of which a bespoke "expire" saga would have to reimplement, and one
        // of which (the final backup) is the reason a customer can undo this.
        const key = `restore_expiry_${project.id}`;
        const { rows } = await opts.pool.query<{ id: string }>(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, 'delete_project', $2, $3::jsonb, 'pending')
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [project.id, key, JSON.stringify({
            project_id: project.id, ref: project.ref, reason: 'restore_expired' })]);
        const jobId = rows[0]?.id;
        if (!jobId) continue;               // already scheduled by an earlier sweep
        created++;

        // Marked here rather than by the saga so the dashboard stops describing the
        // copy as validatable the moment it stops being one.
        await opts.pool.query(
          `UPDATE projects SET status = 'deleting', updated_at = now() WHERE id = $1`,
          [project.id]);

        const { enqueued: ok } = await enqueueProvisioning(opts.queue, {
          job_row_id: jobId, idempotency_key: key,
          job_type: 'delete_project', project_id: project.id,
        });
        if (ok) enqueued++;
        log('restored copy expired — handed to the deletion pipeline, data kept for ' +
            'the recovery window', {
          project: project.ref, restored_from: project.source_ref,
          expired_at: project.expires_at.toISOString(), job: jobId, delivered: ok,
        });
      }
      if (created > 0) log('restore expiry sweep complete', { due: due.length, created, enqueued });
      return { due: due.length, created, enqueued };
    },
  };
}
