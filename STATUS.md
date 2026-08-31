# Corebase — Build Status

**Last updated:** 2026-08-31 · **Phase:** Milestone 0 (the provisioning spine) · **T1–T10 done — Milestone 0's tasks are complete; the retro (D-169) remains**

This file is the handover document. If you are picking Corebase up — new collaborator,
future me, or an agent — read this first, then [docs/INDEX.md](docs/INDEX.md) for the
plan and [docs/00-foundation/05-decision-log.md](docs/00-foundation/05-decision-log.md)
for the binding decisions.

It is kept current with every step of work. Where it says something is done, there is
a commit, a test count, and usually a measurement behind it.

---

## 1. What works today, in one paragraph

You can `POST /v1/projects` and get a real, isolated PostgreSQL 17.5 database on a
data node roughly **2.5 seconds** later, provisioned by an idempotent saga through
the Docker Engine API over mutual TLS, with its own volume, cgroup limits, the full
role model, three envelope-encrypted credentials, and a connection string the API
hands back that you can immediately `psql` into and create tables in. Twenty
consecutive creates have been measured end to end
([M-002](docs/14-roadmap/05-measurements.md)), and the worker has been SIGKILLed at
eleven points in that saga to prove it resumes with no duplicate anything
([M-003](docs/14-roadmap/05-measurements.md)). Deleting a project stops it and
keeps its data for a 7-day recovery window, then a scheduled purge destroys it and
returns the capacity — 20 create+delete cycles leave nothing behind
([M-004](docs/14-roadmap/05-measurements.md)). Reboot the data node and every
project is serving queries again a few seconds later with no human involved, while
anything the control plane and the node disagree about is reported — and anything
holding data is reported *without* being touched
([M-005](docs/14-roadmap/05-measurements.md)). All of it is visible: Prometheus
scrapes both services, Grafana has a provisioned dashboard, logs are in Loki and
findable by project ref or request id, and the "job stuck" alert has been watched
firing. Nothing above the database exists yet: no data API, no auth, no storage,
no customer-facing dashboard.

## 2. Run it locally

Prerequisites: Docker (Desktop is fine), Node 22+, pnpm 9, plus `jq` and `psql`
for the demo.

```bash
pnpm install
./scripts/staging.sh up            # control-db + control-redis + Docker-in-Docker data node
./scripts/migrate-staging.sh       # apply migrations to the control plane
./scripts/staging.sh kek           # generate the local master key (gitignored)
docker build -t corebase/postgres:17.5 infra/docker/postgres
./scripts/staging.sh seed-images   # push the project image onto the data node
./scripts/staging.sh verify        # 10 checks; all must pass
```

Start the services, then see the whole thing work in about five seconds:

```bash
./scripts/dev.sh
```

```bash
./scripts/demo.sh
```

That creates a project, waits for it, connects to the database it made with the
credentials the API handed back, runs real SQL, and deletes it — using only curl
and psql, which is exactly what a customer has. `--purge` also destroys it;
`--keep` leaves it running and prints the command to connect.

Then the test suite, or the provisioning measurement:

```bash
pnpm test
```

```bash
pnpm --filter @corebase/worker bench
```

The crash-resume matrix is a separate script because 11 scenarios × ~35s is a
nightly job, not a per-commit one:

```bash
pnpm --filter @corebase/worker kill-matrix
```

`CB_KM_ONLY=start_container` narrows it to one scenario; `CB_KM_TIMELINE=1` prints
the restarted worker's log with arrival times, which is how the 60s recovery
mystery got solved.

The full lifecycle loop — create, use, delete, purge, twenty times, then assert
the node and control plane are empty:

```bash
pnpm --filter @corebase/worker lifecycle
```

The node-reboot drill — restart the data node and watch it converge, with an
orphan planted to prove the sweep reports rather than deletes:

```bash
pnpm --filter @corebase/worker node-reboot
```

### Watching it work

