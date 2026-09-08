# Domain & Region Model

## Purpose

Fix the domain scheme sketched in proposal §61 ("exact structure decided later" — decided here), specify the project-ref format, close the TLS gap the proposal never mentions (flagged in the [critical review §3](../00-foundation/03-critical-review.md)), and define a region model that is single-region in V1 (D-024) yet expansion-ready in the schema from day one, so proposal §62–63 never require a rearchitecture.

## Design

### The domain scheme

Two apex domains with a deliberate split of trust:

| Hostname | Plane | Serves | Cookie/trust domain notes |
|---|---|---|---|
| `steadhold.dev` | — | marketing site (Cloudflare Pages) | no app cookies here, ever |
| `app.steadhold.dev` | control | dashboard (Next.js) | dashboard session cookies scoped to this host |
| `api.steadhold.dev` | control | platform REST API `/v1` (D-039) | CLI + dashboard talk here |
| `<ref>.steadhold.app` | data | customer traffic: `/rest/v1`, `/auth/v1`, `/storage/v1` | each project its own origin → browser same-origin policy separates tenants for free |
| `db.<ref>.steadhold.app` *(reserved)* | data | direct Postgres / pooler TCP endpoint when we later front 5432/6432 via load balancer; V1 hands out node-addressed connection strings | |

Why two apexes: customer projects live on **`.steadhold.app`** so that no customer-controlled content or credential ever shares a registrable domain with the dashboard (`app.steadhold.dev`). A tenant XSS or cookie-scope bug on a project subdomain cannot touch dashboard sessions, and the Public Suffix List becomes an option for `steadhold.app` later. Proposal §61's `<ref>.storage.steadhold.app` is **dropped in V1**: a wildcard certificate matches exactly one label, so `*.steadhold.app` does not cover `x.storage.steadhold.app` — a second wildcard cert and routing tier for zero V1 benefit. Storage rides the project origin at `/storage/v1/*` instead.

### Project refs (D-056)

```text
format:   20 characters, lowercase RFC-4648 base32 alphabet (a–z, 2–7)
          first character forced alphabetic (a–z) — must never parse as a number,
          must be a valid DNS label start
entropy:  26 × 32^19 ≈ 2^99.7  (~100 bits)
example:  kf3m7q2xvbn4w6yc5zta  →  kf3m7q2xvbn4w6yc5zta.steadhold.app
```

- **Generation**: 13 random bytes from a CSPRNG → base32 → take 20 chars → regenerate on the (3/16) chance the first char is a digit. Uniqueness enforced by the DB unique index; at 100 bits, collision retry is theoretical.
- **Immutable** (proposal §57): the ref never changes across renames, plan changes, node moves, or region moves — it is the routing key (D-051), the R2 prefix (D-017), the pgBackRest stanza name (D-019), and the JWT audience. Display names are mutable metadata; refs are identity.
- **Never reused**: deleted projects leave a tombstoned ref forever, so a future tenant can never receive a subdomain that old mobile apps, cached JWTs, or bookmarked signed URLs still point at (subdomain-takeover class bug).
- **Unguessable by design**: ~100 bits means the ref itself leaks nothing and cannot be enumerated — but it is *not a secret* (it appears in client bundles); authorization always comes from keys/JWTs (D-029), never from knowing the ref (§20).
- Lowercase base32 survives DNS case-insensitivity, avoids `-`/`_` edge cases in tooling, and is unambiguous to read aloud (no `0/o`, `1/l` — the alphabet excludes `0` and `1`).

### The TLS story (the gap the proposal missed)

```text
client ──TLS 1───▶ Cloudflare edge ──TLS 2───▶ Caddy (app node) ──loopback──▶ gateway
         *.steadhold.app wildcard        Cloudflare Origin CA cert,
         + steadhold.dev/app/api        Full (strict) + authenticated
         certs, auto-managed           origin pulls (mTLS)
```

