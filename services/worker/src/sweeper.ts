import type { Queue } from '@steadhold/queue';
import { enqueueRecovery, type ProvisioningJobData } from '@steadhold/queue';
import type { JobRepo } from './jobs/repo.ts';

/**
 * The sweeper is what makes Redis disposable (D-067). It rebuilds deliveries
 * from Postgres for rows that were never enqueued (the API died between COMMIT
 * and enqueue) or were claimed by a worker that then died.
 *
 * It re-enqueues; it never reruns work itself and never deletes anything.
 */
export interface SweeperOptions {
  repo: JobRepo;
  queue: Queue<ProvisioningJobData>;
  staleAfterMs?: number;
  batchSize?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export function createSweeper(opts: SweeperOptions) {
  const staleAfterMs = opts.staleAfterMs ?? 90_000;
  const batchSize = opts.batchSize ?? 50;
  const log = opts.log ?? (() => {});

  return {
    async sweepOnce(): Promise<{ found: number; reEnqueued: number }> {
      const orphans = await opts.repo.findOrphans(staleAfterMs, batchSize);
      let reEnqueued = 0;
      for (const row of orphans) {
        // A recovery delivery under its own id, not the original idempotency
        // key: Redis still holds the dead worker's job under that key, locked
        // and untouchable until its lockDuration expires. A plain enqueue is a
        // no-op against that record, which left crashed provisions stuck
        // forever; waiting for the lock cost 60s when Postgres had known the
        // worker was dead for 30. The claim UPDATE is the mutex that makes an
        // extra delivery harmless (T6).
        const { enqueued, jobId } = await enqueueRecovery(opts.queue, {
          job_row_id: row.id,
          idempotency_key: row.idempotency_key,
          job_type: row.job_type,
          project_id: row.project_id,
        }, row.attempts);
        if (enqueued) {
          await opts.repo.markEnqueued(row.id);
          reEnqueued++;
          log('re-enqueued orphaned job', {
            id: row.id, job_type: row.job_type, state: row.state, delivery: jobId });
        }
      }
      if (orphans.length) log('sweep complete', { found: orphans.length, reEnqueued });
      return { found: orphans.length, reEnqueued };
    },
  };
}
