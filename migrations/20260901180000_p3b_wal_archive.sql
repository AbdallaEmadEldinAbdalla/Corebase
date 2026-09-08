-- P3b: WAL-archive lag, recorded so it can be alerted on (D-019, backups §1).

-- How far behind object storage the project's WAL is, in seconds.
--
-- Nullable because "never sampled" is not "zero lag", and the difference matters:
-- a project the scan has never reached must not report a healthy archive.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS wal_archive_lag_seconds integer
    CHECK (wal_archive_lag_seconds >= 0);

-- Segments closed and waiting to be pushed. The lag above is derived from the
-- *oldest* of these, which is why both are stored: a lag of 300s with one pending
-- segment is a slow push, and a lag of 300s with two hundred pending segments is
-- a repo that has stopped accepting writes.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS wal_archive_pending integer
    CHECK (wal_archive_pending >= 0);

-- When a segment last landed in the repo, from pg_stat_archiver. Feeds
-- `steadhold_backup_last_success_ts`, which the "last-success age > 26h" alert
-- reads.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS wal_last_archived_at timestamptz;

-- Postgres' own count of failed archive attempts. Monotonic per server start, so
-- what matters is whether it *moves* between two samples — an absolute value says
-- nothing about now.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS wal_archive_failed_count bigint
    CHECK (wal_archive_failed_count >= 0);

-- The last time `pgbackrest check` ran and what it said. Separate from the lag
-- sample because they answer different questions: lag says whether WAL is
-- flowing, check says whether the repo would accept a backup at all — a project
-- can have zero pending segments and a repo whose credentials expired last week.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS backup_checked_at timestamptz;
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS backup_check_ok boolean;
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS backup_check_error text;

-- The rung, stored so a transition is detectable rather than recomputed every
-- sweep — the same reason the disk ladder stores its own (P2e). `unknown` is the
-- default and is deliberately not `ok`: a project nothing has looked at yet has
-- an unknown archive, and defaulting to healthy is how a fleet reports green for
-- projects it has never checked.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'archive_state') THEN
    CREATE TYPE archive_state AS ENUM ('unknown', 'ok', 'warn', 'critical');
  END IF;
END
$$;

ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS archive_state archive_state NOT NULL DEFAULT 'unknown';

COMMENT ON COLUMN project_databases.wal_archive_lag_seconds IS
  'Age of the oldest WAL segment closed but not yet archived (P3b). NOT time '
  'since the last archive: with archive_timeout forcing a switch every 300s on '
  'Free, an idle healthy project would show 300s of "lag" and page every sweep.';
COMMENT ON COLUMN project_databases.archive_state IS
  'Archive rung: ok <5min lag, warn >=5min, critical >=15min (observability '
  'alert catalog). unknown means never sampled.';

-- The scan reads running projects, oldest sample first.
CREATE INDEX IF NOT EXISTS project_databases_wal_scan_idx
  ON project_databases (backup_checked_at NULLS FIRST)
  WHERE status = 'running';
