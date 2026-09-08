-- PgBouncer's auth_query path (D-074).
--
-- The pooler needs to resolve a connecting user's SCRAM verifier. The two ways to
-- do that are a `userlist.txt` on the pooler or a lookup function in Postgres, and
-- the file loses: every credential rotation would have to regenerate and ship it,
-- then RELOAD the pooler, and a stale copy shows up as a mystery auth failure
-- *after* the rotation looked successful. With auth_query, `ALTER ROLE … PASSWORD`
-- is immediately effective and there is nothing to keep in sync.
--
-- Two properties make this safe rather than merely convenient:
--
--   SECURITY DEFINER is what lets a role with no privileges read pg_shadow — and
--   `SET search_path = pg_catalog` is what stops a caller from shadowing `pg_shadow`
--   with their own relation and having this function read it instead. A SECURITY
--   DEFINER function without a pinned search_path is a privilege-escalation bug.
--
--   The allowlist inside the function is a boundary, not a filter. The pooler can
--   never resolve credentials for `postgres`, `authenticator`, `steadhold_admin` or
--   `pgbouncer_auth` itself, so the pooled port cannot become a route to an
--   internal role even if PgBouncer is fully compromised. Only `developer` — the
--   one customer-facing role that connects through the pooler — is resolvable.

CREATE SCHEMA IF NOT EXISTS steadhold;

CREATE OR REPLACE FUNCTION steadhold.pgbouncer_lookup(p_user text)
  RETURNS TABLE (usename name, passwd text)
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = pg_catalog
AS $$
  SELECT usename, passwd
  FROM pg_shadow
  WHERE usename = p_user
    AND usename IN ('developer');
$$;

REVOKE ALL ON FUNCTION steadhold.pgbouncer_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION steadhold.pgbouncer_lookup(text) TO pgbouncer_auth;

-- The pooler connects to Postgres to run the lookup, so it needs to reach the
-- database at all. USAGE on the schema and nothing else — it has no table rights
-- anywhere, and CONNECT is granted to PUBLIC by default which we do not widen.
GRANT USAGE ON SCHEMA steadhold TO pgbouncer_auth;
