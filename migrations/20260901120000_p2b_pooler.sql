-- P2b: a project is two containers now — Postgres and its PgBouncer (D-015).
--
-- The pooler's container id is recorded for the same reason the database's is:
-- the delete and purge sagas act on ids, and a saga that can only find containers
-- by derived name cannot clean up after a rename or a partial failure. Nullable
-- because every project provisioned before this migration has no pooler, and
-- because the column is written after the container is confirmed running.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS pooler_container_id text;

COMMENT ON COLUMN project_databases.pooler_container_id IS
  'PgBouncer container id (P2b). NULL until start_pooler confirms it running.';
