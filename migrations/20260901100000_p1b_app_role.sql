-- Phase 1 · P1b — a least-privilege application role.
--
-- Until now everything connected as `steadhold`, which owns the schema. That made
-- three claims in the corpus untrue at once: audit_logs was not append-only
-- (P1a's finding — privileges do not bind an owner), the application could drop
-- any table it could read, and "least privilege" (platform security, D-088
-- context) described nothing.
--
-- Two roles from here:
--
--   steadhold      owns the schema, runs migrations. Nothing else uses it.
--   steadhold_app  what the API and worker connect as. Reads and writes rows;
--                 cannot change the schema, cannot rewrite audit history.
--
-- The role is created NOLOGIN with no password, because a password in a migration
-- is a password in git. Enabling it is a separate, documented step that reads the
-- secret from the environment (`./scripts/staging.sh app-role` locally; the
-- secret store in production).

CREATE ROLE steadhold_app NOLOGIN;

-- Connect and see the schema, nothing more structural than that.
GRANT CONNECT ON DATABASE steadhold_control TO steadhold_app;
GRANT USAGE ON SCHEMA public TO steadhold_app;

-- Ordinary business tables: full row-level access, no DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, user_identities,
  organizations, organization_members, organization_invites,
  project_groups, projects, project_api_keys, project_secrets,
  nodes, project_databases, provisioning_jobs
TO steadhold_app;

-- audit_logs is the exception, and it is the whole point of splitting the role:
-- INSERT and SELECT only. No UPDATE, no DELETE, no TRUNCATE. P1a's trigger stops
-- the owner from rewriting history by mistake; this stops the application from
-- being *able* to, which is the guarantee that survives someone dropping the
-- trigger.
GRANT SELECT, INSERT ON audit_logs TO steadhold_app;

-- Sequences behind the identity/serial columns.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO steadhold_app;

-- Tables added by later migrations inherit the same shape, so a new table does
-- not silently arrive unreadable — or worse, arrive with the app unable to write
-- it and the failure surfacing in production rather than in the migration.
ALTER DEFAULT PRIVILEGES FOR ROLE steadhold IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO steadhold_app;
ALTER DEFAULT PRIVILEGES FOR ROLE steadhold IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO steadhold_app;

COMMENT ON ROLE steadhold_app IS
  'Application role for the control-plane API and worker. Rows yes, schema no, audit append-only. Enable LOGIN and set a password out of band; never in a migration.';
