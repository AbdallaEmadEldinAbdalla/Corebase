'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
 * Focus return is **this component's** job, not the caller's. `useReturnFocus`
 * documents that the capture must happen before focus moves into the layer, which
 * for the command palette means at the opening click because its input carries
 * `autoFocus`. This dialog moves focus itself, in an effect, so it can capture at
 * the top of that same effect — and doing so here means a new call site cannot get
 * it wrong by omission, which is how it was got wrong.
 *
 * Q15 of the review gate asks for the *name* to be typed for a destructive action.
 * That is calibrated for deleting a project — the one act that destroys data
 * irreversibly — so `requireText` is offered and not required. For a reversible
 * action like removing a member, making someone type a colleague's email teaches
 * them to click through the confirmations that do matter.
 *
 * `requireText` also inverts the focus rule, and safely. Ordinarily Cancel takes
 * focus because the destructive button must not sit under the return key; when a
 * name must be typed that button is *disabled* until it matches, so there is
 * nothing to fire by accident and the field is where the user has to go anyway.
 */
export function ConfirmDialog({
  open, title, children, confirmLabel, onConfirm, onCancel, pending, tone = 'danger',
  requireText,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  tone?: 'danger' | 'default';
  /** When set, the exact text the user must type before confirm is enabled. */
  requireText?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const [typed, setTyped] = useState('');
  const { capture, restore } = useReturnFocus();

  /** Reset between openings, or a second delete inherits the first one's text. */
  useEffect(() => { if (!open) setTyped(''); }, [open]);

  const matched = requireText === undefined || typed === requireText;

  /**
   * Capture-then-focus, on the transition into `open` and nothing else.
   *
   * This used to be the caller's job, and the first new caller written after that
   * rule existed forgot it — the settings page opened this dialog, Escape closed
   * it, and focus landed on `<body>`. A rule every call site must remember is a
   * rule that decays at the first call site, so the dialog now does it itself.
   *
   * The dependency list is `[open]` alone, deliberately. `onCancel` is usually a
   * fresh closure each render, and re-running this effect would re-capture with
   * the dialog's *own* control focused — which then unmounts, which is the exact
   * `<body>` bug `useReturnFocus` was written to prevent. The Escape listener,
   * which does need the current `onCancel`, is a separate effect below.
   */
  useEffect(() => {
    if (!open) return;
    capture();
    // Cancel takes focus, not confirm. The safe option is the default one —
    // except when a name must be typed, where confirm is disabled anyway.
    if (requireText !== undefined) field.current?.focus();
    else cancel.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
        {requireText !== undefined ? (
          <div className="sh-field" style={{ marginTop: 'var(--sh-space-16)' }}>
            <label className="sh-label" htmlFor={fieldId}>
              Type <strong>{requireText}</strong> to confirm
            </label>
            <input id={fieldId} ref={field} className="sh-input" type="text"
                   value={typed} autoComplete="off" spellCheck={false}
                   disabled={pending} onChange={(e) => setTyped(e.target.value)} />
          </div>
        ) : null}
        <div className="sh-dialog__footer">
          <button ref={cancel} type="button" className="sh-btn sh-btn--secondary"
                  onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button type="button"
                  className={`sh-btn ${tone === 'danger' ? 'sh-btn--danger' : ''}`}
                  onClick={onConfirm} disabled={pending || !matched}>
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
