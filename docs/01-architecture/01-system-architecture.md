# System Architecture

## Purpose

The complete V1 system picture: every process that runs, where it runs, and how a request of each major kind travels through it. This doc is the map the rest of the corpus zooms into. It concretizes proposal §6, §25–27, §120 under the binding decisions D-009 (container-per-project), D-010 (TS modular monolith), D-016 (Cloudflare + thin gateway), D-020 (worker as the one separate process), D-023 (Hetzner/Cloudflare/R2), and D-024 (single region eu-central).

## Design

### The V1 topology

```text
                                   Internet
                                      │
                     ┌────────────────┴────────────────┐
                     │        Cloudflare edge          │
                     │  DNS · DDoS · WAF basics        │
                     │  TLS: steadhold.dev,            │
                     │       *.steadhold.dev,          │
                     │       *.steadhold.app (wildcard)│
                     └───┬──────────────┬──────────────┘
        steadhold.dev    │              │  app.steadhold.dev
        (marketing,      │              │  api.steadhold.dev
         CF Pages)       │              │  <ref>.steadhold.app
                         │              ▼
                         │   ┌─────────────────────────────────────────┐
                         │   │  APP NODE (Hetzner, eu-central)         │
                         │   │  ┌───────────────────────────────────┐  │
                         │   │  │ Caddy — origin TLS, reverse proxy │  │
                         │   │  └───────────────┬───────────────────┘  │
                         │   │                  ▼                      │
                         │   │  ┌───────────────────────────────────┐  │
                         │   │  │ services/api — modular monolith   │  │
                         │   │  │  (Node 22 + Fastify, D-010)       │  │
                         │   │  │  ├─ gateway module (data plane)   │  │
                         │   │  │  ├─ control-plane module          │  │
                         │   │  │  ├─ auth module                   │  │
                         │   │  │  └─ storage-api module            │  │
                         │   │  └───────┬───────────────┬───────────┘  │
                         │   │          │               │              │
                         │   │  ┌───────▼─────┐  ┌──────▼───────────┐  │
                         │   │  │ Redis       │  │ services/worker  │  │
                         │   │  │ queue, rate │  │ (BullMQ consumer,│  │
                         │   │  │ limits, pub │─▶│  provisioner +   │  │
                         │   │  │ /sub        │  │  reconciler)     │  │
                         │   │  └─────────────┘  └──────┬───────────┘  │
                         │   └─────────┬────────────────┼──────────────┘
                         │             │ SQL            │ Docker Engine
                         │             ▼                │ API over mTLS
                         │   ┌──────────────────┐       │
                         │   │ CONTROL-PLANE PG │       │
                         │   │ node (D-012)     │       │
                         │   └──────────────────┘       │
                         │                              ▼
                         │   ┌────────────────────────────────────────┐
                         │   │  DATA NODES ×N (Hetzner 64GB)          │
                         │   │  per project (D-009, D-054):           │
                         │   │   ┌──────────┐ ┌──────────┐ ┌────────┐ │
                         │   │   │ Postgres │◀│ PgBouncer│◀│PostgREST││
                         │   │   │ 17 ctr   │ │ ctr      │ │ ctr    │ │
                         │   │   └──────────┘ └──────────┘ └────────┘ │
                         │   │  + pgBackRest (WAL → R2) + node-exporter│
                         │   └────────────────────┬───────────────────┘
                         │                        │
                         ▼                        ▼
                ┌──────────────┐        ┌──────────────────┐
                │ MONITORING   │        │ Cloudflare R2    │
                │ node: Prom + │        │ objects, backups,│
                │ Grafana+Loki │        │ WAL archive      │
                └──────────────┘        └──────────────────┘
```

Private traffic (gateway → data nodes, worker → Docker API, pgBackRest → R2 egress point) rides the Hetzner private network; nothing on a data node is reachable from the public internet except through Cloudflare → Caddy → gateway.

### Service inventory (what actually runs in V1)

