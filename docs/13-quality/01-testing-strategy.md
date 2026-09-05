# Testing Strategy

## Purpose

The test pyramid for a platform company, layer by layer: what each layer proves, which tools run it, and who owns it. The proposal gave one line per layer (§73) plus the critical security test (§74); this doc makes each layer executable. Two properties distinguish Corebase's pyramid from an app company's: (1) the product under test *is* infrastructure, so the integration and E2E layers must run against real Postgres, real containers, and real object storage — mocks prove nothing about a BaaS; (2) two suites are **release-blocking by policy, not by convention**: the tenant-isolation suite ([tenant isolation tests](../06-security/03-tenant-isolation-tests.md), D-085) and the golden-path E2E defined here (D-151).

## Design

### The pyramid at a glance

| Layer | Tool | Runs where | Cadence | Owner | Release-blocking |
|---|---|---|---|---|---|
| Unit | vitest | CI, no containers | Every PR | Feature author | Yes (red = no merge) |
| Integration | vitest + testcontainers (or the D-027 compose stack) | CI, Docker | Every PR | Feature author | Yes |
| Golden-path E2E | TS script using `@corebase/core` + CLI | Staging | Every deploy | Platform team | **Yes (D-151)** |
| Isolation suite | Owned by [tenant isolation tests](../06-security/03-tenant-isolation-tests.md) | Staging + prod canaries | Every deploy + hourly staging + daily prod | Security owner | **Yes (D-085, fleet-wide freeze)** |
| Load/perf | k6 | Staging | Nightly + before capacity-relevant releases | Platform team | Threshold regressions block |
| Chaos-lite | Scripted fault injection | Staging | Weekly scheduled | On-call rotation | Findings triaged as Sev-2 |

### 1. Unit (vitest)

Pure logic, no I/O, milliseconds per test. The discipline is not "write unit tests" — it is **designing the risky logic to be unit-testable**, i.e. extracting it into pure functions with all effects at the edges. The enumerated unit-test targets:

- **Token logic**: JWT claim construction, expiry/refresh-rotation decisions, reuse-detection state ([sessions & tokens](../05-auth/02-sessions-and-tokens.md)) — as pure functions over `(token, now, store-snapshot)`.
- **Filter parsing**: the gateway's request-classification and key-validation logic; anything Corebase adds around PostgREST's grammar ([REST API design](../04-data-api/01-rest-api-design.md)). PostgREST's own grammar is *not* re-unit-tested — D-005/D-011 mean we inherit its test suite, not duplicate it.
- **Quota math**: rate-limit window arithmetic (D-033), plan-cap and disk-headroom calculations, node bin-packing/reservation arithmetic ([postgres provisioning](../03-database-platform/01-postgres-provisioning.md) §7) — property-based where cheap (fast-check): reservations never exceed `0.85 × ram_total`, ladder thresholds monotone.
- **State-machine transitions**: the provisioning lifecycle ([provisioning state machine](../02-control-plane/03-provisioning-state-machine.md)) as a **pure transition function** `(state, event) → (state', effects[])`. Every legal transition, every illegal transition (must yield a rejection, matching the `409 PROJECT_NOT_READY` contract), and every saga checkpoint/resume path is enumerated in a table-driven test.

This creates real design pressure, and D-150 makes it binding: the state machine cannot be written as workers mutating `projects.status` inline with Docker calls interleaved. It must be a pure core that *decides* (`state'` plus a list of effect descriptions) and a thin worker shell that *executes* effects and feeds results back as events. That is more structure than the naive implementation — and it is exactly the structure D-064's checkpoint/resume semantics already need, so the testability pressure and the crash-recovery pressure push the same direction. If a transition can't be unit-tested without Docker, the transition is in the wrong layer.

### 2. Integration (real dependencies, containerized)

Everything that touches a database or a wire protocol. Tooling: **vitest + testcontainers** for suites that need one or two services (fast, parallel, per-suite isolation); the **D-027 compose stack** (`corebase dev` — the same Postgres 17 / PgBouncer / PostgREST / auth / MinIO images as prod) for suites that need the whole assembly. Using the D-027 stack in CI is deliberate double-duty: every CI run also proves the local-dev stack still boots, which is §119 criterion 13.

Enumerated DB-touching suites:

