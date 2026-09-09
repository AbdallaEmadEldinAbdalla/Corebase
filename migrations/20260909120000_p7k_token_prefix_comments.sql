-- P7k · the token prefix, recorded where a rename can reach it.
--
-- This migration exists because of a mistake rather than a feature. The credential
-- prefix rename (D-433) edited the SQL comments inside
-- `20260901110000_p1c_access_tokens.sql`, which had already been applied — so the
-- runner's checksum check refused to run at all, and since it exits non-zero it
-- would have blocked every *later* migration too. The commit that did it said "the
-- migration change is comment-only; no schema is affected", which was true of the
-- schema and false of the runner, and its verification ran against a database that
-- was already migrated, so nothing exercised this path.
--
-- The lesson is the runner's own error message: applied migrations are immutable,
-- add a new one instead. That file is now restored to the bytes that were applied,
-- and the current prefix lives here — as real `COMMENT ON` metadata rather than a
-- SQL comment, which means it is queryable, it is the one place to update if the
-- prefix ever moves again, and `\d+ user_access_tokens` shows it.
--
-- `COMMENT ON` is idempotent: it replaces whatever the column's comment was.

COMMENT ON COLUMN user_access_tokens.token_hash IS
  'SHA-256 of the full shp_… token. The token itself is never stored.';

COMMENT ON COLUMN user_access_tokens.token_prefix IS
  'shp_ plus the first 8 characters, for telling two tokens apart in the UI.';

-- Said here too, because a reader of the schema should not have to find the
-- dashboard to learn it: the column exists, and nothing reads it for
-- authorization. `kernel/principal.ts` carries it into the resolved principal and
-- no code path checks it, so a token with scopes = '{read}' has the same access as
-- one with '{}'. D-062 is where scoping actually gets built.
COMMENT ON COLUMN user_access_tokens.scopes IS
  'NOT ENFORCED. Stored since P1c so adding scopes is not a migration; no code '
  'authorizes against it yet, so every token has full account access (D-062).';
