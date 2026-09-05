# RLS Design

## Purpose

Row-Level Security is the authorization model of the entire data plane (D-036: no phase where the API serves table data without policies). This doc makes the identity→policy pipeline concrete end to end: how a JWT becomes a Postgres role plus session claims under connection reuse (PostgREST's own pool on the API path, D-101; PgBouncer transaction mode on the pooled direct paths, D-015), the exact DDL of the Corebase helper functions, the default-deny posture, a policy cookbook developers copy from, the performance pitfalls that make naive RLS 100× slower, and the `service_role` bypass mechanism. Everything here must survive connection reuse across requests and remain plain SQL that any Postgres can run (portability, D-004).

## Design

### The pipeline: JWT → role → claims → policy

```
client ──Authorization: Bearer <jwt>──► gateway (project resolution, key-hash check, rate limit)
      ──► project's PostgREST ──verify ES256 against project JWKS (D-014)──►
          BEGIN;                                   -- one transaction per request
            SET LOCAL ROLE authenticated;          -- role from the verified `role` claim
            SET LOCAL request.jwt.claims = '{"sub":"7f3c...","role":"authenticated","email":"a@b.c",...}';
            <the actual query>                     -- planner applies RLS policies for `authenticated`
          COMMIT;                                  -- SET LOCAL evaporates here
      ──► postgres (direct — PostgREST's own connection pool, D-101/D-074; no PgBouncer on this path)
```

Key facts, each load-bearing:

1. **PostgREST verifies, Postgres trusts.** The ES256 signature is checked by PostgREST against the project's JWKS (cached, `kid`-addressed — [sessions & tokens](../05-auth/02-sessions-and-tokens.md)). Postgres never parses a JWT; it only ever sees a role and a claims JSON that PostgREST derived from a *verified* token. There is no shared secret in the data plane, and a token from another project fails verification before any SQL runs ([threat model](01-threat-model.md) boundary b).
2. **`SET LOCAL`, never `SET`.** PostgREST connects directly to Postgres (D-101/D-074 — no PgBouncer on the API path), but it is itself a connection pool: the same server connections are reused across requests. Plain `SET` outlives the transaction and would leak one request's identity into the next request served on that connection — a catastrophic cross-request identity bleed. `SET LOCAL` is scoped to the transaction and evaporates at COMMIT/ROLLBACK, which is exactly the lifetime of one API request. PgBouncer transaction mode governs the *other* pooled paths — the developer `DATABASE_URL` and the auth-module connections — where a server connection is handed to a different client at every transaction boundary and the same `SET LOCAL` discipline applies (D-015).
3. **The role switch is `SET LOCAL ROLE`,** to one of exactly three grantable roles: `anon`, `authenticated`, `service_role` (D-029). PostgREST's authenticator role has `GRANT anon, authenticated, service_role TO authenticator NOINHERIT` and nothing else; a token claiming `role: postgres` fails because the authenticator cannot switch to it.
4. **Direct connections skip the pipeline** — a customer psql session is whatever role they logged in as. RLS applies to every non-owner role that holds a grant, so a direct session as `anon` or `authenticated` sees exactly what the API sees; the customer's own owner role is not subject to its own policies and can alter them, which is by design (it's their database — see D-191). Isolation from *other* tenants never depends on RLS — that's the container boundary (D-009, D-081).

### The helper functions — actual DDL

Shipped into every project database by the provisioning migration, in the `auth` schema. They are **plain SQL** (no C extension, no platform dependency): a `pg_dump` restored to vanilla Postgres keeps them working, per D-004.

```sql
create schema if not exists auth;

-- current user id (the JWT `sub` claim), null for anon
create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid
$$;

-- current role claim ('anon' | 'authenticated' | 'service_role'), null if unset
create or replace function auth.role()
returns text
language sql stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  )
$$;

-- the full claims object, for custom claims (e.g. app_metadata.org_id)
create or replace function auth.jwt()
returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;
```

Notes:

- `current_setting(..., true)` (missing_ok) returns NULL instead of erroring when no claims are set — so the same policies work in a bare psql session (everything is null → own-rows policies match nothing).
- `STABLE`, not `IMMUTABLE`: the value is fixed within a statement but varies between transactions. `STABLE` is what lets the planner evaluate it once per statement when wrapped in a scalar subquery (see performance section).
- The functions are owned by the platform migration role and `GRANT EXECUTE TO public` — they leak nothing; they only read the request's own claims. Execute privilege alone is not enough to *call* them: the API roles (`anon`, `authenticated`, `service_role`) also need `USAGE` on schema `auth`, which the provisioning DDL grants ([auth architecture](../05-auth/01-auth-architecture.md)) — without it, every policy invoking `auth.uid()` errors instead of filtering.

