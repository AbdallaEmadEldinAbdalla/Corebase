# Measurement Log

## Purpose

A running record of every number the plan assumed and the build later measured. D-169 makes Milestone 0 end with a retro that corrects the cost model and the density/latency assumptions; this file is the evidence that retro reads. Entries are append-only — a superseded measurement is annotated, never edited away, because the *drift* between assumption and reality is itself the finding.

Each entry states the environment, because a number without its hardware is a rumour.

## M-001 — Per-project Postgres container, idle and light load

**Date:** 2026-08-29 · **Task:** Milestone 0, pre-T2 (image build) · **Answers:** partially [OQ-056](../01-architecture/03-multi-tenancy-and-isolation.md), [OQ-090](../12-business/01-cost-model.md)

**Environment (matters — do not re-plan density on this alone):**

| | |
|---|---|
| Host | macOS Docker VM, `linux/aarch64` — **not** the target Hetzner CCX43 (x86, bare-metal-ish) |
| Image | `steadhold/postgres:17.5` (PG 17.5, bookworm) as specced in `infra/docker/postgres` |
| Limits | `--memory 512m --memory-swap 512m --cpus 0.5` (Free-tier shape, D-054/D-055 subset) |
| Config | `shared_buffers=128MB`, `max_connections=20`, `wal_level=logical`, archiving on |
| Scope | **Postgres only** — no PgBouncer, no PostgREST. The triplet is not yet measured. |

**Numbers:**

| Condition | anon (working set) | page cache | cgroup peak |
|---|---|---|---|
| idle, just initialised | **5.0 MiB** | 87.8 MiB | 102.2 MiB |
| 10 concurrent client backends | **27.9 MiB** | — | — |

**Reading it honestly.** The planning figure is 350 MB per *active project* for the whole triplet (D-091). This measures one third of the triplet, idle, on the wrong architecture. What it does suggest is that Postgres' own anonymous footprint is small and that `shared_buffers` lands in shared/page-cache accounting rather than anon — so the reserved-RAM number the bin-packer books (D-174: 350 MB) is likely conservative, and the real constraint may be page cache and disk rather than anon memory.

**What it does not license.** Raising density before the triplet is measured on target hardware. Two of three processes are missing, and page cache is reclaimable in a way that makes "how much RAM does a project need" a policy question, not just a measurement.

**Next measurement to take:** the full triplet (Postgres + PgBouncer + PostgREST) idle and under a light request load, on an x86 host, with 10 and 50 projects co-resident — that is the number D-091 and D-174 actually rest on.

## M-002 — Twenty consecutive project creates, and what twenty live projects cost

**Date:** 2026-08-31 · **Task:** Milestone 0, T5f (the done-signal for T5) · **Answers:** the T5 exit criterion; partially [OQ-070](../03-database-platform/01-postgres-provisioning.md), [OQ-090](../12-business/01-cost-model.md)

**Environment (matters — do not re-plan density on this alone):**

| | |
|---|---|
| Host | macOS Docker Desktop VM, `linux/aarch64`, 7.9 GiB VM RAM — **not** the target Hetzner CCX43 |
| Topology | Docker staging substitute: control-db + control-redis + one Docker-in-Docker data node driven over mTLS |
| Path measured | `POST /v1/projects` → poll `GET /v1/projects/:ref` to `ready` → connect on the returned `direct` string → `CREATE TABLE` + `INSERT` + `SELECT` |
| Node declared | 16384 MB so twenty Free projects sit under the 85% fill ceiling (D-090); a capacity refusal would measure the wrong thing |
| Scope | **Postgres only** — no PgBouncer, no PostgREST, no warm pool (D-071 unbuilt). This is the cold path. |
| Harness | `pnpm --filter @steadhold/worker bench`; raw numbers in [measurements/m-002-provisioning.json](measurements/m-002-provisioning.json) |

**Provisioning latency — 20/20 succeeded, 0 over the 60s budget:**

