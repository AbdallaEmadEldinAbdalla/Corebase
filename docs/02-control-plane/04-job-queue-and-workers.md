# Job Queue & Workers

## Purpose

How asynchronous work actually runs: the BullMQ-on-Redis design (D-018), the two-phase enqueue pattern that survives crashes, retry/backoff/dead-letter policy, worker concurrency, heartbeats, and graceful shutdown. The [state machine](03-provisioning-state-machine.md) defines *what* jobs do; this doc defines *how* they are delivered, retried, and observed. Foundational constraint, restated because everything follows from it: **Redis is never a source of truth** (D-018, §99) — the `provisioning_jobs` table in the [control-plane schema](01-data-model.md) is the state of record; BullMQ is a delivery and scheduling mechanism that can be flushed and rebuilt from Postgres at any time.

## Design

### Topology

- One Redis instance on the control-plane node, AOF persistence on. Persistence is an optimization (fewer sweeper rebuilds after a restart), **not** a correctness requirement.
- The worker is the one separate process from day one (D-020): `services/worker`, same TypeScript monorepo (D-010), deployed independently of the API.
- Queues, all BullMQ on the same Redis:

| Queue | Jobs | Concurrency per worker | Why separated |
|---|---|---|---|
| `lifecycle` | `provision_project`, `resume_project`, `pause_project`, `delete_project` | 4 | The customer-facing latency path; must not starve behind bulk work |
| `credentials` | `rotate_credentials` | 2 | Touches KMS + live poolers; low parallelism keeps rotation observable |
| `backup` | `create_backup`, `restore_backup` | 2 | Long-running, IO-heavy; a restore must never queue behind provisioning |
| `reconcile` | `node_reconcile` | 1 per node (job id = node id) | Repeatable/scheduled; dedup by job id so sweeps never stack up |

The job taxonomy is closed: these eight types are a `CHECK` constraint in the schema ([data model](01-data-model.md)). Adding a job type is a migration — deliberate friction, because every new type owes a per-step idempotency analysis (below).

### The two-phase enqueue (crash-safe by construction)

