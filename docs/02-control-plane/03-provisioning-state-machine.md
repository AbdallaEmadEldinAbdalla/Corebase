# Provisioning State Machine

## Purpose

The full lifecycle of a Steadhold project, deepened from proposal §28–29 and §75–78: every state, every transition and its trigger, the provisioning saga step-by-step with idempotency and compensation, the deletion pipeline, and the reconciliation loop that catches drift. This is the behavioral contract that [jobs and workers](04-job-queue-and-workers.md) implement and the [platform API](02-platform-api.md) exposes.

## Design

### Principles inherited

- **Never a synchronous provision** (§29): the API writes intent and returns `202`; workers do the work.
- **Every step idempotent** (§75–76): a worker crash + retry must never create a second database. Every step is written as *"does X already exist? → verify and continue; else create."*
- **Desired vs actual**: `projects.status` + `project_databases` rows are *desired/recorded* state; Docker containers, volumes, and gateway routes are *actual* state. Only reconciliation is allowed to close the gap outside a job.
- Pause/resume is first-class, not an afterthought (D-008). Soft delete has a 7-day recovery window (D-038).

### State diagram

```text
                              create (API, 202)
                                     │
                                     ▼
                               ┌───────────┐
                               │ CREATING  │  row committed + job enqueued (two-phase)
                               └─────┬─────┘
                        worker picks │ up job
                                     ▼
                              ┌──────────────┐   any step exhausts retries
                     ┌────────│ PROVISIONING │──────────────┐
                     │        └──────┬───────┘              │
                     │               │ infra steps 1–6 done │
                     │               ▼                      ▼
                     │        ┌─────────────┐          ┌────────┐   retry (operator or
                     │        │ CONFIGURING │─────────▶│ FAILED │◀─┐ auto): re-enqueue with
                     │        └──────┬──────┘ retries  └───┬────┘  │ SAME idempotency key;
                     │               │ steps 7–10 done     │       │ saga resumes at first
                     │               ▼                     └───────┘ incomplete step
                     │          ┌─────────┐    resume job done      (FAILED is re-enterable,
                     │          │  READY  │◀───────────────┐         never terminal)
                     │          └─┬───┬───┘                │
                     │   pause    │   │ delete             │
                     │ (API/idle) │   │ (API)              │
                     │            ▼   │              ┌───────────┐
                     │      ┌─────────┴┐             │ RESUMING  │◀── resume (API call,
                     │      │ PAUSING  │             └───────────┘    incoming data-plane
                     │      └────┬─────┘                   ▲          traffic, or restore)
                     │           │ backup+WAL in R2 (D-077)│
                     │           │ containers removed      │
                     │           ▼                         │
                     │      ┌─────────┐    resume          │
                     │      │ PAUSED  │────────────────────┘
                     │      └────┬────┘
                     │           │ delete (API)
                     ▼           ▼
                  ┌───────────────┐
                  │   DELETING    │  disable API → final backup → stop container
                  └───────┬───────┘
                          │ pipeline steps done (volume KEPT)
                          ▼
                  ┌───────────────┐   restore (API, ≤7 days) → RESUMING → READY
                  │ SOFT_DELETED  │──────────────────────────────────────────▶
                  └───────┬───────┘
                          │ purge sweeper: now() > purge_after (7 days, D-038)
                          ▼
                  ┌───────────────┐
                  │    DELETED    │  terminal; row retained, resources verified gone
                  └───────────────┘
```

### Transition table

