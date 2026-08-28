# Connection Pooling

## Purpose

Makes D-015 (PgBouncer in transaction mode, one pooler per project) concrete: why transaction mode is the only viable mode, exactly what it breaks and how we document those breaks to developers, how PostgREST coexists with it, how the pooler authenticates without holding plaintext credentials, the pool-size arithmetic for a 20-connection Postgres, how RLS session context survives multiplexing, and the trigger for moving beyond one-PgBouncer-per-project.

The critique flagged this precisely (§2.5): the proposal named PgBouncer (§12, §96) without its sharp edges, and the pooler mode is *coupled* to the RLS design. This doc owns the pooler half of that coupling; [RLS design](../06-security/02-rls-design.md) owns the policy half.

## Design

### 1. Why transaction mode

| Mode | Server conn held for | Multiplexing | Session state safe? |
|---|---|---|---|
| session | the client connection's lifetime | none — 1:1 while connected | yes |
| **transaction** | one transaction | high — N clients : few servers | no (see §2) |
| statement | one statement | highest | no, and breaks multi-statement transactions |

Session mode defeats the purpose: a serverless function fleet or a connection-happy ORM holding 200 client connections would need 200 server connections — our small tenants run `max_connections = 20` ([provisioning §3](01-postgres-provisioning.md)). Statement mode breaks transactions outright. **Transaction mode** is the only mode that lets hundreds of client connections share a handful of server slots while keeping transactional semantics — hence D-015. The price is everything in §2.

### 2. What transaction mode breaks — and what we tell developers

Between transactions, a client's next transaction may run on a *different* server connection. Anything that lives on the server *session* silently misbehaves:

| Feature | Failure mode | Guidance we publish |
|---|---|---|
| Named prepared statements | `prepared statement "s1" does not exist` (or exists with wrong SQL) | Mitigated: we run PgBouncer ≥ 1.21 with `max_prepared_statements = 100`, which tracks and replays protocol-level prepares per server conn. Covers node-postgres/psycopg/most ORMs; SQL-level `PREPARE`/`DEALLOCATE` remains unsupported → use `DIRECT_DATABASE_URL` |
| `SET` (session GUCs) | Setting leaks to other clients / vanishes | Use `SET LOCAL` inside a transaction — this is also the RLS pattern (§6) |
| Session advisory locks (`pg_advisory_lock`) | Lock held by a pooled server conn you no longer own | Use transaction-scoped `pg_advisory_xact_lock`, or direct connection |
| `LISTEN` / `NOTIFY` | Notifications delivered to whichever client has the server conn | `LISTEN` requires `DIRECT_DATABASE_URL`; `NOTIFY` (send-only) works pooled |
| `WITH HOLD` cursors | Cursor gone next transaction | Direct connection |
| Temp tables, `ON COMMIT PRESERVE ROWS` | Vanish / appear for strangers | Direct connection; pooler runs `server_reset_query = DISCARD ALL` on handoff in any case |

**Connection-string contract (developer-facing, set in stone in docs and dashboard):**

```
DATABASE_URL         → pgbouncer, port 6432   # default; app traffic; serverless-safe
DIRECT_DATABASE_URL  → postgres,  port 5432   # migrations, LISTEN, advisory locks, admin tools
```

The CLI uses `DIRECT_DATABASE_URL` automatically for `db push`/`db reset` ([migrations](04-migrations.md)). The dashboard shows both with a one-line "which one do I use?" explainer. Only ~5 direct slots exist (§5), which is also documented — a developer pointing their app fleet at the direct URL exhausts it immediately and visibly, which is the correct failure.

### 3. How PostgREST cooperates

PostgREST does **not** go through PgBouncer. It connects directly to Postgres inside the project network with its own internal pool, because:

1. PostgREST reloads its schema cache via `LISTEN pgrst` — impossible through transaction pooling (§2).
2. PostgREST uses prepared statements for performance (`db-prepared-statements = true`); direct connections keep that unconditional rather than depending on PgBouncer's prepared-statement emulation.
3. Same-host hop: pooling PostgREST's already-pooled connections buys nothing.

