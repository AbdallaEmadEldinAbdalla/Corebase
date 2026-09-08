'use client';

import { useEffect, useRef } from 'react';
import { useResumeProject } from '../lib/queries.ts';
import { useToast } from './Toasts.tsx';
import { ApiError } from '../lib/api.ts';
import { onStatus, onResumeSettled, initialResumeState, isDeliberatelyPaused }
  from '../lib/resume-machine.ts';
import { CopyButton } from './Copy.tsx';

/**
 * The paused-project experience (D-008 meets UX, D-131).
 *
 * A free project idle for seven days is paused, and the dashboard's job is to
 * make that feel like a doorbell rather than an outage. Three things follow from
 * that framing, and each is a decision rather than a detail:
 *
 * **Opening the project is the intent to resume**, so there is no confirmation
 * dialog. A modal asking "resume this project?" after the user has already
 * clicked the project is asking them to confirm the thing they just did.
 *
 * **Nothing shows an error while resuming.** Pages render their shells with
 * skeletons; a panel that says "failed to load" during a normal, expected,
 * few-second transition teaches the user their data is at risk when it is not.
 *
 * **A failure is never a dead end** — it carries the code, the sentence, the
 * `request_id` with a copy button (D-032) and a Retry.
 */

/** States where the project cannot answer for data yet. */
export const RESUMING_STATES: ReadonlySet<string> = new Set(['paused', 'resuming']);

export function useAutoResume(ref: string, status: string | undefined, orgId?: string) {
  const resume = useResumeProject(ref, orgId);
  const toast = useToast();
  /**
   * The sequence rules live in `lib/resume-machine.ts` and are tested there
   * against ordered status sequences, which is where the bugs are — firing once
   * per poll instead of once per visit, toasting a resume nobody watched. This
   * hook is deliberately the thin half: it holds the state in a ref, hands each
   * observed status to the machine, and performs whatever the machine says. If
   * the decision moved back in here the test would be guarding a second
   * implementation of it, which is worse than having no test.
   */
  const state = useRef(initialResumeState);

  useEffect(() => {
    const d = onStatus(state.current, status);
    state.current = d.next;
    if (d.ask) {
      resume.mutate(undefined, {
        onSuccess: (r) => {
          state.current = onResumeSettled(
            state.current, r.enqueued ? 'ok' : 'conflict');
        },
        onError: () => { state.current = onResumeSettled(state.current, 'error'); },
      });
    }
    if (d.toastResumed) {
      toast.show({ title: 'Resumed', detail: 'The project is running again.', tone: 'success' });
    }
  }, [status, ref]);   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * `standing` is the paused state nobody asked to leave — the user pressed Pause
   * on the settings page, or another admin did while this page was open. The
   * banner has to word those two situations differently, and before P7d they
   * could not occur, so there was only one wording.
   */
  return Object.assign(resume, { standing: isDeliberatelyPaused(state.current, status) });
}

export function ResumeBanner({ status, plan, error, onRetry, standing, onResume }: {
  status: string | undefined;
  plan?: string | undefined;
  error?: unknown;
  onRetry?: () => void;
  /** Paused with no resume on the way — somebody paused it on purpose. */
  standing?: boolean;
  onResume?: () => void;
}) {
  const api = error instanceof ApiError ? error : null;

  if (api) {
    return (
      <div className="sh-banner sh-banner--error" role="alert">
        <div className="sh-banner__body">
          <div className="sh-banner__title">This project could not be resumed</div>
          <div className="sh-banner__text">{api.message}</div>
          <div className="sh-row sh-row--tight" style={{ marginTop: 'var(--sh-space-12)' }}>
            {onRetry
              ? <button className="sh-btn sh-btn--sm" onClick={onRetry}>Retry</button>
              : null}
            <code className="sh-help">{api.code}</code>
            {api.requestId
              ? <CopyButton value={api.requestId} what="request ID" />
              : null}
          </div>
        </div>
      </div>
    );
  }

  if (!status || !RESUMING_STATES.has(status)) return null;

  /**
   * A pause that is going to stay. The banner must not claim *why* — the control
   * plane records `paused_at` and not a reason, and once a person can press Pause
   * the old wording ("paused after 7 days of inactivity") is simply false for
   * them. So it states the situation, what is safe, and the way out, and it
   * carries the inverse action rather than leaving Resume to a navigation
   * side-effect.
   */
  if (standing) {
    return (
      <div className="sh-banner sh-banner--info" role="status" aria-live="polite">
        <div className="sh-banner__body">
          <div className="sh-banner__title">This project is paused</div>
          <div className="sh-banner__text">
            The database is stopped. Its data, its volume and its keys are kept, and
            the pages below cannot load until it is running again.
            {plan === 'free' ? ' Free projects also pause on their own after seven days idle.' : ''}
          </div>
        </div>
        {onResume ? (
          <button type="button" className="sh-btn sh-btn--sm" onClick={onResume}>
            Resume
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="sh-banner sh-banner--info" role="status" aria-live="polite"
         style={{ marginBottom: 'var(--sh-space-20)' }}>
      <div className="sh-banner__body">
        <div className="sh-banner__title">
          {status === 'paused' ? 'Resuming this project' : 'Resuming…'}
        </div>
        <div className="sh-banner__text">
          Resuming usually takes a few seconds — the pages below fill in as it comes
          back.
          {/* The one place monetization appears in a flow, and it stays quiet:
              paid projects never pause, so this is information, not a pitch. */}
          {plan === 'free' ? ' Paid projects never pause.' : ''}
        </div>
      </div>
    </div>
  );
}
