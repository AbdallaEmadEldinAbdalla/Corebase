# Migrations

## Purpose

Specifies the migration system (proposal §43, D-028): the file format, the tracking table, the precise semantics of `db push` / `db pull` / `db reset` and the V1.1 `db diff`, and — the part every BaaS gets wrong first — what happens when dashboard table-editor changes and local migration files diverge. Plain SQL throughout, because migrations are half the portability story (D-004): a Steadhold migrations directory must run against any Postgres.

## Design

### 1. File format

```
steadhold/                   # scaffolding owned by the CLI spec (steadhold init)
├── migrations/
│   ├── 20260827130000_add_profiles.sql
│   └── 20260829091500_profiles_rls.sql
└── seed.sql                # sibling of migrations/ — dev-only, applied by db reset, never by db push
```

- Filename: `<UTC timestamp YYYYMMDDHHMMSS>_<snake_case_name>.sql`, created by `steadhold migration create <name>`. Timestamp is the version; lexicographic order = application order. Collisions (two developers, same second) are resolved at push time by full-filename ordering and are harmless because push is transactional per file.
- Content: **plain SQL only** (D-028). No DSL, no up/down pairs in V1 — rollbacks are forward migrations (write the inverse SQL), consistent with the restore-based recovery posture ([backups & PITR](05-backups-and-pitr.md)). Any `psql`-free SQL is legal; `\` meta-commands are not (files are executed via the driver, not psql).
- One directive comment is recognized:

```sql
-- steadhold:no-transaction
CREATE INDEX CONCURRENTLY idx_posts_author ON posts (author_id);
```

for statements that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE ... ADD VALUE` pre-PG17-semantics, `VACUUM`). Without the directive, every migration runs in its own transaction.

### 2. The tracking table

Created in each project database (and each local dev database) on first contact, in a Steadhold-owned schema so `db pull` and customer tooling can ignore it cleanly:

```sql
CREATE SCHEMA IF NOT EXISTS steadhold_migrations;
CREATE TABLE steadhold_migrations.schema_migrations (
  version        text PRIMARY KEY,      -- '20260827130000'
  name           text NOT NULL,         -- 'add_profiles'
  checksum       text NOT NULL,         -- sha256 of file bytes
  applied_at     timestamptz NOT NULL DEFAULT now(),
  execution_ms   integer,
  applied_by     text NOT NULL          -- 'cli:<user email>' | 'dashboard:<user id>'
);
```

The checksum makes tampering with already-applied files detectable: history is append-only, and editing an applied migration is an error, not a convenience.

### 3. Command semantics

All remote commands run over `DIRECT_DATABASE_URL` ([pooling §2](02-connection-pooling.md) — DDL through a transaction pooler is asking for trouble), against the linked project (`steadhold link`, [CLI spec](../10-cli-and-sdk/01-cli-spec.md)).

**`db push`** — apply pending local migrations to the linked project:

1. Take a session advisory lock (`pg_advisory_lock(hashtext('steadhold_db_push'))`) — two concurrent pushes must serialize.
2. Read `schema_migrations`; verify every already-applied version's checksum against the local file. Mismatch ⇒ **abort** with a diff hint (someone edited history).
3. Compute pending = local files not in the table, ordered by version. A local file *older* than the newest applied version ⇒ warn (out-of-order merge from a branch) and require `--include-out-of-order` to apply it.
4. Run drift detection (§6). Drift ⇒ warn, require `--force` or a `db pull` reconcile first.
5. For each pending file, in order: `BEGIN` → execute → insert tracking row → `COMMIT` (or the no-transaction path per §1, which inserts its tracking row after successful completion).
6. **Stop on first failure.** The failed migration's transaction rolls back; earlier ones stay applied (each is its own transaction — the tracking table is why this is safe to resume). Print the failing statement, error position, and `request_id`.

**`db pull`** — introspect the remote schema into a baseline migration:

- Output: one `migrations/<ts>_remote_baseline.sql` (or `_remote_changes.sql` when a baseline exists) containing, in dependency order: extensions (`CREATE EXTENSION`), schemas, types/enums/domains, sequences, tables (columns, defaults, constraints, PKs/FKs), indexes, views/materialized views, functions/procedures/triggers, **RLS enablement and policies** (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `CREATE POLICY ...` from `pg_policies`), grants on the above, comments.
- Excluded: Steadhold-managed schemas (`steadhold_migrations`, `auth`, `storage`, `steadhold`) — those are platform-owned and versioned by the platform, not the customer ([storage architecture](../07-storage/01-storage-architecture.md), [auth architecture](../05-auth/01-auth-architecture.md)).
- On a fresh pull against a project with applied migrations, pull also writes the remote's `schema_migrations` state into the local project file so push agrees about history.

