# Critical Review of the v0.1 Proposal

## Purpose

The v0.1 architecture proposal (§1–124) is the founding document of Corebase. It is directionally strong and unusually disciplined about scope — and, like every founding document, naive in specific, dangerous places. This review grades it section-by-section: what is sound (build on it), what is naive (the corpus corrects it), what is missing (the corpus adds it), and where it contradicts itself (the decision log resolves it).

**Verdict up front:** the proposal's instincts about *process* (control/data plane split, idempotent provisioning, modular monolith, "make one flow reliable before adding the next") are excellent. Its blind spots are *economic* (the cost of DB-per-project free tiers), *underestimation of subsystem depth* (the data API and auth are each entire products), and *operational hazards it lists as checkboxes* (WAL replication, backups, upgrades).

---

## 1. What the proposal gets right (§6–7, §26–30, §75–76, §81–83, §115–124)

These sections should be treated as settled and are adopted nearly as-is:

- **Control plane vs data plane (§7–8, §121).** The single most important architectural idea in the doc. Adopted and deepened in [control vs data plane](../01-architecture/02-control-vs-data-plane.md).
- **Provisioning as an async state machine with idempotent jobs (§28–30, §75–76).** The doc correctly identifies the "worker died mid-provision" problem. Deepened into a full reconciliation design in [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md).
- **Modular monolith first (§26–27).** Correct and rare discipline. Adopted (D-020).
- **V1 scope and explicit exclusions (§81–82).** The NOT-list (no edge functions, no K8s abstraction, no AI, no vectors) is the most valuable list in the document.
- **The first milestone framing (§122): "create a project and receive a secure PostgreSQL backend" — not "build Supabase."** This is the corpus's Milestone 0 ([milestone-0](../14-roadmap/04-milestone-0.md)).
- **Risk ranking instinct (§115–116):** tenant isolation, reliability, backups, provisioning, cost — not React — are the risks. Correct; re-ranked slightly in the [risk register](../15-risks/01-risk-register.md) (cost economics moves up to #2).
- **The cross-tenant security test as a continuously-running suite (§74).** Adopted and expanded into a whole doc ([tenant isolation tests](../06-security/03-tenant-isolation-tests.md)).
- **Restore-to-new-database, never overwrite (§36).** Correct; industry standard for good reason.

---

## 2. Where the proposal is naive

### 2.1 The economics of database-per-project are never computed (§10, §52) — **the biggest gap**

The doc recommends DB-per-project isolation and a free tier "designed for developers to actually build something," then defers the numbers to "after infrastructure cost modeling." But the isolation model and the free tier are *the same decision*: a dedicated Postgres instance has a hard memory floor (~150–400 MB RSS with shared_buffers, per-connection overhead, and the pooler). A thousand free projects that are 95% idle would burn hundreds of GB of RAM doing nothing.

This is precisely why Supabase pauses inactive free projects, why Neon built storage/compute separation for scale-to-zero, and why Turso bet on SQLite's near-zero idle cost. The doc mentions none of this.

**Correction:** idle-project **pause/resume is a day-one architectural requirement** (D-008), and a first-pass cost model with real numbers is mandatory before pricing ([cost model](../12-business/01-cost-model.md)). Density math (projects per node) drives node sizing in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md).

### 2.2 "Automatically expose tables as an API" hides an entire product (§14–15, §86)

Four HTTP verbs are listed as if the API layer were a phase-3 sprint. The real surface: a filtering grammar (`?id=eq.<id>` implies operators — eq, neq, gt, in, like, is, fts...), ordering, pagination with counts, resource embedding across foreign keys, upserts, bulk operations, RPC to database functions, schema reloading on DDL, prepared-statement handling through a pooler, and a security model where the API must impersonate database roles safely. PostgREST has spent ~10 years on these edge cases.

**Correction:** **embed PostgREST per project rather than building the query layer** (D-011, analysis in [rest-api-design](../04-data-api/01-rest-api-design.md)). Corebase's engineering goes into the *gateway* around it (project resolution, key validation, rate limits) — the part that is genuinely Corebase-specific.

### 2.3 Auth is also an entire product (§16–18, §87)

"signup, login, logout, refresh, verify email, reset password" reads like a week of work. Missing from the doc: refresh-token rotation **with reuse detection** (the difference between a token-theft incident and a breach), session revocation semantics, JWKS publication and signing-key rotation, timing-safe credential checks, enumeration resistance on signup/reset endpoints, rate limiting per identifier, and — entirely absent from the proposal — **email delivery infrastructure** (§ nothing): verification and reset emails require deliverability, templates, bounce handling, and abuse controls. Auth is the subsystem where a bug is a headline.

