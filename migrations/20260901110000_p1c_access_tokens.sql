-- Phase 1 · P1c — personal access tokens.
--
-- Not in the data-model doc, which specifies `project_api_keys` for a project's
-- anon/service_role keys but has nowhere to put the *user's* token for the CLI
-- (D-062 names it; nothing stores it). D-212 records the gap and this table
-- closes it; the doc is updated to match.
--
-- Same rule as project_api_keys (D-060): hash only, plus a display prefix. A
-- control-plane read compromise must not yield a working token, and the prefix is
-- what lets the dashboard and a support ticket talk about a token nobody holds.

CREATE TABLE user_access_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,              -- 'laptop', 'ci', whatever the user calls it
  token_hash  text NOT NULL UNIQUE,       -- SHA-256 of the full `cbp_…` token
  token_prefix text NOT NULL,             -- `cbp_` + first 8, for display
  -- Scopes are D-062's future: a CI token that can deploy but not delete. Stored
  -- from day one so adding them is not a migration, empty meaning full access.
  scopes      text[] NOT NULL DEFAULT '{}',
  expires_at  timestamptz,                -- NULL = no expiry (OQ-065 is still open)
  last_used_at timestamptz,               -- so a user can see which token is live
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_access_tokens_user ON user_access_tokens(user_id)
  WHERE revoked_at IS NULL;

-- Lookup is by hash on every authenticated request, so it must be an index seek.
CREATE INDEX idx_access_tokens_live ON user_access_tokens(token_hash)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON user_access_tokens TO steadhold_app;
