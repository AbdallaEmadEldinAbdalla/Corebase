# Milestone 0 — Retro

## Purpose

D-169 makes this retro part of Milestone 0, not an optional follow-up: the milestone ends by replacing the plan's assumptions with the build's measurements, correcting the [cost model](../12-business/01-cost-model.md), the density decisions (D-090/D-091/D-174) and the [risk register](../15-risks/01-risk-register.md) where the data warrants it — **and refusing to correct them where it does not.**

That second half is the harder discipline. Six measurements now exist where there were assumptions, and every one of them points in the comfortable direction: projects are cheaper than planned, provisioning is faster than budgeted, recovery works. The temptation is to bank that as headroom. This retro does not, and §4 says exactly why: every number was taken in the cheapest corner of the state space available, and the two things that actually bound density were not measured at all.

## Design

### 1. What Milestone 0 built

Ten tasks, each with a command that proves it and a commit trail tagged `M0/Tx`. The [milestone doc](04-milestone-0.md) carries the task-by-task table with evidence and substitutions. In one sentence: `POST /v1/projects` produces a real, isolated PostgreSQL 17.5 database with its own volume, cgroup limits, role model and envelope-encrypted credentials in about 2.5 seconds; deleting it keeps the data for a recovery window and then a scheduled purge returns every resource; a killed worker resumes without duplicating anything; a rebooted node converges without a human; and all of it is scraped, logged and alerted on.

The substitution that shaped everything: **Docker in place of paid hosting.** The topology is reproduced locally — a control node and a data node driven over the Docker Engine API with mutual TLS — so no step of the plan was skipped and nothing was rented. What that substitution costs is stated wherever it matters, and §4 lists it as the largest single limit on what these numbers mean.

### 2. Assumptions versus measurements

| The plan assumed | Where | Measured | Verdict |
|---|---|---|---|
| Postgres 17 idle RSS **150–300 MB** | cost model A.2 | **102.2 MiB** cgroup peak; 5.0 MiB anon + 87.8 MiB page cache ([M-001](05-measurements.md)) | **Conservative by 1.5–3×** — but see the units warning below |
| Per-active-project total **250–400 MB**, planning 350 MB | A.2, D-091 | **unmeasured** — PgBouncer and PostgREST do not exist yet | **Untested.** Postgres is one third of the triplet |
| Paused-project residual **0.5–2 GB NVMe** | A.2 | **~59 MB** per empty database ([M-004](05-measurements.md)) | **Pessimistic by 8–30×.** Corrected |
| Active projects per 64 GB node **120–180**, planning 150 | A.3, D-091 | **21 co-resident**, on a 7.9 GiB ARM VM | **Untested.** Nowhere near the interesting number |
| Booking 350 MB per active project overcommits deliberately | D-174 | 21 projects booked **7350 MB**, used **524 MiB** — ≈**14:1** | **Premise confirmed** for idle projects |
| Create → READY **< 60 s** | phase plan, T5 | p50 **2.46 s**, max **3.26 s** ([M-002](05-measurements.md)) | **Met with ~18× margin** |
| Warm pool needed to hit create-time targets (D-071) | provisioning §4 | cold path already 2.5 s; ~85% of it is `initdb` | **Not needed for the M0 target.** Deferrable |
| Crash-resume is a tested property (R-6 mitigation) | risk register | 11/11 kill points converge, p50 **30.9 s** ([M-003](05-measurements.md)) | **Now true.** It was not before — the first run found a permanent stall |
| Delete leaves no residue (T7 done-signal) | milestone doc | 20 cycles → 0 containers, 0 volumes, **0 MB still booked** ([M-004](05-measurements.md)) | **Confirmed** |
| Node reboot converges without human action (T8) | milestone doc | every project serving again, worst case **5.2 s** ([M-005](05-measurements.md)) | **Confirmed**, with a caveat on what a dind restart is not |
| Single-node Prometheus suffices (D-146) | observability | whole monitoring stack **~320 MiB**, 156 `corebase_*` series | **Supported for the platform half only** |
| Per-project series ≤ ~25, `project_ref` never on high-cardinality labels (D-146) | observability | **0** platform series carry `project_ref`; enforced by a check | **Held, and now regression-guarded** |

**The units warning, because it is the easiest place in this document to fool ourselves.** M-001's 102.2 MiB and M-002's 25.0 MiB mean are *different quantities*, not a disagreement. M-001 measured the cgroup's peak, which includes page cache; M-002 read `docker stats`, which excludes inactive file cache. Both are honest measurements of a freshly-initialised idle Postgres. **Planning must use the larger one**, because page cache is not free — it is reclaimable, which is a different thing — and because a project with clients attached grows: M-001 measured anon memory going from 5.0 MiB idle to 27.9 MiB at ten client backends, a 5.6× move from the cheapest possible state.

