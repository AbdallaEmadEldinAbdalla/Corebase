-- P4e: how long a session survives without being refreshed (sessions & tokens).

-- Refresh tokens have **no independent absolute expiry** in V1; a lineage's
-- lifetime is bounded by this and by revocation. So this number is the only thing
-- standing between "a token stolen from a device nobody uses any more" and
-- "forever".
--
-- 30 days is the doc's default and is the familiar one — it is roughly what a user
-- expects from "keep me signed in". Configurable because the right answer is a
-- product decision the customer owns: a banking app wants hours, a game wants
-- months, and the platform should not impose either.
--
-- The floor is an hour rather than a minute: below the access token's own lifetime
-- the setting stops meaning "idle timeout" and starts meaning "log out mid-session
-- for no visible reason", because a client that refreshes every 55 minutes would
-- find its session already dead.
ALTER TABLE project_auth_config
  ADD COLUMN IF NOT EXISTS session_idle_seconds integer NOT NULL DEFAULT 2592000
    CONSTRAINT project_auth_config_idle_check
      CHECK (session_idle_seconds BETWEEN 3600 AND 31536000);

COMMENT ON COLUMN project_auth_config.session_idle_seconds IS
  'A session with no refresh for this long is dead (P4e). Default 30 days. The '
  'floor is 1 hour because below one access-token lifetime it stops being an '
  'idle timeout and becomes a mid-session logout.';
