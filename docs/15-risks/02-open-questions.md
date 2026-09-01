# Open Questions Register

## Purpose

Everything the corpus deliberately leaves unresolved, in one place. Each OQ lives in exactly one owning doc, whose Open Questions section carries the full context, options, and current lean — this register is the index, not the argument. An OQ is closed one of two ways: it converts into a numbered decision in the [decision log](../00-foundation/05-decision-log.md) (D-xxx), or the owning doc records why the question dissolved (superseded, trigger never fired, made moot by another decision). An OQ that stays open past its decide-by point is a schedule signal, not a formality.

## How to read and maintain

- OQ numbers are allocated in blocks per corpus section (050s architecture, 070s database platform, 110s auth, …), so the ID roughly tells you where a question lives. IDs are unique corpus-wide; a one-time renumbering fixed early block collisions, so a few sections own a second, non-adjacent block (listed in their headers).
- Cite an OQ together with a link to its owning doc — the link is what keeps citations robust.
- To close an OQ: record the D-xxx (or the dissolution note) in the owning doc, then mark the row here. Never delete rows — the register is also the record of what was once open.
- "Decide by" is a phase, release, or trigger inferred from the owning doc; "—" means no forcing function has been identified yet.

## Hot list — blocking the earliest work (Milestone 0 / Phases 0–3)

| ID | Question | Why it blocks |
|---|---|---|
| OQ-165 | Milestone-0 staging on cloud VMs vs a prod-representative dedicated box | **Answered by doing, not deciding:** M0 ran entirely on local Docker, so every number is ARM and no number is prod-representative. The question is now "when do we buy the box", and [D-209](../14-roadmap/06-milestone-0-retro.md) makes that purchase a precondition for re-basing the density model |
| OQ-056 / OQ-090 | Measured idle RSS of the Postgres+PgBouncer+PostgREST triplet (the 300–350 MB planning figure is unmeasured) | **Still blocking, now with first data.** Postgres alone measures 102.2 MiB cgroup peak idle ([M-001](../14-roadmap/05-measurements.md)); the other two processes are unbuilt. D-209 gates what partial data may change |
| OQ-176 | Does the ~14:1 booked-to-used RAM ratio survive real client load, and at what load does the 350 MB booking begin to bind? | Decides whether D-174's overcommit is comfortable or merely untested — the difference between a free tier that works and one that OOM-kills under its first real traffic |
| OQ-087 | Cloud KMS vs self-hosted sealed store on Hetzner | Risk register says resolve before Phase 1 ends; gates D-035 envelope encryption and LUKS boot keys |
| OQ-051 | WireGuard over the Hetzner private LAN, or trust vSwitch for V1 | Network foundation laid in Phases 0–1; retrofitting encryption later touches every service |
| OQ-080 | Egress allowlist mechanics for tenant Postgres containers (WAL push vs NAT vs per-project rules) | Must be decided during Phase 2 provisioning implementation |
| OQ-063 | How already-provisioned projects receive base-schema upgrades | Shapes the Phase 2 provisioner and reconciler before the first real project exists |
| OQ-067 | ~~What the gateway returns while a paused project resumes~~ **Resolved by D-172**: immediate 503 + `Retry-After: 5`, `project_resuming`, never held | — |
| OQ-045 | Worker drain budget (90 s) vs pgBackRest final-backup duration | Measure with real backups in Phase 3, before the deploy cadence calcifies |

## The register

### OQ-001–002 — Foundation

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-001 | Name/domain availability check for `corebase.com` / `corebase.co` — commercial task outside the corpus | [vision & principles](../00-foundation/01-vision-and-principles.md) | before public launch (with OQ-099) |
| OQ-002 | Publicly benchmark provisioning time vs incumbents at launch? (measurable claim must stay true forever) | [competitive analysis](../00-foundation/02-competitive-analysis.md) | launch marketing planning |

