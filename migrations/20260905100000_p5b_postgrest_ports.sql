-- P5b: the ports a project's PostgREST listens on (D-011, rest-api-design).

-- A project is three containers now. Two ports rather than one because PostgREST
-- serves the API and its **admin server** separately, and the split is the whole
-- reason the admin server exists: `/live` says the process is up without touching
-- the database, `/ready` says it reached Postgres and built a schema cache. A
-- health gate that could only ask the first would pass a PostgREST that is
-- running and serving 503 to every request — which is exactly the state a missing
-- catalogue grant produces.
--
-- Nullable, and that is deliberate rather than lax: every project provisioned
-- before this migration has no PostgREST and no ports for one, and backfilling
-- numbers for containers that do not exist would make `UNIQUE (node_id, …)`
-- collide with the allocator the first time one of those projects is touched.
-- The saga allocates on demand; NULL means "no data API yet", which is the truth.
ALTER TABLE project_databases
  ADD COLUMN IF NOT EXISTS postgrest_port integer
    CONSTRAINT project_databases_pgrst_port_check
      CHECK (postgrest_port IS NULL OR postgrest_port BETWEEN 1024 AND 65535),
  ADD COLUMN IF NOT EXISTS postgrest_admin_port integer
    CONSTRAINT project_databases_pgrst_admin_port_check
      CHECK (postgrest_admin_port IS NULL OR postgrest_admin_port BETWEEN 1024 AND 65535),
  -- Its own container id, for the same reason the pooler has one: reconciliation
  -- and deletion both act on containers, and deriving an id from a name is how a
  -- renamed or recreated container becomes an orphan nobody removes.
  ADD COLUMN IF NOT EXISTS postgrest_container_id text;

-- Unique per node, like the other two ranges. Partial, because NULL is the normal
-- state for every pre-P5b project and a plain UNIQUE would be satisfied by them
-- all — Postgres treats NULLs as distinct — but writing it partial says the
-- intent out loud rather than relying on that.
CREATE UNIQUE INDEX IF NOT EXISTS project_databases_postgrest_port
  ON project_databases (node_id, postgrest_port) WHERE postgrest_port IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS project_databases_postgrest_admin_port
  ON project_databases (node_id, postgrest_admin_port) WHERE postgrest_admin_port IS NOT NULL;

COMMENT ON COLUMN project_databases.postgrest_port IS
  'The data API port (P5b). NULL means this project predates PostgREST and has '
  'no data API yet — not that one failed to start.';
COMMENT ON COLUMN project_databases.postgrest_admin_port IS
  'PostgREST''s admin server: /live without touching the database, /ready with. '
  'The health gate needs the second; a container-local check could only ever '
  'answer the first.';
