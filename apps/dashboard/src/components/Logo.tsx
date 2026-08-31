/**
 * The Corebase mark — a core held within a structural base.
 *
 * The geometry is the supplied artwork, used verbatim: a rounded-square container
 * (480 inset in 512, r=128) holding a diamond with its centre punched out by
 * `fillRule="evenodd"`. Two adjustments, both deliberate.
 *
 * The colours come from role tokens rather than the literals in the source, which
 * were Supabase's green. The design system has one brand colour (D-177) and
 * components reference role tokens only (D-178), so a logo carrying its own hex is
 * the one element guaranteed to be wrong in the other theme.
 *
 * And the accessible name is an `aria-label` rather than `<title id="title">`. The
 * mark renders more than once on a page — top bar and an auth panel — and fixed ids
 * would collide, which is invalid HTML and makes a screen reader announce the wrong
 * one. `role="img"` plus a label says the same thing without an id.
 *
 * The punch-out is what makes it work on both grounds: the hole shows whatever is
 * behind the glyph rather than being painted, so the badge and the bare form need
 * no second colour.
 */
const MARK = 'M256 62 L450 256 L256 450 L62 256 Z M256 174 L174 256 L256 338 L338 256 Z';

export function Logo({ size = 22, badge = true }: {
  size?: number;
  /** Rounded-square badge (top bar, favicon) vs. bare glyph (beside a wordmark). */
  badge?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none"
      role="img" aria-label="Corebase">
      {badge ? (
        <rect x="16" y="16" width="480" height="480" rx="128" fill="var(--cb-accent)" />
      ) : null}
      <path d={MARK} fillRule="evenodd" clipRule="evenodd"
        fill={badge ? 'var(--cb-on-accent)' : 'var(--cb-accent)'} />
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
        borderRadius: 'var(--cb-radius-sm)',
        background: 'var(--cb-accent-subtle)',
        color: 'var(--cb-accent)',
        font: 'var(--cb-caption)', fontWeight: 700,
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
};

export function SectionIcon({ name }: { name: keyof typeof PATHS | string }) {
  const d = PATHS[name];
  if (!d) return <span className="cb-nav-item__icon" aria-hidden="true" />;
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