### OQ-050–064 — Architecture

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-050 | Gateway on a PAUSED project: hold vs 503 — **Closed by D-172** (never-hold; 503 + `Retry-After: 5`, `project_resuming`; OQ-102 keeps the long-poll option open) | [multi-tenancy & isolation](../01-architecture/03-multi-tenancy-and-isolation.md) | closed |
| OQ-051 | Hetzner private network alone for V1, or WireGuard on top for node-to-node encryption in transit? | [system architecture](../01-architecture/01-system-architecture.md) | Phases 0–1 |
| OQ-052 | Redis Sentinel / second instance before GA, and which of its three roles (queue, rate limits, pub/sub) separates first? | [control vs data plane](../01-architecture/02-control-vs-data-plane.md) | before GA (Phase 9) |
| OQ-053 | Bandwidth / file-size threshold where storage uploads switch from the storage-api module to presigned direct-to-R2 | [system architecture](../01-architecture/01-system-architecture.md) | when cost-model egress numbers exist |
| OQ-054 | How long may a decrypted project signing key live in auth-module memory, and are keys pre-warmed against KMS outages? | [control vs data plane](../01-architecture/02-control-vs-data-plane.md) | Phase 4 auth build |
| OQ-055 | Region steering for region #2: edge Worker ref→region lookup vs Cloudflare LB pools vs home-region forwarding | [domain & region model](../01-architecture/04-domain-and-region-model.md) | when expansion is scheduled (V2) |
| OQ-056 | Benchmark real idle RSS of the triplet under PG 17 — **partial data in [M-001](../14-roadmap/05-measurements.md)**; triplet + target hardware outstanding | [multi-tenancy & isolation](../01-architecture/03-multi-tenancy-and-isolation.md) | Milestone 0 |
| OQ-057 | Custom-domain slot (V1.1 or V1.2) and mechanism (Cloudflare for SaaS vs origin ACME) | [domain & region model](../01-architecture/04-domain-and-region-model.md) | post-V1 roadmap planning |
| OQ-058 | Turborepo remote cache: self-hosted vs Vercel-hosted vs none until CI times hurt | [repo & service layout](../01-architecture/05-repo-and-service-layout.md) | when CI times hurt |
| OQ-059 | Dashboard deploys to Cloudflare Pages or rides the app node behind Caddy? | [system architecture](../01-architecture/01-system-architecture.md) | Phase 7 kickoff (dashboard IA) |
| OQ-060 | Reconciler concurrency limit per node, so a repair storm can't saturate a node and harm healthy tenants | [control vs data plane](../01-architecture/02-control-vs-data-plane.md) | Phase 2 (reconciler build) |
| OQ-061 | Free-plan CPU: weight-only (bursty, fair-ish) vs hard `cpu.max` quota (predictable, feels slow)? | [multi-tenancy & isolation](../01-architecture/03-multi-tenancy-and-isolation.md) | Phase 2 provisioning |
| OQ-062 | Submit `corebase.co` to the Public Suffix List once tenant-served HTML exists, to hard-isolate cookies? | [domain & region model](../01-architecture/04-domain-and-region-model.md) | when storage-served HTML ships |
| OQ-063 | Base-schema upgrades for already-provisioned projects: reconciler-applied versioned migrations vs explicit fleet jobs | [repo & service layout](../01-architecture/05-repo-and-service-layout.md) | Phase 2 |
| OQ-064 | Does `apps/docs` ship at V1 as a real app or stub content on `corebase.com`? | [repo & service layout](../01-architecture/05-repo-and-service-layout.md) | V1 cut-list review |

### OQ-040–048, 065–069 — Control plane

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-040 | `usage_records` granularity: hourly (enables intra-day abuse cutoffs, ~24× rows) vs daily | [data model](../02-control-plane/01-data-model.md) | Phase 1, with abuse prevention |
| OQ-041 | Does `project_members` ship in V1, or is org-level RBAC enough until agencies arrive (D-003)? | [data model](../02-control-plane/01-data-model.md) | V1.x |
| OQ-042 | Final `ref` length/alphabet (16–20 lowercase alnum, letter-first) validated against wildcard-TLS/subdomain scheme | [data model](../02-control-plane/01-data-model.md) | Phase 1 DDL freeze |
| OQ-043 | ~~Ready-notification transport for the dashboard~~ **Partly resolved by D-221**: polling for create and resume, which are seconds long. Still open for operations measured in minutes — restore-from-backup is the case that may need SSE | [platform API](../02-control-plane/02-platform-api.md) | before the Phase 3 restore UX |
| OQ-044 | Exact per-plan platform-API rate-limit numbers (current table is placeholder) | [platform API](../02-control-plane/02-platform-api.md) | with pricing + load tests (Phase 9) |
| OQ-045 | Drain budget (90 s) vs pgBackRest final backup: longer budget for `backup` workers, or checkpointable sub-steps? | [job queue & workers](../02-control-plane/04-job-queue-and-workers.md) | Phase 3, measured with real backups |
| OQ-046 | Customer audit export: dashboard NDJSON enough, or SIEM streaming (webhook/S3 push)? | [audit & admin access](../02-control-plane/05-audit-and-admin-access.md) | deferred until asked twice |
| OQ-047 | JIT support access to a *paused* project: force a resume, or operate on the volume offline? | [audit & admin access](../02-control-plane/05-audit-and-admin-access.md) | before private beta, with pause internals |
| OQ-048 | JIT approval surface: admin area of the main dashboard vs a separate operator tool | [audit & admin access](../02-control-plane/05-audit-and-admin-access.md) | Phase 1, with repo layout |
| OQ-065 | PAT lifetime: indefinite with revocation vs forced 90-day expiry with refresh via `corebase login` | [platform API](../02-control-plane/02-platform-api.md) | before CLI ships (Phase 8) |
| OQ-066 | Paused-project RAM reservation — **Closed by D-072/D-174**: released; paused projects book 0 RAM (the pause economics depend on it) | [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) | closed |
| OQ-067 | Resume-on-first-request UX — **Closed by D-172**: immediate 503 + `Retry-After: 5`, `project_resuming`; no hold, no interstitial page in V1 | [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) | closed |
| OQ-068 | Auto-retry out of FAILED: 3 re-enqueues then dashboard `failed` + retry button — confirm with UX | [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) | Phase 7 |
| OQ-069 | Does resume-on-request make Redis availability customer-visible enough to justify Sentinel/replica earlier? | [job queue & workers](../02-control-plane/04-job-queue-and-workers.md) | with infra phase B review |

