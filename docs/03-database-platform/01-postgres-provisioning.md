# Postgres Provisioning

## Purpose

Specifies the mechanics of container-per-project Postgres (D-009): what a project's stack physically is, where its data lives, how a project is provisioned in under 30 seconds, how idle projects are paused and resumed (D-008), how a tenant filling its disk is contained before it takes a node down (a gap the proposal never addressed — critique §3), and how the control plane accounts for node capacity when placing projects.

This is the doc the provisioner worker ([job queue & workers](../02-control-plane/04-job-queue-and-workers.md)) executes against, and the doc the [cost model](../12-business/01-cost-model.md) takes its per-project resource floor from.

## Design

### 1. The per-project stack

Each project is exactly three containers plus one Docker bridge network on a shared Hetzner node (D-009, D-023):

```
net_<project_id>  (per-project Docker bridge network)
├── pg_<project_id>        postgres:17-steadhold      512 MiB mem limit (Free), 0.5 CPU
├── pgb_<project_id>       pgbouncer:steadhold         64 MiB mem limit
└── pgrst_<project_id>     postgrest:steadhold        128 MiB mem limit
```

**Per-project bridge network, not a shared network namespace.** The pod-style alternative (`--network container:pg_x`) makes pgbouncer/postgrest share Postgres's netns and talk over localhost — but Docker recreates dependents whenever the anchor container is recreated, which turns every Postgres image bump into a three-container teardown. A dedicated bridge network gives us:

- stable in-network DNS (`db`, `pooler`, `rest`) so container configs are identical across projects;
- independent restart of any container (minor image bumps touch one container);
- isolation by construction: no container outside `net_<project_id>` can reach the project's Postgres. Cross-project traffic is impossible at the Docker network layer, not merely firewalled.

Ingress: the node runs a TCP router that terminates TLS and routes by SNI (`db.<project>.steadhold.app`) to the project's pgbouncer (pooled port) or Postgres (direct port); HTTP traffic to PostgREST/auth arrives via the gateway (D-016). Routing details are owned by [domain & region model](../01-architecture/04-domain-and-region-model.md) and [request pipeline](../04-data-api/02-request-pipeline.md).

Container hardening (read-only rootfs except `PGDATA`, `no-new-privileges`, dropped capabilities, pids limit) is specified in the [threat model](../06-security/01-threat-model.md).

### 2. Volume layout and disk caps

One dedicated volume per project:

```
/data/projects/<project_id>/
├── pgdata/          # PGDATA, owned by container's postgres uid
├── pgbackrest/      # spool/lock dirs (repo itself is in R2, D-019)
└── stack.env        # rendered container config (no secrets; secrets injected at start)
```

**Disk cap mechanism: XFS project quotas** (`prjquota` mount option on `/data`, one XFS project ID per Steadhold project). Comparison:

| | XFS project quota | LVM logical volume per project |
|---|---|---|
| Space model | Thin — quota is a number, raise/lower instantly | Pre-allocated LV; resize = `lvextend` + `xfs_growfs` per project |
| Cost of 400 projects/node | One filesystem, 400 quota entries | 400 LVs; LVM metadata and udev churn at scale |
| Hard cap on writes | Yes — `ENOSPC` at quota | Yes — `ENOSPC` at LV size |
| Isolation of fs metadata/journal | Shared (one fs) | Per-project fs; one corrupted fs doesn't touch others |
| Snapshots | Not available per project | Available, but unneeded — PITR comes from pgBackRest (D-019) |
| Operational fit for pause (volume kept, 0 RAM) | Perfect — paused project holds only its quota | LV sits fully allocated regardless |

XFS project quotas win on plan-change ergonomics (a quota bump is one `xfs_quota` command, no downtime) and on metadata scalability. The lost per-project fs isolation is acceptable because the quota itself prevents the failure that matters (one tenant exhausting the shared volume), and durability against fs corruption is pgBackRest's job, not the volume's. This is **D-070**.

Quota per project = **plan disk cap × 1.2** — headroom for WAL between archivals, temp files, and the delete-to-recover flow below. The plan cap (what the customer sees) is the database-size number in [pricing & plans](../12-business/02-pricing-and-plans.md).

### 3. Postgres config template (small tenant)

Rendered per project from one template; the Free/small-Pro values:

