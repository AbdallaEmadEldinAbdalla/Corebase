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

## How to add an entry

1. Number sequentially (`M-002`, …). Never renumber.
2. State the environment before the numbers.
3. Say explicitly which open question it answers, partially answers, or fails to answer.
4. Say what the number does **not** license. Over-reading one measurement is how a plan gets confidently wrong.

## Dependencies

- Builds on: [milestone 0](04-milestone-0.md) (D-168, D-169), [cost model](../12-business/01-cost-model.md) (D-090, D-091), [multi-tenancy](../01-architecture/03-multi-tenancy-and-isolation.md) (D-174)
- Feeds: [open questions](../15-risks/02-open-questions.md), [cost model](../12-business/01-cost-model.md), [risk register](../15-risks/01-risk-register.md)
