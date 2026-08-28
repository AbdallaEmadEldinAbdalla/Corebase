# SQL Editor

## Purpose

The SQL editor at `/project/[ref]/sql` (proposal §42): the power surface of the dashboard — raw SQL against the project database with autocomplete, tabs, history, saved queries, EXPLAIN, and the safety rails that let it be powerful without being how people destroy their own production data. It shares the table editor's execution path and role model (D-132) and is the home of the RLS debugging story.

## Design

### Editor component: CodeMirror 6 (not Monaco)

**CodeMirror 6**, with `@codemirror/lang-sql` (PostgreSQL dialect) plus a custom completion source. Justification:

- **Bundle size:** CM6 with the SQL language lands well under ~300 KB minified; Monaco is multiple MB plus a worker architecture designed for a full IDE. The dashboard's speed principle (D-130, §90) makes Monaco's weight a per-navigation tax for features we don't use.
- **Feature fit:** Monaco's edge is LSP-grade multi-file IntelliSense, refactoring, and VS Code parity — none of which apply to a single-buffer SQL console. CM6's extension model handles the parts we do need (custom completions from the introspection cache, diagnostics/decorations for error-position highlighting, keymaps) cleanly and tree-shakes to only what's used.
- CM6 is also markedly better on mobile/touch, which matters for "check something from a phone" even if authoring stays on desktop.

### Schema-aware autocomplete

- Completions: keywords, schemas, tables, views, columns (context-aware after `FROM`/`JOIN` aliases), functions (including `auth.uid()` / `auth.role()` helpers from [RLS design](../06-security/02-rls-design.md)), and named policy/role identifiers.
- Backed by an **introspection cache**: the platform API exposes a project introspection endpoint (over the D-132 path) returning schemas/tables/columns/functions in one payload; the dashboard caches it in TanStack Query.
- **Refresh on DDL:** any successful statement classified as DDL through the dashboard (SQL editor or table editor) invalidates the cache immediately. For DDL executed *outside* the dashboard (psql, `db push`), the cache revalidates on window focus and every 60 s while the editor is open; push-invalidation via event trigger is OQ-133.

### Tabs, saved queries, history

| Feature | Where it lives | Spec |
|---|---|---|
| **Tabs** (unsaved scratch) | **localStorage**, keyed `corebase:sql:<ref>` | Per-project, survive reload, device-local, never sent to the server until executed. Cheap, private, zero API surface. |
| **Saved queries** (named) | **Server-side, control plane** (`GET/POST /v1/projects/:ref/queries`) | Name + SQL text, project-scoped and shared with all project members; deep-linkable as `/sql/[queryId]`. This is the durable, team-visible tier — the reason tabs alone aren't enough. |
| **History** | **Server-side, control plane** | Last **100** executions per project: SQL text, actor, started_at, duration, rows returned/affected, status (ok / error code). Rerun and save-as-query from any entry. Retention 30 days. **Sensitive-value caution:** history stores verbatim SQL, so literals (emails, tokens pasted into a WHERE clause) persist server-side — the history panel says so, entries are deletable individually and in bulk, and redaction policy is OQ-134. |

### Execution & results

- Runs go through the **D-132 path** (`POST /v1/projects/:ref/db/query`): audited, rate-limited, standard error envelope. Request/response shape (the SQL editor and table editor share it):

  ```jsonc
  // request
  {
    "sql": "select * from posts where author_id = $1",
    "params": [],                    // table-editor DML binds here; editor runs usually inline
    "role": "admin",                 // "admin" | "anon" | "authenticated"
    "claims": {"sub": "7f3c..."},   // only with role=authenticated
    "read_only": false,
    "confirm_destructive": false     // must be true to pass the guard (rail 2)
  }
  // response (per statement)
  {
    "rows": [...], "row_count": 42, "fields": [{"name": "id", "type": "uuid"}, ...],
    "duration_ms": 12, "executed_sql": "select ... limit 501",   // shows any auto-appended LIMIT
    "truncated": true                                            // 501st row existed
  }
  ```

  Errors use the standard envelope (D-032) with the Postgres fields attached: `{error: {code, message, request_id, pg: {sqlstate, position, detail, hint}}}`.
