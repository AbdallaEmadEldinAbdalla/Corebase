'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Global keys, in one listener.
 *
 * Two things this gets right that scattered `keydown` handlers usually do not:
 *
 * **It never fires while the user is typing.** A shortcut that steals `p` from a
 * project-name field is worse than no shortcut, so anything originating in an
 * input, textarea, select or contenteditable is ignored — except the modifier
 * combinations, which cannot collide with typing.
 *
 * **`g` is a prefix, not a key.** `g p` means "go to projects", which is the
 * vocabulary people already have from Gmail and GitHub. The prefix expires after a
 * second so a stray `g` does not silently arm a jump.
 */
const PREFIX_TIMEOUT_MS = 1000;

export interface Hotkeys {
  /** Single keys, e.g. `'?'`. */
  keys?: Record<string, () => void>;
  /** Sequences after `g`, e.g. `{ p: goProjects }`. */
  go?: Record<string, () => void>;
  /** ⌘/Ctrl combinations, e.g. `{ k: openPalette }`. */
  meta?: Record<string, () => void>;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function useHotkeys(spec: Hotkeys) {
  // A ref so the listener is installed once and still sees fresh handlers; the
  // alternative re-registers on every render and drops the pending prefix.
  const latest = useRef(spec);
  latest.current = spec;

  useEffect(() => {
    let armed = false;
    let timer: number | undefined;

    const disarm = () => { armed = false; if (timer) window.clearTimeout(timer); };

    const onKey = (e: KeyboardEvent) => {
      const { keys = {}, go = {}, meta = {} } = latest.current;

      if (e.metaKey || e.ctrlKey) {
        const handler = meta[e.key.toLowerCase()];
        if (handler) { e.preventDefault(); handler(); }
        return;
      }
      if (e.altKey) return;
      if (isTyping(e.target)) return;

      if (armed) {
        const handler = go[e.key.toLowerCase()];
        disarm();
        if (handler) { e.preventDefault(); handler(); }
        return;
      }
      if (e.key === 'g') {
        armed = true;
        timer = window.setTimeout(disarm, PREFIX_TIMEOUT_MS);
        return;
      }
      const handler = keys[e.key];
      if (handler) { e.preventDefault(); handler(); }
    };

    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); disarm(); };
  }, []);
}

/**
 * `⌘K` or `Ctrl+K`, matching the keyboard the reader actually has.
 *
 * Printing `⌘K` to a Windows user is a small lie in the most visible piece of
 * chrome in the app, and it is the kind of detail that makes an interface feel like
 * it was built for someone else. Resolved after mount rather than during render,
 * because the server has no idea which platform is asking and guessing there would
 * be a hydration mismatch.
 */
export function useMetaLabel(): string {
  const [label, setLabel] = useState('\u2318K');
  useEffect(() => {
    const mac = /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
    setLabel(mac ? '\u2318K' : 'Ctrl K');
  }, []);
  return label;
}
