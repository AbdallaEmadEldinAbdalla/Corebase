-- Findings from the P2 review: two foreign keys to users(id) with no ON DELETE.
--
-- Both default to NO ACTION, so deleting a user fails with a foreign-key violation
-- if they ever invited anyone or created an API key. There is no user-deletion path
-- yet, which is exactly why this is worth fixing now: the first person to write one
-- would hit it as a mystery constraint error rather than as a design question.
--
-- SET NULL rather than CASCADE in both cases, because the row is not *about* the
-- user. An invitation and an API key outlive whoever created them; losing the
-- attribution is a small loss, losing the key or the invite is a real one — and
-- CASCADE on `project_api_keys` would silently delete a live credential's record
-- while the credential itself kept working, which is the worst of both.
--
-- `audit_logs` deliberately has no foreign keys at all (see its definition): audit
-- history must outlive every row it refers to, including the user.

ALTER TABLE organization_invites
  DROP CONSTRAINT IF EXISTS organization_invites_invited_by_fkey;
ALTER TABLE organization_invites
  ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE organization_invites
  ADD CONSTRAINT organization_invites_invited_by_fkey
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE project_api_keys
  DROP CONSTRAINT IF EXISTS project_api_keys_created_by_fkey;
ALTER TABLE project_api_keys
  ADD CONSTRAINT project_api_keys_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN organization_invites.invited_by IS
  'Who sent it. NULL once that user is deleted — the invitation outlives them.';
COMMENT ON COLUMN project_api_keys.created_by IS
  'Who minted it. NULL once that user is deleted — the key outlives them.';