### OQ-030–032, 070–079 — Database platform

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-070 | Warm-pool sizing under signup bursts: 3/node + cold fallback vs region-level shared pool with predictive refill | [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) | with real signup-burst data |
| OQ-071 | Opt-in pause (with billing pause?) for Pro; tighten the Free 7-day idle window under cost pressure? | [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) | V1.x, with pricing |
| OQ-072 | Multi-tenant pooler bake-off (pgcat vs Supavisor-class vs sharded PgBouncers) — measured, not paper | [connection pooling](../03-database-platform/02-connection-pooling.md) | parked until a §7 trigger fires |
| OQ-073 | Cap Free-tier direct connections with a per-role `CONNECTION LIMIT 5` on `developer`? (leaning yes) | [connection pooling](../03-database-platform/02-connection-pooling.md) | Phase 2, after GUI-tool check |
| OQ-074 | Store customer DB passwords after first render, or show-once with only the SCRAM verifier server-side? | [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md) | Phase 2, with dashboard UX input |
| OQ-075 | Formal key-holder policy (who/where/check cadence) for the offline KEK copies — a one-page runbook | [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md) | before first paying customer |
| OQ-076 | `db diff` engine: port migra's logic to TypeScript vs shelling out to migra/atlas in a container | [migrations](../03-database-platform/04-migrations.md) | V1.1 kickoff |
| OQ-077 | Does `db push` need read-only mode / maintenance banner for table-rewrite migrations, or is the advisory lock enough? | [migrations](../03-database-platform/04-migrations.md) | before V1 launch |
| OQ-078 | Replicate backup repos to a second location (R2 → S3 deep archive?) before or after multi-region compute? | [backups & PITR](../03-database-platform/05-backups-and-pitr.md) | with DR planning, before V2 multi-region |
| OQ-079 | Per-plan concurrent-restore caps and Free-tier restore frequency (restores are compute-costly) | [backups & PITR](../03-database-platform/05-backups-and-pitr.md) | with pricing, before launch |
| OQ-030 | pgvector on small tenants: per-plan caps on dimensions/index type given 64 MB `maintenance_work_mem` / 512 MiB cgroup? | [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) | before extension round 2 (V1.1); needs Free-spec benchmark |
| OQ-031 | First upgrade season: adopt PG18 within 12 months of launch, or hold for 19 and exercise the skip-version path? | [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) | when PG18 extension ecosystem is observable |
| OQ-032 | Extension updates: force `ALTER EXTENSION UPDATE` fleet-wide on minor bumps, or customer-triggered with deprecation window? | [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) | before first fleet extension bump |

