-- P4c: where an auth link may send someone (auth architecture, checklist item 6).

-- The project's own base URL, and the extra URLs an auth link may redirect to.
--
-- This is a **security control, not a convenience**. Every `redirect_to` a client
-- supplies is validated against these two, and an unlisted value falls back to
-- `site_url` rather than being honoured — which is what stops a verification or
-- recovery link from becoming an open redirect that carries a *live session's
-- tokens* to an attacker's host. A one-time token in a URL is a credential, so a
-- redirect that can be pointed anywhere is a credential-exfiltration primitive
-- with our domain's reputation attached to it.
--
-- NULL `site_url` means the project has configured nothing, and the code treats
-- that as "no redirect is allowed at all" rather than "any redirect is allowed":
-- the fail-closed direction, and the reason the column is nullable instead of
-- carrying a default nobody chose.
ALTER TABLE project_auth_config
  ADD COLUMN IF NOT EXISTS site_url text
    CONSTRAINT project_auth_config_site_url_check
      CHECK (site_url IS NULL OR site_url ~ '^https?://[^[:space:]]+$'),
  -- Origin-plus-path-prefix entries, e.g. `https://app.example.com/auth`. Bounded
  -- because it is matched linearly on a request path, and because an allowlist
  -- long enough to need an index is one nobody is auditing.
  ADD COLUMN IF NOT EXISTS additional_redirects text[] NOT NULL DEFAULT '{}'
    CONSTRAINT project_auth_config_redirects_check
      CHECK (array_length(additional_redirects, 1) IS NULL
             OR array_length(additional_redirects, 1) <= 32);

COMMENT ON COLUMN project_auth_config.site_url IS
  'The project''s base URL. Also the fallback for any redirect_to that is not '
  'allowlisted — never the supplied value (P4c). NULL means no redirect is '
  'permitted, which is the fail-closed reading.';
COMMENT ON COLUMN project_auth_config.additional_redirects IS
  'Extra allowed redirect targets, matched on exact origin plus path prefix. '
  'Max 32: an allowlist longer than that is one nobody audits.';