- **Control-plane repositories** against real Postgres: every query in the data-access layer ([data model](../02-control-plane/01-data-model.md)), including the guarded status updates (`UPDATE … WHERE status='configuring'` returning 0 rows) and cursor pagination edges (D-039).
- **Auth flows** against real DB + **mailpit** as the SMTP sink: signup → verification-mail capture → link extraction → verify; password reset round-trip; refresh rotation + reuse detection actually revoking the family ([flows](../05-auth/03-flows.md)).
- **Migration apply/rollback**: `db push` / `db reset` semantics against a scratch database, including partial-failure behavior (a failing migration must not record as applied) ([migrations](../03-database-platform/04-migrations.md)).
- **PostgREST config against a seeded project DB**: boot PostgREST with a generated per-project config against a schema seeded with roles + RLS, assert anon/service_role behavior through the actual HTTP surface — this is the contract test for everything D-011 embeds.
- **Job queue**: BullMQ + Redis + Postgres `provisioning_jobs` — idempotency-key dedup, heartbeat sweeper, dead-letter path ([job queue & workers](../02-control-plane/04-job-queue-and-workers.md)).

### 3. End-to-end: the golden path (D-151)

One scripted scenario, run against **staging on every deploy**, written in TypeScript **using `@corebase/core` and the CLI as its clients** (so the SDK and CLI are exercised as a side effect — §119 criterion 12). It is the proposal's §73 E2E chain extended to the full MVP surface, and per §119 **this script is the MVP acceptance test**: the release that makes it pass end-to-end is, by definition, the MVP.

The scenario, as numbered steps (each step asserts its exact expected result, not merely "no error"):

1. Create a platform account (scripted email on a test domain, staging mail routed to a capture sink).
2. Create an organization.
3. Create a project; record `t0`.
4. Poll `GET /v1/projects/:ref` until `READY`. **Assert `READY − t0 < 60s` (hard fail)**; warn above 30s, since the design target is <30s / warm-pool ~1–3s (D-071, [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) §4). The 60s line is the customer-promise ceiling; the warning keeps the script honest about regression toward it.
5. Fetch project keys (anon, service_role) and connection info.
6. Write a migration (`create table todos … enable row level security` + owner-only policies + an anon-insert policy) and apply it with `corebase db push` (§119 criteria 4, 9, 14).
7. Insert a row via `/rest/v1/todos` with the **anon key**; assert 201 and that RLS shaped the write as policied.
8. Sign up an end user via the project's auth API; capture the verification mail from the sink; verify (§119 criterion 7).
9. Log in; receive access + refresh JWTs (§119 criterion 8).
10. **RLS-scoped read**: as the user, read `todos` — assert the user sees exactly their own rows; assert a second user sees zero of them (the in-project miniature of §74).
11. Upload a file to a bucket; download it; assert byte-identical checksum (§119 criteria 10–11).
12. Run `corebase export`; assert the tarball contains the DB dump, migrations directory, storage manifest, and users export, and that the dump restores into a scratch Postgres (D-004 — the moat claim gets tested every deploy).
13. Pause the project (assert the data API goes dark/parked), then resume; assert the same row is readable again (D-008).
14. Restore the latest backup **to a new instance** (D-019); assert the row exists there; delete both projects.

**§119 criteria → script step mapping** (stated explicitly so "MVP done" is checkable):

| §119 criterion | Covered by |
|---|---|
| 1 create account | Step 1 |
| 2 create project | Step 3 |
| 3 get Postgres | Step 4–5 |
| 4 create table | Step 6 |
| 5 insert data | Step 7 |
| 6 query via API | Steps 7, 10 |
| 7 create auth user | Step 8 |
| 8 authenticate | Step 9 |
| 9 apply RLS | Steps 6, 10 |
| 10 upload file | Step 11 |
| 11 download file | Step 11 |
| 12 use SDK | The script's client *is* the SDK (all steps) |
| 13 run locally | **Not this script** — covered by the CI job that boots the D-027 compose stack and runs a smoke subset (steps 6–11 equivalents) against it |
| 14 push migrations | Step 6 |
| 15 restore a backup | Step 14 |

A red golden path blocks the deploy from promoting. It does not trigger D-085's fleet-wide freeze (that is reserved for isolation failures); it blocks *this* artifact.

### 4. The isolation suite (referenced, not duplicated)

