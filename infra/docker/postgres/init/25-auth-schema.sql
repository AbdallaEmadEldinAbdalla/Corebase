-- The `auth` schema's tables (P4a, D-110, auth architecture §"The auth schema").
--
-- Runs after 20-auth-helpers, which creates the schema and the RLS helpers that
-- anon/authenticated/service_role are allowed to call. This file adds the tables,
-- which they are *not*.
--
-- Why it lives in the image rather than in a saga step: it is fleet-wide, it is
-- identical for every project, and initdb is the one moment when no client can
-- observe a half-created schema. It also means a project's users exist in the
-- project's own database from its first second — customers' users are their data
-- (D-004), so `corebase export` carries them out with a plain `pg_dump` and
-- nothing about a project's end-users is ever stored in the control plane.

-- The platform's own auth identity. Passwordless here; the control plane sets its
-- password at provision (the same pattern as pgbouncer_auth, D-074).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'corebase_auth') THEN
    CREATE ROLE corebase_auth NOINHERIT LOGIN PASSWORD NULL;
  END IF;
END
$$;

-- PUBLIC loses the schema outright. The explicit grants in 20-auth-helpers give
-- anon/authenticated/service_role USAGE so they can call auth.uid() and friends —
-- that is deliberately all they get, and the tables below are the reason it
-- matters: `auth.users.encrypted_password` must be unreachable from any role a
-- customer's API traffic can arrive as, including service_role, which bypasses RLS
-- and would therefore be limited by nothing else.
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO corebase_auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text,
  -- The password hash, parameters included. scrypt rather than the argon2id the
  -- auth doc names: D-211 already settled that trade for platform logins and its
  -- reasoning applies with more force here, because this module absorbs every
  -- project's login load in one process. See the decision recorded for P4a.
  -- NULL for OAuth-only users (V1.1).
  encrypted_password  text,
  email_confirmed_at  timestamptz,
  banned_until        timestamptz,
  -- User-writable via PUT /auth/v1/user. RLS policies and application
  -- authorization must never trust it; privileged flags belong in
  -- raw_app_meta_data, which only service_role may write.
  raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_anonymous        boolean NOT NULL DEFAULT false,
  last_sign_in_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

-- Case-insensitive, and partial so a soft delete frees the address for
-- re-registration while the row stays for the app's foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON auth.users (lower(email))
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at  timestamptz,
  user_agent         text,
  ip                 inet,
  revoked_at         timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON auth.sessions (user_id);

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- sha256 of the opaque token. The plaintext is never stored, so a dump of this
  -- table is not a set of usable credentials — which is the whole difference
  -- between a leaked database and a leaked session for every user.
  token_hash  bytea NOT NULL UNIQUE,
  user_id     uuid  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id  uuid  NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  -- Rotation lineage. Reuse detection is a walk up this chain: a token presented
  -- after it was already used means the family is compromised, and the family is
  -- exactly what `parent_id` describes.
  parent_id   bigint REFERENCES auth.refresh_tokens(id),
  used_at     timestamptz,
  revoked     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_session_idx ON auth.refresh_tokens (session_id);

CREATE TABLE IF NOT EXISTS auth.one_time_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_type  text NOT NULL CHECK (token_type IN
                ('confirmation','recovery','email_change_current',
                 'email_change_new','magic_link')),
  token_hash  bytea NOT NULL,
  -- e.g. the proposed new email for an email change.
  relates_to  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  -- Newest token per type replaces the previous, which is what makes "resend"
  -- safe: the old link stops working the moment a new one is issued.
  UNIQUE (user_id, token_type)
);

-- Created in V1, populated from V1.1 (OAuth). Present now because the shape
-- mirrors GoTrue's deliberately (the same portability argument as D-011): it eases
-- migration *to* Corebase, and a table added later is a migration every customer
-- has to run.
CREATE TABLE IF NOT EXISTS auth.identities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          text NOT NULL,
  provider_user_id  text NOT NULL,
  identity_data     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at   timestamptz,
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS auth.audit_log_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL for anonymous attempts, which are the ones worth counting: a login that
  -- failed has no user to attribute it to and is exactly what an enumeration or
  -- credential-stuffing attempt looks like.
  actor_user_id  uuid,
  action         text NOT NULL,
  ip             inet,
  user_agent     text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON auth.audit_log_entries (created_at);

-- The only role with table privileges here. Note what is *not* granted: no
-- default privileges are altered for this schema, so a table added to `auth`
-- later is unreadable by the API roles until somebody says otherwise — the same
-- fail-closed asymmetry D-108 chose for `public`.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO corebase_auth;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO corebase_auth;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO corebase_auth;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT USAGE, SELECT ON SEQUENCES TO corebase_auth;
