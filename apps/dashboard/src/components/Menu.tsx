'use client';

import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * One popover menu, used by the breadcrumb switchers and the table row actions.
 *
 * It is one component because the keyboard contract is the part that gets
 * forgotten, and forgetting it once per menu is how a dashboard ends up
 * pointer-only. This handles all of §2's requirements in a single place:
 * `Escape` closes **and returns focus to the trigger** (focus landing on `<body>`
 * silently ejects a keyboard user to the top of the page), arrow keys move through
 * the items, Home/End jump, and a click outside dismisses.
 *
 * ## Why the list is a portal
 *
 * It used to be `position: absolute` inside a `position: relative` wrapper,
 * which is the textbook popover and works only while no ancestor has
 * `overflow`. The workspace redesign gave every surface one: `.deckbar` scrolls
 * horizontally, `.deckgrid` scrolls both ways, `.deckfoot` scrolls too. An
 * absolutely-positioned child is clipped by the nearest scrolling ancestor, so
 * **every menu in the product broke at once** — a 300px row-action list inside a
 * 130px cell, the role switcher cut off by its own toolbar. One symptom per
 * surface, one cause.
 *
 * So the list renders into `document.body` at `position: fixed`, placed from the
 * trigger's own rect. That is immune to any ancestor's overflow by construction
 * rather than by luck, and it is why this is a component and not a CSS class:
 * the position has to be measured, and measuring it in one place is the whole
 * argument for having one menu.
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
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) btn.current?.focus();
  };

  /**
   * Where the list goes, in viewport coordinates.
   *
   * Measured from the trigger rather than inherited from a positioned ancestor.
   * `align === 'right'` lines the list's right edge up with the trigger's, which
   * is what a right-aligned row action wants; the horizontal clamp then keeps it
   * on screen, because a menu on the last column of a wide table would otherwise
   * hang off the edge — the same failure as being clipped, one step later.
   *
   * Flipping above the trigger when there is no room below is the other half. A
   * row action near the bottom of a full-height grid has 20px under it, and a
   * list that renders there is a list nobody can read.
   */
  const place = useCallback(() => {
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const listEl = list.current;
    const w = listEl?.offsetWidth ?? (matchTriggerWidth ? b.width : 300);
    const h = listEl?.offsetHeight ?? 0;
    const gap = 4;
    const room = window.innerHeight - b.bottom;
    const above = h > 0 && room < h + gap && b.top > room;
    const left = align === 'right' ? b.right - w : b.left;
    setAt({
      top: above ? Math.max(gap, b.top - h - gap) : b.bottom + gap,
      // 8px of breathing room at either edge, so a clamped menu does not sit
      // flush against the window.
      left: Math.min(Math.max(8, left), Math.max(8, window.innerWidth - w - 8)),
      width: b.width,
    });
  }, [align, matchTriggerWidth]);

  /**
   * Placed before paint, then again once the list has a measured height.
   *
   * The first pass has no element to measure, so `h` is 0 and the menu opens
   * below; the second pass knows its height and can decide to flip. Doing it in
   * a layout effect rather than an effect is what keeps that correction from
   * being a visible jump.
   */
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useLayoutEffect(() => { if (open && at === null) place(); }, [open, at, place]);

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
      // The list is a portal, so it is *not* inside `wrap` any more — checking
      // only the wrapper would close the menu on the click that selects an item.
      const t = e.target as Node;
      if (wrap.current?.contains(t) || list.current?.contains(t)) return;
      setOpen(false);
    };
    /**
     * Re-place on scroll and resize, and `capture: true` for the scroll.
     *
     * Scroll events do not bubble, so a listener on `document` never hears the
     * `.deckgrid` the trigger is actually inside — and a fixed menu whose
     * trigger has scrolled away is worse than a clipped one, because it points
     * at the wrong row. Capture hears every scroll on the way down.
     */
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  return (
    <div className="pop" ref={wrap}>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: btn })}
      {open && typeof document !== 'undefined' ? createPortal(
        <div className={`pop__menu${matchTriggerWidth ? ' pop__menu--fit' : ''}`}
             ref={list} id={id}
             style={{
               top: at?.top ?? -9999,
               left: at?.left ?? -9999,
               ...(matchTriggerWidth && at ? { width: at.width } : {}),
             }}>
          <div className="sh-menu" role="menu" aria-label={label}>
            {children(() => close())}
          </div>
        </div>,
        document.body,
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
