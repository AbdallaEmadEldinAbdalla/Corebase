-- Phase 1 · P1a — the tables Milestone 0 deferred: identity, membership, keys, audit.
--
-- DDL copied from docs/02-control-plane/01-data-model.md, same rule as T3: whole
-- tables may be deferred, columns and constraints may not. What lands here is
-- everything Phase 1's exit criteria need — two users in one org with different
-- roles, an audit row per mutation, hashed keys — plus `user_identities` and
-- `organization_invites`, which cost nothing now and would otherwise force a
-- migration on the day dashboard OAuth or team invites ship.

CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member');           -- §56

-- ── identity ────────────────────────────────────────────────────────────────
CREATE TABLE users (                                                 -- §55
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  password_hash  text,                    -- NULL when identity is OAuth-only
  email_verified boolean NOT NULL DEFAULT false,
  display_name   text,
  is_staff       boolean NOT NULL DEFAULT false,  -- Corebase operators; gates admin API
  disabled_at    timestamptz,             -- abuse suspension without deletion
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_identities (                                       -- §55
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL,          -- 'github' | 'google' | ...
  provider_user_id text NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX idx_user_identities_user ON user_identities(user_id);

-- ── membership ──────────────────────────────────────────────────────────────
CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            org_role NOT NULL DEFAULT 'member',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX idx_org_members_user ON organization_members(user_id);

CREATE TABLE organization_invites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  role            org_role NOT NULL DEFAULT 'member',
  invited_by      uuid NOT NULL REFERENCES users(id),
  token_hash      text NOT NULL,           -- invite accept-token, hashed
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

-- ── project API keys ────────────────────────────────────────────────────────
-- Hash-only (D-060): a control-plane read compromise must not yield working
-- credentials. The prefix exists so the dashboard and support can identify a key
-- without holding it.
CREATE TABLE project_api_keys (                                      -- §47
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('anon', 'service_role')), -- D-029
  key_hash     text NOT NULL,        -- SHA-256 of the full JWT
  key_prefix   text NOT NULL,        -- first 12 chars, for dashboard display / support
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  UNIQUE (key_hash)
);
CREATE INDEX idx_api_keys_project ON project_api_keys(project_id) WHERE revoked_at IS NULL;

-- ── audit ───────────────────────────────────────────────────────────────────
-- Deliberately no foreign keys: an audit row must survive the deletion of
-- everything it references, and an FK is a promise that it will not. bigint
-- identity rather than uuid because monotonic ids make gap detection — the
-- cheapest tamper evidence available — a single query.
CREATE TABLE audit_logs (                                            -- §59
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid,          -- no FK: audit must outlive the org row
  project_id      uuid,
  actor_user_id   uuid,          -- NULL when actor is the system or an operator token
  actor_type      text NOT NULL DEFAULT 'user'
                    CHECK (actor_type IN ('user', 'system', 'operator', 'api_key')),
  action          text NOT NULL,           -- 'project.created', 'secret.updated', ...
  resource_type   text NOT NULL,
  resource_id     text,
  metadata        jsonb NOT NULL DEFAULT '{}',  -- before/after, secrets always redacted
  ip              inet,
  request_id      text,                    -- D-032 correlation
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org_time ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_project_time ON audit_logs(project_id, created_at DESC);

-- Append-only, in two layers, because the first one alone does not work.
--
-- The REVOKE is the doc's mechanism and it is necessary but not sufficient:
-- privileges do not bind a table's OWNER, and in Milestone 0 the application
-- connects as the same role that owns the schema. Verified by doing it — the
-- UPDATE succeeded on the first run of this migration.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;

-- So a trigger, which does bind the owner. This stops the realistic threat:
-- application code — or a mistake in it — rewriting or deleting audit history.
-- It is NOT a wall against a determined holder of the owner role, who can drop
-- the trigger as easily as they could re-grant themselves the privilege. The
-- actual wall is a least-privilege application role that does not own the
-- schema, which is P1b's job; this makes the guarantee real for everything
-- reaching the database through the application in the meantime.
CREATE OR REPLACE FUNCTION corebase_audit_is_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING HINT = 'Audit history is evidence. Correct the record by appending, never by editing.';
END $$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION corebase_audit_is_append_only();

-- ── the bootstrap org gains an owner ────────────────────────────────────────
-- Milestone 0 ran with one hardcoded org and no users at all. Phase 1's model
-- requires every org to have an owner, so the dev org gets one rather than
-- becoming the single row that violates the invariant everything else assumes.
-- The password hash is deliberately absent: this account cannot log in until
-- someone sets a password through the API.
INSERT INTO users (email, display_name, email_verified)
VALUES ('dev@corebase.local', 'Development Owner', true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO organization_members (organization_id, user_id, role)
SELECT o.id, u.id, 'owner'
  FROM organizations o
  CROSS JOIN users u
 WHERE o.slug = 'dev' AND u.email = 'dev@corebase.local'
ON CONFLICT (organization_id, user_id) DO NOTHING;