### 3. What changes

**Corrected, with evidence:**

- **Paused-project disk residual: 0.5–2 GB → ~60 MB baseline plus customer data** (D-207). An empty project's volume measures ~59 MB, so the assumption was pessimistic by 8–30×. This *strengthens* the pause multiplier that the whole model rests on: the residual cost of a paused project is now dominated by its backup objects in R2, not its volume.
- **D-071's warm pool moves from "needed" to "deferred with a trigger"** (D-208). The cold path is 2.5 s against a 60 s budget, and per-step attribution shows ~85% of it is `initdb` plus a first Postgres start — precisely what a warm pool removes. It is still the right optimisation for the ~1 s perceived create the dashboard wants; it is not on the critical path for launch.
- **R-6 (provisioning corruption) drops from exposure 9 to 6** — the kill matrix exists, is green at eleven kill points, and guards two defects that would each have stranded projects permanently. Deletion and purge are *not* in the matrix yet, which is why the likelihood drops one point and not two.
- **R-2 (free-tier economics) keeps exposure 15** and gains a measured baseline in its early-warning signal, so "RSS > 400 MB/project" is now a threshold against a known floor rather than against nothing.

**Explicitly not changed:**

- **The 350 MB per-active-project planning budget stands** (D-209). Every instinct says reduce it — the first data is 3× under. Doing so would be the single most expensive mistake available in this document, because the measurement covers one of three processes, on the wrong architecture, with no clients attached, in the state a project spends the least of its life in.
- **D-091's 150 active/node stands.** 21 co-resident projects on an 8 GiB VM says nothing about 150 on a 64 GB node, and the constraint that actually binds at density — page cache and disk contention across co-tenants — was not stressed at all.
- **D-090's 85% placement stop and 1,200-project cap stand.** The cap is a blast-radius bound, not a capacity one; no measurement here speaks to it.

### 4. What these numbers do not license

Stated plainly, because every table above reads better than the situation warrants:

| Limit | Consequence |
|---|---|
| **ARM, not x86.** Everything ran on an Apple-silicon Docker VM | Memory figures do not transfer directly; Hetzner CCX43/AX52 is the number that matters |
| **Postgres only.** No PgBouncer, no PostgREST | Two thirds of the per-project RAM budget is unmeasured, and it is the two thirds that has no `shared_buffers` to hide in page cache |
| **Idle, no clients.** One three-row table per project | The cheapest corner of the state space. M-001 already shows a 5.6× anon move at ten connections |
| **21 projects, not 150** | The interesting failure mode is co-tenant page-cache and IO contention, which needs density to appear |
| **No exporters.** cAdvisor and postgres_exporter are unbuilt | The per-project half of D-146's cardinality budget — the half that can sink a single Prometheus — is entirely unmeasured |
| **`docker restart` is not a kernel boot** | No cloud-init, no disk remount, no XFS project-quota re-application, no address change (OQ-165) |
| **No backups, no pause/resume** | Two of the model's load-bearing mechanisms (D-008's pause multiplier, D-019's durability) have no measurements at all |

**The single measurement that would move the model most:** the full triplet under light request load on x86, with 10 and 50 projects co-resident, plus cAdvisor and one multi-target postgres_exporter attached. That answers the per-project RAM budget, the per-project cardinality budget, and the first honest read on co-tenant contention — three of the four things §3 refused to change.

### 5. What the build taught us about the plan

**Twenty-three decisions (D-184…D-206) came out of executing rather than planning.** That is ~11% of the corpus's decisions, produced by ten tasks — and the *classes* are more useful than the count:

| Class | Count | Examples |
|---|---|---|
| The plan's own documents contradicted each other | 6 | `data_directory` pinned in two places (D-186); `project_secrets` column names (D-188); the purge modelled as a mode (D-196) |
| A safe-looking default was wrong | 7 | `initdb` leaves `trust` auth (D-185); `unless-stopped` makes a failed container flap (D-184); FORCE RLS breaks the customer's first insert (D-191) |
| Two numbers with a hidden relationship drifted apart | 2 | Orphan threshold vs heartbeat interval (D-193); delivery id vs BullMQ's charset (D-197) |
| A promise had no visible surface | 3 | No recovery deadline in the API (D-205); no reconciliation timestamp (D-201); no request_id in worker logs |
| A library constraint reached further than expected | 2 | BullMQ rejects `:` in both queue names and job ids (D-197) |

Two conclusions, and they pull in opposite directions, which is the honest result.

**The corpus was directionally right and locally wrong.** Not one decision reversed an architectural choice: container-per-project, the control/data plane split, two-phase enqueue, envelope encryption, check-then-act sagas and reconciliation all survived contact with the build intact. Every correction was a level down — a flag, a threshold, a column name, an ordering. Planning at that depth bought real leverage.

