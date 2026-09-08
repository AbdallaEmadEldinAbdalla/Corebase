/**
 * Rendering the usage figures.
 *
 * Pure, and tested, because two of these choices are honesty decisions rather
 * than formatting ones.
 *
 * **The divisors are 1024, and the labels say MB/GB.** That pairing is
 * technically loose — 1024-based units are properly MiB/GiB — and it is the right
 * call here for one reason: `disk_limit_mb` is configured in 1024-based
 * megabytes, so an operator who set 500 must read "500 MB" on the page. Dividing
 * by 1000 instead would render that same limit as "524.3 MB", which invites a
 * support question about where the extra 24 came from. Matching the configured
 * number beats matching the SI committee.
 *
 * **`null` is never 0.** Every figure that comes from a sweep can be absent, and
 * a dash says "nobody has measured this" where a zero says "there is none of it".
 * Those are different statements and only one of them is true.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 0) return '—';
  if (bytes === 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Bytes and kilobytes have no useful fraction; above that, one decimal is
  // enough to distinguish 9.2 GB from 9.8 GB without implying byte precision.
  const digits = () => (unit <= 1 ? 0 : (value < 10 ? 2 : 1));
  let rounded = value.toFixed(digits());
  // `toFixed` can carry — 1023.7 KB rounds to "1024 KB", a unit too low. Step up
  // and re-round *in place*: an earlier version recursed on the same input, which
  // is an infinite loop, and the test written for this line is what found it.
  if (Number(rounded) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
    rounded = value.toFixed(digits());
  }
  return `${trimZeros(rounded)} ${UNITS[unit]}`;
}

/** `9.20` reads as false precision; `9.2` does not. */
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/**
 * A fraction for the disk bar, clamped and null-safe.
 *
 * Returns `null` when there is nothing to show rather than 0, because a bar at
 * zero and a bar for an unmeasured project look identical and mean opposite
 * things — the page renders no bar at all for the second.
 */
export function fraction(used: number | null | undefined, limit: number | null | undefined): number | null {
  if (used === null || used === undefined) return null;
  if (!limit || limit <= 0) return null;
  if (!Number.isFinite(used)) return null;
  return Math.min(1, Math.max(0, used / limit));
}

const MINUTE = 60, HOUR = 3600, DAY = 86400;

/**
 * How long ago, in words. `now` is a parameter so this is testable and so the
 * caller decides what "now" means.
 *
 * Deliberately coarse: a sweep runs every few minutes, so rendering "42 seconds
 * ago" to the second implies a live reading that this figure is not.
 */
export function formatAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'never';

  const seconds = Math.round((now.getTime() - then) / 1000);
  // A clock skew between the browser and the server can put a sample marginally
  // in the future. "in 3 seconds" is alarming and meaningless; "just now" is
  // neither, and is what the reader would conclude anyway.
  if (seconds < 45) return 'just now';
  if (seconds < HOUR) return plural(Math.round(seconds / MINUTE), 'minute');
  if (seconds < DAY) return plural(Math.round(seconds / HOUR), 'hour');
  return plural(Math.round(seconds / DAY), 'day');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}
