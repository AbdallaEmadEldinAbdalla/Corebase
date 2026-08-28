# Corebase

**The backend foundation for modern applications.**

Corebase is a developer-focused Backend-as-a-Service: a developer creates a project and receives a production-ready backend — PostgreSQL, auto-generated APIs, authentication, row-level security, object storage, and (later) realtime — in minutes, without assembling infrastructure themselves.

> One command to get a production backend: `corebase create my-app`

## Status

**Planning phase.** Nothing is built yet. This repository currently contains the complete planning corpus that the platform will be built against.

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
| [09-dashboard](docs/09-dashboard/01-dashboard-ia.md) | Dashboard IA, table editor, SQL editor |
| [10-cli-and-sdk](docs/10-cli-and-sdk/01-cli-spec.md) | CLI spec, local development, SDK spec |
| [11-infrastructure](docs/11-infrastructure/01-infra-phases.md) | Infra phases, IaC & CI/CD, observability, disaster recovery |
| [12-business](docs/12-business/01-cost-model.md) | Cost model, pricing & plans, abuse prevention, open-source strategy |
| [13-quality](docs/13-quality/01-testing-strategy.md) | Testing strategy, release & versioning policy |
| [14-roadmap](docs/14-roadmap/01-phase-plan.md) | Full phase plan, V1 scope & cut list, post-V1 roadmap, Milestone 0 |
| [15-risks](docs/15-risks/01-risk-register.md) | Risk register, open questions |

## North star

Make one developer love using Corebase. Then 10. Then 100. Then 1,000. The infrastructure evolves alongside the users rather than being built entirely in advance.
