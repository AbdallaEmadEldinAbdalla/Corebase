import { describe, it, expect } from 'vitest';
import { archiveRungFor, ARCHIVE_LADDER, ARCHIVE_SQL } from './wal-scan.ts';
import { PLAN_ARCHIVE_TIMEOUT } from './backup.ts';

/**
 * P3b — the archive ladder, and the definition of lag it rests on.
 *
 * The arithmetic is trivial. The reason these tests exist is the definition: the
 * obvious reading of "WAL archive lag" makes the alert fire forever on healthy
 * projects, and nothing in the thresholds themselves would reveal that.
 */

describe('the rungs the alert catalog names', () => {
  it('warns at 5 minutes and pages at 15', () => {
    expect(ARCHIVE_LADDER.warn).toBe(300);
    expect(ARCHIVE_LADDER.critical).toBe(900);
    expect(archiveRungFor(299)).toBe('ok');
    expect(archiveRungFor(300)).toBe('warn');
    expect(archiveRungFor(899)).toBe('warn');
    expect(archiveRungFor(900)).toBe('critical');
  });

  it('treats nothing-waiting as healthy, not as unknown', () => {
    expect(archiveRungFor(0)).toBe('ok');
  });

  it('has no hysteresis, unlike the disk ladder — and that is deliberate', () => {
    // D-251 gave the disk ladder hysteresis because its read-only rung changes the
    // database's behaviour, so flapping means an application seeing writes fail and
    // succeed with no deploy. These rungs are notifications: flapping costs a
    // duplicate Slack message, and stickiness would cost a stale alert.
    expect(archiveRungFor(301)).toBe('warn');
    expect(archiveRungFor(299)).toBe('ok');
  });
});

describe('why lag is not "time since the last successful archive"', () => {
  it('would put every healthy idle Free project permanently at the warn line', () => {
    // archive_timeout is 300s on Free (D-077), so an idle project archives one
    // segment every five minutes and nothing in between. Under the naive
    // definition its lag reaches exactly the warn threshold every cycle — the
    // alert would fire for the entire free tier, and an alert that always fires
    // is an alert nobody reads.
    const timeout = PLAN_ARCHIVE_TIMEOUT['free']!;
    expect(timeout).toBe(300);
    expect(archiveRungFor(timeout)).toBe('warn');
    // Which is why the query measures the oldest *unarchived* segment instead.
    expect(ARCHIVE_SQL).toContain("name LIKE '%.ready'");
    expect(ARCHIVE_SQL).toContain('min(modification)');
  });

  it('reads the archive status directory through the purpose-built function', () => {
    // `pg_ls_archive_statusdir()` over `pg_ls_dir('pg_wal/archive_status')`: it
    // returns the modification time this depends on, and it is grantable to
    // pg_monitor — so moving off superuser later does not change the query.
    expect(ARCHIVE_SQL).toContain('pg_ls_archive_statusdir()');
    expect(ARCHIVE_SQL).not.toContain('pg_ls_dir');
  });

  it('also reads the archiver failure count, which lag cannot see', () => {
    // A push that fails and is retried successfully inside one sweep leaves no
    // trace in either lag or pending — only in Postgres' own failure counter.
    expect(ARCHIVE_SQL).toContain('failed_count');
    expect(ARCHIVE_SQL).toContain('last_failed_wal');
  });
});