`scripts/dev.sh` (above) also tees the services' output to the files Alloy tails,
so logs reach Loki. Grafana is at <http://127.0.0.1:3001/d/corebase-provisioning> (anonymous
admin, local only) and `./scripts/staging.sh monitoring` prints the URLs plus a
health check. To verify the whole observability path end to end — scrape targets,
20 runs on the panel, logs queryable by ref, the alert actually firing:

```bash
pnpm --filter @corebase/worker observability
```

**Note:** stop `dev.sh` before running `pnpm test`. A second worker on the same
Redis consumes the deliveries the queue tests assert on; the suite now detects a
rival consumer and says so rather than failing cryptically.

Tear down with `./scripts/staging.sh down` (keeps volumes) or `nuke` (destroys
everything including the local master key — every stored credential becomes
unreadable, which is the property being rehearsed).

### Driving it by hand

```bash
./scripts/staging.sh status
```

Start the services with the staging environment (the bench harness does this for
you; this is the manual equivalent):

```bash
export CB_CONTROL_DATABASE_URL=postgres://corebase:controlpass@127.0.0.1:55433/corebase_control
export CB_REDIS_URL=redis://127.0.0.1:56379
export CB_DOCKER_HOST=127.0.0.1 CB_DOCKER_PORT=2376
export CB_DOCKER_CERT_DIR=$PWD/infra/docker/staging/certs
export CB_KEK_DIR=$PWD/infra/docker/staging/kek.d
export CB_BOOTSTRAP_SECRET=local-bootstrap-secret-0123456789
export CB_PROJECT_DOMAIN=localhost CB_PG_PORT_MIN=5433 CB_PG_PORT_MAX=5462
export CB_NODE_RAM_MB=16384 CB_STATIC_TOKEN=dev-token PORT=8099
```

`CB_PROJECT_DOMAIN=localhost` matters: connection strings come back as
`<ref>.localhost`, which resolves to 127.0.0.1, so the string the API hands you is
directly usable.

## 3. Repository map

```
docs/                  the planning corpus — 62 documents, 16 sections (read INDEX.md)
design-exports/        design system artefacts: tokens, 43 HTML components, 142 PNGs
migrations/            plain SQL, applied in filename order, checksummed
infra/docker/postgres/ the per-project database image (extension allowlist, auth hardening)
infra/docker/staging/  the local stand-in for staging: control node + dind data node
scripts/               staging.sh, migrate-staging.sh
packages/
  config/              shared tsconfig base
  types/               shared types, error envelope, project-ref grammar
  crypto/              envelope encryption (per-secret DEK under a file-resident KEK)
  secrets/             credential persistence — the store-then-apply rule lives here
  queue/               BullMQ + ioredis wiring, idempotency-keyed enqueue
  metrics/             a Prometheus registry: counters, gauges, histograms
  migrate/             the migration runner (advisory lock, per-file transaction, drift check)
services/
  api/                 Fastify control-plane API
  worker/              provisioning worker: job runner, placement, Docker, sagas
  worker/bench/        the provisioning measurement harness
```

Node runs TypeScript directly with `--experimental-strip-types`; there is no build
step. That has one consequence worth knowing: **Node only strips types, it does not
transpile.** TypeScript features that need code generation — parameter properties,
enums, decorators — fail at runtime while Vitest happily transpiles them in tests.
That combination once produced 17 passing tests against a service that could not
boot. Don't use them.

## 4. What is built, in detail

Test counts are from `pnpm test` and are all currently green: **197 tests**.

Every task below has a command that proves it; they are listed with the task.

### T1 — Repo scaffold · done
pnpm workspaces + Turborepo. `typecheck` and `test` across every package.
Root `test` runs `turbo run test --concurrency=1`, and each service pins
`fileParallelism: false`, because every integration suite truncates the same
staging control database and competes for the same host ports on the data node.

