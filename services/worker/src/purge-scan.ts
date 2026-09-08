import type { Pool } from 'pg';
import type { Queue, ProvisioningJobData } from '@steadhold/queue';
import { enqueueProvisioning } from '@steadhold/queue';

/**
 * The purge scan closes the recovery window (D-038).
 *
 * A soft-deleted project keeps its volume for 7 days so a restore is a status
 * flip. This scan finds the ones whose window has expired and creates the
 * `purge_project` job that destroys them.
 *
 * It is deliberately a *creator* of work, not a repairer of deliveries — that is
 * the sweeper's job. Both run on timers in the worker, and both follow the
 * two-phase rule (D-067): the row is written first, and the enqueue is a
 * best-effort convenience the sweeper can redo.
 */
export interface PurgeScanOptions {
  pool: Pool;
  queue: Queue<ProvisioningJobData>;
  batchSize?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export function createPurgeScan(opts: PurgeScanOptions) {
  const batchSize = opts.batchSize ?? 20;
  const log = opts.log ?? (() => {});

  return {
    async scanOnce(): Promise<{ due: number; created: number; enqueued: number }> {
      const { rows: due } = await opts.pool.query<{ id: string; ref: string }>(
        `SELECT id, ref::text AS ref
           FROM projects
          WHERE status = 'soft_deleted' AND purge_after IS NOT NULL AND purge_after <= now()
          ORDER BY purge_after
          LIMIT $1`, [batchSize]);
      if (due.length === 0) return { due: 0, created: 0, enqueued: 0 };

      let created = 0;
      let enqueued = 0;
      for (const project of due) {
        // Deterministic key: a scan that runs every hour, or twice because two
        // workers are up, must not produce two purges of one project.
        // Underscore, not colon: BullMQ rejects ':' in job ids, and the delivery
        // id is this key (see assertValidDeliveryId for why that is enforced).
        const key = `purge_${project.id}`;
        const { rows } = await opts.pool.query<{ id: string }>(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, 'purge_project', $2, $3::jsonb, 'pending')
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [project.id, key, JSON.stringify({ project_id: project.id, ref: project.ref })]);
        const jobId = rows[0]?.id;
        if (!jobId) continue;              // already scheduled by an earlier scan
        created++;

        const { enqueued: ok } = await enqueueProvisioning(opts.queue, {
          job_row_id: jobId,
          idempotency_key: key,
          job_type: 'purge_project',
          project_id: project.id,
        });
        if (ok) enqueued++;
        log('purge scheduled — the recovery window has closed', {
          project: project.ref, job: jobId, delivered: ok,
        });
      }
      if (created > 0) log('purge scan complete', { due: due.length, created, enqueued });
      return { due: due.length, created, enqueued };
    },
  };
}
