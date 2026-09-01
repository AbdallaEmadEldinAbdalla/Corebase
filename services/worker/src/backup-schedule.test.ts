import { describe, it, expect } from 'vitest';
import { decideBackup, inSlot, slotMinuteFor, WINDOW } from './backup-schedule.ts';

/**
 * P3c — the plan matrix, without a database or a clock.
 *
 * Free takes a nightly full and nothing between. Pro and Team take a weekly full
 * with nightly incrementals. Everything below is a consequence of those two
 * sentences plus the maintenance window, and the interesting cases are the ones
 * where the window has to be *ignored*.
 */
const ID = '11111111-1111-4111-8111-111111111111';
const ALWAYS = { startHour: 0, endHour: 24 };
const at = (iso: string) => new Date(iso);
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * 86_400_000);

describe('a project with no backup at all', () => {
  it('is due a full immediately, window or no window', () => {
    // The exception that matters most. A project created at 09:00 would otherwise
    // have no base backup until the following night, and "we lost a beta user's
    // data" is a sentence about the first eighteen hours far more often than the
    // eighteenth day.
    const noon = at('2026-09-01T12:00:00Z');
    const d = decideBackup({ projectId: ID, plan: 'free', now: noon });
    expect(d.type).toBe('full');
    expect(d.reason).toContain('ever succeeded');
  });
});

describe('Free — nightly full, nothing between', () => {
  const now = at('2026-09-02T04:00:00Z');

  it('takes a full when the last one is a day old', () => {
    expect(decideBackup({
      projectId: ID, plan: 'free', now, window: ALWAYS,
      lastFullAt: daysAgo(now, 1.1), lastAnyAt: daysAgo(now, 1.1),
    }).type).toBe('full');
  });

  it('takes nothing when the last full is hours old', () => {
    const d = decideBackup({
      projectId: ID, plan: 'free', now, window: ALWAYS,
      lastFullAt: daysAgo(now, 0.4), lastAnyAt: daysAgo(now, 0.4),
    });
    expect(d.type).toBeUndefined();
    expect(d.reason).toBe('up to date');
  });

  it('never asks for an incremental — there is no chain by design', () => {
    // At a ≤500 MB cap a full is trivial, and a one-link chain has no middle link
    // that can be the broken thing.
    for (const age of [0.5, 0.9, 0.99]) {
      expect(decideBackup({
        projectId: ID, plan: 'free', now, window: ALWAYS,
        lastFullAt: daysAgo(now, age), lastAnyAt: daysAgo(now, age),
      }).type).toBeUndefined();
    }
  });
});

describe('Pro — weekly full, nightly incremental', () => {
  const now = at('2026-09-02T04:00:00Z');

  it('takes an incremental when the full is fresh but the day has turned', () => {
    const d = decideBackup({
      projectId: ID, plan: 'pro', now, window: ALWAYS,
      lastFullAt: daysAgo(now, 3), lastAnyAt: daysAgo(now, 1.2),
    });
    expect(d.type).toBe('incr');
  });

  it('takes a full once the week is up, not an incremental', () => {
    // The order matters: a project seven days past its full is due both by the
    // incremental rule and the full rule, and taking the incremental would extend
    // the chain instead of resetting it — which is how a restore ends up replaying
    // fourteen links.
    const d = decideBackup({
      projectId: ID, plan: 'pro', now, window: ALWAYS,
      lastFullAt: daysAgo(now, 7.5), lastAnyAt: daysAgo(now, 1.1),
    });
    expect(d.type).toBe('full');
  });

  it('takes nothing when both are fresh', () => {
    expect(decideBackup({
      projectId: ID, plan: 'pro', now, window: ALWAYS,
      lastFullAt: daysAgo(now, 2), lastAnyAt: daysAgo(now, 0.3),
    }).type).toBeUndefined();
  });
});

describe('the maintenance window, and when to ignore it', () => {
  it('does nothing at midday for a project that is merely due', () => {
    const noon = at('2026-09-02T12:00:00Z');
    const d = decideBackup({
      projectId: ID, plan: 'free', now: noon,
      lastFullAt: daysAgo(noon, 1.1), lastAnyAt: daysAgo(noon, 1.1),
    });
    expect(d.type).toBeUndefined();
    expect(d.reason).toContain('window');
  });

  it('ignores the window once a full is over twice its interval late', () => {
    // The window spreads load at night; it is not a reason to keep delaying a
    // backup that is already late. A project two days overdue on a nightly plan
    // has lost a day of its PITR window, and waiting for 03:00 loses more.
    const noon = at('2026-09-02T12:00:00Z');
    const d = decideBackup({
      projectId: ID, plan: 'free', now: noon,
      lastFullAt: daysAgo(noon, 2.5), lastAnyAt: daysAgo(noon, 2.5),
    });
    expect(d.type).toBe('full');
    expect(d.reason).toContain('outside the window');
  });

  it('is the doc\'s 03:00–06:00', () => {
    expect(WINDOW).toEqual({ startHour: 3, endHour: 6 });
  });
});

describe('jitter', () => {
  it('gives a project the same slot every night', () => {
    // Random would re-roll on every sweep, giving a project many chances per night
    // to be "in its slot" — a lottery that fires at a different time each night,
    // which is the opposite of a schedule.
    expect(slotMinuteFor(ID, 180)).toBe(slotMinuteFor(ID, 180));
  });

  it('spreads projects across the window rather than stacking them at 03:00', () => {
    // A node with 150 projects starting at once would read 150 databases
    // simultaneously and share one pipe to the repo.
    const slots = new Set<number>();
    for (let i = 0; i < 60; i++) {
      slots.add(slotMinuteFor(`project-${i}-aaaaaaaaaaaaaaaaaaaa`, 180));
    }
    expect(slots.size).toBeGreaterThan(30);
    for (const s of slots) expect(s).toBeLessThan(180);
  });

  it('treats a slot as a span, so a sweep every few minutes can land in it', () => {
    const windowMinutes = (WINDOW.endHour - WINDOW.startHour) * 60;
    const slot = slotMinuteFor(ID, windowMinutes);
    const hit = (minuteOfWindow: number) => {
      const d = new Date(2026, 8, 2, WINDOW.startHour, 0, 0);
      d.setMinutes(minuteOfWindow);
      return inSlot(ID, d);
    };
    expect(hit(slot)).toBe(true);
    expect(hit(slot + 29)).toBe(true);
    // An instant would be missed on most nights and hit reliably on none.
    expect(hit(slot + 31)).toBe(false);
  });
});