### T2 — Staging infrastructure · done
**Substitution from the plan:** the plan calls for Terraform and two Hetzner nodes.
We reproduce the same *topology* locally — a control node (Postgres + Redis) and a
data node exposing the Docker Engine API over TLS on 2376 — using Docker Compose
with Docker-in-Docker. The interface the worker drives (D-052: Engine API over
mTLS, no per-node agent) is the real one. What this does *not* prove: cloud-init,
real network partitions, NVMe behaviour, XFS project quotas, Hetzner failure modes
(OQ-165).

`scripts/staging.sh` is the entry point: `up | kek | seed-images | verify |
idempotent | down | nuke | status | all`. `verify` runs ten checks including
"plaintext :2375 refused", "TLS required", "project port range reachable" and
"node can run a project container".

### T3 — Control-plane schema · done
Two migrations, applied from empty. The DDL is copied verbatim from
[the data model](docs/02-control-plane/01-data-model.md) so nothing is thrown away
later: 6 enums, `organizations`, `project_groups`, `projects`, `nodes`,
`project_databases`, `provisioning_jobs`, and (T5e) `project_secrets`.

The migration runner (`@corebase/migrate`, 9 tests) takes a Postgres advisory lock,
runs one transaction per file, records a checksum per file and refuses to proceed if
a previously-applied file has changed. CRLF is normalised so a Windows checkout does
not read as drift.

### T4 — API skeleton · done · 17 tests
Fastify. `POST /v1/projects`, `GET /v1/projects`, `GET /v1/projects/:ref`,
`DELETE /v1/projects/:ref`, `/health`. Standard error envelope with `request_id`
(D-032) from the first endpoint. One static bearer token for now.

Two properties worth knowing:

- **Two-phase enqueue (D-067).** The project row and its `provisioning_jobs` row are
  written in one transaction. If the job row cannot be written, the project must not
  exist — a project with no job silently never provisions, which is the worst
  failure mode available. Redis is never the source of truth for job existence;
  enqueueing is a later, retryable step the sweeper can redo.
- **Idempotency replay short-circuits everything.** A seen `Idempotency-Key` returns
  the original outcome *before* validation and the duplicate-name check. Ordering
  this wrong made a retried create collide with the project its own first attempt
  had made, returning 409 instead of the original project.

**Known divergence:** `POST` returns the project bare and list returns
`{ data: [...] }`, where the documented contract is `{ project, job }` and
`{ projects, pagination }`. `GET /v1/projects/:ref` was brought onto the documented
`{ project, database }` shape in T5e. **OQ-175** says fix the other two in one
breaking change together with cursor pagination and the `api_keys` block — three
separate shape fixes would cost three client breaks.

### T5 — Worker and provisioning saga · done · 86 tests · [M-002](docs/14-roadmap/05-measurements.md)

Built in six sub-steps, each committed separately.

**T5a/T5b — job runner.** A job is claimed by a conditional `UPDATE … RETURNING`;
that statement *is* the lock, so two workers racing one delivery cannot both run it.
Heartbeats mark liveness, a checkpoint is written *after* each step so an interrupted
step is retried rather than skipped, and a sweeper re-enqueues rows Redis never
delivered. Each step logs its own duration.