```ini
# memory — container limit 512 MiB
shared_buffers = 128MB
effective_cache_size = 384MB
work_mem = 4MB
maintenance_work_mem = 64MB
huge_pages = off

# connections — customers arrive via PgBouncer (D-015); see 02-connection-pooling.md budget
max_connections = 20
superuser_reserved_connections = 3
password_encryption = scram-sha-256

# WAL / archiving — must stay compatible with pgBackRest (D-019)
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --stanza=<project_id> archive-push %p'
archive_timeout = 300            # Free; 60 on Pro (bounds RPO, see 05-backups-and-pitr.md)
max_wal_size = 1GB
min_wal_size = 128MB
checkpoint_completion_target = 0.9

# observability & safety
shared_preload_libraries = 'pg_stat_statements'
log_min_duration_statement = 1000
log_line_prefix = '%m [%p] %q%u@%d '
listen_addresses = '*'           # reachable only inside net_<project_id>
```

`initdb` runs with `--data-checksums` (required by the restore-verification checks in [backups & PITR](05-backups-and-pitr.md)). Larger plans scale `shared_buffers`/`work_mem`/`max_connections` from the same template; the template is versioned in the control plane so a fleet-wide config change is a recorded migration of the template, not per-node hand edits.

### 4. Provisioning speed: the <30s target

The budget for `project create → READY`:

| Step | Cold path | Pre-warmed path |
|---|---|---|
| Image pull | 10–60s (unacceptable) | 0 — all images pre-pulled at node bootstrap and on every image release |
| Container create + start ×3 | 3–6s | 0 — already running |
| `initdb` + first Postgres start | 3–5s | 0 — already done |
| Steadhold base schema (auth schema, `storage.objects`, helper functions, roles) | 1–2s | 0 — baked into the warm instance |
| Claim + specialize (rename, generate credentials, `ALTER ROLE ... PASSWORD`, render JWT keys, register API keys) | — | 1–3s |
| pgBackRest stanza-create + first archive check | 2–5s (async-able) | 2–5s (async, non-blocking for READY) |
| Gateway/DNS registration | <1s | <1s |

Two candidate designs for eliminating the cold path:

- **Template database**: keep a `template_steadhold` database inside… what? There is no shared instance under D-009 — every project is its own instance, so a template DB only accelerates the base-schema step (~2s), not container start or `initdb`. It solves the wrong 80%.
- **Pre-warmed container pool**: each node keeps N fully-started generic stacks (Postgres initialized with the base schema, pgbouncer and PostgREST up, throwaway credentials). Provisioning = *claim* one, then specialize: assign project ID, create/rename roles with fresh crypto-random passwords, load the project JWT public key into PostgREST config, register the stanza, register routes. Every expensive step moved to idle time.

**Pre-warmed pool wins** (D-071). Target pool: **3 warm stacks per active node**, refilled by a background job within 60s of a claim; a burst deeper than the pool falls back to the cold path (~15–25s with pre-pulled images — still inside the target, just not inside the 5s experience we want for the dashboard). Warm stacks are booked against node RAM like real projects (see §7) so the pool can never oversubscribe a node.

Provisioning remains an idempotent state-machine job (proposal §28–30, §75–76; [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md)) — the pool is an optimization inside the `PROVISIONING` state, not a new lifecycle.

### 5. Pause/resume (D-008) — the economic keystone

A dedicated instance per free project is only affordable because idle projects release their RAM. Density math lives in [multi-tenancy & isolation](../01-architecture/03-multi-tenancy-and-isolation.md) and the [cost model](../12-business/01-cost-model.md); this section is the mechanism.

**Idle detection — two signals, both required:**

1. **No data-plane traffic**: the gateway already meters requests per project (REST, auth, storage) into the control plane; zero requests for the window.
2. **No database connections**: the node agent scrapes pgbouncer (`SHOW STATS`) and Postgres (`pg_stat_activity`, excluding Steadhold-internal roles) into Prometheus; zero client connections for the window.

Window: **7 consecutive days for Free projects** (D-072). Dashboard activity (SQL editor, table editor) counts as traffic — opening your project keeps it awake. Warning email at day 5. Paid tiers do not auto-pause in V1 (OQ-071 tracks opt-in pause for paid).

**Pause procedure** (a normal idempotent job):

