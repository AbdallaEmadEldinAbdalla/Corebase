import { describe, it, expect } from 'vitest';
import { formatBytes, fraction, formatAgo } from './format-usage.ts';

describe('formatBytes', () => {
  it('matches the configured limit rather than the SI unit', () => {
    // `disk_limit_mb: 500` is published as 500 * 1024 * 1024 bytes. An operator
    // who typed 500 has to read 500, or they will ask where the extra 24 MB in
    // "524.3 MB" came from.
    expect(formatBytes(500 * 1024 * 1024)).toBe('500 MB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB');
  });

  it('scales through the units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(9_243_795)).toBe('8.82 MB');
    expect(formatBytes(1024 ** 4)).toBe('1 TB');
  });

  it('keeps two decimals under 10 and one above, and trims dead zeros', () => {
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(12.34 * 1024 * 1024)).toBe('12.3 MB');
    // Not "9.00 MB" — a trailing zero pair reads as measured precision.
    expect(formatBytes(9 * 1024 * 1024)).toBe('9 MB');
  });

  it('never prints 1024 of a unit', () => {
    // 1023.7 KB rounds to "1024" at one decimal, which is a unit too low.
    expect(formatBytes(Math.round(1023.7 * 1024))).not.toContain('1024');
  });

  it('is a dash for absent, not a zero', () => {
    // The distinction the whole page rests on: unmeasured is not empty.
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
  });
});

describe('fraction', () => {
  it('is a ratio of used to limit', () => {
    expect(fraction(50, 100)).toBe(0.5);
    expect(fraction(0, 100)).toBe(0);
  });

  it('clamps, because a disk over its limit is possible and a bar past 100% is not', () => {
    expect(fraction(150, 100)).toBe(1);
  });

  it('is null when there is nothing to draw', () => {
    // A bar at 0 and a bar for an unmeasured project look identical and mean
    // opposite things, so the caller must be able to draw neither.
    expect(fraction(null, 100)).toBeNull();
    expect(fraction(undefined, 100)).toBeNull();
    expect(fraction(10, 0)).toBeNull();
    expect(fraction(10, null)).toBeNull();
    expect(fraction(Number.NaN, 100)).toBeNull();
  });
});

describe('formatAgo', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

  it('is coarse, because the figure is sampled and not live', () => {
    expect(formatAgo(ago(10), now)).toBe('just now');
    expect(formatAgo(ago(44), now)).toBe('just now');
    expect(formatAgo(ago(120), now)).toBe('2 minutes ago');
    expect(formatAgo(ago(3 * 3600), now)).toBe('3 hours ago');
    expect(formatAgo(ago(2 * 86400), now)).toBe('2 days ago');
  });

  it('says one thing in the singular', () => {
    expect(formatAgo(ago(60), now)).toBe('1 minute ago');
    expect(formatAgo(ago(3600), now)).toBe('1 hour ago');
    expect(formatAgo(ago(86400), now)).toBe('1 day ago');
  });

  it('treats a future timestamp as just now rather than counting up', () => {
    // Browser and server clocks disagree by seconds; "in 3 seconds" would be
    // alarming and would mean nothing.
    const future = new Date(now.getTime() + 3000).toISOString();
    expect(formatAgo(future, now)).toBe('just now');
  });

  it('is "never" for absent or unparseable, not the epoch', () => {
    expect(formatAgo(null, now)).toBe('never');
    expect(formatAgo(undefined, now)).toBe('never');
    expect(formatAgo('not a date', now)).toBe('never');
  });
});
