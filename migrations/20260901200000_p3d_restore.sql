-- P3d: restore-to-new-instance and PITR (backups §4, D-019).

-- Production is never overwritten (proposal §36, and it is the only restore flow
-- there is): a restore provisions a *fresh* project and leaves the original
-- untouched and serving. So a restore needs two new states and a link back.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'project_status' AND e.enumlabel = 'restoring'
  ) THEN
    ALTER TYPE project_status ADD VALUE 'restoring' AFTER 'resuming';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'project_status' AND e.enumlabel = 'restored'
  ) THEN
    ALTER TYPE project_status ADD VALUE 'restored' AFTER 'restoring';
  END IF;
END
$$;

-- `restored` rather than `ready`, and the distinction is the point.
--
-- A restored instance is a *copy*, and double-serving live traffic against two
-- databases is a data-loss generator (backups §4 step 5): the customer writes to
-- whichever one their application happens to be pointed at, and reconciling that
-- afterwards is not possible. So it runs with API access off until the customer
-- validates it and explicitly promotes. `ready` would make it indistinguishable
-- from production in every list, badge and API response — which is exactly the
-- confusion that ends with writes going to the wrong copy.

-- Where a restored project came from, and to what point in time.
CREATE TABLE IF NOT EXISTS project_restores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The new project. One restore per project: the restored stack *is* the
  -- restore, so a second row would describe a project that does not exist.
  project_id        uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  -- Where the data came from. ON DELETE SET NULL rather than CASCADE: deleting the
  -- source must not delete the restore, which may be the only surviving copy —
  -- that is often *why* the restore exists.
  source_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  -- Kept as text alongside the FK so a purged source still names itself. A restore
  -- whose lineage reads `null` is a restore nobody can explain a year later.
  source_ref        text NOT NULL,
  -- The requested point in time. Null means "latest" — the node-loss case, where
  -- there is no target beyond "everything you have".
  target_time       timestamptz,
  -- What recovery actually reached, read back from the restored cluster.
  --
  -- `reached_lsn` is the load-bearing one: a non-null replay LSN means WAL was
  -- actually replayed rather than the cluster starting from its base backup and
  -- stopping there. `reached_time` comes from `pg_last_xact_replay_timestamp()`
  -- and is informational — it reports the last *transaction* replayed, and
  -- recovery can legitimately reach its target having replayed none, so NULL here
  -- is not a failure. Treating it as one would fail restores that worked.
  reached_time      timestamptz,
  reached_lsn       text,
  -- The backup pgBackRest chose to restore from, for the record.
  backup_label      text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'succeeded', 'failed')),
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_restores_source_idx
  ON project_restores (source_project_id, started_at DESC);

COMMENT ON TABLE project_restores IS
  'One row per restored project (P3d). Records what was asked for and what '
  'recovery actually reached — a restore that silently landed at an earlier '
  'point is the failure mode this table exists to make visible.';

ALTER TABLE provisioning_jobs DROP CONSTRAINT IF EXISTS provisioning_jobs_job_type_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_job_type_check
  CHECK (job_type IN ('provision_project', 'delete_project', 'purge_project',
                      'pause_project', 'resume_project', 'rotate_credentials',
                      'backup_project', 'restore_project'));
