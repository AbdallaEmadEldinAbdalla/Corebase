import { describe, it, expect } from 'vitest';
import {
  canFit, remainingMb, pickPort, NoPortsError,
  PLAN_RAM_MB, PLAN_CONTAINER_LIMIT_MB, FILL_CEILING,
  PG_PORT_RANGE, POOLER_PORT_RANGE,
} from './placement.ts';

describe('capacity arithmetic (D-090 85% stop)', () => {
  it('stops at 85% of total, not 100%', () => {
    const cap = { ramTotalMb: 1000, ramReservedMb: 0 };
    expect(remainingMb(cap)).toBe(850);
    expect(canFit(cap, 850)).toBe(true);
    expect(canFit(cap, 851)).toBe(false);   // refused well below the DDL ceiling
  });

  it('refuses a booking that would cross the stop', () => {
    expect(canFit({ ramTotalMb: 1000, ramReservedMb: 700 }, 200)).toBe(false);
    expect(canFit({ ramTotalMb: 1000, ramReservedMb: 700 }, 150)).toBe(true);
  });

  it('reports zero or negative headroom once past the stop', () => {
    expect(remainingMb({ ramTotalMb: 1000, ramReservedMb: 900 })).toBe(-50);
    expect(canFit({ ramTotalMb: 1000, ramReservedMb: 900 }, 1)).toBe(false);
  });

  it('rejects a non-positive booking rather than silently allowing it', () => {
    expect(() => canFit({ ramTotalMb: 1000, ramReservedMb: 0 }, 0)).toThrow();
  });

  it('books the plan budget, which is below the container limit (D-174)', () => {
    for (const plan of ['free', 'pro', 'team']) {
      expect(PLAN_RAM_MB[plan]!).toBeLessThan(PLAN_CONTAINER_LIMIT_MB[plan]!);
    }
    expect(PLAN_RAM_MB['free']).toBe(350);   // D-091 planning figure
  });

  it('a 64 GB node at the 85% stop holds ~159 free projects', () => {
    const node = { ramTotalMb: 64 * 1024, ramReservedMb: 0 };
    expect(Math.floor(remainingMb(node) / PLAN_RAM_MB['free']!)).toBe(159);
  });

  it('FILL_CEILING is the documented 0.85', () => expect(FILL_CEILING).toBe(0.85));
});

describe('port allocation', () => {
  it('picks the lowest free port, deterministically', () => {
    expect(pickPort([], PG_PORT_RANGE)).toBe(5433);
    expect(pickPort([5433, 5434], PG_PORT_RANGE)).toBe(5435);
    expect(pickPort([5434], PG_PORT_RANGE)).toBe(5433);   // reuses the gap
  });
  it('throws rather than returning a colliding port when the range is full', () => {
    const full = Array.from({ length: 4 }, (_, i) => 5433 + i);
    expect(() => pickPort(full, [5433, 5436])).toThrow(NoPortsError);
  });
  it('keeps the pg and pooler ranges disjoint', () => {
    expect(PG_PORT_RANGE[1]).toBeLessThan(POOLER_PORT_RANGE[0]);
  });
});