### OQ-080–087 — Security

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-080 | Tenant-container egress mechanics: strict deny + proxied WAL push vs NAT-to-named-endpoints vs per-project rules | [threat model](../06-security/01-threat-model.md) | Phase 2 provisioning implementation |
| OQ-081 | gVisor / Kata / Firecracker evaluation: measure the Postgres I/O penalty before the enterprise tier (AR-1 triggers) | [threat model](../06-security/01-threat-model.md) | before enterprise tier (AR-1) |
| OQ-082 | D-083 enforcement: DDL event trigger inside each project DB vs tooling-layer lint + `relrowsecurity` drift alarm | [RLS design](../06-security/02-rls-design.md) | by Phase 5, with migrations |
| OQ-083 | Custom-claims surface for V1: supported token-issue hook vs documented service-role pattern only | [RLS design](../06-security/02-rls-design.md) | Phase 4 |
| OQ-084 | Is a quarantined *destructive* canary pool in prod worth the operational risk, vs staging-only destructive tests? | [tenant isolation tests](../06-security/03-tenant-isolation-tests.md) | when fleet has spare-node headroom |
| OQ-085 | How many node topologies (same-node, cross-node, cross-AZ) per isolation run before run time hurts deploys? | [tenant isolation tests](../06-security/03-tenant-isolation-tests.md) | when multi-node staging exists |
| OQ-086 | Rate-limit defaults need real-traffic calibration — especially auth limits vs mobile offline→online retry bursts | [platform security](../06-security/04-platform-security.md) | first month of private beta |
| OQ-087 | KMS for V1: cloud KMS vs self-hosted sealed store (age/SOPS, Vault) on Hetzner — affects D-035, D-087, LUKS boot keys | [platform security](../06-security/04-platform-security.md) | before Phase 1 ends (per R-15) |

### OQ-090–099, 106–107 — Business

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-090 | Measured RSS of the tuned per-project stack under idle and light load — the 350 MB planning number needs a benchmark | [cost model](../12-business/01-cost-model.md) | **first data in M-001/M-002; still open** — the triplet needs Phases 1–2, and D-209 gates re-basing |
| OQ-176 | Does the ~14:1 booked-to-used RAM ratio ([M-002](../14-roadmap/05-measurements.md)) survive real client load, and where does the 350 MB booking begin to bind? | [cost model](../12-business/01-cost-model.md) | with the first x86 node, gated by D-209 |
| OQ-177 | Per-project disk floor once WAL archiving writes to the volume rather than the container filesystem | [cost model](../12-business/01-cost-model.md) | when backups land (Phase 3) |
| OQ-091 | Does sub-5-second resume require warm page-cache snapshots or pre-started shells, and at what density cost? | [cost model](../12-business/01-cost-model.md) | Milestone 0 / Phase 2 measurements |
| OQ-092 | Hetzner fair-use reality: at what sustained per-node egress do we get throttled, forcing CDN-in-front earlier? | [cost model](../12-business/01-cost-model.md) | — (observe once beta traffic exists) |
| OQ-093 | Annual pricing (2 months free?) and regional pricing | [pricing & plans](../12-business/02-pricing-and-plans.md) | before public launch, not before |
| OQ-094 | Indefinite retention of paused Free projects vs 12-month archive-to-R2-then-delete | [pricing & plans](../12-business/02-pricing-and-plans.md) | before 10k projects |
| OQ-095 | Is 500 MB the right Free DB cap, or does 1 GB convert better at cents of marginal COGS? | [pricing & plans](../12-business/02-pricing-and-plans.md) | A/B post-launch |
| OQ-096 | Phishing scan of subdomains/storage: build the daily crawl in-house vs vendor (Safe Browsing + URL-scan API) | [abuse prevention](../12-business/03-abuse-prevention.md) | spike before public launch |
| OQ-097 | Which jurisdictions' LE-request, DMCA, CSAM obligations bind an eu-central platform with global users; minimum ToS/AUP | [abuse prevention](../12-business/03-abuse-prevention.md) | counsel before launch |
| OQ-098 | Device fingerprinting for the friction ladder: build vs buy (GDPR review) vs skip until farming is observed | [abuse prevention](../12-business/03-abuse-prevention.md) | when farming is observed |
| OQ-099 | Is "Corebase" registrable in EU/US software classes, or does a conflict force a rename? | [open-source strategy](../12-business/04-open-source-strategy.md) | before public launch |
| OQ-106 | FSL vs AGPL final call at opening time (D-034 provisional) — re-evaluate against the 2027+ landscape | [open-source strategy](../12-business/04-open-source-strategy.md) | at source-opening trigger |
| OQ-107 | Publish this planning corpus (radical-transparency marketing) or keep it internal (competitors read the cost model)? | [open-source strategy](../12-business/04-open-source-strategy.md) | before launch marketing |

