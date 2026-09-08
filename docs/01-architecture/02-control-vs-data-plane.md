# Control Plane vs Data Plane

## Purpose

Proposal §7–8 and §121 name the split; this doc makes it operational. It fixes the exact responsibility boundary, replaces "the provisioner runs scripts" with a reconciliation-loop model, and — the part most designs skip — enumerates the failure domains: precisely which operations survive when one plane is down. The rule being deepened: **never confuse the control plane with the customer data plane** (§121).

## Design

### Definitions

- **Control plane** — the system that manages Steadhold itself. Its customers are *developers clicking and CLI-ing*. Its database is control-plane Postgres (D-012). Its truth is **desired state**: which projects should exist, on which node, at which plan, with which keys.
- **Data plane** — the system that serves *the developers' end-users*. Its components are the per-project container triplets (D-009/D-054), the gateway hot path, the auth token endpoints, and the storage read/write path. Its truth is **actual state**: containers that are running, volumes that hold data.

The planes share a repo and (in V1) mostly a process — the monolith hosts both the control-plane module and the gateway/auth/storage-api modules (D-010, D-020). The split is therefore a **data-coupling discipline**, not a deployment diagram: no data-plane request path may read control-plane Postgres synchronously. That discipline is what makes the later physical split (see [split triggers](05-repo-and-service-layout.md)) a deploy change instead of a rewrite.

### Exact responsibility table

| Concern | Control plane | Data plane |
|---|---|---|
| Accounts, orgs, members, roles | ✅ owns (`users`, `organizations`, …) | ❌ never sees platform accounts |
| Projects: create/pause/resume/delete, plan changes | ✅ desired state + jobs | executes via reconciler; serves or refuses traffic per status |
| Project refs, node placement, port maps | ✅ source of truth | consumes via routing table (D-051) |
| API keys & JWT keypairs | ✅ generates, encrypts (D-035), rotates | verifies signatures with cached **public** material only |
| End-user auth (signup/login/tokens) | ❌ | ✅ auth module + project DB `auth` schema (D-013) |
| End-user data (tables, RLS, SQL) | ❌ never queries customer rows | ✅ PostgREST + Postgres (D-011, D-036) |
| Storage objects & metadata | bucket *configuration* | ✅ object bytes (R2) + `storage.objects` rows (D-017) |
| Rate limiting | sets the tier/quotas | enforces per request (Redis buckets, D-033) |
| Backups | schedules, retention policy, restore orchestration | pgBackRest runs on data nodes autonomously (D-019) |
| Billing, metering, quotas | ✅ aggregates usage events | emits usage events (async, fire-and-forget) |
| Dashboard, CLI control commands (`project create`, `db push` orchestration) | ✅ | ❌ |
| SDK runtime calls (`.from().select()`, `auth.signIn`, `storage.upload`) | ❌ | ✅ |
| Audit log (platform actions) | ✅ (proposal §59) | contributes request logs, not audit entries |
| Observability | Grafana/alerting config | emits metrics/logs (D-021) |

Litmus test for any new endpoint: *"if control-plane Postgres were unreachable right now, must this still work?"* If yes → data plane; design it against the routing table and project-local state only.

### The reconciliation-loop model

Desired state lives in control-plane Postgres. Actual state lives on the nodes (running containers, volumes, pgBackRest stanzas). The worker is a **reconciler** that continuously converges actual toward desired — not a script runner that fires commands and hopes.

```text
        ┌────────────────────────── CONTROL-PLANE PG ─────────────────────────┐
        │  projects(status=READY, node_id=n7, plan=free, …)   ← desired state │
        │  provisioning_jobs(…)                               ← intent ledger │
        └──────────────┬────────────────────────────────▲─────────────────────┘
                       │ 1. job enqueued (BullMQ)        │ 4. observed status,
                       ▼                                 │    drift reports
        ┌─────────────────────────── services/worker ────┴────────────────────┐
        │  EVENT PATH: consume job → execute idempotent steps → update status │
        │  RECONCILE PATH (every 5 min, jittered, + on node events — D-173):  │
        │    for each node: list actual containers/volumes (Docker API, mTLS) │
        │    diff against desired → plan actions → execute → record           │
        └──────────────┬───────────────────────────────────────────────────────┘
                       │ 2–3. ensure volume / ensure container / ensure stanza
                       ▼
        ┌──────────────────────────── DATA NODES ─────────────────────────────┐
        │  containers, volumes, port bindings                 ← actual state  │
        └──────────────────────────────────────────────────────────────────────┘
```

Two paths, one engine:

