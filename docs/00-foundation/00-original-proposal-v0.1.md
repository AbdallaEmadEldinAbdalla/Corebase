# Steadhold — Original Architecture Proposal (v0.1)

> Preserved as the founding reference. **Superseded by the corpus wherever they disagree (D-040).**
> Formatting is condensed; section numbering (§1–124) is preserved and is what other docs cite.
> **The product was called Corebase when this was written** (renamed 2026-09-08, D-407). The name
> is updated throughout so the §-references stay usable as a spec; nothing else about the text moved.
> Status: Initial Architecture Proposal · Category: Backend-as-a-Service · Inspiration: Supabase, Firebase, Turso, Fly.io

**§1 Executive summary.** Steadhold is a developer-focused BaaS providing everything to build/operate a modern app backend without manual infrastructure: PostgreSQL, auto-generated APIs, auth, authorization, RLS, object storage, realtime, secrets, logs, metrics, backups, migrations, API keys, local dev tooling, CLI, SDKs, dashboard. V1 should not reproduce every Supabase feature — establish a strong foundation and add capabilities progressively.

**§2 Product vision.** "The easiest way to deploy the backend of an application." From "I have an idea" to database/auth/API/storage/realtime ready and app connected — without understanding Kubernetes, replication, networking, reverse proxies, provisioning, object storage infra, auth infra, WebSockets, or backups.

**§3 Philosophy.** §3.1 Developer first — project creation = create → region → plan → ready. §3.2 PostgreSQL first — no abstraction over SQL; enhance Postgres, don't hide it. §3.3 Open-source friendly — OSS core + managed cloud model. §3.4 Portable — export database, files, users, config, migrations; never trapped. §3.5 Infrastructure should disappear — users think in users/products/orders, not PgBouncer/WAL/K8s/VPCs.

**§4 Target users.** Indie developers (SaaS, mobile, websites, internal tools, MVPs); startups (managed infra without DevOps hires); agencies (many client projects under one umbrella); enterprise later (SSO, SAML, SCIM, audit, private networking, compliance — not V1).

**§5 Competitive positioning.** Not "a copy of Supabase" — a complete backend foundation around portability, simplicity, infra flexibility. Differentiators: simpler infrastructure, better portability, infra flexibility (shared/dedicated/serverless/edge later), first-class CLI (`steadhold init/dev/db push/db pull/db reset/deploy/logs`).

**§6 Core architecture.** Internet → Cloudflare → API Gateway → {Project API, Auth API, Storage API} → Steadhold Control Plane → {Provisioner, Queue, Scheduler} → Infrastructure → {PostgreSQL, Storage, Realtime}.

**§7 Control plane vs data plane.** Control plane manages Steadhold itself: users, orgs, projects, billing, provisioning, regions, credentials, config, deployments, infra state.

**§8 Data plane.** Handles customer traffic: PostgreSQL, REST API, Auth, Storage, Realtime, Functions. Separation allows independent scaling.

**§9 Multi-tenancy model.** Organization (customer/team) → Projects (e.g. Production/Staging/Development) → Environments eventually (Development/Preview/Staging/Production). Consider from the beginning even if V1 supports one environment.

**§10 Database isolation.** Option A: database per project (strong isolation, simple mental model, easy backup/delete/migrate; more infra, costlier). Option B: schema per project (cheaper, weaker isolation). Option C: shared DB with tenant IDs (efficient, security-complex). Recommended: database per project where practical — but not a dedicated VM per project; multiple Postgres instances per infrastructure node. Later: small → shared infra; large → dedicated DB; enterprise → dedicated cluster.

**§11 PostgreSQL layer.** Provide: Postgres, extensions, migrations, backups, pooling, credentials, SQL editor, logs, metrics, replication, PITR.

**§12 Connection pooling.** Apps create thousands of connections; Postgres doesn't handle unlimited connections. Client → API/Pooler → PgBouncer → PostgreSQL.

**§13 Database credentials.** `DATABASE_URL`, `DIRECT_DATABASE_URL`, `POOLER_DATABASE_URL`; dashboard rotation; encrypted secrets, secret manager, restricted access, rotation. Never plaintext unnecessarily.

**§14 REST API.** Auto-expose tables: `GET/POST /rest/v1/posts`, `PATCH/DELETE /rest/v1/posts?id=eq.<id>`.

