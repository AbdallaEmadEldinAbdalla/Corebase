# REST API Design

## Purpose

The data API is the surface most Steadhold code never touches: per D-011, each project runs its own embedded **PostgREST** instance, and Steadhold's engineering goes into the gateway around it. This doc does two things: (1) documents the build-vs-embed analysis behind D-011 properly, including what embedding costs us and the trigger that would reopen the decision; (2) specifies the developer-facing API contract Steadhold commits to — the URL shape, filter grammar, pagination, embedding, upsert, and RPC semantics — plus the operational glue (schema-cache reloads, per-project PostgREST configuration, versioning stance). The critique that forced this design is [critical review §2.2](../00-foundation/03-critical-review.md): "automatically expose tables as an API" hides an entire product.

## Design

### Build vs embed

The v0.1 proposal (§14–15, §86) budgeted the data API as a phase-3 sprint: four verbs plus `?id=eq.<id>`. The real surface, dimension by dimension:

| Dimension | What "build" actually means | What PostgREST already has |
|---|---|---|
| Filter operators | A grammar, not a list: ~30 operators (`eq`…`plfts`), negation (`not.`), boolean trees (`and=()`, `or=()`) nestable to arbitrary depth, quantifiers (`eq(any)`), correct SQL generation and *injection-safe parameterization* for every combination | A decade-hardened parser → AST → parameterized SQL pipeline |
| Resource embedding | FK-graph discovery from the catalog, one-to-many / many-to-one / many-to-many (junction detection), disambiguation when two FKs join the same pair of tables, `!inner` join semantics, per-embed filters/order/limit | All of it, including spread embeds and nested filtering |
| RPC | Functions as endpoints, `GET` for `IMMUTABLE`/`STABLE` functions, argument marshalling (named, variadic, single JSON), overload resolution, scalar vs setof returns, table-returning functions composable with `select=`/filters | Complete, including function-level privileges |
| Upsert / bulk | `ON CONFLICT` mapping, merge-vs-ignore duplicate resolution, bulk inserts from JSON/CSV arrays, `PUT` semantics on a full PK filter, `missing=default` | Complete |
| Schema cache | Catalog introspection (tables, columns, FKs, functions, views incl. base-table inference for updatable views), a *reload* mechanism so DDL is reflected without restarts | Complete, with `NOTIFY`/signal-driven reload |
| OpenAPI output | Auto-generated spec per role's actual privileges, kept in sync with the schema cache | Built in (`openapi-mode`) |
| Everything else | `Prefer:` handling (return, count, resolution, missing, handling), `Range` pagination, CSV output, `Accept` negotiation, computed/virtual columns, aggregate guards, `max-rows` enforcement, HTTP caching headers | Built in |

Honest estimate for a from-scratch implementation reaching *compatible* parity: 2–4 engineer-years to first credibility, then a permanent maintenance tail — PostgREST's issue tracker is roughly ten years of edge cases (view updatability, embed ambiguity, JWT audience handling, pooler interactions) that we would rediscover one incident at a time, on the tenant-data hot path where bugs are security bugs. Against D-002 (isolation & security first) and D-005 (compose proven OSS), building is indefensible.

**What embedding costs — stated, not hidden:**

| Cost | Reality | Mitigation |
|---|---|---|
| Haskell binary opacity | Nobody on the team writes Haskell; we cannot hot-patch PostgREST, only configure it, file upstream issues, or carry patches we can't confidently author | Treat PostgREST as a black-box appliance with a pinned version; all Steadhold-specific behavior lives in the gateway or in SQL (roles, RLS, `pre-request` function) — both fully ours |
| Config constraints | Behavior is tunable only through the exposed config surface; per-request dynamic behavior (per-plan row caps, billing hooks) can't be injected mid-query | The SQL escape hatch (`db-pre-request`, role settings like `statement_timeout`, RLS itself) covers most needs; the gateway covers the rest before/after the proxy hop |
| Version coupling | Our public API surface tracks upstream releases; an upstream breaking change becomes our migration project | Pin one PostgREST version fleet-wide (same logic as D-037 for Postgres); absorb upstream majors deliberately, behind the `/rest/v1` contract (D-102) |
| Per-project RAM | One PostgREST process per project (D-009 triplet) costs ~40–80 MB RSS each — real money in the density math | Counted in the [cost model](../12-business/01-cost-model.md) and node sizing ([postgres provisioning](../03-database-platform/01-postgres-provisioning.md)); paused projects (D-008) drop the whole triplet |