1. **Event path (fast)**: a user action inserts a `provisioning_jobs` row (the state of record, D-018) and enqueues it. The worker executes the job's steps. Every step is an *ensure* (`ensure_volume(spec)`, `ensure_container(spec)`), keyed by the job's idempotency key.
2. **Reconcile path (safety net)**: on a 5-minute jittered per-node timer (D-065/D-173), the worker diffs desired vs. actual per node and repairs drift — a container that OOM-died and Docker restart policy didn't bring back, a triplet that a failed job left half-created, a paused project whose containers are somehow still running, an orphan container whose project was deleted. The ≤60 s convergence budget applies only to explicitly enqueued desired-state changes (create, pause, resume, delete, evacuate) on the event path — it is a job-latency budget, not a fleet diff; ordinary crashes are caught by Docker restart policy in seconds, not by either loop (D-173).

**Why reconciliation beats fire-and-forget scripts:**

- **Crash safety.** A script that dies after step 3 of 7 leaves an undefined state that only a human can fix. A reconciler that dies is merely *late*: the next pass re-derives the plan from (desired, actual) and continues. Proposal §75's "worker crash + retry must not create a second database" falls out for free — `ensure` semantics make retries convergent.
- **Drift repair.** Scripts encode transitions ("create X"); reconcilers encode invariants ("X exists with spec S"). Nodes reboot, Docker daemons restart, operators hand-fix things at 3am. Only invariants survive contact with reality.
- **One code path for provision/repair/resume.** Pause = set desired `status=PAUSED` (reconciler stops containers). Resume = set `READY` (reconciler starts them). Node evacuation = rewrite `node_id` (reconciler restores from backup on the new node). No special-case scripts to rot.
- **Auditability.** Every convergence action is a recorded diff — "found container missing, created it" — which is exactly what the [audit & admin access](../02-control-plane/05-audit-and-admin-access.md) design wants anyway.