**§15 API architecture.** HTTP → Gateway → Project Resolver → Authentication → Authorization → Query Builder → PostgreSQL. The API layer must understand project, user, role, API key, JWT, permissions, RLS.

**§16 Authentication.** V1: email/password, verification, password reset, sessions, JWT, refresh tokens, user management. Later: Google/GitHub/Apple/Microsoft/Discord, magic links, passkeys, MFA, SSO, SAML.

**§17 Auth architecture.** Client → Auth API → {User Service, Session Service, Token Service, OAuth Service} → PostgreSQL.

**§18 JWT.** Claims like `{sub, role, project_id, iat, exp}`. Signing keys securely managed; RS256 or equivalent modern asymmetric algorithm.

**§19 RLS.** First-class feature. Example: `CREATE POLICY ... ON profiles FOR SELECT USING (auth.uid() = user_id)`. Identity propagation: JWT → API → authenticated user → Postgres session context → RLS → data.

**§20 Security requirement.** Tenant isolation is a critical boundary. Every request needs unambiguous project context; never trust client-supplied `project_id` without validating key/token against the project.

**§21 Storage.** Buckets (public/private); upload, download, delete, list, signed URLs, MIME validation, size limits, metadata, access policies.

**§22 Storage architecture.** Client → Storage API → Authorization → object storage (S3/R2/MinIO). Metadata in Postgres (`storage.objects`); files in object storage.

**§23 Realtime.** Eventually: database changes, broadcasts, presence. Postgres → logical replication/WAL → Realtime service → WebSocket gateway → clients.

**§24 Realtime security.** No cross-project subscriptions. Every WS connection bound to project_id, user_id, token, permissions before joining channels.

**§25 API gateway.** Routing, TLS, rate limiting, authn, project resolution, versioning, request IDs, logging. Candidates: Envoy, Nginx, HAProxy, custom Go. Avoid building a massive gateway for V1.

**§26 Internal services.** steadhold-api/-auth/-storage/-realtime/-provisioner/-worker/-gateway — but don't microservice immediately; modular monolith first.

**§27 Recommended initial backend.** One Steadhold API (projects, orgs, billing, keys, provisioning, settings); separate services only when scaling requires.

**§28 Provisioning system.** On project create: create project → assign ID → select region → allocate DB → generate credentials → configure DB/pooler/API/storage/auth/backups → READY.

**§29 Provisioning state machine.** States: CREATING, PROVISIONING, CONFIGURING, READY, FAILED, DELETING, DELETED. Never a single synchronous request; use jobs.

**§30 Job queue.** Create → DB transaction → provisioning job → queue → worker → infrastructure. Queue candidates: Redis, NATS, RabbitMQ. Start simple.

**§31 Infrastructure layer.** Abstract ComputeProvider/DatabaseProvider/StorageProvider/NetworkProvider; providers: AWS, Hetzner, DigitalOcean, OVH… Don't hard-code into one cloud.

**§32 Infrastructure abstraction.** e.g. DatabaseProvider: createDatabase, deleteDatabase, restartDatabase, getDatabaseStatus, createBackup, restoreBackup, rotateCredentials — enables provider migration.

**§33 Deployment strategy.** Phase 1: VMs + Docker. Phase 2: orchestration. Phase 3: Kubernetes where it provides actual value. Don't start with K8s.

**§34 Backups.** Mandatory. Daily backups + continuous WAL archiving + PITR. WAL → object storage; snapshots → backup storage.

**§35 Backup retention.** By plan: Free short, Pro longer, Business extended, Enterprise custom.

**§36 Restore.** Never overwrite production without explicit action. Restore → new database → validate → promote.

**§37 Observability.** Per project: logs, metrics, health, usage. Metrics: CPU, memory, disk, connections, queries, storage, API requests, errors, bandwidth.

**§38 Logging.** Per request: request_id, project_id, user_id, timestamp, method, path, status, duration. Never log sensitive data accidentally.

**§39 Dashboard.** Next.js, Tailwind, shadcn/ui. Org nav: Projects/Billing/Settings. Project nav: Overview, Table Editor, SQL Editor, Database, Auth, Storage, API, Realtime, Logs, Metrics, Backups, Settings.