- **Results grid:** virtualized rendering (smooth at tens of thousands of rows), per-column type badges, NULL rendered distinctly from empty string, cell copy, row copy as JSON, **export CSV** of the fetched result set (client-side), and a **JSON cell viewer** (pretty-printed modal with collapse/expand) for `json`/`jsonb` columns.
- Execution time and row count shown per run (§42). Multiple statements in one run execute sequentially; results render per statement.
- **EXPLAIN buttons:** `Explain` prepends `EXPLAIN (FORMAT TEXT)`; `Explain analyze` prepends `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)` behind a confirm noting it *actually executes* the statement (and is refused for destructive statements unless the destructive guard is separately confirmed). **V1 renders the text plan** in a monospace panel; the visual plan-tree renderer is **V1.1** (per the [IA cut-list](01-dashboard-ia.md)).

### Safety rails (D-134)

1. **Execution role choice — the RLS debugging story.** A role switcher in the toolbar, default **`corebase_admin`** (D-132; BYPASSRLS — sees everything, exactly like the owner connection string). Options: **`anon`**, **`authenticated`**, and **`authenticated` as a specific user** (paste or pick a user id; optional extra-claims JSON). Non-admin runs wrap the statement exactly like the [data-plane pipeline](../06-security/02-rls-design.md) does under D-015:

   ```sql
   BEGIN;
   SET LOCAL ROLE authenticated;
   SET LOCAL request.jwt.claims = '{"sub":"<user-id>","role":"authenticated", …}';
   <statement>;
   COMMIT;
   ```

   The workflow this enables: write a policy in the [table editor](02-table-editor.md), run the same `SELECT` here as admin (all rows) → `anon` (none) → a specific user (their rows). The role switcher's current value is loud in the UI (colored toolbar chip), and non-admin runs are labeled in history.
2. **Destructive-statement guard.** Statements are classified server-side (client mirrors it for instant feedback, but the server check is authoritative — a guard only in JS is not a guard): `DROP …`, `TRUNCATE`, `DELETE` without `WHERE`, `UPDATE` without `WHERE` → confirmation modal stating the object and blast radius; `DROP TABLE / DROP SCHEMA` require the object name **typed back** (same ladder as the [table editor](02-table-editor.md)). Guarded statements are refused by the API unless the request carries the confirmation flag.
3. **Statement timeout.** Every run executes with `SET LOCAL statement_timeout = '60s'` by default; configurable per project (project settings, cap 10 min). Timeout errors explain the setting and where to change it.
4. **Row-limit auto-append.** A bare top-level `SELECT` with no `LIMIT` gets `LIMIT 501` appended (visible in the "executed SQL" line under the results): 500 rows render, and a 501st row shows as "Showing first 500 — Show more" (reruns with a raised limit). Never applied to statements with an explicit `LIMIT`, to non-SELECTs, or to CTE-wrapped/multi-statement scripts the classifier can't safely rewrite.
5. **Transaction mode.** Each run executes in its own transaction: auto-commit on success, full rollback on any error — a 3-statement script never half-applies. **Explicit `BEGIN` passthrough:** if the script itself contains `BEGIN`/`COMMIT`/`ROLLBACK`, the editor does not add its own wrapper. Transactions cannot be held open *across* runs (each run is one API request, and PgBouncer transaction mode, D-015, precludes cross-request session state) — so no idle-in-transaction leaks from abandoned tabs, by construction.
6. **Read-only mode toggle.** Per-tab toggle that runs everything under `SET TRANSACTION READ ONLY` — for spelunking sessions on production data. Sticky per tab; the destructive guard still applies when it's off.