### OQ-100–105 — Data API

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-100 | Ship the OpenAPI spec under `follow-privileges`, or gate it behind `service_role` against schema-shape disclosure? | [REST API design](../04-data-api/01-rest-api-design.md) | Phase 5, with threat-model ruling |
| OQ-101 | Per-project `db-schemas` config (beyond `public`, e.g. an `api` views-only schema) — allow, and in which release? | [REST API design](../04-data-api/01-rest-api-design.md) | post-V1, on demand |
| OQ-102 | Should the gateway optionally long-poll (~10 s) the first request into a resuming project instead of always 503ing? | [request pipeline](../04-data-api/02-request-pipeline.md) | once real resume-time distributions exist |
| OQ-103 | If the gateway goes multi-node, do rate-limit buckets move in-process with async Redis reconciliation? | [request pipeline](../04-data-api/02-request-pipeline.md) | at gateway split trigger |
| OQ-104 | Key-rotation retirement of the old kid at 30 days: automatic vs gated on developer confirmation with last-seen data | [API keys & roles](../04-data-api/03-api-keys-and-roles.md) | with early-customer feedback |
| OQ-105 | Per-plan role settings (raised `statement_timeout`, `work_mem`-class): offered, and where does the config live? | [API keys & roles](../04-data-api/03-api-keys-and-roles.md) | V1.x, with pricing |

### OQ-110–119 — Auth

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-110 | Auth → project DB via the shared PgBouncer (lean, reserved `corebase_auth` role) vs a tiny dedicated direct pool | [auth architecture](../05-auth/01-auth-architecture.md) | Phase 4, with pooling load numbers |
| OQ-111 | Per-project auth config: dedicated control-plane table vs rows in `project_settings` | [auth architecture](../05-auth/01-auth-architecture.md) | before dashboard auth pages (Phase 4) |
| OQ-112 | Rotated-key pickup in PostgREST (SIGUSR2 reload vs container restart) and measured p99 of a strict-mode Redis check | [sessions & tokens](../05-auth/02-sessions-and-tokens.md) | Phase 4–5 |
| OQ-113 | Absolute session lifetime ("force re-login every N days") as per-project config | [sessions & tokens](../05-auth/02-sessions-and-tokens.md) | V1.x |
| OQ-114 | Ship direct-GET `/verify` consumption and add a "press to confirm" interstitial only if scanner-prefetch breakage shows up? | [flows](../05-auth/03-flows.md) | post-launch, on `invalid_token`-after-`used` evidence |
| OQ-115 | Turnstile CAPTCHA on `/signup`+`/recover`: V1 launch requirement or config-off knob wired for later enablement? | [flows](../05-auth/03-flows.md) | Phase 4 |
| OQ-116 | Dedicated sending IP: trigger volume (~50k/month provisional) and who owns the warm-up schedule | [email infrastructure](../05-auth/04-email-infrastructure.md) | when email metering exists |
| OQ-117 | Do security-notice emails count against per-project caps? (leaning no, but exemptions weaken the cap invariant) | [email infrastructure](../05-auth/04-email-infrastructure.md) | Phase 4, with abuse prevention |
| OQ-118 | Apple Sign-In timing (App Store mandates it alongside other social logins; signed-JWT secret quirks) | [OAuth & future](../05-auth/05-oauth-and-future.md) | V1.2 planning |
| OQ-119 | Magic-link vs 6-digit OTP for email sign-in: both under one endpoint, or pick one for V1.1? | [OAuth & future](../05-auth/05-oauth-and-future.md) | V1.1 design |

### OQ-120–126 — Storage

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-120 | Bucket-level `size_limit` in V1, or is the per-project quota enough until customers ask? | [storage architecture](../07-storage/01-storage-architecture.md) | Phase 6 |
| OQ-121 | Per-project object encryption (SSE-C / envelope keys) for cryptographic erasure, at the cost of presigned uploads | [storage architecture](../07-storage/01-storage-architecture.md) | before any compliance-driven segment (V2+) |
| OQ-122 | Is 50 MB the right proxy/presign threshold? Needs NIC-headroom and p99 upload-size measurements | [storage architecture](../07-storage/01-storage-architecture.md) | with beta traffic measurements |
| OQ-123 | Cloudflare purge-by-URL rate limits: at what overwrite volume does purging need batching or hashed-key-only guidance? | [storage architecture](../07-storage/01-storage-architecture.md) | at overwrite-volume trigger |
| OQ-124 | Daily full per-project R2 listings are O(total objects): at what fleet size does the orphan sweep go incremental? | [storage API & policies](../07-storage/02-storage-api-and-policies.md) | at fleet-size trigger |
| OQ-125 | Pre-expiry signed-URL revocation: Redis denylist on the signed-GET path, or keep "use a private bucket"? | [storage API & policies](../07-storage/02-storage-api-and-policies.md) | on first real request |
| OQ-126 | Explicit part-level multipart resume (S3-style UploadPart) before V1.1, or keep it implicit in SDK/proxy? | [storage API & policies](../07-storage/02-storage-api-and-policies.md) | before V1.1 |