| Unit | Process/container | Runs on | Deploy cadence | Notes |
|---|---|---|---|---|
| Marketing site | Cloudflare Pages | edge | ad hoc | `steadhold.dev` |
| Dashboard | Next.js (`apps/dashboard`) | app node (or CF Pages) | with monolith | `app.steadhold.dev`; talks only to `api.steadhold.dev` |
| Caddy | systemd + container | app node | rare | origin TLS termination (D-050), Cloudflare Origin CA cert, authenticated origin pulls |
| **services/api** | one Node process | app node | continuous | the modular monolith: gateway, control-plane, auth, storage-api modules (D-010, D-020) |
| **services/worker** | one Node process | app node | independent of api | the ONE separate process from day one (D-020): BullMQ jobs + reconciliation loop |
| Redis | container | app node | rare | queue (D-018), rate-limit buckets (D-033), routing pub/sub (D-051). Never a source of truth |
| Control-plane Postgres | dedicated node (or managed, provisional) | CP node | rare | D-012; desired state of the whole fleet |
| Per-project triplet | 3 containers | data nodes | reconciler-managed | Postgres 17 + PgBouncer + PostgREST per project (D-009, D-011, D-015, D-037, D-054) |
| pgBackRest | cron/systemd per node | data nodes | rare | nightly base + continuous WAL to R2 (D-019) |
| Observability stack | Prometheus, Grafana, Loki | monitoring node | rare | D-021 |

Everything above is Docker Compose under systemd per node, provisioned by Terraform + cloud-init (D-022). No Kubernetes.

### How `<project-ref>.steadhold.app` reaches the right container

1. **DNS**: a single wildcard record `*.steadhold.app` points at Cloudflare-proxied origin IPs (the app node's Caddy). No per-project DNS records ever exist — the ref is only meaningful to the gateway.
2. **Edge**: Cloudflare terminates client TLS with the `*.steadhold.app` wildcard cert and opens an origin connection to Caddy carrying the original `Host` header (see [domain & region model](04-domain-and-region-model.md) for the TLS chain).
3. **Gateway**: the gateway module extracts the ref from `Host`, and looks it up in its **in-memory routing table** — `ref → {project_id, node private IP, postgrest_port, pooler_port, status, public JWT key, rate-limit tier}` — which is hydrated from the control plane at boot and kept fresh via Redis pub/sub invalidation plus a periodic full refresh (D-051). The hot path never queries control-plane Postgres ([control vs data plane](02-control-vs-data-plane.md)).
4. **Dispatch by path prefix**: `/rest/v1/*` proxies over the private network to that project's PostgREST container port; `/auth/v1/*` dispatches in-process to the auth module (which connects to the project's pooler); `/storage/v1/*` dispatches to the storage-api module. Unknown ref → 404; `PAUSED` project → resume trigger (D-008, see [multi-tenancy](03-multi-tenancy-and-isolation.md), OQ-050); `SUSPENDED/DELETING` → 403/410.

Port allocation is per node: each project triplet gets stable host ports recorded in the control plane at provision time and mirrored into the routing table.

### Request lifecycle A — control plane: "create project"

```text
dashboard ── POST api.steadhold.dev/v1/projects {name, region, plan}
  1. Cloudflare → Caddy → monolith: control-plane module
  2. Session/authn check; org membership + plan quota check
  3. One transaction in control-plane PG:
       INSERT projects (status=CREATING, ref=<generated per D-056>, region)
       INSERT provisioning_jobs (idempotency_key, state=PENDING)   ← state of record (D-018)
  4. Enqueue job in BullMQ (Redis); respond 202 {project, status: CREATING}
  5. worker picks job:
       a. pick data node (bin-pack on reserved RAM headroom)
       b. generate DB credentials + ES256 project keypair (D-014);
          envelope-encrypt and store (D-035); derive anon/service_role JWTs (D-029)
       c. via Docker Engine API over mTLS (D-052): create volume (quota'd),
          start postgres → pgbouncer → postgrest containers
       d. apply base schema: roles (anon/authenticated/service_role),
          auth schema, storage.objects, RLS scaffolding (D-036)
       e. register pgBackRest stanza; take first base backup (D-019)
       f. mark project READY; publish routing-table update on Redis pub/sub
  6. dashboard polls GET /v1/projects/:id until READY; shows connection
     strings, keys, <ref>.steadhold.app endpoint
```

