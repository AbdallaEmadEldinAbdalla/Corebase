# Extensions & Upgrades

## Purpose

Two subjects the proposal underweighted. Extensions (§11 lists them as a feature word): which Postgres extensions Corebase offers, and the threat model behind refusing the rest — on shared nodes, an extension is code execution inside the tenant boundary. Upgrades (missing entirely, flagged in the [critical review](../00-foundation/03-critical-review.md) §3): the standing playbook D-037 demands for moving a fleet of thousands of single-version databases from PostgreSQL 17 to 18+, plus the routine of minor-version bumps.

## Design

### 1. Extension threat model — why a curated allowlist

Under container-per-project (D-009) the container is the isolation boundary, and RLS/roles are boundaries *inside* it. Extensions threaten both:

- **Untrusted C extensions are arbitrary native code** in the Postgres process. Inside the container that's "only" the tenant's own instance — but it is also the launchpad for every container-escape CVE, and containers are a good boundary, not a perfect one ([threat model](../06-security/01-threat-model.md)). A curated list is defense in depth for the *node*, not paranoia about the tenant.
- **Filesystem/network-reach extensions break the request-path security model even without an escape**: `dblink`/`postgres_fdw` turn the database into an SSRF client that can probe the node network and other services from a trusted network position; `file_fdw`/`adminpack` read/write the server filesystem; any of them can exfiltrate across boundaries RLS never sees.
- **Server-program execution**: `COPY TO/FROM PROGRAM` and server-file COPY are superuser/role-gated by Postgres itself; customer roles (`developer` and below, [credentials §1](03-credentials-and-secrets.md)) are **never** granted `pg_execute_server_program`, `pg_read_server_files`, or `pg_write_server_files`, and never superuser — so these are closed by role design, restated here because they are the classic SQL-level escape ([tenant isolation tests](../06-security/03-tenant-isolation-tests.md) includes probes for all three).

**Enforcement is by absence, not by policy**: the `postgres:17-corebase` image ships *only* the allowlisted extensions' `.so`/control files. There is nothing to misconfigure — `CREATE EXTENSION dblink` fails because dblink does not exist in the image. Trusted extensions on the list can be created by the `developer` role directly (PG13+ trusted mechanism); non-trusted listed ones are installed via the dashboard/API, executed by the internal admin role, recorded as a migration ([migrations §5](04-migrations.md)).

### 2. The V1 allowlist

| Extension | V1? | Rationale | Risk notes |
|---|---|---|---|
| `pg_stat_statements` | **V1** (preloaded) | Powers dashboard query insights ([observability](../11-infrastructure/03-observability.md)); zero customer action | Trusted usage; read-only stats |
| `pgcrypto` | **V1** | Hashing/crypto in SQL; ubiquitous in auth-adjacent schemas | Trusted; no I/O reach |
| `uuid-ossp` | **V1** | Compatibility: countless tutorials/Supabase schemas use `uuid_generate_v4()` (native `gen_random_uuid()` is preferred in our docs) | Trusted; trivial |
| `pg_trgm` | **V1** | Fuzzy search / `LIKE` acceleration; the most-asked-for indexing extension | Trusted; index AM only |
| `btree_gin`, `btree_gist` | **V1** | Composite/exclusion-constraint support; tiny, standard | Trusted |
| `citext` | **V1** | Case-insensitive text (emails); common migration blocker if absent | Trusted |
| `pgvector` | **V1** | AI-era table stakes; a top-3 reason developers pick a Postgres BaaS today. Pure type + index AM: no filesystem/network reach, widely deployed and reviewed. Worth one exception to "no C extensions beyond contrib" | C code (accepted); HNSW index builds are memory-hungry → bounded by `maintenance_work_mem` (64 MB template) and the container cgroup — build failures are the tenant's, not the node's (OQ-030) |
| `postgis` | **V1.1** | Real demand but: ~10× image-size growth (GEOS/GDAL/PROJ), large attack/patch surface, and its own upgrade coupling with major versions. Ship as a *variant image* (`postgres:17-corebase-gis`) chosen at project create, so the base fleet doesn't carry it | Large C dependency tree; variant-image isolation keeps the blast radius to projects that opted in |
| `pg_cron` | **V1.1** | Wanted for scheduled jobs, but runs in-server with `shared_preload_libraries` and per-DB config; defer until the functions/cron product story exists (§109 V1.3) | Executes stored SQL on schedule — fine inside the tenant boundary; needs quota thought |
| `dblink`, `postgres_fdw`, `file_fdw`, `adminpack`, `pg_prewarm`(server-wide), any `plpython`/`plperlu`, `pg_net`-class HTTP | **Denied** | Filesystem/network/untrusted-language reach per §1 | Not in the image; revisit only per-extension with a written isolation argument |

Requests for unlisted extensions become a labeled feedback queue; the bar for adding one: trusted or contrib-grade provenance, no filesystem/network reach (or an isolation argument for why the container boundary suffices), maintained against every major version we run, and measurable demand.

