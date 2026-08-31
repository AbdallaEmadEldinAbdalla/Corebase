import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

/**
 * Queue transport shared by services/api (producer) and services/worker
 * (consumer). Deliberately thin.
 *
 * Redis is a DELIVERY mechanism, never the source of truth (D-018). The row in
 * provisioning_jobs is what makes a job exist; this queue only makes a worker
 * notice it promptly. Everything here must therefore tolerate Redis losing data
 * — the sweeper rebuilds from Postgres.
 */

/**
 * BullMQ reserves ':' for its own key namespacing and rejects it in queue
 * names, so namespacing goes through `prefix` instead. Redis keys still come
 * out as `corebase:provisioning:*`.
 */
export const QUEUE_PROVISIONING = 'provisioning';
export const QUEUE_PREFIX = 'corebase';

export interface ProvisioningJobData {
  job_row_id: string;
  idempotency_key: string;
  job_type: string;
  project_id: string | null;
}

export function createRedis(url: string): Redis {
  return new IORedis(url, {
    // BullMQ requires this; a blocking command must not be aborted mid-wait
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createQueue(connection: Redis): Queue<ProvisioningJobData> {
  return new Queue<ProvisioningJobData>(QUEUE_PROVISIONING, {
    connection,
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      // exponential backoff; the row's attempts/max_attempts remain authoritative
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
  });
}

/**
 * The BullMQ jobId IS the idempotency key (D-063/D-067). Adding the same key
 * twice is a no-op in Redis, so a retried enqueue — from the API or from the
 * sweeper — cannot create a second delivery.
 */
export async function enqueueProvisioning(
  queue: Queue<ProvisioningJobData>,
  data: ProvisioningJobData,
  opts: JobsOptions = {},
): Promise<{ enqueued: boolean }> {
  const existing = await queue.getJob(data.idempotency_key);
  if (existing) return { enqueued: false };
  await queue.add(data.job_type, data, { ...opts, jobId: data.idempotency_key });
  return { enqueued: true };
}

export function createWorker(
  connection: Redis,
  handler: (data: ProvisioningJobData, job: Job<ProvisioningJobData>) => Promise<void>,
  opts: { concurrency?: number } = {},
): Worker<ProvisioningJobData> {
  return new Worker<ProvisioningJobData>(
    QUEUE_PROVISIONING,
    async (job) => handler(job.data, job),
    {
      connection,
      prefix: QUEUE_PREFIX,
      // bounded so a retry storm cannot saturate a node (OQ-060)
      concurrency: opts.concurrency ?? 4,
      lockDuration: 60_000,
    },
  );
}

export type { Job, Queue, Worker, Redis };
