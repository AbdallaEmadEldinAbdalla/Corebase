import { describe, it, expect } from 'vitest';
import {
  restoreTtlHours, expiryFor, RESTORE_TTL_HOURS_DEFAULT, RESTORE_TTL_HOURS_MAX,
} from './restore-expiry.ts';

/**
 * P3e — how long a restored copy lives.
 *
 * Two numbers: 48 hours by default, never more than a week. The clamping matters
 * more than the numbers, because both ends of the range fail silently — a TTL of
 * zero deletes every copy before anyone can look at it, and a TTL of a year is
 * capacity quietly going to databases nobody queries.
 */
describe('the window', () => {
  it('is 48 hours by default', () => {
    expect(RESTORE_TTL_HOURS_DEFAULT).toBe(48);
    expect(restoreTtlHours(undefined)).toBe(48);
    expect(restoreTtlHours('')).toBe(48);
  });

  it('is never longer than a week, however it is configured', () => {
    expect(RESTORE_TTL_HOURS_MAX).toBe(168);
    expect(restoreTtlHours('168')).toBe(168);
    expect(restoreTtlHours('169')).toBe(168);
    expect(restoreTtlHours('8760')).toBe(168);
  });

  it('falls back to the default for a value that is not a window at all', () => {
    // Nonsense, zero and negatives are not "a very short window" — they are the
    // absence of an answer, and the safe answer to that is the default. A TTL of
    // zero would delete every copy before the customer could open it, which is
    // indistinguishable from the feature being broken.
    expect(restoreTtlHours('0')).toBe(48);
    expect(restoreTtlHours('-5')).toBe(48);
    expect(restoreTtlHours('nonsense')).toBe(48);
  });

  it('clamps a real number that is merely out of range, in both directions', () => {
    // Different case from the one above, and worth separating: someone who wrote
    // 0.5 or 200 *did* express an intent, so the honest response is the nearest
    // bound rather than silently substituting 48. A fleet that will not boot
    // because someone typed 200 is worse than one that keeps copies for a week.
    expect(restoreTtlHours('0.5')).toBe(1);
    expect(restoreTtlHours('1')).toBe(1);
    expect(restoreTtlHours('300')).toBe(RESTORE_TTL_HOURS_MAX);
  });

  it('truncates fractions rather than carrying them into an interval', () => {
    expect(restoreTtlHours('47.9')).toBe(47);
  });
});

describe('the deadline', () => {
  it('is the window from now', () => {
    const now = new Date('2026-09-02T10:00:00Z');
    expect(expiryFor(now, 48).toISOString()).toBe('2026-09-04T10:00:00.000Z');
    expect(expiryFor(now, 1).toISOString()).toBe('2026-09-02T11:00:00.000Z');
  });

  it('is a week out at the ceiling', () => {
    const now = new Date('2026-09-02T10:00:00Z');
    expect(expiryFor(now, RESTORE_TTL_HOURS_MAX).toISOString())
      .toBe('2026-09-09T10:00:00.000Z');
  });
});
