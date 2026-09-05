-- Per-project role model (D-029, D-108). Created at provision time so it is
-- never retrofitted — Milestone 0 T5 runs this even though nothing uses it yet.
--
-- authenticator is the only login role PostgREST uses; it can do nothing itself
-- and only SET ROLE into anon / authenticated (NOINHERIT is what makes that safe).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- bypasses RLS by role attribute, never by permissive policy (D-082)
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'corebase_admin') THEN
    -- audited dashboard/DDL path; never handed to customer apps (D-132)
    CREATE ROLE corebase_admin NOINHERIT LOGIN PASSWORD NULL CREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_auth') THEN
    -- The pooler's own identity (D-074). It can do exactly one thing: call the
    -- lookup function below. The worker sets its password at provision time, so
    -- no credential is baked into the image.
    CREATE ROLE pgbouncer_auth NOINHERIT LOGIN PASSWORD NULL;
  END IF;

  -- P4a: the auth module's identity. Passwordless here, given a password at
  -- provision. It is the only role with table privileges in the `auth` schema
  -- (25-auth-schema.sql), which is what keeps the end-user password hashes out of
  -- reach of every role a customer's API traffic can arrive as — service_role
  -- included, since BYPASSRLS does not grant table privileges.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'corebase_auth') THEN
    CREATE ROLE corebase_auth NOINHERIT LOGIN PASSWORD NULL;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;

-- Schema usage. NOTE the asymmetry, and it is deliberate (D-108):
-- anon gets USAGE on the schema but NO table privileges. New tables are not
-- readable by anon until explicitly granted, so the failure mode is 403, never
-- an accidental public dump.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;

-- Customer roles never get filesystem or program execution (D-080).
REVOKE ALL ON SCHEMA information_schema FROM PUBLIC;

-- …but `authenticator` gets it back, because PostgREST builds its schema cache by
-- introspecting `information_schema` and `pg_catalog` (P5b). Without this it
-- starts, connects, and then answers **every request with 503** while logging
-- `permission denied for schema information_schema` — a project that looks
-- provisioned and serves nothing.
--
-- This is not a hole in the revoke above. That revoke exists so `anon` and
-- `authenticated` — the roles a *request* runs as — cannot enumerate a schema
-- they have no table grants on. `authenticator` is different in kind: it is the
-- login role that never queries as itself (NOINHERIT, D-074), and it holds a
-- password only the control plane has. Reading the catalogue is the entire job
-- PostgREST logs in to do, and `SET LOCAL ROLE` drops to a customer role before
-- any of the customer's data is touched.
GRANT USAGE ON SCHEMA information_schema TO authenticator;
GRANT SELECT ON ALL TABLES IN SCHEMA information_schema TO authenticator;
