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
const SRC = join(STYLES, '..');
const read = (f: string) => readFileSync(join(STYLES, f), 'utf8');

const TOKENS = read('tokens.css');

/**
 * A token collapses from an inline `style={{}}` exactly as easily as from a rule,
 * and the first version of this guard read only the stylesheets — so the very bug
 * the docblock above describes came straight back in five `.tsx` files and sat
 * there through the whole dashboard shell. A consumer is anything that can write
 * `var(--sh-…)`, which also puts D-178's ramp-step rule where it was always aimed.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);

/** Every stylesheet except the token layer itself, which is where ramps belong. */
const CONSUMERS = [
  ...readdirSync(STYLES)
    .filter((f) => f.endsWith('.css') && f !== 'tokens.css')
    .map((f) => ({ file: f, css: read(f) })),
  ...walk(SRC)
    .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
    .map((f) => ({ file: f.slice(SRC.length + 1), css: readFileSync(f, 'utf8') })),
];

/** The role tokens the design system doc's "semantic role tokens" table names. */
const ROLE_TOKENS = [
  'bg', 'surface', 'surface-alt', 'border', 'border-strong',
  'text', 'text-secondary', 'text-muted', 'accent-subtle', 'on-accent',
];

describe('design tokens', () => {
  it('defines every role token the design system names', () => {
    for (const name of ROLE_TOKENS) {
      expect(TOKENS, `--sh-${name} is missing`).toContain(`--sh-${name}:`);
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

/**
 * The guard I did not have, and the bug that proves it was needed.
 *
 * `shell.css` referenced `--sh-space-5` in five places. There is no such token —
 * the 4-point scale is 4/8/12/16/24/32/48, named space-1/2/3/4/6/8/12 — and an
 * undefined custom property with no fallback makes the *entire declaration*
 * invalid rather than falling back to something. So five paddings silently became
 * zero, which is how the command palette's input ended up with its text jammed
 * against the edge. Nothing failed; it just looked wrong, and only to a human.
 *
 * A reference with an explicit fallback is fine — `var(--sh-space-5, 20px)` is what
 * the exported components.css does, and it renders correctly — so the test only
 * flags references that would collapse.
 */
describe('every token a stylesheet uses is defined', () => {
  for (const { file, css } of CONSUMERS) {
    it(`${file} references no undefined token without a fallback`, () => {
      const defined = new Set(
        Array.from(TOKENS.matchAll(/(--sh-[a-z0-9-]+)\s*:/g)).map((m) => m[1]!));
      const missing = new Set<string>();
      // The capture group after the name tells us whether a fallback follows: a
      // comma means `var(--x, fallback)`, a paren means bare.
      for (const m of css.matchAll(/var\(\s*(--sh-[a-z0-9-]+)\s*([,)])/g)) {
        if (m[2] === ')' && !defined.has(m[1]!)) missing.add(m[1]!);
      }
      expect([...missing],
        `${file} uses tokens that do not exist, so those declarations are dropped`,
      ).toEqual([]);
    });
  }
});

describe('D-178 — no stylesheet reaches past a role token to a ramp step', () => {
  for (const { file, css } of CONSUMERS) {
    it(`${file} names no ramp step`, () => {
      const ramps = css.match(/--sh-(ink|violet)-\d+/g) ?? [];
      expect(
        [...new Set(ramps)],
        `${file} uses ramp steps directly; use a role token instead`,
      ).toEqual([]);
    });
  }
});