1. Mark `PAUSING`; gateway begins returning the resume flow for new requests.
2. Final backup: incremental + WAL flush per **D-078** ([backups & PITR](05-backups-and-pitr.md)) — a paused project must be restorable without its volume.
3. `CHECKPOINT`, then clean-stop Postgres (clean shutdown ⇒ no WAL replay on resume), stop pgbouncer/PostgREST.
4. Containers removed, **volume, network definition, and config kept**; mark `PAUSED`; release `ram_reserved` (disk reservation kept).

**Resume trigger and the 503-vs-hold question.** Options for the first gateway request that hits a `PAUSED` project:

- *Immediate 503 + `Retry-After`*: simplest; but the canonical first-touch is a human loading their app after a week — a raw failure page is the worst possible re-onboarding.
- *Hold the request until ready*: best UX, but unbounded holds pile up gateway connections and upstream timeouts (Cloudflare ~100s) make >30s holds pointless.

**Decision: never hold** (D-172). The first request to a paused project idempotently enqueues the resume job (deduped per project) and **immediately** returns `503` with `Retry-After: 5` and error code `project_resuming`; subsequent requests during resume get the same response. The SDK retries transparently (up to 3 times, at ~5/10/15 s — riding the resume targets below, so the first retry lands at the median resume time). Never-hold keeps gateway concurrency exposure bounded and failure semantics explicit; the earlier hold-≤20 s hybrid is superseded, and OQ-102 (optional long-poll) stays open. Direct TCP connections to a paused project are refused at the SNI router with a Postgres error string pointing at the dashboard; any data-plane API request (or dashboard visit) triggers resume.

**Resume path**: start containers from kept volume/config → clean-shutdown Postgres accepts connections in single-digit seconds (no replay) → node agent health-checks Postgres, pgbouncer, PostgREST → re-register routes → `READY` → resume WAL archiving and schedule a fresh incremental. **Target: p50 < 5s, p95 < 15s** — which is why the SDK's first retry (~5 s) usually finds the project ready. If the original node lacks RAM at resume time, the resume job places the project on another node and restores from backup instead (slower path, surfaced as a status page event).

### 6. Disk-full handling

Never let a tenant reach `ENOSPC` on a shared volume without layers in front of it. An out-of-disk Postgres PANICs mid-WAL-write; on a *shared* volume it would take every tenant on the node with it, and a full disk also breaks WAL archiving — corrupting the PITR story for the neighbors. The XFS quota (§2) is the hard backstop that converts "node down" into "one project's writes fail"; the ladder below exists so customers almost never hit the backstop.

**Enforcement ladder** (evaluated by the node agent against quota usage, D-073):

| Threshold (of plan cap) | Action |
|---|---|
| 80% | Email + dashboard banner: "approaching your database size limit"; metric event for support visibility |
| 90% | Second email; dashboard banner becomes persistent; Free tier: upgrade CTA; ops alert (low urgency) |
| 95% | **Soft read-only**: `ALTER DATABASE <db> SET default_transaction_read_only = on` + terminate idle-in-transaction sessions. Writes fail with a clear error; reads keep working |
| 120% (= XFS quota) | Hard stop: `ENOSPC` confined to this project |

Honesty note: `default_transaction_read_only` is advisory — a session can override it with `SET default_transaction_read_only = off` (**not** `SET transaction_read_only = off`, which applies only to the transaction it runs in and so does nothing under autocommit — D-249). That is deliberate and is also the **recovery path**: the dashboard's "free up space" flow opens a session that disables the flag, lets the customer `DELETE`/`DROP`/`VACUUM`, and re-enables it. The 20% quota headroom above the plan cap exists exactly so the recovery flow (deletes generate WAL) has room to run. The hard guarantee is the quota; the GUC is UX.

Clearing the ladder: dropping back below 90% auto-lifts read-only and clears banners. Upgrade to a bigger plan = one `xfs_quota` limit change, effective immediately.

**Node-level volume** is monitored separately: alert at 75%, **auto-cordon at 85%** (see §7). Because every project is quota-capped and placements are disk-booked, node-volume exhaustion indicates an accounting bug, not a tenant event — it pages.

### 7. Node capacity accounting

Control-plane tables (full DDL in [data model](../02-control-plane/01-data-model.md)):