**And no amount of planning would have found these.** The three worst defects of the milestone — a worker crash stranding a project forever (D-193/D-194), `trust` authentication in every project database (D-185), FORCE RLS breaking the customer's very first `INSERT` (D-191) — were each invisible on paper and immediate in execution. Two were found by tests written *because* the step demanded a done-signal; one was found by using the product as a customer. The per-step "test it, verify it live, split-commit it" discipline is what converted them from latent production incidents into an afternoon's work.

The synthesis: plan deeply, then distrust the plan's *details* specifically and let execution correct them fast. The corpus's real value was not being right about flags — it was that every correction had a place to land and a decision log to be argued with.

### 6. Process observations worth keeping

- **A test that cannot run must fail, never skip.** A silently-skipped integration suite hid a BullMQ queue-name bug behind a green run. This is now a standing rule and every integration suite throws with the reason and the fix command.
- **Live verification finds a different class of bug than tests do.** FORCE RLS, the missing recovery deadline, and a volume leaking from our own health check were all found by using the thing, not by asserting about it.
- **Per-step attribution turns folklore into findings.** "Creates are sometimes slow" became "`start_container` has a 17× spread on one Engine API call" the moment step durations were logged — and the logging cost four lines.
- **A measurement's environment is part of the measurement.** Every entry in the log states what it does *not* license. That section is what makes the log safe to read in six months.

## Decisions

- **D-207 — Paused-project disk residual is re-based from 0.5–2 GB to ~60 MB baseline plus customer data.** *(Rationale: measured at ~59 MB per empty project volume (M-004); the original figure was pessimistic by 8–30×. The correction strengthens rather than weakens the pause multiplier, and moves the dominant residual cost of a paused project from NVMe to its R2 backup objects.)*

- **D-208 — D-071's warm pool is deferred with an explicit trigger, not built for Milestone 0 or launch. Trigger: a create-latency target below ~1.5 s (a dashboard UX decision), or a measured cold-create p95 above 10 s.** *(Rationale: the cold path measures p50 2.46 s against a 60 s budget, and ~85% of that is `initdb` plus a first Postgres start — exactly what a warm pool removes, which makes it the right optimisation for the wrong problem right now. Deferring it is R-4 discipline: it felt like progress and was not needed.)*

- **D-209 — The 350 MB per-active-project planning budget and D-091's 150 active/node may only be re-based on a measurement that satisfies all four conditions: the full triplet (Postgres + PgBouncer + PostgREST), x86 hardware of the launch SKU class, ≥50 co-resident projects, and client load attached. Partial data may inform the risk register but may not move the planning number.** *(Rationale: the first measurements are 3× under the assumption and every one of them was taken in the cheapest corner of the state space; a planning number lowered on convenient data is how a density model becomes confidently wrong. Converting D-091's "re-base within 90 days of launch" into a precondition on the *evidence* rather than a deadline is what stops the deadline from doing the deciding.)*

- **D-210 — Every measurement entry states what it does not license, and a decision may not cite a measurement that does not cover its conditions.** *(Rationale: the measurement log is append-only and will be read by people who were not there; the "does not license" section is the part that prevents a number taken on an idle ARM container from being quoted as a density result. This retro is the first test of that rule and §3's refusals are its output.)*

## Open Questions

- **OQ-090** *(updated)* — still open, now with first data. M-001 and M-002 measure Postgres alone; the triplet number the 350 MB budget rests on requires PgBouncer and PostgREST to exist. Blocked on Phase 1/2, gated by D-209.
- **OQ-091** — untouched by Milestone 0: no pause/resume was built, so resume latency and its density cost remain unmeasured. The 5.2 s node-reboot rebuild (M-005) is a weak lower bound at best — it had a warm page cache and an initialised volume.
- **OQ-176** — Does the ~14:1 booked-to-used ratio survive real client load, and at what load does the 350 MB booking start to bind? The answer decides whether D-174's overcommit is comfortable or merely untested.
- **OQ-177** — What is the disk floor per project once WAL archiving writes to the volume rather than the container filesystem (a known gap)? ~59 MB is the floor for an empty database with archiving effectively disabled.

## Dependencies

- Builds on: [measurements](05-measurements.md) (M-001…M-006), [milestone 0](04-milestone-0.md) (D-168, D-169), [cost model](../12-business/01-cost-model.md) (D-090, D-091), [multi-tenancy](../01-architecture/03-multi-tenancy-and-isolation.md) (D-174), [decision log](../00-foundation/05-decision-log.md)
- Feeds: [cost model](../12-business/01-cost-model.md) (A.2/A.3/A.4 annotations), [risk register](../15-risks/01-risk-register.md) (R-2, R-6 re-grades), [phase plan](01-phase-plan.md) (D-208 defers a Phase-2 item), [open questions](../15-risks/02-open-questions.md)