| From | To | Trigger | Actor |
|---|---|---|---|
| — | CREATING | `POST /v1/projects` commits row + job in one transaction | API |
| CREATING | PROVISIONING | Worker dequeues `provision_project` | Worker |
| PROVISIONING | CONFIGURING | Infra steps (node, volume, container, healthy, pooler) complete | Worker |
| CONFIGURING | READY | Roles/schemas, PostgREST, keys, gateway, backups complete | Worker |
| PROVISIONING / CONFIGURING | FAILED | A step exhausts its retries (see [retry policy](04-job-queue-and-workers.md)) | Worker |
| FAILED | PROVISIONING | Retry: auto (next backoff tier) or operator/customer `retry` — **same idempotency key**, saga resumes at first incomplete step | Worker |
| FAILED | DELETING | Customer deletes, or operator aborts → compensation runs first | API/Operator |
| READY | PAUSING | `POST .../pause`, or idle detector (free plan, D-008) | API / Scheduler |
| PAUSING | PAUSED | Final backup AND last WAL segment confirmed landed in R2 (`pgbackrest check`, D-077 — until confirmed the project stays PAUSING) + containers removed + gateway route set to "parked, resumable" | Worker |
| PAUSED | RESUMING | `POST .../resume`, or first data-plane request to a parked route | API / Gateway |
| RESUMING | READY | Container started from existing volume, healthy, route live | Worker |
| READY / PAUSED / FAILED | DELETING | `DELETE /v1/projects/:ref` (with `confirm`) | API |
| DELETING | SOFT_DELETED | Deletion pipeline steps 1–4 done; `deleted_at`, `purge_after = deleted_at + interval '7 days'` set | Worker |
| SOFT_DELETED | RESUMING | `POST .../restore` before `purge_after` (else `410 PROJECT_PURGED`) | API |
| SOFT_DELETED | DELETED | Purge sweeper past `purge_after`: destroy volume, backups per retention, verify | Worker |

Illegal transitions are rejected by the API with `409 PROJECT_NOT_READY` and by workers with a no-op + warning log (a job that arrives for a project no longer in the expected state must not act — state is re-read inside the job, never trusted from the payload).

### The provisioning saga

One `provision_project` job executes the steps below in order, persisting a cursor to `provisioning_jobs.checkpoint` after each completed step (e.g. `{"last_step": 4}`). A retried job fast-forwards: for every step ≤ cursor it runs the **verify** half only; from cursor+1 it runs verify-then-create. That is what makes FAILED re-enterable instead of terminal.

| # | Step | Idempotency check ("does X already exist?") | Compensation on abort |
|---|---|---|---|
| 1 | Allocate node capacity | `project_databases` row exists with node? → verify node still active, reuse. Else: pick node (`region`, `status='active'`, best-fit on `ram_total_mb - ram_reserved_mb`), `SELECT ... FOR UPDATE`, reserve RAM, insert row (transactional reservation rule in the [data model](01-data-model.md)). (`project_databases` is the placement bookkeeping in the control-plane data model — the same mechanism the provisioning doc calls `placements`; one mechanism, two names: [provisioning](../03-database-platform/01-postgres-provisioning.md)) | Release reservation (decrement `ram_reserved_mb`), delete `project_databases` row |
| 2 | Create volume | Docker volume `vol_<ref>` exists? → verify labels, reuse. Else create | Remove volume (safe: no data yet at abort time) |
| 3 | Start Postgres container | Container labeled `project=<ref>` exists? → running: continue; stopped/crashed: remove and recreate (config may have been the cause). Else create with cgroup limits from `ram_limit_mb` (D-009) and PG 17 image (D-037) | Stop + remove container |
| 4 | Wait healthy | Poll `pg_isready` + accept-connection probe, bounded (5 min) | — (timeout fails the step, normal retry path) |
| 5 | Create roles & schemas | For each of `anon`, `authenticated`, `service_role`, the `auth` schema, the `storage` schema: `SELECT ... FROM pg_roles/pg_namespace` → exists: verify grants; else `CREATE` — every DDL guarded (`IF NOT EXISTS` or catalog check) | None needed (dropped with container/volume) |
| 6 | Start PgBouncer | Pooler container for `<ref>` exists? → verify config hash matches; mismatch → recreate. Else create (transaction mode, D-015) | Stop + remove pooler |
| 7 | Start PostgREST | Same pattern (D-011): exists → verify config hash; else create pointing direct at Postgres (`db:5432`), never through PgBouncer (D-101) | Stop + remove |
| 8 | Generate keys & credentials | `project_api_keys` rows for `anon`+`service_role` exist? → skip (never regenerate silently). Else: generate ES256 keypair (D-014), mint both JWTs, store hashes (D-060), envelope-encrypt DB password + signing key into `project_secrets` (D-035) | Revoke keys (set `revoked_at`), delete secrets rows |
| 9 | Register with gateway | Route for `<ref>.steadhold.app` present in routing store? → verify target; else write ([request pipeline](../04-data-api/02-request-pipeline.md)) | Deregister route |
| 10 | Enable backups | pgBackRest stanza for `<ref>` exists? → `stanza-check`; else `stanza-create` + schedule the per-plan backup policy (D-077) + continuous WAL archiving | Remove stanza config (backups in object storage untouched) |
| 11 | Mark READY | `UPDATE projects SET status='ready' WHERE id=$1 AND status='configuring'` — guarded update; 0 rows → log & stop (state changed underneath) | — |

