-- P3c: scheduled base backups, and a record of every run (backups §2, D-018).

-- Why a table rather than reading `pgbackrest info` when asked.
--
-- The repo knows what backups exist; it does not know about the ones that were
-- *attempted*. A project whose nightly full has failed for six days looks
-- identical, through `info`, to a project whose retention window happens to start
-- six days ago — and the alert catalog's "last-success age > 26h" needs exactly
-- that distinction. Failures are the rows that matter here, and they leave no
-- trace in the repo by definition.
CREATE TABLE IF NOT EXISTS backup_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 'full' | 'incr' | 'diff', matching pgBackRest's own vocabulary so a row can
  -- be compared with `info` output without translation.
  type          text NOT NULL CHECK (type IN ('full', 'incr', 'diff')),
  status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'succeeded', 'failed')),
  -- pgBackRest's label, e.g. 20260901-120000F. Null until the backup completes;
  -- it is the join key back to the repo.
  label         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  size_bytes    bigint CHECK (size_bytes >= 0),
  -- The WAL range the backup spans. Needed to answer "can I restore to time T"
  -- without asking the repo, and to notice a backup whose WAL never arrived.
  wal_start     text,
  wal_stop      text,
  error         text,
  -- Which job produced this run, so a stuck run can be traced to the job that
  -- owns it rather than guessed at from timestamps.
  job_id        uuid REFERENCES provisioning_jobs(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- "When did this project last succeed, and at what" — the scheduler's only
-- question, asked once per project per sweep.
CREATE INDEX IF NOT EXISTS backup_runs_project_success_idx
  ON backup_runs (project_id, type, finished_at DESC)
  WHERE status = 'succeeded';

-- Runs that never finished. A backup left `running` by a killed worker is
-- indistinguishable from one in progress without this being cheap to scan.
CREATE INDEX IF NOT EXISTS backup_runs_running_idx
  ON backup_runs (started_at)
  WHERE status = 'running';

COMMENT ON TABLE backup_runs IS
  'Every base-backup attempt, successful or not (P3c). The repo records what '
  'exists; this records what was tried, which is what a failing schedule looks '
  'like from the outside.';

-- The job type that takes them. Scheduling is a control-plane job per project
-- (D-018), never per-node cron: only the control plane can jitter across the
-- fleet, skip paused projects, and know a project's plan.
ALTER TABLE provisioning_jobs DROP CONSTRAINT IF EXISTS provisioning_jobs_job_type_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_job_type_check
  CHECK (job_type IN ('provision_project', 'delete_project', 'purge_project',
                      'pause_project', 'resume_project', 'rotate_credentials',
                      'backup_project'));