### OQ-108–109, 127–130 — Realtime (post-V1)

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-108 | Walrus-style policy evaluation: prototype cost per event per 100 subscribers, and is delivery-time policy skew acceptable? | [realtime architecture](../08-realtime/01-realtime-architecture.md) | gate for CDC v2 |
| OQ-109 | Per-plan `max_slot_wal_keep_size` and slot count (Free likely CDC-disabled or 1 slot / 1 GB) | [realtime architecture](../08-realtime/01-realtime-architecture.md) | after per-plan disk quotas land (V1.2) |
| OQ-127 | Benchmarks: WAL overhead of `wal_level=logical` vs `replica`, and `REPLICA IDENTITY FULL` write amplification | [realtime architecture](../08-realtime/01-realtime-architecture.md) | before CDC ships (V1.2) |
| OQ-128 | Load-validate broadcast limits (10 msg/s/conn, 500 msg/s/channel, 64 KiB payload, 50 req/s REST) against real capacity | [channels, broadcast, presence](../08-realtime/02-channels-broadcast-presence.md) | before broadcast GA (V1.2) |
| OQ-129 | `realtime.can_join` v2: result-cache TTL per (connection, channel), paused-DB behavior, join-storm protection | [channels, broadcast, presence](../08-realtime/02-channels-broadcast-presence.md) | V1.2 |
| OQ-130 | Presence ceiling: 500 keys/channel and 1 KiB meta right? When does snapshot-on-join need pagination or lazy sync? | [channels, broadcast, presence](../08-realtime/02-channels-broadcast-presence.md) | V1.2 |

### OQ-131–134, 149, 168–171 — Dashboard & design system

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-149 | Overview sparkline data path: control-plane rollup table vs a scoped Prometheus proxy on the platform API. Still open on purpose — D-222 ships the overview page *without* the sparklines and says so on the page, rather than settling this from inside a component | [dashboard IA](../09-dashboard/01-dashboard-ia.md) | before any per-project metric is shown to a customer |
| OQ-131 | Executed-DDL journal: exported into `db pull`/`db diff` as migration entries, or human-readable log only? | [table editor](../09-dashboard/02-table-editor.md) | Phase 7, with migrations |
| OQ-132 | Index creation from the editor: plain `CREATE INDEX` vs `CONCURRENTLY` by default above a row-count threshold | [table editor](../09-dashboard/02-table-editor.md) | with the D-132 execution-path implementation |
| OQ-133 | Introspection cache: is focus-revalidate + 60 s polling enough, or should the OQ-082 DDL trigger push-invalidate editors? | [SQL editor](../09-dashboard/03-sql-editor.md) | Phase 7, together with OQ-082 |
| OQ-134 | Query-history redaction/retention: literal masking, shorter retention, org-configurable, or per-run "don't record"? | [SQL editor](../09-dashboard/03-sql-editor.md) | before history ships (Phase 7) |
| OQ-168 | Does the marketing site share the product token set, or get a looser expressive palette the product avoids? | [design system](../09-dashboard/04-design-system.md) | before the launch site is built |
| OQ-169 | Icon library: adopt Lucide (shadcn default) or draw a custom set for the ~30 product-specific concepts? | [design system](../09-dashboard/04-design-system.md) | Phase 7 |
| OQ-170 | ~~Ship a `prefers-reduced-motion` contract now, or defer until animation exists~~ **Resolved by D-225**: shipped now — 120–180 ms, `transform`/`opacity` only, fully disabled under `prefers-reduced-motion: reduce`; skeletons do not shimmer | [design system](../09-dashboard/04-design-system.md), [ux standards](../09-dashboard/05-ux-standards.md) | — |
| OQ-171 | Does the CLI colour its output to match the violet palette, or stay terminal-default? | [design system](../09-dashboard/04-design-system.md) | Phase 8, with CLI spec |

