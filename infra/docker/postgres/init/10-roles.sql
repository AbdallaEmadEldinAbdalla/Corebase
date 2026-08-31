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