```sql
nodes(id, region, ram_total_mb, ram_reserved_mb,
      disk_total_gb, disk_reserved_gb,
      status,          -- active | cordoned | draining
      warm_pool_target, heartbeat_at)

placements(project_id, node_id, ram_reserved_mb, disk_reserved_gb, state)
```

- **`ram_reserved` per project** = the **plan RAM budget, not the sum of container limits** (D-174). Free tier: **350 MB booked per active project; paused = 0**. The container memory limits (512 + 64 + 128 + 64 MiB stack overhead = **~768 MiB per triplet**) remain the documented **burst ceilings** — deliberately overcommitted, never booked: the ceilings are never hit simultaneously across a node, and booking them would strand ~55% of node RAM. Safety comes from metering *actual* usage with node-pressure alerts, not from reservation arithmetic. Consequences: the 85% placement stop (below, D-090) yields a **150-active/node design maximum** (D-091), while the fleet-wide average stays **≤75%** per D-148 — plan ~135–140 active per node across the fleet so one node's active load always fits in the survivors plus one emergency node.
- **Paused projects book 0 RAM but keep their disk reservation** — this asymmetry *is* the pause economics.
- **Bin-packing**: new placements go to the active node in the region with the **lowest fill ratio** — the *worse* of its RAM and disk ratios against the 0.85 ceiling — among **all** nodes that fit the booking on both axes (spread-first — favors resume headroom and blast-radius over max density; revisit toward fill-first when node count grows). Ranking all of them rather than picking one matters: a packer that stops at the emptiest node fails with "no capacity" whenever that node is merely too small (**D-252**), and the ranking is what lets a provision that loses a race for the last slot try the next candidate instead of failing (**D-253**). A node whose heartbeat has gone stale is excluded and reported as such, not as full (**D-254**). Warm-pool stacks are booked like projects so they are part of the same arithmetic.
- **Resume headroom**: each node keeps a reserve (the 15% fill ceiling) so paused projects on that node can resume in place. If concurrent resumes exceed the reserve, overflow resumes restore-to-new-node from backup (§5).
- **Cordon** (`status = cordoned`): no new placements or warm-pool refills; existing projects untouched. Used for maintenance, incident isolation, and the 85% disk auto-cordon. **Draining** additionally migrates projects off (backup/restore-based in V1 — no streaming replication per project yet).

## Decisions

**D-070 — Per-project stack is three containers (postgres:17, PgBouncer, PostgREST) on a dedicated per-project Docker bridge network; volumes live on XFS with per-project project quotas (`prjquota`), quota = plan cap × 1.2.** *(Rationale: bridge network gives independent container restarts, uniform in-network DNS, and network-layer tenant isolation; XFS project quotas give instant, thin, per-tenant hard caps without LVM's per-project allocation and metadata burden — durability is pgBackRest's job, not the volume's.)*

**D-071 — *(the warm-pool half is deferred with a trigger by [D-208](../14-roadmap/06-milestone-0-retro.md); image pre-pull stands and is in use)* Provisioning speed comes from pre-pulled images plus a pre-warmed pool of generic, fully-initialized stacks per node (target 3), claimed and specialized at create time; template-database approach rejected.** *(Rationale: under container-per-project the slow steps are container start and initdb, which a template database cannot amortize; a warm pool moves every expensive step to idle time and gets create→READY to ~1–3s, with a ~15–25s cold fallback still inside the 30s target.)*

**D-072 — Pause/resume mechanics: idle = 7 consecutive days with zero data-plane requests AND zero client DB connections (Free tier; warning at day 5); pause = final incremental backup, checkpoint, clean stop, containers removed, volume kept, RAM released; resume is triggered by the first gateway request, answered per D-172 (immediate 503 + `Retry-After: 5`, `project_resuming`; never held); direct TCP to a paused project is refused. Resume target p50 < 5s, p95 < 15s.** *(Rationale: dual-signal idle detection avoids pausing projects used only via direct connections; clean shutdown makes resume replay-free and fast; never-hold request handling per D-172 gives well-behaved clients a working first retry while keeping gateway exposure bounded.)*

**D-174 — Placement books plan RAM budgets, not container limits: `ram_reserved` per active Free project = 350 MB (paused = 0); container memory limits (512 MiB Postgres etc., ~768 MiB per triplet) are deliberately overcommitted burst ceilings, not reservations — safety comes from metering actual usage with node-pressure alerts. The ceilings compose as: per-node placement stops at 85% of bookable RAM (D-090) — the 150-active/node figure (D-091) is the per-node design maximum at that stop — while the fleet-wide average stays ≤75% (D-148), i.e., plan ~135–140 active per node across the fleet so one node's active load always fits in the survivors plus one emergency node.** *(Rationale: booking hard limits would strand ~55% of node RAM against ceilings never hit simultaneously and make the free tier uneconomic — the opposite of D-008's purpose; overcommit-with-metering is how every density platform works; distinguishing the per-node max from the fleet average is what lets D-090, D-091 and D-148 all hold at once.)*

