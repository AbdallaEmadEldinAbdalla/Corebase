# Request Pipeline

## Purpose

The hop-by-hop trace of a data-plane request — from a client's `fetch` to RLS-filtered rows and back — with the error surface, latency budget, and caching/invalidation contract at every hop. This is the doc that proves D-016 (thin gateway) in the concrete: the gateway resolves, validates, rate-limits, and proxies; it never parses queries, never touches the control-plane database on the hot path ([control vs data plane](../01-architecture/02-control-vs-data-plane.md), D-051), and never holds customer data. Companion docs: [01-rest-api-design.md](01-rest-api-design.md) for what PostgREST does with the request, [03-api-keys-and-roles.md](03-api-keys-and-roles.md) for what the two JWTs mean.

## Design

### The trace

```text
 client            Cloudflare          gateway (app node)                 data node (project triplet)
   │                   │                     │                                  │
   │ GET /rest/v1/todos?done=eq.false        │                                  │
   │ Host: abck3xw7….corebase.co             │                                  │
   │ apikey: <anon JWT>                      │                                  │
   │ Authorization: Bearer <user JWT>        │                                  │
   ├──── TLS ─────────►│                     │                                  │
   │                   │ DDoS/WAF scrub      │                                  │
   │                   ├── origin TLS ──────►│  (via Caddy, D-050)              │
   │                   │  Host preserved     │                                  │
   │                   │                     │ 1. Host → routing-table lookup   │
   │                   │                     │    (in-memory, D-051)            │
   │                   │                     │ 2. apikey: verify JWT sig against│
   │                   │                     │    cached project JWKS (kid),    │
   │                   │                     │    check revocation set          │
   │                   │                     │ 3. rate limits: IP → key →       │
   │                   │                     │    project buckets (Redis, D-033)│
   │                   │                     │ 4. mint/propagate X-Request-ID   │
   │                   │                     │    (D-032)                       │
   │                   │                     ├── private LAN ──────────────────►│
   │                   │                     │   /rest/v1/* → PostgREST port    │
   │                   │                     │   (/auth/v1, /storage/v1 →       │
   │                   │                     │    in-process modules instead)   │
   │                   │                     │                                  │ 5. PostgREST: verify
   │                   │                     │                                  │    Authorization JWT
   │                   │                     │                                  │    (JWKS file, kid),
   │                   │                     │                                  │    read role claim
   │                   │                     │                                  │ 6. BEGIN;
   │                   │                     │                                  │    SET LOCAL ROLE authenticated;
   │                   │                     │                                  │    SET LOCAL request.jwt.claims=…;
   │                   │                     │                                  │    SET LOCAL application_name=<req-id>;
   │                   │                     │                                  │    (pre-request fn, D-105)
   │                   │                     │                                  │ 7. compiled SQL runs;
   │                   │                     │                                  │    RLS filters rows (D-036)
   │                   │                     │                                  │ 8. COMMIT → JSON
   │                   │◄────────────────────┤◄─────────────────────────────────┤
   │◄──────────────────┤  X-Request-ID, Content-Range, …                        │
```

Step 6 is the D-015 pattern: all request context is `SET LOCAL` inside the transaction, so it evaporates at `COMMIT` and can never leak across requests — this holds whether the connection is PostgREST's own pool (direct, D-101) or a customer connection through PgBouncer transaction mode.

What the gateway did **not** do: no control-plane query, no session lookup, no SQL awareness, no response-body inspection. Total custom hot-path code is a table lookup, one ES256 verification, three Redis bucket checks, and a proxy — that is the entire D-016 mandate.

### Hop-by-hop responsibilities and error mapping

