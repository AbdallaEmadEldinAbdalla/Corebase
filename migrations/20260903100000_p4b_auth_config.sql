-- P4b: per-project auth configuration (auth architecture §D-110).

-- D-110 puts a project's auth config — lifetimes, whether confirmation is
-- required, the redirect allowlist — in the *control plane*, resolved per request,
-- because the auth module is one multi-tenant process serving every project. It
-- cannot hold per-project settings in its own configuration file; there is one
-- process and thousands of projects.
--
-- A row per project is created lazily: a project with no row gets the column
-- defaults, which are the doc's V1 defaults. That is deliberate rather than lazy —
-- it means an existing project needs no backfill to have correct auth behaviour,
-- and a default changed here changes it for every project that never overrode it.
CREATE TABLE IF NOT EXISTS project_auth_config (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,

  -- Skip email confirmation and hand back a session at signup.
  --
  -- Default OFF, and this is the one setting where the default is a security
  -- decision: with autoconfirm on, anybody can create an account on somebody
  -- else's email address and use it. It exists because local development against
  -- a Docker stack has no mail server, and the dashboard shows a standing warning
  -- while it is on (flows §1 step 6).
  autoconfirm boolean NOT NULL DEFAULT false,

  -- Close signup without taking the project down. An app in private beta, or one
  -- being abused, needs this to be one flag rather than a redeploy.
  disable_signup boolean NOT NULL DEFAULT false,

  -- Access-token life. The doc's range is 5 minutes to 24 hours: shorter than
  -- five minutes and clients spend more time refreshing than working, longer than
  -- a day and a revoked session stays usable for a day (D-113 — revocation kills
  -- refresh, not the token already issued).
  access_token_ttl_seconds integer NOT NULL DEFAULT 3600
    CONSTRAINT project_auth_config_ttl_check CHECK (access_token_ttl_seconds BETWEEN 300 AND 86400),

  -- The project's own password floor. Ours is 12 for platform accounts; a
  -- customer's users are the customer's product decision, so the default is the
  -- doc's 8 and the ceiling is 32 (past which it stops being a security control
  -- and starts being a support burden).
  password_min_length integer NOT NULL DEFAULT 8
    CONSTRAINT project_auth_config_pw_check CHECK (password_min_length BETWEEN 8 AND 32),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE project_auth_config IS
  'Per-project auth settings, read by the multi-tenant auth module on every '
  'request (D-110). A missing row means "all defaults" — no backfill needed.';
COMMENT ON COLUMN project_auth_config.autoconfirm IS
  'Development-only. On means an unverified email address gets a working session, '
  'so anyone can sign up as anyone. The dashboard warns while it is set.';
