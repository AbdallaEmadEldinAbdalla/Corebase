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
| Image | `corebase/postgres:17.5` (PG 17.5, bookworm) as specced in `infra/docker/postgres` |
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
| Harness | `pnpm --filter @corebase/worker bench`; raw numbers in [measurements/m-002-provisioning.json](measurements/m-002-provisioning.json) |

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

**Incidental finding (feeds T7/T8).** Volumes from earlier runs survive their containers, exactly as designed (`removeContainer` keeps volumes; nothing deletes them yet). Note that `docker volume prune` does **not** remove named volumes without `--all`, so the obvious cleanup command silently does nothing — worth knowing before writing T8's sweeper. A named `cb-*-pgdata` volume with no container and no `project_databases` row is precisely the orphan class T8 must detect and T7 must remove deliberately.

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

## How to add an entry

1. Number sequentially (`M-002`, …). Never renumber.
2. State the environment before the numbers.
3. Say explicitly which open question it answers, partially answers, or fails to answer.
4. Say what the number does **not** license. Over-reading one measurement is how a plan gets confidently wrong.

## Dependencies

- Builds on: [milestone 0](04-milestone-0.md) (D-168, D-169), [cost model](../12-business/01-cost-model.md) (D-090, D-091), [multi-tenancy](../01-architecture/03-multi-tenancy-and-isolation.md) (D-174)
- Feeds: [open questions](../15-risks/02-open-questions.md), [cost model](../12-business/01-cost-model.md), [risk register](../15-risks/01-risk-register.md)
