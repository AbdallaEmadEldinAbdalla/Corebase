'use client';

import { useEffect, useRef } from 'react';
import { useResumeProject } from '../lib/queries.ts';
import { useToast } from './Toasts.tsx';
import { ApiError } from '../lib/api.ts';
import { onStatus, onResumeSettled, initialResumeState } from '../lib/resume-machine.ts';
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

  return resume;
}

export function ResumeBanner({ status, plan, error, onRetry }: {
  status: string | undefined;
  plan?: string | undefined;
  error?: unknown;
  onRetry?: () => void;
}) {
  const api = error instanceof ApiError ? error : null;

  if (api) {
    return (
      <div className="sh-banner sh-banner--error" role="alert"
           style={{ marginBottom: 'var(--sh-space-20)' }}>
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

  return (
    <div className="sh-banner sh-banner--info" role="status" aria-live="polite"
         style={{ marginBottom: 'var(--sh-space-20)' }}>
      <div className="sh-banner__body">
        <div className="sh-banner__title">
          {status === 'paused' ? 'Resuming this project' : 'Resuming…'}
        </div>
        <div className="sh-banner__text">
          This project was paused after 7 days of inactivity. Resuming usually takes
          a few seconds — the pages below fill in as it comes back.
          {/* The one place monetization appears in a flow, and it stays quiet:
              paid projects never pause, so this is information, not a pitch. */}
          {plan === 'free' ? ' Paid projects never pause.' : ''}
        </div>
      </div>
    </div>
  );
}