### 3. Minor-version updates

Minor releases (17.x → 17.x+1) are security patches; the fleet takes them **monthly, or within 72 h for an actively-exploited CVE**:

1. New `postgres:17-corebase` image built, scanned, soak-tested on a canary node (internal projects + volunteers) for 48 h.
2. Control plane records target image digest; **paused projects are done for free** — they simply resume onto the current image (containers are recreated from the current image at resume, [provisioning §5](01-postgres-provisioning.md)); this is the pause-aware scheduling dividend, and at healthy pause ratios it's most of the fleet.
3. Active projects: rolling per node, batched (e.g., 10 projects at a time), inside a per-region off-peak window. Cost per project = clean stop + start on the kept volume ≈ **2–5 s of unavailability**; pooler `max_client_conn` buffering + SDK retries absorb most of it. Dashboard shows the maintenance event; no customer action.
4. PgBouncer/PostgREST image bumps ride the same mechanism, usually with zero Postgres restart (independent containers — the D-070 bridge-network dividend).

### 4. Major-version upgrades — the playbook (D-037's standing deliverable)

One fleet version (PG17 at launch, D-037) means the whole fleet must cross to 18/19 within a bounded season — heterogeneity is the ops tax we refused to pay. Strategy options:

| Strategy | Downtime | Rollback | Complexity | Fit |
|---|---|---|---|---|
| **In-place `pg_upgrade --link`** (dual-binary container) | Minutes (mostly `ANALYZE` after) | **Poor**: link mode modifies the old cluster's files — rollback = PITR restore, losing post-upgrade writes | Medium: dual-binary image, extension binary compat per version, stats rebuild | Large DBs where copying is prohibitive |
| **Dump/restore into a new instance** | Minutes–hours (size-bound) | **Excellent**: old instance untouched until promote; 72 h regret window | Low: reuses the [restore-to-new machinery](05-backups-and-pitr.md) end to end | Small DBs — which is most of the fleet |
| **Blue-green via logical replication** | Seconds (cutover only) | Excellent until cutover | High: slot management (the exact hazard class D-030 defers), sequence sync, DDL freeze during sync, 2× resources | Large paid DBs where minutes of downtime are unacceptable |

**Chosen defaults (D-079), by size:**

- **≤ 10 GB (the overwhelming majority): dump/restore blue-green.** Provision new stack on PG-new → `pg_dump | pg_restore` → verify (row counts, migration table, `pg_amcheck`) → brief write-freeze on old (soft read-only, same mechanism as [disk ladder](01-postgres-provisioning.md) §6) → final delta is unnecessary because the freeze precedes the dump of a small DB (minutes) → **promote = endpoint/credential swap** (identical to [backups §4](05-backups-and-pitr.md) step 6) → old stack kept 72 h. Customer-visible downtime: the write-freeze minutes, scheduled.
- **> 10 GB: in-place `pg_upgrade` in a dual-binary container**, inside a scheduled maintenance window, immediately preceded by a fresh full backup (rollback = restore-to-new on the old version image, restoring to the pre-upgrade point; post-upgrade writes lost — stated plainly in the window notice). Followed by `ANALYZE` (staged: `vacuumdb --analyze-in-stages`) and extension `ALTER EXTENSION ... UPDATE`.
- **Logical-replication blue-green: not built for the first fleet upgrade.** It becomes the Team/Enterprise path when a customer class exists for whom minutes matter; it inherits D-030's slot-hazard controls when built.
- **Paused projects upgrade lazily**: flagged `upgrade_pending`; at resume, the resume job routes through dump/restore on the new version before serving traffic (resume takes minutes that one time, messaged in the dashboard). The fleet is "done" when active projects are done; paused stragglers converge on contact, and any still paused at old-version end-of-support are upgraded in bulk during a final sweep.

**Per-project dump/restore verification gate** (the promote in the ≤ 10 GB path is blocked until all pass):

1. `pg_restore` completed with zero errors (warnings triaged against an allowlist, e.g. ownership no-ops);
2. object-count parity per schema (tables, indexes, functions, policies) between old and new via the same introspection engine as `db pull` ([migrations §3](04-migrations.md));
3. row-count parity on every user table (exact — the write-freeze makes this a stable comparison);
4. `corebase_migrations.schema_migrations` identical on both sides;
5. `ALTER EXTENSION ... UPDATE` applied and every §2 extension reports the expected version;
6. PostgREST schema cache loads and a synthetic authenticated request round-trips with RLS enforced ([tenant isolation tests](../06-security/03-tenant-isolation-tests.md) smoke subset).

Any failure aborts before promote: the old instance never stopped being live, so an aborted upgrade is a non-event for the customer — retried in the next window with the failure attached to the ops ticket.

**Comms & window policy — the season timeline:**

