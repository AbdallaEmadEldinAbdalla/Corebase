'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

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
  }), [show]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div className="cb-toast" key={t.id} role="status">
            <span className={`cb-toast__icon cb-toast__icon--${t.tone}`} aria-hidden="true">
              <svg viewBox="0 0 12 12">
                {t.tone === 'success'
                  ? <path d="M2.5 6.5 5 9l4.5-6" />
                  : <path d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5" />}
              </svg>
            </span>
            <div className="cb-toast__body">
              <div className="cb-toast__title">{t.title}</div>
              {t.detail ? <div className="cb-toast__text">{t.detail}</div> : null}
            </div>
            {t.action ? (
              <button type="button" className="cb-toast__action" onClick={t.action.run}>
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
