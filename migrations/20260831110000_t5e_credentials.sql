-- Milestone 0 · T5e — credential storage and the addresses needed to reach a
-- project database.
--
-- project_secrets is the envelope-encryption table of D-035/D-075: ciphertext
-- and wrapped data key live here, the master key does not. A dump of this
-- database decrypts to nothing.
--
-- Column names follow the credentials doc (dek_wrapped / kek_id) rather than the
-- data-model doc's earlier `key_version integer`: a text kek_id is what makes
-- the master key a file named <kek_id>.key and KEK rotation an online re-wrap
-- job. D-188 records the resolution.

CREATE TABLE project_secrets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ciphertext   bytea NOT NULL,
  dek_wrapped  bytea NOT NULL,
  kek_id       text NOT NULL,
  -- 'active' is what a connection string renders from; 'retiring' is the
  -- previous version kept briefly so support can answer "which credential is my
  -- app on" (credentials doc §4a step 7).
  state        text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retiring')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  UNIQUE (project_id, name, version)
);

-- One active version per name, enforced by the database rather than by
-- convention: two active DEVELOPER_PASSWORD rows means the dashboard renders a
-- connection string that may or may not work.
CREATE UNIQUE INDEX project_secrets_one_active
  ON project_secrets (project_id, name) WHERE state = 'active';

CREATE INDEX project_secrets_project ON project_secrets (project_id);

CREATE TRIGGER project_secrets_updated_at
  BEFORE UPDATE ON project_secrets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- How the control plane reaches a node. `hostname` is an identity, not a route:
-- it is what the node calls itself, and it does not resolve from the control
-- plane in every environment (it does not resolve at all in local staging).
ALTER TABLE nodes ADD COLUMN address text;

COMMENT ON COLUMN nodes.address IS
  'Address the control plane connects to for this node (project ports, admin connections). Distinct from hostname, which is the node''s own identity.';

-- The customer-facing hostname for this project database. Derivable from ref
-- today; stored because the naming scheme is region- and generation-dependent
-- (see domain & region model) and an existing project must keep answering on the
-- name it was handed.
ALTER TABLE project_databases ADD COLUMN connection_host text;
