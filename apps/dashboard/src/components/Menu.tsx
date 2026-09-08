'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * One popover menu, used by the breadcrumb switchers and the table row actions.
 *
 * It is one component because the keyboard contract is the part that gets
 * forgotten, and forgetting it once per menu is how a dashboard ends up
 * pointer-only. This handles all of §2's requirements in a single place:
 * `Escape` closes **and returns focus to the trigger** (focus landing on `<body>`
 * silently ejects a keyboard user to the top of the page), arrow keys move through
 * the items, Home/End jump, and a click outside dismisses.
 */
export function Menu({ trigger, children, align = 'left', label }: {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) btn.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    // First item focused on open, so a keyboard user is already inside the menu
    // rather than having to press Down to enter it.
    const items = () => Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    items()[0]?.focus();

    const onKey = (e: KeyboardEvent) => {
      const all = items();
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); all[(at + 1) % all.length]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); all[(at - 1 + all.length) % all.length]?.focus(); }
      if (e.key === 'Home') { e.preventDefault(); all[0]?.focus(); }
      if (e.key === 'End') { e.preventDefault(); all[all.length - 1]?.focus(); }
      if (e.key === 'Tab') close(false);   // tabbing away is leaving, not cancelling
    };
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="pop" ref={wrap}>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: btn })}
      {open ? (
        <div className={`pop__menu${align === 'right' ? ' pop__menu--right' : ''}`}
             ref={list} id={id}>
          <div className="sh-menu" role="menu" aria-label={label}>
            {children(() => close())}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A menu row. `role="menuitem"` and a real button, so Menu's key handling finds it. */
export function MenuItem({ children, onSelect, active, tone }: {
  children: ReactNode;
  onSelect: () => void;
  active?: boolean;
  tone?: 'danger';
}) {
  return (
    <button type="button" role="menuitem"
            className={`sh-menu__item${active ? ' is-active' : ''}`}
            style={tone === 'danger' ? { color: 'var(--sh-danger)' } : undefined}
            onClick={onSelect}>
      {children}
    </button>
  );
}
