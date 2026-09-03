-- P4f: how many addresses must confirm an email change (flows §9).

-- Default `double`, and the reasoning is the most interesting in the auth config
-- because both single-sided options are broken in opposite ways:
--
--   * confirming only the **new** address lets an attacker holding a hijacked
--     session silently re-point the account to their own mailbox — and then own
--     password reset forever, which converts a temporary session compromise into
--     permanent account ownership;
--   * confirming only the **old** address lets a user lock themselves onto a
--     typo'd, unreachable new address, which is unrecoverable without support.
--
-- Old-address confirmation proves the legitimate owner approves; new-address
-- confirmation proves the destination is real and theirs. Projects may relax to
-- `new_only` because some products genuinely prefer the support burden to the
-- friction, but they have to say so.
ALTER TABLE project_auth_config
  ADD COLUMN IF NOT EXISTS email_change_confirm text NOT NULL DEFAULT 'double'
    CONSTRAINT project_auth_config_email_change_check
      CHECK (email_change_confirm IN ('double', 'new_only'));

COMMENT ON COLUMN project_auth_config.email_change_confirm IS
  'double (default) requires both the old and the new address to confirm an '
  'email change; new_only requires the new one. Single-sided old-only is not '
  'offered — it cannot prove the destination is reachable (P4f).';
