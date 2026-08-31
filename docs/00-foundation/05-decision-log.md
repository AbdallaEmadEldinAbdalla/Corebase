# Decision Log

## Purpose

The single authoritative register of every locked decision in the corpus, ADR-style but compact. Any doc may *propose*; only entries here are *binding*. If two docs disagree, this log wins; if this log is silent, the disagreement is a bug — file it in [open questions](../15-risks/02-open-questions.md).

**Format:** `D-xxx — decision — rationale — where detailed`. Status is **Locked** unless marked *(provisional)*.

## Strategy & product

| ID | Decision | Rationale | Detail |
|---|---|---|---|
| D-001 | Differentiation axis is simplicity + portability + provisioning speed + economics — **not** feature parity with Supabase | A small team can't out-feature an incumbent; it can out-simple one | [vision](01-vision-and-principles.md) |
| D-002 | Binding priority stack: isolation & security > durability > DX > cost > breadth | Settles cross-doc conflicts mechanically | [vision](01-vision-and-principles.md) |
| D-003 | V1 audience: indie developers and startups only; agency/enterprise modeled in schemas, not built | PMF before breadth | [vision](01-vision-and-principles.md) |
| D-004 | `corebase export` (DB dump + storage manifest + users + migrations) ships in V1 | Portability is the claimed moat; untested moat = fiction | [vision](01-vision-and-principles.md), [CLI spec](../10-cli-and-sdk/01-cli-spec.md) |
| D-005 | Compose proven OSS data-plane components; don't rewrite them | Inherit a decade of edge cases for free | [competitive analysis](02-competitive-analysis.md) |
| D-006 | Three declared lanes: provisioning speed, portability, economics | Scope filter for every feature debate | [competitive analysis](02-competitive-analysis.md) |
| D-007 | No GraphQL in V1–V2 | Thin market slice; REST + SDK covers V1 users | [competitive analysis](02-competitive-analysis.md) |
| D-008 | Idle free-project **pause/resume is a day-one architectural requirement** | DB-per-project free tier is otherwise economically impossible | [provisioning](../03-database-platform/01-postgres-provisioning.md), [cost model](../12-business/01-cost-model.md) |
| D-040 | This corpus supersedes the v0.1 proposal wherever they disagree | One source of truth | [critical review](03-critical-review.md) |

## Architecture

| ID | Decision | Rationale | Detail |
|---|---|---|---|
| D-009 | **Container-per-project Postgres** on shared nodes: one dedicated Postgres instance per project, in a cgroup-limited Docker container | Dedicated-instance isolation with shared-hardware economics; resolves proposal contradiction C-4 | [multi-tenancy](../01-architecture/03-multi-tenancy-and-isolation.md) |
| D-010 | Control plane: **TypeScript modular monolith** (Node 22 + Fastify) in a pnpm + Turborepo monorepo | Velocity is the V1 priority (proposal §94); one language across API/CLI/SDK/dashboard | [repo layout](../01-architecture/05-repo-and-service-layout.md) |
| D-016 | Edge: **Cloudflare** (DNS, wildcard TLS for `*.corebase.co`, DDoS) in front of a **thin custom gateway** (Fastify) doing project resolution, key validation, rate limiting only | "Don't build a gateway" means don't build Envoy; the custom part is only what's Corebase-specific (resolves C-3) | [system architecture](../01-architecture/01-system-architecture.md), [request pipeline](../04-data-api/02-request-pipeline.md) |
| D-020 | Modular monolith until a measured constraint forces a split; provisioner **worker** is the one separate process from day one | Workers have different deploy/restart semantics than the API | [repo layout](../01-architecture/05-repo-and-service-layout.md) |
| D-023 | Providers: **Hetzner** compute, **Cloudflare** edge, **R2** object storage | Best economics for lane 3; provider-abstraction interfaces keep exit possible | [infra phases](../11-infrastructure/01-infra-phases.md) |
| D-024 | Single region for V1: **eu-central** (Hetzner Falkenstein) | Multi-region before PMF is capital destruction | [domain & region model](../01-architecture/04-domain-and-region-model.md) |
| D-031 | V1: project == environment. Environment grouping (`environment` column + project groups) modeled in the schema from day one, surfaced later | Cheap now, expensive to retrofit | [control-plane data model](../02-control-plane/01-data-model.md) |

## Database platform

