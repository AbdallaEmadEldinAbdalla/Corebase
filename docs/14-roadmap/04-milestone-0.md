# Milestone 0 — The Walking Skeleton

## Purpose

The first executable milestone, task by task: from empty repo to *"`POST /v1/projects` returns a connection string and `psql` works, reliably, survivably."* This is proposal §122 made concrete. Milestone 0 deliberately builds the **hard, risky spine** (provisioning, state machine, idempotency, teardown) with the thinnest possible skin — no dashboard, no auth product, no pooler, no backups yet. Everything later hangs off this spine.

## Design

### What Milestone 0 proves

1. The provisioning saga works and is **idempotent under crash** (proposal §75–76 — the riskiest V1 mechanism).
2. Desired state (control-plane Postgres) and actual state (containers on a node) can **reconcile** after failures.
3. The container-per-project unit (D-009/D-054) actually provisions in **<60s** — the lane-1 claim gets its first measurement.
4. Deletion truly tears down (the inverse path is as important as the forward path).

### Explicitly NOT in Milestone 0

Dashboard, org model (a single hardcoded dev account is fine), PgBouncer, PostgREST, auth, storage, backups, pause/resume, billing, rate limiting, TLS niceties (staging can run on a private network + SSH tunnel). All arrive in P1–P6 per the [phase plan](01-phase-plan.md).

### Task breakdown

Ordered; each task lists its done-signal. (Est. sizes: S <1d, M 1–3d, L ~1wk for one engineer — provisional.)

**T1. Repo scaffold (S)** — pnpm + Turborepo monorepo per [repo layout](../01-architecture/05-repo-and-service-layout.md): `services/api`, `services/worker`, `packages/types`, `infra/terraform`, `migrations/`. CI: lint + typecheck + vitest on PR. *Done: green pipeline on a hello-world test.*

**T2. Staging infrastructure (M)** — Terraform: 1 control node + 1 data node (Hetzner, private network), cloud-init installs Docker with TLS-guarded Engine API (D-052), control node runs Postgres 17 + Redis via compose. *Done: `terraform apply` from zero produces SSH-able nodes; re-apply is a no-op.*

**T3. Control-plane schema, minimal cut (S)** — `projects`, `project_databases`, `nodes`, `provisioning_jobs` tables only (subset of [data model](../02-control-plane/01-data-model.md), same DDL so nothing is thrown away). Migration runner wired (plain SQL, the same discipline customers will get). *Done: migrations apply from empty in CI and on staging.*

**T4. API skeleton (S)** — Fastify `/v1/projects` POST/GET/DELETE + `/health`; error envelope + `X-Request-ID` (D-032) from the very first endpoint; a single static bearer token for now. *Done: create returns `{id, ref, status: CREATING}` and a job row exists (same transaction — the two-phase enqueue pattern from [job queue](../02-control-plane/04-job-queue-and-workers.md) from day one).*

**T5. Worker + provisioning saga (L)** — BullMQ worker consuming `provision_project`: allocate node (trivial: the one node) → create XFS-quota volume → start `postgres:17` container with cgroup limits (D-054/D-055 subset: memory + CPU only) → wait healthy → create the project's base roles (even though nothing uses them yet — the [role model](../04-data-api/03-api-keys-and-roles.md) DDL runs here so it's never retrofitted) → generate + store credentials (envelope encryption D-035 from day one, even at this size) → write connection details → status READY. **Every step: check-then-act idempotency.** *Done: 20 consecutive creates <60s each.*

**T6. Crash-resume proof (M)** — kill the worker (SIGKILL) between each pair of saga steps in a scripted test; on restart the job resumes and converges with **zero duplicate containers/volumes**; a `provisioning_jobs` sweeper re-enqueues orphaned rows. *Done: the kill-matrix test passes in CI against a disposable node.*

**T7. Deletion saga (M)** — DELETE → status DELETING → stop/remove containers → remove volume → mark DELETED (soft-delete window D-038 is modeled but the timer can be a stub). Idempotent like T5. *Done: create+delete loop ×20 leaves node and control plane clean (asserted by listing Docker + volumes).*