```
# postgrest.conf (per project, rendered from template)
db-uri = "postgres://authenticator:<secret>@db:5432/<project_db>"
db-pool = 7
db-prepared-statements = true
db-channel-enabled = true          # LISTEN pgrst for schema reload
db-anon-role = "anon"
```

PostgREST wraps every HTTP request in one transaction and injects request context with `SET LOCAL` — exactly the pattern §6 mandates — so its behavior and the pooled-customer behavior are the same model.

### 4. Pooler ↔ Postgres authentication: auth_query, not userlist

| | `userlist.txt` | `auth_query` |
|---|---|---|
| Credential source | File on pooler container, per role | Postgres itself (`pg_shadow` via SECURITY DEFINER function) |
| Rotation (D-014/D-035 flows) | Regenerate + ship file + `RELOAD` on every rotation — an orchestration step that can drift | `ALTER ROLE ... PASSWORD` is immediately effective; nothing to ship |
| Secret material at rest on pooler | SCRAM verifiers in a file on the node | None beyond the single `pgbouncer_auth` credential |
| New roles | File update required | Automatic |
| Failure mode | Stale file = mystery auth failures after rotation | auth_query role misconfigured = loud, immediate, testable |

**auth_query wins** (D-074): one fewer distributed state to keep consistent, and credential rotation ([credentials & secrets](03-credentials-and-secrets.md)) becomes a single `ALTER ROLE`. Setup per project:

```sql
CREATE ROLE pgbouncer_auth LOGIN PASSWORD '<generated>';  -- internal, never customer-visible
CREATE FUNCTION corebase.pgbouncer_lookup(p_user text)
  RETURNS TABLE (usename name, passwd text)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT usename, passwd FROM pg_shadow
    WHERE usename = p_user
      AND usename IN ('developer');           -- only pooled, customer-facing roles
$$;
REVOKE ALL ON FUNCTION corebase.pgbouncer_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION corebase.pgbouncer_lookup(text) TO pgbouncer_auth;
```

The allowlist inside the function is a defense-in-depth boundary: the pooler can never resolve credentials for `postgres`, `authenticator`, or other internal roles, so the pooled port cannot become a path to elevated roles even if PgBouncer is compromised.

### 5. Pool sizing for a 20-connection Postgres

Server-side budget (`max_connections = 20`):

| Consumer | Slots |
|---|---|
| `superuser_reserved_connections` (ops, node agent, pgBackRest) | 3 |
| PostgREST direct pool (`db-pool`) | 7 |
| PgBouncer server pool (`default_pool_size` + `reserve_pool_size`) | 6 + 2 |
| Customer direct connections (`DIRECT_DATABASE_URL`: migrations, psql, GUI tools) | 2 (headroom, unenforced) |

```ini
; pgbouncer.ini (per project, rendered from template)
[databases]
* = host=db port=5432

[pgbouncer]
listen_port = 6432
pool_mode = transaction
auth_type = scram-sha-256
auth_user = pgbouncer_auth
auth_query = SELECT usename, passwd FROM corebase.pgbouncer_lookup($1)

max_client_conn = 200          ; client side is cheap; this is the serverless-burst absorber
default_pool_size = 6          ; per (user, database) pair — one real pair per project
reserve_pool_size = 2
reserve_pool_timeout = 3
max_prepared_statements = 100  ; protocol-level prepared statement support (§2)
server_reset_query = DISCARD ALL
server_idle_timeout = 240      ; shed idle server conns — frees Postgres backends on quiet projects
query_wait_timeout = 60        ; fail queued queries loudly instead of hanging forever
```

The asymmetry is the whole point: **200 client connections against 8 server slots**. For a small tenant, 8 concurrently-executing transactions is far beyond Free-tier workloads; the queue (`query_wait_timeout`) converts overload into visible latency then errors, not into Postgres connection exhaustion. Larger plans scale `default_pool_size` and `max_connections` together via the same template.

### 6. RLS context under transaction pooling

