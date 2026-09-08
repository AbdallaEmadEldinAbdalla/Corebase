import { describe, it, expect } from 'vitest';
import { onStatus, onResumeSettled, initialResumeState, type ResumeState } from './resume-machine.ts';

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

  it('reports a second pause/resume cycle in the same session', () => {
    const { asks, toasts } = run(
      ['paused', 'resuming', 'ready', 'pausing', 'paused', 'resuming', 'ready']);
    expect(asks).toEqual([0, 4]);
    expect(toasts).toEqual([2, 6]);
  });

  it('never asks for a state that is not paused', () => {
    const { asks } = run(['provisioning', 'failed', 'restoring', 'deleting', 'pausing']);
    expect(asks).toEqual([]);
  });
});

describe('a failed attempt stays retryable; a 409 does not need retrying', () => {
  it('re-arms after a transport error', () => {
    const asked: ResumeState = { asked: true, sawResuming: false };
    expect(onResumeSettled(asked, 'error').asked).toBe(false);
    // and the next poll asks again
    expect(run(['paused'], onResumeSettled(asked, 'error')).asks).toEqual([0]);
  });

  it('stays armed after a 409, which means the control plane already has it', () => {
    const asked: ResumeState = { asked: true, sawResuming: false };
    expect(onResumeSettled(asked, 'conflict').asked).toBe(true);
    expect(run(['paused', 'paused'], onResumeSettled(asked, 'conflict')).asks).toEqual([]);
  });

  it('stays armed after success', () => {
    const asked: ResumeState = { asked: true, sawResuming: false };
    expect(onResumeSettled(asked, 'ok').asked).toBe(true);
  });
});
