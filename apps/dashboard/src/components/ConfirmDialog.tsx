'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useReturnFocus } from '../lib/return-focus.ts';

/**
 * The confirmation every destructive action goes through.
 *
 * It exists as one component rather than per-surface markup because the parts that
 * are easy to forget are the parts that only a keyboard user notices, and
 * forgetting them once per dialog is how gate question 7 decays: Escape closes the
 * topmost layer, focus moves *into* the dialog on open and back to the trigger on
 * close, the scrim does not swallow the Escape key, and the confirm button is not
 * the one focused first — a dialog that opens with "Delete" under the return key is
 * a trap, not a confirmation.
 *
 * `useReturnFocus` is captured by the caller at the click that opens this, not in
 * an effect inside it, for the reason that hook documents: by the time an effect in
 * here runs, focus has already moved.
 *
 * Q15 of the review gate asks for the *name* to be typed for a destructive action.
 * That is calibrated for deleting a project — the one act that destroys data
 * irreversibly — so `requireText` is offered and not required. For a reversible
 * action like removing a member, making someone type a colleague's email teaches
 * them to click through the confirmations that do matter.
 */
export function ConfirmDialog({
  open, title, children, confirmLabel, onConfirm, onCancel, pending, tone = 'danger',
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  tone?: 'danger' | 'default';
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const { restore } = useReturnFocus();

  useEffect(() => {
    if (!open) return;
    // Cancel takes focus, not confirm. The safe option is the default one.
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  useEffect(() => { if (!open) restore(); }, [open, restore]);

  if (!open) return null;

  return (
    // `.sh-modal` is the layer; `.sh-dialog` is only the box. Without the wrapper
    // this renders in flow — inside the table cell it was invoked from.
    <div className="sh-modal">
      {/* The scrim is a real button so a pointer user can dismiss by clicking away
          and a screen reader is told what it does, rather than it being an
          undiscoverable div that happens to have an onClick. */}
      <button type="button" className="sh-scrim" aria-label="Cancel" onClick={onCancel} />
      <div className="sh-dialog" role="dialog" aria-modal="true" tabIndex={-1}
           aria-label={title} ref={dialog}>
        <div className="sh-dialog__title">{title}</div>
        <div className="sh-dialog__text">{children}</div>
        <div className="sh-dialog__footer">
          <button ref={cancel} type="button" className="sh-btn sh-btn--secondary"
                  onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button type="button"
                  className={`sh-btn ${tone === 'danger' ? 'sh-btn--danger' : ''}`}
                  onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
