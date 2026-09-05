import { describe, it, expect, vi } from 'vitest';
import { createTrafficMeter } from './traffic.ts';

/**
 * P5a — the data-plane traffic signal.
 *
 * The property that matters is arithmetic: a burst of requests must cost one
 * write, not one per request, or this puts a control-plane UPDATE on the hot path
 * that D-051 exists to keep free of them. The rest is about not failing a request
 * for a bookkeeping row.
 */
/**
 * The argument types are declared rather than inferred: `vi.fn` with a zero-arg
 * implementation infers a zero-length tuple for the call arguments, so reading
 * `mock.calls[0][1]` is a type error even though the call really does carry two.
 */
const fakePool = (impl?: () => Promise<unknown>) => {
  const query = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(
    impl ?? (() => Promise.resolve({ rows: [] })));
  return { pool: { query } as never, query };
};

describe('P5a — the traffic meter', () => {
  it('writes once for a burst, not once per request', () => {
    const { pool, query } = fakePool();
    const meter = createTrafficMeter(pool, { intervalMs: 60_000 });
    for (let i = 0; i < 50; i++) meter.seen('p1');
    // Fifty requests, one UPDATE. The idle window is measured in days, so a
    // minute of staleness cannot change the decision — and the alternative is a
    // write per request on the data plane's hot path.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatch(/last_active_at = now\(\)/);
    expect(query.mock.calls[0]![1]).toEqual(['p1']);
  });

  it('writes again once the interval has passed', () => {
    vi.useFakeTimers();
    try {
      const { pool, query } = fakePool();
      const meter = createTrafficMeter(pool, { intervalMs: 1000 });
      meter.seen('p1');
      vi.advanceTimersByTime(1500);
      meter.seen('p1');
      expect(query).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('keeps projects apart', () => {
    const { pool, query } = fakePool();
    const meter = createTrafficMeter(pool, { intervalMs: 60_000 });
    meter.seen('p1'); meter.seen('p2'); meter.seen('p1');
    // One throttle per project, not one globally — otherwise a busy project
    // suppresses a quiet one's only request of the hour and the quiet one is
    // paused for it.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('never throws, and never awaits, when the write fails', async () => {
    const { pool, query } = fakePool(() => Promise.reject(new Error('pool is closed')));
    const errors: string[] = [];
    const meter = createTrafficMeter(pool, {
      intervalMs: 60_000, onError: (e) => errors.push(e.message) });
    // A request must not get slower, and must certainly not fail, because a
    // bookkeeping UPDATE did.
    expect(() => meter.seen('p1')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(['pool is closed']);
    // …and the memo is released, so the next request retries rather than waiting
    // out the whole interval on a write that never happened.
    meter.seen('p1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('bounds what it remembers', () => {
    const { pool } = fakePool();
    const meter = createTrafficMeter(pool, { intervalMs: 60_000 });
    for (let i = 0; i < 10_050; i++) meter.seen(`p${i}`);
    // An unbounded map fed by an unauthenticated endpoint is a leak with a
    // public trigger.
    expect(meter.size()).toBeLessThanOrEqual(10_000);
  });
});
