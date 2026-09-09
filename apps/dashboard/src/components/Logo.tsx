import {
  BarChart3, Cable, Gauge, KeyRound, LayoutGrid, Settings, Table2, Users,
  type LucideIcon } from 'lucide-react';

/**
 * The Steadhold mark — the chiselled S, cut at the waist.
 *
 * The geometry is the identity's, verbatim from
 * `design-exports/steadhold/build-identity.py`: one spine, stroke 28, `butt` caps
 * that land on a vertical tangent so both terminals read as a flat stone cut, and
 * Bézier controls pulled to the corners to square the bowls. The ground line at
 * y=126 falls exactly where the two bowls lock, which is what makes the accent a
 * whole stratum rather than a sliver (D-408). It replaces a diamond with a punched
 * centre that predated the brand entirely.
 *
 * **The split is done with nested `<svg>` viewports, not `clipPath`.** A nested
 * `<svg>` clips its content to its own viewport and needs no `id`, which matters
 * here for the reason the previous version of this file already recorded about
 * `<title id>`: the mark renders more than once per page — top bar and auth panel
 * — and duplicate ids are invalid HTML. `clipPath` would need a unique id per
 * instance, and `useId` is a hook, which this component cannot use without
 * becoming a client component for no other reason.
 *
 * Colours are role tokens (D-178), which lands exactly on the identity's two
 * finishes: `text` + `accent-text` gives ink-on-paper in light and
 * paper-on-bright-terracotta in dark, with no per-theme branch here.
 */
const SPINE = 'M146 60 C146 38 126 28 100 28 C72 28 52 44 52 66 '
  + 'C52 84 66 94 90 100 C114 106 148 114 148 134 '
  + 'C148 156 126 172 100 172 C72 172 54 160 54 138';
const CUT = 126;

/** One half of the letter, clipped by its own viewport. */
function Half({ from, to, stroke }: { from: number; to: number; stroke: string }) {
  return (
    <svg x={0} y={from} width={200} height={to - from} viewBox={`0 ${from} 200 ${to - from}`}>
      <path d={SPINE} fill="none" stroke={stroke} strokeWidth={28} strokeLinecap="butt" />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  // Free-standing, always. D-410 allows a field behind the mark in exactly one
  // place — a browser tab, whose ground is unknown — and that is now a static
  // `app/icon.svg` from the identity's own asset set, not this component. So the
  // badge variant this file used to carry had no caller left.
  return (
    <svg width={size} height={size} viewBox="0 0 200 200" fill="none"
      role="img" aria-label="Steadhold">
      <Half from={0} to={CUT} stroke="var(--sh-text)" />
      <Half from={CUT} to={200} stroke="var(--sh-accent-text)" />
    </svg>
  );
}

/**
 * An organization's identity in a switcher.
 *
 * It replaces a violet circle that was the same violet circle for every
 * organization — decoration in the shape of data, which is worse than nothing
 * because it looks like it means something. The initial actually distinguishes one
 * row from the next, and it stays inside the token system: accent-subtle ground,
 * accent letter, no invented per-org colours.
 */
export function OrgAvatar({ name, size = 18 }: { name: string; size?: number }) {
  // First letter of the first word that has one. "42 Labs" gives "4", which is
  // still the right answer — it is what the user reads first.
  const initial = (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  return (
    <span aria-hidden="true"
      style={{
        width: size, height: size, flex: 'none',
        display: 'grid', placeItems: 'center',
        borderRadius: 'var(--sh-radius-sm)',
        background: 'var(--sh-accent-subtle)',
        color: 'var(--sh-accent)',
        font: 'var(--sh-caption)', fontWeight: 700,
        fontSize: Math.max(9, Math.round(size * 0.55)),
        lineHeight: 1,
      }}>
      {initial}
    </span>
  );
}

/**
 * Section icons for the sidebar — **Lucide** (ISC), not hand-drawn.
 *
 * These were seven hand-written path strings, and the experiment failed twice
 * over. It failed on *quality*: `keys` shipped filled, which left a key head with
 * no counter and made it a lollipop, and `settings` took three attempts to stop
 * reading as a sun and then as a ship's wheel. And it failed on *maintenance*: a
 * later edit to the `settings` entry spliced away the `usage` entry beside it,
 * `SectionIcon` fell back to a blank square, and that square shipped — it looks
 * enough like a deliberate bullet that it survived several of my own screenshots.
 *
 * Lucide is drawn on the same 24-unit grid at the same 2px stroke this set was
 * imitating, by people who do it properly, and it removes the whole class of
 * problem. The logo above is *not* Lucide and never will be — it is generated from
 * `build-identity.py` (D-409) — but nothing about a sidebar glyph is brand.
 *
 * The map is also the type. `SectionName` is `keyof typeof ICONS`, `NavItem` takes
 * that rather than `string`, and so an icon that is deleted or misspelled becomes a
 * compile error instead of a silent square. That is the actual fix for what went
 * wrong; swapping the artwork alone would have left the failure mode in place.
 */
const ICONS = {
  projects: LayoutGrid,
  overview: Gauge,
  /** A cable, not a plug: the page is about connection strings, not power. */
  connect: Cable,
  keys: KeyRound,
  /** Two figures — one silhouette reads as "account", a different page. */
  members: Users,
  /** A grid, because the page is rows and columns before it is anything else. */
  'table-editor': Table2,
  usage: BarChart3,
  settings: Settings,
} satisfies Record<string, LucideIcon>;

export type SectionName = keyof typeof ICONS;

export function SectionIcon({ name }: { name: SectionName }) {
  const Icon = ICONS[name];
  return (
    <Icon size={16} strokeWidth={2} aria-hidden="true"
      style={{ flex: 'none', color: 'currentColor' }} />
  );
}
