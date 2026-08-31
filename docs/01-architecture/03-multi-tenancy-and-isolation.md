# Multi-Tenancy & Isolation

## Purpose

Fix the tenancy model (org → project) and the isolation mechanism that everything prices, provisions, and secures against. This doc resolves proposal §9–10 — including its internal contradiction C-4 — into the container-per-project decision (D-009), shows the density math that makes it economically survivable on Hetzner hardware, and specifies the noisy-neighbor controls. Isolation sits at rank 1 of the priority stack (D-002): every tradeoff here resolves toward the stronger boundary.

## Design

### The tenancy model

```text
Organization  (billing boundary, member roles: owner/admin/member — §56)
   └── Project  (isolation boundary, == one environment in V1, D-031)
         ├── one Postgres 17 container   (the customer's database, D-037)
         ├── one PgBouncer container     (transaction mode, D-015)
         ├── one PostgREST container     (the data API engine, D-011)
         ├── one R2 prefix               (storage objects, D-017)
         ├── one ES256 keypair           (JWT trust domain, D-014)
         └── one immutable ref           (<ref>.corebase.co, D-056)
```

- **Org** is who pays and who administers. Agencies get many projects under one org (D-003: modeled, not featured).
- **Project** is the unit of everything operational: isolation, provisioning, pausing, backup, deletion, rate limiting, export. In V1 a project *is* an environment — "staging" means a second project (D-031). The schema carries `environment` and project-group columns from day one so V2 environments don't require a migration, per D-031; see [control-plane data model](../02-control-plane/01-data-model.md).
- There is deliberately **no tenancy inside a customer database**: whatever multi-tenant model the *customer* builds with RLS is their business. Corebase's boundary is the project.

### The three isolation options (proposal §10), compared for real

Option A is analyzed in its corrected form per C-4: **container-per-project** — one dedicated Postgres *instance* per project, in a cgroup-limited container, many per shared node — not a VM per project.

| Criterion | A: Container-per-project | B: Schema-per-project (shared instance) | C: Shared DB + tenant_id columns |
|---|---|---|---|
| Isolation strength | **Kernel + Postgres boundary.** Own instance: own superuser-free role tree, own `postgresql.conf`, own shared_buffers, own extensions. cgroup walls for CPU/RAM/IO. An escape requires a container/kernel exploit | Postgres privilege system only. One compromised or misconfigured role, one `search_path` slip, one `SECURITY DEFINER` mistake → cross-tenant read. All tenants share superuser, extensions, and crash domain | Application-layer only. Every query must carry a correct `tenant_id` predicate; one missed WHERE clause is a breach. RLS helps but the platform's own bugs are inside the blast radius |
| RAM floor per idle project | ~210–430 MB (math below) — the real cost of this choice | ~1–5 MB (a schema is nearly free) | ~0 (rows are free) |
| Ops burden | Fleet of thousands of small instances: needs reconciler (D-053), per-project backup stanzas, fleet-wide upgrade playbook (D-037). But each unit is simple and identical | Fewer instances, but shared-instance surgery: a `VACUUM FREEZE` storm, wraparound, or crash takes down N tenants; per-tenant tuning impossible; connection storms from one tenant starve all | Simplest infra, hardest software: tenant-scoping logic smeared through every query, migration, and index decision forever |
| Backup granularity | **Per project, natively** — pgBackRest stanza per instance; PITR per project; restore one tenant without touching others (D-019) | `pg_dump` per schema (slow, no PITR per tenant); instance-level PITR restores *everyone* to the same timestamp | None per tenant. Restoring one tenant = extract rows from a full restore; PITR per tenant impossible |
| Blast radius (crash/OOM/disk-full) | One project. A runaway query OOMs one container; a full volume stops one project (quota, D-055) | All projects on the instance | All projects, full stop |
| Pause-ability (D-008) | **Native**: stop and remove the triplet's containers → RAM cost → ~0, disk retained (D-072). This is what makes the free tier possible | Can't stop one schema; the instance must stay hot for any active tenant | Meaningless — always hot |
| Migration path (small→dedicated, §10) | Same artifact at every tier: move the container to a bigger/dedicated node | Re-platforming: schema → own instance is a data migration | Full export/re-import |
| Portability (D-004) | `pg_dump` of *their* database — clean, complete | dump of a schema with platform namespaces entangled | Corebase-proprietary row extraction |

