# Table Editor

## Purpose

The table editor at `/project/[ref]/table-editor` (proposal §41): schema management and row browsing without leaving the browser — under one non-negotiable rule that keeps a GUI from becoming a footgun: **every UI operation compiles to visible SQL, and the SQL is what runs.** The editor is a SQL *generator with a preview*, never a black box. This doc specs the interaction pattern, the operation→SQL catalog, the data grid and its execution path, and the per-table RLS panel.

## Design

### The rule and the interaction pattern (§41)

Every schema-changing action follows one loop:

```
user acts in UI  →  SQL preview panel shows the EXACT statement(s)
                →  user confirms (warning ladder may add friction, below)
                →  executed via the admin path (D-132), result or error shown
                →  offered: [Save as migration]
```

- The **SQL preview panel** is a docked, read-only, syntax-highlighted pane. It shows the verbatim DDL — not a summary, not pseudo-SQL. Power users can flip it to *editable* before confirming (at which point the form greys out and the SQL is authoritative).
- **Save as migration** records the executed SQL server-side as a proper migration (D-076): a row in `schema_migrations` plus a correctly named plain-SQL migration file per D-028 (`migrations/20260827131500_add_posts_table.sql`), surfaced for download / copy-to-clipboard and emitted by `db pull` into the repo the CLI manages. A saved change therefore enters history exactly like a pushed file — it is **not** drift ([migrations](../03-database-platform/04-migrations.md), D-076; save-as-migration is default-on for linked projects). Dashboard DDL that is *not* saved is, by that doc's drift stance, drift: captured in `ddl_log`, reconciled via `db pull --changes` in V1 and diffable via `db diff` in V1.1. Every executed statement is additionally recorded in the project's executed-DDL history (visible under the editor's "History" tab) so nothing done in the GUI is ever unreconstructible; the remaining export/journal details are OQ-131.

### Operation → SQL catalog

Warning ladder: **(i) info** — plain confirm; **(ii) caution** — amber confirm explaining locks/rewrites; **(iii) destructive** — red confirm requiring the object's name typed back.

| UI operation | Generated SQL shape | Ladder |
|---|---|---|
| Create table | `CREATE TABLE public.posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(), …);` followed by `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;` (D-083 — always appended, shown in the preview, not hidden) | i |
| Rename table | `ALTER TABLE public.posts RENAME TO articles;` | ii — "REST endpoint `/rest/v1/posts` changes; clients referencing it break" |
| Drop table | `DROP TABLE public.posts;` (`RESTRICT` implicit; a dependents list is shown — CASCADE only via explicit checkbox that re-renders the preview with `CASCADE` and escalates the warning) | iii — type table name |
| Add column | `ALTER TABLE … ADD COLUMN status text NOT NULL DEFAULT 'draft';` (NOT NULL without default on a non-empty table is blocked with the reason) | i |
| Rename column | `ALTER TABLE … RENAME COLUMN status TO state;` | ii — API field name changes |
| Change column type | `ALTER TABLE … ALTER COLUMN price TYPE numeric(10,2) USING price::numeric(10,2);` — the editor always emits an explicit `USING`, pre-filled with the straight cast and editable for real conversions | ii — "table rewrite; ACCESS EXCLUSIVE lock for the duration" (row-count shown) |
| Drop column | `ALTER TABLE … DROP COLUMN legacy_flag;` | iii — type column name |
| Set / drop NOT NULL, default | `ALTER TABLE … ALTER COLUMN … {SET NOT NULL \| DROP NOT NULL \| SET DEFAULT … \| DROP DEFAULT};` | i (SET NOT NULL: ii — full-table validation scan) |
| Create index | `CREATE INDEX idx_posts_author_id ON public.posts (author_id);` — strategy for `CONCURRENTLY` (can't run in a transaction) is OQ-132 | ii on large tables |
| Drop index | `DROP INDEX idx_posts_author_id;` | ii |
| Add foreign key | `ALTER TABLE public.posts ADD CONSTRAINT posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON DELETE …;` — **fan-in warning:** if the referencing column has no index, the preview carries an inline notice ("deletes/updates on `users` will seq-scan `posts`") with a one-click "also create index", which appends the `CREATE INDEX` to the preview | ii |
| Drop constraint | `ALTER TABLE … DROP CONSTRAINT …;` | ii |
| Add CHECK / UNIQUE | `ALTER TABLE … ADD CONSTRAINT … {CHECK (…) \| UNIQUE (…)};` | ii — validation scan / possible failure on existing rows (failure surfaces the offending constraint error verbatim) |

Relationship/ERD view: **deferred to V1.1** (cut in [dashboard IA](01-dashboard-ia.md)).

**Worked example of the loop** — user creates table `posts` with a `title text not null` column in the dialog. The preview panel shows:

```sql
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text not null
);

alter table public.posts enable row level security;
alter table public.posts force row level security;
```

Confirm executes all three statements as one run (one transaction) via the D-132 path. The success toast offers **Save as migration**, producing `20260827131500_create_posts.sql` with exactly that content — nothing normalized, nothing reformatted. The name suffix is derived from the operation and editable before download.

### Data grid and the execution path

**Execution path (D-132):** dashboard → platform API (`POST /v1/projects/:ref/db/query`) → the project's Postgres over the platform's own connection, running as a dedicated **`corebase_admin`** role. Explicitly **not** the public data API with a `service_role` key, because:

1. `service_role` in a browser is a standing leak risk; the session-cookie platform API keeps customer-DB power server-side (D-062).
2. PostgREST's surface can't express DDL, `USING` casts, or introspection — the editor needs raw SQL.
3. Centralizing on the platform API gives every editor statement the standard envelope, `request_id` (D-032), rate limits (D-033), and an `audit_logs` entry (actor, project, statement hash) per [audit & admin access](../02-control-plane/05-audit-and-admin-access.md) — the data API has no concept of *which dashboard user* acted.

`corebase_admin` is a per-project role: full DDL/DML on customer schemas, `BYPASSRLS` (it is the developer's own console over their own data — same trust level as their direct connection string), **not** superuser, no `pg_execute_server_program` (D-080). Tenant isolation never rests on this role; it rests on the container boundary (D-009, D-081) — the platform API resolves `:ref` to that project's container and can reach no other.

**Grid behavior:**

- Paginated 100 rows/page; keyset pagination on the primary key where one exists, offset fallback otherwise. Total count uses `pg_class.reltuples` estimates above a threshold (exact `COUNT(*)` on big tables is a self-inflicted seq scan); shown as "~12,400 rows".
- Column headers show type + nullability; sort toggles emit `ORDER BY` (visible in a collapsed "view as SQL" affordance — reads are SQL too).
- Filters compile to `WHERE` clauses with typed operators per column type:

  | Column type | Offered operators | Compiled shape |
  |---|---|---|
  | text / varchar | equals, not equals, contains, starts with, is null | `col = $1`, `col ILIKE '%' || $1 || '%'`, `col ILIKE $1 || '%'`, `col IS NULL` |
  | numeric / int | `=`, `≠`, `<`, `≤`, `>`, `≥`, is null | `col >= $1` … |
  | timestamptz / date | before, after, between, is null | `col < $1`, `col BETWEEN $1 AND $2` |
  | boolean | is true, is false, is null | `col IS TRUE` … |
  | uuid | equals, is null | `col = $1` |
  | json / jsonb | key equals (path + value) | `col->>$1 = $2` |

  All filter values are bound parameters — the grid never string-interpolates user input into SQL.
- **Inline edit** generates `UPDATE public.posts SET title = $1 WHERE id = $2;` — always **PK-guarded**, parameterized, one row. Same loop as DDL: the statement is shown (values as placeholders) in a slim confirm popover.
- **Tables without a primary key are read-only in the grid** — no editing, with an inline explainer and a one-click "add primary key" that opens the DDL flow. Ctid-based editing is a corruption trap under concurrency; refuse.
- Insert row → form → `INSERT INTO … (cols) VALUES ($1…);`. Delete row(s) → `DELETE FROM … WHERE pk IN (…);` with ladder (ii), row count in the confirm.
- Row edits are DML, not schema: they are never offered as migrations.

### RLS panel (per table)

A permanent panel on every table's page — RLS status is not buried in settings, it is the second thing you see after the data (ties to D-036: the API's security model *is* RLS, and [RLS design](../06-security/02-rls-design.md)):

| Table state | Presentation |
|---|---|
| RLS enabled + ≥1 policy | Neutral badge: "RLS · 3 policies", expandable list |
| RLS enabled + 0 policies | Informational badge: **"No policies — API returns no rows."** Presented as the *safe default* (D-083), not an error, with an "Add policy" button |
| **RLS disabled** | **Red banner across the table view:** "Row Level Security is disabled — anyone with the anon key can read and write every row of this table through the API." One-click fix generating `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;` through the normal preview→confirm loop |

- **Policy list:** name, command (`SELECT/INSERT/UPDATE/DELETE/ALL`), roles, `USING` / `WITH CHECK` expressions shown as SQL. Edit and drop go through the standard loop (`DROP POLICY` is ladder ii).
- **Policy editor (D-133):** creation starts from **templated starting points** taken from the [RLS design](../06-security/02-rls-design.md) cookbook — *own rows*, *public read*, *public read + authenticated write*, *org membership* — and each template **expands immediately into a full, editable `CREATE POLICY` statement** in the editor. The SQL is the artifact: what you see is exactly what runs, and saving offers the same "save as migration" step. There is no form-only wizard whose output you cannot read (V1 position; also on the [IA cut-list](01-dashboard-ia.md)).
- A "Test as role" shortcut deep-links to the [SQL editor](03-sql-editor.md) with a `SELECT * FROM <table>` prefilled and the role switcher open — the policy-debugging loop lives there.

## Decisions

- **D-132 — Dashboard database operations (table editor and SQL editor) execute via the platform API (`/v1/projects/:ref/db/query`) over the platform's own connection to the project database, as a dedicated per-project `corebase_admin` role (full DDL/DML + BYPASSRLS on customer schemas, never superuser), with every statement audited and rate-limited; the public data API and browser-held `service_role` keys are never used for dashboard operations.** *(Rationale: keeps god-mode credentials out of the browser, gives the editor the raw-SQL and introspection surface PostgREST cannot provide, and funnels every GUI action through one audited, request-id'd, rate-limited path.)*
- **D-133 — Every table-editor operation compiles to visible, verbatim SQL shown in a preview panel before execution, is offered afterwards as a plain-SQL migration file per D-028, and RLS policy creation uses templates that expand to editable `CREATE POLICY` SQL — no black-box wizard in V1. Inline row editing is PK-guarded parameterized DML; tables without a primary key are read-only in the grid.** *(Rationale: §41's translate-to-SQL rule is what keeps the GUI honest and the schema portable (D-004) — users graduate from clicking to reading to writing SQL on the same screen; PK-guarded DML is the only UPDATE/DELETE shape that cannot silently hit more rows than the user sees.)*

## Open Questions

- **OQ-131 — Executed-DDL journal export details:** with saved changes already entering `schema_migrations` and drift reconciled via `db pull --changes` (D-076), should the editor's executed-DDL history additionally be exportable/consumable as pre-formed migration entries, or remain a human-readable attribution log? Owned jointly with [migrations](../03-database-platform/04-migrations.md).
- **OQ-132 — Index creation strategy from the editor:** plain `CREATE INDEX` (transactional, but locks writes for the build) vs `CREATE INDEX CONCURRENTLY` by default (no write lock, but cannot run in a transaction — needs a special non-transactional lane in the D-132 execution path and invalid-index cleanup on failure). Leaning: CONCURRENTLY above a row-count threshold. Decide with the execution-path implementation.

## Dependencies

- Builds on: [01-dashboard-ia.md](01-dashboard-ia.md) (D-130 stack, routes), [../02-control-plane/02-platform-api.md](../02-control-plane/02-platform-api.md) (envelope, sessions), [../06-security/02-rls-design.md](../06-security/02-rls-design.md) (D-083 defaults, policy cookbook), [../03-database-platform/04-migrations.md](../03-database-platform/04-migrations.md) (D-028 format, drift stance), [../02-control-plane/05-audit-and-admin-access.md](../02-control-plane/05-audit-and-admin-access.md), [../06-security/01-threat-model.md](../06-security/01-threat-model.md) (D-080/D-081 role limits)
- Feeds: [03-sql-editor.md](03-sql-editor.md) (shares the D-132 execution path and role model), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md) (admin-path cases), [../14-roadmap/01-phase-plan.md](../14-roadmap/01-phase-plan.md)
