# Corebase Planning Corpus — Index

The complete A-to-Z plan for Corebase. Every doc follows the template **Purpose → Design → Decisions → Open Questions → Dependencies**; all binding decisions live in the [decision log](00-foundation/05-decision-log.md).

## Recommended reading order

**First pass (strategy & shape):** 00-foundation (all) → 01-architecture/01–03 → 14-roadmap/01–02 → 15-risks/01
**Second pass (the systems):** 02 → 03 → 04 → 05 → 06 → 07
**Third pass (the rest):** 08 → 09 → 10 → 11 → 12 → 13 → 14-roadmap/03–04 → 15-risks/02

## 00 — Foundation

| Doc | Contents |
|---|---|
| [01 Vision & principles](00-foundation/01-vision-and-principles.md) | What Corebase is, the five principles, non-goals, the binding priority stack |
| [02 Competitive analysis](00-foundation/02-competitive-analysis.md) | The field, exploitable lanes, moat honesty |
| [03 Critical review](00-foundation/03-critical-review.md) | Section-by-section critique of the v0.1 proposal; contradiction ledger; §1–124 disposition map |
| [04 Glossary](00-foundation/04-glossary.md) | Shared vocabulary |
| [05 Decision log](00-foundation/05-decision-log.md) | **All binding decisions (D-001…)** |

## 01 — Architecture

| Doc | Contents |
|---|---|
| [01 System architecture](01-architecture/01-system-architecture.md) | Full system diagram, request lifecycles, service boundaries |
| [02 Control vs data plane](01-architecture/02-control-vs-data-plane.md) | The split, reconciliation loops, failure domains |
| [03 Multi-tenancy & isolation](01-architecture/03-multi-tenancy-and-isolation.md) | Org→project model, container-per-project decision, density math |
| [04 Domain & region model](01-architecture/04-domain-and-region-model.md) | Subdomains, wildcard TLS, SNI routing, region model |
| [05 Repo & service layout](01-architecture/05-repo-and-service-layout.md) | Monorepo scaffold, modular-monolith boundaries, split triggers |

## 02 — Control plane

| Doc | Contents |
|---|---|
| [01 Data model](02-control-plane/01-data-model.md) | Full control-plane schema (DDL): users, orgs, projects, keys, jobs, audit |
| [02 Platform API](02-control-plane/02-platform-api.md) | `/v1` REST contract, error envelope, request IDs, pagination |
| [03 Provisioning state machine](02-control-plane/03-provisioning-state-machine.md) | Project lifecycle states, sagas, idempotency, deletion pipeline |
| [04 Job queue & workers](02-control-plane/04-job-queue-and-workers.md) | BullMQ design, idempotency keys, crash recovery, dead letters |
| [05 Audit & admin access](02-control-plane/05-audit-and-admin-access.md) | Audit events, JIT operator access, break-glass |

## 03 — Database platform

| Doc | Contents |
|---|---|
| [01 Postgres provisioning](03-database-platform/01-postgres-provisioning.md) | Container-per-project, sizing, density, pause/resume, disk-full handling |
| [02 Connection pooling](03-database-platform/02-connection-pooling.md) | PgBouncer transaction mode, prepared-statement problem, auth passthrough |
| [03 Credentials & secrets](03-database-platform/03-credentials-and-secrets.md) | Credential types, envelope encryption, rotation |
| [04 Migrations](03-database-platform/04-migrations.md) | Migration format, push/pull/reset semantics, shadow DB |
| [05 Backups & PITR](03-database-platform/05-backups-and-pitr.md) | pgBackRest, WAL archiving, restore-to-new, automated restore testing |
| [06 Extensions & upgrades](03-database-platform/06-extensions-and-upgrades.md) | Curated extension allowlist (threat model), major-version upgrades |

## 04 — Data API

| Doc | Contents |
|---|---|
| [01 REST API design](04-data-api/01-rest-api-design.md) | Embed-PostgREST decision, filter/embed grammar, pagination, RPC |
| [02 Request pipeline](04-data-api/02-request-pipeline.md) | Gateway → project resolution → authn → role → RLS → SQL |
| [03 API keys & roles](04-data-api/03-api-keys-and-roles.md) | anon / authenticated / service_role model, key rotation |

## 05 — Auth

| Doc | Contents |
|---|---|
| [01 Auth architecture](05-auth/01-auth-architecture.md) | Build-vs-adopt decision, service design, user schema |
| [02 Sessions & tokens](05-auth/02-sessions-and-tokens.md) | ES256 JWTs, JWKS, refresh rotation + reuse detection, revocation |
| [03 Flows](05-auth/03-flows.md) | Signup/login/logout/verify/reset, sequence by sequence |
| [04 Email infrastructure](05-auth/04-email-infrastructure.md) | Deliverability, templates, rate limits, abuse |
| [05 OAuth & future](05-auth/05-oauth-and-future.md) | OAuth providers, magic links, MFA, passkeys, SSO/SAML roadmap |

