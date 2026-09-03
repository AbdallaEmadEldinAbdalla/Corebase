-- P4d: the email pipeline's control-plane state (email infrastructure §bounces).

-- Addresses we will not send to, and why.
--
-- Two lists in one table, distinguished by `project_id`: NULL is the **global**
-- list, a non-NULL id is that project's own. One table rather than two because
-- the enqueue check is a single query against both (§bounces step 4 orders the
-- check global → project → caps → send), and two tables would mean two round
-- trips on the hot path plus two places for the same shape to drift.
--
-- Why suppression exists at all: a sending domain's reputation is scored on how
-- much of its mail bounces. Continuing to send to an address that hard-bounced is
-- the single most effective way to convince an inbox provider that we are a
-- spammer — and on shared infrastructure that judgement lands on every project.
CREATE TABLE IF NOT EXISTS email_suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = global. An address on the global list is a spam trap or long dead, and
  -- protecting the shared domain outranks any one project's wish to retry it.
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  -- Stored lowercased by the writer. Not a generated column, because the
  -- canonical form of an address is a judgement (only the domain is truly
  -- case-insensitive) and the one we commit to is "lowercase the whole thing",
  -- which is what every provider's suppression list does.
  email       text NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual')),
  -- The provider's own event payload, for answering "why is this address
  -- suppressed" six weeks later without a support ticket to the provider.
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per (list, address). A repeated bounce updates rather than accumulates:
-- a suppression list that grows a row per event is a list nobody can read, and the
-- count of events belongs in the metrics, not in the key.
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_project_key
  ON email_suppressions (project_id, lower(email)) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_global_key
  ON email_suppressions (lower(email)) WHERE project_id IS NULL;

COMMENT ON TABLE email_suppressions IS
  'Addresses that will not be sent to. project_id NULL is the global list '
  '(§bounces step 3: an address that hard-bounces across three or more projects '
  'is a trap or dead, and protects the shared domain).';

-- Every send attempt, and what became of it.
--
-- Its first job is answering the developer's question — "why did my user not get
-- the email?" — which is unanswerable from a queue, because a queue's job is gone
-- once it succeeds and its failure has no project attached. Its second is being
-- the row of record: D-018 says Redis is delivery and never truth, and until now
-- the only record that a mail was owed was the one-time token, which says nothing
-- about whether sending was attempted or refused.
CREATE TABLE IF NOT EXISTS email_sends (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The queue's delivery id, so a job and its row can be matched from either end.
  delivery_id  text NOT NULL,
  template     text NOT NULL,
  recipient    text NOT NULL,
  status       text NOT NULL CHECK (status IN
                 ('queued', 'sent', 'failed', 'suppressed', 'rate_limited')),
  -- Counts attempts, not retries: 1 means the first try. The retry budget is
  -- three, so a row at 3 that is still `failed` is dead-lettered.
  attempts     integer NOT NULL DEFAULT 0,
  -- The provider's id for the message, which is the only way to correlate a
  -- delivery or bounce webhook back to this row.
  provider_id  text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The same delivery id must not produce two sends. This is what makes the whole
-- pipeline idempotent: a worker that crashes after sending and before recording
-- retries, and the insert is what stops that retry becoming a second email in
-- somebody's inbox.
CREATE UNIQUE INDEX IF NOT EXISTS email_sends_delivery_key
  ON email_sends (project_id, delivery_id);
-- The developer's view: this project's recent mail, newest first.
CREATE INDEX IF NOT EXISTS email_sends_project_idx
  ON email_sends (project_id, created_at DESC);

COMMENT ON TABLE email_sends IS
  'One row per owed email and what became of it (P4d). Exists so a developer can '
  'be told why a user got no mail — suppressed, rate-limited, failed — which a '
  'queue cannot answer.';
COMMENT ON COLUMN email_sends.attempts IS
  'Attempts, not retries: 1 is the first try. Budget is 3 (30s/5min/30min), so a '
  'row at 3 and still failed has been dead-lettered.';
