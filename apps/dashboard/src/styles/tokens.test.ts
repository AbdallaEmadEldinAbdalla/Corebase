import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The design system as an executable rule, not a document to remember.
 *
 * `docs/09-dashboard/04-design-system.md` states two things that are binding
 * rather than stylistic, and both are the kind of rule that decays silently:
 *
 * - **D-178:** components reference semantic *role* tokens only. "A component
 *   that names a ramp step directly is a bug" — and it is a bug that looks
 *   perfectly fine in light mode, which is exactly why a human review misses it.
 *   It surfaces months later as an unreadable dark theme.
 * - **D-179:** no drop shadows anywhere; elevation is surface tint plus border
 *   weight. One `box-shadow` slipped into a component is the start of a second,
 *   undocumented elevation scale.
 *
 * This is a better guard than diffing against design-exports/07-html, because it
 * checks the rule the export exists to communicate rather than the bytes it
 * happens to contain.
 */

const STYLES = new URL('.', import.meta.url).pathname;
const read = (f: string) => readFileSync(join(STYLES, f), 'utf8');

const TOKENS = read('tokens.css');
/** Every stylesheet except the token layer itself, which is where ramps belong. */
const CONSUMERS = readdirSync(STYLES)
  .filter((f) => f.endsWith('.css') && f !== 'tokens.css')
  .map((f) => ({ file: f, css: read(f) }));

/** The role tokens the design system doc's "semantic role tokens" table names. */
const ROLE_TOKENS = [
  'bg', 'surface', 'surface-alt', 'border', 'border-strong',
  'text', 'text-secondary', 'text-muted', 'accent-subtle', 'on-accent',
];

describe('design tokens', () => {
  it('defines every role token the design system names', () => {
    for (const name of ROLE_TOKENS) {
      expect(TOKENS, `--cb-${name} is missing`).toContain(`--cb-${name}:`);
    }
  });

  it('redefines the role tokens for dark, in both the explicit and the system case', () => {
    // D-178: dark is a second set of values, not an inversion — and it has to
    // arrive two ways, because a user who never touched the toggle gets the
    // media query and a user who chose dark gets the attribute.
    expect(TOKENS).toContain('[data-theme="dark"]');
    expect(TOKENS).toContain('prefers-color-scheme: dark');
    // The media block must not win over an explicit light choice.
    expect(TOKENS).toMatch(/:root:not\(\[data-theme="light"\]\)/);
  });

  /**
   * D-179 forbids *drop* shadows — elevation — and the test has to say that
   * precisely, because the system uses `box-shadow` for two things it explicitly
   * requires: the focus ring (§7: "a 2px accent ring plus a violet/100 outer
   * halo") and the active nav item's 3px accent bar (D-180). Both are spread-only
   * shadows with a zero blur radius.
   *
   * So the rule is the blur radius: a non-zero blur is a soft shadow and there is
   * no legitimate use of one in this system. A first version of this test banned
   * `box-shadow` outright and failed on the design system's own focus ring, which
   * would have meant either deleting a required affordance or deleting the test.
   */
  it('has no drop shadows — only zero-blur rings and bars (D-179)', () => {
    const offenders: string[] = [];
    for (const { file, css } of [{ file: 'tokens.css', css: TOKENS }, ...CONSUMERS]) {
      for (const decl of css.match(/box-shadow\s*:\s*[^;}]+/g) ?? []) {
        const value = decl.slice(decl.indexOf(':') + 1).trim();
        if (value === 'none') continue;
        for (const layer of value.split(/,(?![^()]*\))/)) {
          const lengths = layer.trim().match(/-?\d*\.?\d+(px|rem|em)?/g) ?? [];
          // offset-x, offset-y, blur, spread — blur is the third.
          const blur = lengths[2];
          if (blur && parseFloat(blur) !== 0) {
            offenders.push(`${file}: ${layer.trim()}`);
          }
        }
      }
    }
    expect(offenders, `drop shadows found:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('D-178 — no stylesheet reaches past a role token to a ramp step', () => {
  for (const { file, css } of CONSUMERS) {
    it(`${file} names no ramp step`, () => {
      const ramps = css.match(/--cb-(ink|violet)-\d+/g) ?? [];
      expect(
        [...new Set(ramps)],
        `${file} uses ramp steps directly; use a role token instead`,
      ).toEqual([]);
    });
  }
});
