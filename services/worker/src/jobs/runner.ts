import type { ProvisioningJobData } from '@steadhold/queue';
import type { JobRepo, JobRecord } from './repo.ts';

/**
 * A saga is an ordered list of named steps. Each step is check-then-act: it
 * asks "is this already true?" before doing anything, so re-running a step is
 * harmless. That is what makes crash-resume (T6) possible — the runner replays
 * from the last checkpoint and completed steps become no-ops.
 */
export interface SagaStep<C> {
  name: string;
  run(ctx: C): Promise<void>;
}

export interface SagaContext {
  job: JobRecord;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface RunnerOptions {
  repo: JobRepo;
  sagas: Record<string, SagaStep<SagaContext>[]>;
  staleAfterMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /**
   * Metrics hooks, injected rather than imported: the runner stays testable
   * without a registry, and where the numbers go is main.ts's business.
   */
  onStep?: (jobType: string, step: string, seconds: number) => void;
  onJob?: (jobType: string, outcome: 'succeeded' | 'failed' | 'dead_letter', seconds: number) => void;
  /**
   * A job has given up for good.
   *
   * Separate from `onJob`, which is a metric, because this one has to *change
   * something*. Until it existed, a dead-lettered `provision_project` left the
   * project sitting at `creating` forever: the saga had stopped, the retries were
   * spent, and the dashboard went on showing CREATING — for half an hour in the
   * case that produced this hook — because nothing in the worker ever called
   * `markStatus`. A state nobody will ever leave has to be said out loud.
   *
   * Awaited, and its own failure is logged rather than thrown: the job is already
   * terminal, so there is no outcome left to protect.
   */
  onDeadLetter?: (job: JobRecord) => Promise<void>;
}

export class UnknownJobTypeError extends Error {}

/** Identity fields lifted out of the job payload for every log line. */
function ctxLabels(job: JobRecord): Record<string, unknown> {
  const payload = (job.payload ?? {}) as { ref?: string; request_id?: string };
  return {
    ...(payload.ref ? { ref: payload.ref } : {}),
    ...(payload.request_id ? { request_id: payload.request_id } : {}),
  };
}

/**
 * How long a claimed job may go without a heartbeat before another worker may
 * take it. Derived from the heartbeat interval on purpose: a worker that has
 * missed three beats is dead by any measure available to us, and a threshold
 * chosen independently of the beat drifts into one of two failures — too long
 * and a crashed job's re-delivery arrives before the row looks stale (T6 found
 * this: BullMQ re-delivered at ~30s against a 90s threshold, the restarted
 * worker declined the claim, and the delivery was marked complete, leaving the
 * project stuck forever); too short and a live worker has its job stolen
 * mid-step.
 */
export const STALE_HEARTBEAT_MULTIPLE = 3;

export function createRunner(opts: RunnerOptions) {
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const staleAfterMs = opts.staleAfterMs ?? heartbeatMs * STALE_HEARTBEAT_MULTIPLE;
  if (staleAfterMs <= heartbeatMs * 2) {
    throw new Error(
      `staleAfterMs (${staleAfterMs}ms) must exceed two heartbeat intervals ` +
      `(${heartbeatMs}ms each), or a live worker loses jobs it is still running`);
  }
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;

  return {
    /** Returns what happened, so callers and tests can assert without log scraping. */
    async execute(data: ProvisioningJobData): Promise<
      { outcome: 'succeeded' | 'skipped' | 'retry' | 'dead_letter'; stepsRun: string[] }
    > {
      const row = await opts.repo.byIdempotencyKey(data.idempotency_key);
      if (!row) {
        // Redis had a delivery Postgres has no row for. Postgres wins (D-018).
        log('warn', 'job delivered with no row of record — dropping', { key: data.idempotency_key });
        return { outcome: 'skipped', stepsRun: [] };
      }
      if (row.state === 'succeeded') {
        log('info', 'job already succeeded — duplicate delivery ignored', { id: row.id, ...ctxLabels(row) });
        return { outcome: 'skipped', stepsRun: [] };
      }

      const claimed = await opts.repo.claim(row.id, staleAfterMs);
      if (!claimed) {
        log('info', 'job claimed by another worker', { id: row.id, ...ctxLabels(row) });
        return { outcome: 'skipped', stepsRun: [] };
      }

      const steps = opts.sagas[claimed.job_type];
      if (!steps) {
        await opts.repo.fail(claimed.id, `no saga registered for job_type "${claimed.job_type}"`);
        throw new UnknownJobTypeError(claimed.job_type);
      }

      const jobStartedAt = now();
      const beat = setInterval(() => { void opts.repo.heartbeat(claimed.id); }, heartbeatMs);
      const done = new Set<string>(
        Array.isArray(claimed.checkpoint?.['completed'])
          ? (claimed.checkpoint['completed'] as string[]) : []);
      const stepsRun: string[] = [];
      try {
        for (const step of steps) {
          if (done.has(step.name)) { log('info', 'step already done — skipping', { step: step.name }); continue; }
          const startedAt = now();
          await step.run({
            job: claimed,
            // ref and request_id travel on every line (D-147: they belong in the
            // line, never in a Loki label). One `ref` query then shows a
            // project's whole history, and one `request_id` shows exactly the
            // work a single API call caused.
            log: (msg, extra) => log('info', msg, {
              step: step.name, id: claimed.id, ...ctxLabels(claimed), ...extra,
            }),
          });
          // Per-step duration on every run, not just when someone is measuring.
          // A saga whose total time is known but whose distribution across steps
          // is not is a saga you cannot tune; this is also the raw material for
          // T9's provisioning-duration histogram.
          const stepMs = now() - startedAt;
          log('info', 'step complete', { step: step.name, id: claimed.id, ms: stepMs });
          opts.onStep?.(claimed.job_type, step.name, stepMs / 1000);
          done.add(step.name);
          stepsRun.push(step.name);
          // checkpoint AFTER the step, so an interrupted step is retried
          await opts.repo.saveCheckpoint(claimed.id, { completed: [...done] });
        }
        await opts.repo.succeed(claimed.id);
        opts.onJob?.(claimed.job_type, 'succeeded', (now() - jobStartedAt) / 1000);
        return { outcome: 'succeeded', stepsRun };
      } catch (err) {
        const { terminal } = await opts.repo.fail(claimed.id, (err as Error).message);
        log(terminal ? 'error' : 'warn', terminal ? 'job dead-lettered' : 'job failed, will retry',
          { id: claimed.id, ...ctxLabels(claimed), error: (err as Error).message });
        opts.onJob?.(claimed.job_type, terminal ? 'dead_letter' : 'failed',
          (now() - jobStartedAt) / 1000);
        if (terminal) {
          try {
            await opts.onDeadLetter?.(claimed);
          } catch (hookErr) {
            log('error', 'dead-letter hook failed',
              { id: claimed.id, error: (hookErr as Error).message });
          }
          return { outcome: 'dead_letter', stepsRun };
        }
        throw err;   // let BullMQ apply its backoff
      } finally {
        clearInterval(beat);
      }
    },
  };
}
