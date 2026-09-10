'use client';

import { useEffect, useRef } from 'react';

/**
 * A checkbox this product draws, rather than one the operating system draws.
 *
 * `.sh-check` sets `accent-color` on a native input, so the box is the OS's —
 * which is what D-429 forbids, and which is also why the design system's own
 * inventory row ("Checkbox — off, on, **indeterminate**, disabled") has never
 * been implementable: `accent-color` cannot draw an indeterminate state, and
 * nothing in the app had ever rendered one.
 *
 * Built the way `.sh-switch` is built — the real input is hidden and kept, so
 * every keyboard and screen-reader behaviour is the browser's, and only the
 * pixels are ours. The alternative considered for row selection was a switch,
 * which would satisfy D-429 by misusing a control that means "a setting is on"
 * to mean "this row is selected".
 *
 * `indeterminate` is a DOM property and not an attribute, so React cannot set it
 * from JSX — hence the ref and the effect. That is the whole reason this is a
 * component rather than four lines of markup at each call site.
 */
export function Checkbox({
  checked, indeterminate = false, onChange, label, disabled,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /**
   * The accessible name. Required, and there is no visible-text variant here on
   * purpose: every use so far is a selection cell in a table, where a visible
   * label would be repeated down the column — so the name has to say *which
   * row*, and a caller that had a visible label would not need this component.
   */
  label: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className="sh-checkbox">
      <input ref={input} type="checkbox" checked={checked} disabled={disabled}
             aria-label={label}
             onChange={(e) => onChange(e.target.checked)} />
      <span className="sh-checkbox__box" aria-hidden="true" />
    </label>
  );
}