Owned entirely by [tenant isolation tests](../06-security/03-tenant-isolation-tests.md): ephemeral A/B fixtures plus prod canaries (D-084), the full attack matrix, exact-status assertions. Cadence: **every deploy (pre-promote, blocking) + hourly scheduled in staging + daily prod canaries**; any failure freezes all releases fleet-wide (D-085). This doc's only obligation is structural: the harness lives in `tests/isolation/` in the monorepo and runs in the same CI stage as the golden path, and nothing in the pyramid below it may claim to cover isolation.

### 5. Load & performance (k6)

Two standing k6 jobs, nightly against staging:

- **Request-pipeline smoke**: sustained mixed read/write against a seeded project through the full gateway → pooler → PostgREST path. Thresholds mirror the latency budget in [request pipeline](../04-data-api/02-request-pipeline.md) — that doc owns the numbers; this suite encodes them as k6 `thresholds` (e.g. gateway-added overhead p99, simple indexed read p95, sustained error rate ≈ 0). A threshold regression blocks the next release until explained.
- **Provisioning storm**: **50 concurrent project creates** against staging. Asserts: all reach `READY`; pool-refill behavior matches D-071 (first ~N from the warm pool fast, the rest via the cold path still under the 60s ceiling); no reservation-accounting drift afterward (reconcile sweep reports zero repairs).

k6 scripts live in `tests/load/`; results ship to Prometheus (D-021) so trends are graphs, not folklore.

### 6. Chaos-lite (scheduled fault injection, staging)

Not a chaos platform — three scripted faults, run weekly on staging, each asserting the *designed* recovery:

- **Kill the provisioner worker mid-provision** (SIGKILL between saga steps): assert the job sweeper re-enqueues, the saga resumes from its checkpoint with the same idempotency key, exactly one database exists at the end (D-064, §75–76).
- **Kill a project's Postgres container**: assert reconcile auto-restarts it within its bound (3/hour) and an alert fires ([provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) reconciliation table).
- **Fill a project's disk** (write until XFS quota): assert the enforcement ladder fires in order — warnings, read-only at the threshold, never node impact — and auto-lifts when space is freed ([postgres provisioning](../03-database-platform/01-postgres-provisioning.md) §6, D-073).

Findings are triaged as Sev-2 bugs; chaos-lite never runs against prod in V1.

### Where tests live and how CI stages them

Monorepo layout (per [repo & service layout](../01-architecture/05-repo-and-service-layout.md), D-010): unit and integration tests live **next to the package they test** (`packages/*/src/**/*.test.ts`, vitest workspace config at the root); cross-cutting suites live under a top-level `tests/` tree:

```
tests/
  e2e/          # the golden-path script (D-151) + local-stack smoke subset
  isolation/    # harness owned by ../06-security/03-tenant-isolation-tests.md
  load/         # k6 scripts + threshold configs
  chaos/        # the three scripted faults
  factories/    # shared factory modules (also imported by package-level tests)
```

CI stage ordering (each stage gates the next; [IaC & CI/CD](../11-infrastructure/02-iac-and-cicd.md) owns the pipeline itself):

1. **Lint + typecheck + unit** — no containers, target < 3 min.
2. **Integration** — testcontainers suites in parallel; the D-027 compose-stack boot + smoke subset runs here too (§119 criterion 13).
3. **Build + deploy to staging.**
4. **Pre-promote gates, in parallel**: golden-path E2E (D-151) and the ephemeral-A/B isolation matrix (D-084/D-085). Both green → promote to prod.
5. **Scheduled, outside the PR path**: hourly isolation runs, nightly k6, weekly chaos-lite, monthly restore verification (D-019 — owned by [backups & PITR](../03-database-platform/05-backups-and-pitr.md), listed here because it is a test, not an ops chore).

The ordering rule: cheap and deterministic before expensive and environmental. A unit failure must never cost a staging deploy to discover.

### Test-data management

- **Factories, not fixtures-by-hand**: one factory module per aggregate (org, project, user, key) shared across integration/E2E, producing valid-by-construction records with overridable fields.
- **Ephemeral projects with TTL cleanup**: every staging project created by any suite is tagged `test=true, ttl=<ISO>`; a staging-only reaper deletes expired ones hourly. No suite may rely on cleanup-in-teardown alone — crashed runs must not leak projects (they cost real RAM per D-009).
- Prod test entities are limited to the isolation canaries; nothing else creates prod data.

