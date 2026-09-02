-- P3g: a purged project's repo is destroyed, provably (D-038, D-066).

-- Why a table, and why it outlives everything else the project had.
--
-- D-038 requires *provable* destruction and D-066 sets the schedule: the final
-- backup is kept 30 days past purge, and only then does the repo path go. By the
-- time that deadline arrives the container, the volume, the placement row and the
-- credentials are all gone — so the one thing that must survive purge is the
-- knowledge of what still needs deleting and when. Without this row, a purged
-- project's repo simply stays in object storage forever, which is what happened
-- until now: the data a customer asked us to destroy, retained indefinitely, with
-- nothing anywhere recording that it should not be.
CREATE TABLE IF NOT EXISTS project_repos (
  project_id      uuid PRIMARY KEY REFERENCES projects(id) ON DELETE RESTRICT,
  -- The prefix, stored rather than derived. It *is* derivable from the project id
  -- today, and a scheme change later would silently orphan every scheduled
  -- destruction — the row would name a path the code no longer computes, and the
  -- objects would be missed by exactly the sweep meant to remove them.
  repo_path       text NOT NULL,
  bucket          text NOT NULL,
  -- Purge + 30 days (D-066). Null means "not scheduled" and is never a licence to
  -- delete now: a repo with no deadline is one nothing has decided about.
  destroy_after   timestamptz,
  destroyed_at    timestamptz,
  objects_deleted integer CHECK (objects_deleted >= 0),
  -- The last failure, kept so a repo that cannot be destroyed is visible rather
  -- than merely retried forever in silence.
  last_error      text,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ON DELETE RESTRICT, not CASCADE, and deliberately.
--
-- The projects row is never deleted today (mark_deleted only sets the status,
-- because a ref is never reused — D-061). If that ever changes, CASCADE would
-- take the destruction schedule with it and leave the objects behind with nothing
-- recording that they exist. RESTRICT turns that into a loud failure instead.

CREATE INDEX IF NOT EXISTS project_repos_due_idx
  ON project_repos (destroy_after)
  WHERE destroyed_at IS NULL;

COMMENT ON TABLE project_repos IS
  'Where each project''s backup repo lives and when it must be destroyed (P3g, '
  'D-066: purge + 30 days). Outlives every other trace of the project, because '
  'destruction is due long after the container, volume and credentials are gone.';

-- Existing purged projects have repos nobody scheduled. Give them the same
-- deadline from now rather than from their purge — backdating would destroy, on
-- the very next sweep, data whose 30-day window never actually ran.
INSERT INTO project_repos (project_id, repo_path, bucket, destroy_after)
SELECT p.id, '/projects/' || p.id::text, 'unknown', now() + interval '30 days'
  FROM projects p
 WHERE p.status = 'deleted'
   AND NOT EXISTS (SELECT 1 FROM project_repos r WHERE r.project_id = p.id);