The cost is discipline: actual state must be *observable* (inspectable containers, labeled with `project_ref`), and desired state must be *complete* (nothing exists on a node that the control plane doesn't know about). Full state machine and saga details: [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md), [job queue & workers](../02-control-plane/04-job-queue-and-workers.md).

### Failure-domain analysis

#### Control plane down (control-plane Postgres unreachable, or control-plane module erroring)

The contract: **the data plane keeps serving customer traffic.**

| Operation | Survives? | Why |
|---|---|---|
| REST queries (`/rest/v1/*`) | ✅ | gateway routes from in-memory table (D-051); PostgREST + project PG are self-contained |
| API-key validation | ✅ | signature check against cached per-project public keys — no lookup (D-014/D-029) |
| End-user JWT verification | ✅ | same: asymmetric keys, JWKS material cached at the verifier |
| End-user login / refresh (`/auth/v1/*`) | ✅* | user rows are in the *project* DB; signing key must be in the auth module's decrypted-key cache. *Cold cache after a monolith restart during the outage → fails (OQ-054) |
| Storage down/upload | ✅ | metadata in project PG, bytes in R2; bucket config cached with routing entry |
| Direct SQL (`psql` to pooler/5432) | ✅ | never touches Steadhold software at all |
| Rate limiting | ✅ | Redis-backed, control plane not involved (degraded-open if Redis is also down — see [platform security](../06-security/04-platform-security.md)) |
| Backups / WAL archiving | ✅ | pgBackRest runs autonomously on data nodes (D-019) |
| Dashboard: sign-in, project list, settings | ❌ | these *are* the control plane |
| Create/pause/resume/delete project | ❌ | desired state can't be written; **resume-on-request of paused projects also fails** — paused free projects stay dark for the outage duration |
| Key/credential rotation, plan changes | ❌ | control-plane writes |
| SQL editor / table editor in dashboard | ❌ | proxied through dashboard session auth (control plane), even though the target DB is up |
| New routing-table entries / invalidations | ❌ deferred | existing entries keep serving from cache; changes queue up until recovery (periodic full refresh backfills) |
| Usage metering | degraded | events buffer/drop; billing reconciles later — metering is deliberately async (proposal §53) |

#### Data plane down (a data node fails)

| Operation | Survives? | Why |
|---|---|---|
| Control plane entirely | ✅ | dashboard, billing, project CRUD on *other* nodes unaffected |
| Other data nodes' projects | ✅ | blast radius = one node's projects (~150–200, see [density math](03-multi-tenancy-and-isolation.md)) |
| The failed node's projects | ❌ | down until node recovers or reconciler restores them elsewhere from base backup + WAL (D-019; RTO in [disaster recovery](../11-infrastructure/04-disaster-recovery.md)) |
| Detection & response | ✅ | reconciler observes unreachable node, alerts (D-021); restore-elsewhere is an operator-approved action in V1, not automatic |

#### The honest V1 caveat

In V1 the gateway/auth/storage modules share a *process* with the control-plane module (D-020). A crash-looping monolith therefore takes the data-plane HTTP path down with it — only direct SQL and backups survive. This is accepted deliberately: the mitigation is the data-coupling discipline above (so control-plane *dependency* outages don't cascade) plus the codified split triggers in [repo & service layout](05-repo-and-service-layout.md) (so process separation happens when measured, not imagined). Cloudflare additionally shields the origin from L3/L4 events.

### What the gateway must cache/replicate locally (the hot-path contract)

To keep the data plane serving with the control plane dark, the gateway needs, per project ref:

| Cached datum | Source | Freshness mechanism | Staleness tolerance |
|---|---|---|---|
| ref → node IP, PostgREST/pooler ports | control-plane PG | pub/sub invalidation + periodic full refresh (D-051) | minutes (placement rarely changes) |
| project status (READY/PAUSED/SUSPENDED/DELETING) | control-plane PG | pub/sub; **suspend/delete also pushed synchronously** | seconds for suspension (abuse), minutes otherwise |
| project JWT **public** key(s) + kid set | control-plane PG (public half only) | pub/sub on rotation; old kid honored through overlap window (D-014) | rotation overlap window |
| anon/service_role key hashes (revocation check) | control-plane PG | pub/sub on rotation | seconds-to-minutes |
| rate-limit tier & quota numbers | control-plane PG | periodic refresh | hours |
| bucket config (names, public flag, size/MIME caps) | control-plane PG | pub/sub | minutes |

Deliberately **not** on the hot path: private keys (auth module only, decrypted on demand via KMS and cached — D-035), user sessions (project DB), row authorization (RLS in Postgres, D-036), usage counters (async). Redis pub/sub is an *optimization*, not a dependency: if Redis is down, entries serve stale until the periodic refresh reconnects — correctness degrades toward staleness, never toward outage.

## Decisions

- **D-053 — Provisioning is a reconciliation loop, not a script pipeline: desired state lives in control-plane Postgres, the worker converges node-actual state toward it via idempotent `ensure` operations, with an event path (jobs) for latency and a periodic diff pass for drift repair; nothing may exist on a data node that desired state does not describe.** *(Rationale: crash-safety and drift repair fall out of invariant-based convergence, satisfying proposal §75–76 structurally instead of per-script; pause/resume/evacuate become status writes rather than bespoke tooling.)* This entry's original "≤60 s drift pass" wording is superseded by D-173 below.
- **D-173 — Reconciliation is two-tier: the binding drift-discovery sweep is the 5-minute jittered per-node reconciliation (D-065); a fast convergence path (≤60 s from enqueue) applies only to explicitly enqueued desired-state changes (create, pause, resume, delete, evacuate) — it is a job-latency budget, not a fleet diff. Crashed containers are caught by Docker restart policy in seconds, not by either loop. Supersedes D-053's "≤60 s drift pass" reading.** *(Rationale: a full desired-vs-actual diff every 60 s across 1,000+ containers per node hammers the Docker API for no benefit once restart policy owns the crash case; 5-minute drift discovery bounds divergence from out-of-band changes, and the ≤60 s budget preserves snappy provisioning where it is actually felt.)*

(D-051 — hot-path routing cache — is defined in [01-system-architecture.md](01-system-architecture.md) and load-bearing here.)

## Open Questions

- **OQ-052** — Redis is a single instance in V1 carrying three roles (queue, rate limits, routing pub/sub). Its loss degrades all three gracefully, but do we want Redis Sentinel/a second instance before GA, and which role gets separated first? Owner: [job queue & workers](../02-control-plane/04-job-queue-and-workers.md).
- **OQ-054** — Signing-key cache policy in the auth module: how long may a decrypted project private key live in memory, and do we pre-warm keys for active projects so a monolith restart during a control-plane/KMS outage doesn't silence logins? Security-vs-availability tradeoff; owner: [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md).
- **OQ-060** — Reconciler concurrency limits: max simultaneous convergence actions per node (a full-node repair storm could saturate a node's disk/CPU and harm healthy tenants). Owner: [job queue & workers](../02-control-plane/04-job-queue-and-workers.md).

## Dependencies

- Builds on: [01-system-architecture.md](01-system-architecture.md), [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md) (§1 adoption of §7–8/§121), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md)
- Feeds: [../02-control-plane/01-data-model.md](../02-control-plane/01-data-model.md), [../02-control-plane/03-provisioning-state-machine.md](../02-control-plane/03-provisioning-state-machine.md), [../02-control-plane/04-job-queue-and-workers.md](../02-control-plane/04-job-queue-and-workers.md), [../04-data-api/02-request-pipeline.md](../04-data-api/02-request-pipeline.md), [../11-infrastructure/04-disaster-recovery.md](../11-infrastructure/04-disaster-recovery.md), [../15-risks/01-risk-register.md](../15-risks/01-risk-register.md)