Every worker step is idempotent (proposal §75–76): "create container" is "ensure container exists with this spec." Crash + retry converges instead of duplicating. Full state machine: [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md).

### Request lifecycle B — data plane: REST query through PostgREST

```text
client ── GET https://abck3xw7….steadhold.app/rest/v1/todos?select=*&done=eq.false
          headers: apikey: <anon JWT>, Authorization: Bearer <user JWT>
  1. Cloudflare: TLS, DDoS scrub, forwards with Host intact
  2. Caddy → gateway module:
       a. Host → routing-table lookup (in-memory, D-051)
       b. verify apikey signature against cached project public key (D-014/D-029)
       c. rate-limit check: IP → key → project buckets in Redis (D-033)
       d. attach X-Request-ID; proxy to node-private-ip:postgrest_port
  3. PostgREST (project's own instance, D-011):
       verify user JWT (same project key), map role claim → Postgres role,
       open txn via PgBouncer (transaction mode, D-015),
       SET LOCAL role + request.jwt.claims, compile query → SQL
  4. Postgres: RLS policies filter rows (D-036) → result
  5. Response streams back gateway → Caddy → Cloudflare → client,
     with X-Request-ID and the uniform error envelope on failure (D-032)
```

Note what the gateway did **not** do: no control-plane DB query, no session lookup, no query parsing. It is a resolver + validator + proxy — that is the whole point of D-016. Detail: [request pipeline](../04-data-api/02-request-pipeline.md).

### Request lifecycle C — auth login

```text
client ── POST https://<ref>.steadhold.app/auth/v1/token?grant_type=password
  1. Cloudflare → Caddy → gateway: ref resolution + per-identifier rate limit
  2. dispatch in-process to auth module (D-013 — in-house, in the monolith)
  3. auth module connects to the PROJECT's database via its pooler
     (reserved steadhold_auth role): SELECT from auth.users,
     timing-safe verify of password hash, enumeration-resistant errors
  4. issue tokens: ES256 access JWT signed with the project private key
     (decrypted via KMS, cached in memory), kid in header (D-014);
     rotating refresh token — store only its hash in auth.refresh_tokens,
     with reuse-detection lineage (D-013)
  5. respond {access_token, refresh_token, expires_in, user}
```

User records live in the **project's** database (`auth` schema), not the control plane — that is what makes user export possible (D-004) and keeps customer PII out of the control plane. Sequence detail: [auth flows](../05-auth/03-flows.md), [sessions & tokens](../05-auth/02-sessions-and-tokens.md).

### Request lifecycle D — storage upload

```text
client ── POST https://<ref>.steadhold.app/storage/v1/object/avatars/me.png
          Authorization: Bearer <user JWT>   (body: file stream)
  1. Cloudflare → Caddy → gateway: ref resolution, key check, rate limit
  2. dispatch to storage-api module
  3. verify user JWT; load bucket config (public/private, size/MIME limits)
  4. open txn in the project DB: INSERT INTO storage.objects (metadata row) —
     the INSERT runs as the user's role, so storage RLS policies decide
     authorization (D-017: metadata-in-PG is what makes files RLS-able)
  5. stream body to R2 under key steadhold-prod/<ref>/avatars/<object-id>
  6. commit metadata row only after R2 confirms; on R2 failure, rollback
     (orphan-object sweeps handle the reverse case —
      see storage architecture)
  7. respond {Key, id}; downloads run the same path in reverse, or via
     signed URLs minted by storage-api
```

Uploads transit the app node in V1 (simple, one code path); presigned direct-to-R2 upload is the pressure valve if bandwidth becomes a cost problem (OQ-053). Detail: [storage architecture](../07-storage/01-storage-architecture.md), [storage API & policies](../07-storage/02-storage-api-and-policies.md).

### Intentionally NOT in the V1 architecture

