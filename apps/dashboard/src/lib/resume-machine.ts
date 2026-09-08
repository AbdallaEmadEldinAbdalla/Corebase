/**
 * What to do about a project's status, as a pure decision.
 *
 * The auto-resume rules (D-131) are three lines of prose and four ways to get
 * wrong, and every one of them is a *sequence* bug rather than a rendering bug:
 *
 *  - fire the resume **once per visit**, not once per poll — `useProject` polls
 *    every second while a project settles, so a naive `status === 'paused'`
 *    effect posts a resume every second until the state moves;
 *  - say "Resumed" only for a resume actually **observed**, so opening a healthy
 *    project does not toast;
 *  - a transport failure must leave the resume **retryable**, while a 409 must
 *    not, because 409 means the control plane already has it in hand;
 *  - and none of it may depend on which component happened to mount.
 *
 * Extracted from the hook so it is testable without a DOM. The dashboard has no
 * DOM test tooling and this does not need any: the rules are about an ordered
 * sequence of statuses, so the test feeds sequences. Testing this through React
 * would be testing React.
 */
export interface ResumeState {
  /** A resume has been asked for during this visit. */
  asked: boolean;
  /** `resuming` has been seen, so a later `ready` is a resume we watched. */
  sawResuming: boolean;
}

export const initialResumeState: ResumeState = { asked: false, sawResuming: false };

export interface ResumeDecision {
  next: ResumeState;
  /** Post the resume now. */
  ask: boolean;
  /** Show the "Resumed" toast now. */
  toastResumed: boolean;
}

export function onStatus(state: ResumeState, status: string | undefined): ResumeDecision {
  const sawResuming = state.sawResuming || status === 'resuming';

  if (status === 'paused' && !state.asked) {
    return { next: { asked: true, sawResuming }, ask: true, toastResumed: false };
  }
  if (status === 'ready' && state.sawResuming) {
    // Cleared, so a project that pauses and resumes twice in one session toasts
    // twice rather than never again.
    return { next: { asked: false, sawResuming: false }, ask: false, toastResumed: true };
  }
  return { next: { ...state, sawResuming }, ask: false, toastResumed: false };
}

/**
 * A resume attempt came back. A 409 is the control plane saying it already has
 * this in hand, so the ask stands; anything else never reached it, so it does not.
 */
export function onResumeSettled(
  state: ResumeState, outcome: 'ok' | 'conflict' | 'error',
): ResumeState {
  return outcome === 'error' ? { ...state, asked: false } : state;
}
