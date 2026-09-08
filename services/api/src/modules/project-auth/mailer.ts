import type { Pool } from 'pg';
import { capsFor, checkAndConsume, type CounterStore } from '@steadhold/email';
import { enqueueAuthEmail, type AuthEmailJobData, type Queue } from '@steadhold/queue';
import type { AuthMailer, AuthEmailJob } from './mail.ts';

/**
 * The real mailer: suppression → caps → send row → queue (P4d, D-116).
 *
 * ## Why the gate is here and not in the worker
 *
 * Checking caps at *enqueue* rather than at send means a burst is refused while it
 * is still one Redis round trip, instead of filling a queue whose drain rate is
 * the thing the caps exist to protect. A worker-side check would let an attacker
 * put ten thousand jobs in Redis and have them all refused one at a time, which
 * denies the project its legitimate mail just as effectively as sending them
 * would have burned the domain.
 *
 * ## Why nothing here throws
 *
 * Every caller is an enumeration-safe flow that has already committed to a
 * same-shape 200 (D-330). A cap hit, a suppressed address, a Redis outage and a
 * bug in this file must all produce the same HTTP response as a successful send,
 * because the alternative tells the caller their address was interesting. What
 * makes that honest rather than a shrug is `email_sends`: every outcome, including
 * every refusal, is a row a developer can read.
 */

export interface RealMailerDeps {
  pool: Pool;
  redis: CounterStore;
  queue: Queue<AuthEmailJobData>;
  /** Where a failure that has nowhere else to go is reported. */
  onError?: ((err: Error, job: AuthEmailJob) => void) | undefined;
}

interface ProjectRow { plan: string; created_at: Date }

export function createMailer(deps: RealMailerDeps): AuthMailer {
  return {
    async enqueue(job: AuthEmailJob): Promise<void> {
      try {
        await handle(deps, job);
      } catch (err) {
        // The last line of the "must not throw" contract. A flow's 200 has
        // already been decided, so the only useful thing left is to say so
        // somewhere an operator will see.
        deps.onError?.(err as Error, job);
      }
    },
  };
}

async function handle(deps: RealMailerDeps, job: AuthEmailJob): Promise<void> {
  const recipient = job.to.trim().toLowerCase();
  if (!recipient) return;

  // Both suppression lists in one query, which is why they share a table: the
  // check is on the hot path of every flow, and two tables would be two round
  // trips plus two places for the same shape to drift.
  const [{ rows: sup }, { rows: proj }] = await Promise.all([
    deps.pool.query<{ scope: string }>(
      `SELECT CASE WHEN project_id IS NULL THEN 'global' ELSE 'project' END AS scope
         FROM email_suppressions
        WHERE lower(email) = $1
          AND (project_id IS NULL OR project_id = $2)`,
      [recipient, job.projectId]),
    deps.pool.query<ProjectRow>(
      `SELECT plan, created_at FROM projects WHERE id = $1`, [job.projectId]),
  ]);

  const record = async (
    status: 'queued' | 'suppressed' | 'rate_limited', error?: string,
  ) => {
    // `ON CONFLICT DO UPDATE` rather than DO NOTHING: a resend after a cap window
    // reopens must be able to move the row from `rate_limited` to `queued`, or
    // the developer's view says a mail was refused when it was later sent.
    // `attempts` is left alone — it belongs to the worker.
    await deps.pool.query(
      `INSERT INTO email_sends (project_id, delivery_id, template, recipient, status, error)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, delivery_id) DO UPDATE
          SET status = excluded.status, error = excluded.error,
              recipient = excluded.recipient, updated_at = now()`,
      [job.projectId, job.deliveryId, job.email, recipient, status, error ?? null]);
  };

  if (sup.length) {
    // Global beats project: an address on the global list is a trap or dead, and
    // no project's wish to retry it outranks the shared domain.
    const scope = sup.some((r) => r.scope === 'global') ? 'global' : 'project';
    await record('suppressed', `on the ${scope} suppression list`);
    return;
  }

  const project = proj[0];
  const caps = capsFor(
    project?.plan ?? 'free',
    project ? Date.now() - project.created_at.getTime() : undefined);

  const verdict = await checkAndConsume(deps.redis, {
    projectId: job.projectId, recipient, caps,
    // Already established above; the gate takes them as an argument so it stays
    // pure and testable against a fake Redis with no database at all.
    suppression: { global: false, project: false },
  });

  if (!verdict.allowed) {
    await record('rate_limited',
      verdict.reason === 'rate_limited'
        ? `over the ${verdict.cap} cap for the ${project?.plan ?? 'free'} plan`
        : 'suppressed');
    return;
  }

  // The row before the job, for the same reason credentials are stored before
  // they are applied (store-then-apply): a crash between the two leaves a row
  // saying a mail is owed and no job, which a sweeper can fix. The reverse
  // leaves a mail in somebody's inbox that no row accounts for.
  await record('queued');
  await enqueueAuthEmail(deps.queue, {
    delivery_id: job.deliveryId,
    project_id: job.projectId,
    project_ref: job.projectRef,
    template: job.email,
    to: recipient,
    variables: job.variables,
  });
}
