# Post-V1 Roadmap

## Purpose

The sequenced plan from V1 launch to the long-term platform (proposal §109–111), with each release themed, dependency-ordered, and gated on signals — not calendar dates. The standing rule from §116/§124 applies: **infrastructure evolves alongside users**; every release below is re-scoped against actual user feedback before it starts.

## Design

### Release themes

```text
V1     "A production backend in five minutes"       (launch)
V1.1   "The gaps users hit in week one"              OAuth, db diff, extensions, CLI polish
V1.2   "The living backend"                          realtime, webhooks, custom domains, Team plan
V1.3   "Compute"                                     functions, cron, queues-lite
V2     "Scale-up"                                    HA/replicas, perf, bigger tenants, self-host beta
V3     "Multi-region & enterprise"                   regions, SSO/SAML, compliance, private networking
```

### V1.1 — the gaps users hit in week one

Trigger to start: V1 launched, first ~2–4 weeks of feedback triaged.

| Item | Notes | Owning doc |
|---|---|---|
| OAuth: Google + GitHub | The single most-requested auth feature everywhere; flow already specced | [oauth & future](../05-auth/05-oauth-and-future.md) |
| Magic links | Rides on existing one-time-token infra | same |
| `corebase db diff` | Shadow-DB diffing (D-028) | [migrations](../03-database-platform/04-migrations.md) |
| Extension allowlist round 2 | Promote the V1.1 candidates: postgis (variant image) and pg_cron (D-078; pgvector already ships in V1) | [extensions](../03-database-platform/06-extensions-and-upgrades.md) |
| Custom SMTP per project | Projects send from their own domain | [email infra](../05-auth/04-email-infrastructure.md) |
| SDK/CLI polish wave | Beta feedback batch; `--json` everywhere; typegen improvements | [cli spec](../10-cli-and-sdk/01-cli-spec.md) |
| Visual EXPLAIN plan tree | SQL editor V1.1 item (saved queries ship in V1, D-134) | [sql editor](../09-dashboard/03-sql-editor.md) |
| ERD/relationship view | Table editor V1.1 item | [table editor](../09-dashboard/02-table-editor.md) |

### V1.2 — the living backend

Trigger: data platform boring (backup/restore/pause metrics green ≥1 quarter), support load under control.

| Item | Notes |
|---|---|
| **Realtime step 1: broadcast + presence** | No WAL involvement — the safe 80% of value ([channels doc](../08-realtime/02-channels-broadcast-presence.md)); realtime service is the first split from the monolith |
| **Realtime step 2: WAL CDC** | Only after step 1 is stable; slot kill-switches mandatory ([realtime architecture](../08-realtime/01-realtime-architecture.md)) |
| Webhooks (DB events → HTTP) | Shares delivery infrastructure thinking with realtime; retry/signing/dead-letter done properly |
| Custom domains | Per-project CNAME + cert automation (this is where per-project certs finally enter) |
| Environments UI | Surface the D-031 project-group model: dev/staging/prod linked projects, promote-migration flow |
| Team plan | Env groups + more members + longer retention ([pricing](../12-business/02-pricing-and-plans.md)) |
| Image transformations | Resize/format on storage, cache-heavy, quota-guarded |
| Anonymous sign-in | Guest → registered conversion |
| MFA/TOTP | Auth item with the `aal` claim — V1.2 per D-119's fixed order |

### V1.3 — compute

Trigger: users demonstrably hacking around the lack of server-side logic (the signal: webhook targets that are just "run my code" shims).

| Item | Notes |
|---|---|
| Functions | Runtime decision deferred until here (Deno/workerd/Firecracker-class — decide with V1.2's operational knowledge; this is a *platform*, budget accordingly) |
| Scheduled jobs / cron | On the functions substrate; pg_cron for in-DB scheduling as the cheap path earlier |
| Queues-lite | Expose a simple queue primitive (pgmq-style in-Postgres first — stays in-lane, zero new infra) |

### V2 — scale-up

Trigger: paying tenants outgrowing single-container Postgres (the good problem).

- **HA option per project**: streaming replica + managed failover as a paid add-on; revisits the container-per-project topology.
- **Compute tiers**: dedicated-node projects (the proposal §10's "Large Project → dedicated database" tier).
- **Performance program**: pooler evolution (pgcat trigger per [pooling](../03-database-platform/02-connection-pooling.md)), gateway hot-path work.
- **Self-host beta**: the D-034 trigger conditions likely met around here — server components open under the chosen license ([open-source strategy](../12-business/04-open-source-strategy.md)).
- **Passkeys/WebAuthn.**

### V3 — multi-region & enterprise

Trigger: revenue justifying it and concrete enterprise deals blocked on these exact items (per D-003: never speculatively).

- Second region + region-aware control plane (schema is ready per D-024/[domain & region model](../01-architecture/04-domain-and-region-model.md)); cross-region DR upgrade from backup-copies to warm standby ([disaster recovery](../11-infrastructure/04-disaster-recovery.md)).
- SSO/SAML/SCIM, audit-log export, private networking, compliance program (SOC 2 starts ~12 months before it's needed — flag early).
- Kubernetes re-evaluation against the Phase-C criteria ([infra phases](../11-infrastructure/01-infra-phases.md)) — still only if triggered.

### What stays permanently out (re-affirmed)

No proprietary data model, no GraphQL (D-007), no analytics/CDN side-products, no feature-race items outside the three lanes (D-006) without a decision-log change.

## Decisions

- **D-165 — Post-V1 releases are gated on the trigger signals above, not dates; each release's scope is re-cut against user feedback before it begins.** *(Rationale: §116 — the biggest business risk is building ahead of users.)*
- **D-166 — Realtime ships in two steps (broadcast/presence, then CDC) and is the first service split from the monolith.** *(Rationale: D-030's risk ordering; WebSocket fleets scale differently than request/response.)*
- **D-167 — The functions runtime decision is explicitly deferred to V1.3 planning.** *(Rationale: it's a platform-sized bet; deciding it now with zero operational data would be theater.)*

## Open Questions

- OQ-163: pg_cron / pgmq as early in-Postgres compute primitives before V1.3 — cheap wins or scope creep? Evaluate at V1.1.
- OQ-164: When SOC 2 prep starts (V2 vs V3 boundary) — depends on the first enterprise-shaped deal.

## Dependencies

- Builds on: [phase plan](01-phase-plan.md), [v1 scope](02-v1-scope-and-cutlist.md), every subsystem's own "future" sections.
- Feeds: [risk register](../15-risks/01-risk-register.md).