(Steps 1–6 run under `PROVISIONING`; the transition to `CONFIGURING` happens between 6 and 7.)

**Compensation policy:** compensation runs only on *abort* (operator abandons, or customer deletes a FAILED project) — not on ordinary retry, because retry wants the partial work preserved. Compensation is itself a job (`delete_project` with `payload.mode='abort'`) and runs the deletion pipeline's resource-teardown steps, which are all "does X exist? → destroy" idempotent in the reverse direction.

**Pause saga** (`pause_project`): verify READY → final backup → set gateway route to parked (returns a "project paused, resuming on first request" response + triggers resume) → checkpoint + clean stop, then remove the PostgREST, PgBouncer, Postgres containers (volume, per-project network definition, and config kept; `container_id=NULL`, `paused_at=now()`, D-072) → **confirm the final backup AND the last WAL segment have landed in R2 (`pgbackrest check`)** — the binding D-077 gate: until both are confirmed the project stays PAUSING, only then PAUSED → **release the RAM reservation entirely** — a paused project books 0 MB (D-072/D-174); this asymmetry *is* the pause economics ([provisioning](../03-database-platform/01-postgres-provisioning.md)). **Resume saga** is provisioning steps 3–4, 6–7, 9 against the existing volume (re-reserving RAM in step 1's bookkeeping, resume-elsewhere if the node is full); target: seconds, not minutes.

### Deletion pipeline (§77, D-038)

`DELETING` runs these steps (same checkpoint/idempotency mechanics):

1. **Disable API**: gateway route → 410-with-explanation; revoke nothing yet (restore must be cheap).
2. **Disable writes**: `ALTER DATABASE ... SET default_transaction_read_only = on` if the container is running (defense in depth; the route is already dark).
3. **Final backup**: pgBackRest full backup, labeled `final-<ref>-<date>`; **verified** (restore-check per D-019) before proceeding — an unverified final backup blocks the pipeline.
4. **Stop containers** (Postgres, pooler, PostgREST). Volume kept. → mark `SOFT_DELETED`, set `deleted_at`, `purge_after`.
5. *(After 7 days, purge sweeper enqueues `purge_project` — D-196:)* destroy volume → release node RAM reservation → delete pooler/PostgREST configs → deregister gateway route (fully) → revoke API keys → delete secrets rows → verify every resource is gone (list-and-assert) → mark `DELETED`. Backups then age out per plan retention (§35); the final backup is kept 30 days beyond purge as the last-resort escape hatch.

Restore inside the window = flip to `RESUMING` and run the resume saga; nothing was destroyed.

### Reconciliation (drift detection)

A periodic `node_reconcile` job per node (every 5 minutes, jittered — D-065/D-173) compares desired vs actual:

| Drift class | Detection | Response |
|---|---|---|
| Container down but project READY (crashed) | Desired: running; actual: exited *or absent* | **Auto-repair**: enqueue the provisioning saga, which converges either case (D-200); bounded at 3/hour, then mark project `failed` and alert |
| Container running but project PAUSED/DELETED (zombie) | Actual exists; desired says not | **Auto-repair**: stop container; alert (this is a billing/security leak) |
| Orphaned volume (no `project_databases` row) | Actual volume; no desired row | **Alert only** — never auto-delete data (priority stack: durability > cost) |
| Orphaned reservation (`ram_reserved_mb` ≠ Σ `ram_limit_mb` of rows on node) | Arithmetic check | **Auto-repair**: recompute from rows |
| Gateway route pointing at nothing / missing route for READY project | Route store vs `project_databases` | **Auto-repair**: rewrite route |
| Job `running` with stale heartbeat | `heartbeat_at < now() - interval '10 min'` | Handled by the [job sweeper](04-job-queue-and-workers.md), not node reconcile |

Reconciliation **repairs toward desired state**; it never invents desired state. Anything it cannot classify → operator alert with full context. Every sweep's report is persisted to `nodes.last_reconcile` (D-201), so "did it run" and "what did it find" survive log retention. Results land in the reconcile job's payload and metrics ([observability](../11-infrastructure/03-observability.md)); repeated drift on one node is a cordon signal.

## Decisions

- **D-064 — FAILED is a re-enterable state, never terminal: the saga persists a per-step checkpoint in `provisioning_jobs.checkpoint`, retries reuse the original idempotency key, and every step is written as verify-then-create so a resumed saga fast-forwards through completed work. Compensation (reverse teardown) runs only on explicit abort or delete, never on retry.** *(Rationale: §75–76 made idempotency a rule; the checkpoint makes it cheap and makes "retry" a first-class customer/operator action instead of a support escalation.)*
- **D-065 — Reconciliation runs as a per-node sweep every 5 minutes with a fixed repair policy: auto-repair crashed containers (rate-limited), zombie containers, routes, and reservation arithmetic; orphaned volumes and anything unclassified are alert-only.** *(Rationale: drift is a certainty (§75's crashed-worker world); auto-repair must be bounded to the classes where the safe direction is obvious — data-destroying repairs are never automatic, per the D-002 priority stack.)*
- **D-066 — Deletion is blocked on a verified final backup: step 3 of the deletion pipeline restore-checks the final backup before any resource is destroyed, and the final backup outlives the purge by 30 days.** *(Rationale: the one moment a backup absolutely must work is when everything else is about to be deleted; verification is the difference between a recovery window and a promise.)*

## Open Questions

- OQ-066: Should paused projects keep their node RAM reservation (safe, wastes density) or release it (dense, but resume can fail on a full node and needs a migration path)? **Resolved by D-072/D-174:** released; paused projects book 0 RAM. Residual sub-question: the resume-elsewhere path when the original node has since filled — mechanics owned by the [cost model](../12-business/01-cost-model.md) + [provisioning](../03-database-platform/01-postgres-provisioning.md).
- OQ-067: Resume-on-first-request latency budget — what does the gateway return while a paused project resumes (blocking hold-open vs immediate 503-with-Retry-After vs branded "waking up" page for browser traffic)? Needs a decision before free-tier auto-pause ships. **Resolved by D-172:** immediate 503 + `Retry-After: 5`, error `project_resuming`; no hold.
- OQ-068: Auto-retry policy out of FAILED for *customer-visible* failures — silently retrying forever hides real problems; V1 proposal: 3 automatic re-enqueues, then surface `failed` in the dashboard with a retry button. Confirm with dashboard UX ([dashboard IA](../09-dashboard/01-dashboard-ia.md)).

## Dependencies

- Builds on: [01-data-model.md](01-data-model.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-008, D-009, D-011, D-014, D-015, D-019, D-038), [../01-architecture/02-control-vs-data-plane.md](../01-architecture/02-control-vs-data-plane.md)
- Feeds: [04-job-queue-and-workers.md](04-job-queue-and-workers.md), [02-platform-api.md](02-platform-api.md), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md), [../03-database-platform/05-backups-and-pitr.md](../03-database-platform/05-backups-and-pitr.md), [../14-roadmap/04-milestone-0.md](../14-roadmap/04-milestone-0.md)
