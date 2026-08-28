# Competitive Analysis

## Purpose

An honest map of the BaaS landscape as of mid-2026: what each incumbent actually does well, where they are weak, and which weaknesses are *exploitable* by a small team versus merely visible. This doc exists to keep Corebase from building a worse Supabase and calling it differentiation.

## Design

### The field

| Platform | Model | Core strength | Exploitable weakness |
|---|---|---|---|
| **Supabase** | Managed Postgres + PostgREST + GoTrue + Storage + Realtime; OSS core | Ecosystem, docs, brand, feature breadth | Complexity creep; per-project pricing granularity; dashboard sprawl; free-tier pausing annoys users |
| **Firebase** | Google's proprietary BaaS (Firestore/RTDB) | Mobile SDKs, realtime, Google integration | Total lock-in, no SQL, pricing shock at scale — *the* portability foil |
| **Neon** | Serverless Postgres (storage/compute split, branching) | Scale-to-zero economics, DB branching, cold-start engineering | Database only — no auth/storage/APIs; not a full backend |
| **Turso** | Edge SQLite (libSQL) | Massive per-DB density (DB-per-user patterns), latency | SQLite limits; not Postgres; smaller ecosystem |
| **PocketBase** | Single-binary Go + SQLite backend | Radical simplicity, self-host in seconds | Single-node by design; no managed cloud; SQLite ceiling |
| **Appwrite** | OSS BaaS (own document API over MariaDB/pg) | Feature breadth, self-hosting community | Proprietary data API (not SQL-first); cloud economics unproven |
| **Nhost** | Managed Hasura (GraphQL) + Postgres + auth | GraphQL-first DX | Narrower audience; Hasura dependency |
| **Fly.io / Railway / Render** | App platforms with managed Postgres | Compute + DB colocation | Not a BaaS: no auth/RLS/auto-API — different product, but competes for the "just give me a backend" dollar |

### What Supabase actually got right (copy these)

1. **Postgres as the product.** No abstraction tax; the ecosystem (extensions, tooling, knowledge) comes free.
2. **RLS as the authorization model.** Policies live next to data; the API stays thin.
3. **Composed OSS services** (PostgREST, GoTrue-lineage auth, storage-api) rather than a monolith rewrite — years of edge cases inherited for free.
4. **The anon/service-role two-key model.** Simple enough to explain in one paragraph, powerful enough for real apps.
5. **Local dev parity** (`supabase start` = the real stack in Docker).

### What the incumbents left open (Corebase's actual lanes)

1. **Provisioning speed + first-five-minutes.** Supabase project creation takes minutes and the dashboard is dense. A sub-30-second provision with a ruthless onboarding path is a *felt* difference. Achievable: pre-warmed Postgres containers make this an engineering choice, not magic ([postgres provisioning](../03-database-platform/01-postgres-provisioning.md)).
2. **Portability as a first-class verb.** Nobody ships a great `export` / `eject` story — incumbents' incentives point the other way. Cheap to build, high trust value, and it *compounds* with being late to market ("try us; leaving is easy").
3. **Economics via density.** Supabase runs a VM-ish stack per project; Neon solved idle cost with storage/compute split. A container-per-project model with **aggressive pause/resume of idle projects** captures most of the economics at a fraction of Neon's engineering cost ([cost model](../12-business/01-cost-model.md)).
4. **Simplicity as a feature.** PocketBase proves demand for "small and comprehensible." Nobody offers PocketBase-grade simplicity *with* managed Postgres and a cloud. That intersection is unoccupied.
5. **Transparent pricing.** Usage-dimension sprawl (8+ billing meters) is a common complaint. Fewer, more predictable dimensions is a real differentiator ([pricing](../12-business/02-pricing-and-plans.md)).

### What is NOT an exploitable lane (avoid)

- **Feature breadth.** Vectors, AI, analytics, edge functions — chasing these in V1 is how the runway dies ([risk register](../15-risks/01-risk-register.md)).
- **GraphQL.** Nhost owns it; the market slice is thin; REST + SDK covers V1 users.
- **Enterprise compliance.** SOC2/SAML before PMF is capital destruction.
- **Out-innovating Neon on database internals.** Storage/compute separation is a 20-engineer problem. Corebase buys the same economics with pause/resume and revisits later.

### Moat honesty

A small team's real moats, in descending order of durability:

1. **Economics** — if cost-per-free-project is 5–10× lower than incumbents', the free tier becomes sustainable marketing others can't match.
2. **DX velocity** — small teams iterate on onboarding/CLI faster than incumbents can reorganize.
3. **Portability trust** — cultural moat; hard for lock-in-dependent incumbents to copy credibly.
4. ~~Features~~ — not a moat; anything shipped is copyable in a quarter.

## Decisions

- **D-005 — Compose proven OSS data-plane components rather than rewriting them** (PostgREST for the data API; evaluated per subsystem elsewhere). *(Rationale: Supabase's composition strategy is its most copyable structural advantage; rewriting PostgREST's decade of edge cases is negative-value work for V1.)*
- **D-006 — Corebase's three declared lanes: provisioning speed, portability, economics.** Marketing, roadmap, and scope debates cite these lanes; features outside them need extraordinary justification.
- **D-007 — No GraphQL in V1–V2.** REST + SDK only.
- **D-008 — Idle-project pause/resume is a core architectural requirement from day one**, not an optimization — it is what makes lane 3 (economics) real. Detailed in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) and [cost model](../12-business/01-cost-model.md).

## Open Questions

- OQ-002: Should Corebase publicly benchmark provisioning time vs incumbents at launch? (Marketing decision; measurable claim requires keeping it true forever.)

## Dependencies

- Builds on: [01-vision-and-principles.md](01-vision-and-principles.md)
- Feeds: [03-critical-review.md](03-critical-review.md), [12-business/*](../12-business/01-cost-model.md), [14-roadmap/*](../14-roadmap/01-phase-plan.md)
