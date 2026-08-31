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

/**
 * BullMQ reserves ':' in job ids as well as in queue names, and rejects it with
 * "Custom Id cannot contain :". Since the delivery id IS the idempotency key
 * (D-067), that constraint reaches all the way out to the API's
 * `Idempotency-Key` header and to every internally-derived key.
 *
 * Enforced here rather than trusted, because the failure is silent and total: an
 * enqueue that throws is swallowed by the producer (the row of record exists, so
 * the sweeper will retry), and the sweeper then throws on the same key every
 * sweep — one bad key disables orphan recovery for every project on the fleet.
 */
export const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_.=#@-]{8,255}$/;

export function assertValidDeliveryId(key: string): void {
  if (!DELIVERY_ID_PATTERN.test(key)) {
    throw new Error(
      `"${key}" cannot be a delivery id: it must match ${DELIVERY_ID_PATTERN} ` +
      "(BullMQ rejects ':' in job ids, and the delivery id is the idempotency key)");
  }
}

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
  assertValidDeliveryId(data.idempotency_key);
  const existing = await queue.getJob(data.idempotency_key);
  if (existing) return { enqueued: false };
  await queue.add(data.job_type, data, { ...opts, jobId: data.idempotency_key });
  return { enqueued: true };
}

/**
 * The delivery id used when the sweeper rebuilds a lost delivery.
 *
 * Deliberately *not* the bare idempotency key. Redis still holds a job under
 * that key — the one the dead worker was handed — and BullMQ keeps it `active`
 * with a live lock for the full `lockDuration` after the process vanished, so
 * neither adding nor removing it is possible. Waiting that out made crash
 * recovery take 60s when Postgres had known the worker was dead for 30 (T6
 * measured exactly that).
 *
 * Keyed by attempt, so a sweep that runs twice before the worker picks up
 * produces one delivery, not two, and a second crash produces a third id rather
 * than colliding with the second.
 */
export function recoveryJobId(idempotencyKey: string, attempt: number): string {
  return `${idempotencyKey}#recover-${attempt}`;
}

/**
 * Re-deliver a job whose row Postgres says is orphaned.
 *
 * `enqueueProvisioning`'s "already there, do nothing" is right for the producer:
 * two creates with one idempotency key must not become two deliveries. It is
 * wrong for the sweeper, whose whole purpose is to rebuild deliveries from
 * Postgres — Redis's record of the *previous* delivery is not a reason to
 * withhold the next one.
 *
 * This is safe only because of the claim UPDATE in provisioning_jobs: that
 * statement is the mutex, so a stale delivery and a recovery delivery arriving
 * together means one runs and one is skipped, never two runs. Do not call this
 * from anywhere lacking that guarantee.
 */
export async function enqueueRecovery(
  queue: Queue<ProvisioningJobData>,
  data: ProvisioningJobData,
  attempt: number,
  opts: JobsOptions = {},
): Promise<{ enqueued: boolean; jobId: string }> {
  // A row that was never delivered at all — the API died between COMMIT and
  // enqueue — is not a recovery, it is the first delivery, and it should carry
  // the plain idempotency key like any other. Only deviate when that key is
  // already taken by the delivery a dead worker was holding.
  assertValidDeliveryId(data.idempotency_key);
  const plain = data.idempotency_key;
  if (!(await queue.getJob(plain))) {
    await queue.add(data.job_type, data, { ...opts, jobId: plain });
    return { enqueued: true, jobId: plain };
  }

  const jobId = recoveryJobId(plain, attempt);
  if (await queue.getJob(jobId)) return { enqueued: false, jobId };
  await queue.add(data.job_type, data, { ...opts, jobId });
  return { enqueued: true, jobId };
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
