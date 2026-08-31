-- Milestone 0 · T8 — record what reconciliation found, on the node it examined.
--
-- The first question an operator asks about a reconciliation loop is not "what
-- drifted" but "is it running at all". A timestamp and the last report on the
-- node row answer that with a single SELECT, and outlive the log retention that
-- would otherwise be the only record.

ALTER TABLE nodes ADD COLUMN last_reconcile_at timestamptz;
ALTER TABLE nodes ADD COLUMN last_reconcile jsonb NOT NULL DEFAULT '{}';

COMMENT ON COLUMN nodes.last_reconcile IS
  'Report from the most recent node_reconcile sweep: drift found, repairs made, orphans alerted.';
