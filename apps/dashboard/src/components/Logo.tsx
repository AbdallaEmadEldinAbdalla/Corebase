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
 * Section icons for the sidebar. Also drawn here, for the same reason as the logo,
 * and kept to one visual weight so the nav does not look assembled from clip art.
 *
 * They replace the board's generic filled square, which was identical for every
 * item — seven rows of the same shape is a decoration column, not a scanning aid.
 */
const PATHS: Record<string, string> = {
  projects: 'M3 4.5h7v6H3zM12 4.5h7v6h-7zM3 12.5h7v6H3zM12 12.5h7v6h-7z',
  overview: 'M4 12a8 8 0 0 1 16 0M12 12l4-3',
  connect: 'M8 4v6a4 4 0 0 0 8 0V4M12 14v6',
  keys: 'M14.5 5a4.5 4.5 0 1 0-3.2 7.7L4 20v0h3v-2h2v-2h2l1.3-1.3A4.5 4.5 0 0 0 14.5 5Z',
  // Two figures, not one: the section is about a group, and a single silhouette
  // reads as "account" — which is a different page.
  members: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0'
    + 'M16.5 11.5a3 3 0 1 0 0-6M18 20h3.5a5.5 5.5 0 0 0-4-5.3',
};

export function SectionIcon({ name }: { name: keyof typeof PATHS | string }) {
  const d = PATHS[name];
  if (!d) return <span className="sh-nav-item__icon" aria-hidden="true" />;
  const filled = name === 'projects' || name === 'keys';
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"
      style={{ flex: 'none', color: 'currentColor' }}>
      <path d={d}
        {...(filled
          ? { fill: 'currentColor' }
          : {
            fill: 'none', stroke: 'currentColor', strokeWidth: 2,
            strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const
          })} />
    </svg>
  );
}