**§40 Project overview.** Health per service (DB/API/Auth/Storage/Realtime) + requests, DB usage, storage usage, active users, errors.

**§41 Table editor.** Create/delete table, columns, indexes, FKs, constraints, relationships, RLS policies — every UI op translates to SQL/migrations.

**§42 SQL editor.** Syntax highlighting, autocomplete, history, tabs, execution time, results, errors, saved queries; later explain/analyze/plans.

**§43 Migration system.** `steadhold migration create add_profiles` → `migrations/20260827130000_add_profiles.sql`; commands: db push/pull/reset/diff.

**§44 Local development.** `steadhold init` / `steadhold dev`; local stack: Postgres, Auth, Storage, API, Realtime. Docker Compose is an excellent start.

**§45 CLI.** login/logout, init, dev, project create/list/delete, db push/pull/reset/diff, functions deploy, logs, link, status.

**§46 SDK.** `@steadhold/core`: `createClient(URL, ANON_KEY)`; `.from("users").select("*")`; `auth.signInWithPassword`; `storage.from("avatars").upload`; `channel("messages").on(...).subscribe()`.

**§47 API keys.** Public/anonymous key + service-role key; service role bypasses user-level restrictions only by design; treat as secret.

**§48 Secrets.** Env vars, secrets, API keys, JWT config, OAuth credentials — encrypted at rest.

**§49 Rate limiting.** Levels: IP, user, API key, project, endpoint. Anonymous lower, authenticated higher, enterprise custom.

**§50 Abuse prevention.** Spam, mining, malicious APIs, file hosting, phishing, bots, excessive usage. Needs quotas, rate limits, verification, project limits, automated detection, billing protections.

**§51 Billing.** Usage-based eventually (DB size, storage, bandwidth, requests, compute, realtime connections, active users, backups); V1 keeps pricing simple: Free/Pro/Team/Enterprise.

**§52 Free tier.** Designed for developers to actually build something: 1–2 projects, small DB, limited storage/bandwidth/retention/connections. Exact numbers after infrastructure cost modeling.

**§53 Usage metering.** Services → usage events → metering service → usage DB → billing. Don't build billing into individual services.

**§54 Control-plane schema.** users, organizations, organization_members, projects, project_members, project_regions, project_api_keys, project_secrets, project_databases, project_storage, project_settings, billing_customers, subscriptions, usage_records, audit_logs, provisioning_jobs.

**§55 User model.** users(id, email, password_hash, email_verified, created_at, updated_at); separate user_identities(provider, provider_user_id, metadata).

**§56 Organizations.** organizations(id, name, slug, timestamps); organization_members(org_id, user_id, role); roles: owner/admin/member.

**§57 Projects.** projects(id, organization_id, name, slug, region, status, plan, timestamps). Project IDs immutable.

**§58 Project database metadata.** project_databases(id, project_id, provider, host, port, database_name, status, version, timestamps). Never plaintext passwords in normal tables.

**§59 Audit logs.** audit_logs(id, org_id, project_id, actor_user_id, action, resource_type, resource_id, metadata, ip, created_at); actions like project.created, database.reset, api_key.created, member.invited, backup.restored, secret.updated.

**§60 API versioning.** `/api/v1`; no breaking changes without versioning.

**§61 Domain architecture.** steadhold.dev; app.steadhold.dev; api.steadhold.dev; `<project-id>.steadhold.app`; `<project-id>.storage.steadhold.app`. Exact structure decided later.

**§62 Region architecture.** us-east, us-west, eu-west, eu-central, ap-southeast, me-central; choose region at creation → provision there.

**§63 Region-aware control plane.** project → region → infrastructure cluster → database (e.g. project_123 → eu-central → cluster-eu-03 → postgres-184).

**§64 Disaster recovery.** Primary + replica + backup; cross-region recovery (EU primary → EU replica → US backup). After core is stable.

**§65 Security architecture.** TLS everywhere, encryption at rest, secret encryption, least privilege, short-lived credentials, audit logs, network isolation, rate limiting, input validation.

**§66 Administrative access.** No routine engineer access to customer DBs. JIT access, audit logging, restricted roles, break-glass.

**§67 Data encryption.** TLS client→Steadhold→DB; encrypted object storage; secrets in encrypted secret manager.

