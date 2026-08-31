'use client';

import { useEffect, useState } from 'react';

/**
 * Light and dark are peers, not a preference with a default (D-178), so the
 * toggle has three positions and "System" is one of them — removing the
 * attribute rather than guessing which of the two the OS meant.
 */
type Choice = 'light' | 'dark' | 'system';

export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>('system');

  useEffect(() => {
    const stored = (() => {
      try { return localStorage.getItem('cb-theme'); } catch { return null; }
    })();
    setChoice(stored === 'dark' || stored === 'light' ? stored : 'system');
  }, []);

  const apply = (next: Choice) => {
    setChoice(next);
    const root = document.documentElement;
    try {
      if (next === 'system') { localStorage.removeItem('cb-theme'); root.removeAttribute('data-theme'); }
      else { localStorage.setItem('cb-theme', next); root.setAttribute('data-theme', next); }
    } catch { /* private mode: the class still applies for this page */ }
  };

  const next: Choice = choice === 'light' ? 'dark' : choice === 'dark' ? 'system' : 'light';
  const label = choice === 'system' ? 'System' : choice === 'dark' ? 'Dark' : 'Light';

  return (
    <button type="button" className="cb-btn cb-btn--ghost cb-btn--sm"
            onClick={() => apply(next)}
            aria-label={`Theme: ${label}. Switch to ${next}.`}>
      {label}
    </button>
  );
}
