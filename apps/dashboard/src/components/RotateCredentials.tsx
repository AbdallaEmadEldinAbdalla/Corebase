'use client';

import { useEffect, useRef, useState } from 'react';
import { useRotateCredentials } from '../lib/queries.ts';
import { useToast } from './Toasts.tsx';
import { ErrorSurface } from './ErrorSurface.tsx';

/**
 * Rotating a project's database credentials, from the page that shows them.
 *
 * The credentials doc is explicit that this is a first-class screen and gives the
 * reason: "a credential you're scared to rotate is a credential you'll leak and
 * keep." So the job of this dialog is not to add friction — it is to remove the
 * fear, by saying exactly what will happen before it happens.
 *
 * Two things it does *not* do. It does not type-to-confirm: rotation destroys no
 * data and the recovery is to read the new string off this page, so the ceremony
 * reserved for project deletion (design system §5 rule 4) would be
 * disproportionate and would teach people to avoid it. And `terminate` is a
 * checkbox rather than a second button, unchecked, labelled with its consequence —
 * because it is the option that *does* break a running application, and the
 * default has to be the safe one.
 */
export function RotateCredentials({ projectRef }: { projectRef: string }) {
  const [open, setOpen] = useState(false);
  const [terminate, setTerminate] = useState(false);
  const rotate = useRotateCredentials(projectRef);
  const toast = useToast();
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const run = async () => {
    try {
      const res = await rotate.mutateAsync(terminate);
      setOpen(false);
      trigger.current?.focus();
      // The effect sentence comes from the API rather than being written twice —
      // it is the same fact, and two copies drift.
      toast.show({ tone: 'success', title: 'Credentials rotated', detail: res.effect });
      setTerminate(false);
    } catch { /* rendered in the dialog */ }
  };

  return (
    <>
      <button ref={trigger} type="button" className="sh-btn sh-btn--secondary sh-btn--sm"
              onClick={() => setOpen(true)}>
        Rotate credentials
      </button>

      {open ? (
        <div className="layer layer--center"
             onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="sh-dialog" role="dialog" aria-modal="true" tabIndex={-1}
               ref={dialog} aria-label="Rotate credentials" style={{ width: 460 }}>
            <div className="sh-dialog__title">Rotate database credentials?</div>
            <div className="sh-dialog__text">
              A new password is generated and applied. <strong>Applications already
              connected keep working</strong> — Postgres only checks the password when a
              connection is opened. Anything that opens a <em>new</em> connection needs
              the new string, so update your environment variables after this.
            </div>

            {rotate.error ? (
              <div style={{ marginBottom: 'var(--sh-space-16)' }}>
                <ErrorSurface error={rotate.error} />
              </div>
            ) : null}

            {/* `sh-switch`, not `sh-check`. The check keeps the operating system's
                box and only tints it with `accent-color`, so it is the one control
                on the page still drawn by the OS. The switch hides the input and
                draws the track itself — same input underneath, so it stays a real
                checkbox for a screen reader and for the keyboard, and the pixels
                are ours. */}
            <label className="sh-switch" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={terminate}
                     onChange={(e) => setTerminate(e.target.checked)} />
              <span className="sh-switch__track" aria-hidden="true" />
              <span style={{ font: 'var(--sh-body-s)' }}>
                <strong>Also disconnect everything now.</strong>
                <br />
                <span className="muted">
                  For a leaked password: rotating alone does not remove someone who
                  already has a connection open. This will break your running
                  application until it reconnects.
                </span>
              </span>
            </label>

            <div className="sh-dialog__footer"
                 style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sh-space-8)' }}>
              <button type="button" className="sh-btn sh-btn--secondary"
                      onClick={() => { setOpen(false); trigger.current?.focus(); }}>
                Cancel
              </button>
              <button type="button"
                      className={`sh-btn${terminate ? ' sh-btn--danger' : ''}`}
                      disabled={rotate.isPending} onClick={() => void run()}>
                {rotate.isPending ? 'Rotating…'
                  : terminate ? 'Rotate and disconnect' : 'Rotate'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