**§68 Reliability targets.** Define API/DB/storage/realtime uptime eventually (99.9/99.95/99.99). No SLA before infra supports it.

**§69 Health checks.** Every component: /health, /ready (DB, queue, storage connectivity).

**§70 Internal service communication.** Authenticated internal APIs; HTTP/gRPC/NATS. V1: plain HTTP suffices.

**§71 IaC.** Terraform or equivalent; reproducible infra; infra/ tree (networking, postgres, storage, monitoring, regions). No manual dashboard-click dependencies.

**§72 CI/CD.** PR → tests → lint → build → security checks → deploy; automated production deploys.

**§73 Testing strategy.** Unit (logic), integration (DB/API), E2E (account → project → table → user → insert → read), security tests (tenant A cannot access tenant B — automated).

**§74 Critical security test.** Create projects A and B, users in each; user A → project B must yield 403/unauthorized. Runs continuously.

**§75 Failure handling.** All infra operations idempotent (operation_id, idempotency_key, resource_state). Worker crash + retry must not create a second database.

**§76 Provisioning idempotency.** Worker checks "does DB already exist?" → verify/configure vs create. Never blindly repeat destructive ops.

**§77 Project deletion.** DELETE → mark DELETING → disable API → disable writes → backup → delete resources → verify → DELETED. Consider recovery period.

**§78 Data retention.** Soft-deleted period before permanent deletion.

**§79 Developer experience.** The most important feature. `npm install @steadhold/core` → createClient → build immediately.

**§80 First five minutes.** Sign up → create project → copy credentials → install SDK → create table → insert → auth user → query. Target: first successful DB request < 5 minutes.

**§81 V1 scope.** Control plane (users, orgs, projects, keys, settings); DB (Postgres, SQL editor, tables, migrations, connection strings, pooling, backups); API (REST, authn, authz, RLS); Auth (email/password, JWT, sessions, reset, verification); Storage (buckets, upload/download, signed URLs); Dashboard (project, database, auth, storage, logs, settings); CLI (init, dev, link, db push/pull/reset).

**§82 V1 explicitly NOT included.** Edge functions, advanced realtime, global replication, K8s abstraction, multi-cloud, enterprise SSO, SAML, SCIM, AI, vector DB, analytics, CDN, advanced observability.

**§83 V1 development order.** 1 Control plane → 2 Postgres provisioning → 3 Database API → 4 Auth → 5 Storage → 6 RLS → 7 Dashboard → 8 CLI → 9 Backups → 10 Realtime.

**§84 Phase 1 — control plane.** users, orgs, projects, members, keys; dashboard: login → org → projects → create project.

**§85 Phase 2 — PostgreSQL.** create/delete/restart DB, status, connection string, rotate credentials; then SQL editor.

**§86 Phase 3 — API.** GET/POST/PATCH/DELETE with authn, authz, RLS, pagination, filtering, sorting.

**§87 Phase 4 — Auth.** signup, login, logout, refresh, verify, reset; integrate JWT with API.

**§88 Phase 5 — Storage.** create bucket, upload, download, delete, signed URL; external object storage initially.

**§89 Phase 6 — RLS.** JWT → session context → RLS; test cross-tenant aggressively.

**§90 Phase 7 — Dashboard.** Speed, clarity, good defaults, excellent errors; no unnecessary features.

**§91 Phase 8 — CLI.** Local ↔ remote; reproduce database locally.

**§92 Phase 9 — Backups.** Snapshot, WAL archive, restore, retention; test actual recovery.

**§93 Phase 10 — Realtime.** Only after DB/API stable. WAL → change decoder → broker → WebSockets.

**§94 Tech stack.** Dashboard: Next.js/React/TS/Tailwind/shadcn. Core API: Go or Node/TS — recommendation: TS for velocity, Go later for infra-heavy services.

**§95 Database.** PostgreSQL. Non-negotiable.

**§96 Pooling.** PgBouncer.

**§97 Storage.** S3-compatible: R2, S3, MinIO.

**§98 Queue.** Redis first; later NATS/Kafka only when scale justifies.

**§99 Cache.** Redis (sessions, rate limiting, queues, caching, locks). Not a source of truth.

**§100 Observability.** OpenTelemetry, Prometheus, Grafana; logs via Loki.

