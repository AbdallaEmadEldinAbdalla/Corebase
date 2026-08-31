# Corebase

**The backend foundation for modern applications.**

Corebase is a developer-focused Backend-as-a-Service: a developer creates a project and receives a production-ready backend — PostgreSQL, auto-generated APIs, authentication, row-level security, object storage, and (later) realtime — in minutes, without assembling infrastructure themselves.

> One command to get a production backend: `corebase create my-app`

## Status

**Building Milestone 0 — the provisioning spine.** `POST /v1/projects` returns a real, isolated PostgreSQL 17.5 database on a data node about **2.5 seconds** later, with its own volume, cgroup limits, the full role model, envelope-encrypted credentials, and a connection string you can `psql` into immediately. Twenty consecutive creates are measured end to end.

The worker has also been SIGKILLed at eleven points in that saga to prove it resumes with no duplicate containers, volumes, credentials or capacity bookings.

Deleting a project keeps its data for a 7-day recovery window and then a scheduled purge destroys it and returns the capacity; twenty create+delete cycles leave nothing behind on the node or in the control plane.

Reboot the data node and every project is serving queries again seconds later with no human involved; whatever the control plane and the node disagree about is reported, and anything holding data is reported *without* being touched.

All of it is visible: Prometheus scrapes both services, Grafana has a provisioned dashboard, logs are in Loki and findable by project ref or request id, and the "job stuck" alert has been watched firing.

**All ten Milestone-0 tasks are done.** What remains is the milestone retro (D-169): reconciling the cost model and the density figures with the six measurements the build produced. Nothing above the database exists yet — no data API, no auth, no storage, no dashboard.

> **[STATUS.md](STATUS.md) is the handover document**: what works, how to run it locally, what every rule in the code is defending against, and what is not built yet. Read it before the corpus if you are here to contribute.

## Run it

```bash
pnpm install
./scripts/staging.sh up && ./scripts/migrate-staging.sh && ./scripts/staging.sh kek
docker build -t corebase/postgres:17.5 infra/docker/postgres
./scripts/staging.sh seed-images && ./scripts/staging.sh verify
```

Then start the services and watch the whole thing work in about five seconds:

```bash
./scripts/dev.sh
```

```bash
./scripts/demo.sh
```

It creates a project, waits for it, connects to the database it made with the credentials the API handed back, runs real SQL, and deletes it — using only `curl` and `psql`, which is exactly what a customer has.

The full suite is 198 tests, integration included; they need the staging stack above and **fail rather than skip** without it:

```bash
pnpm test
```

Or measure provisioning end to end — twenty creates, each proven usable by connecting to it:

```bash
pnpm --filter @corebase/worker bench
```

Or kill the worker at eleven points mid-provision and watch every one converge:

```bash
pnpm --filter @corebase/worker kill-matrix
```

Or run twenty full create-use-delete-purge cycles and check nothing is left behind:

```bash
pnpm --filter @corebase/worker lifecycle
```

Or reboot the data node and watch it converge on its own:

```bash
pnpm --filter @corebase/worker node-reboot
```

To watch it work, `./scripts/dev.sh` starts both services with the right environment and ships their logs to Loki; Grafana is then at <http://127.0.0.1:3001/d/corebase-provisioning>.

Staging is Docker Compose plus Docker-in-Docker standing in for a control node and a data node. The interface the worker drives is the real one — the Docker Engine API over mutual TLS, no per-node agent (D-052) — so no step of the plan is skipped and nothing is paid for. [STATUS.md §2](STATUS.md) has the details and the environment variables.

## What is built

| | |
|---|---|
| `services/api` | Fastify control-plane API: `/v1/projects` CRUD, error envelope with `request_id`, idempotency keys, two-phase enqueue |
| `services/worker` | Provisioning worker: job runner with checkpoints, transactional placement, Docker Engine API client over mTLS, the eight-step provisioning saga |
| `packages/crypto` | Envelope encryption — per-secret data key wrapped by a master key that never enters the database |
| `packages/secrets` | Credential persistence; enforces store-then-apply so a crash cannot lose a password |
| `packages/queue` `packages/migrate` `packages/types` | BullMQ wiring, the SQL migration runner, shared types |
| `infra/docker/postgres` | The per-project database image: extension allowlist enforced by absence, no `trust` auth anywhere, RLS on at table creation |
| `infra/docker/staging` | The local stand-in for staging, including Prometheus, Loki, Alloy and Grafana with the dashboard provisioned as code |
| `packages/metrics` | A Prometheus registry — counters, gauges, histograms, with label sets declared up front so the cardinality budget is hard to break |

## The planning corpus

## The planning corpus

Everything lives under [docs/](docs/INDEX.md). Start there — [docs/INDEX.md](docs/INDEX.md) gives the full map and a recommended reading order.