The classic failure pair: the API writes the DB row and crashes before enqueueing (job lost forever), or enqueues first and crashes before commit (job references a row that doesn't exist). The pattern that survives both:

```text
Phase 1 (API request handler, ONE Postgres transaction):
  BEGIN;
    INSERT INTO projects (...) VALUES (...);              -- the intent
    INSERT INTO provisioning_jobs
      (project_id, job_type, idempotency_key, state, payload)
      VALUES ($prj, 'provision_project', $idem_key, 'pending', $payload);
  COMMIT;               -- durable: intent and job exist together, or neither does
  → respond 202 to the client

Phase 2 (immediately after commit, best-effort):
  bullmq.add('lifecycle', payload, { jobId: idem_key, ... });
  UPDATE provisioning_jobs SET state = 'enqueued'
   WHERE id = $job AND state = 'pending';

Sweeper (inside the worker process, every 30 s):
  -- rows the API never managed to hand to Redis
  SELECT * FROM provisioning_jobs
   WHERE state = 'pending' AND created_at < now() - interval '60 seconds'
   FOR UPDATE SKIP LOCKED;
  → for each: bullmq.add(..., { jobId: idempotency_key });  -- add() dedups per jobId
    UPDATE ... SET state = 'enqueued';

  -- rows Redis has lost, or whose worker died
  SELECT * FROM provisioning_jobs
   WHERE state IN ('enqueued', 'running')
     AND coalesce(heartbeat_at, updated_at) < now() - interval '10 minutes'
   FOR UPDATE SKIP LOCKED;
  → if no live BullMQ job exists under that jobId: re-add (attempts UNCHANGED —
    this is redelivery, not retry). If a live BullMQ job exists: leave it alone.
```

Properties:

- Phase 2 failing (API crash, Redis down) loses nothing: the sweeper re-enqueues from Postgres.
- Redis losing *everything* (flush, failover, corruption) loses nothing: every non-terminal row gets re-added. This is what "Redis is never the source of truth" means structurally, not aspirationally.
- `jobId = idempotency_key` makes `add()` a no-op on duplicates, so Phase 2 and the sweeper racing each other is harmless.
- The 60-second grace period on `pending` avoids re-enqueueing rows whose Phase 2 is still in flight.

### Idempotency keys end-to-end

One key travels the entire path:

```text
client Idempotency-Key header (D-063)
  → provisioning_jobs.idempotency_key (UNIQUE — a collision means "already accepted";
    the API returns the stored response instead of double-submitting)
    → BullMQ jobId (dedup at the queue)
      → saga checkpoint in the same row (resume, don't restart — D-064)
        → per-step "verify then create" against real infrastructure (§76)
```

System-initiated jobs (idle pause, purge, reconcile, nightly backups) generate **deterministic** keys so natural double-fires collide: `pause:<ref>:<date>`, `reconcile:<node_id>:<window_start>`, `backup:<ref>:<date>` — never `uuid()` at enqueue time for anything a scheduler might trigger twice.

### Retry policy, backoff, dead letters

| Parameter | Value | Notes |
|---|---|---|
| Max attempts | 5 (`max_attempts` column; per-type override — `restore_backup` uses 3) | |
| Backoff | Exponential with jitter: base 30 s, factor 4 → ~30 s, 2 m, 8 m, 32 m | Long tail on purpose: most infra failures are transient but not instant |
| Retryable failures | Timeouts, Docker daemon errors, node unreachable, lock contention, KMS blips | Worker throws → BullMQ schedules retry; row gets `state='failed'`, `attempts++`, `last_error` |
| Non-retryable failures | Precondition violations (project in wrong state), payload validation errors, a verify step finding *conflicting* resources | Worker marks the row `dead` immediately — retrying a logic error burns attempts and pages nobody |
| Attempts exhausted | Row → `state='dead'`; the project surfaces as `failed` where applicable | **Operator alert fires**: Prometheus alert on `corebase_jobs_dead_total` + notification ([observability](../11-infrastructure/03-observability.md)) |
| Dead-letter recovery | Operator action via the admin surface ([audit & admin access](05-audit-and-admin-access.md)): `retry` (re-enqueue, attempts reset, **same idempotency key** → saga resumes at its checkpoint) or `abort` (run compensation per the [state machine](03-provisioning-state-machine.md)) | Dead rows are never auto-deleted; they are the incident record until resolved, and both actions are audited |

### Honesty about delivery semantics

This system is **at-least-once, not exactly-once** — and no queue configuration changes that. A worker can complete a step and crash before checkpointing; a partitioned worker can still be running while the sweeper redelivers. Exactly-once *delivery* is a myth; exactly-once *effect* is engineered per step:

- Every step re-verifies actual state before mutating (§76's "does X already exist?").
- Guarded updates (`UPDATE ... WHERE status='configuring'`) turn stale executions into no-ops.
- Redelivery (sweeper; `attempts` unchanged) is distinct from retry (failure; `attempts++`).
- The advisory lock (below) shrinks — but does not eliminate — the concurrent-execution window; the steps' idempotency is the actual guarantee.

A new job type does not get a queue until its per-step idempotency checks are written down. Review requirement, not advice.

### Concurrency, heartbeats, long jobs

- Concurrency per the queue table; horizontal scale = more worker processes (BullMQ distributes; `FOR UPDATE SKIP LOCKED` keeps sweepers from colliding).
- **Heartbeats:** long jobs (provision, backup, restore) update `provisioning_jobs.heartbeat_at` every 30 s, piggybacked on BullMQ's lock-extension callback. A `running` row with a heartbeat older than 10 minutes is treated as orphaned by the sweeper → redelivered. Steps carry their own bounded timeouts (health wait 5 m, backup 60 m) so a hung step becomes a failed attempt, not a zombie.
- **Per-project serialization:** at most one lifecycle job per project runs at a time, enforced with a Postgres advisory lock on `hashtext(project_id::text)` taken at job start. A second job for the same project fails to acquire, re-schedules itself +30 s, and exits. Prevents pause/provision interleaving on one container.

### Graceful shutdown (drain, don't kill mid-saga)

Deploys restart workers routinely; a restart must never look like a crash:

1. `SIGTERM` → the worker pauses its queue consumption (no new jobs).
2. In-flight jobs get a drain budget (90 s) to reach the next step boundary; the saga runner checks a `shuttingDown` flag between steps and exits cleanly, leaving the row `enqueued` for another worker.
3. A job that cannot reach a boundary in time: the worker stops heartbeating and exits; step idempotency makes the redelivery safe.
4. `systemd` `TimeoutStopSec=120` sits above the drain budget so the platform never SIGKILLs inside it. Rolling deploys (start new worker → drain old) live in [IaC & CI/CD](../11-infrastructure/02-iac-and-cicd.md).

### Scheduled work

BullMQ repeatables are *triggers only*: each tick materializes a normal `provisioning_jobs` row (deterministic key) and runs it through the standard path — so even scheduled work is Postgres-recorded and sweeper-recoverable.

| Schedule | Work | Note |
|---|---|---|
| Every 30 s | Sweeper (in-process timer, **not** a queue job) | The one component that must not depend on the queue it repairs |
| Every 5 min, jittered per node | `node_reconcile` | Drift table in the [state machine](03-provisioning-state-machine.md) |
| Hourly | Idle-pause scan → `pause_project` per candidate (D-008) | Idle policy in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) |
| Hourly | Purge scan: `purge_after < now()` → `delete_project` (mode=purge, D-038) | |
| Nightly, spread per node | `create_backup` per project (D-019) | |

## Decisions

- **D-067 — Two-phase enqueue is mandatory for every job: the `provisioning_jobs` row is written in the same Postgres transaction as the intent it serves, BullMQ enqueue happens after commit with `jobId = idempotency_key`, and a 30-second sweeper re-enqueues any row without a live BullMQ job. Scheduled/system jobs must use deterministic idempotency keys.** *(Rationale: makes D-018's "Redis is never a source of truth" structural — the system provably survives an API crash between commit and enqueue, and survives total Redis loss, because Postgres can always rebuild the queue.)*
- **D-068 — Delivery is explicitly at-least-once with idempotent effect: retries use exponential backoff (30 s base, factor 4, jitter) up to `max_attempts` (default 5), non-retryable failures dead-letter immediately, exhausted jobs enter a `dead` state that fires an operator alert and is only ever resolved by an audited operator `retry` (same key, checkpoint resume) or `abort` (compensation). Redelivery does not consume attempts.** *(Rationale: pretending exactly-once exists produces designs that break on the first crash; naming at-least-once forces every job type to carry per-step idempotency checks, and dead letters with alerts turn "silently stuck" into "visibly owned".)*

## Open Questions

- OQ-069: Redis deployment shape — single instance with AOF is acceptable *because* of D-067, but does the resume-on-request path ([state machine](03-provisioning-state-machine.md)) make Redis availability customer-visible enough to justify Sentinel/replica earlier? Revisit with [infra phases](../11-infrastructure/01-infra-phases.md).
- OQ-045: Drain budget (90 s) vs the longest atomic step (pgBackRest final backup can exceed it) — should `backup`-queue workers get a longer budget and their own deploy cadence, or should long steps become checkpointable sub-steps? Measure with real backups before V1.

## Dependencies

- Builds on: [01-data-model.md](01-data-model.md), [03-provisioning-state-machine.md](03-provisioning-state-machine.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-008, D-018, D-019, D-020, D-038)
- Feeds: [02-platform-api.md](02-platform-api.md) (202/job responses), [05-audit-and-admin-access.md](05-audit-and-admin-access.md) (dead-letter operator actions), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md), [../03-database-platform/05-backups-and-pitr.md](../03-database-platform/05-backups-and-pitr.md), [../11-infrastructure/03-observability.md](../11-infrastructure/03-observability.md)
