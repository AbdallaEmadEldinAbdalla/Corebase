# Phase Plan — V1, End to End

## Purpose

The executable build order for Corebase V1: every phase with scope, key tasks, exit criteria, and the demoable flow that proves it. This corrects the v0.1 proposal's ordering (§83) in two ways: **RLS ships with the data API** (D-036 — never an API without policies), and **backups move up** (durability outranks dashboard polish per the priority stack D-002). Realtime is out of V1 entirely (D-030).

Phases are sequential milestones, not calendar estimates. Each ends in something demoable; nothing starts before the previous phase's exit criteria hold. Team-size assumptions per proposal §117 (1–3 engineers).

## Design

### Phase overview

```text
P0  Walking skeleton        "corebase project → running Postgres → first query"
P1  Control plane           orgs, projects, keys, platform API, dashboard shell
P2  Database platform       pooling, credentials, pause/resume, disk quotas
P3  Backups                 pgBackRest, WAL archiving, restore-to-new, verification
P4  Auth                    email/password, JWT, refresh rotation, email infra
P5  Data API + RLS          gateway pipeline, PostgREST, policies, isolation suite
P6  Storage                 buckets, upload/download, signed URLs, RLS on objects
P7  Dashboard               table editor, SQL editor, auth/storage/keys UI
P8  CLI + local dev + SDK   corebase dev, db push/pull, export, @corebase/core
P9  Hardening & launch      load, chaos-lite, docs, pricing wiring, private beta
```

