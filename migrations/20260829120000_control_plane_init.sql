-- Milestone 0 · T3 — control-plane schema, minimal cut.
--
-- DDL is copied verbatim from docs/02-control-plane/01-data-model.md so nothing
-- is thrown away when the rest of the model lands: only whole tables are
-- deferred, never columns or constraints from the tables that are here.
--
-- Present because T3 names them: projects, nodes, project_databases,
-- provisioning_jobs.
-- Present because those four would not be valid without them: organizations and
-- project_groups (projects.organization_id is NOT NULL; project_group_id has an
-- FK). Their own child tables (members, invites, users) are deferred to P1.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ── enums ───────────────────────────────────────────────────────────────────
CREATE TYPE project_status AS ENUM (
  'creating', 'provisioning', 'configuring', 'ready', 'failed',
  'pausing', 'paused', 'resuming',
  'deleting', 'soft_deleted', 'deleted'
);
CREATE TYPE project_environment AS ENUM ('development', 'preview', 'staging', 'production');
CREATE TYPE project_plan AS ENUM ('free', 'pro', 'team', 'enterprise');
CREATE TYPE database_status AS ENUM ('provisioning', 'running', 'paused', 'failed', 'deleting', 'deleted');
CREATE TYPE node_status AS ENUM ('active', 'cordoned', 'draining', 'retired');
CREATE TYPE job_state AS ENUM (
  'pending', 'enqueued', 'running', 'succeeded', 'failed', 'dead_letter'
);

-- ── organizations (FK parent; membership deferred to P1) ─────────────────────
CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

-- ── projects ────────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  ref              citext NOT NULL UNIQUE
                     CHECK (ref ~ '^[a-z][a-z0-9]{15,19}$'),
  name             text NOT NULL,
  region           text NOT NULL DEFAULT 'eu-central',
  status           project_status NOT NULL DEFAULT 'creating',
  plan             project_plan NOT NULL DEFAULT 'free',
  environment      project_environment NOT NULL DEFAULT 'production',
  project_group_id uuid REFERENCES project_groups(id) ON DELETE SET NULL,
  paused_at        timestamptz,
  deleted_at       timestamptz,
  purge_after      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('soft_deleted','deleted')) = (deleted_at IS NOT NULL)
         OR status = 'deleting')
);
CREATE INDEX idx_projects_org ON projects(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_purge ON projects(purge_after) WHERE status = 'soft_deleted';

-- ── nodes ───────────────────────────────────────────────────────────────────
CREATE TABLE nodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname        text NOT NULL UNIQUE,
  region          text NOT NULL DEFAULT 'eu-central',
  status          node_status NOT NULL DEFAULT 'active',
  ram_total_mb    integer NOT NULL CHECK (ram_total_mb > 0),
  ram_reserved_mb integer NOT NULL DEFAULT 0
                    CHECK (ram_reserved_mb >= 0 AND ram_reserved_mb <= ram_total_mb),
  disk_total_gb   integer NOT NULL,
  labels          jsonb NOT NULL DEFAULT '{}',
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_nodes_placement ON nodes(region, status) WHERE status = 'active';

-- ── project databases ───────────────────────────────────────────────────────
CREATE TABLE project_databases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  node_id       uuid NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  container_id  text,
  volume_name   text NOT NULL,
  port          integer NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  pooler_port   integer NOT NULL,
  pg_version    text NOT NULL DEFAULT '17',
  status        database_status NOT NULL DEFAULT 'provisioning',
  ram_limit_mb  integer NOT NULL,
  paused_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, port),
  UNIQUE (node_id, pooler_port)
);
CREATE INDEX idx_project_dbs_node ON project_databases(node_id);

-- ── jobs (state of record; Redis is delivery only — D-018) ───────────────────
CREATE TABLE provisioning_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  node_id         uuid REFERENCES nodes(id) ON DELETE SET NULL,
  job_type        text NOT NULL CHECK (job_type IN (
                    'provision_project', 'pause_project', 'resume_project',
                    'delete_project', 'rotate_credentials',
                    'create_backup', 'restore_backup', 'node_reconcile')),
  idempotency_key text NOT NULL UNIQUE,
  state           job_state NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  last_error      text,
  payload         jsonb NOT NULL DEFAULT '{}',
  checkpoint      jsonb NOT NULL DEFAULT '{}',
  heartbeat_at    timestamptz,
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_jobs_sweeper ON provisioning_jobs(state, scheduled_for)
  WHERE state IN ('pending', 'enqueued', 'running');
CREATE INDEX idx_jobs_project ON provisioning_jobs(project_id, created_at DESC);

-- ── updated_at maintenance ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_organizations_updated  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_projects_updated       BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_nodes_updated          BEFORE UPDATE ON nodes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_project_dbs_updated    BEFORE UPDATE ON project_databases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_jobs_updated           BEFORE UPDATE ON provisioning_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
