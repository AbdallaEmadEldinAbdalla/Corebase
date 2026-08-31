-- Milestone 0 · T7 — deletion is two operations, not one.
--
-- D-038 gives a project a 7-day recovery window: the soft delete stops the
-- container and KEEPS the volume, and a purge days later destroys it. The
-- job-queue doc modelled the second phase as `delete_project` with
-- `payload.mode = 'purge'`; it gets its own job_type instead (D-196).
--
-- The reason is the job row itself. One row spanning both phases would share a
-- single `checkpoint` set, a single `attempts` budget and a single idempotency
-- key across two operations a week apart — so a purge that failed twice would
-- inherit the soft delete's completed-step list and its exhausted retries. They
-- are separate operations with separate failure domains and deserve separate
-- rows.

ALTER TABLE provisioning_jobs DROP CONSTRAINT provisioning_jobs_job_type_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_job_type_check
  CHECK (job_type IN (
    'provision_project', 'pause_project', 'resume_project',
    'delete_project', 'purge_project', 'rotate_credentials',
    'create_backup', 'restore_backup', 'node_reconcile'));

-- The purge scan looks for exactly this: soft-deleted projects whose window has
-- closed. Partial so it stays small however many live projects exist.
CREATE INDEX idx_projects_purge_due ON projects (purge_after)
  WHERE status = 'soft_deleted';