**Correction:** auth gets five docs ([05-auth/](../05-auth/01-auth-architecture.md)), including one dedicated to [email infrastructure](../05-auth/04-email-infrastructure.md). The build-vs-adopt decision is made explicitly (D-013).

### 2.4 Realtime's operational hazard is treated as a checkbox (§23, §93)

"WAL → decoder → broker → WebSockets" is the easy 20%. The hard 80%: a logical replication slot **pins WAL on the primary** — if the consumer stalls, WAL accumulates until the *customer's database disk fills and the primary goes down*. Slot management, backpressure, snapshot semantics on subscribe, and channel authorization are where realtime systems actually live or die. The doc's only nod is "only after the database/API system is stable" — right instinct, unexamined mechanism.

**Correction:** realtime is **deferred past V1 entirely** (D-030); broadcast/presence (no WAL involvement) ship first when it comes. Hazards documented in [realtime architecture](../08-realtime/01-realtime-architecture.md).

### 2.5 PgBouncer is named without its sharp edges (§12, §96)

Transaction-mode pooling (required for real multiplexing) breaks session state: prepared statements, `SET`, advisory locks, `LISTEN/NOTIFY`. Since RLS context is per-request `SET LOCAL`, the pooler mode and the RLS design are *coupled* — a fact the doc never connects. Also unaddressed: how the pooler authenticates users without storing plaintext credentials (auth_query), and per-project pooler placement.

**Correction:** [connection pooling](../03-database-platform/02-connection-pooling.md) specifies transaction mode + `SET LOCAL`-based context injection, and the constraint propagates into [RLS design](../06-security/02-rls-design.md) and [request pipeline](../04-data-api/02-request-pipeline.md).

### 2.6 Phase ordering has a security bug (§83, §86, §89)

The proposal ships the Database API in Phase 3, Auth in Phase 4, and **RLS in Phase 6**. An auto-generated API without RLS is either (a) wide open, or (b) gated by an interim authorization layer that gets thrown away two phases later. Both are wrong: the API's security model *is* JWT→role→RLS; they are one system and must ship together.

**Correction:** the [phase plan](../14-roadmap/01-phase-plan.md) reorders: Auth core (tokens) → Data API **with RLS from the first request**. There is never a moment where a Corebase API serves table data without policies.

### 2.7 The multi-tenancy section contradicts itself mildly (§10)

"Database per project" is recommended, then immediately softened to "PostgreSQL Instance A/B/C/D on a shared Infrastructure Node." Instance-per-project and database-per-project-in-shared-instance have very different isolation and cost profiles, and the doc doesn't pick one.

**Correction:** **container-per-project** (one Postgres instance in one cgroup-limited container per project) on shared nodes (D-009). Full analysis of the three-way tradeoff in [multi-tenancy and isolation](../01-architecture/03-multi-tenancy-and-isolation.md).

---

## 3. What is missing entirely

| Missing topic | Why it matters | Where the corpus adds it |
|---|---|---|
| **Email infrastructure** | Auth cannot ship without deliverable email; abuse (spam via reset emails) is immediate | [05-auth/04](../05-auth/04-email-infrastructure.md) |
| **TLS for per-project subdomains** | `<project>.corebase.co` needs wildcard certs + SNI routing; never mentioned | [01-architecture/04](../01-architecture/04-domain-and-region-model.md) |
| **Postgres major-version upgrades** | Fleet-wide upgrades across thousands of DBs is a hard, recurring operation | [03-database-platform/06](../03-database-platform/06-extensions-and-upgrades.md) |
| **Disk-full / resource-exhaustion handling** | A customer DB filling its disk is a *when*, not an *if*; also the realtime WAL hazard | [03-database-platform/01](../03-database-platform/01-postgres-provisioning.md), [15-risks/01](../15-risks/01-risk-register.md) |
| **SQL-level isolation escapes** | RLS tests check the API path; `COPY TO PROGRAM`, untrusted extensions, `dblink`, file FDWs are DB-level escapes on shared nodes | [06-security/01](../06-security/01-threat-model.md) |
| **Licensing analysis for the OSS core** | "Open source friendly" without a license position invites a strategic mistake (see every relicensing drama 2018–2024) | [12-business/04](../12-business/04-open-source-strategy.md) |
| **Support burden & operations headcount** | §117's three-person team must also answer tickets and carry a pager | [15-risks/01](../15-risks/01-risk-register.md) |
| **Restore testing** | §92 says "test actual recovery" in three words; untested backups are fiction | [03-database-platform/05](../03-database-platform/05-backups-and-pitr.md) |
| **Data-plane egress cost** | Bandwidth is a classic BaaS margin killer; R2-style zero-egress storage changes the math | [12-business/01](../12-business/01-cost-model.md) |