Dependency shape: P0→P1→P2→P3 are strictly sequential (each builds the substrate of the next). P4 and P5 overlap partially (P5 needs P4's JWTs). P6–P8 can interleave. P9 gates launch.

---

### Phase 0 — Walking skeleton (Milestone 0)

The proposal's §122 first milestone. Full task-level detail lives in [milestone-0](04-milestone-0.md).

**Scope:** one Hetzner node, hand-rolled control plane minimum: `POST /v1/projects` → provisioning job → Postgres 17 container with volume + credentials → connection string returned → `psql` works. No dashboard, no auth, no pooler.

**Exit criteria:**
- Create → READY reliably in <60s, 20 times in a row, including two runs where the worker is killed mid-provision and the job resumes idempotently.
- Delete tears everything down verifiably (container, volume, DNS, control-plane rows marked).
- State machine rows in Postgres match reality after a node reboot (first reconciliation sweep works).

**Demo:** `curl -X POST .../v1/projects` → paste connection string → `psql` → `CREATE TABLE`.

---

### Phase 1 — Control plane

**Scope:** the real foundation per [data model](../02-control-plane/01-data-model.md) and [platform API](../02-control-plane/02-platform-api.md): users (dashboard accounts), orgs + membership roles, projects with full state machine, API keys generation, secrets (envelope encryption D-035), audit log writes on every mutation, `/v1` API with error envelope + request IDs (D-032/D-039), BullMQ worker per [job queue](../02-control-plane/04-job-queue-and-workers.md). Dashboard shell: login, org switcher, project list, create-project flow, project overview stub.

**Key tasks:** control-plane schema migrations; session auth for the dashboard + PAT auth for the future CLI; provisioning saga hardened (per-step idempotency checks); nodes table with capacity accounting; staging environment stood up via Terraform ([iac & cicd](../11-infrastructure/02-iac-and-cicd.md)).

**Exit criteria:**
- Two users in one org with different roles see correct permissions end to end.
- Every mutating endpoint writes an audit row; keys are stored hashed; secrets round-trip through envelope encryption.
- CI runs unit + integration suites green on every PR.

**Demo:** sign up → create org → create project in dashboard → watch state transitions live → project READY with connection string displayed.

---

### Phase 2 — Database platform

**Scope:** per [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) and [pooling](../03-database-platform/02-connection-pooling.md): PgBouncer per project (transaction mode, D-015), `DATABASE_URL`/`DIRECT_DATABASE_URL` distinction, credential rotation flow, **pause/resume (D-008)** with idle detection, per-project disk quotas + the disk-full enforcement ladder, node bin-packing for placement, per-project resource limits (cgroups).

**Exit criteria:**
- 100 test projects on one node within RAM budget; density matches the [cost model](../12-business/01-cost-model.md) assumptions or the model is corrected.
- Pause after idle threshold; resume on demand in target time; no data loss across 50 pause/resume cycles.
- A project that fills its disk quota goes read-only and recovers when space is freed; the node itself never suffers.
- Credential rotation works with active connections (documented behavior).

**Demo:** create 20 projects, watch them pause when idle, resume one by connecting to it.

---

### Phase 3 — Backups (moved up from proposal's Phase 9)

**Why moved:** durability is #2 in the priority stack (D-002). Running weeks of P4–P8 development against customer-shaped databases with no restore path is how "we lost a beta user's data" happens. Backups also unblock realistic restore/DR testing for everything later.

**Scope:** per [backups & PITR](../03-database-platform/05-backups-and-pitr.md): pgBackRest per project → R2; nightly base + continuous WAL archiving; restore-to-new-instance flow exposed in the platform API; retention per plan; **automated restore verification job**; final-backup-on-delete in the deletion pipeline (D-038).

**Exit criteria:**
- PITR to an arbitrary timestamp within retention works, proven by restoring a project and finding a row written at a known time.
- Restore verification job runs on a schedule and alerts on failure (tested by sabotaging a backup in staging).
- WAL-archive lag is monitored and alerts fire (tested).
- Deleting a project produces a final backup retrievable during the 7-day soft-delete window.

**Demo:** drop a table "accidentally", restore project to 5 minutes earlier as a new instance, show the table back.

---

### Phase 4 — Auth

**Scope:** per [05-auth](../05-auth/01-auth-architecture.md): the multi-tenant auth module serving `/auth/v1/*`; `auth` schema in each project DB; signup/login/logout/verify/reset flows; ES256 JWTs + per-project JWKS (D-014); refresh rotation with reuse detection; **email infrastructure** (provider integration, templates, per-project send caps).

**Exit criteria:**
- All [flows](../05-auth/03-flows.md) pass integration tests including the abuse cases (enumeration resistance, rate limits, token reuse → session-family revocation).
- JWKS rotation runbook executed once in staging, sessions survive per design.
- Emails deliver to major providers from staging (manual verification) with SPF/DKIM/DMARC green.

**Demo:** a plain HTML page signs a user up against a project, verifies email, logs in, shows the JWT claims.

---

### Phase 5 — Data API + RLS (merged, not sequential — D-036)

**Scope:** per [rest-api-design](../04-data-api/01-rest-api-design.md), [request pipeline](../04-data-api/02-request-pipeline.md), [rls-design](../06-security/02-rls-design.md): the thin gateway (project resolution, key validation, rate limiting D-033, paused-project resume trigger); PostgREST per project wired to the four-role model; `auth.uid()` helpers installed in every project; default-deny RLS posture; anon/service_role keys (D-029); **the tenant-isolation suite running in CI from the first week of this phase** ([isolation tests](../06-security/03-tenant-isolation-tests.md)).

**Exit criteria:**
- The full filter/embed/RPC surface works through the gateway against a seeded project.
- The isolation suite passes and is release-blocking; the §74 cross-tenant test runs continuously in staging.
- Latency budget met (p50/p99 per the request-pipeline doc) under k6 smoke load.
- A request to a paused project resumes it per the specified UX.

**Demo:** the proposal's §80 five-minute flow minus storage: table + policy via SQL, insert as service_role, read as authenticated user seeing only their rows.

---

### Phase 6 — Storage

**Scope:** per [07-storage](../07-storage/01-storage-architecture.md): storage module at `/storage/v1`; `storage` schema per project; R2 integration; upload/download/list/delete; signed URLs; public buckets via the storage domain; RLS-based policies on objects; orphan-reconciliation sweep; storage quota accounting.

**Exit criteria:**
- Policy examples from the docs work as written (avatars own-path case).
- Orphan sweep provably converges both failure directions (crash-injected tests).
- Quota enforcement blocks uploads at cap.

**Demo:** avatar upload from the phase-4 demo page, public URL renders, signed URL expires.

---

### Phase 7 — Dashboard (full)

**Scope:** per [09-dashboard](../09-dashboard/01-dashboard-ia.md): table editor (UI→SQL with preview + save-as-migration), SQL editor with safety rails, auth users management, storage browser, API keys page with copy-paste snippets, logs view, backups view with restore button, the paused-project UX, onboarding checklist on project overview.

**Exit criteria:**
- The entire §80 first-five-minutes flow is completable by a new user without reading docs (hallway-tested on ≥3 people, timed <5min).
- Every UI mutation shows its SQL; every error shows a request_id.

**Demo:** the first-five-minutes flow, recorded end to end.

---

### Phase 8 — CLI + local dev + SDK

**Scope:** per [10-cli-and-sdk](../10-cli-and-sdk/01-cli-spec.md): `login/init/link/dev/db push|pull|reset/migration new/export/projects/secrets/logs`; the Docker Compose local stack with prod-parity paths; `@corebase/core` SDK (database builder, auth, storage) + `gen types`; **`corebase export`** (D-004).

**Exit criteria:**
- `corebase dev` cold-starts the full local stack; the same SDK code runs locally and against prod by swapping the URL.
- `db push/pull` round-trips a real schema including policies.
- `export` tarball restores into a vanilla Postgres + MinIO setup, documented (the portability proof).
- SDK published to npm (scoped, beta tag) with generated types working.

**Demo:** scaffold an app locally with `corebase dev`, push migrations to prod project, deploy nothing else — the app works against prod.

---

### Phase 9 — Hardening & launch

**Scope:** the [MVP success criteria](02-v1-scope-and-cutlist.md) checklist run end to end repeatedly; load tests (provisioning storm, request pipeline); chaos-lite drills (node-loss restore per [disaster recovery](../11-infrastructure/04-disaster-recovery.md)); docs site (getting started, per-subsystem guides, self-explanatory error codes); pricing/billing wiring (Stripe, plan enforcement, usage metering per [pricing](../12-business/02-pricing-and-plans.md)); abuse controls armed ([abuse prevention](../12-business/03-abuse-prevention.md)); status page; private beta (10–50 hand-picked developers), feedback loop, then public.

**Exit criteria (launch gate):**
- All 15 items of proposal §119 pass as automated e2e ([testing strategy](../13-quality/01-testing-strategy.md) golden path).
- One full node-loss drill completed within RTO in staging.
- Isolation suite: 30 consecutive days green.
- Billing charges a real test card correctly for a Pro upgrade.
- On-call rotation + runbooks exist for every alert in the [alert catalog](../11-infrastructure/03-observability.md).

**Demo:** a stranger signs up and ships something.

## Decisions

- **D-160 — Phase order is P0–P9 as above; backups are Phase 3 (before auth/API), realtime is out of V1, RLS ships inside Phase 5 with the data API.** *(Rationale: priority stack D-002 — durability before features; D-030; D-036.)*
- **D-161 — Every phase has exit criteria that are testable, and a phase is not "done" on code-complete — only on criteria-pass.** *(Rationale: the proposal's own §116 warning about building ahead of validation.)*
- **D-162 — The isolation suite becomes release-blocking the week Phase 5 starts, not at launch.** *(Rationale: retrofitting security gates never happens under launch pressure.)*

## Open Questions

- OQ-160: Calendar estimates are deliberately absent; attach them only when the team composition (§117) is decided. Tracked in [open questions](../15-risks/02-open-questions.md).
- OQ-161: Private-beta size and selection criteria (10 vs 50 changes support load significantly).

## Dependencies

- Builds on: the entire corpus — every phase references its owning docs.
- Feeds: [02-v1-scope-and-cutlist.md](02-v1-scope-and-cutlist.md), [04-milestone-0.md](04-milestone-0.md), [15-risks/01](../15-risks/01-risk-register.md).
