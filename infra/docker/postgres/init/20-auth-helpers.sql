-- The bridge from a verified JWT to SQL predicates (D-015, RLS design).
-- The request's claims arrive as a GUC set with SET LOCAL inside the request
-- transaction — the only session-state pattern that survives transaction
-- pooling (D-015).
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb,
           '{}'::jsonb) $$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(auth.jwt() ->> 'sub', '')::uuid $$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT auth.jwt() ->> 'role' $$;

-- Helpers must be callable by the API roles, but the schema's tables must not be.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role()
  TO anon, authenticated, service_role;