**T5c — placement.** `SELECT … FOR UPDATE` on the emptiest eligible node, book plan
RAM (D-174: 350 MB for a Free project, not the container's 512 MB ceiling), stop at
85% of bookable RAM (D-090), allocate a port from a range, write
`project_databases`. `releaseNode` is the exact idempotent inverse.

**T5d — container steps.** `docker.ts` is an Engine API client over mTLS written
against `node:https` rather than a Docker SDK. `create_volume`, `start_container`
and `wait_healthy`, each check-then-act:

- `start_container` adopts a container that was created but never started — the
  crash window — instead of failing on the name conflict, and records `container_id`
  only once the container is actually running.
- `wait_healthy` probes `pg_isready` *through the Engine exec API*, because the
  worker has no network path to the project's port in production. `exec` returns
  `exitCode: null` when the container cannot exec at all (initialising, restarting,
  stopped); `inspect` is the authority on whether that is temporary.
- Containers are created with **no restart policy** and promoted to
  `unless-stopped` only once the database answers (**D-184**). Under
  `unless-stopped`, a container that cannot initialise flaps forever and the health
  gate sees a permanent `restarting` state instead of a dead container.

**T5e — credentials and readiness.** `create_base_roles` verifies the roles the
image creates and fails loudly if any are missing, then creates `developer` (the
customer's role: NOSUPERUSER, NOCREATEROLE, NOBYPASSRLS, CREATE on `public` only).
`store_credentials` generates POSTGRES / DEVELOPER / AUTHENTICATOR passwords,
persists them envelope-encrypted, then applies them. `write_connection` records the
customer-facing host. `mark_ready` refuses to flip the status if the database is not
running, there is no container, no connection host, or fewer than three credentials.

**T5f — the measurement.** `pnpm --filter @corebase/worker bench`. 20/20 creates
ready *and usable*, max 3.26s against a 60s budget. Per-step attribution showed
~85% of a create is `wait_healthy` (initdb plus a first Postgres start) and the
control plane's own work totals 57 ms.

### T6 — Crash-resume proof · done · [M-003](docs/14-roadmap/05-measurements.md)

`pnpm --filter @corebase/worker kill-matrix` SIGKILLs the worker at eleven points
in the saga — seven step boundaries plus four mid-step windows where no
checkpoint exists — restarts it, and asserts convergence with **exactly one**
container, volume, placement row, credential set and RAM booking, and a database
usable on the credential the API hands out. 11/11 pass; restart→ready p50 30.9s,
of which 30s is the liveness window and ~1s is the actual re-execution.

SIGKILL rather than SIGTERM on purpose: SIGTERM runs the graceful drain, which is
the case that cannot fail.

**This task found the worst bug in the project so far.** The first run did not
converge slowly — it did not converge at all, ever:

1. The orphan threshold (90s) outlived BullMQ's own re-delivery (~30s). The
   re-delivery arrived while the row still looked healthy, `claim` refused it,
   and BullMQ marked that delivery *complete*. Nothing retried. A worker crash
   mid-provision left the project `creating` permanently. Fixed by **D-193**:
   the threshold is now derived from the heartbeat interval (three missed beats),
   and the runner throws on any override under two intervals.
2. Even once the row was recognised as orphaned, the sweeper's re-enqueue was a
   no-op against the dead worker's delivery record, and waiting for that record's
   lock to expire cost the full 60s `lockDuration`. Fixed by **D-194**: recovery
   deliveries carry their own attempt-keyed id, used only when the plain key is
   occupied. Safe because the `claim` UPDATE — not Redis — is the mutex.

Five fast regression tests now guard both defects inside `pnpm test`.

### T7 — Deletion saga · done · [M-004](docs/14-roadmap/05-measurements.md) · 16 tests

Deletion is **two operations**, not one. The M0 task text describes a single pass
("stop/remove containers → remove volume → mark DELETED"), which contradicts
D-038's 7-day recovery window and D-061's soft-delete model — you cannot restore
a project whose volume you destroyed. The state machine's two-phase design is
binding, so that is what is built:

`delete_project` — **reversible.** disable_api (a no-op until the gateway exists,
said out loud in the logs rather than silently skipped) → disable_writes (`ALTER
DATABASE … default_transaction_read_only`, so a client on a live direct
connection cannot write data the final backup would miss) → final_backup (a
**gate**, not a stub: `CB_REQUIRE_FINAL_BACKUP=true` makes deletion fail loudly
rather than quietly skip D-066, and it is off in M0 because no backup system
exists) → stop_container (clearing the restart policy first, or `unless-stopped`
brings it straight back) → mark_soft_deleted, with `COALESCE` on `purge_after` so
a retry cannot slide the window forward.

`purge_project` — **irreversible**, and gated. verify_purgeable refuses anything
that is not `soft_deleted` with an expired window; that guard is what gives the
recovery window meaning. Then remove_container (by name as well as by recorded id,
so a container created just before a crash is not left behind) → remove_volume →
delete_credentials → release_capacity → **verify_gone**, which lists the node and
throws if anything remains → mark_deleted.

`verify_gone` is why "delete leaves no residue" is a property of the code rather
than of a test, and one of the 16 tests proves it can actually fail by standing a
container back up and watching the step catch it.

The purge scan (`purge-scan.ts`) closes expired windows on a timer — hourly in
production, since the window is measured in days.

### T8 — Reconciliation sweep · done · [M-005](docs/14-roadmap/05-measurements.md) · 15 tests

`reconcile.ts` compares desired state in the control plane against what is
actually on the node, every 5 minutes with jitter (D-065/D-173). Two rules govern
all of it:

**It repairs toward desired state; it never invents desired state.** A container
the control plane has no row for is not evidence a project exists — it is drift to
report.

**Data-destroying repairs are never automatic** (D-002: durability above cost). A
stray container can be stopped, because that is reversible. An orphaned volume is
somebody's database with a missing row, and the answer is an alert, not a
deletion. Getting this backwards once costs a customer their data, which is why
three of the fifteen tests exist purely to prove the reconciler leaves things
alone.

| Drift | Response |
|---|---|
| project `ready`, container stopped or absent | enqueue the provisioning saga (**D-200**), bounded at 3/hour then mark `failed` and alert |
| container running, project `soft_deleted`/`paused` | stop it and alert — a billing and security leak |
| managed container with no project row | **alert only**, never removed |
| `cb-*` volume with no placement row | **alert only**, never removed |
| `nodes.ram_reserved_mb` ≠ Σ plan bookings on that node | recompute from the rows |

Repair goes through the provisioning saga rather than a bespoke restart path
because the saga is already check-then-act: it fast-forwards a stopped container
to `start_container` and creates a missing one, so there is one convergence path
instead of two. The reconciler also declines to act when a job for that project is
already in flight, so it never races the saga it would duplicate.

Every sweep persists its report to `nodes.last_reconcile` (**D-201**), because the
first question about a reconciliation loop is not "what drifted" but "is it
running at all", and a log line answers that only until retention expires.

The drill (`bench/node-reboot.mts`) is the done-signal and separates the two
mechanisms on purpose: containers with a restart policy come back because *Docker*
restarts them, and a container that is *gone* is reconciliation's job. Both are
asserted, and every project is finally checked by running a query through the
connection string the API hands out.

### T9 — Observability seed · done · [M-006](docs/14-roadmap/05-measurements.md) · 17 tests

Prometheus + Loki + Alloy + Grafana in the staging stack, `/metrics` on both
services, one provisioned dashboard and three alert rules.

`@corebase/metrics` is a hand-written registry — three metric types and one
well-specified text format, the same reasoning that put the Docker client here
rather than a Docker SDK. What it buys beyond avoiding a dependency is control
over label sets, which is the thing that actually matters: **D-146's cardinality
budget is a design constraint**, and a registry that demands the label set at
construction makes an accidental per-project histogram hard to write. The
verification harness queries `{__name__=~"corebase_.*", project_ref!=""}` and
fails if anything matches, so a regression breaks a check rather than a
Prometheus.

Metrics: provisioning job duration (histogram, `job_type` × `outcome`), per-step
duration, jobs finished by outcome, node RAM booked as ratio and absolute, jobs by
state, oldest non-terminal job age, and the reconcile trio. Gauges derived from
control-plane rows are read at scrape time, never cached — a cached copy is a
second source of truth whose failure mode is a dashboard that looks healthy
because the process that would have updated it is the one that died.

Logs carry `ref` and `request_id` **in the line, never as labels** (D-147), so one
query follows a project's whole history and another shows exactly the work a
single API call caused. A `request_id` label would be a new Loki stream per
request.

The alert the plan names — job stuck >10 min — reads a purpose-built gauge
(**D-204**) so the rule is one comparison, and the harness plants an hour-old
non-terminal job and waits for the rule to reach `firing`, not merely `pending`: a
rule whose `for` window never elapses would satisfy "pending" forever, which is
exactly the bug an alert test should catch.

### T10 — Demo script · done

`./scripts/demo.sh` is the whole product in one file, and it is deliberately
poor in privileges: **curl and psql only**, no database access, no internal
helpers, because a demo that needs more than a customer has is not a demo. It is
also the seed of the golden-path e2e (13-quality/01), so it is written to be read
— each step says what it is proving.

It creates a project, waits for `ready`, connects on the returned string, runs
`CREATE TABLE` / `INSERT` / `SELECT`, and then asserts three things about the
database a customer should not have to take on trust: it is Postgres 17.5, the
new table already has RLS enabled (D-083 — the event trigger fired), and the
customer's role is not a superuser (D-080). Then it deletes the project and prints
the date the recovery window closes.

Two things it surfaced. The API had no way to tell you when your recovery window
ends, which made D-038 a promise with no visible deadline — `deleted_at` and
`purge_after` are now on the project detail (**D-205**). And the script wanted a
"purge now" that does not exist and should not (**D-206**): seven days of undo is
the product, so `--purge` expires the window through the control DB and is
labelled test-only.

Green end to end in ~5 s, and it cleans up after itself when it fails, because a
script that leaves a running database behind on every failure teaches people to
distrust it.

## 5. Rules the code follows

These are not style preferences; each one exists because breaking it caused a real
bug in this repository.

**Check-then-act, every saga step.** A step asks "is this already true?" before doing
anything, so re-running it is harmless. This is what makes crash-resume possible.

**Store-then-apply, every credential.** A credential is persisted to the control
plane *before* it is applied to the project database. A crash between the two leaves
a stored password not yet in effect, which the retry applies. The reverse order
leaves a database whose password does not exist anywhere.

**A test that cannot run must fail, never skip.** Integration suites that could not
reach staging used to skip silently, and a skip looks like a pass — which is exactly
how a BullMQ queue-name bug survived a green suite. They now throw, with the reason
and the command that fixes it.

**Liveness thresholds are derived, never chosen.** The orphan threshold is three
heartbeat intervals, computed from the interval. Two independently-chosen numbers
with a correctness relationship between them will drift, and T6 showed what that
costs: a project that never provisions, with no error anywhere.

**Never book what you cannot reach.** `nodes.address` is how the control plane
reaches a node; `nodes.hostname` is only what the node calls itself (**D-192**).
Using the second as the first works until an environment where it does not resolve.

**Enforcement lives in the artefact, not the runbook.** The project image *deletes*
`dblink`, `postgres_fdw` and `file_fdw` and fails its own build if they survive
(D-078); an init script aborts the boot if `pg_hba.conf` grants `trust` anywhere
(D-185). A dropped build argument has no visible symptom until someone is already
inside.

**Commits are split and tagged with the step.** `feat(M0/T5d): …`,
`fix(M0/T5e): …`, `docs(M0/T5f): …`. One concern per commit, and the message says
*why*, including what the alternative would have broken.

## 6. Decisions made while building (not from the plan)

Twenty-three decisions came out of running the thing rather than planning it. Full text in
the [decision log](docs/00-foundation/05-decision-log.md); the log holds
D-001…D-192 and is binding when two documents disagree.

| ID | What changed | Why it surfaced |
|---|---|---|
| D-184 | Containers created with no restart policy; promoted after the health gate | `unless-stopped` made a failing container flap forever and hid the failure |
| D-185 | No `trust` auth anywhere; image builds with `--auth-local=peer --auth-host=scram-sha-256`, init script enforces it | `initdb` defaults made any in-container code execution an unauthenticated superuser login |
| D-186 | The shared `postgresql.conf` pins no `data_directory`; PGDATA in the spec is the single source of truth | The pinned path contradicted the spec on every first boot |
| D-187 | ChaCha20-Poly1305 (IETF) instead of XChaCha20-Poly1305 | XChaCha20 needs libsodium; each DEK encrypts exactly one secret, so a 96-bit nonce is safe |
| D-188 | `project_secrets` uses `dek_wrapped` + text `kek_id` | Two docs described the same table differently; a text id can name a key file, an integer cannot |
| D-189 | `developer` is granted `USAGE ON SCHEMA information_schema` | The blanket revoke left a new project un-introspectable by psql, any ORM, any migration tool |
| D-190 | The health gate probes TCP, never the unix socket | The entrypoint's init-phase server answers on the socket, so the gate passed before the real server listened |
| D-191 | New tables get `ENABLE ROW LEVEL SECURITY` **without** `FORCE` (supersedes D-083's FORCE half) | FORCE broke the customer's first `INSERT` on every new project while buying no isolation |
| D-192 | `nodes.address` is the route; `hostname` is the identity | The control plane needs to open connections to nodes |
| D-193 | Orphan threshold derived from the heartbeat interval (3 missed beats); a bad override throws | A 90s threshold against a 30s re-delivery left crashed provisions stuck permanently |
| D-194 | Sweeper recovery deliveries use an attempt-keyed id when the plain key is occupied | A dead worker's BullMQ lock made recovery wait 60s for a worker Postgres knew was dead at 30s |
| D-195 | Every log line carries an ISO `ts`; every saga step logs its duration | The 60s recovery mystery was read straight off these two fields |
| D-196 | The purge is its own job type, not a mode on delete | One row cannot carry two operations a week apart: shared checkpoints and a shared attempt budget |
| D-197 | Delivery ids and `Idempotency-Key` are restricted to a colon-free charset | BullMQ rejects `:` in job ids; one bad key silently disabled orphan recovery fleet-wide |
| D-198 | Framework-level 4xx keep their status; only real faults are 500 | A bodyless DELETE with a JSON content-type returned 500, blaming the server for the client's request |
| D-199 | A soft-deleted project stays visible; only a purged one is gone | `deleted_at IS NULL` hid the project the moment it was deleted, making the recovery window unusable |
| D-200 | Reconciliation repairs by enqueueing the provisioning saga, bounded at 3/hour | One convergence path, already idempotent; a bespoke restart would be a second, less-tested one |
| D-201 | Each sweep persists its report to `nodes.last_reconcile` | "Is reconciliation running at all" should survive log retention and be one SELECT |
| D-202 | Hand-written metrics registry; no `corebase_*` metric carries `project_ref`, asserted by a check | D-146's budget is a constraint: one per-project histogram would be 600k series |
| D-203 | The worker re-asserts its node row on every reconcile, not just at startup | A vanished node row leaves the worker up while placement is blind to it |
| D-204 | The stuck-job alert reads a purpose-built gauge, not a PromQL reconstruction | One comparison is reviewable; a stale series is itself an alert |
| D-205 | A soft-deleted project exposes `deleted_at` and `purge_after`; both absent, not null, when alive | A recovery deadline you cannot read is not a deadline you can act on |
| D-206 | No customer-facing "purge now"; early closure is a control-plane operation | Seven days of undo is the product, not an inconvenience to route around |

## 7. Measurements

Numbers the plan assumed and the build measured, in
[docs/14-roadmap/05-measurements.md](docs/14-roadmap/05-measurements.md). Append-only —
a superseded measurement is annotated, because the drift between assumption and
reality is itself the finding.

- **M-001** — one project Postgres, idle: 5.0 MiB anon, 87.8 MiB page cache, 102 MiB
  cgroup peak; 27.9 MiB anon at 10 client backends.
- **M-002** — 20 consecutive creates: p50 2463 ms, max 3264 ms, 0 over the 60s
  budget. 21 live projects book 7350 MB and actually use 524 MiB (≈14:1). ~85% of a
  create is `wait_healthy`; the control plane's own work is 57 ms.
- **M-003** — crash recovery: SIGKILL at 11 points in the saga, 11/11 converge
  with zero duplicates. restart→ready p50 30.9s, of which 30s is the liveness
  window; re-execution itself is 0.5–3s.
- **M-004** — 20 create+delete cycles: delete→soft_deleted p50 416ms, purge p50
  1220ms. Residue afterwards: 0 containers, 0 volumes, 0 MB still booked, 0
  credential rows, 0 placement rows.
- **M-005** — node reboot: Engine API back in 4.7s, the one container that could
  not self-restart rebuilt and serving queries 5.2s after the reboot, 4/4 projects
  answering, and the planted orphan reported without being touched.
- **M-006** — the monitoring stack costs ~320 MiB across four containers and
  produces 156 `corebase_*` series, **none carrying `project_ref`**. Says the
  platform half of D-146's budget is nearly free; says nothing yet about the
  per-project half, which is the half that can sink a node.

Both were taken on an ARM Docker VM with Postgres only — no PgBouncer, no
PostgREST. Neither licenses raising the planned density (D-091's 150 projects/node).

## 8. What is not built yet

**Milestone 0, remaining:** the ten tasks are done. What is left is the
**retro** (D-169), which is part of the milestone and not an afterthought: six
measurements (M-001…M-006) now exist against assumptions the plan made before
anything was built, and the cost model, the density figures (D-090/D-091/D-174)
and the risk register have not yet been reconciled with them.

**Everything above the database** is Phase 1+: the data API (PostgREST), auth,
storage, realtime, the dashboard, the CLI, the SDK. All planned in detail under
[docs/](docs/INDEX.md); none started.

**Known gaps in what *is* built:**

- Deletion has no final backup and no restore-within-window. The D-066 gate exists
  and is off; `POST /v1/projects/:ref/restore` is not implemented, so the recovery
  window currently protects the data without yet offering a way to get it back.
- The deletion and purge sagas have not been through the T6 kill matrix. The
  irreversible half of a purge is exactly where a crash matters most.
- Reconciliation has no gateway-route drift class, because there is no gateway. It
  also has no way to *resolve* an orphan: it reports them forever until a human
  acts, and there is no operator tooling for that yet.
- No Alertmanager. Alerts are verified as `firing` in Prometheus; routing to a
  human (page / warn / ticket) is undecided (OQ-146), so nothing wakes anyone up.
- No per-project metrics. cAdvisor and postgres_exporter are the per-project half
  of D-146's inventory and neither is deployed, so the noisy-neighbour view and
  the disk ladder have no data behind them yet.
- Local log shipping tails files because the API and worker are host processes
  here. Production discovers Docker json-file logs instead — same shipper, but the
  discovery path is untested locally.

- The WAL archive writes to the container filesystem, not the volume, so it does not
  survive container replacement. Belongs with backups, not with provisioning.
- No warm pool (D-071). Creates are the cold path; M-002 says that is fine for now.
- The pooler port is allocated and recorded but nothing listens on it — PgBouncer is
  a later task, and the `pooled` connection string will not connect until then.
- `corebase_admin` exists as a role with no password; the audited dashboard path that
  needs it does not exist yet.
- OQ-175: two API response envelopes still diverge from the documented contract.

## 9. Where to look when you pick this up

| Question | File |
|---|---|
| What are we building and why? | [docs/INDEX.md](docs/INDEX.md), then [00-foundation](docs/00-foundation/01-vision-and-principles.md) |
| Why is it like this? | [docs/00-foundation/05-decision-log.md](docs/00-foundation/05-decision-log.md) — binding |
| What is deliberately unresolved? | [docs/15-risks/02-open-questions.md](docs/15-risks/02-open-questions.md) — 140 questions |
| What is the next task, exactly? | [docs/14-roadmap/04-milestone-0.md](docs/14-roadmap/04-milestone-0.md) — includes a progress table |
| What did we measure? | [docs/14-roadmap/05-measurements.md](docs/14-roadmap/05-measurements.md) |
| How does provisioning actually work? | `services/worker/src/jobs/sagas.ts` — read top to bottom |
| How does a project database get built? | `infra/docker/postgres/` — Dockerfile plus four init scripts |
| What does the UI look like? | [design-exports/07-html](design-exports/07-html) served over HTTP |