### Coverage philosophy (D-152)

No global percentage mandate — a % target optimizes for covering easy code. Instead: **the enumerated critical paths in this doc are 100%-covered or the release doesn't ship** — the state-machine transition table (every legal + illegal transition), token/refresh logic, quota and reservation arithmetic, RLS-bearing query paths, migration apply/record semantics, and every step of the golden path and isolation matrix. CI enforces this as *presence of the enumerated suites and their green status*, not as a coverage-tool threshold.

Explicitly allowed to be under-tested in V1 (listed so it's a choice, not an accident): dashboard UI beyond smoke (no snapshot/visual-regression suite), CLI output formatting, email template rendering fidelity, observability dashboards/alert rules, docs-site code samples, and performance of admin/back-office endpoints. Each earns tests when it earns bugs.

## Decisions

- **D-150 — The provisioning state machine is implemented as a pure transition function `(state, event) → (state', effects[])`, exhaustively unit-tested (all legal and illegal transitions, all checkpoint/resume paths); workers are thin shells that execute the returned effects and feed results back as events.** *(Rationale: the riskiest control-plane logic must be testable without Docker; the same core/shell split is what D-064's checkpoint-resume semantics need anyway, so testability and crash-recovery pressures align rather than compete.)*
- **D-151 — The golden-path E2E script defined here is the MVP acceptance test (§119, §73): it runs against staging on every deploy, uses the SDK and CLI as its clients, asserts create→READY under 60 seconds, and a red run blocks that deploy from promoting.** *(Rationale: §119's fifteen criteria only mean something as one continuously-executed scenario; making the script the acceptance test removes any ambiguity about what "MVP done" or "still shippable" means.)*
- **D-152 — No global coverage-percentage mandate; instead the critical paths enumerated in this doc are 100%-covered as a release gate, and the V1 under-tested list is maintained explicitly in this doc.** *(Rationale: percentage targets reward covering easy code and punish deleting it; an enumerated-paths gate puts the effort exactly where the risk register points, and the explicit under-tested list keeps the trade-off a decision instead of drift.)*

## Open Questions

- **OQ-150 — Staging topology fidelity:** how many nodes must staging run for placement-sensitive tests (same-node A/B pinning, provisioning-storm bin-packing, cordon behavior) to be meaningful, and what does that cost? Interacts with OQ-085. Revisit when staging is stood up ([IaC & CI/CD](../11-infrastructure/02-iac-and-cicd.md)).
- ~~**OQ-151 — k6 threshold numbers**~~ — **resolved by D-388.** The latency budget's numbers are locked, and the suite now splits them by whether they travel between machines. The error rate, the RLS-correctness rate and the gateway's *added* cost (measured against a direct arm in the same interleaved run) are enforced everywhere. The absolute p50/p99 stay record-only except under `CB_LOAD_STRICT=1`, because a shared runner is not a production node and a threshold that ignores that gets muted rather than fixed. What remains open is narrower and is tracked as **OQ-184**: whether the doc's ~1.5 ms gateway figure is achievable at all, or wants revising — it was measured at 2.91 ms per request on a laptop with Docker-forwarded Redis, and needs a production-shaped node to settle.
- **OQ-152 — Flake policy:** quarantine mechanism for a flaky non-critical test (auto-skip + tracking issue vs hard rule that flakes block like failures). The golden path and isolation suite are explicitly *not* quarantinable — flakes there are treated as failures — but the policy for the rest needs deciding before the suite is big enough to flake.

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-005, D-010, D-011, D-019, D-027, D-032), [../02-control-plane/03-provisioning-state-machine.md](../02-control-plane/03-provisioning-state-machine.md), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md), [../04-data-api/02-request-pipeline.md](../04-data-api/02-request-pipeline.md), [../10-cli-and-sdk/02-local-development.md](../10-cli-and-sdk/02-local-development.md)
- Feeds: [02-release-and-versioning.md](02-release-and-versioning.md), [../11-infrastructure/02-iac-and-cicd.md](../11-infrastructure/02-iac-and-cicd.md), [../14-roadmap/02-v1-scope-and-cutlist.md](../14-roadmap/02-v1-scope-and-cutlist.md) (MVP acceptance = the golden path), [../14-roadmap/04-milestone-0.md](../14-roadmap/04-milestone-0.md)