---

## 4. Contradiction ledger (resolved in the decision log)

| # | Contradiction | Resolution |
|---|---|---|
| C-1 | "Portability first" (§3.4) vs a proprietary auth/user schema and platform-specific RLS helpers (`auth.uid()`) | Portability = *exportability with documented mappings*, not schema-neutrality. `corebase export` ships in V1 (D-004); helper functions documented as plain SQL any Postgres can run. |
| C-2 | "Open source core" as a principle (§3.3) vs total absence from V1 scope (§81) and no license position (§113) | OSS is a *strategy with a trigger condition*, not a V1 deliverable: code structured for later opening; license analysis done now (D-034); public release deferred until the platform stabilizes. |
| C-3 | "Avoid building a massive gateway" (§25) vs the gateway's own requirement list (routing, TLS, rate limiting, auth, project resolution, versioning, request IDs, logging) | The *edge* concerns (TLS, DDoS, some routing) go to Cloudflare + Caddy; only project resolution/key validation/rate limiting is custom code (D-016). "Don't build a gateway" really means "don't build Envoy." |
| C-4 | "Database per project" (§10) vs "instances on a shared node" (same section) | Container-per-project on shared nodes (D-009) — dedicated *instance*, shared *hardware*, cgroup-enforced boundaries. |
| C-5 | RLS in Phase 6 vs API in Phase 3 (§83) | Phases reordered; API and RLS ship together (D-036). |
| C-6 | "Free tier designed for developers to actually build something" (§52) vs unexamined DB-per-project idle cost | Pause/resume from day one (D-008) + computed free-tier quotas from the [cost model](../12-business/01-cost-model.md). |

---

## 5. Section-by-section disposition map (§1–124 → corpus)

Legend: ✅ adopted as-is · 🔧 adopted with corrections · ➕ expanded substantially · ❌ rejected/deferred

