import { describe, it, expect } from 'vitest';
import { rungFor, LADDER, quotaFor, type DiskState } from './disk-scan.ts';
import { PLAN_DISK_CAP_MB, quotaMbFor, diskBookingGbFor, QUOTA_HEADROOM } from './placement.ts';

/**
 * The ladder's arithmetic, without a database. The rungs and the hysteresis are the
 * part that is easy to get subtly wrong and impossible to notice in production
 * until a customer is stuck.
 */
describe('P2e — the ladder', () => {
  const at = (pct: number, from: DiskState = 'ok') => rungFor(pct, from);

  it('climbs at the documented thresholds', () => {
    expect(at(0)).toBe('ok');
    expect(at(79.9)).toBe('ok');
    expect(at(80)).toBe('warn');
    expect(at(89.9)).toBe('warn');
    expect(at(90)).toBe('critical');
    expect(at(94.9)).toBe('critical');
    expect(at(95)).toBe('read_only');
    expect(at(500)).toBe('read_only');
  });

  it('holds read-only until usage is back under the lift line, not the trigger', () => {
    // Hysteresis. Lifting at 95% would let a project on the boundary flap between
    // writable and read-only, and every flip is an incident from the application's
    // side — errors appearing and vanishing with no deploy.
    expect(at(94, 'read_only')).toBe('read_only');
    expect(at(90, 'read_only')).toBe('read_only');
    expect(at(89.9, 'read_only')).toBe('warn');
    expect(LADDER.lift).toBeLessThan(LADDER.readOnly);
  });

  it('does not make a project sticky on the lower rungs', () => {
    // Only read-only is sticky, because only read-only has a cost to flapping.
    // A warn banner appearing and clearing is fine.
    expect(at(50, 'warn')).toBe('ok');
    expect(at(85, 'critical')).toBe('warn');
  });

  it('gives the recovery path room to run', () => {
    // The headroom is the whole reason a customer at 100% of their plan can still
    // delete rows: freeing space *writes*, and a filesystem with nothing left
    // cannot accept the WAL that would free space.
    expect(QUOTA_HEADROOM).toBeGreaterThan(1);
    expect(quotaFor(500)).toBe(600);
    expect(quotaMbFor('free')).toBe(600);
    // At the read-only rung the project still has real room before the hard quota.
    const capMb = PLAN_DISK_CAP_MB['free']!;
    const atReadOnly = capMb * (LADDER.readOnly / 100);
    expect(quotaMbFor('free') - atReadOnly).toBeGreaterThan(100);
  });

  it('books whole gigabytes, never zero', () => {
    // A Free project's quota is 600 MB, which rounds to 1 GB — booking 0 would let
    // a node take unlimited Free projects on the disk axis.
    expect(diskBookingGbFor('free')).toBe(1);
    expect(diskBookingGbFor('pro')).toBe(10);       // 8192 * 1.2 = 9830 MB -> 10 GB
    expect(diskBookingGbFor('nonsense')).toBe(1);   // unknown plan falls back to free
  });
});
