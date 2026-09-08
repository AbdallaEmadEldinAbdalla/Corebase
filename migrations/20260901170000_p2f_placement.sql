-- P2f: bin-packing needs the node table to be honest about two things.

-- A disk ceiling the database enforces, mirroring the RAM one that has been
-- there since the control plane's first migration.
--
-- The packer already refuses to cross 85% of either axis, and this is the
-- backstop for the case where the packer is wrong — which is the case that
-- matters, because a booking that oversubscribes disk produces no error at all
-- until a tenant tries to write. RAM had this from day one and disk did not,
-- which is the same asymmetry that let placement ignore disk entirely until P2e.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'nodes_disk_reserved_within_total'
  ) THEN
    ALTER TABLE nodes ADD CONSTRAINT nodes_disk_reserved_within_total
      CHECK (disk_reserved_gb <= disk_total_gb);
  END IF;
END
$$;

-- A node registered with no disk is not a node with infinite headroom.
--
-- `ram_total_mb` has carried `CHECK (> 0)` since the beginning; `disk_total_gb`
-- did not, so a node registered with 0 was a division by zero waiting for a
-- ratio to be computed. The packer treats a zero-capacity axis as full rather
-- than empty, deliberately — this makes the row impossible in the first place.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nodes_disk_total_positive') THEN
    ALTER TABLE nodes ADD CONSTRAINT nodes_disk_total_positive CHECK (disk_total_gb > 0);
  END IF;
END
$$;

-- The candidate scan: active nodes in one region, every sweep and every
-- provision. Small today at one node, and the index is what keeps the packer's
-- two-pass selection cheap when the fleet is not.
CREATE INDEX IF NOT EXISTS nodes_placement_idx
  ON nodes (region, status, last_seen_at);

COMMENT ON COLUMN nodes.last_seen_at IS
  'Heartbeat, re-asserted on every reconcile pass. Placement refuses a node that '
  'has gone quiet (SH_NODE_STALE_SECONDS): status stays active when a worker dies, '
  'and a project placed there hangs in creating rather than failing (P2f).';
