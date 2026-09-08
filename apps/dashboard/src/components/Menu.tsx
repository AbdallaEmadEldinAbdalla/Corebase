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
export function Menu({ trigger, children, align = 'left', label, matchTriggerWidth }: {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  label: string;
  /**
   * Size the popup to the trigger instead of `.sh-menu`'s fixed 300px.
   *
   * That width is right for the org and account switchers, which carry an avatar,
   * a name and a role — and wrong for a value picker, where a 300px list hanging
   * off a 76px control reads as two unrelated things. A select's list belongs to
   * its control.
   */
  matchTriggerWidth?: boolean;
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
        <div className={`pop__menu${align === 'right' ? ' pop__menu--right' : ''}`
             + (matchTriggerWidth ? ' pop__menu--fit' : '')}
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

/**
 * A select that is ours, not the operating system's.
 *
 * `.sh-select` puts `appearance: none` on a native `<select>` and draws its own
 * caret, so the *closed* control is on-brand — and then the moment it opens the
 * list is OS chrome that CSS cannot reach: system font, system metrics, system
 * highlight colour, in the middle of a warm clay palette. There is no styling fix
 * for that; the popup is not in the page.
 *
 * So this is a button plus `Menu`, which already owns the behaviour the review
 * gate asks for — Escape closes the topmost layer and returns focus to what opened
 * it, the first item is focused on open, arrows move, Tab leaves.
 *
 * **The honest trade-off:** a menu is not a listbox. ARIA would prefer
 * `role="listbox"` with `role="option"` children for a value picker, and this
 * reuses `role="menuitem"`. Taking the correct role would mean a second popup
 * implementation with its own focus handling, and a second implementation of focus
 * management is how the first one stops being the tested one. Reusing the
 * primitive that already behaves correctly is the better trade, and it is written
 * down here rather than left for someone to discover.
 */
export function Select<T extends string>({ value, options, onChange, label, disabled, id }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** Accessible name — a role picker in a table needs to say *whose* role. */
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  const current = options.find((o) => o.value === value);
  /**
   * Width comes from the *longest* option, not the selected one.
   *
   * A button sizes to its content, so without this the control shrinks and grows
   * as the value changes — and in a table that means the whole column jiggles when
   * someone picks a different role. A native `<select>` reserves the widest
   * option's width for exactly this reason; this is that behaviour, kept.
   */
  const widest = Math.max(...options.map((o) => o.label.length), 4);
  return (
    <Menu label={label} matchTriggerWidth
      trigger={({ open, toggle, ref }) => (
        <button ref={ref} type="button" className="sh-select" id={id}
          aria-haspopup="menu" aria-expanded={open} aria-label={label}
          disabled={disabled} onClick={toggle}
          style={{
            textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer',
            // `.sh-input,.sh-select,.sh-textarea` sets `width:100%`, which is right
            // for a field filling its wrapper and wrong for a value picker: in a
            // table cell it stretched the control across the whole column. A
            // select is as wide as its widest option and no wider.
            width: 'max-content',
            // the caret's 36px of padding-right, plus the widest label
            minWidth: `calc(${widest}ch + 52px)`,
          }}>
          {current?.label ?? value}
        </button>
      )}>
      {(close) => (
        <>
          {options.map((o) => (
            <MenuItem key={o.value} active={o.value === value}
              onSelect={() => { onChange(o.value); close(); }}>
              <span>{o.label}</span>
              {o.value === value
                ? <span className="sh-menu__check" aria-hidden="true">✓</span>
                : null}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}