### OQ-039, 135–139 — CLI & SDK

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-135 | `corebase import` (re-import counterpart to export): V1.1 candidate or documented-manual-only via `REIMPORT.md`? | [CLI spec](../10-cli-and-sdk/01-cli-spec.md) | V1.1 planning |
| OQ-136 | Steer CI users to read-scoped PATs for verification-only pipelines, and does that need a `--scope` flag on `login --token`? | [CLI spec](../10-cli-and-sdk/01-cli-spec.md) | Phase 8 |
| OQ-137 | Podman / Colima / OrbStack: test and claim a support matrix, or "Docker only" for V1? | [local development](../10-cli-and-sdk/02-local-development.md) | Phase 8 |
| OQ-138 | Dev profiles between `--db-only` and the full stack (e.g. db+auth): real demand or flag creep? | [local development](../10-cli-and-sdk/02-local-development.md) | deferred until asked twice |
| OQ-139 | Multi-tab session sync: adopt `BroadcastChannel` (storage-event fallback) or storage-events-only for V1? | [SDK spec](../10-cli-and-sdk/03-sdk-spec.md) | Phase 8, after browser-support review |
| OQ-039 | Published-per-project types package (auto-regenerated on `db push`) vs the committed `gen types` file | [SDK spec](../10-cli-and-sdk/03-sdk-spec.md) | post-V1 |

### OQ-140–148, 157–159 — Infrastructure

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-140 | When does the data-plane fleet move from Hetzner CCX to dedicated AX (~2× RAM/€, Robot ops, vSwitch networking)? | [infra phases](../11-infrastructure/01-infra-phases.md) | ≥6 data nodes or compute >40% of COGS |
| OQ-141 | Sweep informal "node agent" phrasing into D-052 wording, or introduce a real agent in Phase B if round-trips bottleneck? | [infra phases](../11-infrastructure/01-infra-phases.md) | Phase B, measure first |
| OQ-142 | Does the 75% DR headroom ceiling (D-148) count warm stacks? (proposed: yes, per D-071) | [infra phases](../11-infrastructure/01-infra-phases.md) | when DR drills produce data |
| OQ-143 | If R2's S3-conditional-write Terraform lockfile proves unreliable under concurrent CI, fall back to Terraform Cloud? | [IaC & CI/CD](../11-infrastructure/02-iac-and-cicd.md) | after 3 months of staging usage |
| OQ-144 | WireGuard mesh module: pre-build in Phase B, or on the first dedicated-node / second-location need? | [IaC & CI/CD](../11-infrastructure/02-iac-and-cicd.md) | Phase B or first dedicated node |
| OQ-145 | Ephemeral second staging data node per e2e run vs a standing one (~€29/mo): cost vs ~2 min boot latency — ephemeral confirmed for *drills* by D-175; e2e-run substrate still open | [IaC & CI/CD](../11-infrastructure/02-iac-and-cicd.md) | start ephemeral; revisit on e2e flakes |
| OQ-146 | Paging delivery: self-hosted Alertmanager→Twilio/ntfy vs a free-tier incident tool (Grafana OnCall OSS) | [observability](../11-infrastructure/03-observability.md) | before first paying customer |
| OQ-147 | `corebase_monitor` exact grants, and is it filtered from customer-visible `pg_stat_activity` views? | [observability](../11-infrastructure/03-observability.md) | at monitoring rollout (Phase 2–3) |
| OQ-148 | remote_write the alert-critical series to a tiny secondary so a mon-1 loss doesn't blind on-call mid-incident? | [observability](../11-infrastructure/03-observability.md) | before GA |
| OQ-157 | Status-page/paging vendor (with OQ-146): one incident vendor or two, and does `status.corebase.co` need non-Cloudflare DNS? | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) | before first paying customer |
| OQ-158 | Measured parallel restore rate per target node — the real bound on D-148's <60 min RTO (interacts with OQ-060 caps) | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) | first quarterly node-loss drill |
| OQ-159 | Region-loss refinements: pre-scripted `envs/dr/` vs documented-only; paid-tier storage-object second copies; publish paid-first restore priority? | [disaster recovery](../11-infrastructure/04-disaster-recovery.md) | with OQ-078, before V2 multi-region |

### OQ-150–156 — Quality

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-150 | How many staging nodes make placement-sensitive tests (pinning, bin-packing storms, cordon) meaningful, at what cost? | [testing strategy](../13-quality/01-testing-strategy.md) | when staging is stood up (Phase 1) |
| OQ-151 | k6 thresholds run record-only until the request-pipeline latency budget locks — decide the lock date | [testing strategy](../13-quality/01-testing-strategy.md) | with the request-pipeline latency budget |
| OQ-152 | Flake policy for non-critical tests (auto-skip + tracking issue vs flakes-block); golden path/isolation are exempt | [testing strategy](../13-quality/01-testing-strategy.md) | before the suite is big enough to flake |
| OQ-153 | Is 12 months of security fixes for the previous SDK major right, and does the CLI need longer (CI embedding)? | [release & versioning](../13-quality/02-release-and-versioning.md) | before the first public SDK major |
| OQ-154 | Usage floor for D-153 removals: absolute calls/day, distinct keys, or zero-for-N-weeks — and who signs off | [release & versioning](../13-quality/02-release-and-versioning.md) | before the first deprecation is filed |
| OQ-155 | Forced-unpin (D-154) for unresponsive owners: auto-roll with email only, or dashboard ack above a traffic threshold? | [release & versioning](../13-quality/02-release-and-versioning.md) | before the first PostgREST major arrives |
| OQ-156 | Surface per-key "you called a deprecated endpoint this week" in the dashboard, or header + changelog until needed? | [release & versioning](../13-quality/02-release-and-versioning.md) | with observability, before first real deprecation |

