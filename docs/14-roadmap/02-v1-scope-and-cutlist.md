# V1 Scope & Cut List

## Purpose

The binding definition of what V1 *is* and — more importantly — what it is *not*. Scope creep is the proposal's own declared biggest business risk (§116); this doc is the instrument that resists it. Anything not in the IN table requires a decision-log change to enter V1.

## Design

### V1 IN

| Area | Included | Owning doc |
|---|---|---|
| Control plane | Accounts, orgs (owner/admin/member), projects + full lifecycle incl. pause/resume + soft delete, API keys, secrets, audit log, `/v1` API | [02-control-plane](../02-control-plane/01-data-model.md) |
| Database | Postgres 17 container-per-project, PgBouncer pooled + direct URLs, credential rotation, disk quotas, curated extensions | [03-database-platform](../03-database-platform/01-postgres-provisioning.md) |
| Backups | pgBackRest nightly + WAL archiving, PITR (plan-gated), restore-to-new, automated restore verification | [03-database-platform/05](../03-database-platform/05-backups-and-pitr.md) |
| Data API | PostgREST-compatible REST (`/rest/v1`), full filter/embed/RPC grammar, anon/service_role keys, gateway rate limiting | [04-data-api](../04-data-api/01-rest-api-design.md) |
| Auth | Email/password, verification, reset, ES256 JWT + JWKS, refresh rotation w/ reuse detection, per-project email caps, templates | [05-auth](../05-auth/01-auth-architecture.md) |
| RLS | Default-deny, `auth.*` helpers, policy editor (templated → SQL), isolation suite | [06-security/02](../06-security/02-rls-design.md) |
| Storage | Buckets (public/private), upload/download/list, signed URLs, RLS policies on objects, quotas | [07-storage](../07-storage/01-storage-architecture.md) |
| Dashboard | Project overview + onboarding, table editor (UI→SQL), SQL editor w/ safety rails, auth users, storage browser, keys, logs, backups/restore | [09-dashboard](../09-dashboard/01-dashboard-ia.md) |
| CLI | login/logout, init, link, status, dev (incl. stop/destroy), db push/pull/reset, migration new, **export**, projects, keys list, secrets, logs, gen types | [10-cli-and-sdk/01](../10-cli-and-sdk/01-cli-spec.md) |
| Local dev | `corebase dev` Docker Compose stack with prod-parity paths | [10-cli-and-sdk/02](../10-cli-and-sdk/02-local-development.md) |
| SDK | `@corebase/core`: database builder, auth, storage, generated types | [10-cli-and-sdk/03](../10-cli-and-sdk/03-sdk-spec.md) |
| Billing | Free/Pro plans live, Stripe, 3 metered dimensions, free-tier hard stops | [12-business/02](../12-business/02-pricing-and-plans.md) |
| Ops | Single region (eu-central), observability stack, alert catalog, status page, DR posture per D-024 | [11-infrastructure](../11-infrastructure/01-infra-phases.md) |

### V1 OUT — the cut list, with reasons

Cuts fall into three classes: **(A)** deferred because the substrate isn't ready, **(B)** deferred because the audience (D-003) doesn't need it yet, **(C)** rejected as off-lane (D-006).

| Cut | Class | Reason | Returns in |
|---|---|---|---|
| Realtime (all of it: CDC, broadcast, presence) | A | Highest operational risk per [critique §2.4](../00-foundation/03-critical-review.md); D-030 | V1.2 ([post-V1](03-post-v1-roadmap.md)) |
| Edge/serverless functions | A | Whole second platform; proposal §82 agrees | V1.3 |
| OAuth social login | B | Email/password proves the auth substrate; OAuth is additive | V1.1 |
| Magic links, MFA, passkeys, SSO/SAML | B | Per [auth roadmap](../05-auth/05-oauth-and-future.md) sequencing | V1.1–V3 |
| `db diff` | B | Shadow-DB diffing is polish; push/pull/reset covers the loop (D-028) | V1.1 |
| Multiple environments per project UI | B | Modeled in schema (D-031), surfaced later; two projects works today | V1.2 |
| Read replicas, HA per project | A | Restore-from-backup is the V1 durability story; HA is a paid-tier V2 feature | V2 |
| Multi-region | A/B | D-024; the region column exists, the fleet doesn't | V3 |
| Custom domains for projects | B | Wildcard subdomains suffice for building; custom domains are a launch-something feature | V1.2 |
| Image transformations | C→B | CPU/abuse surface; storage serves originals | V1.2 |
| Vector/AI features (pgvector is IN as an extension; no vector *product*) | C | Off-lane; the extension satisfies builders | — |
| GraphQL | C | D-007 | — |
| Analytics/log products, CDN product | C | Off-lane per proposal §82 | — |
| Team plan | B | Free+Pro covers the V1 audience; Team needs env-groups anyway | V1.2 |
| Enterprise anything (SSO, private networking, compliance certs) | B | D-003 | V3 |
| Kubernetes | A | D-022; phase-C trigger conditions in [infra phases](../11-infrastructure/01-infra-phases.md) | when triggered |
| Public self-hosting / OSS server release | B | D-034 trigger conditions in [open-source strategy](../12-business/04-open-source-strategy.md) | when triggered |
| Webhooks (database → HTTP) | B | Popular but additive; needs delivery infrastructure done right | V1.2 |
| Scheduled jobs / cron for customers | B | Rides on the functions substrate | V1.3 |

### MVP success criteria (proposal §119, restated as the launch checklist)

All fifteen, automated as the golden-path e2e ([testing strategy](../13-quality/01-testing-strategy.md)):

1. Create account · 2. Create project · 3. Get PostgreSQL (<60s) · 4. Create table · 5. Insert data · 6. Query via REST API · 7. Create auth user · 8. Authenticate · 9. Apply RLS and see it enforced · 10. Upload file · 11. Download file · 12. Use the SDK for 5–11 · 13. Run the stack locally · 14. Push migrations · 15. Restore a backup.

Plus three Corebase-specific additions:

16. **Export the project** and restore it outside Corebase (D-004 proof) · 17. **Pause/resume** transparently (D-008 proof) · 18. Cross-tenant isolation suite green (D-002 proof).

### The scope-change protocol

1. Proposed addition is written up in one paragraph against the three lanes (D-006).
2. It must displace something of equal size from the IN table, or push the launch date explicitly — never silently.
3. The decision lands in the [decision log](../00-foundation/05-decision-log.md) either way, including rejections (rejected-with-reason kills zombie re-proposals).

## Decisions

- **D-163 — The IN/OUT tables above are the binding V1 scope; changes go through the scope-change protocol.** *(Rationale: §116 — scope creep is the top business risk; a protocol beats willpower.)*
- **D-164 — Launch checklist = §119's fifteen criteria + export, pause/resume, and isolation-suite additions (18 total), all automated.** *(Rationale: the three additions are exactly Corebase's declared lanes; launching without proving them means launching without the moat.)*

## Open Questions

- OQ-162: Webhooks keep getting requested early in every BaaS's life — pre-commit to the V1.2 slot or leave floating? (Currently floating.)

## Dependencies

- Builds on: [phase plan](01-phase-plan.md), [vision](../00-foundation/01-vision-and-principles.md), [decision log](../00-foundation/05-decision-log.md)
- Feeds: [post-V1 roadmap](03-post-v1-roadmap.md), [milestone 0](04-milestone-0.md)