| | min | p50 | p95 | max | mean |
|---|---|---|---|---|---|
| create → `ready` | 2446 ms | 2463 ms | 3264 ms | 3264 ms | 2624 ms |
| `ready` → first statement returns a row | — | 23 ms | — | — | — |

The exit criterion was **<60s each**; the slowest was **3.26s**, ~18× inside budget. A single warm-up create precedes the twenty and is reported separately at **7439 ms** — the first create on a node with a cold engine, which is a different thing and is not averaged in.

**Where the time actually goes** (per saga step, 21 runs, from the worker's own duration logs):

| Step | p50 | max |
|---|---|---|
| `wait_healthy` | 2095 ms | 2763 ms |
| `start_container` | 186 ms | 3258 ms |
| `store_credentials` | 32 ms | 102 ms |
| `create_base_roles` | 18 ms | 63 ms |
| `allocate_node` | 4 ms | 35 ms |
| `create_volume` | 4 ms | 666 ms |
| `mark_ready` | 2 ms | 3 ms |
| `write_connection` | 1 ms | 5 ms |

Two things fall out. **~85% of a create is `wait_healthy`** — waiting for `initdb` and a first Postgres start, which no amount of control-plane tuning touches. The control plane's own work (placement, role DDL, three envelope-encrypted credentials, connection row, readiness gate) totals **57 ms at p50**; the Docker-facing steps total 2285 ms. And the tail is `start_container`: p50 186 ms against a max of 3258 ms — a 17× spread on a step that is one Engine API call, so the occasional multi-second create is Docker's container start rather than anything in the saga. Two earlier runs of this harness each threw one slow create (7.0s and 10.6s). The 10.6s one was the harness's own fault — it started the clock before the worker had finished booting, and the fix was to wait for node registration. The 7.0s one predates per-step logging and was never attributed; the `start_container` spread above is the leading candidate, and per-step durations now ship on every run so the next one will not need guessing.

This is direct evidence for D-071: a warm pool eliminates exactly the two steps that cost anything. It is also evidence that D-071 is **not needed for the M0 target** — it is needed for the ~1–3s perceived create the dashboard wants.

**Resource cost of twenty-one live projects on one node:**

| | |
|---|---|
| Containers running | 21 |
| RAM **booked** by placement (D-174: 350 MB each) | 7350 MB (44.9% of the declared node) |
| RAM **actually used**, all containers | **524.4 MiB total** — mean 25.0, min 22.6, max 27.1 MiB |
| Ratio booked : actual | ≈ **14 : 1** |
| Node VM in use (everything, page cache included) | 1284 MiB of 7936 MiB |
| Disk | 1.216 GB across 21 volumes (~59 MB per project) |

**Reading it honestly.** The 14:1 gap between booked and actual RAM is consistent with M-001 and with D-174's premise that booking plan budgets rather than container ceilings is right — but these are freshly-created idle databases with one three-row table: no working set, no connections, no warmed page cache. M-001's single-container numbers (5.0 MiB anon idle → 27.9 MiB at 10 client backends) remain the better guide to what a *used* project costs. Disk per project (~59 MB for an empty database) is a new number and is the more predictable one.

**What it does not license.** Raising density (D-091's 150/node) on this evidence. Twenty-one idle databases on ARM with no clients attached is the cheapest corner of the state space; two of three triplet processes are absent; and the binding constraint at real density is expected to be page cache and disk, neither of which this stresses. It also does not license dropping the 350 MB booking — the booking exists to survive projects that *are* used.

**Incidental finding (feeds T7/T8).** Volumes from earlier runs survive their containers, exactly as designed (`removeContainer` keeps volumes; nothing deletes them yet). Note that `docker volume prune` does **not** remove named volumes without `--all`, so the obvious cleanup command silently does nothing — worth knowing before writing T8's sweeper. A named `sh-*-pgdata` volume with no container and no `project_databases` row is precisely the orphan class T8 must detect and T7 must remove deliberately.

**Next measurement to take:** the full triplet under light request load on x86, with 10 and 50 projects co-resident; and a create-latency run *after* the warm pool exists, to see what D-071 actually buys against the 2463 ms cold p50.

## M-003 — Crash recovery: how long a killed provision takes to converge

**Date:** 2026-08-31 · **Task:** Milestone 0, T6 (crash-resume proof) · **Answers:** the T6 exit criterion; corrects the heartbeat/orphan figures in [job queue & workers](../02-control-plane/04-job-queue-and-workers.md)

**Environment:** same Docker staging substitute as M-002 (ARM Docker Desktop VM, one dind data node). Worker heartbeat 10 s, orphan threshold 30 s, sweep interval 10 s, BullMQ `lockDuration` 60 s.

**Method:** for each of 11 points in the provisioning saga, `SIGKILL` the worker at that exact moment (matched on its own step logs), restart it, and measure time-to-`ready` from the restart. Seven points are step boundaries (a checkpoint exists); four are mid-step, where no checkpoint exists and the whole step must re-run. Every run then asserts: exactly one container, one volume, one `project_databases` row, three credential rows, `ram_reserved_mb` booked exactly once, and a database usable on the credential the API hands out.

**Numbers:**

| | min | p50 | max |
|---|---|---|---|
| restart → `ready` | 30.5 s | 30.9 s | 33.2 s |

11/11 converged with every invariant held.

**Reading it honestly.** The 30 s floor is not work — it is the liveness window. A worker cannot be declared dead faster than the threshold that defines death, and the threshold is three missed 10 s heartbeats (D-193). Actual re-execution after the row is declared orphaned is 0.5–3 s, the same as a cold create. So recovery latency is a *policy* number: shortening it means shortening the heartbeat, and the floor moves with it.

**What it cost to get here.** The first run of this matrix did not fail slowly — it failed permanently. Two defects, neither visible to any test that existed:

1. The orphan threshold (90 s) outlived BullMQ's re-delivery (~30 s), so the re-delivery arrived while the row still looked healthy, `claim` refused it, and BullMQ marked that delivery *complete*. Nothing retried. The project stayed `creating` forever. (**D-193**)
2. The sweeper's re-enqueue was a no-op against the dead worker's delivery record, so even once the row was recognised as orphaned it could not be re-delivered. Once fixed by waiting for the lock, recovery cost 60 s — the full `lockDuration` — for a worker Postgres had known was dead for 30. (**D-194**)

**What it does not license.** Claiming crash-safety for the *deletion* saga (T7) or for pause/resume, neither of which exists. It also does not prove behaviour under a node reboot, where containers vanish rather than a worker — that is T8.

**Next measurement to take:** the same matrix against the deletion saga once T7 lands, and node-reboot convergence for T8.

## M-004 — The full lifecycle, twenty times, and what it leaves behind

**Date:** 2026-08-31 · **Task:** Milestone 0, T7 (deletion saga) · **Answers:** the T7 exit criterion

**Environment:** same Docker staging substitute as M-002/M-003. Recovery window compressed from 7 days to 1 second and the purge scan to 2 s; every other part of the purge path — the scan, the job row, the `verify_purgeable` guard, the saga — runs exactly as it would after seven real days.

**Method:** 20 cycles of `POST /v1/projects` → `ready` → connect on the returned credential and write a row → `DELETE` → `soft_deleted` → *(window closes)* → `deleted`, all through the HTTP API and the running worker. Nothing calls a saga directly. Then list the node and the control plane and assert nothing named `sh-*` remains.

**Numbers:**

| | p50 | max |
|---|---|---|
| create → `ready` | 2450 ms | 2678 ms |
| `DELETE` → `soft_deleted` | 416 ms | 621 ms |
| window closed → `deleted` | 1220 ms | 3070 ms |

**Residue after 20 cycles:**

| | |
|---|---|
| containers named `sh-*` on the node | **0** |
| volumes named `sh-*` on the node | **0** |
| node RAM still booked | **0 MB** |
| credential rows | **0** |
| placement rows | **0** |
| project rows | 20, all `deleted` |

**Reading it honestly.** The soft delete is fast (416 ms) because it is cheap by design: stop a container, write two timestamps. The purge is dominated by scan latency, not work — the numbers cluster around 1.0 s and 1.2 s because the scan runs every 2 s in this configuration and the cycle lands wherever it lands. The interesting figure is the residue table, and specifically **0 MB still booked**: a 350 MB-per-project capacity leak is invisible until a node refuses to place work it has room for, and no test other than a loop like this would notice it.

The `project_databases` row is deleted at purge, not retained. That is not an aesthetic choice: `UNIQUE (node_id, port)` means a retained row holds its port forever against a range of a thousand per node, so keeping placement history would slowly starve a long-lived node of ports. Project rows *are* retained, because a `ref` is never reused (D-061) and a purged project must never be confusable with a new one.

**What it does not license.** Any claim about deletion under crash. The T6 kill matrix covers the provisioning saga only; the same treatment for `delete_project` and `purge_project` has not been run, and the irreversible half of a purge is where a crash matters most. It also does not exercise the real 7-day window, restore-within-window (unbuilt), or a final backup (unbuilt — the D-066 gate exists and is off).

**Next measurement to take:** the kill matrix against the deletion and purge sagas, and node-reboot convergence for T8.

## M-005 — Node reboot: how long until every project is serving again

**Date:** 2026-08-31 · **Task:** Milestone 0, T8 (reconciliation sweep) · **Answers:** the T8 exit criterion

**Environment:** same Docker staging substitute. Reconcile interval shortened from the production 5 minutes (D-065/D-173) to 5 s so the drill finishes in a minute; the interval is a policy number, and what is under test is whether the sweep converges at all.

**Method:** five projects provisioned to `ready`. One container removed outright (volume kept) so something genuinely needs rebuilding rather than restarting. One project's rows deleted while its container stays, planting an orphan the sweep must report and must **not** delete. Then `docker restart` the data node and wait, touching nothing by hand. Each project is finally checked by connecting through the API's connection string and running a query.

**Numbers:**

| | |
|---|---|
| node Engine API back after restart | 4.7 s |
| every surviving container running again (Docker's restart policy) | within that window |
| removed container rebuilt and serving queries (reconciliation) | **5.2 s** from the reboot |
| projects answering queries afterwards | 4 of 4 |

Final sweep report:

| class | ref | action |
|---|---|---|
| `container_not_running` | the removed one | `repair_enqueued` |
| `orphan_container` | the planted orphan | `alert_only` |
| `orphan_volume` | the planted orphan | `alert_only` |
| `reservation_drift` | — | `recomputed` |

**Reading it honestly.** Two different mechanisms are at work and the drill separates them deliberately. Containers came back because **Docker's restart policy** restarted them — D-173 says exactly that, and reconciliation is not what recovers a reboot. What reconciliation recovered is the container that was *gone*, which no restart policy can help with; that took one sweep interval plus the saga's own ~2 s, and the volume surviving is why the rebuilt database came back with its data rather than as a fresh one.

The orphan pair is the more important half of the result. Both were reported and both were left exactly where they were. A reconciler that deleted an orphaned volume would be worse than no reconciler at all: the volume is a customer's database whose row went missing, and the container is often the only remaining evidence of what existed.

**What it does not license.** Anything about a real node reboot: `docker restart` on a Docker-in-Docker container is not a kernel boot, and it does not exercise cloud-init, disk remount, XFS quota re-application, or a node that comes back with a different address. It also does not cover the drift classes that have no implementation because their subsystems do not exist — the gateway-route class in particular.

**Next measurement to take:** the same drill against a real VM reboot once a real node exists (OQ-165), and the kill matrix against the deletion and purge sagas.

## M-006 — What the monitoring stack itself costs, and the series it produces

**Date:** 2026-08-31 · **Task:** Milestone 0, T9 (observability seed) · **Answers:** partially the single-node-Prometheus premise in D-146

**Environment:** the T9 staging stack — Prometheus 3.1, Loki 3.3 (single binary, filesystem chunks), Grafana 11.5, Alloy 1.5 — beside the control node on the same Docker VM. Production puts these on a separate mon-1 with R2-backed storage. Scrape interval 5 s here against production's 15 s, so per-series sample rates are 3× higher than they will be.

**Resident cost, all four containers, with 20 projects' worth of history:**

| | memory | disk |
|---|---|---|
| Prometheus | 54.5 MiB | 1.4 MB |
| Loki | 124.5 MiB | 0.6 MB |
| Grafana | 92.5 MiB | 25.1 MB |
| Alloy | 48.1 MiB | <1 KB |
| **total** | **~320 MiB** | ~27 MB |

**Series produced:**

| | |
|---|---|
| Prometheus head series, everything | 912 |
| `steadhold_*` series | **156** |
| largest family: `steadhold_provisioning_step_seconds_bucket` | 80 (8 steps × 10 buckets) |
| `steadhold_api_requests_total` | 2 (method × route pattern × status class) |
| series carrying `project_ref` | **0** |

**Reading it honestly.** 320 MiB for the whole monitoring stack supports D-146's premise that a single Prometheus is enough for a long time — this is a fraction of one project's RAM booking. The number that matters more is the last row: **zero** platform series carry `project_ref`. D-146 projects ~25 series per project at 10k projects ≈ 250k series, and every one of those comes from cAdvisor and postgres_exporter, neither of which exists yet. So this measurement says the *platform* half of the budget is nearly free; it says nothing yet about the per-project half, which is the half that can sink a single node.

The step histogram is already the largest family at 80 series, from 8 steps × 10 buckets. That is fine at one node and stays fine — the labels are `job_type` and `step`, neither of which grows with tenants. It is worth noticing anyway, because it is the shape that becomes 600k series the moment someone adds `project_ref` to it, which is exactly why the harness asserts nobody has.

**What it does not license.** Any conclusion about Prometheus at scale. There are 20 projects here and no exporters; the interesting question is 10k projects with cAdvisor and postgres_exporter attached, and this measures neither. It also runs at a 3× higher scrape rate than production, which inflates disk per series and deflates nothing.

**Next measurement to take:** head series and Prometheus RSS with cAdvisor plus one multi-target postgres_exporter attached, at 50 and 500 projects — the point where D-146's per-project budget is actually tested.

## M-007 — How long pause and resume actually take

**Date:** 2026-09-01 · **Task:** Phase 2, P2c (pause/resume) · **Answers:** the latency half of Phase 2's exit criterion 2

**Environment:** the staging substitute — Docker-in-Docker on an arm64 laptop, one project on the node, no client load beyond the harness. The project's stack is Postgres + PgBouncer; PostgREST is Phase 5 and absent. Timed through the real HTTP API and the real worker, from `POST /v1/projects/:ref/resume` returning 202 to the project reporting `ready`, so the queue hop is inside the number.

**Twenty consecutive pause/resume cycles on one project:**

| | p50 | p95 | max |
|---|---|---|---|
| pause | 746 ms | 790 ms | 790 ms |
| **resume** | **546 ms** | **1199 ms** | 1199 ms |

Target: resume p50 < 5 s, p95 < 15 s ([provisioning §5](../03-database-platform/01-postgres-provisioning.md)). Measured **9× inside** the p50 target and **12× inside** p95. First provision of the same project, for scale: 2.9 s.

**Reading it honestly.** The reason resume is faster than the first provision is that it skips everything expensive: no volume creation, no role setup, no credential generation, no key minting — it starts two containers against a volume that is already correct. And the reason it is faster than the *doc's* estimate is the clean shutdown: the pause runs `CHECKPOINT` and stops Postgres gracefully, so the resumed database has no WAL to replay. That is asserted separately rather than inferred — a test greps the resumed instance's log for `redo starts at` and fails if recovery ran.

The pause being *slower* than the resume is not an anomaly worth optimising. It contains a checkpoint and a graceful stop, which is work deliberately moved out of the resume path where a customer is waiting.

**What it does not license.** Nothing about resume under contention, which is the case that will matter. One project resuming on an idle node is the easy end: the interesting numbers are fifty projects resuming at once after a node reboot, a resume that has to wait behind other jobs in the queue, and a resume onto a node that filled up while the project slept — which today does not resume at all but stops with the node named, because placing it elsewhere needs backups (Phase 3). It also says nothing about the *idle detection* half of the criterion, which is asserted by tests rather than timed, and nothing about a cold page cache: twenty cycles on one project keep the volume's pages warm in the host, and a project paused for a week will not be.

Per D-209 this may not be used to re-base any density or RAM planning number: one project, ARM, idle, no data plane.

**Next measurement to take:** resume latency with 20 projects resuming concurrently, and after a real interval rather than seconds — the two conditions that separate this number from the one customers will see.

## M-008 — One hundred projects on one node, with clients attached

**Date:** 2026-09-01 · **Task:** Phase 2, P2g (exit criterion 1) · **Answers:** the functional half of criterion 1; partially [OQ-090](../12-business/01-cost-model.md); adds a new finding to [R-2](../15-risks/01-risk-register.md)

**Environment (matters — do not re-plan density on this alone):**

| | |
|---|---|
| Host | macOS Docker Desktop VM, `linux/aarch64`, **7934 MiB** VM RAM, 10 vCPU — **not** the target Hetzner CCX43 (x86) |
| Topology | Docker staging substitute: control-db + control-redis + one Docker-in-Docker data node over mTLS |
| Node **declared** | 41984 MB RAM / 168 GB disk — **a fiction**, and the one deliberate lie in the run. Placement books the plan budget (D-174: 350 MB/project), so 100 projects reserve 35 GB and the 85% stop needs a ~41 GB node. Declaring the truth would have measured the bin-packer's refusal, which P2f already proves twice, and nothing about density |
| Per-org ceiling | raised from 20 to 120 for the run. The ceiling is an abuse control, not a capacity one, and it was the first wall this hit: 20 created, 80 refused with a 409, the node nowhere near its limits |
| Stack | **postgres + pgbouncer** — no PostgREST (Phase 5). Two containers per project, not three |
| Load | 2 connections per project (200 total), each with its own table of 500 rows, looping an aggregate query for 60 s |
| Harness | `pnpm --filter @steadhold/worker density`; raw numbers in [measurements/m-008-density.json](measurements/m-008-density.json) |

**It holds. 100/100 projects, 200 containers, no failures.**

| | |
|---|---|
| Provisioned | **100/100** in **98.9 s** at concurrency 4 |
| create → `ready` | p50 **3514 ms**, p95 **5309 ms**, max **6247 ms** |
| Connections attached | **200/200**, none refused |
| Statements in 60 s | 1,414,854 |

Create latency is ~1.4× M-002's 2463 ms single-stream p50 while doing four at a
time *and* starting a pooler each — still 5× inside the 30 s target.

**What a project actually costs (anon working set, cgroup v2):**

| | idle | under load |
|---|---|---|
| All 200 containers | 868 MiB | **1306 MiB** |
| Per project (db + pooler) | 8.68 MiB | **13.06 MiB** |
| — its Postgres | 7.5 MiB | 11.9 MiB |
| — its pooler | 1.2 MiB | 1.2 MiB |
| Booked by placement | 350 MB | 350 MB |
| **Booked : used** | **40 : 1** | **27 : 1** |

`anon` rather than `usage` on purpose: `usage` includes page cache, which a node
under pressure reclaims, so quoting it as the cost of a project overstates it by
whatever the kernel happened to be holding. It is also what M-001 measured, which
keeps the two comparable — and they agree: M-001 saw 5.0 MiB idle and 27.9 MiB at
ten backends for Postgres alone; this sees 7.5 MiB idle and 11.9 MiB at two.

**The finding is not the memory. It is the CPU.**

| | idle | under load |
|---|---|---|
| Node memory used (incl. page cache) | 5726 / 7934 MiB | 6169 / 7934 MiB |
| Node `MemAvailable` | 2208 MiB | **1765 MiB** |
| **Cores busy** | — | **8.21 of 10** |

RAM was over-booked 27-fold while **CPU sat at 82%** with two connections per
project. The cost model books RAM and reasons about density in RAM (D-091, D-174);
on this evidence, with clients attached, the resource that runs out first is CPU.
That is a claim about *this* hardware — 10 ARM vCPU against a CCX43's 16 dedicated
x86 cores — and the ratio of cores to RAM differs on the target. But it is the
first measurement here taken with load attached, and it points at a different
binding constraint than the one the model watches.

**Disk: 8.3 MiB per project**, from `pg_database_size` — the same source the
enforcement ladder and billing use. Not comparable to M-002's ~59 MB, which was
volume footprint (WAL, backup label, filesystem overhead); the two answer
different questions and the earlier number is the one that matters for capacity.

**The pooler is ~10× cheaper than budgeted.** [Connection pooling](../03-database-platform/02-connection-pooling.md)
budgets 10–20 MiB RSS per pooler; the measured anon working set is **1.2 MiB**, flat
between idle and 200 attached connections. Its 64 MiB container ceiling is 53× the
observed working set.

**Reading it honestly — what this may and may not do.**

Under **D-209**, the 350 MB budget and D-091's 150-active/node may only be re-based
on a measurement with the full triplet, x86 launch-SKU-class hardware, ≥50
co-resident projects, and client load. This run satisfies **two of four**: 100
co-resident projects and real client load. It cannot satisfy the other two —
PostgREST is Phase 5, and this is ARM. So none of the numbers above move a planning
figure, and that is D-209 working as intended rather than a shortfall in the run.

What it does establish: the platform *functions* at the target density, the
control plane places and provisions 100 projects on one node without a failure,
and the direction of the earlier evidence holds with clients attached — booked RAM
is roughly 27× used, not 3× as a pessimist would have guessed.

**What it does not license.** Lowering the booking. The 350 MB exists to survive a
project that is *used*, and two connections running one aggregate query is not a
used project — it is a floor with clients on it. Nor does it license any statement
about the third container, which is absent, or about x86.

**Next measurement to take:** the full triplet on x86 launch-SKU hardware with ≥50
co-resident projects and load — the one D-209 actually asks for, and the only one
that can re-base D-091. Separately, a CPU-first density run: raise connections per
project until something saturates, and find out whether the binding resource on
target hardware is cores or memory. That question is now the interesting one.

## How to add an entry

1. Number sequentially (`M-002`, …). Never renumber.
2. State the environment before the numbers.
3. Say explicitly which open question it answers, partially answers, or fails to answer.
4. Say what the number does **not** license. Over-reading one measurement is how a plan gets confidently wrong.

## Dependencies

- Builds on: [milestone 0](04-milestone-0.md) (D-168, D-169), [cost model](../12-business/01-cost-model.md) (D-090, D-091), [multi-tenancy](../01-architecture/03-multi-tenancy-and-isolation.md) (D-174)
- Feeds: [open questions](../15-risks/02-open-questions.md), [cost model](../12-business/01-cost-model.md), [risk register](../15-risks/01-risk-register.md)