| When | Action |
|---|---|
| T−90 d | Internal projects + monitoring stack move to PG-new; extension-compatibility gate evaluated (a new major is not offered until every §2 extension has a compatible release in the new image) |
| T−45 d | Volunteer/canary customer projects (opt-in flag); local dev stack (`corebase dev`, D-027) offers PG-new so customers can test before their window |
| T−30 d | Season announced: email + dashboard + status page; **self-serve "upgrade now" button** live (agencies upgrade their dev/staging projects first — free canaries); default per-project windows published, customer-adjustable within the season |
| T 0 | Rolling default windows begin, smallest projects first (fastest, safest path exercises the machinery before the big ones) |
| T+60 d | > 10 GB `pg_upgrade` cohort scheduled windows run |
| T+90 d | Season closes for active projects; unresponsive stragglers upgraded in their published default window; paused projects remain lazy (below) |

**Version bookkeeping:** the control plane records per project the running image digest, Postgres major/minor, and per-extension versions (scraped, not assumed) — the upgrade season is driven off this table, and "fleet is one version" (D-037) is a monitored invariant with an alert, not a hope.

**Cadence stance:** Corebase adopts a new major within ~12 months of its release (skipping majors is allowed — e.g., 17 → 19 — as long as the fleet stays on a version with ≥ 2 years of upstream support remaining); the trigger is upstream support horizon and extension readiness, not novelty (OQ-031).

## Decisions

**D-078 — V1 extension allowlist: `pg_stat_statements` (preloaded), `pgcrypto`, `uuid-ossp`, `pg_trgm`, `btree_gin`, `btree_gist`, `citext`, `pgvector`. V1.1: `postgis` via a variant image, `pg_cron` with the jobs story. Everything else — expressly `dblink`, `postgres_fdw`, `file_fdw`, `adminpack`, untrusted PLs — is denied by absence: only allowlisted extensions exist in the image. Customer roles are never granted `pg_execute_server_program` / `pg_read_server_files` / `pg_write_server_files`.** *(Rationale: extensions with filesystem/network reach break isolation without needing a container escape, and untrusted C code is escape-CVE launchpad; enforcement-by-image-contents cannot be misconfigured; pgvector's demand justifies the one C-extension exception because it has no I/O reach and its memory cost is cgroup-bounded; postgis's dependency tree is quarantined to an opt-in image variant.)*

**D-079 — Major-version upgrades: default is dump/restore blue-green into a new instance with endpoint-swap promote and a 72 h rollback window for projects ≤ 10 GB; in-place `pg_upgrade` in a dual-binary container (fresh full backup first, PITR-based rollback, staged ANALYZE) for > 10 GB; logical-replication blue-green deferred until a paying customer class needs seconds-level cutover. Paused projects upgrade lazily at resume. Season policy: 30-day notice, self-serve early upgrade, extension-compatibility gate, ≤ 90 days canary-to-complete.** *(Rationale: most of a BaaS fleet is small enough that the safest strategy — old instance untouched until an explicit swap, mirroring the restore and promote machinery we already operate — is also fast enough; pg_upgrade is reserved for the sizes where copying hurts more than its weak rollback; logical replication imports the slot-hazard class D-030 exists to avoid, so it must be pulled by revenue, not pushed by elegance.)*

(D-037 governs the single-fleet-version constraint this playbook serves; D-009/D-070 make per-project image swaps mechanically simple.)

## Open Questions

- **OQ-030** — pgvector operational limits on small tenants: HNSW build memory vs the 64 MB `maintenance_work_mem` / 512 MiB cgroup — do we need per-plan guidance (or hard caps) on vector dimensions and index type (IVFFlat on Free)? Needs a benchmark on the Free-tier container spec.
- **OQ-031** — First upgrade season target: adopt PG18 within 12 months of our launch, or hold for 19 and exercise the skip-version path? Decide when PG18's extension ecosystem (pgvector, PostGIS variant) status is observable; feeds [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md).
- **OQ-032** — Extension version pinning per project vs fleet-wide: when the image updates an extension (e.g., pgvector 0.x → 0.y with index-format changes), is `ALTER EXTENSION UPDATE` forced fleet-wide during minor bumps, or customer-triggered with a deprecation window? Leaning fleet-wide-with-notice for security releases, customer-triggered otherwise.

## Dependencies

- Builds on: [decision log](../00-foundation/05-decision-log.md) (D-009, D-030, D-037), [threat model](../06-security/01-threat-model.md), [postgres provisioning](01-postgres-provisioning.md) (image, container lifecycle, pause), [backups & PITR](05-backups-and-pitr.md) (restore/promote machinery reused by upgrades)
- Feeds: [tenant isolation tests](../06-security/03-tenant-isolation-tests.md) (SQL-escape probes), [observability](../11-infrastructure/03-observability.md), [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md), [risk register](../15-risks/01-risk-register.md), [v1 scope & cut list](../14-roadmap/02-v1-scope-and-cutlist.md)
