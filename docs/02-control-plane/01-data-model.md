# Control-Plane Data Model

## Purpose

The complete PostgreSQL schema for the Steadhold control plane — the database that stores *who our customers are and what we run for them* (proposal §54–59), never *their* data (§121, D-040's routing keeps that boundary in [control vs data plane](../01-architecture/02-control-vs-data-plane.md)). This doc is the DDL of record: the first migration of the control-plane database is generated from it. Postgres 17 (D-037 applies to the control plane too, per D-012).

## Design

### What deliberately does NOT live here

The control plane stores metadata about projects; it never stores what projects contain:

| Not in the control plane | Where it lives instead |
|---|---|
| Customer application data (tables, rows) | Each project's own Postgres container (D-009) |
| Customer app *end-users* (the `auth` schema: users, sessions, refresh tokens of the customer's app) | The project database — see [auth architecture](../05-auth/01-auth-architecture.md) |
| Storage object metadata (`storage.objects`) | The project database (D-017) |
| Database passwords / plaintext credentials of any kind | Only envelope-encrypted ciphertext here (D-035); plaintext exists transiently in worker memory |
| Logs and metrics time series | Loki / Prometheus ([observability](../11-infrastructure/03-observability.md)); the control plane keeps only aggregated `usage_records` |
| Job execution state of the moment | BullMQ/Redis holds the *live* queue; Postgres `provisioning_jobs` is the state **of record** (D-018) |

Rule of thumb: if deleting a row would delete something a *customer's end-user* created, it does not belong in this schema.

### Conventions

- Primary keys: `uuid DEFAULT gen_random_uuid()`. Projects additionally carry an immutable human-facing `ref` slug (§57) used in URLs (`<ref>.steadhold.app`).
- All timestamps `timestamptz`, `created_at`/`updated_at` everywhere; `updated_at` maintained by a shared trigger (omitted below for brevity, defined once in the migration).
- Soft delete is `status` + `deleted_at`/`purge_after` on `projects` (D-038); other rows cascade or are retained for audit.
- No plaintext secrets in any column, ever (§58, D-035). API keys are stored as hash + display prefix only.

### DDL

```sql
-- ============================================================
-- Enumerated types
-- ============================================================
CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member');           -- §56

CREATE TYPE project_status AS ENUM (                                  -- §29 + D-008 + D-038
  'creating', 'provisioning', 'configuring', 'ready', 'failed',
  'pausing', 'paused', 'resuming',
  'deleting', 'soft_deleted', 'deleted'
);

CREATE TYPE project_environment AS ENUM (                              -- D-031
  'development', 'preview', 'staging', 'production'
);

CREATE TYPE project_plan AS ENUM ('free', 'pro', 'team', 'enterprise'); -- §51

CREATE TYPE database_status AS ENUM (
  'provisioning', 'running', 'paused', 'failed', 'deleting', 'deleted'
);

CREATE TYPE node_status AS ENUM ('active', 'cordoned', 'draining', 'retired');

CREATE TYPE job_state AS ENUM (
  'pending',      -- row written, not yet confirmed in BullMQ (two-phase enqueue)
  'enqueued',     -- confirmed present in Redis
  'running',
  'succeeded',
  'failed',       -- attempts remain; will be retried
  'dead'          -- attempts exhausted; operator attention required
);

CREATE TYPE subscription_status AS ENUM (
  'trialing', 'active', 'past_due', 'canceled', 'incomplete'
);

-- ============================================================
-- Platform accounts (dashboard/CLI users — NOT customer app users)
-- ============================================================
CREATE TABLE users (                                                   -- §55
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  password_hash  text,                    -- NULL when identity is OAuth-only
  email_verified boolean NOT NULL DEFAULT false,
  display_name   text,
  is_staff       boolean NOT NULL DEFAULT false,  -- Steadhold operators; gates admin API
  disabled_at    timestamptz,             -- abuse suspension without deletion
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

*Rationale:* `citext` for case-insensitive email uniqueness; `password_hash` (argon2id, see [platform security](../06-security/04-platform-security.md)) nullable because OAuth-only accounts have none. `is_staff` exists from day one so [operator access](05-audit-and-admin-access.md) never needs a schema change.

```sql
CREATE TABLE user_identities (                                         -- §55
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL,          -- 'github' | 'google' | ...
  provider_user_id text NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX idx_user_identities_user ON user_identities(user_id);
```

*Rationale:* one row per external identity; the unique pair prevents one GitHub account linking to two Steadhold users. Dashboard OAuth is post-V1 but the table costs nothing now (same logic as D-031).

```sql
-- ============================================================
-- Organizations & membership
-- ============================================================
CREATE TABLE organizations (                                           -- §56
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
```

*Rationale:* composite PK on membership — a user holds exactly one role per org. "Last owner cannot leave/demote" is an application invariant enforced in the [platform API](02-platform-api.md), not a constraint (requires counting, which constraints do badly). Invites store a hash, never the raw token, same rule as API keys.

```sql
-- ============================================================
-- Projects
-- ============================================================
CREATE TABLE project_groups (                                          -- D-031
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE projects (                                                -- §57
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  ref              citext NOT NULL UNIQUE                    -- immutable URL slug
                     CHECK (ref ~ '^[a-z][a-z0-9]{15,19}$'),
  name             text NOT NULL,          -- unique per ORG, not globally (D-217)
  region           text NOT NULL DEFAULT 'eu-central',       -- D-024: single region in V1
  status           project_status NOT NULL DEFAULT 'creating',
  plan             project_plan NOT NULL DEFAULT 'free',
  environment      project_environment NOT NULL DEFAULT 'production',  -- D-031
  project_group_id uuid REFERENCES project_groups(id) ON DELETE SET NULL, -- D-031
  paused_at        timestamptz,             -- D-008 bookkeeping
  deleted_at       timestamptz,             -- D-038: set on soft delete
  purge_after      timestamptz,             -- deleted_at + 7 days
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('soft_deleted','deleted')) = (deleted_at IS NOT NULL)
         OR status = 'deleting')
);
CREATE INDEX idx_projects_org ON projects(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_purge ON projects(purge_after)
  WHERE status = 'soft_deleted';           -- the purge sweeper's scan
```

*Rationale:* `ref` is generated (random, 16–20 lowercase chars), immutable, and globally unique — it is the tenant key the gateway resolves ([request pipeline](../04-data-api/02-request-pipeline.md)); `name` is a mutable display label. `ON DELETE RESTRICT` from org: orgs with projects can't be hard-deleted by accident — projects go through the [deletion pipeline](03-provisioning-state-machine.md) first. The `UNIQUE` on `ref` is *not* partial: refs are never reused, even after purge, so a stale bookmark can never hit a stranger's project.

```sql
-- ============================================================
-- Keys & secrets (hashes and ciphertext only — never plaintext)
-- ============================================================
CREATE TABLE project_api_keys (                                        -- §47
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

-- D-212: personal access tokens. D-062 names them and this table was missing —
-- project_api_keys holds a *project's* keys, not a *user's* CLI token. Same rule
-- as above: hash plus a display prefix, never the token.
CREATE TABLE user_access_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,      -- SHA-256 of the full `shp_…` token
  token_prefix text NOT NULL,             -- `shp_` + first 8, for display
  scopes       text[] NOT NULL DEFAULT '{}',   -- D-062's scoping, empty = full access
  expires_at   timestamptz,               -- NULL = no expiry (OQ-065 open)
  last_used_at timestamptz,               -- written by the resolve query itself
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_access_tokens_user ON user_access_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_access_tokens_live ON user_access_tokens(token_hash) WHERE revoked_at IS NULL;

-- D-188: column names follow the credentials doc; `kek_id` is text because the
-- master key is a file named <kek_id>.key, and an integer version cannot name one.
CREATE TABLE project_secrets (                                         -- §48, D-035
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  version      integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ciphertext   bytea NOT NULL,   -- secret encrypted under the data key (AAD: project_id, name, version)
  dek_wrapped  bytea NOT NULL,   -- per-secret data key, encrypted under the master key
  kek_id       text NOT NULL,    -- which master key wrapped this DEK (enables KEK rotation)
  state        text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retiring')),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  UNIQUE (project_id, name, version)
);
-- Exactly one active version per name, enforced by the database: two active rows
-- means the dashboard renders a connection string that may or may not work.
CREATE UNIQUE INDEX project_secrets_one_active
  ON project_secrets (project_id, name) WHERE state = 'active';
```

*Rationale:* envelope encryption per D-035 — decryption requires the KMS master key, so a control-plane DB dump alone leaks nothing. `key_version` makes master-key rotation a background re-wrap job (`rotate_credentials` in [job queue](04-job-queue-and-workers.md)) instead of a migration. API keys: the full key is shown exactly once at creation; thereafter only `key_prefix` is displayable. Verification at the gateway is JWT-signature-based (D-029/D-014); `key_hash` exists for revocation lookups.

```sql
-- ============================================================
-- Fleet: nodes & project databases
-- ============================================================
-- D-192: `address` is the route the control plane uses; `hostname` is identity.
CREATE TABLE nodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname      text NOT NULL UNIQUE,
  address       text,                    -- how the control plane reaches it (D-192)
  region        text NOT NULL DEFAULT 'eu-central',
  status        node_status NOT NULL DEFAULT 'active',
  ram_total_mb  integer NOT NULL CHECK (ram_total_mb > 0),
  ram_reserved_mb integer NOT NULL DEFAULT 0
                  CHECK (ram_reserved_mb >= 0 AND ram_reserved_mb <= ram_total_mb),
  disk_total_gb integer NOT NULL,
  labels        jsonb NOT NULL DEFAULT '{}',
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_nodes_placement ON nodes(region, status)
  WHERE status = 'active';

CREATE TABLE project_databases (                                       -- §58
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  node_id       uuid NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  container_id  text,                     -- Docker container id; NULL while paused
  volume_name   text NOT NULL,            -- survives pause (D-008)
  port          integer NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  pooler_port   integer NOT NULL,
  pg_version    text NOT NULL DEFAULT '17',                            -- D-037
  connection_host text,                   -- customer-facing name, written at provision time
  status        database_status NOT NULL DEFAULT 'provisioning',
  ram_limit_mb  integer NOT NULL,         -- the cgroup limit; sums into node accounting
  paused_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, port),
  UNIQUE (node_id, pooler_port)
);
CREATE INDEX idx_project_dbs_node ON project_databases(node_id);
```

*Rationale:* capacity accounting is `SELECT ... FOR UPDATE` on the node row: the placement step reserves `ram_limit_mb` into `ram_reserved_mb` transactionally, so two concurrent provisions cannot oversubscribe a node (density math in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md)). `container_id` nullable + `volume_name` non-null encodes D-008: pausing destroys the container, never the volume. `ON DELETE RESTRICT` from nodes: a node with databases on it must be drained, not deleted. Connection *credentials* are not here — they live in the secrets table, encrypted (§58's "never plaintext passwords" rule).

```sql
-- ============================================================
-- Jobs (state of record; Redis is a delivery mechanism — D-018)
-- ============================================================
CREATE TABLE provisioning_jobs (                                       -- §30, §75
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL, -- NULL for node-scoped jobs
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
  checkpoint      jsonb NOT NULL DEFAULT '{}',  -- saga step cursor (see state machine doc)
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
```

*Rationale:* `idempotency_key UNIQUE` is the crash-safety anchor of the whole [two-phase enqueue](04-job-queue-and-workers.md): re-submitting an intent collides here instead of double-provisioning (§75–76). `checkpoint` stores the last completed saga step so a retried job resumes rather than restarts. The partial index is exactly what the sweeper scans.

```sql
-- ============================================================
-- Audit (append-only — see 05-audit-and-admin-access.md)
-- ============================================================
CREATE TABLE audit_logs (                                              -- §59
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

REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;
-- The application role receives INSERT and SELECT only (see 05-audit-and-admin-access.md).
--
-- D-215: the REVOKE alone does NOT make this append-only, and the build proved it
-- — privileges do not bind a table's owner, and the application connected as the
-- owner. A statement trigger raising on UPDATE/DELETE does bind the owner, and
-- D-216 splits the application off the owner role so the privilege half becomes
-- real too. Both layers ship; neither alone is enough.
CREATE OR REPLACE FUNCTION steadhold_audit_is_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END $$;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION steadhold_audit_is_append_only();
```

*Rationale:* deliberately **no foreign keys** — audit rows must survive deletion of everything they reference. `bigint` identity, not uuid: monotonic ids make gap detection (tamper evidence) trivial. Grants make it append-only at the database layer, not just by convention.

```sql
-- ============================================================
-- Billing & metering (§51–53)
-- ============================================================
CREATE TABLE billing_customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE RESTRICT,
  provider             text NOT NULL DEFAULT 'stripe',
  provider_customer_id text NOT NULL UNIQUE,
  billing_email        citext NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_customer_id      uuid NOT NULL REFERENCES billing_customers(id) ON DELETE RESTRICT,
  provider_subscription_id text NOT NULL UNIQUE,
  plan                     project_plan NOT NULL,
  status                   subscription_status NOT NULL,
  current_period_start     timestamptz NOT NULL,
  current_period_end       timestamptz NOT NULL,
  canceled_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_customer ON subscriptions(billing_customer_id);

CREATE TABLE usage_records (                                           -- §53
  id           bigint GENERATED ALWAYS AS IDENTITY,
  project_id   uuid NOT NULL,             -- no FK: usage outlives the project for invoicing
  metric       text NOT NULL CHECK (metric IN (
                 'db_size_bytes', 'storage_size_bytes', 'egress_bytes',
                 'api_requests', 'auth_active_users', 'backup_size_bytes',
                 'compute_seconds')),
  quantity     numeric NOT NULL CHECK (quantity >= 0),
  period_start timestamptz NOT NULL,
  period_end   timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, period_start)
) PARTITION BY RANGE (period_start);
-- Monthly partitions created by a scheduled job; e.g.:
-- CREATE TABLE usage_records_2026_09 PARTITION OF usage_records
--   FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE INDEX idx_usage_project_metric
  ON usage_records(project_id, metric, period_start DESC);
```

*Rationale:* metering is a firehose relative to everything else in this schema — range partitions keep the hot set small and make retention a `DROP TABLE` (§53's "don't build billing into individual services": services emit events, the metering worker aggregates into these rows; pricing logic reads them in [pricing & plans](../12-business/02-pricing-and-plans.md)). Stripe (or equivalent) remains the money source of truth; these tables mirror only what quota enforcement and invoicing need.

### Entity relationship sketch

```text
users ──< user_identities
users ──< organization_members >── organizations ──< organization_invites
                                   organizations ──< project_groups
                                   organizations ──< projects ──── project_databases >── nodes
                                   organizations ─── billing_customers ──< subscriptions
projects ──< project_api_keys
projects ──< project_secrets
projects ──< provisioning_jobs (also node-scoped)
(no FK)     audit_logs, usage_records   — reference by id, survive deletion
```

## Decisions

- **D-060 — API keys and all bearer tokens are stored hash-only (SHA-256) plus a 12-char display prefix; the full value is shown exactly once at creation and is never recoverable from the control plane.** *(Rationale: a control-plane read compromise must not yield working credentials; the prefix is enough for dashboard identification and support tickets.)*
- **D-061 — Soft delete is modeled as `status` + `deleted_at` + `purge_after` on `projects`; child rows are removed only at purge time via FK cascade, and `projects.ref` values are never reused, even after purge.** *(Rationale: restore-within-7-days (D-038) must be a pure status flip with all children intact; permanent ref retirement prevents a recycled slug from ever pointing a stale client at another tenant's project.)*

Binding design rules carried by this doc without their own D numbers (they follow from D-002/D-018 and the DDL above): node capacity is reserved transactionally (`SELECT ... FOR UPDATE` on `nodes`) at placement time, before any container exists — the DB is the only serialization point concurrent workers share; and `usage_records` is monthly-range-partitioned with pre-aggregated rows only, never per-request events.

## Open Questions

- OQ-040: Aggregation granularity for `usage_records` — hourly vs daily rows per (project, metric). Hourly enables intra-day quota cutoffs (abuse response) at ~24× the row count. Decide alongside [abuse prevention](../12-business/03-abuse-prevention.md).
- OQ-041: Does `project_members` (§54 lists it) ship in V1, or is org-level RBAC enough until agencies arrive (D-003)? Currently **omitted** from the DDL; the API treats all org members as project members. Revisit at V1.x.
- OQ-042: `ref` length/alphabet final form (currently 16–20 lowercase alphanumeric, letter-first for DNS-safety) — must be validated against the wildcard-TLS and subdomain scheme in [domain & region model](../01-architecture/04-domain-and-region-model.md).

## Dependencies

- Builds on: [../01-architecture/02-control-vs-data-plane.md](../01-architecture/02-control-vs-data-plane.md), [../01-architecture/03-multi-tenancy-and-isolation.md](../01-architecture/03-multi-tenancy-and-isolation.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-008, D-012, D-018, D-029, D-031, D-035, D-037, D-038)
- Feeds: [02-platform-api.md](02-platform-api.md), [03-provisioning-state-machine.md](03-provisioning-state-machine.md), [04-job-queue-and-workers.md](04-job-queue-and-workers.md), [05-audit-and-admin-access.md](05-audit-and-admin-access.md), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md), [../03-database-platform/03-credentials-and-secrets.md](../03-database-platform/03-credentials-and-secrets.md), [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md)
