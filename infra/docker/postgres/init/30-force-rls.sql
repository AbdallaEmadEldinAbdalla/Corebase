-- Fail closed by construction (D-083): every API-reachable table gets RLS
-- ENABLED and FORCED at creation. No policy therefore means no access, rather
-- than the Postgres default of "table owner sees everything".
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
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', obj.object_identity);
    RAISE NOTICE 'corebase: RLS enabled and forced on %', obj.object_identity;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS corebase_force_rls;
CREATE EVENT TRIGGER corebase_force_rls
  ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION corebase.force_rls_on_new_tables();