RLS context (who is asking) must be attached per *request*, and transaction mode guarantees only that a transaction stays on one server connection. Therefore the only safe pattern — mandated by D-015 and detailed in [RLS design](../06-security/02-rls-design.md) — is:

```sql
BEGIN;
SET LOCAL role = 'authenticated';
SET LOCAL request.jwt.claims = '{"sub":"<user-uuid>","role":"authenticated", ...}';
-- application queries; policies read auth.uid() → current claim
COMMIT;  -- SET LOCAL evaporates with the transaction, before the conn returns to the pool
```

`SET LOCAL` cannot outlive the transaction, so no identity can ever leak onto a server connection handed to another client — the property that makes transaction pooling *safe* for a multi-user API, not merely tolerable. PostgREST does exactly this internally per request (§3); customers building custom servers against `DATABASE_URL` get the same pattern documented with copy-paste snippets. A bare `SET`-based context helper will never appear in Corebase docs or SDKs.

### 7. Future path: multi-tenant pooler (pgcat-class)

Per-project PgBouncer costs ~10–20 MiB RSS and one more container per project — booked in the [cost model](../12-business/01-cost-model.md) and acceptable at V1 scale. It also has ceilings: PgBouncer is single-threaded (irrelevant for small tenants, relevant if we ever front big ones), and thousands of poolers are thousands of config surfaces.

The escape hatch is a multi-tenant pooler (pgcat or successor): one pooler process per node, per-tenant pools inside it. **Trigger condition to open that project:** any of (a) pooler fleet overhead exceeds ~5% of node RAM at target density, (b) a paid tier needs >2 vCPU of pooling throughput for a single project, or (c) pooler config drift causes a second SEV. Until a trigger fires, per-project PgBouncer stands — it is the simplest thing that preserves per-tenant blast radius, and blast radius outranks density (D-002).

## Decisions

**D-074 — Pooler auth uses the auth_query pattern (dedicated `pgbouncer_auth` role + SECURITY DEFINER lookup function allowlisting only customer-facing pooled roles); userlist.txt rejected. Standard small-tenant sizing: `max_client_conn = 200`, `default_pool_size = 6` + `reserve_pool_size = 2`, `max_prepared_statements = 100`, `server_idle_timeout = 240`, against `max_connections = 20` budgeted as 3 reserved / 7 PostgREST / 8 pooler / 2 direct. PostgREST connects directly to Postgres (LISTEN-based schema reload and prepared statements), never through PgBouncer.** *(Rationale: auth_query makes rotation a single ALTER ROLE with no file-shipping to drift, keeps verifier material out of pooler containers, and the in-function allowlist stops the pooled port from reaching internal roles; the sizing keeps a hard, legible budget under a 20-connection instance; PostgREST's LISTEN requirement makes routing it through transaction pooling impossible.)*

(D-015 remains the governing decision for mode and placement; this doc implements it.)

## Open Questions

- **OQ-072** — Multi-tenant pooler evaluation: when a §7 trigger fires, pgcat vs Supavisor-class vs sticking with sharded PgBouncers — needs a measured bake-off (latency under SCRAM auth_query, per-tenant isolation guarantees) rather than a paper choice. Parked until a trigger fires.
- **OQ-073** — Should Free-tier direct connections be capped by a per-role `CONNECTION LIMIT` on `developer` (e.g., `CONNECTION LIMIT 5`) to make the §5 "2 direct slots" budget enforced rather than advisory? Leaning yes; needs a check that it doesn't break common GUI tools that open several connections.

## Dependencies

- Builds on: [postgres provisioning](01-postgres-provisioning.md) (stack, config template), [decision log](../00-foundation/05-decision-log.md) (D-015, D-011, D-029), [rest-api-design](../04-data-api/01-rest-api-design.md)
- Feeds: [RLS design](../06-security/02-rls-design.md), [request pipeline](../04-data-api/02-request-pipeline.md), [credentials & secrets](03-credentials-and-secrets.md), [migrations](04-migrations.md), [CLI spec](../10-cli-and-sdk/01-cli-spec.md), [cost model](../12-business/01-cost-model.md)
