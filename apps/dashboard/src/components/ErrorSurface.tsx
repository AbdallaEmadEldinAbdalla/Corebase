'use client';

import { useState } from 'react';
import { ApiError } from '../lib/api.ts';

/**
 * Every error the user sees, in one component.
 *
 * The design system makes this binding rather than stylistic: an error surface
 * shows the platform error *code*, a human sentence, and the `request_id` with a
 * copy button (D-032, design system §5 rule 3). One component so that no page
 * can accidentally render `String(error)` and drop the id — which is the only
 * thing support can actually use.
 */
export function ErrorSurface({ error, onRetry, title }: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const api = error instanceof ApiError ? error : null;
  const message = api?.message
    ?? (error instanceof Error ? error.message : 'Something went wrong.');

  const copy = async () => {
    if (!api?.requestId) return;
    try {
      await navigator.clipboard.writeText(api.requestId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied; the id is on screen either way */ }
  };

  return (
    <div className="sh-banner sh-banner--error" role="alert">
      <span className="sh-banner__icon" aria-hidden="true">
        <svg viewBox="0 0 12 12"><path d="M2 2 10 10M10 2 2 10" /></svg>
      </span>
      <div className="sh-banner__body">
        <div className="sh-banner__title">{title ?? api?.code ?? 'Error'}</div>
        <div className="sh-banner__text">{message}</div>
        {api?.requestId ? (
          <div className="reqid" style={{ marginTop: 'var(--sh-space-8)' }}>
            <span>{api.requestId}</span>
            <button type="button" className="sh-btn sh-btn--ghost sh-btn--sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : null}
      </div>
      {onRetry ? (
        <button type="button" className="sh-banner__action" onClick={onRetry}>Retry</button>
      ) : null}
    </div>
  );
}

/** Inline field error. Replaces help text, never stacks with it (§5 rule 3). */
export function FieldError({ children }: { children: React.ReactNode }) {
  return <span className="sh-help sh-help--error">{children}</span>;
}
