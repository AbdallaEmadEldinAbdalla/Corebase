import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { renderCss, roles, contrast, hueGap, saturation } from './tokens.build.mjs';
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
   * tokens.css is generated (D-418). This is the assertion that makes the
   * generator the source of truth rather than a suggestion: if someone edits the
   * CSS by hand, or edits the generator and forgets to re-render, the two stop
   * matching and the build fails. It is also what makes the *duplicated* dark
   * blocks safe — the previous file carried them by hand under a comment reading
   * "keep the two blocks in sync", and a comment cannot fail.
   */
  it('is byte-identical to what tokens.build.mjs renders', () => {
    expect(TOKENS,
      'tokens.css has drifted from its generator — run:\n' +
      '  node apps/dashboard/src/styles/tokens.build.mjs > apps/dashboard/src/styles/tokens.css',
    ).toBe(renderCss());
  });

  it('emits the two dark blocks with identical bodies', () => {
    // The reason the generator exists. An explicit `data-theme="dark"` and a
    // viewer on system-dark who never touched the toggle must get the same
    // values, and they are selected by different rules — so the bodies are
    // compared directly rather than trusted.
    const explicit = TOKENS.match(/:root\[data-theme="dark"\] \{\n([\s\S]*?)\n\}/);
    const system = TOKENS.match(/:root:not\(\[data-theme="light"\]\) \{\n([\s\S]*?)\n  \}/);
    expect(explicit, 'no explicit dark block').toBeTruthy();
    expect(system, 'no system dark block').toBeTruthy();
    const norm = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    expect(norm(system![1]!), 'the two dark blocks disagree').toBe(norm(explicit![1]!));
  });

  /**
   * The accessibility floor, executed. The design system doc used to *state* that
   * white on the accent clears AA "which is what made this accent viable", and it
   * was true of the light value and false of the dark one: white on violet/600
   * was 4.23:1 and ink on it 4.36:1, so the dark primary button failed AA with
   * either label for as long as the system existed. Nobody caught it because the
   * claim lived in prose and prose does not run.
   */
  describe('contrast floor (D-417)', () => {
    const AA = 4.5;

    it('carries white on every accent and danger fill, in both themes', () => {
      for (const mode of ['light', 'dark'] as const) {
        const r = roles(mode);
        for (const key of ['accent', 'accent-hover', 'accent-active', 'danger', 'danger-hover']) {
          const fill = r[key as keyof typeof r] as string;
          expect(contrast(fill, r['on-accent'] as string),
            `white on --sh-${key} (${mode}) is below AA`).toBeGreaterThanOrEqual(AA);
        }
      }
    });

    it('holds body, secondary and muted text against every surface', () => {
      for (const mode of ['light', 'dark'] as const) {
        const r = roles(mode);
        for (const t of ['text', 'text-secondary', 'text-muted']) {
          for (const s of ['bg', 'surface', 'surface-alt']) {
            expect(contrast(r[t as keyof typeof r] as string, r[s as keyof typeof r] as string),
              `--sh-${t} on --sh-${s} (${mode}) is below AA`).toBeGreaterThanOrEqual(AA);
          }
        }
      }
    });

    it('holds the accent tint pairing — the one a screenshot found', () => {
      // `badge--accent` is accent-on-subtle over accent-subtle. The obvious
      // choice, accent over accent-subtle, is 4.33:1 and was already written.
      for (const mode of ['light', 'dark'] as const) {
        const r = roles(mode);
        expect(contrast(r['accent-on-subtle'] as string, r['accent-subtle'] as string),
          `accent text on its own tint (${mode}) is below AA`).toBeGreaterThanOrEqual(AA);
        // and the tint must still be a visible fill, not the page ground
        expect(contrast(r['accent-subtle'] as string, r['bg'] as string),
          `--sh-accent-subtle is invisible against the page (${mode})`).toBeGreaterThan(1.05);
      }
    });

    it('holds every semantic colour against its own tint', () => {
      for (const mode of ['light', 'dark'] as const) {
        const r = roles(mode);
        for (const s of ['success', 'warning', 'error', 'info']) {
          expect(contrast(r[s as keyof typeof r] as string, r[`${s}-bg` as keyof typeof r] as string),
            `--sh-${s} on --sh-${s}-bg (${mode}) is below AA`).toBeGreaterThanOrEqual(AA);
        }
      }
    });

    /**
     * The rule the first version of this palette did not have, and the one a
     * screenshot caught instead of a test.
     *
     * Every constraint here was about contrast, or about hue distance from the
     * accent. None asked whether a semantic *belongs* on a warm clay surface — so
     * info shipped as a saturated navy, `#10203A`, hue 217° and saturation 0.57
     * against a surface at 32°/0.21. It was the coldest and loudest thing on the
     * screen and read as borrowed from another product, which is a thing you see
     * immediately and measure never.
     *
     * Hue is what keeps the semantics apart; chroma is what keeps them in the
     * family. The ceiling is the accent's own tint, because nothing merely
     * informational should out-shout the brand — and unlike a magic number, that
     * ceiling moves correctly if the brand ever changes again.
     */
    it('keeps every semantic tint within the brand tint\'s chroma', () => {
      for (const mode of ['light', 'dark'] as const) {
        const r = roles(mode);
        const ceiling = saturation(r['accent-subtle'] as string);
        for (const s of ['success', 'warning', 'error', 'info']) {
          const tint = r[`${s}-bg` as keyof typeof r] as string;
          expect(saturation(tint),
            `--sh-${s}-bg (${mode}) is more saturated than the brand's own tint, `
            + `so it reads as a louder, foreign colour on a warm surface`,
          ).toBeLessThanOrEqual(ceiling + 0.001);
        }
      }
    });

    it('keeps a skeleton visible against the surface it loads on', () => {
      // Not an AA floor — a skeleton is not text — but a placeholder at 1.09:1
      // is invisible, and "loading" then looks identical to "nothing here".
      for (const mode of ['light', 'dark'] as const) {
        const r = roles(mode);
        for (const s of ['surface', 'bg']) {
          expect(contrast(r['skeleton'] as string, r[s as keyof typeof r] as string),
            `a skeleton on --sh-${s} (${mode}) is not visible`).toBeGreaterThanOrEqual(1.25);
        }
      }
    });

    it('keeps the focus ring at 3:1 against what it sits on (WCAG 2.2)', () => {
      for (const mode of ['light', 'dark'] as const) {
        const r = roles(mode);
        for (const s of ['bg', 'surface']) {
          expect(contrast(r['focus-ring'] as string, r[s as keyof typeof r] as string),
            `focus ring on --sh-${s} (${mode}) is below 3:1`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    /**
     * D-177's binding rule: "error must never be a hue the brand also uses",
     * which is why a red-adjacent accent was rejected once already. Terracotta IS
     * red-adjacent, so the rule is kept by moving the semantics instead — error
     * to the cool side of red, warning to a true ochre. That is only a real
     * separation if it is measured, so it is.
     */
    it('keeps the accent unmistakable from warning and from destructive', () => {
      for (const mode of ['light', 'dark'] as const) {
        const r = roles(mode);
        for (const s of ['warning', 'error', 'danger']) {
          expect(hueGap(r['accent'] as string, r[s as keyof typeof r] as string),
            `--sh-accent and --sh-${s} (${mode}) are within 25° of each other`,
          ).toBeGreaterThanOrEqual(25);
        }
      }
    });
  });

  /**
   * D-178 says a component may not reach past a role token to a ramp step, and
   * the guard for it matched ramp *names* — so three colour literals written
   * straight into components.css sailed through the entire brand rebuild. One of
   * them was `color:#BEB4D6`, the old violet ink-700, still sitting in the code
   * panel's copy button as a cool lavender in a warm palette. A literal is the
   * same violation as a ramp step and is harder to see, so it is the same rule.
   */
  it('has no colour literals outside the token layer (D-178)', () => {
    for (const { file, css } of CONSUMERS) {
      const literals = [
        ...(css.match(/#[0-9A-Fa-f]{3}\b|#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{8}\b/g) ?? []),
        ...(css.match(/\brgba?\([^)]*\)/g) ?? []),
      ];
      expect(literals,
        `${file} writes colour literally; every colour is a role token`,
      ).toEqual([]);
    }
  });

  /**
   * No control drawn by the operating system (D-429).
   *
   * `.sh-select` puts `appearance: none` on a native `<select>` and draws its own
   * caret, so the closed control looks right — and the moment it opens, the list is
   * OS chrome that CSS cannot reach: system font, system metrics, system highlight,
   * dropped into a warm clay palette. There is no styling fix, because the popup is
   * not in the page. `components/Menu.tsx` exports a branded `Select` built on the
   * primitive that already has the focus behaviour the review gate wants.
   *
   * A bare `type="checkbox"` is the same problem at lower volume: `.sh-check` only
   * tints the OS box with `accent-color`, while `.sh-switch` hides the input and
   * draws the track — the same real input underneath, so it keeps its semantics for
   * a screen reader and the keyboard, with pixels that are ours.
   *
   * The rule is about *rendering*, not about elements: `<input type="text">` and
   * `<textarea>` are fully styleable and stay.
   */
  it('renders no control the operating system draws (D-429)', () => {
    // Comments are stripped first: this file's own docblocks discuss `<select>`
    // at length, and a guard that cannot tell prose from markup fails on the
    // explanation of why it exists.
    const code = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const { file, css: raw } of CONSUMERS) {
      if (!file.endsWith('.tsx')) continue;
      const css = code(raw);
      expect(css.match(/<select\b/g) ?? [],
        `${file} uses a native <select>; its open list is OS chrome. `
        + `Use the branded Select from components/Menu.tsx.`,
      ).toEqual([]);
      // The switch's own input is the sanctioned use, so the check is for a
      // checkbox that is *not* inside an `sh-switch` label.
      const bare = (css.match(/type="checkbox"/g) ?? []).length;
      const switches = (css.match(/sh-switch/g) ?? []).length;
      expect(bare <= switches,
        `${file} has a checkbox outside an sh-switch; sh-check leaves the box to `
        + `the OS. Use the switch.`,
      ).toBe(true);
    }
  });

  it('names the spacing scale by value, so a missing step is self-evident', () => {
    // D-414's root cause was an index that skipped: space-1/2/3/4/6/8/12 for
    // 4/8/12/16/24/32/48 made `--sh-space-5` read as a real token.
    for (const px of [4, 8, 12, 16, 20, 24, 32, 48]) {
      expect(TOKENS, `--sh-space-${px} is missing or is not ${px}px`)
        .toMatch(new RegExp(`--sh-space-${px}:\\s+${px}px;`));
    }
    // and no index-named survivor is left behind to mean something else
    const indexed = TOKENS.match(/--sh-space-(\d+):\s*(\d+)px/g) ?? [];
    for (const decl of indexed) {
      const [, name, value] = decl.match(/--sh-space-(\d+):\s*(\d+)px/)!;
      expect(name, `--sh-space-${name} is ${value}px — the name must be the value`).toBe(value);
    }
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