| ID | Decision | Rationale | Detail |
|---|---|---|---|
| D-012 | Control-plane database: PostgreSQL, run on dedicated control-plane node(s) with the same pgBackRest tooling as customer DBs *(provisional: a managed Postgres is acceptable at first if it reduces early ops risk)* | Dogfooding; one backup system | [data model](../02-control-plane/01-data-model.md) |
| D-015 | Pooling: **PgBouncer in transaction mode**, one pooler per project container pair; RLS context injected with `SET LOCAL` inside the request transaction | Transaction mode is required for multiplexing; `SET LOCAL` is the only session-state pattern that survives it | [pooling](../03-database-platform/02-connection-pooling.md), [RLS design](../06-security/02-rls-design.md) |
| D-019 | Backups: **pgBackRest** per project — base backups + continuous WAL archiving to object storage (schedule per plan, refined by D-077); PITR; **restore always to a new instance**; automated restore verification (monthly clause superseded by D-176's continuous sampling with floors) | Untested backups are fiction; restore-to-new prevents self-inflicted data loss | [backups & PITR](../03-database-platform/05-backups-and-pitr.md) |
| D-037 | One Postgres major version fleet-wide, **PostgreSQL 17** at launch; upgrade playbook is a standing operational deliverable | Fleet heterogeneity is an ops tax a small team can't pay | [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) |
| D-028 | Migrations: plain timestamped SQL files; `db push / pull / reset` in V1; `db diff` (shadow-DB based) in V1.1 | Plain SQL = portability (D-004); diff is high-effort polish | [migrations](../03-database-platform/04-migrations.md) |
| D-035 | Secrets: envelope encryption (per-secret data keys under a master key in a KMS/sealed store); plaintext never lands in control-plane tables | Standard practice; enables key rotation | [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md) |

## Data API & auth

| ID | Decision | Rationale | Detail |
|---|---|---|---|
| D-011 | **Embed PostgREST** (one instance per project) as the data API engine; Corebase builds the gateway around it, not the query layer | The filter/embed/RPC surface is a decade of edge cases (critique §2.2); Supabase-compatible mental model eases migration *to* Corebase | [rest-api-design](../04-data-api/01-rest-api-design.md) |
| D-029 | Two project keys as long-lived JWTs signed with the project keypair: `anon` and `service_role`, mapping to Postgres roles of the same names | Two-key model is proven and explainable in one paragraph | [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md) |
| D-013 | Auth: **build a minimal in-house auth service** (TypeScript, inside the monolith) with a frozen V1 scope: email/password, verification, reset, JWT access + rotating refresh tokens with reuse detection. GoTrue's threat mitigations are adopted as a checklist, not its codebase | Keeps one language and full schema control; GoTrue would import Go + its own migration/ops surface for features V1 doesn't need. Riskiest build-vs-buy call — revisit trigger: any auth CVE-class bug found internally | [auth architecture](../05-auth/01-auth-architecture.md) |
| D-014 | JWTs signed **ES256** with per-project keypairs; `kid` in headers; per-project JWKS endpoint; documented rotation procedure | Asymmetric = data plane verifies without shared secrets; per-project keys contain blast radius | [sessions & tokens](../05-auth/02-sessions-and-tokens.md) |
| D-036 | **RLS ships with the data API** — no phase where an API serves table data without policies (fixes proposal ordering bug, critique §2.6) | The API's security model *is* RLS | [phase plan](../14-roadmap/01-phase-plan.md) |
| D-039 | Control-plane API: REST under `/v1`, cursor pagination, standard error envelope with `request_id` | Proposal §104–106 adopted | [platform API](../02-control-plane/02-platform-api.md) |
| D-032 | Uniform error format `{error: {code, message, request_id}}` and `X-Request-ID` on every response, both planes | Debuggability and support tooling | [platform API](../02-control-plane/02-platform-api.md) |
| D-033 | Rate limiting at the gateway: layered IP → API-key → project buckets, Redis-backed (sliding window) | Abuse arrives on day one of a public API | [platform security](../06-security/04-platform-security.md) |

## Storage, realtime, jobs

| ID | Decision | Rationale | Detail |
|---|---|---|---|
| D-017 | Storage: S3-compatible only — **R2 in production** (zero egress), **MinIO locally**; object metadata in the project's Postgres (`storage.objects`) | Egress is the classic margin killer; metadata-in-PG enables RLS on files | [storage architecture](../07-storage/01-storage-architecture.md) |
| D-018 | Job queue: **Redis + BullMQ**; every job carries an idempotency key; Redis is never a source of truth (job *state of record* lives in Postgres `provisioning_jobs`) | Simplest proven option; proposal §98–99 adopted with the source-of-truth caveat made structural | [job queue](../02-control-plane/04-job-queue-and-workers.md) |
| D-030 | **Realtime is post-V1.** When built: broadcast/presence (no WAL) first, WAL-based CDC last, with slot-lag kill switches | Replication slots can take down a customer primary (critique §2.4); highest-risk subsystem for lowest V1 value | [realtime architecture](../08-realtime/01-realtime-architecture.md) |
| D-038 | Project deletion: soft-delete with a **7-day recovery window**, then staged permanent deletion (disable API → final backup → destroy → verify) | Proposal §77–78 adopted with a number attached | [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) |

## Frontend, CLI, ops

| ID | Decision | Rationale | Detail |
|---|---|---|---|
| D-025 | Dashboard: Next.js + Tailwind + shadcn/ui | Proposal §39 adopted; boring is good | [dashboard IA](../09-dashboard/01-dashboard-ia.md) |
| D-026 | CLI: TypeScript in the monorepo, distributed via npm (`npm i -g corebase`), standalone binaries later | One language; fastest path | [CLI spec](../10-cli-and-sdk/01-cli-spec.md) |
| D-027 | Local dev: `corebase dev` = Docker Compose stack of the **same components as prod** (Postgres 17, PgBouncer, PostgREST, auth, storage+MinIO) | Local/prod parity is a top-3 Supabase lesson | [local development](../10-cli-and-sdk/02-local-development.md) |
| D-021 | Observability: OpenTelemetry SDK everywhere; Prometheus + Grafana + Loki self-hosted on a monitoring node | Proposal §100 adopted | [observability](../11-infrastructure/03-observability.md) |
| D-022 | IaC: Terraform + cloud-init; Docker Compose per node under systemd; **no Kubernetes in V1** | Proposal §33/§101 adopted; K8s enters only when reconciliation scale demands it | [iac & cicd](../11-infrastructure/02-iac-and-cicd.md) |
| D-034 | Licensing: SDK + CLI are **Apache-2.0 from first public release**; server components remain private until the platform API stabilizes, with **FSL (Functional Source License) as the default** choice at opening time *(provisional on the server license)* | Resolves contradiction C-2 with a concrete position; avoids the relicense-under-pressure trap | [open-source strategy](../12-business/04-open-source-strategy.md) |

## Architecture detail (from 01-architecture)

| ID | Decision | Detail |
|---|---|---|
| D-050 | Origin TLS terminated by Caddy with Cloudflare Origin CA cert + authenticated origin pulls | [domain & region model](../01-architecture/04-domain-and-region-model.md) |
| D-051 | Gateway routes from an in-memory routing table (boot hydration + Redis pub/sub + periodic refresh); the hot path never queries control-plane Postgres | [control vs data plane](../01-architecture/02-control-vs-data-plane.md) |
| D-052 | Worker manages nodes via Docker Engine API over mTLS; no per-node agent daemon | [infra phases](../11-infrastructure/01-infra-phases.md) |
| D-053 | Provisioning is a reconciliation loop: desired state in control-plane Postgres, idempotent `ensure` convergence; cadence per D-173 (5-min drift sweep; ≤60s applies only to enqueued changes — the original "≤60s drift pass" reading is superseded by D-173) | [control vs data plane](../01-architecture/02-control-vs-data-plane.md) |
| D-054 | Per-project unit = exactly three containers (Postgres 17 / PgBouncer / PostgREST) on one XFS-quota'd volume; pause stops all three | [multi-tenancy](../01-architecture/03-multi-tenancy-and-isolation.md) |
| D-055 | Day-one noisy-neighbor control set: cgroup mem/cpu/io, XFS project quota, PgBouncer caps, statement_timeout, gateway buckets | [multi-tenancy](../01-architecture/03-multi-tenancy-and-isolation.md) |
| D-056 | Project refs: immutable, never-reused 20-char lowercase base32 slugs (~100 bits, first char alphabetic) | [domain & region model](../01-architecture/04-domain-and-region-model.md) |
| D-057 | Wildcard `*.corebase.co` at Cloudflare + Origin CA at Caddy; no per-project certs in V1; custom domains later via Cloudflare for SaaS | [domain & region model](../01-architecture/04-domain-and-region-model.md) |
| D-058 | region→cluster→node schema is region-aware from the first migration (one eu-central row set in V1) | [domain & region model](../01-architecture/04-domain-and-region-model.md) |
| D-059 | Module boundaries CI-enforced (dependency-cruiser); services split only on codified triggers T1–T5 (gateway first, realtime born separate) | [repo layout](../01-architecture/05-repo-and-service-layout.md) |

## Control plane detail (from 02-control-plane)

| ID | Decision | Detail |
|---|---|---|
| D-060 | API keys stored hash-only with one-time display (refined by D-107 for the two derivable project keys) | [data model](../02-control-plane/01-data-model.md) |
| D-061 | Soft delete = status + deleted_at + purge_after; refs never reused | [data model](../02-control-plane/01-data-model.md) |
| D-062 | Platform-API auth is dual-mode: dashboard session cookie + scoped `cbp_` personal access tokens for CLI/automation | [platform API](../02-control-plane/02-platform-api.md) |
| D-063 | `Idempotency-Key` required on lifecycle mutations; 24h replay window; flows into provisioning_jobs | [platform API](../02-control-plane/02-platform-api.md) |
| D-064 | FAILED is re-enterable via saga checkpoint + same-key resume; compensation only on explicit abort/delete | [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) |
| D-065 | 5-minute per-node reconciliation with bounded auto-repair; data-destroying repairs are alert-only, never automatic | [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) |
| D-066 | Deletion is blocked on a restore-verified final backup, kept 30 days past purge | [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) |
| D-067 | Mandatory two-phase enqueue: job row written in the same DB transaction as intent, jobId = idempotency key, sweeper rebuilds queue from Postgres | [job queue](../02-control-plane/04-job-queue-and-workers.md) |
| D-068 | Delivery is explicitly at-least-once: exponential backoff, dead-letter state + operator alert | [job queue](../02-control-plane/04-job-queue-and-workers.md) |
| D-069 | Operator access is JIT-only: time-boxed ephemeral credentials, four-eyes, dual-unseal break-glass, grants visible in the customer's audit log | [audit & admin access](../02-control-plane/05-audit-and-admin-access.md) |

## Database platform detail (from 03-database-platform)

| ID | Decision | Detail |
|---|---|---|
| D-070 | Per-project stack = three containers (postgres:17, PgBouncer, PostgREST) on a dedicated per-project Docker bridge network; volumes on XFS with per-project quotas (`prjquota`), quota = plan cap × 1.2 | [provisioning](../03-database-platform/01-postgres-provisioning.md) |
| D-071 | Provisioning speed via pre-pulled images + a per-node warm pool (~3) of generic initialized stacks claimed at create time; template-database rejected — create→READY ~1–3s, cold fallback still <30s | [provisioning](../03-database-platform/01-postgres-provisioning.md) |
| D-072 | Pause/resume mechanics: idle = 7 consecutive days with zero data-plane requests AND zero client DB connections; pause = final incremental + checkpoint + clean stop, containers removed, volume kept, RAM released; resume triggered by first gateway request, handled per D-172 (immediate 503 + `Retry-After: 5`, `project_resuming` — the hold-≤20s mechanics are superseded by D-172); targets p50 <5s / p95 <15s | [provisioning](../03-database-platform/01-postgres-provisioning.md) |
| D-073 | Per-project disk ladder: 80% notify → 90% escalate → 95% soft read-only (`default_transaction_read_only=on`) → hard ENOSPC only at the 120% XFS quota; node volume auto-cordons at 85% | [provisioning](../03-database-platform/01-postgres-provisioning.md) |
| D-074 | Pooler auth via `auth_query` (dedicated `pgbouncer_auth` role + SECURITY DEFINER allowlist function); userlist.txt rejected; small-tenant sizing `max_client_conn=200`, pool 6+2 against `max_connections=20`; PostgREST connects direct to Postgres, never through PgBouncer | [pooling](../03-database-platform/02-connection-pooling.md) |
| D-075 | Bootstrap-stage KEK = libsodium-sealed root-only keyfile on control-plane nodes (XChaCha20-Poly1305 DEKs, AAD-bound, `kek_id` indirection for online re-wrap); KMS migration triggers: first compliance customer, SOC 2 start, or >2 root holders | [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md) |
| D-076 | Schema drift: all project DDL captured via event trigger into `ddl_log`; dashboard DDL offers save-as-migration; `db push` refuses on unreconciled drift (`--force` override); `db pull --changes` converts drift to a migration; `db reset` is structurally local-only, no remote flag | [migrations](../03-database-platform/04-migrations.md) |
| D-077 | Backup policy per plan *(numbers provisional with pricing)*: Free nightly full + continuous WAL, 7-day PITR; Pro weekly full + nightly incremental, 30-day PITR; Team +6-hourly incrementals >20GB, 90-day PITR; pause completes only after final backup lands in R2, paused chains never expire | [backups & PITR](../03-database-platform/05-backups-and-pitr.md) |
| D-078 | V1 extension allowlist: pg_stat_statements, pgcrypto, uuid-ossp, pg_trgm, btree_gin, btree_gist, citext, pgvector; postgis (variant image) and pg_cron in V1.1; everything else denied by absence from the image; customer roles never get server-program/file-read grants | [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) |
| D-079 | Major-version upgrades: dump/restore blue-green with endpoint-swap promote + 72h rollback for ≤10GB projects; in-place `pg_upgrade` (dual-binary container, backup-first) for >10GB; logical-replication blue-green deferred; paused projects upgrade lazily at resume | [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) |

## Security detail (from 06-security)

| ID | Decision | Detail |
|---|---|---|
| D-080 | Customer DB roles are never superuser and never members of pg_execute_server_program / pg_read_server_files / pg_write_server_files | [threat model](../06-security/01-threat-model.md) |
| D-081 | Container hardening baseline: non-root, no-new-privileges, seccomp, cap_drop ALL, read-only rootfs, PID limits, per-container network policy with egress default-deny | [threat model](../06-security/01-threat-model.md) |
| D-082 | service_role bypasses RLS via the BYPASSRLS role attribute, not permissive policies | [RLS design](../06-security/02-rls-design.md) |
| D-083 | Every API-reachable table gets ENABLE + FORCE ROW LEVEL SECURITY at creation; no policies ⇒ no access | [RLS design](../06-security/02-rls-design.md) |
| D-084 | Isolation suite runs against ephemeral per-run A/B fixtures (staging) + persistent prod canaries | [tenant isolation tests](../06-security/03-tenant-isolation-tests.md) |
| D-085 | Any isolation-test failure freezes all releases fleet-wide and pages at Sev-1 | [tenant isolation tests](../06-security/03-tenant-isolation-tests.md) |
| D-086 | V1 internal **service-to-service** traffic: private network + scoped service tokens, not mTLS (DB always TLS+SCRAM; worker→Docker Engine API stays mTLS per D-052); mTLS triggers: second region / third-party workloads / compliance | [platform security](../06-security/04-platform-security.md) |
| D-087 | Encryption at rest: LUKS on data volumes, pgBackRest per-project encryption, R2 SSE, envelope encryption for secrets | [platform security](../06-security/04-platform-security.md) |
| D-088 | zod at every TS boundary; all SQL parameterized, CI-enforced ban on string-built SQL | [platform security](../06-security/04-platform-security.md) |
| D-089 | No paid bug bounty before 1.0; security@ inbox with triage SLAs + security.txt from day one | [platform security](../06-security/04-platform-security.md) |

## Business detail (from 12-business)

| ID | Decision | Detail |
|---|---|---|
| D-090 | Binding cost guardrails: ≤€0.05/mo paused and ≤€0.50/mo active free project, free-fleet cost ≤25% of MRR, placement stop at 85% node RAM, 1,200-project node cap *(thresholds provisional until re-based on live prices — scenarios currently priced on AX-class assumptions vs D-140's CCX43 launch SKUs)* | [cost model](../12-business/01-cost-model.md) |
| D-091 | 64GB node is the standard unit of scale: 150 active is the per-node design max (at D-090's 85% stop; fleet average ~135–140 under D-148's 75% ceiling, per D-174) / 1,000 total projects planned, 350MB active RAM budget | [cost model](../12-business/01-cost-model.md) |
| D-092 | Plan ladder: Free / Pro ~$25 / Team ~$99+ / Enterprise-deferred; only Free pauses *(quotas and prices provisional until re-based on the final cost model)* | [pricing & plans](../12-business/02-pricing-and-plans.md) |
| D-093 | Exactly three metered dimensions (DB storage, file storage+bandwidth, MAU); everything else is plan-capped | [pricing & plans](../12-business/02-pricing-and-plans.md) |
| D-094 | Free tier can never bill: hard stops, no card required, data never deleted for cap breaches; Pro has a default-on spend cap | [pricing & plans](../12-business/02-pricing-and-plans.md) |
| D-095 | Metering pipeline: usage events → `usage_records` → billing engine → Stripe; usage_records is the quantity source of truth | [pricing & plans](../12-business/02-pricing-and-plans.md) |
| D-096 | Signal-scored signup friction ladder: email verify universal; phone/card/manual review only on risk signals | [abuse prevention](../12-business/03-abuse-prevention.md) |
| D-097 | Enforcement ladder warn → throttle → suspend-project → suspend-account, with appeals; export access preserved | [abuse prevention](../12-business/03-abuse-prevention.md) |
| D-098 | Server-opening triggers: platform API stable ≥6mo + third-party-proven self-host docs + triage capacity; open by default once all three hold | [open-source strategy](../12-business/04-open-source-strategy.md) |
| D-099 | "Self-host" = the hardened single-node Compose data plane (fleet machinery excluded); trademark registered before opening | [open-source strategy](../12-business/04-open-source-strategy.md) |

## Data API detail (from 04-data-api)

| ID | Decision | Detail |
|---|---|---|
| D-100 | PostgREST schema-cache reload via DDL event trigger → `NOTIFY pgrst` (SIGUSR1 fallback) | [rest-api-design](../04-data-api/01-rest-api-design.md) |
| D-101 | PostgREST connects direct to Postgres, not through PgBouncer (needs LISTEN; is itself a pool) | [rest-api-design](../04-data-api/01-rest-api-design.md) |
| D-102 | `/rest/v1` is a compatibility contract; one fleet-wide pinned PostgREST version, staged bumps | [rest-api-design](../04-data-api/01-rest-api-design.md) |
| D-103 | Paused project request ⇒ idempotent resume job + immediate 503, never held; response values per D-172 (`Retry-After: 5`, `project_resuming` — the original Retry-After 15 / `project_paused` are superseded); SDK auto-retries | [request pipeline](../04-data-api/02-request-pipeline.md) |
| D-104 | Redis pub/sub cache invalidation + 60s full-refresh backstop; ≤30s key-revocation SLO with a synthetic canary | [request pipeline](../04-data-api/02-request-pipeline.md) |
| D-105 | X-Request-ID reaches Postgres as `application_name` via PostgREST pre-request function | [request pipeline](../04-data-api/02-request-pipeline.md) |
| D-106 | PostgREST error bodies pass through verbatim; the D-032 envelope applies to gateway-minted errors | [request pipeline](../04-data-api/02-request-pipeline.md) |
| D-107 | anon/service_role keys are re-derived on demand (deterministic signing); anon always visible, service_role behind reveal-click + audit event (refines D-060) | [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md) |
| D-108 | No default table grants to `anon`; force-RLS on new tables — fail-closed | [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md) |
| D-109 | Gateway injects `Authorization` from `apikey` when absent | [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md) |

## Auth detail (from 05-auth)

| ID | Decision | Detail |
|---|---|---|
| D-110 | Auth is one multi-tenant module of the monolith serving all projects at `<ref>.corebase.co/auth/v1/*`; per-project auth containers rejected (would re-create the idle-RAM problem D-008 kills); project context resolved per request via the gateway routing table | [auth architecture](../05-auth/01-auth-architecture.md) |
| D-111 | Password hashing: argon2id (OWASP baseline profile, PHC-encoded) with transparent parameter upgrades on next verify; bcrypt accepted verify-only for imported users, rehashed to argon2id on first login | [auth architecture](../05-auth/01-auth-architecture.md) |
| D-112 | Refresh tokens: opaque 256-bit CSPRNG, SHA-256 hash stored only, strict rotation; replay within a 10s grace idempotently returns the child, beyond it revokes the whole session family + `token_reuse_detected` audit; 30-day idle expiry | [sessions & tokens](../05-auth/02-sessions-and-tokens.md) |
| D-113 | Revocation stance: access JWTs are stateless on the data-plane hot path; revocation kills refresh immediately and access within `exp` (default 3600s, per-project 300–86400s); per-request session validation deferred to V1.x behind a benchmark | [sessions & tokens](../05-auth/02-sessions-and-tokens.md) |
| D-114 | Account deletion in V1 is developer-initiated only (soft delete, tombstoned email, session revocation, no cascade into app schemas); end-user self-serve deletion deferred to V1.x | [flows](../05-auth/03-flows.md) |
| D-115 | Transactional email: Postmark in V1 behind an `EmailProvider` interface (SES = at-scale migration target); sending identity `mail.corebase.co` with SPF `-all`, DKIM, DMARC quarantine→reject | [email infrastructure](../05-auth/04-email-infrastructure.md) |
| D-116 | Shared-domain email is per-project capped (Free 30/h, 200/d, 100 distinct recipients/d, ≤4/h per address) and fixed-template only (escaped variables, no arbitrary HTML/links); bounce/complaint suppression lists; >10% bounce or >0.1% complaint auto-pauses a project's email | [email infrastructure](../05-auth/04-email-infrastructure.md) |
| D-117 | Custom per-project SMTP is V1.1: own credentials (envelope-encrypted), own domain — at which point shared caps and template restrictions no longer apply | [email infrastructure](../05-auth/04-email-infrastructure.md) |
| D-118 | OAuth ships V1.1, Google + GitHub only: code flow with server-side exchange, PKCE (S256), per-project provider credentials, allowlist-validated redirects; auto-link only on provider-verified email matching a *confirmed* user | [oauth & future](../05-auth/05-oauth-and-future.md) |
| D-119 | Auth scope freeze: post-V1 order fixed as OAuth → magic links → anonymous → MFA/TOTP → passkeys → SAML/SSO; phone/SMS deferred with no target; exceptions require a superseding decision-log entry | [oauth & future](../05-auth/05-oauth-and-future.md) |

## Storage detail (from 07-storage)

| ID | Decision | Detail |
|---|---|---|
| D-120 | One R2 bucket per region with `projects/<ref>/<bucket>/<path>` prefixes; per-project object encryption deferred | [storage architecture](../07-storage/01-storage-architecture.md) |
| D-121 | Storage is a monolith module and the sole holder of R2 credentials; customers never receive raw object-store creds | [storage architecture](../07-storage/01-storage-architecture.md) |
| D-122 | Uploads: proxied ≤50MB; presigned + intent row + callback above | [storage architecture](../07-storage/01-storage-architecture.md) |
| D-123 | MIME/size enforced at the service; magic-byte sniffing for a dangerous set; nosniff/attachment serving | [storage API & policies](../07-storage/02-storage-api-and-policies.md) |
| D-124 | Consistency model = object-first writes, row-first deletes, intent rows, daily sweep with 24h grace | [storage API & policies](../07-storage/02-storage-api-and-policies.md) |

## Realtime detail (from 08-realtime, post-V1)

| ID | Decision | Detail |
|---|---|---|
| D-125 | wal_level=logical from day one + pgoutput decoder + colocated per-node realtime agent; realtime is the first monolith split | [realtime architecture](../08-realtime/01-realtime-architecture.md) |
| D-126 | Slot-safety envelope: max_slot_wal_keep_size hard cap, lag alerts at 25/50/75%, kill-switch at 90%, auto-recreate + client resync, at-most-once delivery, bounded buffers | [realtime architecture](../08-realtime/01-realtime-architecture.md) |
| D-127 | CDC authorization via opt-in publications; filters are explicitly not a security boundary; walrus-style policy evaluation is the successor path | [realtime architecture](../08-realtime/01-realtime-architecture.md) |
| D-128 | Wire protocol v1 (join/broadcast/presence/heartbeat frames), connection contract with mid-session re-auth, per-connection rate limits, Redis pub/sub fan-out | [channels, broadcast, presence](../08-realtime/02-channels-broadcast-presence.md) |
| D-129 | Channels private by default with JWT-claim prefix rules; SQL `realtime.can_join` callback deferred | [channels, broadcast, presence](../08-realtime/02-channels-broadcast-presence.md) |

## Dashboard detail (from 09-dashboard)

| ID | Decision | Detail |
|---|---|---|
| D-130 | Dashboard is a pure frontend: Next.js + TanStack Query against the platform API only, no BFF | [dashboard IA](../09-dashboard/01-dashboard-ia.md) |
| D-131 | Paused projects auto-resume on dashboard open, with progress banner and skeleton UI | [dashboard IA](../09-dashboard/01-dashboard-ia.md) |
| D-132 | All dashboard DB operations run via the platform API as an audited per-project `corebase_admin` role — never browser-held service_role keys | [table editor](../09-dashboard/02-table-editor.md) |
| D-133 | Every table-editor operation compiles to visible SQL offered as a migration; policy templates expand to editable SQL (no black-box wizard); PK-guarded inline edits | [table editor](../09-dashboard/02-table-editor.md) |
| D-134 | SQL editor is CodeMirror 6 with binding safety rails: role switcher, server-enforced destructive guard, 60s timeout, LIMIT auto-append, one-transaction-per-run, read-only toggle | [sql editor](../09-dashboard/03-sql-editor.md) |

## CLI & SDK detail (from 10-cli-and-sdk)

| ID | Decision | Detail |
|---|---|---|
| D-135 | CLI on commander with keychain-first PAT storage, 0600-checked fallback file | [cli spec](../10-cli-and-sdk/01-cli-spec.md) |
| D-136 | Telemetry opt-in only; 24h-cached npm update check | [cli spec](../10-cli-and-sdk/01-cli-spec.md) |
| D-137 | Versioned export tarball format v1: manifest + checksums, schema.sql + data.dump, users.jsonl incl. password hashes + REIMPORT.md, storage manifest, secret names only | [cli spec](../10-cli-and-sdk/01-cli-spec.md) |
| D-138 | Deterministic local-dev keypair with `iss: corebase-local`, never valid in prod; path parity local↔prod is a binding invariant | [local development](../10-cli-and-sdk/02-local-development.md) |
| D-139 | SDK ships realtime as a loudly-throwing reserved stub; `{data, error}` contract never throws for API errors | [sdk spec](../10-cli-and-sdk/03-sdk-spec.md) |

## Infrastructure detail (from 11-infrastructure)

| ID | Decision | Detail |
|---|---|---|
| D-140 | Phase A topology is exactly four prod nodes in FSN1 — `cp-1` (control plane + gateway, ~CCX23), `data-1`/`data-2` (~CCX43/64GB + 1TB XFS each), `mon-1` (~CPX41) — plus one combined staging node; platform services as release-manifest Compose under systemd; per-project triplets are reconciler-owned, outside Compose; two data nodes from day one | [infra phases](../11-infrastructure/01-infra-phases.md) |
| D-141 | The four provider interfaces (ComputeProvider, DatabaseNodeProvider, StorageProvider, DnsProvider) exist from the first commit and are the only path to provider APIs; exactly one implementation each until a priced exit decision demands a second | [infra phases](../11-infrastructure/01-infra-phases.md) |
| D-142 | Terraform state in a dedicated versioned R2 bucket per environment (S3 backend, native locking), bootstrap-created outside TF, `prevent_destroy`; nightly state copies to the off-Cloudflare backup location | [iac & cicd](../11-infrastructure/02-iac-and-cicd.md) |
| D-143 | IaC secrets are SOPS+age files in the repo (operator keys + one CI key + one offline recovery key); runtime application secrets stay under D-035 and never enter Terraform | [iac & cicd](../11-infrastructure/02-iac-and-cicd.md) |
| D-144 | Unit of deploy/rollback is an immutable versioned release manifest (image digests, project-stack digests, migration watermark); node-by-node rollout behind health + error-rate gates; rollback = previous manifest; control-plane migrations follow expand-migrate-contract | [iac & cicd](../11-infrastructure/02-iac-and-cicd.md) |
| D-145 | Prod deploys are solo-with-audit: single-engineer approval gated by the full staging suite (isolation red = frozen per D-085), audit-logged and auto-announced; 2-person rule at ≥4 engineers or first compliance demand | [iac & cicd](../11-infrastructure/02-iac-and-cicd.md) |
| D-146 | Metrics topology: node_exporter + cAdvisor + one multi-target postgres_exporter per node (per-project sidecars rejected); per-project cardinality budget ≤~25 series, `project_ref` never combined with route/status labels; fleet rollups via recording rules | [observability](../11-infrastructure/03-observability.md) |
| D-147 | Logs: Alloy per node → Loki on mon-1 (R2 chunks); retention 30d platform, 1d Free / 7d Pro / 30d Team customer-visible; OTel instrumented day one but no trace backend in V1 (Tempo V1.1); customers reach logs/metrics only via the scoped `/v1/projects/:ref/logs\|metrics` API, never Loki/PromQL | [observability](../11-infrastructure/03-observability.md) |
| D-148 | Node-loss recovery objective + DR headroom rule: RPO ≤5min (WAL-archive lag), RTO <60min for a lost node's active projects; fleet-wide reserved-RAM ceiling 75% (warm pool counts) + pre-approved emergency node provisioning; evacuation respects D-090's 85% per-node stop *(targets provisional until quarterly drills produce measured restore throughput)* | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) |
| D-149 | Cross-repo backup copies: pgBackRest repos + TF state + DNS zone export + release manifests replicate daily (control-plane repo 6-hourly) from R2 to Backblaze B2 EU — off-Cloudflare, off-Hetzner — via StorageProvider `copyBetween`, with 36h/72h sync-age alerts; V1 region-loss posture = rebuild-from-backups, RTO days, region RPO ≤24h | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) |
| D-155 | Incident frame: Sev-1..Sev-4 ladder with availability definitions; hosted third-party status page off Corebase/Cloudflare infra; pre-approved comms templates implementing the 72h customer-notification rule | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) |
| D-156 | Binding drill cadence: quarterly node-loss drill on ephemeral drill nodes per D-175 (one restore sourced from the B2 copy) + quarterly Cloudflare-bypass drill + semiannual control-plane restore drill + annual region-loss tabletop; a missed RTO in a drill files an incident-grade retro | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) |
| D-157 | Node evacuation is operator-initiated via a single `declare-lost` command (cordon + evacuate + replacement provisioning) executed by the reconciler at bounded concurrency; automatic failover rejected in V1 (consistent with D-065) | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) |