**§101 Infrastructure.** Linux, Docker, Terraform, Cloudflare → later orchestration, multi-region, multi-cloud.

**§102 Repository.** Monorepo: apps/ (dashboard, docs, marketing), services/ (api, auth, storage, realtime, provisioner, worker), packages/ (sdk, database, auth, config, types), cli/, infra/ (terraform, docker, monitoring), migrations/, tests/, docs/.

**§103 Repository philosophy.** Clear boundaries; avoid everything-imports-everything; control plane → infra abstraction → providers.

**§104 API naming.** REST conventions: POST/GET /v1/projects, GET/PATCH/DELETE /v1/projects/:id.

**§105 Error format.** `{error: {code, message, request_id}}`; never expose stack traces.

**§106 Request IDs.** X-Request-ID in logs, errors, dashboard, support tooling.

**§107 Documentation.** First-class product: Getting Started, Database, Auth, Storage, Realtime, API, CLI, SDK, Security, Migrations, Self-Hosting.

**§108 Quick start.** npm install → createClient(env) → `.from("users").select("*")`.

**§109 Long-term roadmap.** V1.1: OAuth, improved storage, better migrations, CLI improvements, extensions. V1.2: realtime, presence, broadcasts, webhooks. V1.3: serverless functions, scheduled jobs, cron. V2: edge compute, queues, Redis, additional DBs, better global deployment. V3: multi-region, replication, enterprise, private networking, compliance.

**§110 Long-term platform.** Database, Auth, Storage, Realtime, Functions + observability + billing/usage as one platform.

**§111 Ultimate product.** `steadhold create` → complete production backend (DB, auth, storage, API, realtime, functions, queues, cron, observability, backups, CDN).

**§112 Business model.** Free → Developer → Pro → Team → Enterprise; revenue correlates with infrastructure consumption (DB resources, storage, bandwidth, compute, requests, realtime, users, backups).

**§113 Open-source strategy.** Steadhold OSS (API, auth, storage, realtime, local dev) + Steadhold Cloud (managed infra, billing, provisioning, multi-region, enterprise, cloud dashboard).

**§114 Competitive moat.** Not cloning Supabase: efficient provisioning, excellent CLI/SDK, easy migration, better economics, fast provisioning/low latency, ecosystem.

**§115 Biggest technical risks.** Not React/Next/SQL editor — but: 1 tenant isolation, 2 database reliability, 3 backups, 4 provisioning, 5 security, 6 abuse, 7 infra cost, 8 scaling, 9 networking, 10 operational complexity.

**§116 Biggest business risk.** Building too much infrastructure before having users. Small MVP → real developers → feedback → infrastructure pain → build what's needed.

**§117 Initial team.** 1 full-stack/platform, 1 infrastructure, 1 product/frontend. A strong solo engineer can build the MVP; operating production infra alone gets hard as customers grow.

**§118 Initial infrastructure budget.** Cheap: 1–3 compute nodes + object storage + managed DNS/CDN + monitoring + backup storage. Scale with revenue.

**§119 MVP success criteria.** A developer can: 1 create account, 2 create project, 3 get Postgres, 4 create table, 5 insert data, 6 query via API, 7 create auth user, 8 authenticate, 9 apply RLS, 10 upload file, 11 download file, 12 use SDK, 13 run locally, 14 push migrations, 15 restore a backup.

**§120 Final architecture.** Cloudflare → API gateway → {Steadhold API, Auth API, Storage API} → control-plane DB → provisioner queue → workers → {PostgreSQL, object storage, realtime} → observability.

**§121 Most important rule.** Never confuse control plane with customer data plane; the split enables scaling, security, regional deployment, DR.

**§122 First milestone.** Not "build Supabase" — "create a Steadhold project and automatically receive a secure PostgreSQL backend." Flow: account → project → provisioner → Postgres → credentials → API endpoint → dashboard → first SQL query. Then auth, storage, RLS, realtime, functions.

**§123 North star.** One command to a production backend: `steadhold create my-app` → provisioned checklist → connection strings → `steadhold dev`.

**§124 Final principle.** Win not by more features but by simpler, faster, more portable, more transparent, easier to operate. First goal: make one developer love Steadhold. Then 10, 100, 1,000. Infrastructure evolves alongside users.
