# Vision & Principles

> **Template note (applies to every doc in this corpus):** each document follows the structure
> **Purpose → Design → Decisions → Open Questions → Dependencies**. Decisions are numbered
> `D-xxx` and mirrored in the [decision log](05-decision-log.md). Cross-references are relative links.

## Purpose

Define what Corebase is, what it refuses to be, and the principles that settle arguments when documents in this corpus disagree. Every other doc inherits from this one.

## Design

### The one-sentence product

**Corebase turns "I have an idea" into a production-ready application backend in minutes**: PostgreSQL, auto-generated APIs, authentication, row-level security, object storage, and eventually realtime and functions — behind one project, one CLI, one dashboard.

### The north-star experience

```bash
corebase create my-app
```

```text
✓ Project created
✓ PostgreSQL provisioned
✓ Connection pooling enabled
✓ Authentication enabled
✓ Storage enabled
✓ API generated
✓ Security policies initialized
✓ Backups enabled
✓ API keys generated

Your backend is ready.
```

First successful database request in **under five minutes** from sign-up ([the "first five minutes"](../14-roadmap/02-v1-scope-and-cutlist.md)).

### The five principles

1. **Developer first.** Every decision is graded against "does this make the developer's first hour better?" Provisioning speed, error message quality, docs, and CLI ergonomics are product features, not polish.

2. **PostgreSQL first.** Corebase enhances Postgres; it never hides it. Developers get real connection strings, real SQL, real extensions (curated — see [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md)). No proprietary query abstraction sits between the developer and their database.

3. **Portable.** A developer can leave at any time with their database (`pg_dump`), files (S3-compatible export), users (standard table export including password hashes), and migrations. Portability is a *tested feature* with an export command, not a marketing claim — see the critique of this principle in the [critical review §3.4](03-critical-review.md).

4. **Open-source friendly.** The core is designed to be open-sourceable and self-hostable; the cloud business is managed infrastructure on top. The timing and license are a deliberate decision, not a default — see [open-source strategy](../12-business/04-open-source-strategy.md).

5. **Infrastructure disappears.** Users think in `users`, `orders`, `messages` — never in PgBouncer, WAL, or VPCs. Internally the opposite holds: *we* obsess over PgBouncer, WAL, and VPCs so users don't have to.

### Non-goals (permanent or long-deferred)

- **Not a Firebase-style proprietary data model.** Postgres is the source of truth; no NoSQL abstraction.
- **Not a general compute platform** (V1–V2). Functions/edge come only after the data platform is boring and reliable.
- **Not a feature-race with Supabase.** Corebase wins on simplicity, provisioning speed, portability, and economics — not feature count. Cloning Supabase's surface area is explicitly the losing strategy ([competitive analysis](02-competitive-analysis.md)).
- **Not enterprise-first.** SSO/SAML/SCIM/compliance are V3 concerns. Building them early is the classic way to die before product-market fit.
- **No SLA before the infrastructure can honor one.**

### The priority stack (when principles conflict)

When two goals conflict, resolve in this order:

```text
1. Tenant isolation & security      (never traded away)
2. Data durability (backups work)   (never traded away)
3. Developer experience
4. Cost economics
5. Feature breadth
```

Example: a feature that improves DX but weakens isolation (e.g., allowing arbitrary Postgres extensions) loses. A feature that adds breadth but threatens the cost model (e.g., always-on dedicated VMs for free projects) loses.

### Who it's for

| Audience | What they need | Priority |
|---|---|---|
| Indie developers | MVP backend in an evening, generous-enough free tier | **V1 core audience** |
| Startups | Managed infra without a DevOps hire; staging/prod projects | V1 |
| Agencies | Many small client projects under one org | V1.x (org model supports it from day one) |
| Enterprise | SSO, audit, private networking, compliance | V3 — modeled in schemas, not built |

## Decisions

- **D-001 — Corebase's differentiation axis is *simplicity + portability + provisioning speed + economics*, not feature parity with Supabase.** All scope debates resolve against this. *(Rationale: a three-person team cannot out-feature a 100-person incumbent; it can out-simple them.)*
- **D-002 — The priority stack above is binding.** Isolation and durability outrank DX; DX outranks cost; cost outranks breadth.
- **D-003 — V1 targets indie developers and startups only.** Agency and enterprise needs are represented in data models (orgs, roles, audit tables) but their features are deferred.
- **D-004 — Portability is a shippable feature**: `corebase export` (DB dump + storage manifest + users + migrations) is in V1 scope. *(Rationale: it's the claimed moat; an untested moat is fiction.)*

## Open Questions

- OQ-001: Product name/domain availability check (`corebase.com`, `corebase.co`) — commercial task, outside this corpus. Tracked in [open questions](../15-risks/02-open-questions.md).

## Dependencies

- Refined by: [02-competitive-analysis.md](02-competitive-analysis.md), [03-critical-review.md](03-critical-review.md)
- Consumed by: every other document in this corpus.