## Quality detail (from 13-quality)

| ID | Decision | Detail |
|---|---|---|
| D-150 | The provisioning state machine is a pure `(state, event) → (state', effects[])` transition function, exhaustively unit-tested | [testing strategy](../13-quality/01-testing-strategy.md) |
| D-151 | The golden-path script is the MVP acceptance test; runs on every deploy and blocks promotion | [testing strategy](../13-quality/01-testing-strategy.md) |
| D-152 | No coverage-% mandate; the enumerated critical paths are 100%-covered or the release doesn't ship | [testing strategy](../13-quality/01-testing-strategy.md) |
| D-153 | Deprecation protocol: Deprecation+Sunset headers, changelog entry, ≥6-month window, usage floor before removal | [release & versioning](../13-quality/02-release-and-versioning.md) |
| D-154 | PostgREST major upgrades are fleet-staged via a per-project image-tag pin within a bounded ≤6-month window | [release & versioning](../13-quality/02-release-and-versioning.md) |

## Roadmap & risk decisions (from 14-roadmap, 15-risks)

| ID | Decision | Detail |
|---|---|---|
| D-160 | Phase order P0–P9; backups are Phase 3; realtime out of V1; RLS ships inside Phase 5 with the data API | [phase plan](../14-roadmap/01-phase-plan.md) |
| D-161 | A phase is done only on exit-criteria pass, never on code-complete | [phase plan](../14-roadmap/01-phase-plan.md) |
| D-162 | The isolation suite becomes release-blocking the week Phase 5 starts | [phase plan](../14-roadmap/01-phase-plan.md) |
| D-163 | The V1 IN/OUT tables are binding scope; changes go through the scope-change protocol | [v1 scope & cutlist](../14-roadmap/02-v1-scope-and-cutlist.md) |
| D-164 | Launch checklist = proposal §119's 15 criteria + export + pause/resume + isolation-suite (18 total), all automated | [v1 scope & cutlist](../14-roadmap/02-v1-scope-and-cutlist.md) |
| D-165 | Post-V1 releases are trigger-gated, not date-gated; scope re-cut against user feedback per release | [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md) |
| D-166 | Realtime ships in two steps (broadcast/presence → CDC) and is the first service split from the monolith | [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md) |
| D-167 | Functions runtime decision explicitly deferred to V1.3 planning | [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md) |
| D-168 | Milestone 0 builds the provisioning spine with production-grade patterns — never throwaway versions of load-bearing mechanisms | [milestone 0](../14-roadmap/04-milestone-0.md) |
| D-169 | Milestone 0 ends with a measurement retro correcting the cost model and density/latency assumptions | [milestone 0](../14-roadmap/04-milestone-0.md) |
| D-170 | Risk register reviewed at every phase boundary and after every Sev-1/2; R-1/R-3 mitigations never traded away | [risk register](../15-risks/01-risk-register.md) |
| D-171 | External security review of auth + isolation boundary is a Phase-9 launch-gate item | [risk register](../15-risks/01-risk-register.md) |