**Conclusion: D-011 stands — embed PostgREST, one instance per project.** A second-order benefit is deliberate: the API is Supabase-compatible at the mental-model level, which lowers the cost of migrating *to* Steadhold (D-001 portability lane, in reverse).

**Revisit trigger for D-011:** reopen the decision if (a) a P0 security or correctness fix is blocked on upstream for more than two weeks with no carryable patch, or (b) a feature required by the roadmap needs a fork rather than gateway/SQL-level composition. Until then, no wrapper code that reimplements PostgREST behavior "just in case."

### The developer-facing contract

Everything below is what Steadhold publicly commits to for V1. It is PostgREST semantics, restated as *our* contract — if we ever swapped the engine, this section is what must keep working.

**URL shape**

```text
https://<ref>.steadhold.app/rest/v1/<table-or-view>     — tables and views in the exposed schema
https://<ref>.steadhold.app/rest/v1/rpc/<function>      — database functions
```

`<ref>` is the immutable project slug ([data model](../02-control-plane/01-data-model.md)). Every request carries `apikey: <anon-or-service_role JWT>` and optionally `Authorization: Bearer <user JWT>` — the dual-header pattern specified in [api-keys-and-roles](03-api-keys-and-roles.md). The exposed schema in V1 is `public` (OQ-101 tracks opening this up).

**Filter grammar** — `?<column>=<operator>.<value>`, combinable; every filter ANDs by default.

| Operator | Meaning | Example |
|---|---|---|
| `eq` / `neq` | equals / not equals | `?status=eq.active` |
| `gt` / `gte` / `lt` / `lte` | comparisons | `?price=lt.100` |
| `like` / `ilike` | SQL LIKE, `*` as wildcard; `ilike` case-insensitive | `?name=ilike.*smith*` |
| `is` | IS checks for `null` / `true` / `false` | `?deleted_at=is.null` |
| `in` | member of list | `?id=in.(1,2,3)` |
| `cs` / `cd` | contains / contained-in (arrays, jsonb, ranges) | `?tags=cs.{urgent,bug}` |
| `ov` | overlaps (arrays, ranges) | `?period=ov.[2026-01-01,2026-02-01)` |
| `fts` / `plfts` / `wfts` | full-text search: `to_tsquery` / `plainto_tsquery` / `websearch_to_tsquery` | `?body=fts(english).cat&body=plfts.fat+cats` |
| `not.<op>` | negates any operator | `?status=not.eq.archived` |
| `or=()` / `and=()` | boolean trees, nestable | `?or=(age.gte.18,and(role.eq.admin,verified.is.true))` |

JSON path filtering works on jsonb columns: `?metadata->>tier=eq.gold`. Computed (virtual) columns — SQL functions taking the row type — filter and select like real columns.

**Ordering and pagination**

```http
GET /rest/v1/todos?select=*&order=created_at.desc.nullslast&limit=20&offset=40
```

or the header form, which the SDK uses internally:

```http
GET /rest/v1/todos?select=*
Range-Unit: items
Range: 40-59
Prefer: count=exact
```

Response carries `Content-Range: 40-59/2384`. `Prefer: count=exact` runs a real `count(*)`; `count=planned` reads the planner estimate (cheap, approximate); `count=estimated` is exact below `db-max-rows` and planned above. Without a count preference the total is `*` and no count query runs. `db-max-rows = 1000` caps any single response fleet-wide; clients page past it.

**Resource embedding** — the FK graph becomes the query language:

```http
GET /rest/v1/posts?select=id,title,author:users(id,name),comments(body,created_at)&comments.order=created_at.desc&comments.limit=3
```

One request, no N+1: `author` is a many-to-one embed through the `posts.author_id → users.id` FK, `comments` a one-to-many, each with its own order/limit/filters. Many-to-many resolves automatically through junction tables. **Disambiguation:** when two FKs connect the same tables (e.g. `posts.author_id` and `posts.editor_id` both → `users`), name the FK: `select=author:users!posts_author_id_fkey(name),editor:users!posts_editor_id_fkey(name)`. `!inner` turns an embed into an inner join so parent rows without matches drop out: `?select=*,comments!inner(*)&comments.body=ilike.*urgent*`.

**Writes**

```http
POST /rest/v1/todos
apikey: <anon JWT>
Authorization: Bearer <user JWT>
Content-Type: application/json
Prefer: return=representation

[{"title": "ship the API doc", "done": false}]
```

