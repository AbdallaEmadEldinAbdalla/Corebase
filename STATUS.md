# Corebase — Build Status

**Last updated:** 2026-09-03 · **Phase:** Phase 4 (auth) · **Milestone 0 complete** · **Phase 1 complete** (P1a–P1g, all exit criteria met) · **Phase 2 complete** (P2a–P2g) · **Phase 3 complete** (P3a–P3h; **all four exit criteria met**) · **Phase 4 in progress** (P4a–P4e done)

This file is the handover document. If you are picking Corebase up — new collaborator,
future me, or an agent — read this first, then [docs/INDEX.md](docs/INDEX.md) for the
plan and [docs/00-foundation/05-decision-log.md](docs/00-foundation/05-decision-log.md)
for the binding decisions.

It is kept current with every step of work. Where it says something is done, there is
a commit, a test count, and usually a measurement behind it.

The one thing to read before trusting any number here: the
[Milestone-0 retro](docs/14-roadmap/06-milestone-0-retro.md) §4, which lists what
the measurements do **not** license. Everything measured so far was measured in the
cheapest corner of the state space.

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
firing.

Since then, Phase 1 has put a platform around that spine. You can sign up, log in
(scrypt, rate-limited, timing-equalised), hold a session or a `cbp_` personal access
token, create organizations, invite people to them, and hold one of three roles that
actually decides what you can do — a member can create and pause projects but not
delete them, an admin can do everything but delete the org or grant owner, and no
admin can strip an owner to take the org. Projects belong to organizations now, so
listing them shows *yours*; the previous version showed every project on the
platform. Every mutating call leaves an audit row in an append-only table, enforced
by a trigger and by a database role that owns nothing, and a test enumerates the
routes to keep it that way. Each project gets its own ES256 keypair with `anon` and
`service_role` keys and publishes a JWKS. CI runs a one-minute unit lane and a full
integration lane against the Docker staging stack on every PR, with the slow drills
on a nightly schedule.

And there is a dashboard: sign in, switch organizations, see your projects, create
one and watch it go from `creating` to `ready` without reloading, then copy a
connection string that works — built on the exported design system, in both themes.

Every project now also gets a **connection pooler** — PgBouncer in transaction mode
on its own port — so `DATABASE_URL` is a real string an application can point at,
and twelve concurrent clients share one Postgres backend. The pooled port resolves
credentials for exactly one role and cannot reach any internal one.

And projects **pause and resume**: an idle one gives its RAM back and keeps its
disk, its port and its credentials, coming back in **546 ms at the median** with
every row intact — measured across 50 consecutive cycles.

Still nothing between a customer and their database above SQL: no data API
(PostgREST), no end-user auth service, no storage, no realtime.

## 2. Run it locally

Prerequisites: Docker (Desktop is fine), Node 22+, pnpm 9, plus `jq` and `psql`
for the demo.

```bash
pnpm install
./scripts/staging.sh up            # control-db + control-redis + Docker-in-Docker data node
./scripts/migrate-staging.sh       # apply migrations to the control plane
./scripts/staging.sh kek           # generate the local master key (gitignored)
docker build -t corebase/postgres:17.5 infra/docker/postgres
docker build -t corebase/pgbouncer:1.23 infra/docker/pgbouncer
./scripts/staging.sh seed-images   # push both project images onto the data node
./scripts/staging.sh backup-store  # bucket + TLS for the object store, and prove egress
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

### The dashboard

`dev.sh` sets `CB_DASHBOARD_ORIGINS`, so with it running:

```bash
pnpm dev:dashboard
```

Then open http://localhost:3000. There is no seeded password anywhere — the
bootstrap account has no hash on purpose — so create an account on `/signup`. A new
account has no organization and lands on `/no-org`; the org endpoint exists but has
no screen yet, so make one with the API:

```bash
curl -sS -c /tmp/cb.jar -X POST http://127.0.0.1:8099/v1/auth/login -H 'content-type: application/json' -d '{"email":"you@example.com","password":"your-password-here"}'
```

```bash
curl -sS -b /tmp/cb.jar -X POST http://127.0.0.1:8099/v1/orgs -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -d '{"name":"Greenbull","slug":"greenbull"}'
```

`$CSRF` is the `csrf_token` from the login response. Reload the dashboard and the
switcher has an org; from there create a project and watch it reach `ready`.

Then the test suite, or the provisioning measurement:

```bash
pnpm test
```

The unit lane is the fast half — no Docker, no database, about a minute — and it is
what CI runs first:

```bash
pnpm test:unit
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
docs/                  the planning corpus — 66 documents, 16 sections (read INDEX.md)
design-exports/        design system artefacts: tokens, 43 HTML components, 142 PNGs
migrations/            plain SQL, applied in filename order, checksummed
infra/docker/postgres/ the per-project database image (extension allowlist, auth hardening)
infra/docker/pgbouncer/ the per-project pooler image (transaction mode, auth_query)
infra/docker/staging/  the local stand-in for staging: control node + dind data node
scripts/               staging.sh, migrate-staging.sh, dev.sh, demo.sh
.github/workflows/     ci.yml (unit + integration on every PR), nightly.yml (the drills)
apps/
  dashboard/           the Next.js dashboard shell (P1g) — a pure client of /v1
packages/
  config/              shared tsconfig base
  types/               shared types, error envelope, project-ref grammar
  crypto/              envelope encryption (per-secret DEK under a file-resident KEK)
  secrets/             credential persistence — the store-then-apply rule lives here
  queue/               BullMQ + ioredis wiring, idempotency-keyed enqueue
  metrics/             a Prometheus registry: counters, gauges, histograms
  audit/               the audit writer: redaction, size cap, joins the caller's transaction
  jwt/                 ES256 sign/verify, one algorithm only
  migrate/             the migration runner (advisory lock, per-file transaction, drift check)
services/
  api/                 Fastify control-plane API
  worker/              provisioning worker: job runner, placement, Docker, sagas
  worker/bench/        the provisioning measurement harness