## Consistency resolutions (from the 2026-08 contradiction sweep)

| ID | Decision | Detail |
|---|---|---|
| D-172 | Paused-project requests: the gateway never holds; the first request idempotently enqueues resume and immediately returns 503 + `Retry-After: 5`, error `project_resuming`; SDKs auto-retry ≤3 times (~5/10/15s, riding the p50<5s / p95<15s resume targets). Supersedes D-072's hold-≤20s mechanics and D-103's Retry-After-15 / `project_paused`; OQ-102 (optional long-poll) stays open | [request pipeline](../04-data-api/02-request-pipeline.md) |
| D-173 | Reconciliation is two-tier: the binding drift-discovery sweep is the 5-minute jittered per-node reconciliation (D-065); ≤60s is the convergence budget for explicitly enqueued desired-state changes only; container crashes are caught by Docker restart policy, not either loop. Supersedes D-053's "≤60s drift pass" reading | [control vs data plane](../01-architecture/02-control-vs-data-plane.md) |
| D-174 | Placement books plan RAM budgets, not container limits: `ram_reserved` = 350MB per active Free project (paused = 0); container limits (~768 MiB/triplet) are overcommitted burst ceilings backed by usage metering. Ceilings compose: 85% per-node stop (D-090) makes 150 active the per-node design max (D-091); the fleet average stays ≤75% (D-148), ~135–140 active/node planning figure | [provisioning](../03-database-platform/01-postgres-provisioning.md) |
| D-175 | Quarterly node-loss drills run on ephemeral drill infrastructure: Terraform creates two temporary staging data nodes per drill (standing staging remains one combined node, D-140 unchanged), declare-lost → evacuate → restore runs between them, nodes destroyed after. Resolves the D-140/D-156 substrate conflict; confirms OQ-145's ephemeral lean for drills | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) |
| D-176 | Restore verification is continuous sampling with binding per-plan floors: weekly batches prioritizing never-verified and longest-unverified chains; every project verified ≤90 days (Free) / ≤30 days (Pro/Team); a failure treats that project's backups as nonexistent — immediate fresh full + re-verify + page. Supersedes D-019's monthly clause | [backups & PITR](../03-database-platform/05-backups-and-pitr.md) |

