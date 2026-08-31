-- D-185: no password-free path into a project database, anywhere.
--
-- initdb's defaults leave `trust` on the local socket and on loopback, so any
-- code running inside the container becomes Postgres superuser without a
-- credential. The image sets --auth-local=peer --auth-host=scram-sha-256 so
-- that cannot happen; this script is the enforcement, because a silently
-- dropped build arg would otherwise reopen the hole with no visible symptom.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(format('%s %s %s -> %s', type, database, address, auth_method), '; ')
    INTO offending
    FROM pg_hba_file_rules
   WHERE auth_method = 'trust';

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'D-185 violated: pg_hba.conf grants trust authentication (%)', offending;
  END IF;

  -- The inverse check: host connections must be scram, not md5 or password.
  SELECT string_agg(format('%s %s -> %s', type, address, auth_method), '; ')
    INTO offending
    FROM pg_hba_file_rules
   WHERE type LIKE 'host%' AND auth_method NOT IN ('scram-sha-256', 'cert', 'reject');

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'D-185 violated: weak host auth method in pg_hba.conf (%)', offending;
  END IF;
END $$;
