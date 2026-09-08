# Repo & Service Layout

## Purpose

Turn proposal §102–103 into a concrete, V1-trimmed monorepo scaffold under the locked stack (D-010: pnpm + Turborepo, Node 22 + Fastify; D-020: modular monolith plus exactly one separate worker process), define the module boundary rules that keep the monolith modular instead of muddy, and codify the *measurable* triggers under which a module graduates to its own deployable — so future splits are decisions read off a dashboard, not arguments.

## Design

### The monorepo (proposal §102, trimmed to what V1 ships)

```text
steadhold/
├── apps/
│   ├── dashboard/               # Next.js + Tailwind + shadcn/ui (D-025); talks only to api.steadhold.dev
│   └── docs/                    # docs site (first-class product, proposal §107); content + framework
├── services/
│   ├── api/                     # THE modular monolith (Node 22 + Fastify, D-010) — one deployable
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── control-plane/   # orgs/projects/keys/billing endpoints (/v1), desired-state writes
│   │       │   ├── auth/            # end-user auth service (D-013): /auth/v1 flows, token issuance
│   │       │   ├── storage-api/     # /storage/v1: metadata-in-PG + R2 streaming (D-017)
│   │       │   └── gateway/         # data-plane front door: ref resolution, key validation, rate limits, proxy (D-016)
│   │       ├── kernel/              # shared in-process infra: config load, logging/OTel, error envelope (D-032), Fastify plugins, routing-table store (D-051)
│   │       └── main.ts              # composition root: the ONLY file that imports all modules and wires them
│   └── worker/                  # the ONE separate process from day one (D-020): BullMQ consumers + reconciler (D-053), Docker Engine API client (D-052)
├── packages/
│   ├── sdk/                     # @steadhold/core — public client SDK (proposal §46); Apache-2.0 at release (D-034)
│   ├── config/                  # shared tsconfig/eslint/prettier presets; dependency-cruiser boundary rules (D-059)
│   └── types/                   # shared contracts ONLY: API DTOs (zod schemas), job payloads, routing-table entry type, error codes — no runtime logic
├── cli/                         # `steadhold` CLI (TS, npm-distributed, D-026): init/dev/link/db push|pull|reset/export (D-004, D-028)
├── infra/
│   ├── terraform/               # Hetzner nodes, Cloudflare DNS/TLS, R2 buckets (D-022, D-023)
│   ├── docker/                  # Compose files: per-node data-plane template (project triplet, D-054), app-node stack, `steadhold dev` local stack (D-027)
│   └── monitoring/              # Prometheus rules, Grafana dashboards, Loki config (D-021)
├── migrations/                  # CONTROL-PLANE Postgres migrations (timestamped SQL, same format we sell, D-028); customer-project base schema lives with the provisioner assets in services/worker
├── tests/
│   ├── e2e/                     # golden path: signup → project → table → insert → query (proposal §73)
│   └── isolation/               # the continuously-running cross-tenant suite (proposal §74) — API-level AND SQL-level cases
├── turbo.json                   # pipeline: build/test/lint graphs, remote cache (OQ-058)
├── pnpm-workspace.yaml
└── package.json
```

