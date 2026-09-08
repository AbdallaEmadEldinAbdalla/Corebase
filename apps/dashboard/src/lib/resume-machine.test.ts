import { describe, it, expect } from 'vitest';
import { onStatus, onResumeSettled, initialResumeState, isDeliberatelyPaused,
  type ResumeState } from './resume-machine.ts';

/** Feed a sequence of polled statuses; collect what the machine decided. */
function run(statuses: (string | undefined)[], start: ResumeState = initialResumeState) {
  let state = start;
  const asks: number[] = [];
  const toasts: number[] = [];
  statuses.forEach((s, i) => {
    const d = onStatus(state, s);
    if (d.ask) asks.push(i);
    if (d.toastResumed) toasts.push(i);
    state = d.next;
  });
  return { asks, toasts, state };
}

describe('auto-resume decides from the sequence, not the current value (D-131)', () => {
  it('asks once even though the status is polled every second while paused', () => {
    // The bug this exists to prevent: eight polls, eight resume requests.
    const { asks } = run(Array<string>(8).fill('paused'));
    expect(asks).toEqual([0]);
  });

  it('asks on open and then follows the project through to ready', () => {
    const { asks, toasts } = run(['paused', 'resuming', 'resuming', 'ready']);
    expect(asks).toEqual([0]);
    expect(toasts).toEqual([3]);
  });

  it('does not toast for a project that was already running', () => {
    // Opening a healthy project must be silent — a "Resumed" toast for a project
    // that never paused is a notification about nothing.
    const { asks, toasts } = run(['ready', 'ready']);
    expect(asks).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it('does not toast when it never saw the resume', () => {
    // Someone else resumed it, or it was resuming before this page mounted and
    // the first status this client saw was `ready`.
    const { toasts } = run(['ready']);
    expect(toasts).toEqual([]);
  });

  it('toasts a resume it joined midway', () => {
    // Deep-linked into a project that was already resuming: not this client's
    // request, but it did watch it finish, so the outcome is worth reporting.
    const { asks, toasts } = run(['resuming', 'ready']);
    expect(asks).toEqual([]);
    expect(toasts).toEqual([0 + 1]);
  });

  /**
   * **This expectation changed in P7d, deliberately.** It used to assert
   * `asks == [0, 4]` — that a project pausing a second time mid-visit would be
   * auto-resumed a second time. That was reasonable when the only thing that
   * could pause a project was the seven-day idle sweeper, which cannot fire
   * while a page is open polling it. Once a person can pause from the settings
   * page, the second pause has an author: either this user, or another admin
   * doing it while this page is open. Resuming it either way is fighting
   * somebody. The toast behaviour is unchanged — a resume that *is* watched is
   * still reported.
   */
  it('reports a second pause/resume cycle, but does not start the second resume', () => {
    const { asks, toasts } = run(
      ['paused', 'resuming', 'ready', 'pausing', 'paused', 'resuming', 'ready']);
    expect(asks).toEqual([0]);
    expect(toasts).toEqual([2, 6]);
  });

  it('never asks for a state that is not paused', () => {
    const { asks } = run(['provisioning', 'failed', 'restoring', 'deleting', 'pausing']);
    expect(asks).toEqual([]);
  });
});

describe('a failed attempt stays retryable; a 409 does not need retrying', () => {
  it('re-arms after a transport error', () => {
    const asked: ResumeState = { asked: true, sawResuming: false, sawReady: false };
    expect(onResumeSettled(asked, 'error').asked).toBe(false);
    // and the next poll asks again
    expect(run(['paused'], onResumeSettled(asked, 'error')).asks).toEqual([0]);
  });

  it('stays armed after a 409, which means the control plane already has it', () => {
    const asked: ResumeState = { asked: true, sawResuming: false, sawReady: false };
    expect(onResumeSettled(asked, 'conflict').asked).toBe(true);
    expect(run(['paused', 'paused'], onResumeSettled(asked, 'conflict')).asks).toEqual([]);
  });

  it('stays armed after success', () => {
    const asked: ResumeState = { asked: true, sawResuming: false, sawReady: false };
    expect(onResumeSettled(asked, 'ok').asked).toBe(true);
  });
});

describe('a pause the user performed is not undone (P7d)', () => {
  /**
   * The observed defect: the settings page's Pause button worked, and 41 seconds
   * later auto-resume started the project again. Nothing in the UI said so — the
   * job history was the only evidence.
   */
  it('does not resume a project that was ready when the visit started', () => {
    const { asks } = run(['ready', 'ready', 'pausing', 'paused', 'paused', 'paused']);
    expect(asks).toEqual([]);
  });

  it('still resumes a project that was already paused on arrival', () => {
    const { asks } = run(['paused', 'paused']);
    expect(asks).toEqual([0]);
  });

  it('resumes on arrival even when the project is mid-pause, which the user did not do', () => {
    const { asks } = run(['pausing', 'paused']);
    expect(asks).toEqual([1]);
  });

  it('having been ready once in a visit is enough — a resume then pause is still ours', () => {
    // Arrive paused, auto-resume, reach ready, then pause by hand: no second ask.
    const { asks, toasts } = run(['paused', 'resuming', 'ready', 'pausing', 'paused', 'paused']);
    expect(asks).toEqual([0]);
    expect(toasts).toEqual([2]);
  });

  it('a reload after pausing is a fresh arrival, so it resumes again', () => {
    // A new visit starts from initialResumeState — the user navigated to a
    // paused project, which D-131 reads as wanting it back.
    const { asks } = run(['paused']);
    expect(asks).toEqual([0]);
  });

  describe('isDeliberatelyPaused', () => {
    it('is true for a pause with no resume asked, and false while resuming', () => {
      const own = run(['ready', 'pausing', 'paused']).state;
      expect(isDeliberatelyPaused(own, 'paused')).toBe(true);

      const arrived = run(['paused']).state;
      expect(isDeliberatelyPaused(arrived, 'paused')).toBe(false);
    });

    it('is false for any status that is not paused', () => {
      const st = run(['ready']).state;
      for (const s of ['ready', 'resuming', 'pausing', undefined]) {
        expect(isDeliberatelyPaused(st, s)).toBe(false);
      }
    });
  });
});