**T8. Reconciliation sweep v0 (M)** — periodic job (D-053): list containers on the node, diff against desired state; restart missing containers, flag orphans (alert, don't auto-delete — [executing with care](../02-control-plane/03-provisioning-state-machine.md)). *Done: reboot the data node; all READY projects come back without human action; an orphan container is detected and reported.*

**T9. Observability seed (S)** — structured logs (request_id, project_ref) shipped to Loki; three metrics exported: provisioning duration histogram, job failure counter, node RAM reserved. One Grafana panel + one alert (job stuck >10min). *Done: the provisioning-duration panel shows T5's 20 runs.*

**T10. The demo script (S)** — a `scripts/demo.sh`: create project via curl → poll to READY → `psql "$URL" -c 'CREATE TABLE hello(...); INSERT ...; SELECT ...'` → delete. *Done: runs green end to end; this script is the seed of the golden-path e2e ([testing strategy](../13-quality/01-testing-strategy.md)).*

### Progress and evidence

Append-only. Each row names what actually proved the done-signal, so the milestone
retro (D-169) reads evidence rather than recollection. Substitutions from the plan
are stated, not glossed.

| Task | State | Evidence | Substitution from the plan |
|---|---|---|---|
| T1 Repo scaffold | done | pnpm + Turborepo, `typecheck`/`test` green | — |
| T2 Staging infra | done | `scripts/staging.sh all` — 10 checks pass from zero, re-apply is a no-op | Docker Compose + Docker-in-Docker instead of Terraform + two Hetzner nodes. The real interface (Engine API over mTLS, D-052) is unchanged; cloud-init, real partitions, NVMe and XFS project quotas stay unproven (OQ-165) |
| T3 Control-plane schema | done | `migrations/20260829120000_control_plane_init.sql` + `20260831110000_t5e_credentials.sql`, applied from empty; 9 migration-runner tests | — |
| T4 API skeleton | done | 17 API tests; error envelope and `X-Request-ID` from the first endpoint | Response envelope diverges from the documented contract on two endpoints — see OQ-175 |
| T5a–b Worker + job runner | done | claim-by-conditional-UPDATE, heartbeats, checkpoints, orphan sweeper; 14 tests | — |
| T5c Placement | done | transactional booking, 85% fill ceiling, port allocation; 19 tests | — |
| T5d Container steps | done | Engine API client over mTLS, cgroup limits, TCP health gate; 16 integration tests | — |
| T5e Credentials + ready | done | envelope encryption, base roles, connection details, `mark_ready` refusals; 42 tests | — |
| **T5 (whole)** | **done** | **[M-002](05-measurements.md#m-002--twenty-consecutive-project-creates-and-what-twenty-live-projects-actually-cost): 20/20 creates ready *and usable*, max 3.31s against the 60s budget** | Measured on the Docker substitute, ARM, Postgres only — not the triplet on x86 |
| T6 Crash-resume proof | done | `pnpm --filter @steadhold/worker kill-matrix` — SIGKILL at 11 points, 11/11 converge with zero duplicates; [M-003](05-measurements.md); 5 regression tests in the default suite | Kill matrix is a script, not part of `pnpm test`: 11 scenarios × ~35 s is a nightly/CI job, not a per-commit one |
| T7 Deletion saga | done | `pnpm --filter @steadhold/worker lifecycle` — 20 create+delete cycles, zero residue; [M-004](05-measurements.md); 16 integration tests | Two phases (soft → purge) per the state machine and D-038, not the single pass this task's own text describes; the D-066 final-backup gate exists but is off, since no backup system exists yet |
| T8 Reconciliation sweep | done | `pnpm --filter @steadhold/worker node-reboot` — node rebooted, all projects serving again with no human, orphan reported and untouched; [M-005](05-measurements.md); 15 integration tests | `docker restart` on a dind container is not a kernel boot: no cloud-init, disk remount or XFS quota re-application (OQ-165). The gateway-route drift class has no implementation because there is no gateway yet |
| T9 Observability seed | done | `pnpm --filter @steadhold/worker observability` — 24 checks: both services scraped, 20 runs on the panel, logs queryable by `ref` and `request_id`, `ProvisioningJobStuck` reaches `firing`, dashboard provisioned; [M-006](05-measurements.md) | Alloy tails log *files* locally because the API and worker are host processes here; in production it discovers Docker json-file logs and needs no cooperation from the app. No Alertmanager: the alert is verified as `firing` in Prometheus, and routing (page/warn/ticket) is undecided (OQ-146) |
| T10 Demo script | done | `./scripts/demo.sh` — create, wait, real SQL over psql, delete; `--purge` also destroys it. Green end to end in ~5s | Uses only curl and psql, i.e. what a customer has. The single exception is `--purge`, which expires the recovery window through the control DB and is labelled test-only, because there is no customer-facing purge (D-206) |

The exit criteria below are deliberately *not* satisfied by T5 alone: the
kill-matrix, deletion residue and reboot convergence are separate proofs.

### Exit criteria (restated from the phase plan)

- 20 consecutive create→READY <60s; kill-matrix (T6) green; delete leaves no residue; node reboot converges (T8); the demo script runs clean.
- Everything above runs in CI or on a schedule — Milestone 0 ends with *automation proving it*, not a hand-run demo.

### What Milestone 0 decides by building

Building this settles, with running code instead of debate: real idle RSS per project triplet-precursor (feeds OQ-056/OQ-090 back into the [cost model](../12-business/01-cost-model.md)), actual provisioning latency vs the <60s/<30s targets, and whether Docker-Engine-API-over-mTLS control (D-052) feels operationally sound. **A Milestone-0 retro updating the cost model and decision log with measured numbers is part of the milestone.** → **[done: the retro](06-milestone-0-retro.md)** (D-207…D-210).

## Decisions

- **D-168 — Milestone 0 builds the provisioning spine with production-grade patterns (two-phase enqueue, envelope encryption, error envelope, idempotent sagas) from the first line — never "temporary" versions of load-bearing mechanisms.** *(Rationale: these exact mechanisms are the top technical risks (§115); prototyping them throwaway means testing the wrong thing.)*
- **D-169 — Milestone 0 ends with a measurement retro that corrects the cost model and any density/latency assumptions in the corpus.** *(Rationale: the corpus runs on assumptions; this is the first chance to replace them with data.)*

## Open Questions

- OQ-165: Whether T2's staging runs on Hetzner cloud VMs (cheap, fast to boot) vs a dedicated box matching prod-intended hardware (representative RSS/IO numbers for the retro). Leaning: cloud VMs for T1–T8 speed, one dedicated box before the retro.

## Dependencies

- Builds on: [phase plan](01-phase-plan.md), [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md), [job queue](../02-control-plane/04-job-queue-and-workers.md), [postgres provisioning](../03-database-platform/01-postgres-provisioning.md), [repo layout](../01-architecture/05-repo-and-service-layout.md)
- Feeds: Phase 1 (everything it builds is kept), [cost model](../12-business/01-cost-model.md) via the retro.
