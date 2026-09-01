-- P2e: per-project disk caps and the enforcement ladder (D-073).

-- Node-side disk booking, mirroring ram_reserved_mb. Without it, placement books
-- RAM and ignores disk entirely — which means the node can be full of projects
-- that each have room in memory and none on disk, and "the node itself never
-- suffers" becomes a hope rather than arithmetic.
ALTER TABLE nodes
  ADD COLUMN IF NOT EXISTS disk_reserved_gb integer NOT NULL DEFAULT 0
    CHECK (disk_reserved_gb >= 0);

-- The plan's database-size cap, in MB, and the quota derived from it.
--
-- The cap is what the customer is told (500 MB Free, 8 GB Pro/Team) and what the
-- ladder's percentages are measured against. The *quota* is cap × 1.2: the 20%
-- headroom exists so the recovery flow can run at all, because deleting rows
-- generates WAL and a filesystem with zero free space cannot accept the writes
-- that would free space. A quota set exactly at the cap deadlocks the customer.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS disk_limit_mb integer NOT NULL DEFAULT 500
    CHECK (disk_limit_mb > 0);

-- What the last sample saw. Nullable because a project that has never been
-- sampled is not a project at zero bytes, and the ladder must not act on a
-- reading it does not have.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS disk_used_bytes bigint CHECK (disk_used_bytes >= 0);
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS disk_checked_at timestamptz;

-- Which rung of the ladder this project is on.
--
-- Stored rather than recomputed each sweep so a transition can be detected: the
-- ladder's actions are things that must happen once (notify, escalate, go
-- read-only), not every six hours forever. Comparing the new rung against the
-- stored one is what turns a level into an event.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'disk_state') THEN
    CREATE TYPE disk_state AS ENUM ('ok', 'warn', 'critical', 'read_only');
  END IF;
END
$$;

ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS disk_state disk_state NOT NULL DEFAULT 'ok';

COMMENT ON COLUMN project_databases.disk_limit_mb IS
  'Plan database-size cap in MB (D-073). The hard quota is this x 1.2.';
COMMENT ON COLUMN project_databases.disk_state IS
  'Ladder rung: ok <80%, warn >=80%, critical >=90%, read_only >=95% (D-073).';

-- Existing rows predate plans having caps; Free is the default and every project
-- created so far is Free.
UPDATE project_databases d
   SET disk_limit_mb = CASE p.plan WHEN 'free' THEN 500 ELSE 8192 END
  FROM projects p
 WHERE p.id = d.project_id;

-- The scan reads running projects ordered by how stale the sample is.
CREATE INDEX IF NOT EXISTS project_databases_disk_scan_idx
  ON project_databases (disk_checked_at NULLS FIRST)
  WHERE status = 'running';
