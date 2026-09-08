'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Whether the sidebar is collapsed to icons.
 *
 * Two rules that pull against each other, and the resolution is the interesting
 * part:
 *
 *  - **Tablet widths start collapsed.** A 232px sidebar out of a ~1000px window is
 *    a quarter of the screen spent on seven words, and the content column pays for
 *    it — that is where the members list ran out of room in the first place.
 *  - **An explicit choice wins, at every width.** Someone who expands it on a
 *    tablet has said what they want, and a layout that re-collapses on the next
 *    navigation is arguing with them.
 *
 * So the stored value is *tri-state*: `'expanded'`, `'collapsed'`, or absent. Only
 * absent defers to the viewport. A boolean could not express "no opinion yet", and
 * with one, either the tablet default overrides the user or the user's first visit
 * gets a default they never chose.
 *
 * The read happens in an effect rather than during render because `localStorage`
 * and `matchMedia` do not exist on the server, and guessing during SSR is a
 * hydration mismatch. The first paint is therefore expanded on every load; that is
 * one frame, and it is the same trade `useMetaLabel` already makes for `⌘K`.
 */
const KEY = 'sh.sidebar';

/** Below this the sidebar collapses unless the user has said otherwise. */
export const TABLET_MAX = 1024;

export interface Sidebar {
  collapsed: boolean;
  toggle: () => void;
}

export function useSidebar(): Sidebar {
  const [collapsed, setCollapsed] = useState(false);

  /**
   * A mirror of the state, so `toggle` can read the current value without
   * closing over it and without putting the write inside the updater.
   *
   * The first version did `setCollapsed((was) => { localStorage.setItem(…); return !was; })`,
   * which is a side effect inside a state updater — React's StrictMode invokes
   * those twice on purpose to surface exactly that, so the toggle stored the wrong
   * value and the sidebar refused to expand. The updater must be pure; the write
   * belongs beside it.
   */
  const current = useRef(collapsed);
  useEffect(() => { current.current = collapsed; }, [collapsed]);


  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(KEY); } catch { /* private mode */ }

    if (stored === 'collapsed') { setCollapsed(true); current.current = true; return; }
    if (stored === 'expanded') { setCollapsed(false); current.current = false; return; }

    // No opinion stored: follow the viewport, and keep following it while the
    // window is resized. A tablet rotated to landscape should get its space back.
    const mq = window.matchMedia(`(max-width: ${TABLET_MAX}px)`);
    setCollapsed(mq.matches);
    current.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      setCollapsed(e.matches);
      current.current = e.matches;
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    const next = !current.current;
    current.current = next;
    setCollapsed(next);
    // Writing on toggle is what makes the choice explicit and stops the viewport
    // rule from taking it back on the next load.
    try { localStorage.setItem(KEY, next ? 'collapsed' : 'expanded'); } catch { /* ignore */ }
  }, []);

  return { collapsed, toggle };
}