| Proposal §§ | Topic | Disposition | Corpus location |
|---|---|---|---|
| 1–5 | Vision, philosophy, users, positioning | ✅➕ | [00-foundation/01](01-vision-and-principles.md), [02](02-competitive-analysis.md) |
| 6–8 | High-level architecture, control/data plane | ✅➕ | [01-architecture/01–02](../01-architecture/01-system-architecture.md) |
| 9–10 | Multi-tenancy, DB isolation | 🔧 (C-4) | [01-architecture/03](../01-architecture/03-multi-tenancy-and-isolation.md) |
| 11–13 | Postgres layer, pooling, credentials | 🔧 (§2.5) | [03-database-platform/01–03](../03-database-platform/01-postgres-provisioning.md) |
| 14–15 | REST API | 🔧 (§2.2) | [04-data-api/01–02](../04-data-api/01-rest-api-design.md) |
| 16–18 | Auth, JWT | 🔧➕ (§2.3) | [05-auth/*](../05-auth/01-auth-architecture.md) |
| 19–20 | RLS, tenant security | ✅➕ | [06-security/02](../06-security/02-rls-design.md), [01](../06-security/01-threat-model.md) |
| 21–22 | Storage | ✅➕ | [07-storage/*](../07-storage/01-storage-architecture.md) |
| 23–24 | Realtime | 🔧 deferred (§2.4) | [08-realtime/*](../08-realtime/01-realtime-architecture.md) |
| 25 | API gateway | 🔧 (C-3) | [01-architecture/01](../01-architecture/01-system-architecture.md), [04-data-api/02](../04-data-api/02-request-pipeline.md) |
| 26–27 | Service layout, modular monolith | ✅ | [01-architecture/05](../01-architecture/05-repo-and-service-layout.md) |
| 28–30 | Provisioning, state machine, queue | ✅➕ | [02-control-plane/03–04](../02-control-plane/03-provisioning-state-machine.md) |
| 31–33 | Infra abstraction, deployment phases | ✅ | [11-infrastructure/01](../11-infrastructure/01-infra-phases.md) |
| 34–36 | Backups, retention, restore | ✅➕ | [03-database-platform/05](../03-database-platform/05-backups-and-pitr.md) |
| 37–38 | Observability, logging | ✅ | [11-infrastructure/03](../11-infrastructure/03-observability.md) |
| 39–42 | Dashboard, table editor, SQL editor | ✅ | [09-dashboard/*](../09-dashboard/01-dashboard-ia.md) |
| 43–46 | Migrations, local dev, CLI, SDK | ✅➕ | [03-database-platform/04](../03-database-platform/04-migrations.md), [10-cli-and-sdk/*](../10-cli-and-sdk/01-cli-spec.md) |
| 47–48 | API keys, secrets | ✅ | [04-data-api/03](../04-data-api/03-api-keys-and-roles.md), [03-database-platform/03](../03-database-platform/03-credentials-and-secrets.md) |
| 49–53 | Rate limiting, abuse, billing, metering | ✅➕ | [06-security/04](../06-security/04-platform-security.md), [12-business/02–03](../12-business/02-pricing-and-plans.md) |
| 54–59 | Control-plane schema, audit | ✅➕ | [02-control-plane/01](../02-control-plane/01-data-model.md), [05](../02-control-plane/05-audit-and-admin-access.md) |
| 60–63 | API versioning, domains, regions | ✅➕ (TLS gap) | [13-quality/02](../13-quality/02-release-and-versioning.md), [01-architecture/04](../01-architecture/04-domain-and-region-model.md) |
| 64 | Disaster recovery | ✅ deferred detail | [11-infrastructure/04](../11-infrastructure/04-disaster-recovery.md) |
| 65–68 | Security architecture, admin access, encryption, SLA | ✅➕ | [06-security/04](../06-security/04-platform-security.md), [02-control-plane/05](../02-control-plane/05-audit-and-admin-access.md) |
| 69–72 | Health checks, internal comms, IaC, CI/CD | ✅ | [11-infrastructure/02–03](../11-infrastructure/02-iac-and-cicd.md) |
| 73–74 | Testing, critical security test | ✅➕ | [13-quality/01](../13-quality/01-testing-strategy.md), [06-security/03](../06-security/03-tenant-isolation-tests.md) |
| 75–78 | Idempotency, deletion, retention | ✅➕ | [02-control-plane/03](../02-control-plane/03-provisioning-state-machine.md) |
| 79–82 | DX, first five minutes, V1 scope | ✅ | [14-roadmap/02](../14-roadmap/02-v1-scope-and-cutlist.md) |
| 83–93 | Phase plan 1–10 | 🔧 (C-5) | [14-roadmap/01](../14-roadmap/01-phase-plan.md) |
| 94–101 | Tech stack picks | 🔧 locked | [05-decision-log.md](05-decision-log.md) D-010…D-019 |
| 102–103 | Monorepo | ✅ | [01-architecture/05](../01-architecture/05-repo-and-service-layout.md) |
| 104–108 | API naming, errors, request IDs, docs | ✅ | [02-control-plane/02](../02-control-plane/02-platform-api.md), [13-quality/02](../13-quality/02-release-and-versioning.md) |
| 109–114 | Roadmap, platform vision, business model, OSS, moat | 🔧➕ | [14-roadmap/03](../14-roadmap/03-post-v1-roadmap.md), [12-business/*](../12-business/01-cost-model.md) |
| 115–119 | Risks, team, budget, MVP criteria | ✅➕ re-ranked | [15-risks/01](../15-risks/01-risk-register.md), [14-roadmap/01](../14-roadmap/01-phase-plan.md) |
| 120–124 | Final architecture, first milestone, north star | ✅ | [01-architecture/01](../01-architecture/01-system-architecture.md), [14-roadmap/04](../14-roadmap/04-milestone-0.md) |

## Decisions

This doc *generates* corrections that are formalized elsewhere; its own standing decisions:

- **D-040 — The v0.1 proposal is superseded by this corpus.** Where they disagree, the corpus (and the decision log) wins. The proposal remains the vision reference.

## Open Questions

- None owned here; the gaps identified above are tracked in their target docs and in [open questions](../15-risks/02-open-questions.md).

## Dependencies

- Builds on: [01-vision-and-principles.md](01-vision-and-principles.md), [02-competitive-analysis.md](02-competitive-analysis.md)
- Feeds: every section of the corpus (dispositions above are the routing table).
