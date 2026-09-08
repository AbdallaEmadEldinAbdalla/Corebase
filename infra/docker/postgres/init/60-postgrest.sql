-- P5b: what PostgREST needs from the project's own database.
--
-- Two things, both referenced by the per-project `postgrest.conf` and neither of
-- which PostgREST can create for itself. A config naming a `db-pre-request` that
-- does not exist makes **every request fail** — so these arrive with the image, at
-- `initdb`, for the same reason the auth schema does (D-314): they are fleet-wide
-- and identical, and `initdb` is the one moment when no client can see a
-- half-created state.

-- ── the pre-request hook (D-105) ───────────────────────────────────────────
--
-- PostgREST calls this at the start of every request's transaction. Its job is to
-- put the request id into `application_name`, so a slow query found in
-- `pg_stat_activity` — or in a log line, or in a lock wait — can be traced back to
-- the HTTP request that caused it. Without it a customer reporting "the API was
-- slow at 14:03" leaves an operator correlating timestamps by hand.
--
-- SECURITY DEFINER, owned by the superuser, because it runs as whichever role the
-- request selected — `anon` included — and `set_config` on `application_name` is
-- not something an anonymous caller should be granted directly.
CREATE OR REPLACE FUNCTION steadhold.pre_request() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  req_id text;
BEGIN
  -- The gateway forwards its request id as a PostgREST-mapped header, which
  -- arrives here as a GUC. `true` on current_setting means "NULL if unset" rather
  -- than an error: a request without the header is normal — a developer's own
  -- curl, for instance — and must not fail.
  req_id := current_setting('request.headers', true)::json ->> 'x-request-id';
  IF req_id IS NOT NULL THEN
    -- Truncated: application_name is limited to NAMEDATALEN-1 (63) bytes and
    -- Postgres silently truncates past it. Doing it here keeps the value
    -- recognisable rather than arbitrarily clipped, and the prefix is what makes
    -- it greppable next to the pooler's and the auth module's connections.
    PERFORM set_config('application_name', 'pgrst:' || left(req_id, 56), true);
  END IF;
EXCEPTION WHEN others THEN
  -- Never fail a request for a bookkeeping hook. A malformed header, a JSON cast
  -- that throws, a future PostgREST that stops setting `request.headers` — none
  -- of those are reasons to return 500 to a customer whose query was fine.
  NULL;
END;
$$;

REVOKE ALL ON FUNCTION steadhold.pre_request() FROM PUBLIC;
-- USAGE on the schema as well as EXECUTE on the function. They are separate
-- privileges and only having the second produces `permission denied for schema
-- steadhold` on **every request that carries a token** — the API comes up, answers
-- `/ready` with 200, and then fails everything, which reads as an authorization
-- bug in the customer's policies rather than a missing grant in ours.
--
-- USAGE lets these roles resolve names in `steadhold`; it does not let them run
-- anything, because every other function in here keeps the REVOKE above.
GRANT USAGE ON SCHEMA steadhold TO authenticator, anon, authenticated, service_role;
-- Only the roles a request can actually run as. `authenticator` is included
-- because it is the login role, and PostgREST calls the hook before `SET LOCAL
-- ROLE` on some paths.
GRANT EXECUTE ON FUNCTION steadhold.pre_request() TO authenticator, anon, authenticated, service_role;

COMMENT ON FUNCTION steadhold.pre_request() IS
  'PostgREST db-pre-request (D-105): stamps the request id into application_name '
  'so a slow query can be traced back to the HTTP request. Never raises.';

-- ── schema-cache reload on DDL (D-100) ─────────────────────────────────────
--
-- PostgREST caches the catalog, and a stale cache after DDL is *the* classic
-- embedded-PostgREST failure: "I created the table and the API 404s". This makes
-- the reload automatic and source-agnostic — the dashboard's table editor,
-- `steadhold db push` and a developer in raw psql all get it, and no code path in
-- Steadhold has to remember to poke anything.
--
-- Separate from `steadhold_force_rls` deliberately, even though both fire on DDL.
-- They fail differently and for different reasons: force-RLS is a security
-- posture whose failure must be loud, and this is a cache hint whose failure must
-- not be. One trigger doing both would have to pick one of those behaviours.
CREATE OR REPLACE FUNCTION steadhold.pgrst_reload() RETURNS event_trigger
LANGUAGE plpgsql AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN others THEN
  -- A DDL statement must not fail because a cache hint could not be sent. The
  -- worst case is a stale cache, which the reconciler's SIGUSR1 fallback and the
  -- next DDL both fix.
  NULL;
END;
$$;

DROP EVENT TRIGGER IF EXISTS steadhold_pgrst_reload;
CREATE EVENT TRIGGER steadhold_pgrst_reload
  ON ddl_command_end
  EXECUTE FUNCTION steadhold.pgrst_reload();

-- `drop` is its own event, and a dropped table is exactly the case where a stale
-- cache serves a 200 for something that no longer exists.
DROP EVENT TRIGGER IF EXISTS steadhold_pgrst_reload_drop;
CREATE EVENT TRIGGER steadhold_pgrst_reload_drop
  ON sql_drop
  EXECUTE FUNCTION steadhold.pgrst_reload();

COMMENT ON FUNCTION steadhold.pgrst_reload() IS
  'Event-trigger body for D-100: NOTIFY pgrst on DDL so the schema cache reloads '
  'without a restart, whatever issued the DDL. Never raises.';
