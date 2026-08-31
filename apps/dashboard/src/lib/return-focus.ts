'use client';

import { useCallback, useRef } from 'react';

/**
 * Remember what had focus before a layer opened, and put it back when the layer
 * closes.
 *
 * The capture has to happen **at the event that opens the layer**, not in an effect
 * inside it. That is the whole reason this is a hook rather than three lines in each
 * dialog: the palette's input carries `autoFocus`, so React has already moved focus
 * into the layer by the time any effect inside it runs — capturing there records the
 * input, the input unmounts, and focus lands on `<body>`, which silently ejects a
 * keyboard user to the top of the page.
 *
 * That is exactly the failure the UX standard's gate question 7 asks about, and it
 * is invisible to anyone testing with a mouse.
 */
export function useReturnFocus() {
  const target = useRef<HTMLElement | null>(null);

  const capture = useCallback(() => {
    const el = document.activeElement;
    // `<body>` is not a return target; if the layer was opened from a global
    // shortcut with nothing focused, there is nowhere meaningful to go back to.
    target.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }, []);

  const restore = useCallback(() => {
    const el = target.current;
    target.current = null;
    // The element can be gone if the layer's action re-rendered the page.
    if (el && el.isConnected) el.focus();
  }, []);

  return { capture, restore };
}