```

Everything except the dashboard runs TypeScript directly with
`--experimental-strip-types`; there is no build step. The dashboard is the exception
— Next.js compiles it — which is why it is the only package with a `build` that
produces anything. That has one consequence worth knowing: **Node only strips types, it does not
transpile.** TypeScript features that need code generation — parameter properties,
enums, decorators — fail at runtime while Vitest happily transpiles them in tests.
That combination once produced 17 passing tests against a service that could not
boot. Don't use them.

## 4. What is built, in detail

Test counts are from `pnpm test` and are all currently green: **606 tests**, of
which **319** need no infrastructure (`pnpm test:unit`).

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

`scripts/staging.sh` is the entry point: `up | kek | app-role | backup-store |
seed-images | verify | idempotent | down | nuke | status | monitoring | all`.
`backup-store` (P3a) creates the backup bucket, generates the object store's
self-signed TLS material, and dials the store from a container on a fresh private
network inside the data node — the same NAT path a real node takes to R2, checked
rather than assumed. `verify` runs ten checks including
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
| `cb-*` volume with no placement row, **or any unlabelled volume** | **alert only**, never removed |
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

### The Milestone-0 retro · done · [the retro](docs/14-roadmap/06-milestone-0-retro.md)

D-169 made the retro part of the milestone: end by replacing assumptions with
measurements. Six measurements existed; all six pointed the comfortable way.

**The retro's main output is a refusal.** The 350 MB per-active-project planning
budget and the 150-active/node density figure did **not** move, even though the
first data is ~3× under. D-209 now states the four conditions any measurement must
meet before they can — full triplet, x86 launch-SKU hardware, ≥50 co-resident
projects, client load attached — because every M0 number came from one of three
processes, on ARM, idle, at 21 co-resident. Lowering a planning number on
convenient data is how a density model becomes confidently wrong.

What did change: the paused-project disk residual was 8–30× pessimistic and is
re-based to ~60 MB (D-207), which *strengthens* the pause multiplier the cost model
rests on. D-071's warm pool is deferred with an explicit trigger (D-208) because
the cold create path already runs 18× inside its budget — the first time R-4
("building ahead of users") was caught in the act and stopped. R-6 (provisioning
corruption) drops 9 → 6 on built-and-green evidence; R-2 and R-12 deliberately hold.

It also counts what the build taught us about the plan. Twenty-three of 210
decisions came from executing rather than planning, and **not one reversed an
architectural choice** — every correction was a level down: a flag, a threshold, a
column name, an ordering. The corpus was directionally right and locally wrong, in
ways only execution surfaces.

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
---

## 4b. Phase 1 — the platform surface

Milestone 0 built the spine: one endpoint, one hard-coded org, a static token, and a
real database at the end of it. Phase 1 turns that into something a person can hold
an account on, and gives them a dashboard to hold it in. The [phase plan](docs/14-roadmap/01-phase-plan.md) sets three exit
criteria, and they are what the tasks below are measured against:

1. two users with different roles see correct permissions end to end;
2. every mutating call leaves an audit row;
3. CI runs unit + integration suites green on every PR.

### P1a — identity, membership and audit schema · done

`20260901090000_p1a_identity_and_audit.sql`: `users`, `user_identities` (so an OAuth
provider can be added later without a rewrite), `organization_members`,
`organization_invites`, `project_api_keys`, `audit_logs`.

The bootstrap owner is seeded **with no password hash**. It exists so the dev org has
an owner, and it cannot be logged into — a seeded account with a known password is
the oldest way to ship a backdoor by accident.

Two findings, and both are in the decision log.

`REVOKE … FROM PUBLIC` does not bind the table owner, so the first version of
"append-only audit" was not append-only at all: the migration ran as the owner, and
so did the API (**D-215**). The fix is a `BEFORE UPDATE OR DELETE` statement-level
trigger that raises unconditionally — a rule the *owner* also obeys — plus a
least-privilege application role, below (**D-216**).

```sql
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION corebase_audit_is_append_only();
```

And the ordering bug CI found rather than I did: the migration linked the bootstrap
user to the dev org by joining on its slug, but on a **clean** database that org does
not exist yet — the API creates it at startup. So the INSERT matched nothing and a
fresh install came up with an organization that had no owner. My staging database
already had the org from Milestone 0, which is exactly why it survived until the
integration lane ran against an empty one. `ensureBootstrapOrg` now creates the
membership too, idempotently.

### P1b — the application role, the audit writer, the envelope · done · 15 tests

**A role that cannot rewrite history.** `corebase_app` is `NOLOGIN` with grants
narrow enough that `UPDATE audit_logs` is refused by privilege and not only by
trigger (`20260901100000_p1b_app_role.sql`). The API runs as it; migrations do not.

**`writeAudit(q, actor, event)`** takes the *caller's* client rather than a pool, so
the audit row joins the mutation's transaction — an audit written outside the
transaction is a lie waiting for a rollback.

It redacts on the way in. The key patterns catch `password`/`token`/`secret`/`key`,
with a `NOT_SECRET_KEY` allowlist so that `idempotency_key`, `key_prefix`, `kek_id`
and friends stay readable — over-redaction hurts too, and an audit trail full of
`[redacted]` is not evidence. The value patterns catch PEM blocks, JWTs, 43-char
base64url secrets and password-bearing connection strings, so a secret pasted into
an innocuously-named field is still caught. Metadata over 8 KiB is truncated, never
rejected: dropping the audit row is the worst possible response to a large one.

**A guard that keeps criterion 2 true.** A test enumerates every mutating route via
Fastify's `onRoute` hook and fails if one has no audit call. This one is worth the
paragraph because it was wrong **twice** and passed both times: first it parsed
`printRoutes`' tree and matched nothing at all, then it built the app without the
auth and orgs modules so it could not see half the mutating surface. Both times the
proof was the same — add a throwaway unaudited route and watch the guard fail.

**The `/v1` envelope** now matches the documented contract, closing OQ-175, and
list endpoints use keyset pagination with an opaque base64url cursor over
`(created_at, id)`. Never OFFSET: page 500 of an OFFSET query reads 10,000 rows to
return 20, and it skips rows when the set changes under the reader.

### P1c — passwords, sessions and personal access tokens · done

**scrypt**, at the user's direction, rather than paying argon2's native-build cost
(**D-211**). `N=65536, r=8, p=2`, parameters stored in the hash so they can be raised
without invalidating anyone, NFKC normalisation so a password typed on a different
keyboard still verifies, and `verifyPassword` returning `{ok, needsRehash}` so the
login path upgrades old hashes — raising the cost is worth nothing to existing users
otherwise.

Nothing distinguishes an unknown email from a wrong password: not the status, not the
message, and not the timing. The last one is why `decoyHash`/`burnVerify` exist — a
miss that returns in a millisecond while a real failure takes 100 ms is an
enumeration oracle no matter what the body says. Login is rate-limited per identifier
*and* per address, since either alone has an obvious hole, and failures are audited
with a reason the operator sees and the client never does.

Sessions are opaque ids in Redis under a SHA-256 of the key, with a 7-day idle and
30-day absolute TTL, `HttpOnly`/`SameSite=Lax`, and CSRF enforced inside the
principal resolver for mutating methods — not in a hook someone can forget to add.
PATs are `cbp_`-prefixed, hashed at rest, and shown exactly once (D-060): the list
endpoint cannot leak one even if it is wrong.

`resolvePrincipal` tries session cookie, then PAT, then the static token — which
authenticates but is *nobody*, so `/v1/auth/me` says so rather than inventing a user.

Deferred out loud: `verify-email` and `password-reset` need an email sender, which is
Phase 4. They are **absent rather than stubbed** — a 501 route is a promise a client
will code against, and a silently-succeeding stub is worse than either.

### P1d — organizations, roles and project scoping · done · *exit criterion 1*

The role model is [one table](services/api/src/kernel/permissions.ts), not scattered
`if (role === 'owner')` checks, because a matrix can be *read* to answer "what can an
admin do" and conditionals can only be searched.

Three checks, deliberately separate:

- `can(role, capability)` — the matrix.
- `canAssignRole(actor, target)` — "may change roles" and "may grant *this* role" are
  different questions, and conflating them lets an admin promote themselves to owner.
- `canActOn(actor, subject)` — an admin must not be able to strip every owner and
  take the org, a hole no single capability check closes because "may change roles"
  was true the whole time.

A non-member gets **404, not 403**: 403 confirms the org exists.

What P1d exposed in Milestone-0 code was worse than what it added. Project list
returned **every project on the platform**; project names were checked for uniqueness
**globally**, so one tenant's naming leaked into another's (**D-217**); a delete was
audited under the bootstrap org rather than the project's own; and the project routes
demanded the static token first, so a logged-in user's cookie was rejected. Also
`count(*) … FOR UPDATE` is not valid Postgres, which made every "cannot remove the
last owner" case a 500 — the fix is to lock the rows and then count them.

### P1e — project API keys and JWKS · done

ES256 JWTs, [hand-written](packages/jwt/src/index.ts) to support exactly one
algorithm. `verify` rejects any `alg` other than `ES256` **before** computing a
signature and requires a 64-byte R‖S, which is the whole `alg: none` /
algorithm-confusion family closed by construction rather than by configuration.

Provisioning now mints a per-project keypair and two keys — `anon` and
`service_role` — stored envelope-encrypted like every other credential, and
`mark_ready` refuses unless both exist. `GET /v1/projects/:ref/.well-known/jwks.json`
publishes the public half so a customer's own services can verify tokens without
calling us.

One bug worth keeping: both keys' `key_prefix` came out as `eyJhbGciOiJF` — the
base64 of the JWT header, identical for every key ever minted, which made the column
useless for the one job it has. It is now a label, `cbk_anon_<ref4>` (**D-218**).

### P1f — CI · done · *exit criterion 3*

Two lanes, and the split is the point.

**`unit`** — install, `pnpm typecheck`, `pnpm build`, `pnpm test:unit`: **216 tests
across 11 packages**, no infrastructure, about a minute. The build is in this lane
because `tsc --noEmit` is happy about plenty of things `next build` refuses. Every package got a `test:unit` script
that excludes `**/*.e2e.test.ts`, which meant renaming the DB-dependent tests to say
so in their filenames — a test that needs a database should declare it where you can
see it, not in a `beforeAll` that skips. The lane is run with the database and Redis
URLs pointed at **dead ports**, so anything that quietly reaches for infrastructure
fails here instead of passing by accident on a runner that happens to have some.

**`integration`** — builds the project image (so the D-078 extension allowlist and the
D-185 auth hardening are enforced in CI, not just locally), brings up the same Docker
staging substitute the dev loop uses, migrates, generates a master key, enables the
application role, seeds the image onto the data node, runs `staging.sh verify`, and
then runs the full **379-test** suite. On failure it dumps `staging.sh status` and
both containers' logs, because a red CI run with no diagnostics costs a full
reproduce-locally cycle.

The integration suites **do not skip** when their infrastructure is missing — they
fail, with the command that fixes it. A silently-skipped suite once hid a real bug
behind a green run here, and CI is exactly where that would happen again.

**`nightly.yml`** carries the drills that are too slow for a PR and too important to
run only by hand: the T6 kill matrix (11 SIGKILL points), the T7 lifecycle residue
loop (20 cycles), the T8 node-reboot drill, and the M-002 provisioning bench. On a
schedule they stay honest; on every PR they would get disabled within a week.

The whole recipe was replayed locally from a **nuked** stack before being committed —
7 migrations from empty, 10/10 verify — which is how the fresh-install
bootstrap-owner bug in P1a surfaced.

**It is green on a runner now**, and getting there took three failures that no local
run could have produced, which is the argument for CI in three lines:

1. `pnpm/action-setup` refuses to start when both its `version` input and
   package.json's `packageManager` name a version. The input is gone; pinning it
   twice is how the two drift.
2. buildx's default *docker* driver cannot export a cache, so `cache-to: type=gha`
   failed the very build it was meant to make cheap. `setup-buildx-action` supplies a
   docker-container builder, which supports both the GitHub cache and `load: true`.
3. `./certs:/certs/client-out` was a bind mount on the data node, and **on Linux the
   Docker daemon creates a missing bind-mount source directory as root** — so
   `infra/docker/staging/certs` arrived root-owned and the script could not write the
   certs it was about to pull. Docker Desktop remaps bind-mount ownership to the
   local user, which is why this script worked on macOS for months with a latent
   defect. The mount was also doing nothing: dind writes client certs to the named
   volume, and inside the running container `client-out` held only what the host had
   put there. Removed, not repointed (**D-227**), and `cmd_up` now creates the
   directory before compose can.

**And then the lane itself turned out to be wrong**, which is worth recording
because the failure mode is invisible. Two defects, and together they meant the
"needs no infrastructure" proof proved nothing. `services/worker/src/e2e.test.ts`
was not matched by `**/*.e2e.test.ts` — the glob needs something before `.e2e.` and
that filename has nothing — so nine tests that truncate the staging database were
in the unit lane the whole time. And turbo was replaying a **cached pass**: results
were keyed on file hashes, but a database is an input turbo cannot hash, so
re-running with the database URL on a dead port produced a cache hit and printed
"10 successful" without executing a thing. Both are fixed (**D-223**): the file is
renamed, `test` and `test:unit` are `cache: false`, and an audit of all 32 test
files says it was the only leak. The numbers above are from after the fix.
### P1g — the dashboard shell · done · 13 tests

`apps/dashboard`, a Next.js App Router app that is a pure client of the platform
API (D-130): no API routes, no BFF, no server-side control-plane access. Session
cookies for auth, TanStack Query as the entire data layer — the server cache *is*
the app state, so there is no store.

**The first version of this was rejected, and the rejection was right.** The colours
were correct and the mechanics were not: it was a page router with panels. Three
projects filled a screen that should hold twenty, nothing was reachable from the
keyboard, there was no way to create an organization at all, and the design system's
own instructions — "dense by default: 52px rows", "skeletons match the shape of the
content they replace" — had been ignored while its tokens were honoured.

The response was not a nicer set of screens. It was
**[docs/09-dashboard/05-ux-standards.md](docs/09-dashboard/05-ux-standards.md)**:
the interaction contract, written as rules with reasons, ending in a twenty-question
gate. **D-224 makes it binding and makes the gate run on every UI change**, enforced
as the `ux-review` role in [.claude/skills/](.claude/skills/ux-review/SKILL.md) and
pointed at from [CLAUDE.md](CLAUDE.md). The reference bar is named in the document —
Supabase's dashboard — and so is the reason it is reachable now rather than after a
final redesign: its depth is *shell* properties, not features, and shell properties
can be met with four pages.

**What the shell does**

- **Context is always visible and always switchable from where you are.** The
  breadcrumb is `org / project` and both segments are menus, so switching either
  never requires going up to a list page first.
- **The chrome does not re-render on navigation.** It lives in route *layouts*, so
  moving between project sections repaints the content region only — verified by
  marking the sidebar and top-bar DOM nodes and confirming they survive a real
  client-side navigation.
- **A command palette on `⌘K`** (`Ctrl K` off macOS, detected) that navigates,
  switches organization and project, creates either, copies a connection string or
  a project ref, toggles the theme and signs out. Matching is *subsequence*, so
  `grn` finds "Switch to Greenbull" — a palette that needs exact word order is one
  you have to remember rather than guess at. **D-226 makes it a requirement**: every
  capability a menu exposes is also in the palette, and new capabilities land there
  first, which is also what forces every action to have a name and an invocable
  handler for the CLI later.
- **`g p` / `g o` / `g c` / `g k`** to jump, `?` for the shortcut sheet, `Esc` closes
  the topmost layer. Global keys never fire while the user is typing, and `g` is a
  prefix that expires after a second so a stray keystroke does not silently arm a
  jump.
- **Dense tables by default**, cards available where identity matters, and the choice
  remembered per browser. The toggle is hidden when there is nothing to switch
  between — a control that cannot do anything reads as broken, not as disabled.
- **Every mutation answers.** The pressed control shows pending and refuses a second
  submit; completion produces a toast naming what happened; copying reports through
  the toast layer rather than by mutating its own label, because the user's eyes are
  on the field they are about to paste into.
- **One error surface for the whole app** — platform `code`, a sentence, and the
  `request_id` with a copy button (D-032) — so no page can render `String(error)`
  and drop the only thing support can act on.
- **Motion**: 120–180 ms, `transform`/`opacity` only, fully disabled under
  `prefers-reduced-motion` (**D-225**, resolving OQ-170).

**Pages**: login, signup, projects (table/cards), new project, project overview,
Connect, API keys, new organization, and `/no-org`. Three project sections and one
org section, all of which are real — the IA's full sidebar is Phase 2+ and none of
it appears until it works.

**Connect** renders the same credentials four ways — URI, `psql`, `.env`, Node — with
the selected tab in the URL, because "open Connect, then click the third tab" is the
instruction gate question 3 exists to eliminate. **API keys** shows `anon` in full
because it is publishable by design, and `service_role` as its label with the exact
`curl` to read it, because the audited reveal needs a confirmation flow that states
what the key does and that looking is recorded — a half-built version would write
audit rows saying a key was revealed when nothing displayed it.

**Two guards on the visual layer**, both proven by introducing a violation and
watching them fail: no stylesheet may name a ramp step (D-178) and there are no drop
shadows (D-179). The shadow rule had to be rewritten first — banning `box-shadow`
outright failed on the design system's *own* focus ring and the 3px active-nav bar,
which are required, so the rule is the blur radius. A third guard came out of a bug
the user spotted: **`--cb-space-5` does not exist**, the 4-point scale being
4/8/12/16/24/32/48, and an undefined custom property with no fallback invalidates the
whole declaration rather than falling back — so five paddings silently became zero
and the palette's input sat flush against its edge. A test now fails on any token
reference that would collapse.

**What the first gate run found, in the code written to satisfy it**

- **Q6** — the palette was missing "Copy connection string" and "Copy project ref",
  which the projects table's row menu already had. That is precisely the decay D-226
  exists to prevent, and there was a `void conn;` line in the palette proving I had
  noticed and moved on.
- **Q12** — the list ignored `pagination.next_cursor` and printed "Showing 20 of 20"
  for an organization with 25 projects. Now an infinite query with a truthful count
  and a Load-more.
- **Q7** — `Esc` closed the palette but focus landed on `<body>`, because the input's
  `autoFocus` had already moved focus by the time the layer's own effect captured
  "what had focus before". The capture has to happen at the event that opens the
  layer, which is now a shared hook, and both layers were re-verified by asserting
  `document.activeElement` after Escape.

**Bugs found by looking at it rather than by testing it**, several of them caught by
the user: a project's status is `creating`, not `provisioning`, so the badge went
neutral and — much worse — the overview decided the project was not settling and
**stopped polling**, meaning it would have sat on CREATING until reload; the state
map is now `Record<ProjectStatus, …>` against the enum, so a new state is a compile
error. Per-character `<span>`s in the palette's match highlighting destroyed text
shaping, rendering "G r e e n b u l l". Anchors styled as buttons carried the
browser's underline. "you are a owner". The org switcher had a uniform violet circle
per row — decoration in the shape of data — now the organization's initial. Seven
identical squares down the sidebar, now drawn glyphs. And a hydration mismatch from
the deliberate pre-paint theme script, scoped with `suppressHydrationWarning` on the
one element where it is true.

**The logo** is the supplied artwork used verbatim — a diamond with its centre
punched out by `fillRule="evenodd"` — recoloured to role tokens, and with the
accessible name as an `aria-label` rather than `<title id="title">` so two marks on
one page do not collide on ids. An earlier attempt of mine was scrapped because at
26px it read unmistakably as a person icon.

**Verified by driving it.** Signed in, switched organizations, created projects,
watched `creating` → `ready` with no reload, opened Connect and pasted its string
into `psql` where it created a table and inserted a row, read the keys page, ran the
palette from the keyboard, checked focus restoration on both layers, confirmed the
chrome survives navigation, and looked at every screen in both themes.

---

## 4c. Phase 2 — the database platform

Per the [phase plan](docs/14-roadmap/01-phase-plan.md): PgBouncer per project,
the `DATABASE_URL`/`DIRECT_DATABASE_URL` distinction, credential rotation,
pause/resume with idle detection, disk quotas and the disk-full ladder,
bin-packing placement, and cgroup limits.

**Exit criteria** (four, and the first one is gated by D-209):

1. 100 test projects on one node within RAM budget; density matches the cost model
   or the model is corrected. **D-209 constrains what this may conclude**: the
   planning numbers may only be re-based on a measurement with the full triplet, on
   x86 launch-SKU-class hardware, with ≥50 co-resident projects and client load. A
   run on this ARM laptop can inform the risk register and may not move the model.
2. Pause after the idle threshold; resume in target time; no data loss across 50
   pause/resume cycles.
3. A project that fills its disk quota goes read-only and recovers when space is
   freed; the node itself never suffers.
4. Credential rotation works with active connections, with documented behaviour.

### P2a — a private network per project · done · 8 tests

Phase 2 opens with substrate rather than a feature. The pooler's rendered
`pgbouncer.ini` says `host=db` and PostgREST's `db-uri` will say the same, so both
need a network the project's containers share and a stable name for Postgres on it
(**D-228**). `cb-<ref>-net`, derived from the ref rather than stored — exactly one
exists per project and nothing allocates it, so a column would be a second place
for the same fact to be wrong. The published host port stays, because
`DIRECT_DATABASE_URL` is a contract.

`create_network` runs before `start_container`, which joins at *create* time rather
than attaching after start: a container that starts unattached resolves nothing for
the first moments of its life, and for the pooler that window is exactly when it
first reaches for `db`. `start_container` also *ensures* the network rather than
trusting the step before it — every other step here is safe run alone, this one
briefly was not, and the symptom was a Docker 404 from inside container start that
reads as an infrastructure fault rather than as a skipped step.

**The network's whole lifecycle is covered** (**D-229**): removed at soft-delete,
not only at purge, because it holds no data and does hold a subnet from the node's
address pool — finite, and otherwise held for a week per deleted project.
`verify_gone` asserts its absence, and reconciliation gained an `orphan_network`
drift class. That is not hypothetical: 18 leaked from failed runs in one afternoon,
and a node that exhausts its address pool cannot create the next project's network
at all.

Proven on a real node rather than in a spec: a second container on the network
resolves `db` and `psql` connects to Postgres through it, and a network with a
container attached refuses removal — which is what makes the purge ordering
load-bearing rather than stylistic.

### The bug P2a uncovered, which was not P2a's

Adding two saga steps turned the worker suite red, and chasing it found something
older and much worse. **The Engine API client was using Node's global `https`
agent, which has had `keepAlive: true` on by default since Node 19** — so every
call parked a TLS socket without bound. A run of ~130 provisioning operations broke
a node's listener *permanently*: every later connection was reset, from our client
and from the `docker` CLI alike, until the whole engine was restarted.

It had presented as "Docker Desktop is flaky" and is almost certainly the cause of
the two earlier engine deaths recorded in this project. One pooled agent per client
with `maxSockets: 8` (**D-230**), and the worker suite went from 58 failures to 0
with the node still reachable after all 387 tests — which it had not been at any
point that day.

Two more things a live `demo.sh` run surfaced that no test covered. The demo assumed
the account had exactly one organization, so running the API test suite broke it —
the suite creates orgs with the same static token, and the API is right to refuse to
guess (**D-231**; clients resolve the org explicitly now). And `--purge` looked
broken because the purge scan defaults to an hour, which is correct in production
and wrong in a dev loop whose whole point is watching the purge happen.

**Three hand-kept lists of saga step names** in the e2e suites were replaced with
lists read from the sagas. Inserting two steps broke all three at once — one
silently stopped removing the network, and `verify_gone` caught it, which is exactly
what that step exists for. Third time a duplicated list has cost time here.

Verified end to end after every change: create → provision → `psql` → `CREATE
TABLE` → soft-delete → purge in 18s, leaving the node holding only Docker's own
three networks.

### P2b — a connection pooler for every project · done · 12 tests

The `pooled` connection string stopped being a promise. PgBouncer in transaction
mode, one per project (D-015), on the network P2a built — its config says
`host=db`, which is why that network came first.

**How the pooler gets credentials without holding them.** `auth_query`, not a
`userlist.txt` (D-074): the pooler asks Postgres for a connecting user's verifier
through `corebase.pgbouncer_lookup`, so a rotation is one `ALTER ROLE` with nothing
to ship or reload. The image creates `pgbouncer_auth` as a **passwordless** LOGIN
role and the worker sets its password at provision time, so no credential is baked
into an image (**D-232**).

Two details in that function are load-bearing. `SET search_path = pg_catalog` stops
a caller shadowing `pg_shadow` with their own relation and having a definer-rights
function read it instead — a SECURITY DEFINER function without a pinned search_path
is a privilege escalation, not a style preference. And the allowlist inside it is a
*boundary*: only `developer` is resolvable, so the pooled port cannot reach
`postgres`, `authenticator`, `corebase_admin` or `pgbouncer_auth` itself even if
PgBouncer is fully compromised. Verified by presenting the correct superuser
password to a real project's pooled port and being refused — while `developer` still
connected, so the refusals are the allowlist and not a broken pooler.

**The image is ours** (**D-233**), 23.6 MB, running as a non-root user created
explicitly in the Dockerfile since Alpine's package provides none. Every rule in
`pgbouncer.ini` is baked in and only values come from the environment, because here
the configuration *is* the boundary: pool mode, the auth_query wiring and the pool
arithmetic all have recorded rationale, and an entrypoint that accepted arbitrary
config would let any of them change by accident. Pinned ≥1.21, where
protocol-level prepared-statement tracking arrived — without it transaction pooling
breaks node-postgres, psycopg and most ORMs on contact.

**The gate proves the chain, not the process.** `wait_pooler_healthy` connects as
`developer` *through* the pooler and runs a query, which is the only check that
exercises all of it: PgBouncer accepted the client, authenticated itself as
`pgbouncer_auth`, resolved the customer's verifier through the lookup, and proxied a
real transaction. A TCP check on 6432 passes for a pooler that can do none of that.
`mark_ready` refuses without a pooler recorded (**D-234**), and the delete saga
stops the pooler *before* the database — one left answering against a stopped
Postgres fails connections in a way that reads as "the database is broken" rather
than "the project is deleted".

**Reconciliation had a real bug the moment a project had two containers.** It keyed
them by project ref alone, so the two overwrote each other in the map and whichever
came last in the Engine's listing won — **a stopped database read as healthy for as
long as its pooler was up**, which is the exact failure reconciliation exists to
catch. A role label now discriminates them, a dead pooler is its own
`pooler_not_running` drift class, and a pooler outliving its project is stopped like
any other zombie (**D-235**).

**Verified live**, end to end: a project through the real saga reaches ready in 3s
with the pooled gate passing; the `DATABASE_URL` the dashboard renders was pasted
into `psql` and created a table through PgBouncer that the direct URL then read
back; twelve concurrent clients shared one Postgres backend; and the internal roles
were refused on that project's pooled port.

One thing trying it changed: most of what transaction pooling breaks **does not
error**. `LISTEN` on the pooled URL returns success and then never delivers. The
dashboard says so in those terms, because "these need the direct URL" invites the
conclusion that the pooled one errors, and the developer finds out otherwise in
production.

Also in this step: the staging substitute publishes the pooler port range (an
allocated-but-unpublished port is a dead `DATABASE_URL` that looks like a broken
pooler), `seed-images` loads both images and names the build command if either is
missing, and the compose project is now `corebase` rather than `corebase-staging`.

### P2c — pause and resume · done · 9 tests · [M-007](docs/14-roadmap/05-measurements.md)

**Exit criterion 2, met.** A database per free project is only affordable because
idle projects release their RAM (D-008), and this is the mechanism.

Pause shuts Postgres down *cleanly* — `CHECKPOINT`, then a graceful stop — rather
than killing the container, so the volume has no WAL to replay. That is most of why
resume is sub-second, and it is asserted rather than assumed: a test greps the
resumed instance's log for `redo starts at` and fails if recovery ran. Containers
are **removed**, not merely stopped, which is where the overhead actually is; the
volume, the network and the placement row stay, because that row is what lets resume
hand back the *same* connection string (**D-239**). A customer whose URL changed
after an idle week has lost data in the only sense they care about.

Re-booking the RAM is deliberately the **first** step of resume: it is the step that
can legitimately fail, and a node that filled up while a project slept must refuse
before containers start, not after. Until backups exist it names the node and stops
rather than silently placing the project elsewhere.

**Measured** ([M-007](docs/14-roadmap/05-measurements.md)), twenty cycles through
the real API and worker: **pause p50 746 ms, resume p50 546 ms / p95 1199 ms** —
9× and 12× inside the p50 < 5 s / p95 < 15 s target. And **50 consecutive cycles**
with the rows, the port and the credentials all intact.

**A latent accounting bug fell out of it** (**D-237**). `releaseNode` credited the
node with the *plan's* RAM whenever a placement row was deleted. Purging an
already-paused project — booking zero — would have returned 350 MB that was never
reserved, leaving the node permanently under-counted and accepting work it cannot
hold. Under-counting is the dangerous direction: over-counting wastes a node,
under-counting overloads one. The booking now lives on the row.

**The idle scan took three attempts, and each wrong version is worth knowing**
(**D-236**):

1. Counting `developer` backends alone reports a busy project for four minutes after
   the last client leaves, because PgBouncer parks server connections *as the
   customer's role* for `server_idle_timeout`. A project that never looks idle never
   pauses, and the free tier stops paying for itself.
2. Asking the pooler how many clients it has fixed that and broke the opposite case:
   subtracting its server count cancels a real direct connection against a parked
   one, so a project with one live `psql` session read as idle and would have been
   paused under its user.
3. The pooler's backends are now identified by its **address** on the project
   network rather than counted. Exact in both directions — and the console's own
   pool is excluded, because otherwise the scan counts itself as a customer.

Both signals are required and a project that cannot be asked is left running:
"cannot conclude" is not "idle", and pausing on a failed probe would pause healthy
projects during a blip. **The honest gap:** the doc's *first* signal — no data-plane
traffic — needs a gateway that does not exist. Today the second signal is sufficient
*because* there is no data plane, so a client connection is the only way to use a
project at all. That stops being true the moment Phase 5 lands PostgREST, and the
failure would be silent.

`POST /v1/projects/:ref/pause` and `/resume` are a **member's** business — the
platform API lists their mutations as "create/pause/resume" — which is why
`project.lifecycle` has been separate from `project.delete` since P1d. They return
409 with the current state for a project in the wrong one, not 404: a project that
is already paused exists, and saying otherwise sends the caller hunting a bug that
is not there.

**And an empty JSON body is no longer an error anywhere** (**D-238**). Fastify
rejected it with "Body cannot be empty when content-type is set to
'application/json'" — a framework 400 blaming the client for our contract, landing
on exactly the endpoints that take no body. Every HTTP client sets a JSON
content-type by default. This supersedes the half of D-198 that made the best of the
rejection; malformed JSON still keeps its 400, which was D-198's actual point.

### P2d — credential rotation · done · 5 tests

**Exit criterion 4, met**: "credential rotation works with active connections
(documented behaviour)". The documented behaviour has three parts, each asserted
against a real project rather than described.

**An established session survives.** Postgres authenticates at connect time only,
so a rotation is invisible to a running application. That is not a footnote — it is
what makes rotation safe to do routinely, and the credentials doc says why that
matters: *a credential you are scared to rotate is a credential you will leak and
keep.*

**A new connection with the old password is refused**, immediately and with no
window.

**The pooler needs nothing** — no config re-render, no file to ship, no reload.
`auth_query` reads `pg_shadow` live, so one `ALTER ROLE` is the entire rotation.
This is the payoff D-074 picked auth_query for, and it is asserted as an *absence*:
same container id, never restarted, and the pooled port serving the new credential
while refusing the old one. Verified live through the HTTP API as well as in tests.

Store-then-apply (**D-246**) is the ordering rule, and one test runs only the store
half — which is exactly what a crash between the two looks like. The old password
still works, the new one does not yet, and the retry applies it. The reverse order
leaves a database whose password exists nowhere.

The new version is numbered from the **highest ever used**, not the active one,
because the AAD binds `(project_id, name, version)` — reusing a number after an
earlier rotation left higher retiring rows would make two different ciphertexts
claim to be the same secret. The previous version is kept `retiring` for 24 hours so
"which credential is my app on" has an answer, then purged.

**Rotation is admin-only (`secret.manage`) while revealing is a member's right
(`project.read`)** — a deliberate asymmetry (**D-247**). Reading your own
credentials is using the product; replacing them breaks every application holding
the old ones, which one member should not be able to do to a colleague's running
service by accident.

**`terminate` is opt-in** (**D-248**) and documented as compromise response.
Rotating alone does nothing about someone who already holds a connection. Two facts
made the default worth stating twice: a terminated `pg` connection emits an
`'error'` event, and an unhandled one takes a Node process down — so `terminate`
does not merely fail an application's next query, it can crash one whose pool has no
error handler.

The dashboard dialog exists because the credentials doc calls rotation a first-class
screen. Its job is to remove fear rather than add friction: no type-to-confirm,
since rotation destroys nothing and the new string is on the same page, and
`terminate` is an unchecked checkbox labelled with its consequence that turns the
button red when checked.

### P2e — the disk-full enforcement ladder · done · 11 tests

**Exit criterion 3's testable half is met**: a project that fills its quota goes
read-only and recovers when space is freed. The rungs are D-073's — ≥80% warn, ≥90%
critical, ≥95% soft read-only — with the filesystem quota at 120% as the backstop.

Usage comes from `pg_database_size()`, the same source the billing path uses, so the
number a customer is charged on and the number that throttles them are the same one.
Two sources would eventually disagree, and the disagreement would arrive as "you
throttled me at 94%".

Read-only engages at 95% and lifts below **90%** (**D-251**). The hysteresis is
deliberate: a project on the boundary would otherwise flap between writable and not,
and each flip is an incident from the application's side — errors appearing and
vanishing with no deploy. Only that rung is sticky; a warn banner clearing is free.

**Disk is booked at placement** on the same 85% ceiling as RAM (**D-250**), and
released only on purge, never on pause — a paused project keeps its volume, so its
disk stays occupied while its RAM does not. Booking memory and ignoring disk is how
a node fills with projects that each have memory to spare and nowhere to write.

**Two findings, both from running it rather than reading it** (**D-249**).

The rung is advisory by design, and the provisioning doc named the recovery as
`SET transaction_read_only = off`. **That does not work.** Under autocommit each
statement is its own transaction and that GUC applies only to the transaction it
runs in, which then commits — so a customer following our documentation would have
concluded they were locked out of the one action that fixes their problem. The doc
is corrected at source, and a test now asserts the *wrong* form fails so it cannot
drift back.

The same mechanism made the ladder a **one-way door**. `ALTER DATABASE` is itself a
write, so once a project went read-only the control plane's own admin connection was
read-only too and could not turn the flag off. A customer would have stayed read-only
forever no matter how much space they freed. That one surfaced only because the test
grew a captured scan log — the failure had been swallowed into "no transition
happened", which reads as nothing being wrong.

**The node-level half of criterion 3 is not met, and cannot be here.** "The node
itself never suffers" ultimately rests on the XFS project quota (D-070), which needs
a real node with an XFS filesystem mounted `prjquota`; the substitute runs
Docker-in-Docker on overlay and has no way to enforce a hard per-project cap. What
*is* implemented and tested is everything above the backstop: the ladder, the
recovery, disk booking so placement cannot oversubscribe, and an 85% node-volume
cordon. The hard cap is recorded as unverifiable locally rather than claimed.

### P2f — bin-packing, and the walls checked against the kernel · done · worker suite 173 → 223

Two halves of the same scope line: where a project gets placed, and what stops it
hurting its neighbours once it is there.

**Bin-packing.** Placement ordered candidates by `ram_reserved_mb ASC LIMIT 1`.
That reads as "emptiest node first" and is not — it is absolute megabytes, so a
4 GB node holding 1 GB sorts ahead of a 64 GB node holding 2 GB, and the packer
hands projects to the *fullest* node in the fleet as soon as nodes differ in size.
Nothing could show it: the only fleet that has existed here is one node.

It also took **one** candidate, so a booking that did not fit the emptiest node
failed with "no capacity" while the region had room. Quantified by reverting the
change: 20 concurrent provisions against two nodes with 18 free slots placed
**13**. Five projects refused with capacity sitting idle, and the fuller the
fleet, the likelier that gets.

Now every node that fits *both* axes is ranked by fill ratio — the worse of RAM
and disk against the 85% stop (**D-252**) — ties broken on hostname so the order
is total. The list is also what makes the locking right: each candidate is locked
and re-read before the booking is committed to, because under READ COMMITTED
`LIMIT 1 FOR UPDATE` can hand back a row as it looked before a rival's booking
(**D-253**). A provision that loses that race tries the next node instead of
failing.

Placement now refuses a node nothing has been heard from, and says so rather than
"no capacity" (**D-254**). `status` stays `active` when a worker dies, so a project
sent there does not fail — it sits in `creating` until the saga times out, which
reads as "provisioning is slow" and points at nothing.

**The walls.** D-055 asks for memory, CPU, IO, disk quota, connection caps,
`statement_timeout` and rate buckets. Memory and CPU were set from day one; this
adds process count (**D-256**) and disk I/O, and changes how all of them are
verified (**D-257**).

The I/O weight is the finding. Adding `BlkioWeight` — literally what the doc asks
for — made **every container on the node fail to start**:

```
openat2 /sys/fs/cgroup/docker/<id>/io.weight: no such file or directory
```

`io.weight` exists only on a kernel with a weight-capable I/O policy (BFQ, or
blk-iocost). This one has neither, so the io controller offers `io.max` and
`io.stat` and nothing to weight with — and runc turns the missing file into a hard
failure rather than a warning. The wall meant to protect the neighbours took down
the tenant. The engine cannot be asked either: on cgroup v2 `/info` has dropped
its blkio fields and reports no warnings. So the node is probed once from inside a
container, and every uncertain answer resolves to *unsupported* (**D-255**) —
because a missing weight costs fairness on a busy disk while a weight the kernel
cannot apply costs every provision on that node.

The pid ceiling is not for Postgres, which forks politely. It is for whatever else
gets to run inside the container — a `COPY … PROGRAM`, a compromised extension —
since exhausting the *node's* pid space means no tenant's database can fork, and
neither can the reconciler that would notice. Its cost is recorded rather than
discovered later: a container pinned at its ceiling cannot be `exec`ed into, so an
operator cannot get a shell into the container that most needs one.

**Every limit is now read from `/sys/fs/cgroup` inside the container, never from
`docker inspect`** (**D-257**). Inspect echoes the HostConfig we sent and cannot
tell "applied" from "accepted and ignored" — which is exactly why the existing T5d
limits test stayed green while the I/O weight was breaking every container on the
node. Two assertions go past configuration into behaviour: `cpu.max` proven by a
busy loop consuming ~1s of CPU in 2s of wall time instead of ~2s, and `pids.max`
by the kernel refusing the fork.

Two smaller things fell out. The engine reports a failed exec **on the exec's own
output stream** with a 200, so a caller reading stdout gets `OCI runtime exec
failed: … unable to spawn stage-1` where a value should be — this suite asserted a
cgroup value against that sentence and reported it as a cgroup mismatch. An error
arriving as data, the same shape as P2e's swallowed ladder transition; the client
throws on it now. And the project image declares `VOLUME
/var/lib/postgresql/data`, so every mount-less probe container leaked an anonymous
volume that `v=0` keeps forever — caught by reconciliation two suites away,
reporting each one correctly as disk with no owner (**D-258**).

### P2g — the density measurement · done · M-008

Exit criterion 1: *"100 test projects on one node within RAM budget; density
matches the cost model assumptions or the model is corrected."*

**It holds. 100/100 projects, 200 containers, 98.9 seconds, no failures** —
create→`ready` p50 3514 ms / p95 5309 ms at concurrency 4, with a pooler started
for each, still 5× inside the 30 s target. All 200 client connections attached and
ran 1.4 million statements over 60 s.

`pnpm --filter @corebase/worker density` is the instrument; the numbers are
**[M-008](docs/14-roadmap/05-measurements.md)** and the raw JSON is beside it.

| per project (anon working set) | idle | under load |
|---|---|---|
| Postgres | 7.5 MiB | 11.9 MiB |
| its pooler | 1.2 MiB | 1.2 MiB |
| **total** | **8.68 MiB** | **13.06 MiB** |
| booked by placement | 350 MB | 350 MB |
| **booked : used** | **40 : 1** | **27 : 1** |

**The finding is not the memory — it is the CPU.** RAM was over-booked 27-fold
while **CPU sat at 8.21 of 10 cores** with two connections per project. The cost
model books RAM and reasons about density in RAM (D-091, D-174); it does not model
cores at all. That is a claim about *this* hardware — 10 ARM vCPU against a
CCX43's 16 dedicated x86 cores — but it is the first measurement here taken with
load attached, and it points at a different binding constraint than the one the
model watches. Recorded as **OQ-182** and as a new early-warning signal on
**R-2**.

Two smaller findings. The pooler's measured working set is **1.2 MiB** against a
budgeted 10–20 MiB and a 64 MiB ceiling — 53× headroom on a sidecar that may cost
almost nothing (**OQ-183**). And disk is **8.3 MiB per project** from
`pg_database_size`, which is *not* comparable to M-002's ~59 MB: that was volume
footprint including WAL and filesystem overhead, and it remains the number that
matters for capacity.

**Criterion 1 is closed on its functional half and deliberately left open on its
modelling half** (**D-259**). D-209 permits re-basing the 350 MB budget and
D-091's 150-active/node only on a measurement with the full triplet, x86
launch-SKU-class hardware, ≥50 co-resident projects, and client load. This run
satisfies **two of four** — it cannot satisfy the others, because PostgREST is
Phase 5 and this is ARM. The measured numbers are ~27× more favourable than the
assumption, which is precisely when D-209 matters: a planning figure lowered on
favourable partial data is the failure it was written to prevent.

**What the run cost to get right**, all of it environmental rather than in the
product:

The first attempt stopped at exactly 20 projects, with 80 refused by a 409. That
is the per-org project ceiling — an abuse control, not a capacity one — and
leaving it in place for a node density run measures the ceiling (**D-261**).

Widening the node's published port range failed with *"invalid ranges specified
for container and host Ports"*: the compose file parameterised the host side of
the mapping and pinned the container side to `5433-5462` (**D-262**). The way
that mismatch fails when it does *not* fail loudly is the reason it earned a row —
a project whose port the node does not publish provisions perfectly and then dies
nine steps later at `wait_pooler_healthy` with `ECONNREFUSED`, reading as a broken
pooler. The harness now pre-flights the highest port it will need.

And `nodes.ram_reserved_mb` is a counter, not a view over `project_databases`, so
truncating the project tables between runs frees nothing — the node still believes
it holds the memory. The packer refused half the projects, correctly, against
bookings whose rows no longer existed. The harness recomputes the reservation from
the rows, which is what the reconciler's `reservation_drift` repair already does
and for the same reason: the rows are the truth and the counter is a cache.

### The P2 review — what a deep pass over everything found

Asked to revisit the whole build, not a step of it. Eight findings, all fixed; the
two sharpest were the same shape — a protection this codebase applies carefully in
one place and not in another.

**A hardcoded credential** (**D-240**). `CB_STATIC_TOKEN` defaulted to the literal
string `dev-token`, so an API deployed with no configuration accepted that header
as the **bootstrap owner** — full rights, no expiry, no revocation, attributed to a
real user so nothing in the audit log looked unusual. Verified before fixing:
`buildApp({})` answered 200. The project refuses this deliberately elsewhere — the
bootstrap user has no password hash, `trust` auth is banned at image build time
(D-185), `corebase_app` is NOLOGIN (D-216) — and it arrived through a `??`.

**An unmetered 64 MiB-per-request hash** (**D-241**). Only login was rate limited.
Signup is the one unauthenticated endpoint that runs scrypt, at 64 MiB a call
(D-211) — twenty concurrent requests is ~1.3 GiB, reachable by anyone with a
socket. D-211's own rationale worried about precisely this and then protected only
login.

**A database password is as powerful as the `service_role` key** (**D-242**), and
one was gated and audited while the other came back on every project read,
unlogged. Connection strings now need `?reveal=true` and taking them is recorded,
deduplicated per person per project per hour so a polling dashboard cannot bury the
reveals that matter. The capability is deliberately not raised: a member may create
projects, so a member must be able to use them.

**The one that threatened an exit criterion** (**D-245**). The data node answered
*"all predefined address pools have been fully subnetted"* **with three networks on
it**. dockerd's built-in default carves /16s from 172.17–172.31 and inside dind most
collide with the outer engine's routes — so with a network per project (D-228) a
node runs out of *addresses* at roughly ten projects while Phase 2 is aiming at a
hundred. In production that would have surfaced as a mysterious provisioning
failure. An explicit `--default-address-pool` of `10.201.0.0/16` in /24s gives 256;
verified by creating 60 project-shaped networks where the default managed three.

Also fixed: a project stuck in a transitional status with no job running is now
drift rather than invisible (**D-243**, and `pausing` was the silent case);
reconciliation no longer reports a repair it deferred; projects per organization are
capped so one tenant cannot consume a node's whole RAM budget (**D-244**); the
pooler's `userlist.txt` quoting is asserted rather than assumed, ahead of credential
rotation touching it; and two foreign keys to `users(id)` gained `ON DELETE SET
NULL`, so the first person to write a user-deletion path meets a design decision
rather than a constraint violation.

**What the review found clean:** SQL is parameterised, and the two interpolation
sites assert their alphabet and throw rather than escape; every route has an
authorization check except signup, login and JWKS, which are correctly public;
`audit_logs` deliberately has no foreign keys so history outlives what it describes;
no secrets are tracked in git; and reconciliation had already classified
`paused`/`pausing` correctly before pause existed.

**A known local constraint, not a product one:** Docker Desktop's host port-forward
to the data node wedges under sustained load — every later connection is reset, from
our client and the `docker` CLI alike, until the engine is restarted. Bounding the
worker's connection pool (D-230) made it far rarer but did not remove it. CI runs
Linux with a native dockerd and does not have this failure mode.

## 4d. Phase 3 — backups

Phase 3 was moved ahead of everything else because durability is #2 in the
priority stack (D-002), and weeks of feature work against customer-shaped
databases with no restore path is how "we lost a beta user's data" happens.

The operating rule for the whole phase is the backups doc's first line: **a backup
that has not been restore-tested is treated as not existing.** Nothing in P3a
claims a project is protected. It builds the repo that P3d's PITR restore and
P3e's verification loop will either prove or condemn.

### P3a — the backup substrate · done · 25 tests

Every project now gets a pgBackRest repo in real object storage, encrypted under
its own cipher-pass, with WAL archiving proven to reach it before provisioning
completes.

- **Object storage is MinIO in the staging stack**, standing in for R2 (D-017)
  and never a paid dependency during development. It speaks the same S3 API
  pgBackRest talks, which is the entire interface.
- **Reachability works the way production works.** A project container lives on
  its own private per-project network (D-070/D-228) and reaches the store through
  the node's NAT egress — exactly as a real node reaches R2 over the internet.
  Nothing is attached to a shared network, so no project gains a route to another;
  verified by dialling the store from a container on a fresh private network
  inside the node, and `./scripts/staging.sh backup-store` re-checks it every run
  rather than trusting it.
- **One stanza name, `main`, fleet-wide** (**D-263**) — isolation is `repo1-path`
  plus the cipher-pass, both per project. A per-project stanza name would need a
  per-project `postgresql.conf`, reintroducing the drift D-186 removed.
- **The cipher-pass is its own stored secret** (**D-264**), envelope-encrypted,
  and written into the container with `docker exec` rather than an environment
  variable (**D-265**) — `docker inspect` shows a container's environment to
  anyone who can reach the Engine API, which is the whole control plane.
- Two saga steps, `configure_backups` then `verify_archiving`, split for the same
  reason `start_pooler` and `wait_pooler_healthy` are: "we wrote a config" and
  "the thing works" are different claims. The second runs `pgbackrest check`,
  which forces a WAL switch and confirms the segment lands — so it tests config,
  credentials, cipher-pass and egress in the one place where failure is still
  cheap. Cost to provisioning: ~1.1 s.
- `CB_REQUIRE_BACKUPS` fails provisioning closed for a project that cannot be
  backed up. **Off** until Phase 3 finishes, because a fleet with no repo
  configured must still be able to provision; the log line saying a project has
  no PITR is what stops that being invisible in the meantime.

**Four findings, three of them in what I wrote and one in the image.**

`initdb` was **not running with `--data-checksums`** (**D-269**), which
provisioning §3 states and backups §7's verification requires. Its absence is
silent in both directions: page corruption goes undetected, and a verification
pass reports a healthy restore of a rotting cluster. A backup system whose checks
cannot fail is worse than none, because it manufactures confidence. Postgres 18
turns checksums on by default and 17 does not, which is how it survived review.

**pgBackRest has no plain-HTTP mode for S3** — `repo1-storage-verify-tls=n`
relaxes verification, not the protocol — so the staging store had to serve TLS
(**D-266**). That is the substitute being faithful; R2 is TLS-only too.

The first attempt hung for **60 seconds and exited 49**, which reads as an
unreachable network. It was `host:9000` in `repo1-s3-endpoint` *and* a separate
`repo1-storage-port`, so pgBackRest dialled the wrong port. Fixed, and pinned by a
test asserting the endpoint carries no port.

The last one is the interesting one. `stanza-create` began failing on saga
**replay** with exit 50 — and the error I printed was 600 characters of
configuration, because pgBackRest opens every command by echoing its full option
list and I had truncated from the front (**D-268**). Reporting from the `ERROR`
lines instead revealed the actual cause: `archive-async=y` runs a long-lived
`archive-push` worker that holds the archive lock while it batches, and
`stanza-create` was losing the race. Every pgBackRest command now retries through
lock contention (**D-267**) — non-lock failures are not retried, because a real
error hidden behind a delay is worse than a fast one. The correlation is what
makes this matter: the busier a project is, the likelier its backup commands lose
that race, so the projects whose backups matter most were the ones that would
fail.

**Verification:** `backup.e2e.test.ts` 8/8 against the live node and store — a
stanza created, archiving confirmed end to end, a full backup of a 1000-row table
landing under the project's own prefix, two projects with separate paths and
separate passes (each blind to the other's history), replay proven idempotent, and
the cipher-pass absent from both the container environment and the ciphertext at
rest. Plus `backup.test.ts` 17/17 on the config rendering and the retry logic.


### P3b — WAL-archive lag, and an alert proven to fire · done · 12 tests

**Exit criterion 3 is met.** A project whose WAL is not reaching object storage
keeps serving, keeps reporting `ready`, and stops being recoverable — nothing about
that is visible from outside, which is the entire reason this step exists.

The scan runs every two minutes (faster than the disk ladder: the alert fires at
five minutes of lag, so a sweep interval near the threshold learns about it a full
interval late). It records lag, pending segments, the last successful archive time,
Postgres' own archiver failure count, and the result of `pgbackrest check`. Four
gauges, four alert rules.

**The definition of "lag" is the whole step** (**D-271**). The obvious reading —
time since the last successful archive — is wrong, and wrong in the worst
direction: `archive_timeout` forces a WAL switch every 300 s on Free, so an idle
*healthy* project archives one segment every five minutes and nothing in between.
Its "lag" would sit permanently at up to 300 s, which is exactly the catalog's warn
threshold, and the alert would fire forever for the whole free tier. An alert that
always fires is worse than no alert, because it also discredits the ones that
matter. What is measured instead is **the age of the oldest segment closed but not
yet archived**, straight from `pg_ls_archive_statusdir()` — nothing waiting means
zero lag, whatever the clock says about the last push.

A second reason the five-minute line is right emerged from the test: `archive-async`
batches pushes, so a project that has just written WAL routinely has a segment or
two waiting for a second. Any threshold near zero is noise.

`pgbackrest check` is the second, independent signal, because lag cannot answer
"would the repo accept a backup at all" — a project can have nothing waiting and a
repo whose credentials expired last week. It runs on a 15-minute schedule, and the
schedule is **overridden by trouble** (**D-273**): past the warn rung, a moved
failure count, or a check that is currently failing. That last case is what makes
recovery visible — the alert pages after five minutes, so a stale `false` left
until the next scheduled check keeps the pager ringing a quarter of an hour after
the fix.

No hysteresis here, unlike the disk ladder (**D-272**): these rungs are
notifications, so flapping costs a duplicate message while stickiness would cost a
stale alert. And a project the scan could not reach keeps its previous rung
(**D-274**) — "cannot measure" is not "measured as fine", and `unknown` is
deliberately not `ok`.

**The finding is the one that would have hurt most.** Breaking a project's repo on
purpose — pointing it at a nonexistent bucket — made the **database restart its
entire cluster**:

```
LOG:  server process (PID 197) exited with exit code 103
LOG:  terminating any other active server processes
FATAL:  archive command was terminated by signal 3: Quit
LOG:  all server processes terminated; reinitializing
```

`archive-async=y` double-forks its worker, which reparents it to PID 1 — and PID 1
was the postmaster. A worker exiting non-zero is then indistinguishable from one of
Postgres' own backends crashing, so Postgres does the only correct thing for a
backend crash and terminates every session to reinitialise. Project containers now
run with a real init as PID 1 (**D-270**). An archiving failure has to stay a
backup problem; turning it into an availability incident is exactly backwards,
since surviving incidents is the reason to archive at all.

**Verification, in two halves, because "alerts fire" needs both:**

`promtool test rules` drives synthetic series through the real alert expressions
and asserts which alerts come out — the healthy-idle project producing *none* is
pinned there as the regression D-271 exists to prevent (**D-275**). And
`wal.e2e.test.ts` breaks archiving on a live project, then proves the numbers move:
pending segments appear, lag rises, `pgbackrest check` fails, Postgres' failure
counter moves — and after the config is repaired, all four go back. A metric that
rises and never falls is an alert that cannot clear, so the repair half is as much
of the criterion as the break.


### P3c — backups that happen on their own · done · 23 tests

Base backups are now scheduled, taken, recorded, and expired. Free takes a nightly
full; Pro and Team take a weekly full with nightly incrementals. Fulls-only on Free
is not laziness — at a ≤500 MB cap a compressed full is trivial, and a one-link
chain has no middle link that can be the broken thing.

Scheduling is a control-plane job per project (D-018), never per-node cron, which
is what makes three things possible at once: jittering across the fleet, knowing
each project's plan, and **skipping paused projects** — which must be skipped,
since a paused project has no running Postgres and its final backup is already
pinned against expiry (D-077).

**Three findings, and the first two are mine from earlier steps.**

**Retention was `count` where the doc says `time`** (**D-276**). The two coincide
on Free, where nightly fulls make "7 fulls" and "7 days" identical — which is
exactly why it was invisible, since every project in the fleet is Free. On Pro the
fulls are *weekly*, so `count=35` keeps thirty-five weekly fulls: about eight
months against a 30-day PITR promise, roughly eight times the storage the plan is
priced on. Nobody would have noticed until the bill. Time also carries a guarantee
count cannot — pgBackRest expires a full older than the window only while another
at least that old remains, so a base always exists *before* the oldest restorable
point, which is what the slack in Pro's 35-against-30 was always for.

**`corebase_backup_last_success_ts` was wired to WAL archiving, not base backups**
(**D-277**). P3b did that, and the metric name hides it completely. The alert on it
is "last-success age > 26 h → page", and pointed at WAL it stays green for a project
whose nightly full has not succeeded in a week — because the WAL was flowing
perfectly the whole time. Two healthy-looking signals and one missing backup. WAL
now has its own timestamp gauge, and `BackupRunFailed` was added beside it: silence
and refusal are different failures.

**A counter declared and never incremented.** `corebase_backup_runs_total` existed,
the alert read it, and nothing ever moved it — so `BackupRunFailed` could not fire.
Caught by asking what actually writes each series rather than by any test, which is
worth remembering: a metric with no writer passes every test that asserts the
alert's *expression*.

**Why `backup_runs` is a table** (**D-278**): the repo knows what it holds and
cannot know what was tried. A project whose nightly full has failed for six days is
indistinguishable through `pgbackrest info` from one whose retention window starts
six days ago, and failures leave no trace in a repo by definition. The row is
opened *before* the backup runs, so a worker killed mid-backup leaves a visible
`running` row rather than nothing — and that row stops blocking the project's
schedule after six hours (**D-282**), because a crash must not freeze a project's
backups until someone notices.

Two details that are easy to get subtly wrong and were: the job's idempotency key
carries the **calendar day**, not a timestamp (**D-279**) — a sweep every five
minutes against a half-hour slot would otherwise enqueue one nightly backup a dozen
times. And a project's slot is derived from its id rather than random (**D-280**);
random re-rolls every sweep, giving a project many chances per night to be "in its
slot", which is a lottery that fires at a different time each night rather than a
schedule. A never-backed-up project ignores the window entirely (**D-281**): one
created at midday would otherwise have no base backup for eighteen hours.

**Verification:** `backup-runs.e2e.test.ts` 10/10 — a fresh project scheduled
immediately, the same day scheduling nothing more, a paused project skipped, an
in-flight backup not doubled, an abandoned run releasing its hold, a full taken
whose run row agrees with the repo down to the label and WAL range, a *failed*
backup recorded with its reason rather than vanishing, replay reusing the row, and
an expired full actually removed. Plus 13 unit tests on the plan matrix and the
jitter, and the alert file re-verified by `promtool test rules`.

**One honest limit.** Time-based expiry over real calendar days cannot be exercised
here, because pgBackRest decides from timestamps in the repo and faking those is
repo surgery. The retention test proves the *mechanism* — that `expire` runs as
part of `backup` and removes the older full rather than the newer — using a
count-based override on the command line, while the production policy (`time`, with
the per-plan day counts) is pinned by unit test. What is unverified is the calendar
arithmetic, not the plumbing.


### P3d — restore to a new instance, and PITR · done · 5 live tests + 22 unit

**Exit criterion 1 is met.** Restoring to a chosen second produces a database
holding every row committed before that instant and none committed after it:

```
rows restored: [1, 2]   target 2026-09-02T11:24:21.299Z
```

Rows 3 and 4 — including the one the test calls `THE MISTAKE` — are gone from the
copy and still present in the original. The copy is writable, not a paused
replica.

`POST /v1/projects/:ref/restore { target_time }` creates a **different** project and
returns that one. Production is never overwritten (proposal §36), so the ref in the
response is not the ref in the path and the caller polls the new one. The copy is
marked **`restored`, never `ready`** (**D-283**): two databases serving one
application loses data by construction, and `ready` would make the copy
indistinguishable from production in every list, badge and API response.

The saga reuses the provisioning path's placement, volume and network steps, then
diverges where it must: `start_container` is *absent*, because the volume has to be
filled before Postgres has ever run on it. A throwaway container that starts no
database runs `pgbackrest restore`, and only then does the real container start on
top of the restored data directory.

**Four findings, all from running it, and the fourth is the one that mattered.**

**The PITR target was being rounded backwards.** The target was formatted for
pgBackRest by trimming the milliseconds off an ISO timestamp — `11:23:16.819Z`
became `11:23:16+00` — which silently moves the requested instant back by up to a
second. It is not a rounding detail: a row committed at `11:23:16.5` is *before*
the customer's target and *after* the truncated one, so the restore came back
looking perfectly correct and one transaction short. A customer restoring to the
second before a bad migration would have lost the writes in that second with no way
to tell it had happened. `recovery_target_time` takes fractional seconds; there was
never a reason to drop them. Pinned by a unit test that walks several millisecond
values, because a single round-number case passes against the broken version.

That is also the answer to why the earlier report said the criterion was
unconfirmed: the data assertions had never run. Once the machine was quiet enough
to reach them, they failed immediately and correctly.

**The restored container needs the *source's* repo config before Postgres starts**
(**D-284**). pgBackRest writes `restore_command = 'pgbackrest … archive-get'` into
`postgresql.auto.conf`, and that runs *inside the project container* for every WAL
segment recovery wants. Writing the copy's own config first — the obvious ordering —
points archive-get at an empty repo. It surfaced twice in two disguises: first as
`FATAL: could not locate required checkpoint record at 0/4000080`, a message about
checkpoints that is really about a missing config file, and then as a recovery that
waited for WAL forever.

**A guard that could not fail.** Checking for `recovery.signal` with
`ls … | includes('recovery.signal')` passes whether the file exists or not, because
`ls` prints the path *in its error message*. That version ran green against a data
directory without the file. It uses `test -f` and an exit code now — the repo has
been bitten by vacuous guards before, and this one was written in the same hour as
a comment about proving guards before trusting them.

**`reached_time` is informational and may be NULL** (**D-286**).
`pg_last_xact_replay_timestamp()` reports the last *transaction* replayed, and
recovery can reach its target having replayed none — so requiring it fails restores
that worked. `reached_lsn` is the load-bearing evidence.

`--target-action=pause` is the design's safety property and worth restating
(**D-285**): it leaves the cluster in recovery at the target, which is the only
moment at which "did this land where I asked?" can be answered. Under `promote`
there is no such moment, and a restore that ran out of WAL early would arrive as a
healthy database holding the wrong day.

**Dashboard** (ux-review run per D-224, three failures found and fixed):

- Q18 — adding `restoring` to `SETTLING` made the banner read *"Setting up your
  database"* over the top of someone's recovery. Now its own copy.
- Q19 — the progress bar was a fixed `width: 55%`, a number nothing computed. It
  reads *worse* than no bar: a user watching 55% sit still concludes the operation
  is stuck. Now indeterminate (**D-290**).
- Q14 — a `restored` project was terminal with a warning badge and no explanation.
  Now a banner saying what the copy holds, that it serves no traffic, that the
  original is untouched, and that switching over is a separate step that is not
  built yet.

The typed `Record<ProjectStatus, string>` turned two new enum values into a compile
error rather than a silently-neutral badge. That guard was written after the
`creating` incident and this is the first time it has caught what it was written for.

**Verification.** `restore.e2e.test.ts` 5/5 on the live stack: the point-in-time
proof above, the copy getting its own credentials so the source's no longer open
it, the copy landing as `restored` with a repo of its own, a target predating every
backup **failing loudly** rather than serving an earlier point, and a restore whose
source is gone refusing rather than producing an empty database. Plus 22 unit tests
in `backup.test.ts` covering the config and the target format, and dashboard 13/13.

**What the earlier attempts cost, and what they taught.** Three runs reported
"timed out" and nothing else, on a machine at load average 12 where a provisioning
step that normally takes 0.4 s took 25 s and a `sed` over one file exceeded two
minutes. The first version of the harness collected saga logs into an array it
returned only on success, so a hang printed nothing at all; it prints each step as
it happens now, which is what turned the next failure into one readable line. The
suite is still heavy — five tests each provision a source *and* restore it — and
sharing one provisioned source across the file would cut four provisions.


### P3e — a restored copy has a deadline · done · 14 tests

Restored copies expire. **48 hours by default, never more than a week** — a copy
holds a second full dataset, a second RAM booking and a second disk booking while
serving no traffic, and nothing about it ever finishes on its own: the customer
validates their data on Tuesday and without a deadline the copy is still on the
node in March. At ~100 projects per node (M-008), a handful of forgotten copies is
a node's worth of capacity spent on databases nobody queries.

The week is a **ceiling, not a setting** (**D-291**). A too-long TTL fails
silently and cumulatively — nobody notices capacity going to idle copies until it
is a fleet problem rather than a project one. Someone who wants a copy for longer
should *promote* it, which is the operation that says "this is production now".

**Expiry soft-deletes; it never purges** (**D-292**), and this is the part that
needed the most care. Automatic deletion of a database is the operation you least
want to get wrong, and the circumstances are the worst possible: the customer
restored *because they lost data*, so the copy may be the only surviving version of
something. So expiry hands the project to the **normal deletion pipeline**, which
soft-deletes it, takes a final backup on the way, and keeps the data for the
seven-day recovery window (D-038). The deadline the customer sees is when the copy
stops *running*, not when their data is destroyed — there is a second window behind
it, and an expiry nobody wanted is recoverable for a week. A bespoke expiry saga
would have had to reimplement all three of those, and the one it would most likely
have skipped is the backup that makes the undo possible.

The TTL distinguishes two kinds of bad input (**D-293**): nonsense, zero and
negatives fall back to 48 h, because they are not "a very short window" but the
absence of an answer — and a TTL of zero would delete every copy before anyone
could open it, which is indistinguishable from the feature being broken. A real
number merely out of range is clamped to the nearest bound, because `0.5` and `200`
*are* expressed intent, and a fleet that will not boot over a typo is worse than
one that keeps copies for a week and says so.

The deadline is written in the same transaction as the project (**D-294**) — a
nullable column filled in later is a copy that lives forever whenever the later
step is skipped — and it is returned on the project **detail**, not only in the
reply to the create. The customer who needs it is the one coming back two days
later. The dashboard banner states it, and states the second window with it, so the
sentence a worried customer reads is not "your copy will be deleted".

**Verification:** `restore-expiry.e2e.test.ts` 7/7 against the control plane, and
deliberately *without* provisioning anything — the sweep's job is a decision over
rows, which is entirely SQL, and provisioning five databases to test a `WHERE`
clause is exactly how the P3d suite became too heavy to finish under load. It runs
in 187 ms and covers what must be left alone as carefully as what must be swept:
a copy inside its window, one still being built, a failed restore, a copy with no
deadline, and — the one that would be catastrophic — an ordinary production
project, which has no restore row and must never be a candidate. Plus 7 unit tests
on the clamping. `store.pg.e2e` grew 7 more covering the store's half: a new
project rather than the source, the lineage and deadline written in one
transaction, the ceiling refusing with the remedy named, and a non-restore project
reporting no restore block at all.

**Still not built:** promote. A copy can be validated and then expires; there is no
credential/endpoint swap yet (backups §4 step 6), so the way to keep a restore is
not available and the banner says so rather than offering a dead button.


### P3f — the two interlocks · done · 6 live tests

**Exit criterion 4 is met**: deleting a project produces a final backup that is
retrievable during the recovery window. And D-077's pause interlock is real: pause
does not complete until the project is restorable from object storage alone.

**On delete.** `final_backup` was a gate that could only ever *refuse*; it now takes
a backup, and always a **full** (**D-296**). Everything else in the schedule
balances cost against restore time — this is the only copy that will survive the
project, and a chain whose earlier links are expiring is not something to hand a
customer who is already having a bad day. A failure **stops the deletion**, which
is the whole point of an interlock: nothing about a `DELETE` distinguishes "we are
done with this" from "I typed the wrong ref", and a deletion that proceeded past a
failed backup would close a recovery window with nothing behind it at the one moment
nobody is watching, because the customer has already moved on. `CB_REQUIRE_FINAL_BACKUP`
now defaults **on** (**D-299**) — the failure it prevents is invisible, since a
recovery window with nothing behind it looks exactly like a recovery window.

Deleting an already-paused project is the normal Free case and is handled
separately: there is no container to back up from, so the step relies on the
pause-time backup and says which one it is relying on. "There was already one" and
"we could not take one" must not look alike.

**On pause.** A paused project has no running Postgres, so **WAL archiving stops
with the container** — unhandled, the only current copy of the data is one node's
disk with a backup behind it already older than the pause, which is not what D-008's
economics promise. So pause now takes a backup *after* the checkpoint (the order is
not incidental — a backup before it omits exactly what the checkpoint flushed, the
tail of the data), confirms it with `pgbackrest check`, and **refuses to stop the
containers if either fails** (**D-297**). Leaving them running is the deliberate
part: a paused project whose backup failed is strictly worse than a running one.

An incremental when the last full is under 7 days old, a full otherwise
(**D-298**). The chain matters more here than anywhere, because nothing extends it
again until the project resumes.

**Two test premises of mine were wrong, and both were worth finding.** I asserted
the container was *gone* after a soft delete — it is stopped, not removed, because
phase one of deletion is reversible by design and removal is the purge seven days
later. A test asserting it had gone would have been asserting the window did not
exist. And I assumed a freshly provisioned project pausing immediately would take
an incremental; provisioning takes no backup at all, so it correctly takes a full.
An incremental with no base is not a thing.

**Verification.** `interlocks.e2e.test.ts` 6/6 on the live stack. The criterion
test proves *retrievability* the only way that counts (**D-300**): after the
project is soft-deleted and its containers are stopped, the repo is read from a
**different** container with nothing but the stored cipher-pass, and the final
backup's label is there. A `backup_runs` row saying `succeeded` is our own
bookkeeping; the criterion is about the repo. Both refusal paths are tested by
breaking the repo the way a botched credential rotation would — delete refuses and
the project stays `ready`, pause refuses and the containers stay running.

**Not built:** repo destruction after purge + 30 days (D-066). The repo currently
outlives the project indefinitely, which D-038's "provable destruction" requires
closing — and it needs a path this codebase does not have yet: after purge there is
no container to run `pgbackrest stop` in, so the control plane has to delete the
bucket prefix itself over S3. That is also the design the doc already asks for
("delete rights live only with the control plane"), so it is a step rather than a
patch.


### P3g — a purged project's repo is destroyed, provably · done · 9 tests

The gap the last step recorded is closed. A purged project's backup repo used to
outlive it **indefinitely**: the data a customer asked us to destroy, retained
forever, with nothing anywhere recording that it should not be. D-038 asks for
*provable* destruction and D-066 sets the schedule — the final backup is kept **30
days past purge**, so someone who deleted the wrong project has a month rather
than the week the volume gets, and only then does the repo go.

**The control plane deletes it, over S3** (**D-301**). By the time the deadline
arrives the container, the volume, the placement row and the credentials are all
gone — there is nowhere left to run `pgbackrest`. That is also the access model the
design already asked for: nodes put/get/list their own prefixes and **delete rights
live only with the control plane**, so a compromised node can read its tenants'
encrypted repos and cannot destroy history. The client is hand-written for the
reason the Docker one is — the surface is a list and a delete, SigV4 is a specified
stable algorithm, and an SDK wrapping all of S3 is a large supply-chain cost for
two operations.

`project_repos` is the one thing that outlives everything else a project had
(**D-302**), because what must survive a purge is the knowledge of *what still
needs deleting and when*. `ON DELETE RESTRICT` rather than CASCADE: a future change
that deleted the projects row would otherwise take the schedule with it and leave
the objects behind, unreferenced.

**"Provable" is implemented as re-listing** (**D-303**). Deleting and assuming is
not destruction, so every sweep deletes the prefix and then lists it again, and the
row is marked destroyed only when that list comes back empty — the same discipline
as the purge's `verify_gone` against the node. A sweep that assumed would mark a
repo destroyed while its objects remained: retained forever behind a row asserting
they were gone, which is worse than never having tried. An audit row records the
destruction with its object count, because provable also means someone can be shown
the proof later.

**Three findings from making it work.**

**The control plane and the project containers need separate endpoints**
(**D-305**). In production both are R2 and identical; locally they cannot be — a
project container reaches the store through the node's NAT egress, so its endpoint
is an address on the compose network, and the control plane runs on the host, which
cannot route to a container IP at all. The first attempt timed out after 30 seconds
in a way indistinguishable from a wrong secret.

**A signed S3 request with a body needs an explicit `Content-Length`**
(**D-306**) — Node falls back to chunked encoding without it and S3 answers `411
MissingContentLength`.

**The prefix is the stored path minus its leading slash** (**D-304**). pgBackRest
spells the path `/projects/<id>`; S3 keys have none. A list for the unmodified path
matches nothing *silently* — and the sweep would then have "proven" an untouched
prefix empty, which is the worst available outcome.

**Verification.** `repo-destroy.e2e.test.ts` 9/9 against the real store, with real
objects seeded through `mc` rather than through the client under test — seeding with
the code being verified would let a broken client produce a bucket that looks
correct to itself. The two that matter most: **it touches only the project it was
asked about** (a prefix bug here deletes a live customer's backups, and
`projects/<uuid>` against `projects/<uuid>` is exactly the shape a substring match
gets wrong), and **it refuses to mark a repo destroyed while objects remain**,
tested by handing it a client whose deletes do nothing. Also pinned: a repo with no
deadline is never destroyed — NULL comparisons make that true by construction,
which is precisely why a rewrite with `COALESCE` would destroy every undecided repo
on its first sweep.


### P3h — restore verification · done · 11 tests

**Exit criterion 2 is met, and with it Phase 3.** Verification runs on a schedule
and fails on a sabotaged backup — which was the point of the criterion, because a
verifier that passes healthy backups and also passes broken ones is worse than
none: it manufactures the confidence the whole phase exists to earn.

This is also the step that changes what the previous seven mean. Everything before
it built an archive — a repo, a schedule, retention, interlocks at delete and
pause, provable destruction. The backups doc's first line is that **a backup which
has not been restore-tested is treated as not existing**, so until now the honest
description was "files in a bucket that we believe are restorable". Now something
restores them without being asked and checks what comes back.

**Four checks, each catching what the others cannot** (**D-308**):

1. **Recovery reached consistency** — the only one that fails loudly on its own.
2. **Data checksums verify** — the reason `initdb --data-checksums` exists
   (D-269). Page rot is otherwise silent and a rotting cluster restores clean.
3. **`pg_amcheck`** — a heap can be intact while a btree points at rows that are
   not there, and the index is what queries actually read.
4. **Sanity counts** — the strongest and least mechanical. Tables the *live*
   project reports as non-empty must be non-empty in the restore, because a backup
   can pass every structural test and contain an empty database. The expectation
   is read from the live project *before* the scratch instance is touched: a
   comparison between two databases proves nothing if both sides came from the
   thing under test. It uses `reltuples` rather than `count(*)` (**D-309**) —
   this runs against a customer's production database and must not scan it.

The scratch instance has its own volume, joins no project network, publishes no
port, and is destroyed in a `finally` on every path (**D-307**). It deliberately
carries no `project.ref` label, because the reconciler keys on that one and an
unexpected container wearing it is drift.

**The queue puts never-verified projects first** (**D-310**), and the obvious
ordering gets that exactly backwards: a project nobody has ever verified is the
likeliest to be broken in a way nobody noticed — a misconfigured repo, a
cipher-pass that never matched, a schedule that never fired — and it has no
timestamp to be old, so a longest-unverified sort ranks it last. A **failed**
verification does not count as one, which is D-176's "treat the backups as
nonexistent" expressed as scheduling: the project stays at the front until one
passes. Paused projects are included and need it most — their backup is their only
life.

Two alerts, not one (**D-311**): a failure pages at the same severity as a failed
backup, and low coverage warns — because a verifier that stopped looks exactly
like a fleet whose backups are all fine, and nothing fires when nothing runs.

**Three findings, two of them mine and one the same trap twice.**

`${PIPESTATUS[0]}` is a bash-ism, and the image's `/bin/sh` is dash — the check's
own plumbing exited non-zero, so **every healthy cluster was reported as corrupt**.
The identical trap as `/dev/tcp` in P3a, in the same phase. And `pg_amcheck` takes
the database *positionally*; `--dbname` is psql's spelling and pg_amcheck rejects
it outright, which failed the same way. A check that cannot pass is as useless as
one that cannot fail, and both of these were the former.

The third: the control plane's S3 client has **no `PUT`** (**D-312**), because
delete rights are the only write rights it is meant to hold. The sabotage test
needed to overwrite an object, and does it with `mc` from outside the product
rather than adding a `PUT` that would have quietly broken the access model this
same phase documents.

**Verification.** `verify-restore.e2e.test.ts` 11/11. A healthy backup restores
and passes all four checks; a backup file overwritten with random bytes **fails**,
and the record names which check caught it; an empty repo fails rather than
reporting a vacuous pass — "verified" and "found to have nothing to verify" must
not look alike; a wrong cipher-pass fails; nothing is left on the node afterwards.
Five more cover the scheduler's choices, including that a failed verification does
not count and that paused projects are candidates.

**Substitute limitation:** backups §7 wants verification on a node designated for
it rather than customer capacity. There is one node here, so the scratch instance
shares it — isolated by its own volume and network-less container, but not by
hardware. Recorded rather than pretended away.


## 4e. Phase 4 — auth

### P4a — the `auth` schema in every project database · done · 10 tests

Every project now has the six `auth` tables from the auth architecture doc, created
by the image at `initdb` (**D-314**) rather than by a saga step: they are
fleet-wide and identical, and `initdb` is the one moment when no client can see a
half-created schema. It also makes D-004's export promise true — a project's users
exist in the project's own database from its first second, so `corebase export`
carries them out with a plain `pg_dump` and **nothing about a project's end-users
is ever stored in the control plane**.

The `auth` schema itself already existed with the RLS helpers (`auth.uid()` and
friends, from D-015); this adds the tables, which the API roles are deliberately
*not* allowed to touch.

**The privilege boundary is the part worth reading.** `corebase_auth` is the only
role with table privileges here (**D-315**), and `service_role` is what makes that
non-obvious: it is handed to a customer's server-side code and holds `BYPASSRLS`,
so nothing about row-level security constrains it and the **only** thing between it
and every end-user's password hash is the absence of a table grant. `developer` is
excluded for the same reason — the customer owns their database and can grant
themselves anything, but the default must not hand them their users' hashes in the
connection string the dashboard displays. The auth role's password is its own, not
`authenticator`'s: sharing one would make a leak of the API's connection string a
leak of every end-user's credentials.

Two properties are pinned by tests precisely because they are properties of
something *not* happening (**D-316**): no default privileges are altered for
`auth`, so a table added there later is unreachable until somebody says otherwise;
and the force-RLS event trigger stays scoped to `public`, because enabling RLS on
`auth.users` would lock the auth module out of its own tables by a mechanism meant
to protect customers' data — with every login on the platform failing at once as
the symptom.

**Password hashing is scrypt, not the argon2id the doc named** (**D-313**). D-211
already made that trade for platform logins and the reasoning is stronger here: the
auth module absorbs *every* project's login load in one process (D-110), so a
native dependency would sit on the hottest auth path on the platform. D-111's
properties are kept — parameters in the hash, weaker hashes upgraded on the next
successful verify. What it defers is bcrypt verify-only compatibility for imported
users, which D-111 promised so customers could migrate from GoTrue without a mass
password reset; recorded as a gap rather than dropped, because D-004's portability
is meant to cut both ways.

**Verification:** `auth-schema.e2e.test.ts` 10/10 against a live project — all six
tables present, a soft-deleted user freeing its email for re-registration (the
partial index doing its job), the refresh-token lineage expressing a family and a
session delete taking the whole family with it, one one-time token per type
replacing the previous, and five privilege tests including `service_role` being
refused `auth.users` while still able to call `auth.uid()`.

### P4b — signup and password login · done · 14 tests

`/auth/v1/*` serves its first two flows. A client with a project's anon key can
sign a user up and log them in, and what comes back is an ES256 access token that
verifies against the project's published JWKS with the claim set the token spec
names — `sub` (what every RLS policy's `auth.uid()` reads), `aud: authenticated`,
`role: authenticated`, `ref`, and a `session_id` that ties a stateless token to a
row somebody can revoke.

Built: `POST /signup`, `POST /token?grant_type=password`, `GET
/.well-known/jwks.json`, `GET /health`, and `project_auth_config` in the control
plane (**D-321**, settling OQ-111) carrying `autoconfirm`, `disable_signup`,
`access_token_ttl_seconds` and `password_min_length` — a project with no row gets
the column defaults, so nothing needed a backfill.

**The project is resolved from the signed `apikey`, not the Host header**
(**D-318**). There is no gateway until Phase 5, and this is not the lesser
substitute it looks like: a Host header is an assertion the caller wrote, while the
anon key arrives *signed by the project's own key*. What the gateway adds later is
routing and rate-limit placement, not identity. Two things about that boundary are
pinned by tests and both were nearly wrong:

- **The two issuers are different strings** (**D-319**). The provisioning saga
  signs API keys with `https://<ref>.corebase.co`; an access token's `iss` is
  `…/auth/v1`. The first wiring pinned one for both and 401'd every request with a
  perfectly valid signature.
- **A user's own access token is refused in the `apikey` slot** (**D-320**). It is
  signed by the same key and names the same ref, so a naive implementation takes
  it. The first run of the test that claims this passed *with the role check
  disabled* — the issuer pin was doing all the work — so the test now mints a
  token that passes the issuer pin and carries a user's role, and fails with a 200
  when the role check is removed. A check no test can fail is a check nobody
  should trust.

**Enumeration resistance is the security content of both endpoints, and it costs
real work** (**D-322**). Signup returns 200 with an identical body *shape* whether
or not the address exists — a decoy uuid for the taken case — and spends a full
64 MiB scrypt hash it does not need, because skipping it would make a taken address
answer in 2 ms and a fresh one in 100 ms. Login verifies against a decoy hash when
the email is unknown for the same reason. Both are affordable only because the
rate limit is checked **before** the hash (D-241), which the test proves by timing
the request after the limit trips (<50 ms, versus ~270 ms for one that hashes).
Removing the decoy verify makes the unknown-email path 12.6 ms against 269 ms for a
wrong password — a 21× oracle, which is what the timing assertion catches.

**One connection per request, no pool** (**D-323**, OQ-110 still open). A pooled
connection holds a password; a P2d rotation replaces it; every request after that
fails authentication until something notices. The failure mode is *every login on a
project breaking after a routine credential rotation*, in a subsystem the operator
was not touching. A connect is milliseconds against a verify that is deliberately
tens of them.

Auth error codes are lowercase and GoTrue-compatible (**D-317**) — `invalid_credentials`,
`email_not_confirmed`, `weak_password`, `over_rate_limit` — because client code
branches on them. One code covers a wrong password, an unknown email *and* a
banned user; the audit log in the project's own database records which it actually
was.

**Verification:** `project-auth.e2e.test.ts` 14/14 against live provisioned
projects — the user row landing in the project's database and nowhere in the
control plane, a scrypt hash that never contains the plaintext, the duplicate
address returning the same keys and a *different* uuid, the JWKS publishing no
private material and matching the `kid` the tokens are signed with, a banned user
getting the generic error while the audit log says `login_failed_banned`, a
soft-deleted user unable to log in with the address free to re-register, and a
spliced apikey writing nothing to either of two projects. Both mutation checks
above were run and both failed as they should.
### P4c — one-time tokens, and the flows that spend them · done · 12 unit + 18 integration

`/auth/v1/verify` (GET and POST), `/recover` and `/resend` are built, and signup
now writes the confirmation token it always claimed to. The whole step is about
one table — `auth.one_time_tokens` — and one discipline: a token is 256 bits of
CSPRNG output, only its sha256 is stored, and it is spent exactly once.

**Spent exactly once is a concurrency property, not a check** (**D-324**). The
consume is a single `UPDATE … WHERE used_at IS NULL AND expires_at > now()`, so
the database decides the race. That matters because concurrent clicks on one link
are ordinary — mail clients prefetch, users double-click, corporate scanners
follow every link in an inbox — and with a select-then-update both callers pass
the check and both get a session. Removing the predicate was run: two simultaneous
verifies of one link both returned 200 and left two sessions behind. The same
predicate excludes soft-deleted users, so a tombstoned account cannot be confirmed
back into a working session.

**The redirect allowlist is the other half of the step, and it caught a real bug in
my own code.** `/recover` originally passed `redirect_to` straight into the mailed
link. That is not an open-redirect nuisance: the mail comes from a reputable
domain, the link genuinely points at `<ref>.corebase.co`, and the tokens land
wherever the attacker asked — precisely the capability D-116's fixed templates
exist to withhold. So validation happens where the link is **built**, not only
where it is followed (**D-325**), and the substitution is audited because it is
otherwise invisible to the developer whose redirect is being ignored. A project
with no `site_url` permits no redirect at all and its `GET /verify` answers in JSON
rather than guessing a destination (**D-326**) — "configured nothing" must not read
as "allowed everything".

The allowlist itself is a pure module with its own unit suite, because every way an
allowlist gets written wrong is a string-comparison mistake: exact origin rather
than suffix (`endsWith('example.com')` also accepts `evil-example.com`), path
prefix only at a segment boundary (`/auth` must not authorise
`/authorize-elsewhere`), and non-http schemes refused *before* any origin
comparison (`javascript:` parses with origin `null`, so a scheme check placed after
the origin match can be skipped entirely).

Tokens ride in the redirect's **fragment**, never the query string (**D-327**) —
same tokens, same URL, and the difference is whether a live session gets written
into somebody else's log retention. Every successful verify confirms the address,
not just `type=signup` (**D-328**), because a recovery link proves mailbox control
just as well and the alternative sends a user through a successful reset into a
login that refuses them.

`/resend` replaces the outstanding token rather than adding one (**D-329**), so ten
resends leave one live link in an inbox instead of ten, and an already-confirmed
address gets a same-shape 200 and no mail — otherwise it is a way to make the
shared sending domain deliver to any registered address on demand.

**Nothing sends the mail yet.** The boundary is an `AuthMailer.enqueue` that cannot
throw (**D-330**) — an enumeration-safe flow has already committed to a 200, so a
send failure becoming a 500 would both break the contract and signal that the
address was interesting. The default records jobs and sends nothing, and the API
says so at boot. The row of record is the token in the project's own database, per
D-018, so losing Redis loses delivery and not the fact that mail is owed.

**Verification:** `redirect.p4c.unit.test.ts` 12/12 (suffix matching, segment
boundaries, scheme confusion, the empty-config case) and 18 new integration tests
against live projects — the mailed link confirming an address and unlocking the
login that was refused, a replayed link 401ing, two concurrent clicks yielding
exactly one session, a resend killing the previous link, an unlisted `redirect_to`
substituted in both the mail and the redirect with an audit row to show it, and the
token's plaintext appearing nowhere in `auth.one_time_tokens`. Both mutations above
were run and failed as they should.
### P4d — the email pipeline · done · 29 unit + 22 integration

Auth mail now leaves the process. A flow owes an email, the API's mailer checks
suppression then caps then writes a row then queues a job, and the worker renders
both MIME parts and speaks SMTP to a provider. `signup → queue → SMTP → click the
link out of the delivered message → confirmed user → working login` is one test.

**Postmark is not built, and the interface is** (**D-331**). D-115's load-bearing
half is the seam — "so cutting over is a config-and-warm-up project, not a
rewrite" — and a Postmark client with no account and no verified domain behind it
would be untested code on the one path where failure is silent and reaches users.
The SMTP implementation is not a lesser substitute: it is the shape D-117's
per-project custom SMTP needs, and **Mailpit** stands in for the provider exactly
as MinIO stands in for R2. What the substitute cannot exercise is deliverability,
so **Phase 4's third exit criterion — mail landing at major providers with
SPF/DKIM/DMARC green — stays unmet** rather than being declared met against a
sink.

The SMTP client is hand-written (**D-332**), same reasoning as the S3 SigV4 client
and the JWT signer. Testing it against a real listener rather than a mock earned
its keep immediately: **`Acme (via Corebase) <auth@…>` unquoted is not the name it
looks like.** Parentheses delimit a comment in RFC 5322, so the sink reported the
display name as "Acme" alone — and the "via Corebase" half is the part that keeps
us from claiming to *be* the customer while sending from our own domain, which is
what DMARC alignment exists to catch (**D-333**). A mock would have agreed with
whatever we sent it.

**Caps and suppression are checked at enqueue, suppression first** (**D-334**).
Enqueue-time refuses a burst while it is one Redis round trip instead of filling
the queue whose drain rate the caps protect; suppression first because the reverse
lets a mail-bomb at a suppressed address consume the project's whole hourly budget
without a single message being sent — the attacker denies the project its real
mail for free. Counters are `INCR`-then-compare with a rollback, because
`GET`-then-`INCR` lets two concurrent enqueues both read 29 against a cap of 30.
Per-recipient keys are hashed (**D-337**): Redis keys show up in `MONITOR`,
slowlogs, dumps and any operator's `--scan`, and a plaintext key would put every
end-user address on the platform into all of them.

**Idempotency lives in `email_sends`, not in the queue** (**D-335**). BullMQ
deduplicates a duplicate *enqueue*; what produces duplicate mail is a worker that
sends and dies before recording, after which the queue re-delivers and the
provider has already accepted. Removing that check was run: the same job sent a
second message. The remaining window between provider-accept and row-update is
irreducible without provider-side idempotency keys, and it is not silent —
`attempts` shows the retry. The table's other job is answering "why did my user
get no mail", which a queue structurally cannot: its job is gone once it succeeds,
and `suppressed` and `rate_limited` mean opposite things to a developer.

Retries are the doc's 30 s / 5 min / 30 min via a custom backoff strategy
(**D-336**) — BullMQ's built-in `exponential` doubles and would spend the whole
budget in three minutes, shorter than the outage it exists to survive. A
non-retryable failure (an unrenderable template, credentials refused over an
unencrypted link) is dead-lettered on the first attempt instead of delaying real
mail for 35 minutes.

**One local-environment trap worth recording**, because it looked exactly like our
bug and was not: the sink paused **8 seconds before its SMTP greeting**, making
every send 8 s and the suite 80 s of waiting. Mailpit reverse-resolves the
connecting address first, and from inside a container that PTR lookup finds no
resolver and times out. `MP_SMTP_DISABLE_RDNS` took a send from 8038 ms to 20 ms.
The client was patiently waiting for a banner, correctly.

**Verification:** 29 unit tests (`templates.test.ts` — escaping an address and a
project name that carry markup, an override escaped like any other input, no
remote content in any of the six templates; `gate.test.ts` — the check ordering,
the rollback, the hashed keys, the TTLs, case-insensitive recipients) and 22
integration tests against Mailpit and the control plane: a message arriving with
text before HTML, a non-ASCII subject surviving RFC 2047, header injection through
a project name being impossible, a re-delivered job sending nothing, dead-lettering
at the third attempt, a suppressed address never queued, one project's suppression
not touching another's, the per-recipient cap stopping a mail-bomb with each
refusal recorded and named, a new Free project on half caps, and a broken pool
proving the mailer cannot fail a flow. Two guards were proven by breaking them.
### P4e — refresh rotation, reuse detection, logout and sessions · done · 14 tests

The largest hole in the module is closed: a session can now be renewed and ended.
`POST /token?grant_type=refresh_token`, `POST /logout[?scope=]`, `GET /sessions`
and `DELETE /sessions/:id` are built, along with the bearer-token middleware they
all need.

**The rotation protocol (D-112) is the densest logic in the module and every
branch is a security decision**, so each got its own test and the two that pull
against each other were proven in both directions:

- Removing the theft branch let a token replayed 60 seconds after being spent
  succeed.
- Removing the grace window let an ordinary immediate retry destroy the session.

Both mistakes are invisible from outside until the system is either logging users
out constantly or letting a stolen token live indefinitely, which is why ten
seconds is argued rather than chosen: not zero, because mobile clients on flaky
networks retry and two SPA tabs race, and zero tolerance trains developers to
switch rotation off; not sixty, because the window *is* the period in which a
stolen-and-immediately-replayed token goes undetected.

**One deviation from the doc, and it is unavoidable** (**D-338**). D-112 says the
grace branch returns "the already-issued child R′". Only `sha256(R′)` was ever
stored, so R′'s plaintext cannot be handed out a second time. P4e issues a
*replacement* child under the same parent and revokes the one it replaces. The
property the window exists for is delivered exactly — a client whose response was
lost gets a working token, no second lineage appears — and what changes is that
the lost child stops working, which is right: the only party who might hold it is
whoever received the response the retrying client did not.

**Revocation's boundary is now precise** (**D-339**). The auth endpoints check
session liveness on every bearer request, which is the only reason `/logout` means
anything — an access token is stateless, so verifying it cannot reveal that the
user signed out. The data plane does not, and will not before D-113's deferred
strict mode: a session lookup per data-plane request puts a database round trip on
the hot path D-051 exists to keep database-free, and turns auth availability into
data-API availability. So the guarantee is stated rather than implied: **on the
auth endpoints revocation is immediate; on the data API refresh is dead
immediately and access dies within `exp`.**

A bearer token is refused unless its `role` claim is `authenticated` (**D-340**),
because a project's anon and service_role keys are valid JWTs under the same
keypair — without that check an API key works as a user credential. And the
session lookup is keyed on `(session_id, user_id)`, so a token naming somebody
else's session cannot act on it.

**A bug worth recording, because the test that should have caught it did not.**
`?scope=global` names no `$2` in its UPDATE, and node-postgres sent one anyway — a
bind error, surfacing as a 500 while `local` and `others` worked because those two
reference the parameter (**D-342**). The test called the global logout and did not
assert its status, so a 500 passed as a successful global sign-out. An unchecked
status on a mutation is a mutation that never has to happen; the assertion is now
there and the parameter list follows the predicate.

One stale assertion turned up, and it is the good kind of failure: P4b's test
asserted that `grant_type=refresh_token` returned a 501 saying it was not built,
and P4e built it. The assertion was rewritten rather than deleted — it is the one
place that checks the grant is *dispatched* at all, and a typo in the
query-parameter comparison would otherwise show up only as every client silently
receiving a validation error.

**Verification:** 14 integration tests against live projects — a rotation keeping
its `session_id` and building a two-link lineage, a beyond-grace replay revoking
the whole family with a `token_reuse_detected` row, an inside-grace replay
returning a working token and *not* revoking, two concurrent refreshes with one
token both succeeding and leaving exactly one usable token, an idle-expired session
revoked rather than refreshed, a banned user's refresh killing the session, every
refresh failure returning one indistinguishable answer, logout killing refresh
immediately and being idempotent, all three scopes behaving differently, the
sessions list flagging the current session and carrying no token material, and the
bearer endpoints refusing an anon key, another project's user token, and no token
at all.

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

One hundred and thirty-three decisions came out of running the thing rather than planning it —
D-184…D-210 from Milestone 0, D-211…D-227 from Phase 1, D-228…D-262 from Phase 2, and D-263…D-312 from Phase 3, and D-313…D-316 from Phase 4.
Full text in the [decision log](docs/00-foundation/05-decision-log.md); the log holds
D-001…D-316 and is binding when two documents disagree.

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
| D-207 | Paused-project disk residual re-based 0.5–2 GB → ~60 MB | Measured at ~59 MB per empty volume; the assumption was 8–30× pessimistic |
| D-208 | D-071's warm pool deferred with a trigger | Cold creates already run 18× inside budget; building it would be the R-4 failure |
| D-209 | The RAM and density planning numbers may only be re-based on a measurement meeting four stated conditions | Every M0 number came from the cheapest corner of the state space |
| D-210 | Every measurement states what it does not license; decisions may not cite one beyond its conditions | Stops an idle-ARM number being quoted as a density result |
| D-211 | Platform passwords use **scrypt**, not argon2id; parameters live in the hash and weak hashes upgrade on login | argon2id needs a native module in every image that touches a login; the algorithm gap is small, the toolchain gap is not |
| D-212 | PATs get their own table, `user_access_tokens` | `project_api_keys` holds a *project's* keys, not a *user's* CLI token; revocation keeps the row because an incident review needs it |
| D-213 | `POST /v1/invites/accept` exists; accepting requires the invite's email to match the account | The endpoint table had no way to accept an invite, and the email match stops a forwarded invite from being a bearer token |
| D-214 | The two project keys are stored envelope-encrypted, replacing D-107's deterministic re-derivation | Deterministic ECDSA needs RFC 6979, which Node does not expose — and a bad nonce leaks the private key |
| D-215 | `audit_logs` is append-only by **trigger**, not by `REVOKE` alone | Applied the REVOKE, then tried the UPDATE: it succeeded. Privileges do not bind a table's owner |
| D-216 | The API connects as `corebase_app`, which owns nothing and cannot run DDL; `corebase` owns the schema | Three claims in the corpus were untrue while one role did both jobs |
| D-217 | A project name is unique **within its organization**; the `ref` is the global identity | A global check lets one tenant deny "api" to everyone, and says so in the 409 |
| D-218 | `key_prefix` is a label (`cbk_anon_<ref4>`), not a literal prefix | Both keys displayed as `eyJhbGciOiJF` — the base64 of the JWT header, identical for every key ever minted |
| D-219 | CORS is an explicit allowlist, empty by default, never a wildcard, always `Vary: Origin` | A localhost default ships to production the first time someone forgets the variable, because the service starts fine either way |
| D-220 | The dashboard uses the exported design-system class library, not Tailwind + shadcn (narrows D-025's UI half) | The design system already exists as an implementation; a second component system for the same design guarantees drift |
| D-221 | Create and resume progress is polled, not streamed (resolves OQ-043 for those flows) | Provisioning is ~2.5 s; a stream needs a connection-holding endpoint and a reconnect story to answer what two GETs answer |
| D-222 | The overview page ships without health cards or sparklines and says so on the page | "Auth: green" would be a claim about a service that is not deployed, and OQ-149 must not be settled from inside a component |
| D-223 | Test results are never cached, and `*.e2e.test.ts` is a load-bearing filename | Turbo hashes files, not databases — a cached pass was replayed against dead ports and printed a green lane that never ran |
| D-224 | The [UX standards](docs/09-dashboard/05-ux-standards.md) document is binding, and its 20-question gate runs on every UI change | The first shell honoured every token and had no interaction contract: right in every colour, wrong in every mechanic |
| D-225 | Motion is 120–180 ms, transform/opacity only, disabled under `prefers-reduced-motion` (resolves OQ-170) | "No motion at all" is right for a static board and wrong for a shell — layers arriving without direction is why an interface feels abrupt |
| D-226 | The command palette and full keyboard reachability are shell requirements; every menu capability is also in the palette | It converts "learn where the button is" into "know what it is called", and it forces every action to have a name a CLI can reuse |
| D-227 | No directory this repo writes to may be a compose bind-mount *source*; certs are copied out of the named volume by `docker exec cat` | On Linux the Docker daemon creates a missing bind-mount source as root, locking the scripts out; Docker Desktop remaps it, so the defect was invisible on macOS for months |
| D-228 | Each project gets a private bridge network, `cb-<ref>-net`, with Postgres aliased `db`; the name is derived, not stored | The pooler and PostgREST both configure `host=db`, so a stable alias keeps those templates from ever learning a project's ref |
| D-229 | The network is removed at soft-delete, not only at purge, and `verify_gone` asserts its absence | It holds no data and does hold a subnet from a finite node pool; 18 leaked in one afternoon, and an exhausted pool blocks the next project entirely |
| D-230 | The Engine API client uses one pooled agent per node with `maxSockets: 8`; never the global agent | Node's global agent has had keepAlive on since v19, so ~130 operations broke a node's listener permanently — it read as "Docker Desktop is flaky" for weeks |
| D-231 | No client may rely on the API's single-organization convenience default | `demo.sh` worked until the account had two orgs, which the test suite creates; the API is right to refuse to guess |
| D-232 | `pgbouncer_auth` is a passwordless image role whose password the worker sets; the lookup function pins `search_path` and allowlists `developer` only | A SECURITY DEFINER function without a pinned search_path is a privilege escalation; the allowlist stops the pooled port reaching any internal role |
| D-233 | The pooler image is ours, every `pgbouncer.ini` rule baked in, only values from the environment; PgBouncer ≥ 1.21 | The configuration is the security boundary here, and ≥1.21 is where prepared-statement tracking arrived — without it pooling breaks most ORMs |
| D-234 | `mark_ready` requires a running pooler; the delete saga stops the pooler before the database | A ready project whose `DATABASE_URL` does not connect looks like a bug in the customer's code |
| D-235 | Project containers carry a role label and reconciliation keys on it; a dead pooler is its own drift class | Keying by ref alone made the two containers overwrite each other, so a stopped database read as healthy while its pooler was up |
| D-236 | Idle detection is arithmetic across the pooler and Postgres, and a project that cannot be asked is left running | The pooler parks server connections as the customer's role, so counting backends alone means nothing is ever idle; subtracting its count pauses a project with one live session |
| D-237 | A project's RAM booking lives on its placement row; release credits what the row says, never what the plan says | Purging an already-paused project would have credited RAM that was never reserved, leaving the node under-counted and accepting work it cannot hold |
| D-238 | An empty body under a JSON content-type parses as `{}` rather than being rejected (supersedes half of D-198) | It was a framework 400 blaming the client for our contract, on exactly the endpoints that take no body |
| D-239 | Pause removes containers and keeps volume, network and placement row; resume reuses the provisioning steps | The row is what makes the connection string survive an idle week; a bespoke resume path would be a second, less-tested way to start a project |
| D-240 | `CB_STATIC_TOKEN` has no default; a short or placeholder value refuses to boot | It defaulted to `dev-token`, so an unconfigured API accepted that header as the bootstrap owner — verified, 200 |
| D-241 | Every unauthenticated endpoint that hashes a password is rate limited, on its own budget, before the work | Signup ran a 64 MiB scrypt call unmetered; ~1.3 GiB for twenty concurrent requests |
| D-242 | Connection strings need `?reveal=true` and revealing them is audited, deduplicated hourly | A database password is as powerful as the service_role key, which was gated and audited while the password was neither |
| D-243 | A transitional status with no job running is `stuck_transition` drift — reported, not resolved | A `pausing` project whose job died read as "pausing" to its owner forever, and no sweep saw anything wrong |
| D-244 | Live projects per organization are capped, counting soft-deleted ones | Otherwise the only limit is the placer's capacity error, and one tenant can fail every other tenant's creates |
| D-245 | The data node runs with an explicit `--default-address-pool` sized for the target density | The default pool exhausted with three networks on the node — a per-project network design runs out of addresses at ~10 projects, against a target of 100 |
| D-246 | Rotation is store-then-apply; new versions number from the highest ever used; the previous is kept 24h then purged | The AAD binds the version, so a reused number makes two ciphertexts claim to be the same secret; the reverse order loses the password entirely |
| D-247 | Rotation needs `secret.manage` (admin) while revealing needs `project.read` (member) | Reading your credentials is using the product; replacing them breaks every application holding the old ones |
| D-248 | `terminate` is opt-in and is compromise response, not hygiene | Rotation is invisible to established sessions, which is what makes it routine — and useless against someone already connected |
| D-249 | Read-only is lifted with `SET default_transaction_read_only = off` as its own statement, by the customer *and* by the control plane | The doc's `SET transaction_read_only = off` does nothing under autocommit, and `ALTER DATABASE` being a write made the ladder a one-way door |
| D-250 | Disk is booked at placement on the 85% ceiling, released only on purge | Booking RAM and ignoring disk fills a node with projects that have memory and nowhere to write; a paused project still holds its volume |
| D-251 | Read-only engages at 95%, lifts below 90% | A project on the boundary would flap, and every flip is errors appearing and vanishing with no deploy |
| D-252 | Bin-pack by fill *ratio* — worse of RAM and disk — over every node that fits, not one | Absolute megabytes sorts a small full node ahead of a large empty one; one candidate refuses provisions while the region has room (13 of 20 placed into 18 slots) |
| D-253 | Lock and re-read each candidate before booking it; a lost race tries the next node | `LIMIT 1 FOR UPDATE` under READ COMMITTED returns the row as it was before a rival's booking |
| D-254 | Refuse a stale-heartbeat node, and report staleness rather than "no capacity" | `status` stays active when a worker dies; the project hangs in `creating` and the error names nothing |
| D-255 | Set `BlkioWeight` only where the kernel has `io.weight`, probed per node, defaulting to unsupported | Setting it on a kernel without BFQ/blk-iocost made every container fail to start; the engine cannot be asked on cgroup v2 |
| D-256 | Hard pid ceiling per container: 256 project, 64 pooler | Exhausting the node's pid space stops every tenant's database and the reconciler; accepted cost is that a saturated container cannot be exec'd into |
| D-257 | Verify limits by reading `/sys/fs/cgroup` in the container, never `docker inspect` | Inspect echoes our own request; it is why the T5d limits test stayed green while the I/O weight broke every container |
| D-258 | `removeContainer` keeps anonymous volumes by default, deletes them only on explicit opt-in | `v=1` on a project would delete the customer's database; `v=0` on a mount-less probe leaks a volume reconciliation then reports as an orphan |
| D-259 | Exit criterion 1 closed on its functional half, left open on its modelling half | 100 projects run on one node; D-209 forbids re-basing the planning numbers on ARM without the full triplet, and the data being *favourable* is exactly when that matters |
| D-260 | Density measured on `anon`, never on cgroup `usage` | `usage` counts page cache, which a node under pressure reclaims; anon also keeps M-008 comparable with M-001 |
| D-261 | The per-org project ceiling is an abuse control, not a capacity one, and a density run raises it | Left in place it measures itself: 20 created, 80 refused, the node nowhere near its limits |
| D-262 | The staging node publishes the same port range on both sides of the mapping | A pinned container side broke the widening, and an unpublished port fails nine steps later as a pooler `ECONNREFUSED` rather than at allocation |
| D-263 | One stanza name (`main`) fleet-wide; isolation is `repo1-path` + cipher-pass | A per-project stanza name needs a per-project `postgresql.conf` — the drift D-186 removed |
| D-264 | The repo cipher-pass is a stored secret, never derived | Rotating it means re-creating the repo; a silently-changed pass leaves history nobody can decrypt, found at restore time |
| D-265 | The pgbackrest config is written by `docker exec`, base64, not an env var | `docker inspect` shows a container's environment to the whole control plane |
| D-266 | The staging object store serves TLS with a self-signed cert; clients skip verification | pgBackRest has no plain-HTTP mode for S3, and R2 is TLS-only — serving TLS is faithfulness, not a workaround |
| D-267 | Every pgBackRest command retries through lock contention; real failures do not retry | The async archiver holds the lock, so busy projects — the ones whose backups matter most — were the ones failing |
| D-268 | pgBackRest failures are reported from the `ERROR` lines or the tail, never the front | Its option banner is the first several hundred characters, so truncating from the front hid the cause completely |
| D-269 | `initdb` runs with `--data-checksums` | Required by restore verification and simply absent; without it a verification pass reports a healthy restore of a rotting cluster |
| D-270 | Project containers run a real init as PID 1, not the workload | pgBackRest's async worker double-forks onto PID 1; with the postmaster there, its failure looked like a backend crash and restarted the whole cluster |
| D-271 | Archive lag is the age of the oldest unarchived segment, not time since the last archive | `archive_timeout=300` would peg every healthy idle Free project at the warn line, and an alert that always fires discredits the ones that matter |
| D-272 | The archive rungs have no hysteresis, unlike the disk ladder | These are notifications: flapping costs a duplicate message, stickiness costs a stale alert — opposite consequence, opposite answer |
| D-273 | `pgbackrest check` runs on a 15-minute schedule, overridden by trouble | The interval is a cost control; a stale failing check keeps the pager ringing for 15 minutes after the fix |
| D-274 | An unreachable project keeps its rung and is never recorded healthy | "Cannot measure" is not "measured as fine" — that reports a green fleet during the incident the scan exists to catch |
| D-275 | Alert rules are tested with `promtool test rules`, not merely syntax-checked | The criterion says alerts *fire*; a file that parses proves nothing, and the healthy-idle no-alert case is the regression worth pinning |
| D-276 | Retention is a time policy in days, not a count of fulls | `count` on Pro's weekly fulls keeps ~8 months against a 30-day promise; time also guarantees a base exists before the oldest restorable point |
| D-277 | `corebase_backup_last_success_ts` means the last base backup; WAL has its own gauge | Pointed at WAL, the ">26h" alert stays green for a project whose nightly full has failed all week |
| D-278 | `backup_runs` records attempts, not only the backups that exist | A repo cannot know what was tried, and failures leave no trace in one by definition |
| D-279 | The backup job's idempotency key carries the calendar day | A five-minute sweep against a half-hour slot would enqueue one nightly backup a dozen times |
| D-280 | A project's window slot is derived from its id, never random | Random re-rolls each sweep — a lottery firing at a different time nightly, not a schedule |
| D-281 | A never-backed-up or badly overdue project is backed up outside the window | The window spreads load; it is not a reason to keep delaying a backup already late |
| D-282 | A `running` backup row stops blocking the schedule after six hours | A crash must not freeze a project's backups until a human notices |
| D-283 | A restored project is `restored`, never `ready` | Two databases serving one application loses data by construction; `ready` makes a copy indistinguishable from production |
| D-284 | The restored container gets the source's repo config before Postgres starts | `restore_command` runs archive-get *inside* that container; the copy's own config points it at an empty repo |
| D-285 | Restore with `--target-action=pause`; confirm the target was reached before promoting | `promote` leaves no moment at which "did this land where I asked?" can be answered |
| D-286 | `reached_lsn` is the evidence; `reached_time` may legitimately be NULL | Recovery can reach its target having replayed no transaction, so requiring the timestamp fails restores that worked |
| D-287 | The restore rotates the copy's credentials, connecting with the source's | Otherwise one password opens two databases and a rotation on the original misses the copy |
| D-288 | A restore counts against the per-org ceiling, refusing with the remedy named | It consumes a real node slot; OQ-079 owns the per-plan concurrent-restore policy |
| D-289 | A future or out-of-window `target_time` is refused, never clamped | Clamping returns a restore that silently is not what was asked for — the exact failure the flow prevents |
| D-290 | In-flight work uses an indeterminate progress indicator, never an invented percentage | A fixed 55% fill is a number nothing computed, and it reads as stuck rather than as working |
| D-291 | A restored copy lives 48h by default, 7 days at most — a ceiling, not a setting | A copy holds a second dataset and two bookings while serving nothing, and a long TTL fails silently and cumulatively |
| D-292 | Expiry soft-deletes through the normal pipeline, never purges | The customer restored because they lost data, so the copy may be the only surviving version; the pipeline keeps it recoverable for a week |
| D-293 | Invalid TTL → default; valid-but-out-of-range → clamped | Zero is the absence of an answer, not a short window; a typo must not stop a fleet booting |
| D-294 | The deadline is written with the project and shown on the detail, not only on create | A column filled in later is a copy that lives forever; the customer who needs the deadline returns two days later |
| D-295 | A PITR target keeps its sub-second precision | Trimming milliseconds moves the target back by up to a second, returning a restore that looks correct and is one transaction short |
| D-296 | `final_backup` is always a full, and its failure stops the deletion | The only copy that survives the project; nothing about a DELETE distinguishes "done with this" from "wrong ref" |
| D-297 | Pause backs up after the checkpoint, confirms with `check`, and leaves containers running on failure | A paused project whose backup failed has one node disk as the only copy — worse than a running one |
| D-298 | The pause backup is incremental under 7 days, full otherwise | Nothing extends the chain until resume, so a link nobody watches is a restore that depends on it |
| D-299 | `CB_REQUIRE_FINAL_BACKUP` defaults on | The failure is invisible: a recovery window with nothing behind it looks exactly like one |
| D-300 | Retrievability is proven by reading the repo from a container that is not the deleted project's | A `succeeded` row is our bookkeeping; the criterion is about the repo |
| D-301 | The control plane deletes purged repos itself over S3, with a hand-written SigV4 client | After purge there is no container to run pgBackRest in, and delete rights belong to the control plane alone |
| D-302 | `project_repos` outlives every other trace of a project | What must survive a purge is what still needs deleting and when; RESTRICT so a future delete cannot orphan the objects |
| D-303 | Destruction is proven by re-listing; the row is marked only when the prefix is empty | Deleting and assuming would retain objects forever behind a row asserting they were gone |
| D-304 | The repo path is stored, and the S3 prefix drops its leading slash | pgBackRest spells it `/projects/<id>`, S3 keys have none — the unmodified path matches nothing, silently |
| D-305 | Control plane and project containers reach the store at separate configured endpoints | Identical in production; locally the host cannot route to a container IP, and the mismatch is a timeout that looks like a bad secret |
| D-306 | Every signed S3 request with a body sends an explicit `Content-Length` | Node uses chunked encoding otherwise and S3 answers 411 MissingContentLength |
| D-307 | Verification uses a scratch container with its own volume, no network, no port, destroyed in a finally | It exists to be read once; a reachable copy of a customer's database is a hole opened by the mechanism meant to protect them |
| D-308 | Four checks, and the sanity count is the one that cannot be faked | A backup can pass every structural test and contain an empty database |
| D-309 | The sanity expectation uses `reltuples`, not `count(*)` | It runs against a customer's live production database and must not scan it |
| D-310 | Never-verified projects go first, and a failed verification does not count as one | A longest-unverified sort ranks the never-verified last, because they have no timestamp to be old |
| D-311 | Two alerts: any failure pages, low coverage warns | A verifier that stopped looks exactly like a fleet whose backups are all fine |
| D-312 | The control plane's S3 client has no `PUT` | Delete is the only write right it should hold; the sabotage test overwrites with `mc`, from outside the product |
| D-313 | Project end-user passwords use scrypt, not D-111's argon2id | Extends D-211: a native module on the path that absorbs every project's logins; bcrypt import compatibility deferred, not dropped |
| D-314 | The `auth` tables are created by the image at initdb | Fleet-wide and identical, and it makes the export promise true — end-user data never touches the control plane |
| D-315 | `corebase_auth` alone holds table privileges in `auth`, with its own password | `service_role` has BYPASSRLS, so the absent grant is the only thing between it and every password hash |
| D-316 | No default privileges in `auth`, and force-RLS stays scoped to `public` | Enabling RLS on `auth.users` would lock the auth module out of its own tables — every login failing at once |

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

**Milestone 0 is complete** — ten tasks and the retro. The cost model, the risk
register and the decision log now carry the measured numbers, and D-209 gates what
may be done with them next.

**Phase 1 is complete** — P1a through P1g. All three exit criteria are met: roles
decide permissions end to end (P1d), every mutation is audited and a route guard
enforces it (P1b), and CI runs both suites on every PR (P1f). The dashboard shell
(P1g) covers login, signup, the org switcher, the projects grid, the create-project
flow and a project overview.

**Phase 2 is complete** — all seven steps. **Exit criteria 2 and 4 are met**,
**3 is met apart from its hard backstop** (the XFS project quota needs a real
node), and **1 is met on its functional half**: 100 projects run on one node, but
D-209 forbids re-basing the density model on ARM without the full triplet, so the
modelling half stays open by design rather than by omission.

The measurement that would move the cost model most is the one Phase 1/2 makes
possible:
the full triplet (Postgres + PgBouncer + PostgREST) under light load on x86, with
10 and 50 projects co-resident and the per-project exporters attached. That single
run answers the per-project RAM budget, the per-project cardinality budget, and
the first honest read on co-tenant contention.

**Everything above the database** is Phase 2+: the data API (PostgREST), the end-user
auth service, storage, realtime, the CLI, the SDK. All planned in detail under
[docs/](docs/INDEX.md); none started. Phase 1 built the *platform* around the spine —
accounts, orgs, roles, audit, project keys — not the customer-facing data plane.

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
- OQ-073 is still open: the "2 direct slots" budget is advisory, not enforced by a
  per-role `CONNECTION LIMIT` on `developer`. A customer can still point an
  application fleet at `DIRECT_DATABASE_URL` and exhaust the direct headroom; it
  fails visibly, which is the intended behaviour, but nothing caps it.
- **Idle detection is missing its first signal**, deliberately. The doc requires both
  "no data-plane traffic" and "no database connections"; only the second exists,
  because the first needs a gateway. It is sufficient today — a client connection is
  the only way to use a project — and would become wrong the moment PostgREST lands.
  It is not scheduled to be built before its source exists, because code with no
  input is untestable and rots. What guards it is a **tripwire**: a test asserts a
  project is exactly two containers, so adding PostgREST, auth, storage or a gateway
  fails with instructions to implement the traffic signal first (D-236). The scan
  already takes the second input. Verified by adding a third container spec and
  watching the guard fail.
- No warning email at day 5 of the idle window, and no dashboard banner. The pause
  will arrive unannounced until Phase 4's sender exists.
- Resume onto a node that filled up while the project slept **fails** with the node
  named, rather than placing the project elsewhere and restoring — that path needs
  backups (Phase 3).
- The dashboard has no pause/resume affordance yet and D-131's auto-resume-on-open
  is unimplemented, so a paused project renders as a badge. The endpoints now exist,
  which is what was missing.
- **Proportional disk-I/O fairness is not in effect on this node.** The node's
  kernel has no `io.weight` (no BFQ, no blk-iocost), so D-055's IO weight is
  probed and omitted here rather than applied (D-255). The absolute half —
  `io.max` per-device byte caps for the free tier — is enforceable on this kernel
  but inert until an operator names the node's data device (`CB_IO_DEVICE`); no
  device is configured in staging, so neither I/O control is currently live. What
  is verified is that the spec and the probe agree, in both directions.
- **The hard per-project disk quota is not implemented and cannot be verified here.**
  D-070 puts it on XFS project quotas, which need a real node with an XFS filesystem
  mounted `prjquota`; the substitute runs Docker-in-Docker on overlay. So criterion
  3's "the node itself never suffers" rests on a mechanism this environment cannot
  test. Everything above the backstop — the ladder, the recovery, disk booking, the
  node cordon — is implemented and tested.
- No email or dashboard banner at the 80% and 90% rungs. The ladder records the rung
  and audits nothing yet; notification is Phase 4's sender.
- **Verification shares the one node with customer projects.** Backups §7 wants a
  node designated for verification; there is one node here, so the scratch instance
  is isolated by its own volume and a network-less container rather than by
  hardware. A verification restore competing with a customer's database for I/O is
  a real effect this substrate cannot rule out.
- **bcrypt verify-only compatibility is not built** (D-313). D-111 promised it so
  customers could migrate a user table from GoTrue without a mass password reset;
  it needs a dependency of its own and nobody is migrating in yet. Recorded because
  D-004's portability is supposed to cut both ways.
- The auth module serves **eleven of its thirteen endpoints** (P4b, P4c, P4e).
  What is left: **`GET /user` and `PUT /user`**, and **`/admin/users`**. The
  consequences are specific rather than cosmetic — `PUT /user` is what completes a
  password reset (see below), holds the email-change flow, and is the only writer
  of `raw_user_meta_data`; and without `/admin/users` a developer has no way to
  ban, unban, delete or force-sign-out one of their own users except by SQL.
- **Password reset still stops one step short of resetting a password.** Flow 7
  step 1 works — a recovery link yields a session — and steps 2–6 need `PUT /user`.
  So the flow logs you in and cannot change your credential, the "revoke every
  other session" rule that makes a reset meaningful is unenforced, and the "your
  password was changed" tripwire mail has nothing to trigger it.
- **No absolute session cap.** A lineage's lifetime is bounded only by idle expiry
  (30 days, per-project) and revocation, so a device refreshed weekly stays signed
  in indefinitely. OQ-113 has this as a V1.x config candidate; nothing enforces
  "force re-login every N days" today.
- **Nothing prunes spent refresh tokens.** Every rotation leaves a row, so a
  long-lived session accumulates one per refresh — roughly one per hour per active
  session at the default TTL. Harmless at current scale and a table that grows
  without bound is still a table that grows without bound; there is no reaper.
- **Email sends, but only to a sink.** P4d built the interface, the SMTP client,
  the templates, the caps and the suppression check; the **Postmark client does
  not exist** (D-331), so a deployment's only working provider is an SMTP host.
  That makes **Phase 4's third exit criterion unmet**: mail delivering to Gmail,
  Outlook and Yahoo with SPF, DKIM and DMARC green is a property of a real domain
  at a real provider, and no amount of local testing substitutes. Nor do the DNS
  records exist — `mail.corebase.co`, its SPF `-all`, its DKIM selector, its DMARC
  policy and its aligned return path are all Terraform that has not been written.
- **Nothing populates the suppression lists.** Both lists and the enqueue-time
  check are built and tested; the webhook endpoint that would feed them is not,
  because there is no provider sending webhooks. So a suppression arrives today
  only by an operator inserting a `manual` row, and the complaint score, the
  ≥3-project promotion to the global list, and the >10% bounce / >0.1% complaint
  auto-pause are all part of that same unbuilt half (D-116).
- **No deliverability monitoring and no canary.** `corebase_email_sends_total` and
  `corebase_email_failures_total` exist and are labelled by template, not by
  project — per-project labels on a fleet-wide counter is the cardinality mistake
  D-146's budget exists to prevent, so per-project numbers live in `email_sends`
  instead. What that leaves missing is the doc's whole monitoring table: bounce and
  complaint *rates* need webhook data, and the daily synthetic mail to a canary
  account at each major provider needs accounts at each major provider.
- **Three of the six templates are unreachable.** `email_change_current`,
  `email_change_new` and `password_changed_notice` render correctly and nothing
  emits them, because their flows are not built. They are covered by a rendering
  test so a variable named in a template but absent from the type fails
  immediately rather than at send time.
- Per-project template overrides are supported by the renderer and there is no
  way to set one: the column, the API and the dashboard editor are all unbuilt,
  and the doc's "unknown variables fail validation at save time" is therefore
  enforced at render time instead (which throws, dead-letters that one mail, and
  is strictly worse than catching it in a form).
- **Password reset stops one step short of resetting a password.** Flow 7 step 1 is
  built: a recovery link yields a working session. Steps 2–6 need `PUT /user`,
  which does not exist — so the flow logs you in and cannot change your
  credential, and the "your password was changed" tripwire mail has nothing to
  trigger it.
- **Email change is not built at all.** `email_change_current` and
  `email_change_new` are accepted token types with no endpoint that issues them,
  so Flow 9's double confirmation is a table constraint and nothing more.
- **`/recover` and `/resend` are rate-limited but not yet capped per project.** The
  request buckets exist (4/hour per address, 10/hour per IP); D-116's *send* caps —
  30/hour and 200/day on Free, 100 distinct recipients, ≤4/hour to one address —
  are a P4d concern and unenforced, as are the suppression lists that are supposed
  to be consulted at enqueue.
- Consuming a token on GET means a corporate mail scanner's prefetch verifies the
  address and spends the link (OQ-114). Accepted for V1 deliberately; the audit
  action `verify_failed_confirmation` is the signal that would justify building the
  interstitial page, and nothing yet counts it.
- `corebase_auth` is still not in the pooler's `auth_query` allowlist, and OQ-110
  is still open. P4b took the third option — a fresh connection per request
  (D-323) — because a cached pool breaks on credential rotation. Putting auth
  behind the pooler is a change to the pooler's security posture (D-074) and needs
  load numbers; both make it its own step.
- **Rate limits are per API process, not per project cluster, unless Redis is
  configured.** `main.ts` falls back to an in-memory limiter with a warning, and
  two API replicas then grant two independent budgets. The doc puts these buckets
  at the gateway (D-033); until the gateway exists, Redis is what makes them real.
- No `POST /signup?anonymous=true`, no MFA, no OAuth — all deliberately V1.1+ per
  the scope freeze (D-013).
- `pgbackrest verify` — the monthly repo-side checksum audit that catches bit-rot
  without a full restore (backups §7's last bullet) — is not scheduled. The
  restore-based verification is the stronger of the two and is the one the criterion
  names; the cheap one is still worth having.
- The P3d suite provisions a source per test, which makes it slow and made it
  unfinishable on a loaded machine. Sharing one provisioned source across the file
  would cut four provisions.
- **Promote is not built** (backups §4 step 6). A restored copy can be validated
  and then expires; there is no credential/endpoint swap, so the way to *keep* a
  restore does not exist yet. The dashboard banner says so rather than offering a
  dead button. Expiry (step 7) is built — P3e.
- **Time-based retention is not verified over real calendar days.** pgBackRest
  decides expiry from timestamps in the repo, so proving a 7-day policy needs a
  7-day-old backup or repo surgery. The mechanism is tested with a count-based
  override and the production policy is pinned by unit test; the calendar
  arithmetic is taken on pgBackRest's word.
- Retention expiry is frozen for a paused project only *incidentally*: expire runs
  as part of a backup, a paused project takes none, so nothing expires its chain.
  That is the right outcome and it is not enforced anywhere — nothing would stop a
  future explicit `expire` from running against a paused project.
- The archive alerts are proven against synthetic series and a sabotaged project,
  but **nothing is wired to a receiver**: Prometheus would fire and there is no
  Slack or pager on the other end (OQ-146 owns the vendor choice). "Alerts fire" is
  met in the sense the criterion tests; "someone is woken up" is Phase 4's sender.
- `CB_REQUIRE_BACKUPS` and `CB_REQUIRE_FINAL_BACKUP` are both **on** now that
  Phase 3 is complete: a fleet with no object storage refuses to provision and
  refuses to delete rather than doing either silently. `=false` on each is the
  deliberate opt-out.
- **The density numbers cannot move the cost model, and the model is therefore
  still unvalidated.** M-008 satisfies two of D-209's four conditions (100
  co-resident projects, client load) and cannot satisfy the other two here. The
  350 MB booking and D-091's 150-active/node remain assumptions — favourable
  assumptions, since measured usage is 27× lower, which is exactly the situation
  D-209 exists for.
- **Nothing models CPU.** M-008 found cores at 82% while RAM was 27× over-booked.
  Placement books RAM and disk; there is no CPU term in the arithmetic and no
  measurement of it on target hardware (OQ-182).
- Placement is single-node in staging, so bin-packing across a real fleet is
  proven only against **synthetic node rows** in the control plane. That is the
  right level for the arithmetic and the locking — both are SQL — but nothing here
  has watched a project land on a second physical node. OQ-150 owns the question of
  how many staging nodes would make that meaningful.
- The pooler's pool sizing is one profile for every plan. The doc's "larger plans
  scale `default_pool_size` and `max_connections` together" is a value change the
  entrypoint is structured for and nothing sets yet.
- `corebase_admin` exists as a role with no password; the audited dashboard path that
  needs it does not exist yet.
- `verify-email` and `password-reset` are **absent, not stubbed** — both need the
  Phase-4 email sender. Email verification is what gates project creation in the
  platform API, so that gate is currently declared and not enforced.
- No OAuth identity providers. `user_identities` exists so adding one is not a
  rewrite; nothing writes to it yet.
- PAT scopes are stored and returned but not yet *enforced* — a token with a narrow
  scope currently has its user's full authority.
- The invite email is not sent (same Phase-4 sender), so an invite has to be handed
  over out of band for `POST /v1/invites/accept` to be usable.
- The **nightly drills** have never run on a GitHub runner. `ci.yml` now has —
  both lanes green, including the full integration lane — but `nightly.yml` shares
  none of that proof beyond the setup steps, and the first scheduled run is still
  the real test for the kill matrix, the lifecycle loop and the reboot drill.
- The dashboard covers the shell only: no members page, no billing, no org
  settings, no audit viewer, no table editor, no SQL editor. The audited
  `service_role` reveal is therefore not reachable from the UI — the keys page shows
  the `curl` instead, deliberately, because the reveal needs a confirmation stating
  that looking is recorded.
- No project deletion in the UI. The endpoint exists and the recovery window is
  visible on a deleted project, but the destructive dialog that types the project
  name to confirm (design system §5 rule 4) is not built, so gate question 15 has
  nothing to answer for yet.
- No pause/resume affordance, because the endpoints are Phase 2. That also means
  D-131's auto-resume-on-open is unimplemented and a `paused` project renders as a
  badge and nothing else.
- **No browser test suite.** Every flow was verified by driving a real browser by
  hand, and the keyboard contract by asserting `document.activeElement` in the page,
  but none of that runs in CI — so a regression in login, create, or focus
  restoration would not be caught. This is the largest known gap in the dashboard
  and the obvious next investment: the 20-question gate is a human process, and
  about eight of its questions are mechanically checkable.
- Gate questions deferred rather than passed: **Q9/Q10 have no side panel or second
  view to judge yet** (OQ-180 leaves panel URL state undecided until there is a
  second one), and the palette searches destinations and the user's own projects but
  no other data (OQ-179).
- The projects list paginates with a Load-more rather than a cursor in the URL, so a
  second page of results is not linkable — acceptable while an org has tens of
  projects, and a real gap against gate question 3 at hundreds.

## 9. Where to look when you pick this up

| Question | File |
|---|---|
| What are we building and why? | [docs/INDEX.md](docs/INDEX.md), then [00-foundation](docs/00-foundation/01-vision-and-principles.md) |
| Why is it like this? | [docs/00-foundation/05-decision-log.md](docs/00-foundation/05-decision-log.md) — binding |
| What is deliberately unresolved? | [docs/15-risks/02-open-questions.md](docs/15-risks/02-open-questions.md) — 140 questions |
| What is the next task, exactly? | [docs/14-roadmap/01-phase-plan.md](docs/14-roadmap/01-phase-plan.md) — Phase 1, P1g (dashboard shell) |
| What did Milestone 0 deliver? | [docs/14-roadmap/04-milestone-0.md](docs/14-roadmap/04-milestone-0.md) — includes a progress table |
| How do permissions work? | `services/api/src/kernel/permissions.ts` — the whole role model is one table |
| How does auth work? | `services/api/src/kernel/principal.ts`, then `sessions.ts` and `modules/auth/` |
| Why is every mutation audited? | `packages/audit/src/index.ts`, and the guard in `services/api/src/audit.p1.e2e.test.ts` |
| What does CI do? | [.github/workflows/ci.yml](.github/workflows/ci.yml) — two lanes; `nightly.yml` for the drills |
| What did we measure? | [docs/14-roadmap/05-measurements.md](docs/14-roadmap/05-measurements.md) — M-001…M-007 |
| What do those numbers *not* prove? | [the M0 retro §4](docs/14-roadmap/06-milestone-0-retro.md) — read before quoting any of them |
| How does provisioning actually work? | `services/worker/src/jobs/sagas.ts` — read top to bottom |
| How does a project database get built? | `infra/docker/postgres/` — Dockerfile plus four init scripts |
| What does the UI look like? | run the dashboard (§2), or [design-exports/07-html](design-exports/07-html) served over HTTP |
| How does the dashboard talk to the API? | `apps/dashboard/src/lib/api.ts` — envelope, CSRF, 401, credentials, all in one place |
| Why is the dashboard not Tailwind? | D-220 in the [decision log](docs/00-foundation/05-decision-log.md) |
| **How must a UI change behave?** | [docs/09-dashboard/05-ux-standards.md](docs/09-dashboard/05-ux-standards.md) — §8 is the gate every change runs |
| How do I run that gate? | the `ux-review` skill in [.claude/skills/](.claude/skills/ux-review/SKILL.md) |