## Design system (from 09-dashboard/04)

| ID | Decision | Detail |
|---|---|---|
| D-177 | Brand accent is **Electric Violet** (`#7C3AED` light / `#8B5CF6` dark) with cool violet-tinted neutrals; the token set + component inventory are binding for every Corebase surface | [design system](../09-dashboard/04-design-system.md) |
| D-178 | Light and dark both ship; components reference semantic role tokens only, never ramp steps — dark is a second set of role values, not an inversion | [design system](../09-dashboard/04-design-system.md) |
| D-179 | No drop shadows (elevation = surface tint + border weight); type families frozen at two — Inter for interface, JetBrains Mono for anything copyable | [design system](../09-dashboard/04-design-system.md) |
| D-180 | State is never colour alone: every project state carries a text label, selection uses a left accent bar | [design system](../09-dashboard/04-design-system.md) |

## Self-hosting (from 10-cli-and-sdk/04)

| ID | Decision | Detail |
|---|---|---|
| D-181 | The dashboard ships in self-host in **single-project mode** (`CB_SELFHOST=true`) behind a `meta` introspection service and a control-plane shim serving a documented endpoint subset; org/billing/usage/team routes compiled out, unimplemented routes return `501 not_available_in_selfhost` | [self-hosting](../10-cli-and-sdk/04-self-hosting.md) |
| D-182 | Postgres is not published to the host by default (pooler on 6543 is the only DB entry point); dashboard protected by basic auth with docs mandating a reverse proxy | [self-hosting](../10-cli-and-sdk/04-self-hosting.md) |
| D-183 | Every self-host secret is a required variable with no default — the stack refuses to boot rather than run on a known-weak credential | [self-hosting](../10-cli-and-sdk/04-self-hosting.md) |

