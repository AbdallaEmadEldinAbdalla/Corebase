import { describe, it, expect, vi } from 'vitest';
import { createRunner, STALE_HEARTBEAT_MULTIPLE, UnknownJobTypeError, type SagaStep, type SagaContext } from './runner.ts';
import type { JobRecord, JobRepo } from './repo.ts';

/** In-memory repo double: the runner's contract is what is under test here. */
function fakeRepo(initial: Partial<JobRecord> = {}) {
  const row: JobRecord = {
    id: 'job-1', project_id: 'proj-1', node_id: null,
    job_type: 'provision_project', idempotency_key: 'key-1',
    state: 'enqueued', attempts: 0, max_attempts: 3,
    payload: {}, checkpoint: {}, ...initial,
  };
  const calls: string[] = [];
  const repo = {
    async byIdempotencyKey() { return row; },
    async markEnqueued() { calls.push('markEnqueued'); },
    async claim() {
      if (!['pending', 'enqueued'].includes(row.state) && row.state !== 'running') return undefined;
      row.state = 'running'; row.attempts += 1; calls.push('claim'); return { ...row };
    },
    async heartbeat() { calls.push('heartbeat'); },
    async saveCheckpoint(_id: string, cp: Record<string, unknown>) {
      row.checkpoint = cp; calls.push('checkpoint:' + (cp['completed'] as string[]).join(',')); },
    async succeed() { row.state = 'succeeded'; calls.push('succeed'); },
    async fail(_id: string, err: string) {
      calls.push('fail:' + err);
      const terminal = row.attempts >= row.max_attempts;
      row.state = terminal ? 'dead_letter' : 'pending';
      return { terminal };
    },
    async findOrphans() { return []; },
  } as unknown as JobRepo;
  return { repo, row, calls };
}

const step = (name: string, fn?: () => void): SagaStep<SagaContext> => ({
  name, async run() { fn?.(); },
});
const data = { job_row_id: 'job-1', idempotency_key: 'key-1', job_type: 'provision_project', project_id: 'proj-1' };

describe('saga runner', () => {
  it('runs every step in order and marks the job succeeded', async () => {
    const order: string[] = [];
    const { repo, row } = fakeRepo();
    const runner = createRunner({ repo, sagas: {
      provision_project: [step('a', () => order.push('a')), step('b', () => order.push('b'))] } });
    const res = await runner.execute(data);
    expect(res.outcome).toBe('succeeded');
    expect(order).toEqual(['a', 'b']);
    expect(row.state).toBe('succeeded');
  });

  it('checkpoints AFTER each step, so an interrupted step is retried not skipped', async () => {
    const { repo, calls } = fakeRepo();
    const runner = createRunner({ repo, sagas: { provision_project: [step('a'), step('b')] } });
    await runner.execute(data);
    expect(calls).toContain('checkpoint:a');
    expect(calls).toContain('checkpoint:a,b');
  });

  it('resumes from a checkpoint: completed steps are skipped, the rest run', async () => {
    const ran: string[] = [];
    const { repo } = fakeRepo({ checkpoint: { completed: ['allocate_node', 'create_volume'] } });
    const runner = createRunner({ repo, sagas: { provision_project: [
      step('allocate_node', () => ran.push('allocate_node')),
      step('create_volume', () => ran.push('create_volume')),
      step('start_container', () => ran.push('start_container')),
    ] } });
    const res = await runner.execute(data);
    expect(ran).toEqual(['start_container']);          // the two done steps did not re-run
    expect(res.stepsRun).toEqual(['start_container']);
  });

  it('a duplicate delivery of a succeeded job does nothing', async () => {
    const { repo } = fakeRepo({ state: 'succeeded' });
    const runner = createRunner({ repo, sagas: { provision_project: [step('a')] } });
    expect((await runner.execute(data)).outcome).toBe('skipped');
  });

  it('drops a delivery with no row of record — Postgres wins over Redis', async () => {
    const repo = { async byIdempotencyKey() { return undefined; } } as unknown as JobRepo;
    const runner = createRunner({ repo, sagas: { provision_project: [step('a')] } });
    expect((await runner.execute(data)).outcome).toBe('skipped');
  });

  it('retries a failing step (rethrows for BullMQ backoff) and records the error', async () => {
    const { repo, calls, row } = fakeRepo({ attempts: 0, max_attempts: 3 });
    const runner = createRunner({ repo, sagas: { provision_project: [
      step('boom', () => { throw new Error('volume create failed'); }) ] } });
    await expect(runner.execute(data)).rejects.toThrow('volume create failed');
    expect(calls.some((c) => c.startsWith('fail:volume create failed'))).toBe(true);
    expect(row.state).toBe('pending');                 // retryable, not terminal
  });

  it('dead-letters once attempts reach max, and does NOT rethrow', async () => {
    const { repo, row } = fakeRepo({ attempts: 2, max_attempts: 3 });
    const runner = createRunner({ repo, sagas: { provision_project: [
      step('boom', () => { throw new Error('still broken'); }) ] } });
    const res = await runner.execute(data);
    expect(res.outcome).toBe('dead_letter');
    expect(row.state).toBe('dead_letter');
  });

  it('refuses an unregistered job_type instead of silently succeeding', async () => {
    const { repo } = fakeRepo({ job_type: 'launch_missiles' });
    const runner = createRunner({ repo, sagas: { provision_project: [step('a')] } });
    await expect(runner.execute(data)).rejects.toThrow(UnknownJobTypeError);
  });

  it('heartbeats while a long step runs', async () => {
    vi.useFakeTimers();
    const { repo, calls } = fakeRepo();
    const runner = createRunner({ repo, heartbeatMs: 50, sagas: { provision_project: [
      { name: 'slow', run: () => new Promise<void>((r) => setTimeout(r, 200)) } ] } });
    const p = runner.execute(data);
    await vi.advanceTimersByTimeAsync(250);
    await p;
    expect(calls.filter((c) => c === 'heartbeat').length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });
});

describe('the stale-heartbeat threshold (D-193)', () => {
  it('defaults to three missed heartbeats', () => {
    // Derived, not chosen independently. T6: a 90s threshold against a 10s beat
    // meant a crashed job's re-delivery arrived while the row still looked
    // healthy, the restarted worker declined the claim, BullMQ marked the
    // delivery complete, and the project never converged.
    expect(STALE_HEARTBEAT_MULTIPLE).toBe(3);
  });

  it('refuses a threshold a live worker could trip over', () => {
    expect(() => createRunner({ repo: {} as never, sagas: {}, heartbeatMs: 10_000, staleAfterMs: 15_000 }))
      .toThrow(/must exceed two heartbeat intervals/);
    expect(() => createRunner({ repo: {} as never, sagas: {}, heartbeatMs: 10_000, staleAfterMs: 30_001 }))
      .not.toThrow();
  });
});