**Why A won (D-009):** the priority stack (D-002) puts isolation above cost, and A is the only option whose *worst realistic failure* (noisy neighbor, instance crash, backup mistake) is scoped to one tenant. Its weakness — the RAM floor — is attacked directly by pause/resume (D-008) rather than by weakening the boundary. B and C both trade the #1-ranked value (isolation) for the #4-ranked one (cost), which the stack forbids. B additionally poisons the upgrade story: one shared instance pins every tenant to the same maintenance window and extension set, violating "enhance Postgres, don't hide it."

### The per-project unit

Each project materializes as one unit of three containers on its data node, on a dedicated quota'd volume — the triplet's containers are created directly by the worker's reconciler, not from Compose files (D-140):

```text
project abck3xw7 unit (node n7)
  volume:  /data/projects/abck3xw7   (XFS project quota: plan disk cap × 1.2 —
                                      the 20% headroom is the delete-to-recover
                                      buffer, D-070/D-073)
  ├── postgres    postgres:17   mem_limit per plan (free: 512MiB), cpu-shares,
  │               io-weight; shared_buffers sized to plan (free: 128MB)
  │               (per D-174, mem_limits are overcommitted burst ceilings;
  │               placement books 350MB per active project)
  ├── pgbouncer   transaction mode; max_client_conn / pool_size per plan
  └── postgrest   db-uri → direct to Postgres (db:5432), never through
                  PgBouncer (D-101/D-074); jwt public key baked at provision,
                  reloaded on rotation
  labels: corebase.project_ref, corebase.project_id  (reconciler identity)
  states: READY (all 3 up) · PAUSED (containers removed; volume, per-project
          network definition, and config kept, D-072)
```

### Density math (the sketch — full $ math in the [cost model](../12-business/01-cost-model.md))

Assumptions per idle-but-running project, measured targets not guarantees (OQ-056 tracks the benchmark):

| Component | Idle RSS |
|---|---|
| Postgres 17 (shared_buffers 128MB, few connections) | ~150–300 MB |
| PgBouncer | ~10–30 MB |
| PostgREST | ~50–100 MB |
| **Per-project total** | **~210–430 MB; plan on 350 MB (D-091)** |

On a 64 GB Hetzner node (D-023):

```text
64 GB
 − ~8 GB   OS, Docker daemon, node-exporter, log shipping, pgBackRest peaks,
           headroom (reconciler repair storms, query bursts, page cache floor)
 = ~56 GB usable   (the cost model's 64 − 8 figure)
 ÷ ~350 MB booked per ACTIVE project
 ≈ 160 raw slots → per-node design max of 150 active at the 85% placement
   stop (D-090/D-091); fleet average ~135–140 under the 75% DR reserved-RAM
   ceiling (D-148/D-174)
```

**Pause/resume is the multiplier (D-008).** A paused project consumes ~0 RAM and only disk (~pennies/GB/month). If, realistically, 80–90 % of free projects are idle at any moment and get paused after the inactivity window, one node carries:

```text
150 active slots  +  paused projects limited only by disk
→ ~7× effective density: planned 1,000 provisioned projects per 64 GB node,
  hard cap 1,200 (D-090)
```