The corpus covers, A to Z:

| Section | What it plans |
|---|---|
| [00-foundation](docs/00-foundation/01-vision-and-principles.md) | Vision, principles, competitive analysis, critical review of the original proposal, glossary, decision log |
| [01-architecture](docs/01-architecture/01-system-architecture.md) | System architecture, control/data plane split, multi-tenancy, domains/regions, repo layout |
| [02-control-plane](docs/02-control-plane/01-data-model.md) | Control-plane data model, platform API, provisioning state machine, job queue, audit |
| [03-database-platform](docs/03-database-platform/01-postgres-provisioning.md) | Postgres provisioning, pooling, credentials, migrations, backups/PITR, extensions & upgrades |
| [04-data-api](docs/04-data-api/01-rest-api-design.md) | Auto-generated REST API, request pipeline, API keys & roles |
| [05-auth](docs/05-auth/01-auth-architecture.md) | Auth architecture, sessions & tokens, flows, email infrastructure, OAuth roadmap |
| [06-security](docs/06-security/01-threat-model.md) | Threat model, RLS design, tenant-isolation test suite, platform security |
| [07-storage](docs/07-storage/01-storage-architecture.md) | Object storage architecture, API and access policies |
| [08-realtime](docs/08-realtime/01-realtime-architecture.md) | Realtime architecture (post-V1), channels/broadcast/presence |
| [09-dashboard](docs/09-dashboard/01-dashboard-ia.md) | Dashboard IA, table editor, SQL editor, [design system](docs/09-dashboard/04-design-system.md) |
| [10-cli-and-sdk](docs/10-cli-and-sdk/01-cli-spec.md) | CLI spec, local development, SDK spec |
| [11-infrastructure](docs/11-infrastructure/01-infra-phases.md) | Infra phases, IaC & CI/CD, observability, disaster recovery |
| [12-business](docs/12-business/01-cost-model.md) | Cost model, pricing & plans, abuse prevention, open-source strategy |
| [13-quality](docs/13-quality/01-testing-strategy.md) | Testing strategy, release & versioning policy |
| [14-roadmap](docs/14-roadmap/01-phase-plan.md) | Full phase plan, V1 scope & cut list, post-V1 roadmap, Milestone 0 |
| [15-risks](docs/15-risks/01-risk-register.md) | Risk register, open questions |

## Two registers keep the corpus honest

- **[Decision log](docs/00-foundation/05-decision-log.md)** — every binding decision (D-001…D-192) with its rationale. If two documents disagree, this log wins. Overturned decisions are annotated, never deleted, so the reasoning stays auditable — D-083's FORCE-RLS half, for instance, is annotated as superseded by D-191, which the build discovered by breaking a customer's first `INSERT`.
- **[Open questions](docs/15-risks/02-open-questions.md)** — 140 questions left deliberately unresolved, each with an owning document and a decide-by trigger.
- **[Measurement log](docs/14-roadmap/05-measurements.md)** — every number the plan assumed and the build later measured, append-only. The drift between assumption and reality is the finding.

## The design system

Accent is **Electric Violet** — `#7C3AED` light, `#8B5CF6` dark — on cool violet-tinted neutrals. It was chosen over coral, emerald, deep forest and cyan for two reasons that outlived taste: it is the only candidate where white text clears AA contrast on the accent in *both* themes, and it collides with no semantic colour. In a product whose scariest button is *Delete project*, the brand hue must never be confusable with the error hue.

The written spec is [docs/09-dashboard/04-design-system.md](docs/09-dashboard/04-design-system.md). The artefacts are under [design-exports/](design-exports/INDEX.md):

| Folder | What's in it |
|---|---|
| [`06-tokens/`](design-exports/06-tokens) | `tokens.css` (both themes), `colours.json`, `typography.json` |
| [`07-html/`](design-exports/07-html) | Live reference: all 43 components with their markup, plus one standalone file per component |
| `00-boards/` … `05-palette/` | 142 PNGs at 2x — full boards, sections, every component cropped alone, font specimens, palette ramps |

Open the HTML reference with a local server so the relative CSS resolves:

```bash
cd design-exports/07-html && python3 -m http.server 8000
```

Three rules in the token layer are load-bearing, and a naive light-to-dark inversion breaks all three:

- Components reference **role** tokens (`--cb-surface`, `--cb-text`, `--cb-accent`), never ramp steps — which is why flipping `data-theme` is the entire implementation of dark mode.
- The accent **lifts one ramp step** in dark, or it disappears into the surface.
- Danger *fill* stays darker than error *text* in dark, so white labels on destructive buttons keep their contrast.

There is no shadow scale. Elevation is surface tint plus border weight.

## North star

Make one developer love using Corebase. Then 10. Then 100. Then 1,000. The infrastructure evolves alongside the users rather than being built entirely in advance.