### Default-deny posture

**RLS enabled + forced on every table the API can reach; zero policies = zero rows.** Concretely:

```sql
alter table public.profiles enable row level security;
alter table public.profiles force row level security;   -- applies even to the table owner
```

- Every table created through the dashboard table editor or `corebase` migrations gets both statements automatically (D-083); the enforcement mechanism (DDL event trigger in the project DB vs. lint in `db push` + dashboard) is OQ-082.
- `FORCE` matters because customer-owned tables are owned by the customer's owner role: without FORCE, owner connections silently bypass RLS and developers test against a lie. With FORCE, the owner sees exactly what policies allow — `service_role` remains the explicit, documented bypass (below).
- A freshly created table is therefore deny-by-default for every API role: `authenticated` holds grants but zero policies mean zero rows (`[]`), and `anon` holds no table grant at all (D-108, next bullet). Nothing is readable until the developer writes a policy. The dashboard shows a persistent "no policies — API returns no rows" badge rather than treating it as an error, because it is the *safe* state.
- `GRANT` still gates above RLS (D-108, normative DDL in [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md)): default privileges grant table-level `SELECT/INSERT/UPDATE/DELETE` to `authenticated` and `service_role` only; **`anon` gets no default table grants** — anonymous access is opt-in via explicit per-table `GRANT` (the dashboard toggle emits it). RLS then filters rows for the roles that do hold grants, and RLS-on-at-creation (D-083, as amended by D-191) keeps the whole arrangement fail-closed. Revoking a grant entirely is the coarse switch for "this table is never API-visible."
- Platform-internal schemas (`auth`, `storage`) ship with their own locked policies: `auth.users` is readable only via security-definer views/functions that expose the safe columns — a project's `authenticated` role must not read other users' email addresses by default (tested in [tenant isolation tests](03-tenant-isolation-tests.md)).

### Policy cookbook

The patterns the docs and dashboard templates ship. All use the initplan-cached `(select auth.uid())` form (see performance).

**1. Own rows — select/update:**

```sql
create policy "read own profile"
on public.profiles for select
to authenticated
using ( user_id = (select auth.uid()) );

create policy "update own profile"
on public.profiles for update
to authenticated
using      ( user_id = (select auth.uid()) )   -- which existing rows may be targeted
with check ( user_id = (select auth.uid()) );  -- what the row may look like after
```

**2. Insert — WITH CHECK, not USING.** `INSERT` has no existing row to filter, so it takes only `WITH CHECK`, evaluated against the *new* row. The distinction: `USING` filters rows already in the table (SELECT/UPDATE/DELETE targets); `WITH CHECK` validates rows being written (INSERT, and the post-image of UPDATE). An UPDATE policy without an explicit `WITH CHECK` reuses its `USING` — fine for own-rows, wrong when the two conditions differ.

```sql
create policy "insert own rows"
on public.posts for insert
to authenticated
with check ( author_id = (select auth.uid()) );
```