| Absent | Why | Where it would land later |
|---|---|---|
| Kubernetes / any orchestrator | D-022; Compose-under-systemd is inspectable by a 3-person team | [infra phases](../11-infrastructure/01-infra-phases.md) |
| Realtime service (WAL CDC, WebSockets) | D-030; replication slots can kill a customer primary | [realtime architecture](../08-realtime/01-realtime-architecture.md) |
| Edge/serverless functions | proposal §82; compute platform after the data platform is boring | [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md) |
| Multi-region, read replicas, geo-routing | D-024; schema carries `region` from day one so nothing is retrofitted | [domain & region model](04-domain-and-region-model.md) |
| Separate gateway/auth deployables | D-020; split triggers are codified, not vibes | [repo & service layout](05-repo-and-service-layout.md) |
| Per-node agent daemon | worker drives Docker Engine API remotely (D-052); one fewer fleet-wide deployable | this doc |
| Envoy/Nginx-class custom gateway | C-3 resolution: edge concerns belong to Cloudflare; only project resolution/key validation/rate limiting is ours (D-016) | [request pipeline](../04-data-api/02-request-pipeline.md) |
| GraphQL, vectors, AI, analytics, CDN | D-007, proposal §82 | [V1 scope & cut list](../14-roadmap/02-v1-scope-and-cutlist.md) |

## Decisions

- **D-050 — Origin TLS is terminated by Caddy on the app node using a Cloudflare Origin CA certificate for `*.steadhold.app` (and `api./app.steadhold.dev`), with authenticated origin pulls enforced; Caddy forwards to the monolith over loopback.** *(Rationale: keeps TLS lifecycle out of application code, blocks direct-to-origin bypass of Cloudflare, and gives a zero-code path to later putting the gateway on more nodes; "don't build a gateway" (C-3) extends to "don't hand-roll TLS in Fastify".)*
- **D-051 — The gateway routes from an in-memory routing table (`ref → node/ports/status/public key/limits`), hydrated from control-plane Postgres at boot, invalidated via Redis pub/sub, and fully refreshed on an interval; the data-plane hot path never queries control-plane Postgres.** *(Rationale: decouples data-plane availability and latency from the control plane — the failure-domain requirement of §121; a full table for even 100k projects is a few hundred MB, trivially memory-resident.)*
- **D-052 — The worker manages data nodes over the Docker Engine API with mutual TLS on the private network; there is no custom per-node agent in V1.** *(Rationale: one fewer deployable to version and roll; the Engine API already exposes everything provisioning needs — create/start/stop/inspect containers and volumes — and idempotent "ensure" semantics are straightforward to build on `inspect`.)*

(Also binding here, defined in sibling docs: D-054/D-055 in [multi-tenancy](03-multi-tenancy-and-isolation.md); D-053 in [control vs data plane](02-control-vs-data-plane.md); D-056–D-058 in [domain & region model](04-domain-and-region-model.md); D-059 in [repo & service layout](05-repo-and-service-layout.md).)

## Open Questions

- **OQ-051** — Private-network transport between app node and data nodes: is the Hetzner private network/vSwitch alone acceptable for V1, or do we run WireGuard on top for encryption in transit between nodes? (Proposal §65 says "TLS everywhere"; gateway→PostgREST is currently plain HTTP on the private LAN.) Owner: [platform security](../06-security/04-platform-security.md).
- **OQ-053** — At what monthly bandwidth or file-size threshold do storage uploads switch from transiting the storage-api module to presigned direct-to-R2 uploads? Needs the [cost model](../12-business/01-cost-model.md) egress numbers.
- **OQ-059** — Does the dashboard deploy to Cloudflare Pages (static/SSR at edge) or ride the app node behind Caddy? Pages is cheaper and faster; app node keeps everything in one deploy pipeline. Decide at [dashboard IA](../09-dashboard/01-dashboard-ia.md) time.

## Dependencies

- Builds on: [../00-foundation/01-vision-and-principles.md](../00-foundation/01-vision-and-principles.md), [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md)
- Feeds: [02-control-vs-data-plane.md](02-control-vs-data-plane.md), [03-multi-tenancy-and-isolation.md](03-multi-tenancy-and-isolation.md), [04-domain-and-region-model.md](04-domain-and-region-model.md), [05-repo-and-service-layout.md](05-repo-and-service-layout.md), [../02-control-plane/03-provisioning-state-machine.md](../02-control-plane/03-provisioning-state-machine.md), [../04-data-api/02-request-pipeline.md](../04-data-api/02-request-pipeline.md), [../11-infrastructure/01-infra-phases.md](../11-infrastructure/01-infra-phases.md)