`Prefer: return=representation` echoes inserted rows (with defaults/identities filled in, filtered by `select=`); default is `return=minimal` (201, empty body). Arrays insert in bulk atomically. **Upsert:**

```http
POST /rest/v1/inventory?on_conflict=sku
Prefer: resolution=merge-duplicates, return=representation
```

maps to `INSERT ... ON CONFLICT (sku) DO UPDATE`; `resolution=ignore-duplicates` maps to `DO NOTHING`. `on_conflict` must name a unique or PK column set. `PATCH` + filters updates in place; `DELETE` + filters deletes; both refuse to run unfiltered unless the request explicitly allows full-table writes (SDK-level guard).

**RPC**

```http
POST /rest/v1/rpc/search_products
Content-Type: application/json

{"query": "wireless", "max_price": 200}
```

Named arguments from the JSON body; `IMMUTABLE`/`STABLE` functions are also callable via `GET /rest/v1/rpc/search_products?query=wireless`. Table-returning functions compose with the full read grammar (`select=`, filters, `order`, `Range`). RPC runs under the same role + RLS model as everything else — a function is not a policy bypass unless it is deliberately `SECURITY DEFINER` (which the [RLS design](../06-security/02-rls-design.md) treats as a reviewed exception).

**Errors** — PostgREST returns structured errors (`{"code": "PGRST116", ...}` or the PostgreSQL SQLSTATE for constraint/RLS violations). These pass through the gateway verbatim (D-106 in [request pipeline](02-request-pipeline.md)); gateway-originated failures use the D-032 envelope.

### Schema-cache reload on DDL

PostgREST caches the catalog (tables, FKs, functions). Stale cache after DDL is the classic embedded-PostgREST failure ("I created the table, the API 404s"). Steadhold makes reload automatic and source-agnostic (**D-100**): the base schema applied at provision time (lifecycle step *d* in [system architecture](../01-architecture/01-system-architecture.md)) installs an event trigger:

```sql
CREATE OR REPLACE FUNCTION steadhold.pgrst_ddl_watch() RETURNS event_trigger AS $$
BEGIN
  NOTIFY pgrst, 'reload schema';
END; $$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER pgrst_ddl_watch ON ddl_command_end
  EXECUTE FUNCTION steadhold.pgrst_ddl_watch();
-- plus a companion trigger on sql_drop for DROP statements
```

PostgREST runs with `db-channel-enabled = true` and `LISTEN`s on the `pgrst` channel — possible only because it connects **directly** to Postgres, not through the transaction pooler (D-101 below; `LISTEN` does not survive transaction pooling, which by itself settles the connection topology). The consequence: the dashboard table editor, `steadhold db push`, and a developer in raw `psql` all get cache reloads for free — no code path in Steadhold needs to remember to poke PostgREST. `SIGUSR1` to the container remains the reconciler's out-of-band fallback if the trigger is ever dropped, and `NOTIFY pgrst, 'reload config'` / `SIGUSR2` reloads configuration (used by key rotation, [api-keys-and-roles](03-api-keys-and-roles.md)).

### PostgREST configuration template (rendered per project by the provisioner)

```ini
# /etc/postgrest/postgrest.conf — project <ref>
db-uri            = "postgres://authenticator:@<pg-container>:5432/postgres"
                    # password via PGRST_DB_URI env override, injected from the
                    # secret store at container start (D-035); never in the file
db-schemas        = "public"
db-anon-role      = "anon"
db-pool           = 7           # free tier (D-074 budget) — see sizing note below
db-pool-acquisition-timeout = 10

jwt-secret        = "@/etc/postgrest/jwks.json"   # project JWKS: active kids (D-014)
jwt-role-claim-key = ".role"
jwt-cache-max-lifetime = 3600

db-channel-enabled = true       # LISTEN pgrst — schema reload (D-100)
db-channel         = "pgrst"
db-pre-request     = "steadhold.pre_request"        # request-ID → application_name (D-105)
db-prepared-statements = true   # safe: direct connection, not the txn pooler
db-max-rows        = 1000
db-extra-search-path = "public, extensions"

server-host        = "*"
server-port        = 3000       # host port allocated per project (data model)
admin-server-port  = 3001       # /live /ready for the reconciler
openapi-mode       = "follow-privileges"           # OQ-100
```