## 06 — Security

| Doc | Contents |
|---|---|
| [01 Threat model](06-security/01-threat-model.md) | Tenant-isolation threats incl. SQL-level escapes, gateway threats, key leakage |
| [02 RLS design](06-security/02-rls-design.md) | JWT→session context→policies, policy patterns, RLS performance |
| [03 Tenant isolation tests](06-security/03-tenant-isolation-tests.md) | The continuously-running cross-tenant suite, concrete cases |
| [04 Platform security](06-security/04-platform-security.md) | TLS, encryption at rest, least privilege, rate-limit tiers |

## 07 — Storage

| Doc | Contents |
|---|---|
| [01 Storage architecture](07-storage/01-storage-architecture.md) | Metadata-in-PG + objects-in-S3, buckets, R2/MinIO |
| [02 Storage API & policies](07-storage/02-storage-api-and-policies.md) | Upload/download/signed URLs/multipart, RLS on objects, orphan consistency |

## 08 — Realtime (post-V1)

| Doc | Contents |
|---|---|
| [01 Realtime architecture](08-realtime/01-realtime-architecture.md) | WAL→decoder→broker→WebSocket, slot hazards & kill switches |
| [02 Channels, broadcast, presence](08-realtime/02-channels-broadcast-presence.md) | Channel auth, broadcast/presence (ship first) |

## 09 — Dashboard

| Doc | Contents |
|---|---|
| [01 Dashboard IA](09-dashboard/01-dashboard-ia.md) | Information architecture, nav, stack |
| [02 Table editor](09-dashboard/02-table-editor.md) | UI ops → SQL/migrations, RLS policy editor |
| [03 SQL editor](09-dashboard/03-sql-editor.md) | Editor requirements, history, explain, safety rails |
| [04 Design system](09-dashboard/04-design-system.md) | Colour/type/shape tokens, light + dark themes, component inventory and variants |

## 10 — CLI & SDK

| Doc | Contents |
|---|---|
| [01 CLI spec](10-cli-and-sdk/01-cli-spec.md) | Full command surface, auth/link model, config files |
| [02 Local development](10-cli-and-sdk/02-local-development.md) | `corebase dev` Docker Compose stack, local↔remote parity |
| [03 SDK spec](10-cli-and-sdk/03-sdk-spec.md) | `@corebase/core` API surface |

## 11 — Infrastructure

| Doc | Contents |
|---|---|
| [01 Infra phases](11-infrastructure/01-infra-phases.md) | VMs+Docker → orchestration → K8s-where-it-pays; provider abstraction |
| [02 IaC & CI/CD](11-infrastructure/02-iac-and-cicd.md) | Terraform layout, pipelines, environments |
| [03 Observability](11-infrastructure/03-observability.md) | OTel/Prometheus/Grafana/Loki, per-project logs/metrics, health checks |
| [04 Disaster recovery](11-infrastructure/04-disaster-recovery.md) | Replicas, cross-region backups, runbooks |

## 12 — Business

| Doc | Contents |
|---|---|
| [01 Cost model](12-business/01-cost-model.md) | Real $ math: RAM/instance, projects/node, free-tier burn |
| [02 Pricing & plans](12-business/02-pricing-and-plans.md) | Free/Pro/Team/Enterprise, quotas, metering architecture |
| [03 Abuse prevention](12-business/03-abuse-prevention.md) | Quotas, verification, detection, billing protections |
| [04 Open-source strategy](12-business/04-open-source-strategy.md) | OSS/cloud split, licensing analysis, timing triggers |

## 13 — Quality

| Doc | Contents |
|---|---|
| [01 Testing strategy](13-quality/01-testing-strategy.md) | Unit/integration/e2e layers, golden-path e2e |
| [02 Release & versioning](13-quality/02-release-and-versioning.md) | API versioning policy, breaking changes, deprecation |

## 14 — Roadmap

| Doc | Contents |
|---|---|
| [01 Phase plan](14-roadmap/01-phase-plan.md) | **All phases in executable detail** — scope, tasks, exit criteria, demoable flow each |
| [02 V1 scope & cut list](14-roadmap/02-v1-scope-and-cutlist.md) | V1 in/out, explicit cuts with reasons, MVP success criteria |
| [03 Post-V1 roadmap](14-roadmap/03-post-v1-roadmap.md) | V1.1 → V3: OAuth, realtime, functions, multi-region, enterprise |
| [04 Milestone 0](14-roadmap/04-milestone-0.md) | The very first milestone, task-by-task, ready to execute |

## 15 — Risks

| Doc | Contents |
|---|---|
| [01 Risk register](15-risks/01-risk-register.md) | Top risks ranked with likelihood/impact/mitigation |
| [02 Open questions](15-risks/02-open-questions.md) | Everything deliberately unresolved (OQ-xxx) |
