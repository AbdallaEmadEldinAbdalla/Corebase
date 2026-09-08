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
 *  - a project the user paused **during this visit** must not be resumed, or the
 *    pause button on the settings page silently undoes itself;
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
  /**
   * The project has been seen `ready` during this visit — so if it is paused
   * *now*, it was paused while the user was watching, which means they did it.
   */
  sawReady: boolean;
}

export const initialResumeState: ResumeState =
  { asked: false, sawResuming: false, sawReady: false };

export interface ResumeDecision {
  next: ResumeState;
  /** Post the resume now. */
  ask: boolean;
  /** Show the "Resumed" toast now. */
  toastResumed: boolean;
}

export function onStatus(state: ResumeState, status: string | undefined): ResumeDecision {
  const sawResuming = state.sawResuming || status === 'resuming';
  const sawReady = state.sawReady || status === 'ready';

  /**
   * D-131 is about *arriving* at a paused project: navigating to one is the
   * intent to resume it. It is not about a project that becomes paused while the
   * page is open — the only way that happens is that this user paused it, from
   * the settings page, seconds ago.
   *
   * Without `sawReady` the two are indistinguishable, and the observed result was
   * a project pausing at 11:34:15 and resuming at 11:34:56 with nobody asking:
   * the settings page's one new action undoing itself, and the job history the
   * only place it was visible.
   */
  if (status === 'paused' && !state.asked && !state.sawReady) {
    return { next: { asked: true, sawResuming, sawReady }, ask: true, toastResumed: false };
  }
  if (status === 'ready' && state.sawResuming) {
    // Cleared, so a project that pauses and resumes twice in one session toasts
    // twice rather than never again. `sawReady` is *not* cleared: within one
    // visit, having been ready once is enough to know a later pause was ours.
    return {
      next: { asked: false, sawResuming: false, sawReady: true },
      ask: false, toastResumed: true,
    };
  }
  return { next: { ...state, sawResuming, sawReady }, ask: false, toastResumed: false };
}

/**
 * Is this project paused with no resume on the way?
 *
 * The banner needs to tell "resuming, wait a moment" apart from "you paused this,
 * it will stay paused" — before manual pause existed those were the same state.
 */
export function isDeliberatelyPaused(state: ResumeState, status: string | undefined): boolean {
  return status === 'paused' && !state.asked;
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
