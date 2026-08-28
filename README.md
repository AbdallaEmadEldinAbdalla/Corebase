# Corebase

**The backend foundation for modern applications.**

Corebase is a developer-focused Backend-as-a-Service: a developer creates a project and receives a production-ready backend — PostgreSQL, auto-generated APIs, authentication, row-level security, object storage, and (later) realtime — in minutes, without assembling infrastructure themselves.

> One command to get a production backend: `corebase create my-app`

## Status

**Planning phase.** Nothing is built yet. This repository holds the two things the build will be measured against: the **planning corpus** (what to build and why) and the **design system** (what it looks like).

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

- **[Decision log](docs/00-foundation/05-decision-log.md)** — every binding decision (D-001…D-180) with its rationale. If two documents disagree, this log wins. Overturned decisions are annotated, never deleted, so the reasoning stays auditable.
- **[Open questions](docs/15-risks/02-open-questions.md)** — 135 questions left deliberately unresolved, each with an owning document and a decide-by trigger.

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