**3. Tenant-scoped by org column** (the customer's own multi-tenancy inside their project), driven by a custom claim:

```sql
-- token carries: {"app_metadata": {"org_id": "..."}}
create policy "org members read"
on public.documents for select
to authenticated
using (
  org_id = (select (auth.jwt() -> 'app_metadata' ->> 'org_id')::uuid)
);
```

The claim is minted by the customer's backend (via service_role or an auth hook) — never client-writable metadata. Docs must be loud about this: `user_metadata` is user-editable and must never gate authorization; `app_metadata` is server-set.

**4. Public read, authenticated write:**

```sql
create policy "anyone reads published"
on public.articles for select
to anon, authenticated
using ( published = true );

create policy "authors write"
on public.articles for insert
to authenticated
with check ( author_id = (select auth.uid()) );

create policy "authors update own"
on public.articles for update
to authenticated
using ( author_id = (select auth.uid()) )
with check ( author_id = (select auth.uid()) );
```

Policies are OR-combined per command: `authenticated` reads published articles *or* (with an additional own-rows select policy) their own drafts.

**5. Soft-delete-aware.** With a `deleted_at` column, hide tombstones from reads while letting owners tombstone via UPDATE — and forbid resurrecting or hard-deleting.

**The obvious version of this pattern does not work through the API, and the reason generalises to every policy set** (D-386). Filtering tombstones in the *SELECT policy* — `using (deleted_at is null and user_id = ...)` — makes the tombstoning UPDATE fail with `new row violates row-level security policy`: PostgREST issues its writes with `RETURNING`, so Postgres also applies the **SELECT** policy to the **new** row, and the whole purpose of the update is to move that row out of the SELECT policy's reach. No `Prefer` value avoids it — `return=minimal`, `return=representation` and `count=none` all fail identically (verified).

The rule to carry away: **an UPDATE may not move a row outside its own SELECT policy.** Hide rows in a view, not in the read policy:

```sql
-- Reads: own rows, in any state. Deliberately NOT filtered on deleted_at, or the
-- tombstoning UPDATE below cannot return its own new row.
create policy "read own notes"
on public.notes for select
to authenticated
using ( user_id = (select auth.uid()) );

create policy "soft delete own"
on public.notes for update
to authenticated
using      ( user_id = (select auth.uid()) and deleted_at is null )
with check ( user_id = (select auth.uid()) );

-- no DELETE policy at all: hard delete is impossible via the API

-- Tombstones are hidden here instead. `security_invoker` (PG15+) makes the view
-- run with the *caller's* RLS, so the policy above still applies through it —
-- without it the view would run as its owner and become a bypass.
create view public.live_notes with (security_invoker = true) as
  select id, user_id, body from public.notes where deleted_at is null;
grant select on public.live_notes to authenticated;
```

Clients read `live_notes` and write `notes`. Resurrection is still impossible — the UPDATE policy's `USING` requires `deleted_at is null`, so a tombstoned row is not a legal target — and so is hard delete, because no DELETE policy exists at all.

### Performance pitfalls and fixes

RLS predicates run per row unless the planner can hoist them. The failure modes and their fixes:

| Pitfall | Symptom | Fix |
|---|---|---|
| Bare `auth.uid()` in the predicate | Function (and its `current_setting` + jsonb parse) evaluated **per row**; seq scans on big tables become quadratic-feeling | Wrap as `(select auth.uid())` — a scalar subquery becomes an **InitPlan**, evaluated once per statement, and the result is compared as a constant (visible in EXPLAIN as `InitPlan 1`) |
| Policy column unindexed | Even with the initplan, `user_id = $const` seq-scans | Index every column that appears in a policy predicate: `create index on public.posts (author_id);` — dashboard policy editor suggests it |
| Per-row subqueries to other tables (`exists (select 1 from members m where m.org_id = ... and m.user_id = auth.uid())`) | A join executed per candidate row, invisible in the app's own query | Prefer claims (pattern 3) when membership fits in the token. When it can't (large/volatile membership), use a `security definer` helper that runs the lookup once: |

```sql
create or replace function app.current_org_ids()
returns setof uuid
language sql stable
security definer
set search_path = ''      -- mandatory: pin search_path in every SECURITY DEFINER
as $$
  select org_id from public.org_members
  where user_id = (select auth.uid())
$$;
revoke all on function app.current_org_ids() from public;
grant execute on function app.current_org_ids() to authenticated;

create policy "org read"
on public.documents for select
to authenticated
using ( org_id in (select app.current_org_ids()) );
```

`SECURITY DEFINER` runs as the function owner and therefore skips RLS on `org_members` — deliberate here (the membership table itself would otherwise need a policy just to be readable *by the policy*), but every such function must pin `search_path`, revoke PUBLIC execute, and be reviewed as privileged code. The dashboard flags SECURITY DEFINER functions in the policy view.

Other rules of thumb baked into docs and the SQL editor's EXPLAIN integration ([sql editor](../09-dashboard/03-sql-editor.md)):

- **Always specify `to <role>`** on policies. A policy without a role list is evaluated (and its cost paid) for every role including `service_role`-adjacent paths, and mixes anon/authenticated logic.
- **Test plans as the API sees them:** `set role authenticated; set request.jwt.claims = '{"sub":"..."}'; explain analyze select ...;` — plans differ radically between the owner (no RLS pre-FORCE) and API roles. The SQL editor grows a "run as role" selector for exactly this.
- Duplicate policies per command beat one mega-policy with `case` logic — the planner prunes by command.

### `service_role`: the bypass and its rules

Mechanism (D-082): `service_role` carries the **`BYPASSRLS` role attribute** rather than a lattice of permissive `using (true)` policies:

```sql
alter role service_role bypassrls;
```

Why attribute over policies: (a) a `using (true)` policy must exist *per table per command* — one forgotten table breaks the customer's admin path and generates support load; (b) blanket policies pollute every table's policy list in the dashboard, drowning the real ones; (c) `BYPASSRLS` is a single, auditable, greppable fact about one role. The cost — it's all-or-nothing — is exactly the documented contract of the key (§47: "bypasses user-level restrictions by design").

Hard rules, enforced in docs, SDK, and dashboard:

- **`service_role` must never ship to browsers or mobile apps.** The SDK refuses the obvious footgun: `createClient` warns (dev) / errors (production build flag) when a key whose payload says `role: service_role` is used in a browser context. Detection is best-effort; the docs treat any leaked service key as a rotate-now incident ([api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md)).
- `service_role` is still `NOSUPERUSER` and subject to every SQL-level restriction in the [threat model](01-threat-model.md) boundary (c) — BYPASSRLS skips row policies, not privilege checks.
- Platform-internal schemas may additionally `revoke` from `service_role` where even the customer's server code has no business (e.g. `auth.refresh_tokens` hashes) — bypassing RLS doesn't bypass missing grants.

## Decisions

- **D-082 — `service_role` bypasses RLS via the `BYPASSRLS` role attribute, not via per-table permissive policies.** *(Rationale: one auditable role attribute cannot be forgotten on new tables, keeps customer policy lists clean, and matches the key's documented all-or-nothing contract; grants still bound what it can touch.)*
- **D-083 — Every table reachable by the data API gets `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` automatically at creation; no policies means no access, for `anon` and `authenticated` alike.** *(Rationale: default-deny is the only safe default for an auto-generated API; FORCE keeps owner connections honest so developers test the same reality the API serves; the "empty until you write a policy" state is presented as normal, not as an error.)* **The FORCE half is superseded by D-191; ENABLE stands.**

- **D-191 — New tables get `ENABLE ROW LEVEL SECURITY` only. `FORCE` is not applied.** *(Rationale: found by running M0/T5e against a real project. `FORCE` changes behaviour for exactly one role — the table's owner — and the owner is the customer's own `developer` role. With FORCE, the first `INSERT` after the first `CREATE TABLE` fails with "new row violates row-level security policy": every ORM, migration tool and seed script breaks on a brand-new project, and the customer's own `DATABASE_URL` is unusable until they write policies granting themselves access to their own data. It buys no isolation — cross-tenant isolation is the container boundary (D-009), `service_role` bypasses by attribute (D-082), and `anon`/`authenticated` are non-owners already constrained by ENABLE. Measured on a live project: owner reads and writes its own table; `authenticated` holds the grant but sees 0 rows and cannot insert; `anon` is denied outright. D-083's pedagogical goal is real but belongs to the SQL editor's run-as-role feature, which shows the API's reality without breaking psql.)*

## Open Questions

- **OQ-082 — Enforcement mechanism for D-083:** a DDL event trigger inside each project database (bulletproof, catches raw psql `CREATE TABLE`, but is platform-magic living in customer DBs and shows up in their dumps) vs. enforcement at the tooling layer (`db push` lint + table editor + a drift alarm scanning `pg_class.relrowsecurity`). Leaning: event trigger + `corebase export` strips it. Decide with [migrations](../03-database-platform/04-migrations.md).
- **OQ-083 — Custom-claims surface for V1:** do we ship a supported hook for customers to mint claims (e.g. `app_metadata.org_id`) at token issue time, or document the service-role pattern only? Affects [auth architecture](../05-auth/01-auth-architecture.md); pattern 3 above assumes at least the documented path.

## Dependencies

- Builds on: [connection pooling](../03-database-platform/02-connection-pooling.md) (D-015), [sessions & tokens](../05-auth/02-sessions-and-tokens.md) (D-014), [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md) (D-029), [request pipeline](../04-data-api/02-request-pipeline.md), [threat model](01-threat-model.md)
- Feeds: [tenant isolation tests](03-tenant-isolation-tests.md), [table editor](../09-dashboard/02-table-editor.md) (policy editor), [sql editor](../09-dashboard/03-sql-editor.md) (run-as-role EXPLAIN), [storage API & policies](../07-storage/02-storage-api-and-policies.md), [sdk spec](../10-cli-and-sdk/03-sdk-spec.md)