**`db reset`** — local development only, absolute:

1. Target check: reset refuses to run against anything but the local `steadhold dev` stack ([local development](../10-cli-and-sdk/02-local-development.md)). Concretely: the target host must be the compose-project's Postgres container. There is **no flag** that points reset at a linked remote — not `--force`, not `--yes`. Resetting production is done by nobody, ever; recovering production is a restore ([backups & PITR §4](05-backups-and-pitr.md)).
2. Drop and recreate the local database, re-apply the Steadhold base schema, replay all migrations in order, then apply `seed.sql` if present.

Worked `db push` output (the contract the CLI implements — errors are the product, §90 spirit):

```
$ steadhold db push
Linked project: acme-prod (proj_8f3k2)
Verified 12 applied migrations (checksums OK)
Drift check: clean
Applying 2 pending migrations over DIRECT_DATABASE_URL:
  ✓ 20260827130000_add_profiles.sql            (transaction, 142 ms)
  ✗ 20260829091500_profiles_rls.sql
    ERROR 42P01 at line 7: relation "profile" does not exist
    LINE 7: CREATE POLICY read_own ON profile ...
    Rolled back. 1 of 2 applied; fix the file and push again.
    request_id: req_01J9XW...
```

**CI usage**: `db push` is non-interactive by design (exit codes per the [CLI spec](../10-cli-and-sdk/01-cli-spec.md)'s reserved table, which owns them: 0 success, 1 migration error, 5 refused-by-state — drift or checksum mismatch, distinguished via stderr and the `--json` payload, not the exit code), so `steadhold db push` in a deploy pipeline against a staging project, then production, is the recommended promotion flow — with `CI=true` disabling every prompt and never implying `--force`.

**`db diff`** — V1.1 (D-028), shadow-database approach:

1. Start a scratch `postgres:17` container (locally: via the dev stack; the same image as prod, D-027/D-037).
2. Apply all local migrations to the scratch DB → this is "schema as declared".
3. Introspect scratch and target (linked remote or local dev) into a canonical model (the same introspection engine as `db pull` — build once, use twice).
4. Emit migra-style SQL that transforms target-schema into declared-schema, written to a new migration file for **human review** — destructive statements (`DROP TABLE/COLUMN`) are emitted commented-out with a warning header. Diff is a generator, never an applier.
5. Out of scope for diff, documented loudly: data migrations, reorderings that require table rewrites, and anything the canonical model doesn't capture (exotic options) — the escape hatch is hand-written SQL, which is always legal because migrations are just SQL.

### 4. Authoring guidance we ship with the feature

Migrations run against live databases behind a 20-connection instance ([provisioning §3](01-postgres-provisioning.md)); the docs page generated from this section teaches the lock-safety patterns rather than hiding them:

| Intent | Naive (long lock / rewrite) | Documented pattern |
|---|---|---|
| Add NOT NULL column | `ADD COLUMN x type NOT NULL DEFAULT ...` on huge tables pre-11 lore; fine on PG17 but teach the general shape | `ADD COLUMN` (with default — PG17 is non-rewriting) → backfill if needed → `SET NOT NULL` |
| Add constraint | `ADD CONSTRAINT ... CHECK/FK` (full-table scan under lock) | `ADD CONSTRAINT ... NOT VALID` in one migration → `VALIDATE CONSTRAINT` in the next (short lock + concurrent scan) |
| New index on live table | `CREATE INDEX` (blocks writes) | `-- steadhold:no-transaction` + `CREATE INDEX CONCURRENTLY` |
| Rename in production | `ALTER TABLE ... RENAME` breaking deployed app versions | Expand/contract: add new, dual-write in app, migrate reads, drop old in a later migration |

The CLI adds one guardrail: a lint pass before push flags `CREATE INDEX` (non-concurrent) and `VACUUM FULL`/`CLUSTER` on non-empty public tables as warnings — advisory only in V1, never blocking (`--quiet-lint` silences).

### 5. Dashboard table-editor changes → migrations

Every table-editor operation compiles to SQL and shows it before running (proposal §41, [table editor](../09-dashboard/02-table-editor.md)). On execution against a project, the dashboard offers **"Save as migration"**: the SQL is recorded as a proper migration (row in `schema_migrations`, file surfaced for download / `db pull`). Two modes:

- **Save as migration (default-on for linked projects):** the change enters history like a pushed file; local repos pick it up via `db pull`, which emits it as a migration file.
- **Run without saving:** allowed (it's the customer's database), but it creates *drift* — handled next.

### 6. The drift problem and the chosen stance

Reality: users click around in the production dashboard, their local `migrations/` diverges from the live schema, and the next `db push` either fails confusingly or, worse, "succeeds" onto a schema it wasn't written against. Options considered:

| Stance | Verdict |
|---|---|
| Block dashboard DDL on "linked" projects (migrations-only prod) | Safest, but kills the five-minute experience (§80) — V1 users *start* in the table editor |
| Ignore it (Supabase's long-time default) | The support-ticket generator we're here to avoid |
| **Record everything, detect drift, make reconcile one command** | Chosen — D-076 |

Mechanism (D-076):

1. **Every** DDL statement in a project database is captured by an event trigger into `steadhold_migrations.ddl_log(id, executed_at, username, command_tag, object_identity, ddl_text)` — dashboard, CLI, psql over `DIRECT_DATABASE_URL`, all of it. (Event triggers can't capture every statement's exact text for all command types; where the text is unavailable we log the command tag + object identity — enough for drift *detection* and attribution, with `db pull` as the reconstruction tool.)
2. **Drift detection** at `db push` time (§3 step 4): drift = `ddl_log` entries newer than the last applied migration that did not come from a recorded migration or a saved-as-migration dashboard action.
3. **Reconcile** = `db pull --changes`: emits the drift as a new migration file (introspection-based, so it's correct even where `ddl_text` was partial), marks the log entries reconciled, and push proceeds cleanly.
4. Dashboard shows a persistent **"unsaved schema changes: N"** badge when the log has unreconciled entries — drift is visible where it's created, not just where it breaks.

The stance in one line: **the migration history is the source of truth, but the platform's job is to make ad-hoc changes converge into it, not to forbid them.**

## Decisions

**D-076 — Drift handling: all project DDL is captured via event trigger into `steadhold_migrations.ddl_log`; dashboard DDL offers "save as migration" (default-on for linked projects); `db push` performs checksum verification of applied history and refuses on unreconciled drift (override `--force`); `db pull --changes` converts drift into a migration file and marks it reconciled; `db reset` is structurally local-only with no remote override flag.** *(Rationale: forbidding prod dashboard edits kills the first-five-minutes experience while ignoring them silently corrupts the migration story; capture-detect-reconcile keeps migration history authoritative without policing how users touch their own database, and an un-overridable local-only reset removes the single most catastrophic CLI foot-gun.)*

(D-028 governs format and command set; D-004 governs the plain-SQL portability constraint. Both implemented here.)

## Open Questions

- **OQ-076** — `db diff` engine: port migra's comparison logic to TypeScript (one language, D-010) vs. shelling out to migra/atlas in a container (faster to ship, adds a runtime dependency to the CLI). Decide at V1.1 kickoff; the shared introspection engine from `db pull` shifts the balance toward native.
- **OQ-077** — Should `db push` acquire read-only mode / a maintenance banner for long-running migrations (table rewrites) on paid plans, or is the advisory lock + documentation enough for V1? Depends on how [SQL editor](../09-dashboard/03-sql-editor.md) surfaces long-running DDL.

## Dependencies

- Builds on: [decision log](../00-foundation/05-decision-log.md) (D-004, D-028), [connection pooling](02-connection-pooling.md) (direct-URL requirement), [CLI spec](../10-cli-and-sdk/01-cli-spec.md), [local development](../10-cli-and-sdk/02-local-development.md)
- Feeds: [table editor](../09-dashboard/02-table-editor.md), [SQL editor](../09-dashboard/03-sql-editor.md), [RLS design](../06-security/02-rls-design.md) (policies as migrations), [backups & PITR](05-backups-and-pitr.md), [v1 scope](../14-roadmap/02-v1-scope-and-cutlist.md)
