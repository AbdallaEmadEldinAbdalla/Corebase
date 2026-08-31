import type { ProvisioningJobData } from '@corebase/queue';
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
}

export class UnknownJobTypeError extends Error {}

export function createRunner(opts: RunnerOptions) {
  const staleAfterMs = opts.staleAfterMs ?? 90_000;
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
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
        log('info', 'job already succeeded — duplicate delivery ignored', { id: row.id });
        return { outcome: 'skipped', stepsRun: [] };
      }

      const claimed = await opts.repo.claim(row.id, staleAfterMs);
      if (!claimed) {
        log('info', 'job claimed by another worker', { id: row.id });
        return { outcome: 'skipped', stepsRun: [] };
      }

      const steps = opts.sagas[claimed.job_type];
      if (!steps) {
        await opts.repo.fail(claimed.id, `no saga registered for job_type "${claimed.job_type}"`);
        throw new UnknownJobTypeError(claimed.job_type);
      }

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
            log: (msg, extra) => log('info', msg, { step: step.name, id: claimed.id, ...extra }),
          });
          // Per-step duration on every run, not just when someone is measuring.
          // A saga whose total time is known but whose distribution across steps
          // is not is a saga you cannot tune; this is also the raw material for
          // T9's provisioning-duration histogram.
          log('info', 'step complete', { step: step.name, id: claimed.id, ms: now() - startedAt });
          done.add(step.name);
          stepsRun.push(step.name);
          // checkpoint AFTER the step, so an interrupted step is retried
          await opts.repo.saveCheckpoint(claimed.id, { completed: [...done] });
        }
        await opts.repo.succeed(claimed.id);
        return { outcome: 'succeeded', stepsRun };
      } catch (err) {
        const { terminal } = await opts.repo.fail(claimed.id, (err as Error).message);
        log(terminal ? 'error' : 'warn', terminal ? 'job dead-lettered' : 'job failed, will retry',
          { id: claimed.id, error: (err as Error).message });
        if (terminal) return { outcome: 'dead_letter', stepsRun };
        throw err;   // let BullMQ apply its backoff
      } finally {
        clearInterval(beat);
      }
    },
  };
}