**D-073 — Disk enforcement ladder per project: 80% notify, 90% escalate, 95% soft read-only via `default_transaction_read_only = on` with a dashboard-driven space-recovery flow, hard `ENOSPC` only at the XFS quota (120% of plan cap); node volume auto-cordons at 85%.** *(Rationale: a tenant reaching ENOSPC on a shared volume is a node-wide outage and an archiving failure for neighbors; the ladder makes the hard cap almost unreachable while the quota makes it survivable.)*

**D-184 — Project containers are created with `RestartPolicy: no`; the health gate promotes them to `unless-stopped` after the first successful `pg_isready`.** *(Rationale: found by running T5d. Under `unless-stopped`, a container that cannot initialise restarts forever — the node burns CPU on a doomed boot loop, and the provisioning step sees a permanent `restarting` state instead of an exited container, so it polls to its timeout with nothing useful to report. Promoting the policy after the database answers keeps node-reboot recovery and turns a 60s silent timeout into a 3s specific failure.)*

**D-185 — No `trust` authentication in a project database. The image builds with `POSTGRES_INITDB_ARGS=--auth-local=peer --auth-host=scram-sha-256`, and `init/40-auth-hardening.sql` aborts the boot if `pg_hba_file_rules` contains any `trust` rule or any host rule whose method is not `scram-sha-256`/`cert`/`reject`.** *(Rationale: `initdb` defaults leave `trust` on the local socket and on `127.0.0.1`, which makes any code execution inside the container an unauthenticated superuser login — the same escalation class D-078 removes extensions to prevent, reachable without a container escape. `peer` preserves in-container maintenance for the OS `postgres` user only. Enforcement lives in the image rather than in a runbook because a dropped build argument has no visible symptom until someone is already inside.)*

**D-186 — `postgresql.base.conf` pins no `data_directory`; the data directory is whatever `PGDATA` in the container spec says.** *(Rationale: the volume mounts at `/var/lib/postgresql/data` and `PGDATA` is `…/data/pgdata`, because the mount root can contain `lost+found` and `initdb` refuses a non-empty directory. A path in the fleet-wide config file therefore contradicted the spec on every first boot: `initdb` populated the subdirectory, then the server refused to start on the parent's permissions. The spec is the single source of truth for layout; the config file carries only tuning.)*

## Open Questions

- **OQ-070** — Warm-pool sizing under provisioning bursts (launch days, tutorials): is 3/node + cold fallback enough, or do we need a region-level shared pool target with predictive refill? Revisit with real signup-burst data.
- **OQ-071** — Pause for paid tiers: opt-in pause (with billing pause?) for Pro projects, and whether Free idle window (7d) should tighten under cost pressure or abuse. Owned jointly with [pricing & plans](../12-business/02-pricing-and-plans.md).

## Dependencies

- Builds on: [multi-tenancy & isolation](../01-architecture/03-multi-tenancy-and-isolation.md) (D-009 rationale, density math), [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md), [job queue & workers](../02-control-plane/04-job-queue-and-workers.md), [infra phases](../11-infrastructure/01-infra-phases.md), [decision log](../00-foundation/05-decision-log.md) (D-008, D-009, D-023, D-037)
- Feeds: [connection pooling](02-connection-pooling.md), [credentials & secrets](03-credentials-and-secrets.md), [backups & PITR](05-backups-and-pitr.md), [extensions & upgrades](06-extensions-and-upgrades.md), [cost model](../12-business/01-cost-model.md), [risk register](../15-risks/01-risk-register.md), [observability](../11-infrastructure/03-observability.md)
