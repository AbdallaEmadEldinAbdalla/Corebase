/**
 * The token layer's single source of truth.
 *
 * `tokens.css` is GENERATED from this file — do not hand-edit it. `tokens.test.ts`
 * re-renders and asserts byte-equality, so the checked-in CSS cannot drift from
 * this definition.
 *
 * Why generated rather than hand-written (D-418). A theme pair has to be declared
 * three times in plain CSS — under `[data-theme="dark"]`, under
 * `@media (prefers-color-scheme: dark)` for viewers who chose nothing, and once
 * more for the surfaces that stay dark in both themes. The previous file carried
 * all three by hand under a comment reading "keep the two blocks in sync", which
 * is a hope rather than a mechanism. `light-dark()` would collapse them, but it
 * cannot be made to degrade: a custom property parses permissively, so an
 * unsupported `light-dark()` is accepted and then fails at substitution time,
 * which unsets the colour rather than falling back to the light one. Generating
 * the duplication is the option with a single source AND no compatibility floor.
 *
 * Same reasoning as the logo (D-409): the values live in exactly one place,
 * because a token layer that has drifted from its dark theme drifts invisibly —
 * nobody opens the second block to check.
 */

// ─── contrast, so the accessibility floor is executable rather than documented ──
const srgb = (v) => (v /= 255, v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => srgb(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
export const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};
export const hueGap = (a, b) => {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return Math.min(d, 360 - d);
};

// ─── the palette ───────────────────────────────────────────────────────────────
/**
 * Clay: warm neutrals carrying a trace of the accent's hue, so terracotta reads
 * as native to the surface rather than applied on top of a cool grey. Never a
 * pure grey, and never #FFF for the page — `bg` is paper.
 */
export const clay = {
  light: { 50:'#FAF6F0', 100:'#F3EDE4', 200:'#E7DFD4', 300:'#CFC3B4', 400:'#796959',
           500:'#63564A', 600:'#4A3F33', 700:'#332A21', 800:'#241E18', 900:'#171310' },
  dark:  { 50:'#14110E', 100:'#1C1815', 200:'#262019', 300:'#373026', 400:'#4C4237',
           500:'#6B5F51', 600:'#9C8E7C', 700:'#C0B3A3', 800:'#E2D8CB', 900:'#FAF6F0' },
};

/**
 * Terracotta, from the identity. Two things about it are deliberate and both
 * overturn part of D-177 (see D-417).
 *
 * The FILL does not lift in dark mode. D-177 chose violet because white cleared
 * AA on the accent in both themes, and then applied a "the accent lifts one step
 * in dark" rule that put the dark accent at violet/600 — where white is 4.23:1
 * and ink is 4.36:1, so the dark primary button failed AA with either label. The
 * doc justified the accent by citing only the light value. Holding the fill at
 * one value across both themes keeps `on-accent` white everywhere, which is the
 * property D-177 actually wanted.
 *
 * `bright` is therefore a TEXT colour, not a fill: on a dark surface it is a link
 * or an icon, where contrast is measured against the surface. Filling with it
 * would need a dark label and reintroduce the per-mode exception.
 */
export const accent = {
  base:'#B4502E', bright:'#E07A52',
  light: { hover:'#9A4326', active:'#7F3620', subtle:'#F8EAE3', border:'#E0B29C' },
  dark:  { hover:'#C05531', active:'#A04729', subtle:'#2F1A12', border:'#7C3B24' },
};

/**
 * Semantics, pushed away from the accent's hue on purpose. D-177's binding rule —
 * "error must never be a hue the brand also uses" — is why a red-adjacent accent
 * was rejected once already, and terracotta at 15° sits 12° from the old error red
 * and 21° from the old warning amber. Rather than drop the brand, error moves to
 * the *cool* side of red (rose, ~346°) and warning to a true ochre (~41°), so both
 * clear 25° of separation from the accent and read as a different family, not a
 * different shade. D-180 still forbids colour as the sole carrier either way.
 */
export const semantic = {
  light: { success:['#0F7A52','#E2F3EA'], warning:['#8A6410','#F7EEDA'],
           error:['#C0143C','#FBE4E9'],   info:['#1F5FA8','#E4EDF8'] },
  dark:  { success:['#4FD08A','#0E2A1D'], warning:['#E0A72A','#2A2110'],
           error:['#F2708F','#2C1219'],   info:['#6FA8F0','#10203A'] },
};

/** Destructive fills carry white labels, so they are darker than error *text*. */
export const danger = {
  light: { fill:'#B0123A', hover:'#8F0E2E' },
  dark:  { fill:'#C0143C', hover:'#A01032' },
};

/**
 * Spacing is named by its value, not its index. The previous scale was
 * space-1/2/3/4/6/8/12 for 4/8/12/16/24/32/48 — an index that skips, so
 * `--sh-space-5` reads as "the step after 16" and was written five times in
 * components that had no such token; an undefined custom property with no
 * fallback voids the whole declaration, so five margins silently rendered as zero
 * (D-414). Naming by value makes a missing step self-evident, and 20 is on the
 * scale now because three components genuinely wanted it.
 */
export const space = [4, 8, 12, 16, 20, 24, 32, 48];
export const radius = { sm:'6px', md:'10px', lg:'14px', full:'999px' };
export const control = { sm:'32px', md:'40px', lg:'48px' };

/**
 * Three families, which widens D-179's "frozen at two" — recorded as D-419.
 * Zilla Slab is the typographic half of the identity: its flat slabs answer the
 * mark's stone-cut terminals, and it is the one carrier of brand in a dense data
 * tool. It is confined to display/h1/h2 at two weights so the payload argument
 * D-179 made still holds. Space Grotesk runs the interface. JetBrains Mono keeps
 * D-179's real point: mono means "this is data you can copy", which is a genuine
 * affordance in a database product.
 */
export const font = {
  display: '"Zilla Slab", Georgia, serif',
  ui: '"Space Grotesk", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};
export const type = {
  display:    ['700', '32px/40px', 'display', '-0.6px'],
  'heading-1':['700', '26px/34px', 'display', '-0.4px'],
  'heading-2':['600', '20px/28px', 'display', '-0.2px'],
  'heading-3':['600', '16px/24px', 'ui',      null],
  'body-l':   ['400', '16px/24px', 'ui',      null],
  'body-m':   ['400', '14px/20px', 'ui',      null],
  'body-s':   ['400', '13px/18px', 'ui',      null],
  caption:    ['500', '12px/16px', 'ui',      '0.4px'],
  code:       ['400', '13px/20px', 'mono',    null],
};

/** Surfaces that stay dark in BOTH themes: a toast, a tooltip, the current page
 *  pill. These are single values, not a pair — that is the whole point of them. */
export const fixedDark = {
  'toast-bg':'#241E18', 'toast-fg':'#FAF6F0', 'toast-sub':'#C0B3A3',
  'toast-border':'#373026', 'toast-action':'#E07A52',
  'tooltip-bg':'#241E18', 'tooltip-fg':'#FAF6F0', 'tooltip-border':'#373026',
  'page-current-bg':'#241E18', 'page-current-fg':'#FAF6F0', 'page-current-border':'#4C4237',
};

/** Code surfaces are dark in both themes too — a SQL block is not a light panel. */
export const code = {
  bg:'#171310', header:'#241E18', text:'#FAF6F0',
  keyword:'#E9A17E', string:'#7FD8A6', comment:'#9C8E7C',
  // The copy affordance sits on the permanently-dark panel, so it is fixed too.
  // It used to be `color:#BEB4D6` written straight into components.css — the old
  // violet ink-700, which survived the whole rebuild as a cool lavender in a warm
  // palette because a hex literal is invisible to a guard that looks for ramp
  // *names*. Hence the no-literals rule in tokens.test.ts.
  'copy-bg':'rgb(255 255 255 / 8%)', 'copy-fg':'#C0B3A3',
};

// ─── the role layer — the ONLY names a component may reference (D-178) ─────────
/** role → [light value, dark value]. A component naming a ramp step is a bug. */
export const roles = (mode) => {
  const c = clay[mode], a = accent[mode], s = semantic[mode], d = danger[mode];
  const light = mode === 'light';
  return {
    bg:             c[50],
    surface:        light ? '#FFFFFF' : c[100],
    'surface-alt':  light ? c[100] : c[200],
    'surface-raised': light ? '#FFFFFF' : c[200],
    border:         light ? c[200] : c[300],
    'border-strong':light ? c[300] : c[400],
    text:           c[900],
    'text-secondary': light ? c[600] : c[700],
    'text-muted':   light ? c[400] : c[600],
    accent:         accent.base,
    'accent-hover': a.hover,
    'accent-active':a.active,
    'accent-subtle':a.subtle,
    'accent-border':a.border,
    'accent-text':  light ? accent.base : accent.bright,
    /**
     * Text ON the accent tint, which is NOT the accent itself. A tinted badge
     * needs a deeper foreground than the fill colour it is tinted from:
     * terracotta on its own 6%-tint is 4.33:1, below AA, and every tint light
     * enough to fix that is within 1.03:1 of the page ground — a badge with no
     * visible fill. So the tint keeps its chroma and the text goes deeper.
     * This pairing had no constraint until a screenshot showed the badge, which
     * is why the contrast block now covers it.
     */
    'accent-on-subtle': light ? a.active : accent.bright,
    'on-accent':    '#FFFFFF',
    danger:         d.fill,
    'danger-hover': d.hover,
    'on-danger':    '#FFFFFF',
    success:        s.success[0], 'success-bg': s.success[1],
    warning:        s.warning[0], 'warning-bg': s.warning[1],
    error:          s.error[0],   'error-bg':   s.error[1],
    info:           s.info[0],    'info-bg':    s.info[1],
    // A switch knob reads as the thing that moves, so it is the lightest
    // surface in the control — but pure white on a dark track is harsher than
    // the palette allows anywhere else, so dark gets clay-800 rather than #fff.
    /**
     * A skeleton is its own role, not `surface-alt` reused. Sharing it put the
     * loading bars at 1.16:1 against a card in light and 1.09:1 in dark — a
     * placeholder you cannot see is indistinguishable from content that never
     * arrived, which is exactly the state §6 of the UX standards asks to be
     * designed. It still has to stay quiet: a skeleton that reads as a filled bar
     * looks like data. Border weight is the right loudness for "absent".
     */
    skeleton:       light ? c[300] : c[300],
    'switch-knob':  light ? '#FFFFFF' : c[800],
    'focus-ring':   light ? accent.base : accent.bright,
    'focus-halo':   a.subtle,
    scrim:          light ? 'rgb(23 19 16 / 32%)' : 'rgb(0 0 0 / 58%)',
  };
};

/** Ramp steps, exposed so the token layer itself can name them. Components cannot. */
const ramps = (mode) => {
  const out = {};
  for (const [k, v] of Object.entries(clay[mode])) out[`clay-${k}`] = v;
  out['terracotta'] = accent.base;
  out['terracotta-bright'] = accent.bright;
  return out;
};

// ─── rendering ─────────────────────────────────────────────────────────────────
const decls = (obj, indent = '  ') => {
  const w = Math.max(...Object.keys(obj).map((k) => k.length));
  return Object.entries(obj)
    .map(([k, v]) => `${indent}--sh-${k}:${' '.repeat(w - k.length + 1)}${v};`)
    .join('\n');
};

export function renderCss() {
  const L = { ...ramps('light'), ...roles('light') };
  const D = { ...ramps('dark'), ...roles('dark') };
  const typeDecls = {};
  for (const [name, [weight, size, family, track]] of Object.entries(type)) {
    typeDecls[name] = `${weight} ${size} var(--sh-font-${family})`;
    if (track) typeDecls[`tracking-${name}`] = track;
  }
  const scale = {};
  for (const n of space) scale[`space-${n}`] = `${n}px`;
  for (const [k, v] of Object.entries(radius)) scale[`radius-${k}`] = v;
  for (const [k, v] of Object.entries(control)) scale[`control-${k}`] = v;

  return `/* Steadhold — design tokens.  GENERATED FILE, DO NOT EDIT.
   Source: tokens.build.mjs  ·  regenerate: node tokens.build.mjs > tokens.css
   tokens.test.ts re-renders this and asserts byte-equality, so the dark theme
   cannot drift from the light one (D-418).

   Components reference ROLE tokens only — --sh-surface, --sh-text, --sh-accent.
   Naming a ramp step (--sh-clay-700) in a component is a bug (D-178), and the
   test fails the build if one appears. */

:root {
  color-scheme: light dark;

${decls(L)}

  /* ── type ── three families; Zilla Slab is confined to display/h1/h2 (D-419) */
  --sh-font-display: ${font.display};
  --sh-font-ui:      ${font.ui};
  --sh-font-mono:    ${font.mono};

${decls(typeDecls)}

  /* ── shape & space ── named by value, so a missing step is obvious (D-414) */
${decls(scale)}

  /* ── surfaces that are dark in BOTH themes ── */
${decls(fixedDark)}
${decls(Object.fromEntries(Object.entries(code).map(([k, v]) => [`code-${k}`, v])))}

  /* no shadow scale, by design (D-179) — elevation is surface tint + border */
}

/* An explicit choice wins in both directions. */
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }

/* ── dark theme ────────────────────────────────────────────────────────────────
   Two blocks with identical bodies, and they must stay identical: the explicit
   choice, and the default "system" setting which stamps no attribute at all — a
   viewer on system-dark has nothing on :root to select. Both are emitted from one
   definition, so they cannot diverge. */
:root[data-theme="dark"] {
${decls(D)}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${decls(D, '    ')}
  }
}
`;
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(renderCss());