### Keyboard model

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+Enter` | Run (selection if any, else whole buffer) |
| `Cmd/Ctrl+Shift+Enter` | Explain selection/buffer |
| `Cmd/Ctrl+S` | Save as named query (or update the open one) |
| `Cmd/Ctrl+T` / `Cmd/Ctrl+W` | New / close tab (unsaved buffers prompt) |
| `Cmd/Ctrl+K` | Command palette: switch tab, open saved query, jump to table |

Running a selection executes exactly the selected text (rails still apply) — the standard way to iterate on one statement inside a scratch buffer.

### Error UX

A failed run renders, in order:

- The statement with the **error position highlighted** (Postgres `position` byte offset mapped to line/column; CM6 diagnostic underline + gutter marker + scroll-to).
- Postgres severity + SQLSTATE + message, and **`DETAIL`/`HINT` shown verbatim when present** (Postgres hints are good — surface them, don't paraphrase).
- The platform **`request_id` with a copy button** (D-032) — the same debuggability contract as every other dashboard error.
- Where the error is an RLS artifact (0 rows / `42501` under a non-admin role), an inline nudge: "Running as `anon` — 0 rows may mean no policy matches. Test as admin →".

## Decisions

- **D-134 — The SQL editor is CodeMirror 6 (PostgreSQL dialect, schema-aware completions from an introspection cache), and ships with binding safety-rail defaults: execution via the D-132 admin path with a role switcher (default `corebase_admin`; `anon`/`authenticated`(+claims) runs wrap statements in the exact `SET LOCAL ROLE` + `request.jwt.claims` pattern of the data-plane pipeline); server-enforced destructive-statement guard with typed confirmation for `DROP TABLE`/`DROP SCHEMA`; `statement_timeout` 60 s default (project-configurable, 10 min cap); `LIMIT 501` auto-append on bare SELECTs with a show-more affordance; one transaction per run with explicit-`BEGIN` passthrough; per-tab read-only mode. Tabs are localStorage-only; named queries and 100-entry execution history are server-side in the control plane.** *(Rationale: CM6 wins on bundle weight and extension fit for a single-buffer console, serving the §90 speed principle; the rails encode the difference between "powerful console" and "outage generator", and mirroring the real RLS pipeline in the role switcher makes policy debugging trustworthy — what you test is literally what production executes.)*

## Open Questions

- **OQ-133 — Introspection-cache push invalidation:** is focus-revalidate + 60 s polling enough for out-of-band DDL (psql, `db push`), or should the project DB's DDL event trigger (if adopted per OQ-082) also notify the control plane so open editors refresh instantly? Decide together with OQ-082 in [RLS design](../06-security/02-rls-design.md) / [migrations](../03-database-platform/04-migrations.md).
- **OQ-134 — History redaction & retention:** stored history contains verbatim SQL and therefore any sensitive literals typed into it. Options: literal-masking on write (lossy — breaks rerun), shorter retention, org-configurable retention, or per-run "don't record" flag. Decide before history ships; interacts with data-retention commitments in [platform security](../06-security/04-platform-security.md).

## Dependencies

- Builds on: [01-dashboard-ia.md](01-dashboard-ia.md) (D-130 stack), [02-table-editor.md](02-table-editor.md) (D-132 execution path, warning ladder), [../06-security/02-rls-design.md](../06-security/02-rls-design.md) (role/claims pattern, helper functions), [../03-database-platform/02-connection-pooling.md](../03-database-platform/02-connection-pooling.md) (D-015 transaction mode), [../02-control-plane/02-platform-api.md](../02-control-plane/02-platform-api.md) (envelope, request_id, saved-query endpoints)
- Feeds: [../10-cli-and-sdk/01-cli-spec.md](../10-cli-and-sdk/01-cli-spec.md) (shared statement classifier for guard parity in `db reset`-class commands), [../13-quality/01-testing-strategy.md](../13-quality/01-testing-strategy.md) (rail bypass tests), [../14-roadmap/01-phase-plan.md](../14-roadmap/01-phase-plan.md)