- **TLS 1 (client → edge)**: Cloudflare holds and auto-renews the certificates — apex + `*.steadhold.dev`, apex + `*.steadhold.app` (wildcard TLS at the edge is half of D-016). Every project subdomain is covered by the one wildcard; SNI from the client selects it, nothing per-project exists.
- **TLS 2 (edge → origin)**: Cloudflare **Full (strict)** mode to Caddy, which serves a long-lived **Cloudflare Origin CA** certificate for `*.steadhold.app` and the `steadhold.dev` hosts (D-050 in [system architecture](01-system-architecture.md)). **Authenticated origin pulls** (Cloudflare's client cert, verified by Caddy) plus a firewall allowlist of Cloudflare IP ranges mean the origin refuses everything that didn't come through the edge — otherwise the wildcard DNS would let attackers hit Caddy directly and skip edge rate limiting/DDoS.
- **Why no per-project certificates in V1 (D-057)**: per-project certs exist to serve **custom domains** (`api.customer.com`) — a V1 non-feature. For `<ref>.steadhold.app` the wildcard is strictly better: zero issuance latency at provision time (a Let's Encrypt round-trip per project would add seconds-to-minutes and a rate-limit ceiling), zero renewal fleet to babysit, zero cert-per-tenant storage. Isolation is not weakened: TLS identifies the *platform*, while tenant separation is enforced by routing + keys + RLS. Custom domains, when they come (V1.x), use Cloudflare for SaaS per-hostname certs — additive, no rearchitecture (OQ-057).
- Inside the origin: Caddy → gateway is loopback; gateway → data nodes crosses the Hetzner private network (encryption-in-transit question tracked as OQ-051 in [system architecture](01-system-architecture.md)); Postgres connections offered to customers are TLS-required at PgBouncer/Postgres ([platform security](../06-security/04-platform-security.md)).

### SNI / Host-header routing at the gateway

TLS terminates at the edge and again at Caddy, so by the time a request reaches the gateway module, routing is **pure `Host`-header work** (SNI already did its job selecting the wildcard cert):

```text
Host: kf3m7q2xvbn4w6yc5zta.steadhold.app
  1. exactly one label before steadhold.app?  else 404
  2. label matches ^[a-z][a-z2-7]{19}$ ?    else 404 (cheap junk filter)
  3. routing-table lookup (in-memory, D-051):
       miss                → 404 {error:{code:"project_not_found"}} (D-032)
       status=PAUSED       → resume path (OQ-050)
       status=SUSPENDED    → 403;  DELETING/tombstone → 410
       hit                 → {node_ip, ports, keys, limits, region}
  4. path prefix → PostgREST proxy | auth module | storage-api module
```

Caddy is configured with exactly two virtual hosts (`*.steadhold.app` → gateway, control-plane hosts → their modules); it never knows about individual projects. All tenant knowledge lives in one place — the routing table (D-051) — so there is no per-project state to keep synchronized across a proxy fleet.

### Region model: one region, expansion-ready schema

V1 runs **eu-central (Hetzner Falkenstein) only** (D-024). But region-blindness is the classic retrofit trap (proposal §62–63), so the *data model* is region-aware from the first migration (D-058):

```text
regions   (id, slug 'eu-central', provider 'hetzner', location 'fsn1',
           status active|draining|closed)
clusters  (id, region_id, slug 'eu-central-c1', status)        ← capacity pool
nodes     (id, cluster_id, hostname, private_ip, ram_gb, disk_gb,
           reserved_ram_mb, status active|cordoned|dead)
projects  (…, region_id NOT NULL, node_id, …)                  ← §63 chain:
                                     project → region → cluster → node
```

V1 contents: one `regions` row, one `clusters` row, N `nodes` rows. Every placement decision already walks region → cluster → node, so "multi-region" changes *data*, not *code paths*. The dashboard's region picker renders from `regions` (a one-item list today — honest and future-proof).

**How region expansion works later (no rearchitecture):**

1. **Terraform a cell**: each region is a self-contained cell — data nodes + its own gateway/monolith host, Redis, worker, and monitoring scrape target ([infra phases](../11-infrastructure/01-infra-phases.md)). Insert `regions`/`clusters`/`nodes` rows; the control-plane DB stays global (single-writer, in the home region).
2. **Steering**: `*.steadhold.app` remains one wildcard. Cloudflare (Workers/Load Balancer, by hostname → region map exported from the control plane) steers each ref to its region's origin; until that ships, the home gateway can forward cross-region as a stopgap since the routing table already carries `region` per entry. Latency-sensitive detail deferred (OQ-055).
3. **Per-region reconcilers**: workers subscribe filtered by region; desired state stays central, convergence is local. R2 buckets and backup targets become per-region (data-residency: EU projects' bytes stay in EU).
4. **What never changes**: refs (region-agnostic on purpose — a project can *move* regions by restore-to-new-node, D-019, without a new URL), key model, container triplet, API surfaces.
5. **Explicitly not planned even then**: multi-region *databases* (replication, geo-failover) — that is proposal §64/V3 territory, [disaster recovery](../11-infrastructure/04-disaster-recovery.md).

### Environments and domains (D-031 note)

Since project == environment in V1, `myapp-staging` is simply a second project with its own ref, keys, and subdomain. When environment grouping surfaces later, refs stay per-environment — grouping is a dashboard/control-plane concept, invisible to the domain scheme.

## Decisions

- **D-056 — Project refs are immutable, never-reused, 20-character lowercase RFC-4648 base32 slugs (alphabet a–z 2–7, first character alphabetic; ~100 bits entropy), generated from a CSPRNG at creation; the ref is the universal routing/storage/backup/JWT-audience key, and display names are separate mutable metadata.** *(Rationale: DNS-safe, case-insensitivity-safe, unguessable enough to kill enumeration, long enough to tombstone forever without scarcity; immutability is what lets the routing table, R2 prefixes, and backup stanzas share one key.)*
- **D-057 — TLS: the `*.steadhold.app` wildcard (plus `steadhold.dev`/`app`/`api`) terminates at Cloudflare; origin traffic uses Full (strict) to Caddy holding a Cloudflare Origin CA cert with authenticated origin pulls; there are no per-project certificates in V1, and custom domains (V1.x+) will use per-hostname certs at the edge (Cloudflare for SaaS) rather than origin-side issuance.** *(Rationale: one wildcard gives every project instant TLS at provision time with zero renewal fleet; per-project certs solve only the custom-domain problem V1 doesn't have; strict origin auth closes the direct-to-origin bypass the wildcard DNS would otherwise open.)*
- **D-058 — The control-plane schema is region-aware from the first migration: `regions` → `clusters` → `nodes` tables with `projects.region_id NOT NULL`, populated with a single eu-central row set in V1; all placement logic walks this chain from day one.** *(Rationale: D-024 fixes one region as an operational choice, not a schema assumption; making expansion a data change instead of a code change is nearly free now and brutally expensive to retrofit — proposal §63 adopted structurally.)*

## Open Questions

- **OQ-055** — Region steering mechanism when region #2 arrives: Cloudflare Worker doing ref→region lookup at the edge (needs an exported map, adds a KV dependency) vs. Cloudflare Load Balancer with per-hostname pools vs. home-region forwarding (simple, adds a cross-region hop). Decide when expansion is scheduled; owner: [infra phases](../11-infrastructure/01-infra-phases.md).
- **OQ-057** — Custom-domain roadmap slot and mechanism (Cloudflare for SaaS pricing per hostname vs. origin ACME): V1.1 or V1.2? Feeds [pricing & plans](../12-business/02-pricing-and-plans.md) since custom domains are a classic paid-tier feature.
- **OQ-062** — Should `steadhold.app` be submitted to the Public Suffix List once custom subdomain content (e.g. storage-served HTML) exists, to hard-isolate tenant cookies/localStorage at the browser level? Has side effects on any future shared-cookie feature; owner: [threat model](../06-security/01-threat-model.md).

## Dependencies

- Builds on: [01-system-architecture.md](01-system-architecture.md) (D-050, D-051), [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md) (TLS gap, §3), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-016, D-024, D-031)
- Feeds: [../02-control-plane/01-data-model.md](../02-control-plane/01-data-model.md) (regions/clusters/nodes DDL), [../04-data-api/02-request-pipeline.md](../04-data-api/02-request-pipeline.md), [../06-security/04-platform-security.md](../06-security/04-platform-security.md), [../11-infrastructure/01-infra-phases.md](../11-infrastructure/01-infra-phases.md), [../11-infrastructure/02-iac-and-cicd.md](../11-infrastructure/02-iac-and-cicd.md)
