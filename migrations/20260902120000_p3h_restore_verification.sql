-- P3h: automated restore verification (D-019 made operational by D-176).
--
-- The operating rule of the whole phase, from the backups doc's first line: **a
-- backup that has not been restore-tested is treated as not existing.** Everything
-- before this step built an archive. This is what turns it into a recovery path,
-- and until it runs the honest description of the last seven steps is "we have
-- files in a bucket that we believe are restorable".
CREATE TABLE IF NOT EXISTS restore_verifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Which backup was tested. A verification that cannot name the backup it
  -- restored proves nothing later: the chain moves on, and "this project verified
  -- fine in March" is only useful if you know what was in the repo in March.
  backup_label   text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  duration_ms    integer CHECK (duration_ms >= 0),
  result         text NOT NULL DEFAULT 'running'
                   CHECK (result IN ('running', 'passed', 'failed')),
  failure_reason text,
  -- Which check failed, so a pattern across the fleet is visible without reading
  -- every reason string: 'recovery', 'checksums', 'amcheck', 'sanity', 'restore'.
  failed_check   text,
  -- Wall-clock restore time feeds the RTO table in backups §5 with *measured*
  -- numbers instead of aspirations. Recorded separately from duration_ms, which
  -- covers the whole verification including the checks.
  restore_ms     integer CHECK (restore_ms >= 0),
  bytes_restored bigint CHECK (bytes_restored >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- "Which project is most overdue" — the scheduler's only question.
CREATE INDEX IF NOT EXISTS restore_verifications_project_idx
  ON restore_verifications (project_id, finished_at DESC)
  WHERE result = 'passed';

-- Failures, for the alert and the runbook.
CREATE INDEX IF NOT EXISTS restore_verifications_failed_idx
  ON restore_verifications (finished_at DESC)
  WHERE result = 'failed';

COMMENT ON TABLE restore_verifications IS
  'Every attempt to restore a project''s backup and check it (P3h, D-176). A '
  'failure treats that project''s backups as nonexistent until a fresh full is '
  'taken and verified — which is why the failures are the rows that matter.';

-- Verification is its own job type: it provisions a scratch container, restores
-- into it and destroys it, which is a different attempt budget and a different
-- checkpoint sequence from anything else a project does.
ALTER TABLE provisioning_jobs DROP CONSTRAINT IF EXISTS provisioning_jobs_job_type_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_job_type_check
  CHECK (job_type IN ('provision_project', 'delete_project', 'purge_project',
                      'pause_project', 'resume_project', 'rotate_credentials',
                      'backup_project', 'restore_project', 'verify_restore'));
