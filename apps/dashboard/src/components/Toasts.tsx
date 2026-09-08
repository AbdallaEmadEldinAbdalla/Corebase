'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api.ts';
import { copyText } from '../lib/copy.ts';

/**
 * Toasts, because the UX standard §5 requires every mutation to answer for itself.
 *
 * The rule that shapes this API: a toast **names what happened** and, where an
 * inverse exists, offers it. So `action` is part of the call, not an afterthought —
 * "Project deleted · Undo" costs a careful user nothing and saves a careless one,
 * and it is worth more than a confirmation dialog they have learned to click
 * through.
 *
 * `aria-live="polite"` and not `assertive`: a copy confirmation should not
 * interrupt a screen reader mid-sentence. Errors that need immediate attention are
 * banners on the surface itself, which is where a user can act on them.
 */
export interface Toast {
  id: number;
  title: string;
  detail?: string;
  tone: 'success' | 'error';
  action?: { label: string; run: () => void };
}

const Ctx = createContext<{
  show: (t: Omit<Toast, 'id'>) => void;
  /** The common case, so it does not get written out eleven times. */
  copied: (what: string) => void;
  /**
   * A failed request, with everything §8 question 17 asks for.
   *
   * It was missing, so every caller wrote `detail: err.message` — a sentence with
   * no `code` and no `request_id`, leaving a user nothing to quote and support
   * nothing to search. `ErrorSurface` gets this right for banners; the toast path
   * had no equivalent, which is how one rule ends up honoured on one surface and
   * quietly dropped on the other.
   */
  apiError: (title: string, err: unknown) => void;
} | null>(null);

/** Long enough to read a sentence, short enough not to sit in the way. */
const DWELL_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);

  const show = useCallback((t: Omit<Toast, 'id'>) => {
    const id = next.current++;
    setItems((prev) => [...prev, { ...t, id }]);
    window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), DWELL_MS);
  }, []);

  const value = useMemo(() => ({
    show,
    copied: (what: string) => show({ title: `${what} copied`, tone: 'success' }),
    /** D-032: code, sentence, request_id, and a way to copy it. */
    apiError: (title: string, err: unknown) => {
      const api = err instanceof ApiError ? err : null;
      const detail = api
        ? [api.code, api.message, api.requestId].filter(Boolean).join(' · ')
        : (err instanceof Error ? err.message : 'Something went wrong.');
      const rid = api?.requestId;
      show({
        tone: 'error', title, detail,
        ...(rid ? { action: { label: 'Copy ID', run: () => { void copyText(rid); } } } : {}),
      });
    },
  }), [show]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div className="sh-toast" key={t.id} role="status">
            <span className={`sh-toast__icon sh-toast__icon--${t.tone}`} aria-hidden="true">
              <svg viewBox="0 0 12 12">
                {t.tone === 'success'
                  ? <path d="M2.5 6.5 5 9l4.5-6" />
                  : <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" />}
              </svg>
            </span>
            <div className="sh-toast__body">
              <div className="sh-toast__title">{t.title}</div>
              {t.detail ? <div className="sh-toast__text">{t.detail}</div> : null}
            </div>
            {t.action ? (
              <button type="button" className="sh-toast__action" onClick={t.action.run}>
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