## Provisioning hardening (from M0/T5d, found by running it)

| ID | Decision | Detail |
|---|---|---|
| D-184 | Project containers are **created with no restart policy**; `wait_healthy` promotes them to `unless-stopped` only after the database answers `pg_isready` | A container that cannot initialise (bad config, corrupt volume, exhausted disk) flaps forever under `unless-stopped`, burning node CPU and hiding the failure behind a permanent `restarting` state — the health gate never sees a dead container to report. Attaching the policy after the first successful probe keeps node-reboot recovery while making first-boot failures fail once, loudly, in seconds. [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) |
| D-185 | No `trust` authentication anywhere in a project database: the image builds with `--auth-local=peer --auth-host=scram-sha-256`, and an init script fails the boot if any `trust` rule or non-scram host rule survives | `initdb` defaults leave `trust` on the local socket and on loopback, so any code execution inside the container is an unauthenticated superuser login — a privilege escalation that needs no container escape, which is exactly the class D-078 exists to close. `peer` keeps in-container maintenance (OS `postgres` → db `postgres`) working without granting it to any other process. Verified by [tenant isolation tests](../06-security/03-tenant-isolation-tests.md). [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) |
| D-186 | The shared `postgresql.base.conf` pins **no** `data_directory`; the data directory comes from `PGDATA` in the container spec | The volume is mounted at `/var/lib/postgresql/data` and `PGDATA` is a subdirectory of it (the mount root can hold `lost+found`, which `initdb` refuses). A path pinned in a fleet-wide config file therefore contradicts the spec on every first boot — the server initialises the subdirectory and then refuses to start on the parent's permissions. One source of truth, and it is the spec. [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) |

## How to add a decision

1. Propose it in the owning doc's **Decisions** section with rationale.
2. Add the row here with the next free `D-xxx`.
3. If it overturns an existing decision, mark the old row **Superseded by D-yyy** — never delete rows.

## Dependencies

- Feeds: everything. Every doc's Decisions section must be mirrored here.