| # | Hop | Does | Failure → response |
|---|---|---|---|
| 1 | Cloudflare | client TLS (`*.corebase.co` wildcard), DDoS scrub, WAF basics; no caching of `/rest/*` (dynamic, bypass rule) | origin unreachable → CF 52x (edge-styled) |
| 2 | Caddy (app node) | origin TLS (D-050), authenticated origin pulls (direct-to-origin blocked), forward to gateway on loopback | monolith down → 502 (Caddy) |
| 3 | Gateway: project resolution | `Host` → ref → routing-table entry `{project_id, node_ip, ports, status, JWKS, tier}` — in-memory, control-plane-independent (D-051) | unknown ref → **404** `project_not_found`; `soft_deleted`/`deleting` → **410** `project_deleted`; suspended → **403** `project_suspended` |
| 4 | Gateway: apikey validation | header present, structurally a JWT, ES256 signature valid against cached project JWKS (by `kid`), `ref` claim matches the resolved project, key hash not in revocation set | missing/malformed → **401** `missing_api_key`; bad signature / wrong ref / revoked → **401** `invalid_api_key` |
| 5 | Gateway: rate limits | layered sliding windows in Redis (D-033): per-IP, per-key, per-project (tier from routing entry) | exceeded → **429** `rate_limited` + `Retry-After: <s>` + `X-RateLimit-*` headers |
| 6 | Gateway: paused project | status `paused` → trigger resume (D-103/D-172, below) | **503** `project_resuming` + `Retry-After: 5` |
| 7 | Gateway: dispatch | `/rest/v1/*` → proxy to project PostgREST; `/auth/v1/*`, `/storage/v1/*` → in-process modules | node/PostgREST unreachable → **503** `service_unavailable` (alert fires; see [observability](../11-infrastructure/03-observability.md)) |
| 8 | PostgREST: user JWT | verify `Authorization` JWT (JWKS file, `kid`), read `role` claim; absent header → gateway has already substituted the apikey (D-109 in [api-keys-and-roles](03-api-keys-and-roles.md)), so PostgREST always sees a token | invalid/expired → **401** (PGRST301-class body, passed through) |
| 9 | Postgres | `SET LOCAL` role + claims; SQL under RLS; statement timeout per role | RLS denial → **404**/empty set (policies filter, they don't error); constraint violation → **409/4xx** with SQLSTATE; timeout → **500** `57014` |

Gateway-originated errors (hops 3–7) use the uniform envelope `{"error": {"code", "message", "request_id"}}` (D-032). PostgREST-originated bodies (hops 8–9) pass through **verbatim** (**D-106**): rewriting them would put a JSON parse/serialize on the hot path (against D-016) and break Supabase-client compatibility, which keys off PGRST/SQLSTATE codes. `X-Request-ID` is attached to every response either way.

### The paused-project resume flow (D-103, values per D-172)

Free-tier projects pause when idle (D-008); the first request back is the wake-up call:

```text
request → gateway: routing entry says status=paused
  1. enqueue resume_project job, idempotency_key = "resume:<project_id>"
     (UNIQUE in provisioning_jobs — concurrent requests collapse to one job)
  2. respond immediately:
       HTTP/1.1 503 Service Unavailable
       Retry-After: 5
       X-Request-ID: 01J…
       {"error":{"code":"project_resuming",
                 "message":"Project is resuming; retry after the indicated delay.",
                 "request_id":"01J…"}}
  3. worker: start postgres → pgbouncer → postgrest containers (volume was
     never destroyed — D-008), health-check, mark ready, publish routing update
  4. client (SDK auto-retries on 503+Retry-After) → normal pipeline
```

`Retry-After: 5` puts the SDK's retries at ~5/10/15 s — riding the p50 <5 s / p95 <15 s resume targets from [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) (D-072), so the first retry lands at the median resume time; the value is config, not code, and is revised as resume telemetry accumulates. The gateway does **not** hold the request open in V1 (OQ-102 revisits this). SDK behavior: retry up to 3 times honoring `Retry-After`, then surface the error.

### Latency budget

Targets for the full `/rest/v1` pipeline, intra-region (client in EU, project in eu-central per D-024), simple indexed single-table query, warm caches, project running:

| Hop | p50 | p99 | Notes |
|---|---|---|---|
| Client → Cloudflare edge | 5 ms | 20 ms | client-dependent; EU assumption |
| CF edge processing + edge → Caddy | 5 ms | 25 ms | warm origin keep-alive assumed |
| Caddy → gateway (loopback) | <0.5 ms | 1 ms | |
| Gateway: route lookup | <0.1 ms | 0.5 ms | in-memory map |
| Gateway: apikey ES256 verify | 0.2 ms | 1 ms | cached public key; verify only, no KMS |
| Gateway: rate-limit checks (Redis) | 0.5 ms | 3 ms | Redis on same node; 3 buckets pipelined |
| Gateway → PostgREST (private LAN) | 0.5 ms | 2 ms | persistent upstream connections |
| PostgREST: JWT verify + compile | 1 ms | 5 ms | JWKS local file; jwt-cache warm |
| Postgres: txn + SET LOCAL + query + RLS | 2 ms | 25 ms | indexed read; RLS policy cost tracked in [RLS design](../06-security/02-rls-design.md) |
| Response path back | 2 ms | 10 ms | |
| **End-to-end target** | **≤ 20 ms origin / ≤ 50 ms total** | **≤ 250 ms** | origin = Caddy-in to Caddy-out, our SLO surface |

Two SLOs fall out: **origin processing ≤ 20 ms p50 / ≤ 100 ms p99** (what we control and alert on) and **client-observed ≤ 50 ms p50 intra-region** (what we advertise). The budget's structural point: everything Corebase added around PostgREST (hops 3–7) costs ~1.5 ms p50 — the gateway must stay cheap enough that nobody is ever tempted to bypass it.

### What is cached where, and how it invalidates

| Cache | Location | Contents | Invalidation |
|---|---|---|---|
| Routing table | gateway process memory | `ref → {project_id, node_ip, ports, status, JWKS(kids), tier}` | Redis pub/sub `cb:routing` on any project mutation (provision, pause, resume, suspend, delete) + full refresh every 60 s (D-051, D-104) |
| Project JWKS (verify side) | inside routing entry | active public keys by `kid` | same channel, on key rotation ([api-keys-and-roles](03-api-keys-and-roles.md)) |
| API-key revocation set | gateway process memory | SHA-256 hashes of revoked keys ([data model](../02-control-plane/01-data-model.md) `project_api_keys.revoked_at`) | Redis pub/sub `cb:keys` — **≤ 30 s propagation SLO** (D-104) |
| Rate-limit buckets | Redis | sliding-window counters | TTL expiry |
| PostgREST schema cache | PostgREST process | catalog: tables, FKs, functions | `NOTIFY pgrst, 'reload schema'` event trigger on DDL (D-100) |
| PostgREST JWKS file + config | container fs + process | signing keys, pool sizes | provisioner re-render + `NOTIFY pgrst, 'reload config'` / SIGUSR2 |
| Cloudflare edge | edge | nothing for `/rest/*` | cache bypass rule |

**Invalidation mechanism (D-104):** every control-plane mutation that affects the data plane commits to control-plane Postgres first (state of record), then publishes `{ref, change}` on the relevant Redis channel. Gateway instances apply the delta immediately; the 60-second full refresh from control-plane Postgres is the backstop for lost messages (Redis pub/sub is fire-and-forget). Worst-case staleness is therefore one refresh interval; the ≤ 30 s SLO for **key revocation** specifically is met by the pub/sub fast path and verified by a continuous canary (revoke a synthetic key, measure until the gateway 401s — part of the [tenant-isolation test suite](../06-security/03-tenant-isolation-tests.md)). If Redis is down, revocations still land within one refresh cycle — degraded to ≤ 90 s, alerting meanwhile.

### Request-ID propagation (D-032, D-105)

```text
Cloudflare (CF-Ray: 8f2…)                      recorded, not reused
  └─► gateway mints X-Request-ID: 01JDXAMPLE… (ULID; per-request)
        ├─ logged in gateway access log {request_id, ref, key_kind, status, ms}
        ├─ header forwarded to PostgREST
        │    └─ pre-request fn copies it into application_name (≤64 chars: fits)
        │         ├─ pg_stat_activity.application_name  → live debugging
        │         └─ log_line_prefix '%a'               → Postgres logs in Loki
        ├─ returned to client on EVERY response, success or error (D-032)
        └─ embedded in error envelope bodies
```

The Postgres leg is the piece most stacks skip: PostgREST exposes request headers to SQL as the `request.headers` GUC, and the provision-time `pre-request` function (configured `db-pre-request = "corebase.pre_request"`, see [01-rest-api-design.md](01-rest-api-design.md)) promotes the request ID into `application_name` via `set_config(..., true)` — transaction-local, so it cannot bleed across pooled connections. Result: one `grep 01JDXAMPLE` in Loki returns the gateway line, the PostgREST line, and the exact Postgres statements of a single customer request. Auth/storage module requests do the same via `SET LOCAL application_name` on their pooler connections.

## Decisions

- **D-103 — A request to a paused project triggers an idempotent `resume_project` job (idempotency key `resume:<project_id>`) and immediately returns `503` + `Retry-After`; the gateway never holds requests open awaiting resume in V1; official SDKs retry automatically honoring `Retry-After`. D-103's original response values (`Retry-After: 15`, error code `project_paused`) are superseded by D-172's `Retry-After: 5` / `project_resuming`; the never-hold stance stands.** *(Rationale: first-request wake-up makes D-008 invisible for well-behaved clients without turning the gateway into a stateful waiting room; the UNIQUE idempotency key collapses request stampedes into one job.)*
- **D-172 — Paused-project request handling: the gateway never holds requests open. The first request to a paused project idempotently enqueues the resume job and immediately returns `503` with `Retry-After: 5` and error code `project_resuming`; subsequent requests during resume get the same response. SDKs auto-retry up to 3 times (retries at ~5/10/15 s, matching the p50 <5 s / p95 <15 s resume targets); direct TCP remains refused while paused. Supersedes D-072's hold-≤20 s mechanics and D-103's `Retry-After: 15` / `project_paused` values; OQ-102 (optional long-poll) stays open.** *(Rationale: never-hold keeps gateway concurrency exposure bounded and failure semantics explicit; Retry-After 5 makes the first SDK retry land at the median resume time instead of parking every client for three times that; `project_resuming` is the truthful state once the job is enqueued.)*
- **D-104 — All data-plane caches derived from control-plane state (routing, JWKS, key revocation) invalidate via Redis pub/sub deltas published after commit, backstopped by a 60 s full refresh; key revocation carries an explicit ≤ 30 s propagation SLO verified by a continuous synthetic-revocation canary.** *(Rationale: extends D-051 from routing to all derived caches with one mechanism; pub/sub alone is fire-and-forget, so the refresh loop bounds staleness even through Redis outages; revocation is the security-relevant path and gets the measured SLO.)*
- **D-105 — The gateway-minted `X-Request-ID` (ULID) propagates into Postgres as `application_name`, set transaction-locally by PostgREST's `pre-request` function (from the `request.headers` GUC) and by `SET LOCAL` in the auth/storage modules; `log_line_prefix` includes `%a` on every project database.** *(Rationale: completes D-032 end-to-end — support can trace one request from edge to the exact SQL statements; transaction-local scoping is the only variant that is safe under connection multiplexing per D-015.)*
- **D-106 — PostgREST response bodies, including errors (PGRST/SQLSTATE codes), pass through the gateway unmodified; the D-032 error envelope applies to gateway-originated errors only. `X-Request-ID` is attached at the header layer in both cases.** *(Rationale: body rewriting would add parse/serialize work to the hot path against D-016 and break compatibility with Supabase-style clients that switch on PostgREST error codes; the envelope still covers every error the gateway itself mints.)*

## Open Questions

- **OQ-102** — Resume UX: should the gateway optionally hold the first request (long-poll up to ~10 s) when telemetry says resume typically completes faster than that, instead of always returning 503? Better first-request UX vs. held connections during a resume stampede. Decide once real resume-time distributions exist ([postgres provisioning](../03-database-platform/01-postgres-provisioning.md)).
- **OQ-103** — Rate-limit check placement at scale: three Redis round-trips per request is fine while Redis is node-local; if the gateway ever runs on multiple nodes (split triggers in [repo & service layout](../01-architecture/05-repo-and-service-layout.md)), do buckets move to in-process token buckets with async Redis reconciliation, accepting small over-admission for latency?
- **OQ-051** *(owned by [platform security](../06-security/04-platform-security.md), restated here because this pipeline is the affected path)* — gateway → PostgREST currently rides plain HTTP on the Hetzner private LAN; WireGuard overlay or not for V1.

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-008, D-015, D-016, D-032, D-033, D-036), [../01-architecture/01-system-architecture.md](../01-architecture/01-system-architecture.md) (D-050–D-052), [../01-architecture/02-control-vs-data-plane.md](../01-architecture/02-control-vs-data-plane.md), [01-rest-api-design.md](01-rest-api-design.md) (D-100, D-101), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md)
- Feeds: [03-api-keys-and-roles.md](03-api-keys-and-roles.md), [../06-security/01-threat-model.md](../06-security/01-threat-model.md), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md), [../11-infrastructure/03-observability.md](../11-infrastructure/03-observability.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md)