**Connection topology (D-101): PostgREST connects direct to Postgres, not through PgBouncer.** Three reasons: (1) `LISTEN/NOTIFY` for the schema cache (D-100) does not work through transaction pooling; (2) PostgREST already *is* a pool — it multiplexes all HTTP traffic onto `db-pool` connections and issues `SET LOCAL role / request.*` per transaction, exactly the D-015 pattern, so putting a second pooler behind it adds a hop and per-statement `DEALLOCATE ALL` churn while multiplexing nothing further; (3) prepared statements stay enabled, which transaction mode would forbid. PgBouncer (D-015) remains in front of *everything else* that opens Postgres connections: SDK/psql direct SQL from customers and the auth/storage modules' per-request work. Sizing: PostgREST's `db-pool` counts against the project's `max_connections` budget alongside the pooler's `default_pool_size` — the split is specified in [connection pooling](../03-database-platform/02-connection-pooling.md) (free tier, per D-074, against `max_connections = 20`: 3 reserved / 7 PostgREST / 8 pooler (6+2) / 2 direct; paid tiers scale both).

### Versioning stance for `/rest/v1`

`/rest/v1` is a compatibility contract, not a PostgREST version pin exposed to users (**D-102**). One PostgREST version runs fleet-wide (mirroring D-037's one-Postgres-version rule); minor/patch upstream upgrades roll to the whole fleet after canary. An upstream change that would break the documented `/rest/v1` surface is absorbed via config or a gateway shim where possible; if genuinely unabsorbable, `/rest/v2` ships side-by-side (both prefixes routed to per-version PostgREST processes) with a deprecation window per the [release & versioning policy](../13-quality/02-release-and-versioning.md). Within the V1 horizon we expect never to need `/rest/v2` — the point of the stance is that a PostgREST upgrade is *our* migration project, never the customer's surprise.

## Decisions

- **D-100 — Schema-cache reload is automatic via an event trigger on `ddl_command_end`/`sql_drop` that emits `NOTIFY pgrst, 'reload schema'`; PostgREST listens on the channel (`db-channel-enabled`). `SIGUSR1` is the reconciler's fallback path only.** *(Rationale: DDL arrives from the dashboard, CLI migrations, and raw psql alike — a database-side trigger catches all three with zero coordination code, where any "the dashboard calls the reload endpoint" design silently misses the psql path.)*
- **D-101 — PostgREST connects directly to its project's Postgres, not through PgBouncer; PgBouncer fronts all other connection sources (customer direct SQL, auth/storage modules).** *(Rationale: `LISTEN` for D-100 cannot cross a transaction pooler; PostgREST is itself a multiplexing pool issuing `SET LOCAL` per transaction — the D-015 pattern — so chaining poolers adds latency and disables prepared statements for no additional multiplexing; connection budgets are reconciled in the pooling doc.)*
- **D-102 — `/rest/v1` is a compatibility contract: one pinned PostgREST version fleet-wide, upgrades rolled deliberately behind the contract; an unabsorbable upstream break ships as `/rest/v2` side-by-side rather than mutating `/rest/v1`.** *(Rationale: customers integrate against the documented grammar, not against "whatever PostgREST does this month"; fleet version homogeneity is the same ops-tax argument as D-037.)*

## Open Questions

- **OQ-100** — OpenAPI output exposure: `GET /rest/v1/` returns the generated spec under `openapi-mode = follow-privileges` (spec reflects only what the requesting role can see). Ship that as-is, or gate the spec behind `service_role` to avoid advertising schema shape to anonymous callers? Leaning follow-privileges (an anon spec only reveals anon-visible objects, which RLS already guards), but the [threat model](../06-security/01-threat-model.md) should rule on schema-shape disclosure.
- **OQ-101** — Additional exposed schemas: `db-schemas` is `public` only in V1. When developers ask for e.g. an `api` views-only schema (a common PostgREST hardening pattern), do we allow per-project `db-schemas` config (dashboard setting → config re-render → `NOTIFY reload config`), and in which release?

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-011, D-015, D-029, D-036, D-037), [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md) (§2.2), [../01-architecture/01-system-architecture.md](../01-architecture/01-system-architecture.md), [../03-database-platform/02-connection-pooling.md](../03-database-platform/02-connection-pooling.md)
- Feeds: [02-request-pipeline.md](02-request-pipeline.md), [03-api-keys-and-roles.md](03-api-keys-and-roles.md), [../06-security/02-rls-design.md](../06-security/02-rls-design.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md), [../13-quality/02-release-and-versioning.md](../13-quality/02-release-and-versioning.md)