Deliberately absent vs. proposal §102: `services/auth`, `services/storage`, `services/realtime`, `services/provisioner` as separate services (they are modules or post-V1 — D-020, D-030); `apps/marketing` (Cloudflare Pages, content-only, doesn't need the toolchain); `packages/database`/`packages/auth` (premature abstraction — extract from the monolith when a second consumer exists, not before).

### Module boundary rules (what may import what)

```text
                 apps/dashboard   cli/          services/worker
                       │           │                  │
                       ▼           ▼                  ▼
                    (HTTP only — /v1 API)      packages/types + kernel-free libs
                                                      │
services/api:                                         │
   main.ts ──▶ modules/{control-plane,auth,storage-api,gateway} ──▶ kernel ──▶ packages/*
                       │  cross-module: ONLY via each module's index.ts
                       ▼             (its published interface)
               packages/types
```

| Rule | Statement | Why |
|---|---|---|
| R1 | `packages/*` import nothing from `services/`, `apps/`, or `cli/` — ever | packages are leaves; the SDK must stand alone for its Apache-2.0 release (D-034) |
| R2 | A module imports: its own files, `kernel/`, `packages/*`. Cross-module imports go through the target module's `index.ts` only; deep imports (`modules/auth/src/internal/*` from elsewhere) are build failures | a module with a sealed surface can be lifted into its own service by re-implementing `index.ts` as an HTTP/queue client — the split stays a deploy change |
| R3 | **`gateway` may not import `control-plane`** (even via index). It reads project data exclusively through the kernel's routing-table store interface (D-051) | this compiles the hot-path/control-plane decoupling of [control vs data plane](02-control-vs-data-plane.md) into the dependency graph — the failure-domain promise becomes un-breakable by accident |
| R4 | `control-plane` never imports `auth`/`storage-api`/`gateway`; it signals them only by writing desired state + publishing invalidations | control plane commands the fleet through data, not function calls — same reason as R3, reversed |
| R5 | `services/worker` shares **only** `packages/types` (job payload contracts) and pure libs with `services/api`; no imports from `services/api/src` | the worker deploys independently (D-020); a shared import would couple their release cadence |
| R6 | `apps/*` and `cli/` reach the platform via HTTP (`/v1`) and `packages/sdk|types` — never import server code | dashboard/CLI are API clients like any other; keeps the API honest (proposal §104) |
| R7 | `migrations/` is written in plain timestamped SQL with no TS imports | portability discipline (D-028); the tool we sell is the tool we use |
| Enforcement | `dependency-cruiser` rules live in `packages/config` and run in CI on every PR; violations fail the build (D-059) | boundary rules that aren't enforced are wishes (proposal §103: "avoid everything-imports-everything") |

Inside each module: `index.ts` (public surface), `routes.ts` (Fastify plugin), `service/` (logic), `repo/` (control-plane DB access — only `control-plane` and `auth` have one), `internal/` (unreachable from outside, enforced by R2).

### Process topology in V1

| Deployable | Contents | Restart/deploy semantics |
|---|---|---|
| `services/api` | all four modules in one Node process | continuous deploys; graceful drain behind Caddy; a deploy briefly touches the data-plane path (measured — see trigger T1) |
| `services/worker` | queue consumers + reconciler | deploys independently; jobs resume via idempotency keys (D-018); can be stopped for minutes with zero customer-visible impact (reconciler catches up, D-053) |

Two deployables, exactly (plus per-project data-plane containers managed by the worker, and edge/infra pieces from [system architecture](01-system-architecture.md)). This is the whole point of D-020: different restart semantics → different process; everything else stays together until measurement says otherwise.

### Split triggers (measurable, pre-committed)

A module graduates to its own deployable when its trigger fires — and not before. Each trigger is a dashboard query, not a feeling ([observability](../11-infrastructure/03-observability.md) must make each measurable from day one).

| # | Candidate | Trigger conditions (any one) | Split shape |
|---|---|---|---|
| T1 | **gateway** → `services/gateway` | (a) deploy-correlated data-plane impact: p99 of `/rest/v1/*` degrades >2× or any 5xx burst attributable to monolith deploys, in ≥3 deploys over a month — the data plane is paying for control-plane release cadence; (b) gateway proxy work sustained >50 % of monolith CPU; (c) region #2 is scheduled (each region cell needs a local gateway — [domain & region model](04-domain-and-region-model.md)) | lift module behind its `index.ts`; routing-table store already Redis-fed (D-051), so the new process needs zero new data paths. Gateway is expected to split **first** |
| T2 | **auth** → `services/auth` | (a) token issuance/verify load needs scaling independent of the API (auth CPU >30 % of monolith at peak); (b) security patch cadence conflicts with normal releases (auth-only urgent deploys happening repeatedly); (c) the D-013 revisit trigger fires (CVE-class bug) and the response includes isolation of the auth surface | module already owns its tables and talks to project DBs directly; splits behind the same `/auth/v1` routes at the gateway |
| T3 | **realtime** (post-V1, D-030) | **born separate — never enters the monolith.** WebSocket fleets hold ~100k+ long-lived connections; deploys must drain over minutes not seconds; memory profile is connection-bound not request-bound. Nothing about the monolith's deploy story fits | new `services/realtime` when its phase arrives ([realtime architecture](../08-realtime/01-realtime-architecture.md)) |
| T4 | **storage-api** → `services/storage` | sustained upload/download streaming saturating monolith event loop or NIC (streaming bytes >40 % of process CPU or bandwidth alarms), and OQ-053's presigned-URL escape hatch is insufficient | lowest priority; presigned direct-to-R2 relieves most pressure without a split |
| T5 | **worker** sharding | reconcile-loop lag: full-fleet diff pass exceeding its 60s budget (D-053), or job queue p95 wait >30s at healthy workers | shard workers by cluster/region — a config change, since desired state is already partitioned by node (D-058) |

Anti-trigger, stated once: team discomfort, architectural fashion, or "we might need it" are not triggers. The monolith is a *feature* for a 3-person team (proposal §26–27, §117) — every split adds a deploy pipeline, version skew, an internal auth surface (proposal §70), and an on-call surface.

### Turborepo pipeline sketch

```text
build:  types → config → sdk → {api, worker, cli, dashboard}
test:   unit (per package) → integration (api+worker vs docker-compose PG/Redis)
        → tests/isolation (blocking, on every PR touching services/ or migrations/)
lint:   eslint + dependency-cruiser (R1–R7)  — boundary violations fail here
```

`tests/isolation` runs in CI on every PR **and** continuously against staging/production (proposal §74's "runs continuously" is meant literally): [tenant isolation tests](../06-security/03-tenant-isolation-tests.md), [testing strategy](../13-quality/01-testing-strategy.md).

## Decisions

- **D-059 — Module boundaries R1–R7 are CI-enforced via dependency-cruiser (rules versioned in `packages/config`), and modules may split into separate deployables only when their codified trigger (T1–T5) fires — with the gateway pre-designated as the first split and realtime pre-designated as born-separate.** *(Rationale: a modular monolith stays modular only under mechanical enforcement, and pre-committing measurable split conditions converts future "should we microservice?" debates into dashboard reads — preserving D-020's discipline against both premature splitting and monolith rot; R3/R4 additionally make the plane-decoupling contract of the failure-domain analysis structurally unbreakable.)*

## Open Questions

- **OQ-058** — Turborepo remote cache: self-host the cache server on the monitoring/app node vs. Vercel's hosted cache (external dependency + cost) vs. none until CI times hurt. Owner: [IaC & CI/CD](../11-infrastructure/02-iac-and-cicd.md).
- **OQ-063** — Customer-project **base schema** versioning (the SQL the worker applies at provision: roles, auth schema, storage.objects): how do already-provisioned projects receive base-schema upgrades — reconciler-applied versioned migrations per project, or only-at-provision with explicit fleet migration jobs? Interacts with D-037's upgrade playbook. Owner: [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) + [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md).
- **OQ-064** — Does `apps/docs` ship at V1 launch as a real app or as stub content on `steadhold.dev`? Docs are a "first-class product" (§107) but also real scope; the cut line belongs to [V1 scope & cut list](../14-roadmap/02-v1-scope-and-cutlist.md).

## Dependencies

- Builds on: [01-system-architecture.md](01-system-architecture.md), [02-control-vs-data-plane.md](02-control-vs-data-plane.md) (R3/R4 encode its contract), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-010, D-020, D-025–D-028, D-034)
- Feeds: [../02-control-plane/02-platform-api.md](../02-control-plane/02-platform-api.md), [../02-control-plane/04-job-queue-and-workers.md](../02-control-plane/04-job-queue-and-workers.md), [../10-cli-and-sdk/01-cli-spec.md](../10-cli-and-sdk/01-cli-spec.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md), [../11-infrastructure/02-iac-and-cicd.md](../11-infrastructure/02-iac-and-cicd.md), [../13-quality/01-testing-strategy.md](../13-quality/01-testing-strategy.md), [../14-roadmap/04-milestone-0.md](../14-roadmap/04-milestone-0.md)
