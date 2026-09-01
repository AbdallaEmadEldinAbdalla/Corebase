-- P2c: pause and resume (D-008), the economic keystone of the free tier.

-- Two more job types. Separate jobs rather than modes on one, for the same reason
-- the purge is its own type (D-196): one row cannot carry two operations whose
-- checkpoints and attempt budgets are unrelated.
ALTER TABLE provisioning_jobs DROP CONSTRAINT IF EXISTS provisioning_jobs_job_type_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_job_type_check
  CHECK (job_type IN ('provision_project', 'delete_project', 'purge_project',
                      'pause_project', 'resume_project'));

-- What this project currently has booked on its node's RAM.
--
-- The booking and the *limit* are different numbers and always were (D-174): the
-- limit is the container's burst ceiling, the booking is the plan's RAM budget, and
-- a paused project books zero while keeping its disk. Recording the booking on the
-- row is what makes release and re-book idempotent by the same mechanism
-- `release_capacity` already uses — the update is conditional on the current value
-- inside the transaction, so a second call finds nothing to do.
--
-- It also fixes a live accounting bug: `releaseNode` credited the node with the
-- *plan* booking when the placement row was deleted, so purging an already-paused
-- project — whose booking is zero — would credit RAM that was never reserved and
-- leave the node permanently under-counted.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS ram_booked_mb integer NOT NULL DEFAULT 0
    CHECK (ram_booked_mb >= 0);

-- Every existing row is a running project, so its booking is its plan's budget.
-- 350 MB is Free (D-174); anything else is set explicitly by the allocator from
-- here on, and this backfill only has to be right for what exists today.
UPDATE project_databases d
   SET ram_booked_mb = 350
  FROM projects p
 WHERE p.id = d.project_id
   AND d.ram_booked_mb = 0
   AND d.status <> 'paused';

COMMENT ON COLUMN project_databases.ram_booked_mb IS
  'RAM currently reserved for this project on its node (D-174). Zero while paused.';

-- When this project last had a client connection. Written by the idle scan, which
-- is the only thing that knows; NULL means "never observed active", and the scan
-- treats that as the row's creation time rather than as infinitely idle — a
-- project created five minutes ago has not been idle for seven days.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz;

-- Answering "which projects are idle enough to pause" without scanning every
-- project. Partial, because only running projects are candidates.
CREATE INDEX IF NOT EXISTS project_databases_pause_candidates_idx
  ON project_databases (last_active_at)
  WHERE status = 'running';
