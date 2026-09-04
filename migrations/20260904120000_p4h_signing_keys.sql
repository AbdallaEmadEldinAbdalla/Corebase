-- P4h: the keys a project publishes but is not signing with (sessions & tokens
-- §"Signing-key rotation runbook").

-- Why a table rather than more versions in `project_secrets`.
--
-- `project_secrets` enforces one *active* version per name, which is exactly
-- right for a password — two active DEVELOPER_PASSWORD rows means a connection
-- string that may or may not work. It is exactly wrong for a signing key during a
-- rotation, where the whole point is that **two keys are simultaneously
-- publishable**: the new one before it signs anything, and the old one after it
-- has stopped, so no verifier is ever holding a key set that lacks the key a
-- token was signed with.
--
-- So the currently-signing key stays where it always was — `JWT_PRIVATE_KEY`,
-- `JWT_PUBLIC_KEY`, `JWT_KID` in `project_secrets` — and nothing about signing
-- changes. This table holds the *others*, each with the role it is playing. A
-- project not mid-rotation has no rows here at all, which is what makes the
-- addition free for every existing project and needs no backfill.
--
-- Public keys sit in the clear, deliberately. They are public by definition, and
-- keeping them here means JWKS is one cheap query instead of an envelope
-- decryption per key — on an endpoint every verifier hits on every cold start.
CREATE TABLE IF NOT EXISTS project_signing_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kid         text NOT NULL CHECK (kid ~ '^[a-z0-9_]{4,64}$'),
  -- The public half only. The private half of a non-signing key lives in
  -- `project_secrets` under `JWT_PRIVATE_KEY_<KID>`, still envelope-encrypted:
  -- a `next` key must be able to start signing, and a `retired` one is kept so
  -- an audit can prove what signed a token six weeks ago.
  public_key_pem text NOT NULL,
  -- `next`      published, not yet signing — the dual-publish window, so cached
  --             verifiers already hold it before anything is signed with it.
  -- `retiring`  published, no longer signing — tokens and API keys minted under
  --             it must keep verifying until the swap window closes.
  -- `retired`   not published. The row and its ciphertext stay for audit; every
  --             token and API key under it is now dead.
  status      text NOT NULL CHECK (status IN ('next', 'retiring', 'retired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  -- When the old key may be dropped from JWKS. Gated on the **API-key** swap
  -- window (default 30 days, OQ-104) and not on token validity: the same keypair
  -- signs the long-lived anon/service_role keys (D-029, D-107), so user-token
  -- expiry alone would allow retirement after an hour and the API keys are the
  -- binding constraint by a factor of about seven hundred.
  retire_after timestamptz
);

-- One `next` at a time. Two would make "cut over to the new key" ambiguous, and
-- an operator resolving that ambiguity under pressure is the situation a rotation
-- runbook exists to avoid.
CREATE UNIQUE INDEX IF NOT EXISTS project_signing_keys_one_next
  ON project_signing_keys (project_id) WHERE status = 'next';
-- A kid appears once per project. It is the name a verifier selects a key by, so
-- two rows sharing one would make the selection non-deterministic.
CREATE UNIQUE INDEX IF NOT EXISTS project_signing_keys_kid
  ON project_signing_keys (project_id, kid);
-- The sweep that closes swap windows.
CREATE INDEX IF NOT EXISTS project_signing_keys_retire_idx
  ON project_signing_keys (retire_after) WHERE status = 'retiring';

COMMENT ON TABLE project_signing_keys IS
  'Keys a project publishes in its JWKS but is not signing with (P4h). The '
  'signing key itself stays in project_secrets; a project not mid-rotation has '
  'no rows here.';
COMMENT ON COLUMN project_signing_keys.retire_after IS
  'When the old key may leave JWKS. Gated on the API-key swap window (30 days, '
  'OQ-104), not on token expiry — the same keypair signs the anon/service_role '
  'keys, so those are the binding constraint.';