That multiplier — not the per-node count — is what makes a DB-per-project free tier survivable (the critical review's §2.1 "biggest gap"). Resume is a reconciler status write plus container starts: target cold-resume of a few seconds (requests that arrive mid-resume get an immediate 503 + `Retry-After: 5` per D-172 — see OQ-050, resolved). Sizing, placement (bin-packing on *reserved* RAM, not observed RSS), and disk-full handling live in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md); the dollars live in [cost model](../12-business/01-cost-model.md) (written separately — linked, not duplicated).

### Noisy-neighbor controls

One node hosts ~150+ tenants; one greedy tenant must not be able to hurt the rest. Controls, all per-container/per-project (D-055):

| Resource | Control | Mechanism |
|---|---|---|
| Memory | hard limit per container (`mem_limit`), plan-sized; OOM kills the *tenant's* Postgres, not the node | cgroup v2 `memory.max` via Docker |
| CPU | proportional shares + optional hard quota on free plan | cgroup v2 `cpu.weight` / `cpu.max` |
| Disk IO | per-container IO weight; free plan capped IOPS/BPS | cgroup v2 `io.weight` / `io.max` on the volume's device |
| Disk space | **per-project volume with XFS project quota** = plan disk cap × 1.2 (D-070/D-073 — the 20% headroom is the delete-to-recover buffer); full disk stops one project, and WAL growth cannot eat the node | XFS prjquota on `/data/projects/<ref>` |
| Connections | PgBouncer `max_client_conn` + `default_pool_size` per plan; Postgres `max_connections` kept small since the pooler multiplexes (D-015) | PgBouncer/Postgres config at provision |
| API request rate | layered IP → key → project buckets at the gateway (D-033) | Redis sliding window |
| Long/hostile queries | per-role `statement_timeout` and `idle_in_transaction_session_timeout` defaults (overridable on paid plans) | Postgres role config |
| SQL-level escapes | no superuser for tenants; curated extension allowlist; no `COPY TO PROGRAM`-capable roles, no file FDWs | [threat model](../06-security/01-threat-model.md), [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) |

The continuously-running cross-tenant test suite (proposal §74) exercises this boundary from the API side and the SQL side: [tenant isolation tests](../06-security/03-tenant-isolation-tests.md), living in `tests/isolation/` ([repo layout](05-repo-and-service-layout.md)).

### Tiering later (proposal §10's ladder, unchanged in shape)

| Tier | Placement | Same artifact? |
|---|---|---|
| Free / small | shared node, plan-sized cgroup limits, aggressive pause | yes — the triplet |
| Pro / large | shared node with bigger reservations, or dedicated node | yes — bigger limits |
| Enterprise (V3) | dedicated node(s)/cluster, private networking | yes — different placement |

Because every tier runs the identical container triplet, upgrades are a *reschedule*, not a re-platform. This is the payoff of refusing option B.

## Decisions

- **D-054 — The per-project data-plane unit is exactly three containers (Postgres 17, PgBouncer, PostgREST) on one dedicated XFS-project-quota'd volume, labeled with the project ref; project states map to the whole unit (READY = all running, PAUSED = containers removed with the volume, per-project network definition, and config kept, per D-072).** *(Rationale: one indivisible, identical artifact per tenant keeps the reconciler diff trivial, makes pause/resume a start/stop of a known set, and keeps per-tier differences to config values rather than shapes.)*
- **D-055 — Noisy-neighbor control set, per project, from day one: cgroup v2 memory hard limit, CPU weight (+hard quota on free), IO weight/caps, XFS project-quota disk limit, PgBouncer connection caps, default `statement_timeout`, and gateway rate buckets (D-033).** *(Rationale: at ~150+ tenants/node, fairness cannot be reactive; every axis a tenant can saturate — RAM, CPU, IO, disk, connections, request rate, query time — gets a static wall so the blast radius stays one project, upholding D-002 rank 1.)*

## Open Questions

- **OQ-050** — Gateway behavior for a request hitting a PAUSED project: hold the request while triggering resume (nice UX, but hostage connections if resume is slow), or return `503 + Retry-After` with the SDK auto-retrying? Needs a measured cold-resume time first. Owner: [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) + [SDK spec](../10-cli-and-sdk/03-sdk-spec.md). **Resolved by D-172:** never-hold; immediate 503 + `Retry-After: 5`, `project_resuming`.
- **OQ-056** *(first data: [M-001](../14-roadmap/05-measurements.md) — Postgres alone idles at 5 MiB anon / 102 MiB peak on ARM; triplet on target hardware still needed)* — Benchmark the real idle RSS of the triplet under PG 17 with plan-sized `shared_buffers`, and PostgREST under schema-cache load, before the cost model's numbers are locked. The 350 MB planning figure (D-091) is literature + analogy, not measurement.
- **OQ-061** — Free-plan CPU: weight-only (bursty but fair-ish) vs. hard `cpu.max` quota (predictable, but makes the free tier feel slow even on an idle node)? Interacts with the "first five minutes" DX target. Owner: [postgres provisioning](../03-database-platform/01-postgres-provisioning.md).

## Dependencies

- Builds on: [01-system-architecture.md](01-system-architecture.md), [02-control-vs-data-plane.md](02-control-vs-data-plane.md), [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md) (§2.1, §2.7/C-4), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-002, D-008, D-009, D-031)
- Feeds: [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md), [../03-database-platform/02-connection-pooling.md](../03-database-platform/02-connection-pooling.md), [../06-security/01-threat-model.md](../06-security/01-threat-model.md), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md), [../12-business/01-cost-model.md](../12-business/01-cost-model.md), [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md)
