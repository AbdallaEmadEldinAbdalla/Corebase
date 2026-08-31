'use client';

import type { ReactNode } from 'react';
import { copyText } from '../lib/copy.ts';
import { useToast } from './Toasts.tsx';

/**
 * A copy button that reports through the toast layer rather than by mutating its
 * own label.
 *
 * The label-swap version ("Copy" → "Copied") was the first draft, and it is worse
 * for the case that matters: the user's eyes are on the field they are about to
 * paste into, not on the button they just pressed. A toast is visible wherever
 * they are looking, and it is announced.
 */
export function CopyButton({ value, what, size = 'sm', variant = 'secondary' }: {
  value: string;
  /** Named in the toast: "Connection string copied". */
  what: string;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost';
}) {
  const toast = useToast();
  return (
    <button type="button"
            className={`cb-btn cb-btn--${variant}${size === 'sm' ? ' cb-btn--sm' : ''}`}
            onClick={async () => {
              const ok = await copyText(value);
              if (ok) toast.copied(what);
              else toast.show({ tone: 'error', title: `Could not copy ${what.toLowerCase()}`,
                                detail: 'Select the text and copy it manually.' });
            }}
            aria-label={`Copy ${what.toLowerCase()}`}>
      Copy
    </button>
  );
}

/** A value that exists to be copied: mono, selectable, with the button beside it. */
export function CopyField({ value, what, children }: {
  value: string;
  what: string;
  children?: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--cb-space-3)' }}>
      <code style={{ flex: 1, minWidth: 0, font: 'var(--cb-code)', overflowWrap: 'anywhere' }}>
        {children ?? value}
      </code>
      <CopyButton value={value} what={what} />
    </div>
  );
}
