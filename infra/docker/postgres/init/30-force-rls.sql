-- Fail closed by construction (D-083, amended by D-191): every table created in
-- the API-reachable schema gets RLS ENABLED at creation, so no policy means no
-- access for anon and authenticated rather than the Postgres default of "any
-- role with a grant sees everything".
--
-- FORCE is deliberately NOT applied. FORCE only affects the table's owner, and
-- the owner here is the customer's own `developer` role — forcing it means the
-- first `insert` after the first `create table` fails with "new row violates
-- row-level security policy", and every ORM, migration tool and seed script
-- breaks on a brand-new project. It buys no isolation: cross-tenant isolation is
-- the container boundary (D-009), and the API-facing roles are non-owners and so
-- are constrained by ENABLE alone. Testing policies as a role is the SQL
-- editor's job, not a reason to break the customer's own connection.
--
-- The event trigger is what makes this non-optional; a tooling-layer lint can be
-- bypassed by anyone with SQL access, and the whole point is that it cannot be.
CREATE SCHEMA IF NOT EXISTS corebase;

CREATE OR REPLACE FUNCTION corebase.force_rls_on_new_tables()
  RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
             WHERE command_tag = 'CREATE TABLE' AND schema_name = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
    RAISE NOTICE 'corebase: RLS enabled on % (no policies yet: anon and authenticated see nothing)',
      obj.object_identity;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS corebase_force_rls;
CREATE EVENT TRIGGER corebase_force_rls
  ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION corebase.force_rls_on_new_tables();
