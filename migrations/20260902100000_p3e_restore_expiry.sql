-- P3e: a restored copy has a deadline (backups §4 step 7).

-- When this copy stops being kept.
--
-- A restored instance is a *scratch* copy: it holds a second full dataset, a
-- second RAM booking and a second disk booking, and it serves no traffic. Left
-- alone it is a project nobody deletes — the customer validated their data on
-- Tuesday and the copy is still costing money in March. So it carries a deadline
-- from the moment it is created, and the deadline is visible in the API and on the
-- screen: a deadline you cannot read is not a deadline you can act on.
ALTER TABLE project_restores
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Backfill: anything restored before this migration gets the default window from
-- now rather than from its own creation, because a copy that has already outlived
-- a window it never had should not vanish on the next sweep.
UPDATE project_restores
   SET expires_at = now() + interval '48 hours'
 WHERE expires_at IS NULL;

COMMENT ON COLUMN project_restores.expires_at IS
  'When this restored copy is soft-deleted automatically (P3e). Default 48h from '
  'creation, never more than 7 days. Soft-deleted rather than purged: the copy may '
  'be the only surviving good data, which is often why it exists.';

-- The sweep: restored projects whose deadline has passed.
CREATE INDEX IF NOT EXISTS project_restores_expiry_idx
  ON project_restores (expires_at)
  WHERE status = 'succeeded';

-- Moved here rather than edited into 20260901200000, which is already applied and
-- therefore immutable — the migrate tool refused the edit, correctly. It also
-- belongs here: a COMMENT ON is a comment the *database* carries, which is where
-- someone reading `\d+ project_restores` will actually look, unlike a comment in a
-- file they would have to know to open.
COMMENT ON COLUMN project_restores.reached_lsn IS
  'The load-bearing evidence a restore replayed WAL: a non-null replay LSN means '
  'recovery went past its base backup rather than starting there and stopping.';
COMMENT ON COLUMN project_restores.reached_time IS
  'Informational, and legitimately NULL. pg_last_xact_replay_timestamp() reports '
  'the last *transaction* replayed, and recovery can reach its target having '
  'replayed none — so requiring it would fail restores that worked (D-286).';