### OQ-160–165 — Roadmap

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-160 | Calendar estimates are deliberately absent — attach them only when team composition (§117) is decided | [phase plan](../14-roadmap/01-phase-plan.md) | when team composition is decided |
| OQ-161 | Private-beta size and selection criteria (10 vs 50 changes support load significantly) | [phase plan](../14-roadmap/01-phase-plan.md) | before private beta (Phase 9) |
| OQ-162 | Webhooks: pre-commit to the V1.2 slot or leave floating? (currently floating) | [V1 scope & cut list](../14-roadmap/02-v1-scope-and-cutlist.md) | post-V1 roadmap planning |
| OQ-163 | pg_cron / pgmq as early in-Postgres compute primitives before V1.3: cheap wins or scope creep? | [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md) | evaluate at V1.1 |
| OQ-164 | When SOC 2 prep starts (V2 vs V3 boundary) | [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md) | first enterprise-shaped deal |
| OQ-165 | Milestone-0 staging: cheap cloud VMs for T1–T8 speed vs a prod-representative dedicated box before the retro | [milestone 0](../14-roadmap/04-milestone-0.md) | Milestone 0 start |

### OQ-166–167 — Risks

| ID | Question (one line) | Owning doc | Decide by |
|---|---|---|---|
| OQ-166 | Security-review budget/vendor class: full pentest vs focused review of auth + RLS | [risk register](01-risk-register.md) | Phase 7 timeframe |
| OQ-167 | Cyber-insurance: worth it pre-revenue? | [risk register](01-risk-register.md) | before public launch |
| OQ-179 | Does the command palette search *data* (projects by name and ref, later tables and buckets) or only actions and destinations? Data search means an endpoint per searchable resource plus a debounce contract; actions-only is a smaller promise. Leaning: destinations plus the user's own objects, since the project list is already client-side | [ux standards](../09-dashboard/05-ux-standards.md) | before a second searchable resource type exists |
| OQ-180 | Where does a side panel's state live in the URL — a query parameter (`?panel=key&id=…`, simple and ugly) or a nested route (clean, doubles the route count)? | [ux standards](../09-dashboard/05-ux-standards.md) | before the second panel is built; retrofitting one is cheap and retrofitting five is not |
| OQ-182 | **Is the binding resource at density cores or RAM?** M-008 put 100 projects on one node with two client connections each: RAM was over-booked 27-fold while CPU sat at 82%. The cost model books and reasons in RAM (D-091, D-174) and does not model cores at all. On a CCX43 the core:RAM ratio differs from this ARM VM, so the answer may flip — but nobody has asked the question, and the density model currently cannot answer it | [measurements](../14-roadmap/05-measurements.md), [cost model](../12-business/01-cost-model.md) | with the D-209-compliant measurement, before D-091 is re-based either way |
| OQ-183 | **Is the pooler's 10–20 MiB RSS budget an order of magnitude too generous?** M-008 measured 1.2 MiB anon, flat from idle to 200 attached connections, against a 64 MiB container ceiling. If it holds on x86 with PostgREST present, the triplet's ~768 MiB burst-ceiling arithmetic (D-174) is carrying a sidecar that costs almost nothing | [connection pooling](../03-database-platform/02-connection-pooling.md) | when the triplet is measured whole |
| OQ-181 | Is there a density preference (comfortable/compact) or is dense the only mode? A preference is a second layout to test forever; leaning one mode until someone complains | [ux standards](../09-dashboard/05-ux-standards.md) | when a customer asks |

## Dependencies

- Builds on: every doc in the corpus — this register aggregates their Open Questions sections.
- Feeds: [decision log](../00-foundation/05-decision-log.md) (each closure becomes a D-xxx or a documented dissolution), [risk register](01-risk-register.md) (open questions past their decide-by point are risk signals).
