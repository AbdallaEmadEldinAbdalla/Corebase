-- P6f — rows whose bytes are missing, held for operator review.
--
-- The reconciliation sweep's inverse pass looks for the failure the chosen write
-- orderings are supposed to make impossible: a `storage.objects` row with no
-- object behind it. D-124 is explicit that these are **bugs, not states** — the
-- upload path writes the object first and the delete path writes the row first
-- precisely so this cannot happen — so finding one means an assumption broke.
--
-- Hence quarantine rather than deletion. Auto-deleting the row would erase the
-- evidence of whatever caused it and silently shrink a customer's file list; the
-- honest response is to record it, alert, and let a human decide. That is also
-- why this table lives in the **control plane** rather than in the project's own
-- database: it is an operator's queue, and an operator looking for platform
-- faults should not have to visit two hundred project databases to find them.
CREATE TABLE storage_missing_objects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket       text NOT NULL,
  name         text NOT NULL,
  -- What the row claimed, so an operator can tell a truncated upload from a
  -- vanished object without going back to the project.
  expected_size bigint NOT NULL,
  etag         text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- How many sweeps have found it. A count that keeps rising is a different
  -- problem from a one-off: the first suggests an ongoing fault, the second a
  -- moment that has passed.
  seen_count   integer NOT NULL DEFAULT 1,
  resolved_at  timestamptz,
  UNIQUE (project_id, bucket, name)
);

-- Unresolved first: the queue an operator actually works from.
CREATE INDEX storage_missing_objects_open_idx
  ON storage_missing_objects (last_seen_at DESC) WHERE resolved_at IS NULL;
