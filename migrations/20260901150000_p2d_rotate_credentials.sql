-- P2d: credential rotation as its own job type (credentials doc §4a).
--
-- Its own type for the reason D-196 gave the purge: one row cannot carry two
-- operations whose checkpoints and attempt budgets are unrelated. A rotation that
-- half-applied must be retryable on its own terms, not as a mode on a provision.
ALTER TABLE provisioning_jobs DROP CONSTRAINT IF EXISTS provisioning_jobs_job_type_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_job_type_check
  CHECK (job_type IN ('provision_project', 'delete_project', 'purge_project',
                      'pause_project', 'resume_project', 'rotate_credentials'));

-- Finding retiring versions that are past their window, without scanning the table.
-- Partial because only retiring rows are ever candidates.
CREATE INDEX IF NOT EXISTS project_secrets_retiring_idx
  ON project_secrets (rotated_at)
  WHERE state = 'retiring';
