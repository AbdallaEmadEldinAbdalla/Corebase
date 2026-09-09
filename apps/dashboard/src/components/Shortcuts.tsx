'use client';

import { useEffect, useRef } from 'react';
import { useMetaLabel } from '../lib/hotkeys.ts';

/**
 * The shortcut sheet, on `?`.
 *
 * It exists because §2 requires it: a shortcut nobody can discover is a shortcut
 * for the author only. Listing them is also the cheapest honesty check on the
 * keyboard layer — anything in this dialog that does not work is immediately
 * obvious, which is not true of an undocumented binding.
 */
const groups = (meta: string): { title: string; keys: [string, string][] }[] => [
  { title: 'Anywhere', keys: [
    [meta, 'Command palette'],
    ['?', 'This list'],
    ['[', 'Collapse or expand the sidebar'],
    ['Esc', 'Close the topmost layer'],
  ] },
  { title: 'Go to', keys: [
    ['g p', 'Projects'],
    ['g m', 'Members'],
    ['g o', 'Project overview'],
    ['g t', 'Table editor'],
    ['g c', 'Connect'],
    ['g k', 'API keys'],
    ['g u', 'Usage'],
    ['g s', 'Settings — the project’s, or the org’s outside one'],
    ['g a', 'Your account and access tokens'],
  ] },
  { title: 'Lists and menus', keys: [
    ['↑ ↓', 'Move'],
    ['↵', 'Open or run'],
    ['Tab', 'Leave a menu'],
  ] },
];

export function Shortcuts({ open, onClose }: { open: boolean; onClose: () => void }) {
  const meta = useMetaLabel();
  const GROUPS = groups(meta);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="layer layer--center"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sh-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
           tabIndex={-1} ref={dialog} style={{ width: 460 }}>
        <div className="sh-dialog__title">Keyboard shortcuts</div>
        <div className="sh-dialog__text">
          Everything here also lives in the command palette.
        </div>
        {GROUPS.map((g) => (
          <div key={g.title} style={{ marginBottom: 'var(--sh-space-16)' }}>
            <div className="palette__group" style={{ padding: '0 0 6px' }}>{g.title}</div>
            {g.keys.map(([k, what]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, height: 30 }}>
                <span style={{ width: 78, flex: 'none' }}>
                  {k.split(' ').map((part) => <span className="kbd" key={part} style={{ marginRight: 4 }}>{part}</span>)}
                </span>
                <span style={{ font: 'var(--sh-body-s)', color: 'var(--sh-text-secondary)' }}>{what}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="sh-dialog__footer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="sh-btn sh-btn--secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
