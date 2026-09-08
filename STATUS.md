# Steadhold — Build Status

**Last updated:** 2026-09-05 · **Phase:** Phase 4 (auth) · **Milestone 0 complete** · **Phase 1 complete** (P1a–P1g, all exit criteria met) · **Phase 2 complete** (P2a–P2g) · **Phase 3 complete** (P3a–P3h; **all four exit criteria met**) · **Phase 4 complete** (P4a–P4i; 2 of 3 exit criteria met — the third needs a real domain and provider) · **Phase 5 started** (P5a done)

This file is the handover document. If you are picking Steadhold up — new collaborator,
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
docker build -t steadhold/postgres:17.5 infra/docker/postgres
docker build -t steadhold/pgbouncer:1.23 infra/docker/pgbouncer
./scripts/staging.sh seed-images   # push both project images onto the data node
./scripts/staging.sh backup-store  # bucket + TLS for the object store, and prove egress
./scripts/staging.sh mail-sink     # the SMTP sink that stands in for the provider
./scripts/staging.sh verify        # 10 checks; all must pass
```

**After Docker restarts, re-run `backup-store`.** It writes the object store's
**container IP** into `backup-store.env`, and a restart reassigns that IP — after
which every pgBackRest exec hangs for its full timeout trying to reach an address
nothing answers on. The symptom is `POST /exec/… timed out` after 65 s in the
backup and interlock suites, which looks nothing like "the object store moved".
`./scripts/staging.sh all` does the whole sequence and is the safe thing to run
when in doubt.

Start the services, then see the whole thing work in about five seconds:

```bash
./scripts/dev.sh
```

```bash
./scripts/demo.sh
```

And the auth demo — a browser signing a user up against a real project, verifying
from a real email, and reading its own token's claims:

```bash
./scripts/auth-demo.sh
```

That creates a project, waits for it, connects to the database it made with the
credentials the API handed back, runs real SQL, and deletes it — using only curl
and psql, which is exactly what a customer has. `--purge` also destroys it;
`--keep` leaves it running and prints the command to connect.

### The dashboard

`dev.sh` sets `SH_DASHBOARD_ORIGINS`, so with it running:

```bash
pnpm dev:dashboard
```

Then open http://localhost:3000. There is no seeded password anywhere — the
bootstrap account has no hash on purpose — so create an account on `/signup`. A new
account has no organization and lands on `/no-org`; the org endpoint exists but has
no screen yet, so make one with the API:

```bash
curl -sS -c /tmp/sh.jar -X POST http://127.0.0.1:8099/v1/auth/login -H 'content-type: application/json' -d '{"email":"you@example.com","password":"your-password-here"}'
```

```bash
curl -sS -b /tmp/sh.jar -X POST http://127.0.0.1:8099/v1/orgs -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -d '{"name":"Greenbull","slug":"greenbull"}'
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
pnpm --filter @steadhold/worker bench
```

The crash-resume matrix is a separate script because 11 scenarios × ~35s is a
nightly job, not a per-commit one:

```bash
pnpm --filter @steadhold/worker kill-matrix
```

`SH_KM_ONLY=start_container` narrows it to one scenario; `SH_KM_TIMELINE=1` prints
the restarted worker's log with arrival times, which is how the 60s recovery
mystery got solved.

The full lifecycle loop — create, use, delete, purge, twenty times, then assert
the node and control plane are empty:

```bash
pnpm --filter @steadhold/worker lifecycle
```

The node-reboot drill — restart the data node and watch it converge, with an
orphan planted to prove the sweep reports rather than deletes:

```bash
pnpm --filter @steadhold/worker node-reboot
```

### Watching it work

`scripts/dev.sh` (above) also tees the services' output to the files Alloy tails,
so logs reach Loki. Grafana is at <http://127.0.0.1:3001/d/steadhold-provisioning> (anonymous
admin, local only) and `./scripts/staging.sh monitoring` prints the URLs plus a
health check. To verify the whole observability path end to end — scrape targets,
20 runs on the panel, logs queryable by ref, the alert actually firing:

```bash
pnpm --filter @steadhold/worker observability
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
export SH_CONTROL_DATABASE_URL=postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control
export SH_REDIS_URL=redis://127.0.0.1:56379
export SH_DOCKER_HOST=127.0.0.1 SH_DOCKER_PORT=2376
export SH_DOCKER_CERT_DIR=$PWD/infra/docker/staging/certs
export SH_KEK_DIR=$PWD/infra/docker/staging/kek.d
export SH_BOOTSTRAP_SECRET=local-bootstrap-secret-0123456789
export SH_PROJECT_DOMAIN=localhost SH_PG_PORT_MIN=5433 SH_PG_PORT_MAX=5462
export SH_NODE_RAM_MB=16384 SH_STATIC_TOKEN=dev-token PORT=8099
```

`SH_PROJECT_DOMAIN=localhost` matters: connection strings come back as
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

The migration runner (`@steadhold/migrate`, 9 tests) takes a Postgres advisory lock,
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

**T5f — the measurement.** `pnpm --filter @steadhold/worker bench`. 20/20 creates
ready *and usable*, max 3.26s against a 60s budget. Per-step attribution showed
~85% of a create is `wait_healthy` (initdb plus a first Postgres start) and the
control plane's own work totals 57 ms.

### T6 — Crash-resume proof · done · [M-003](docs/14-roadmap/05-measurements.md)

`pnpm --filter @steadhold/worker kill-matrix` SIGKILLs the worker at eleven points
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
**gate**, not a stub: `SH_REQUIRE_FINAL_BACKUP=true` makes deletion fail loudly
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
| `sh-*` volume with no placement row, **or any unlabelled volume** | **alert only**, never removed |
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

`@steadhold/metrics` is a hand-written registry — three metric types and one
well-specified text format, the same reasoning that put the Docker client here
rather than a Docker SDK. What it buys beyond avoiding a dependency is control
over label sets, which is the thing that actually matters: **D-146's cardinality
budget is a design constraint**, and a registry that demands the label set at
construction makes an accidental per-project histogram hard to write. The
verification harness queries `{__name__=~"steadhold_.*", project_ref!=""}` and
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
  FOR EACH STATEMENT EXECUTE FUNCTION steadhold_audit_is_append_only();
```

And the ordering bug CI found rather than I did: the migration linked the bootstrap
user to the dev org by joining on its slug, but on a **clean** database that org does
not exist yet — the API creates it at startup. So the INSERT matched nothing and a
fresh install came up with an organization that had no owner. My staging database
already had the org from Milestone 0, which is exactly why it survived until the
integration lane ran against an empty one. `ensureBootstrapOrg` now creates the
membership too, idempotently.

### P1b — the application role, the audit writer, the envelope · done · 15 tests

**A role that cannot rewrite history.** `steadhold_app` is `NOLOGIN` with grants
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
the user spotted: **`--sh-space-5` does not exist**, the 4-point scale being
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
(**D-228**). `sh-<ref>-net`, derived from the ref rather than stored — exactly one
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
through `steadhold.pgbouncer_lookup`, so a rotation is one `ALTER ROLE` with nothing
to ship or reload. The image creates `pgbouncer_auth` as a **passwordless** LOGIN
role and the worker sets its password at provision time, so no credential is baked
into an image (**D-232**).

Two details in that function are load-bearing. `SET search_path = pg_catalog` stops
a caller shadowing `pg_shadow` with their own relation and having a definer-rights
function read it instead — a SECURITY DEFINER function without a pinned search_path
is a privilege escalation, not a style preference. And the allowlist inside it is a
*boundary*: only `developer` is resolvable, so the pooled port cannot reach
`postgres`, `authenticator`, `steadhold_admin` or `pgbouncer_auth` itself even if
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
missing, and the compose project is now `steadhold` rather than `steadhold-staging`.

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

`pnpm --filter @steadhold/worker density` is the instrument; the numbers are
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

**A hardcoded credential** (**D-240**). `SH_STATIC_TOKEN` defaulted to the literal
string `dev-token`, so an API deployed with no configuration accepted that header
as the **bootstrap owner** — full rights, no expiry, no revocation, attributed to a
real user so nothing in the audit log looked unusual. Verified before fixing:
`buildApp({})` answered 200. The project refuses this deliberately elsewhere — the
bootstrap user has no password hash, `trust` auth is banned at image build time
(D-185), `steadhold_app` is NOLOGIN (D-216) — and it arrived through a `??`.

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
- `SH_REQUIRE_BACKUPS` fails provisioning closed for a project that cannot be
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

**`steadhold_backup_last_success_ts` was wired to WAL archiving, not base backups**
(**D-277**). P3b did that, and the metric name hides it completely. The alert on it
is "last-success age > 26 h → page", and pointed at WAL it stays green for a project
whose nightly full has not succeeded in a week — because the WAL was flowing
perfectly the whole time. Two healthy-looking signals and one missing backup. WAL
now has its own timestamp gauge, and `BackupRunFailed` was added beside it: silence
and refusal are different failures.

**A counter declared and never incremented.** `steadhold_backup_runs_total` existed,
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
nobody is watching, because the customer has already moved on. `SH_REQUIRE_FINAL_BACKUP`
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
exist in the project's own database from its first second, so `steadhold export`
carries them out with a plain `pg_dump` and **nothing about a project's end-users
is ever stored in the control plane**.

The `auth` schema itself already existed with the RLS helpers (`auth.uid()` and
friends, from D-015); this adds the tables, which the API roles are deliberately
*not* allowed to touch.

**The privilege boundary is the part worth reading.** `steadhold_auth` is the only
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
  signs API keys with `https://<ref>.steadhold.app`; an access token's `iss` is
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
domain, the link genuinely points at `<ref>.steadhold.app`, and the tokens land
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
its keep immediately: **`Acme (via Steadhold) <auth@…>` unquoted is not the name it
looks like.** Parentheses delimit a comment in RFC 5322, so the sink reported the
display name as "Acme" alone — and the "via Steadhold" half is the part that keeps
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
### P4f — `/user`: password change, password reset completion, email change · done · 16 tests

**Password reset works end to end now**, which is the headline: before P4f a
recovery link logged you in and could not change your credential. `GET /user`,
`PUT /user` and the `email_change` branch of `/verify` close Flows 7, 8 and 9.

**The `current_password` rule is the security content of the endpoint** and is
pinned by a test that was made to fail. A stolen access token alone must not be
convertible into permanent account ownership: a token lifted from `localStorage`
buys an attacker an hour, and a token that can set the password buys the account.
The one exception is a token minted by a recovery link, which has already proved
control of the mailbox — the same proof a password would give.

**That exception rides the reserved `amr` claim, not a session flag** (**D-343**).
Marking the session would need a column in `auth.sessions`, which lives in the
project-database image and **has no per-project migration path** — a gap this step
surfaced and did not close (see §8). The claim table reserved `amr` for auth
methods and says adding claims is non-breaking, so it is the mechanism already set
aside for this. It also gives the tighter property: the capability dies with the
token that carried it — an hour at most, and deliberately not carried across a
refresh — rather than lasting the session's thirty days. A recovery link is spent
in seconds.

**Email change is Flow 9's double confirmation, and both single-sided policies are
broken in opposite ways**, which is why the default is strict. Confirming only the
*new* address lets an attacker with a hijacked session silently re-point the
account and then own password reset forever — a temporary compromise turned
permanent. Confirming only the *old* address lets a user strand themselves on a
typo'd unreachable address. So: old-address confirmation proves the owner
approves, new-address confirmation proves the destination is real and theirs.
`new_only` exists because some products prefer the support burden to the friction,
and it issues **no** old-address token rather than one nobody will click
(**D-345**) — an unspendable row would make the change permanently
un-completable.

Two asymmetries that look like inconsistencies and are not:

- A completed **password** change revokes every session *except* the one that made
  it; a completed **email** change revokes *every* session including that one
  (**D-346**). A password change is an act of suspicion, so the session performing
  it is the one known to be in the right hands. An email change re-points the
  account's identity, and if it came from a hijacked session then the owner's
  sessions going too is correct — there is no way to tell the two cases apart.
- `PUT /user {email}` never reports that an address is taken (**D-344**), while
  the confirmation returns a 409. Reporting it up front would be the enumeration
  oracle signup and `/recover` were carefully built to avoid, reachable with one
  throwaway account. The unique index decides the collision instead, and
  `applyEmailChange` distinguishes `23505` from a real error so the loser is told
  rather than 500'd.

`/verify?type=email_change` is the one verify that issues **no** session
(**D-348**): the click may come from a mail client on a device that was never
logged in. And `pending` is a 200, because the user did exactly what the link
asked — reporting it as a failure is how a working double confirmation gets
mistaken for a broken one, which is what makes a project switch to `new_only` and
lose the protection.

**Verification:** 16 integration tests — `GET /user` reading the database rather
than the token's stale claims, a password change refused without and with a wrong
`current_password`, a correct one killing every other session and sending the
tripwire mail, a recovery link completing a reset with no old password, that
capability *not* surviving a refresh, metadata merging rather than replacing and
being unable to reach `app_metadata`, an unknown field and an empty body both
refused, one address alone never completing a change, `new_only` skipping the old
address, a taken address undisclosed on request and caught on confirmation, and
the GET form redirecting with an outcome and no tokens. Two mutations were run:
trusting the session instead of the claim let any bearer set a password with no
current one, and applying on first confirmation completed a change from one
address's word.
### CI repair — two environment-dependent tests, and a real bug behind one of them · 2 fixes + 1 new test

CI had been red since P4b. Not from the auth work — all three auth suites pass on
the runner (`project-auth.e2e` 47, `email.e2e` 10, `email-loop.e2e` 12) — but from
two **Phase 2** tests that were green on this machine and failed on the runner.
Both had the same shape: a branch that never executed where it was written.

**`wait_healthy` was masking its own diagnosis** (**D-349**). `exec` against a
container that has already exited *throws* rather than returning a non-zero code —
the Engine answers `POST /exec/<id>/start` with an error — and unwrapped that
escaped the health loop and became the step's failure. So a container whose
entrypoint refused to initialise reported `POST /exec/673c33c5…` instead of
"container exited while starting". The loop's own comment already gave `inspect`
the job of deciding whether a container cannot exec *yet* or cannot exec *ever*;
catching the throw is what lets it. This is the same failure shape as three earlier
bugs in this repository — a diagnostic that discards what it knows — and it would
have surfaced in production eventually, because which of the two things happens
first is a race.

**The `io.weight` assertion encoded runc's arithmetic** (**D-350**). It checked that
the cgroup read back the literal `200` we asked for. `HostConfig.BlkioWeight` is
cgroup v1's range (10–1000) and runc rescales it into cgroup v2's (1–10000), so
200 reads as `default 1920`. That conversion is runc's implementation detail, not a
contract. It now asserts the property that can actually be wrong: the applied
weight is not cgroup's own default of 100 (what an *ignored* weight looks like) and
sits below the middle of the range (so an inverted rescaling fails too). This is
the second time this test has been wrong in the same way — its `if` branch only
runs on a kernel that *has* the feature, and this one does not.

**The fix that mattered could not be proven by fixing the race.** Making the test
wait for the container to exit removes the race but not the divergence: Docker
Desktop returns an exit code where the runner throws, so the test still passed with
the fix reverted. So there is a second test that **injects** a `docker.exec`
throwing exactly what the Engine throws (**D-351**), and it fails with CI's precise
message — `POST /exec/deadbeef/start failed: 409` — when the fix is removed. A
guard whose branch never executes on the machine where it was written is a guard
nobody has tested.

**One staging trap found while verifying, worth knowing before it costs an hour.**
`backup-store.env` pins the object store's **container IP**, and a Docker restart
reassigns it. Every pgBackRest exec then hangs for its full timeout trying to
reach an address nothing answers on — six interlock tests failed with
`POST /exec/… timed out` after 65 s each, which looks nothing like "the object
store moved". `./scripts/staging.sh backup-store` rewrites the file and fixes it;
it is now part of the after-a-restart sequence in §3. The production analogue does
not exist — R2 is a stable hostname — so this is a property of the substitute
rather than of the design.

**Verification:** `docker.e2e.test.ts` and `cgroups.e2e.test.ts` 26/26 locally,
against a stack rebuilt from scratch after Docker Desktop died again. The
`io.weight` branch still cannot run on this kernel — CI is its only runner — so the
new assertion was checked by hand against the exact strings the runner produced
(`default 1920` passes, `default 100` fails).
### P4g — `/admin/users`: the thirteenth endpoint · done · 13 tests

**Phase 4's API surface is complete.** `GET`/`POST /admin/users` and
`GET`/`PUT`/`DELETE /admin/users/:id` close it, and with them the only supported
way for a customer to honour a user's deletion request — D-114 makes
developer-initiated deletion the *only* deletion in V1, so until now the answer
was "connect to the database and write SQL".

**This surface breaks the rule every other one follows, deliberately** (**D-352**).
It is authorised by the **service_role** key — the customer's own server-side
credential, which can already read every row in the schema — so the enumeration
resistance that shapes signup, `/recover` and `PUT /user` would protect nothing
here and would break a retrying import script that has to tell "already gone" from
"done". Flow 10 says so outright. The corollary is that **the key check is the only
thing between an anon key and every account on the project**, so it runs first on
all five routes and the test exercises all five rather than one. Disabling it was
run: the anon key got a 200.

A refusal is **403, not 401** (**D-353**). The credential is valid and simply not
this one — and the anon key is the one their frontend already holds, so it is the
mistake a developer will actually make; a 401 would send them hunting for an
expired key.

**Deletion keeps the id and nothing else** (**D-355**). The customer's tables
reference `auth.users(id)` under their own FK semantics and Steadhold does not
cascade into app schemas, so a hard delete would either break those references or
force a decision about a customer's data that is not ours to make. The address
becomes `deleted+<id>@invalid` — syntactically valid, in a reserved TLD that can
never receive mail — which frees the real address for re-registration through the
partial unique index. Password, both metadata halves and `email_confirmed_at` are
scrubbed, and every session, refresh lineage and outstanding one-time token dies
with it: **a deleted user whose recovery link still works is a deleted user who
can be signed back in from an inbox.** The audit row keeps the destroyed address,
because the user row can no longer answer "which account was this". Reducing the
delete to just `deleted_at = now()` was run, and the test caught the un-scrubbed
address.

`PUT /admin/users/:id` also carries ban/unban, `email_confirm`, an admin password
set, `app_metadata` — it is the only writer of it — and `sign_out`. A ban, a
password set and `sign_out` all revoke every session (**D-354**), because a ban
that leaves refresh working is not a ban; `sign_out` stays a separate flag because
"log out of that stolen laptop" and "get off my service" are different requests
and conflating them makes the milder one unavailable.

Two smaller decisions worth stating. A **NULL** password hash is a legitimate
state creatable only from here (**D-356**) — an imported account awaiting a reset,
or a provider-only one — and `''` was rejected as a value meaning "absent" that
the login path's own NULL check would miss; the decoy verify keeps such an account
indistinguishable from a wrong password. And a malformed id is rejected before it
reaches a query (**D-357**): not an injection guard, since `pg` parameterises, but
a diagnosis one — `invalid input syntax for type uuid` renders as a 500 and points
a developer at the server instead of at their own request.

**Verification:** 13 integration tests — all five routes refusing the anon key
with 403 and changing nothing, keyset pagination with no overlap and no gap across
three pages, the admin view exposing the ban and `app_metadata` while still never
carrying the hash, a created user confirmed without an email round trip and a
duplicate answered 422 (unlike signup's decoy 200), a passwordless user
indistinguishable from a wrong password, a ban stopping login *and* refresh and
then being lifted, `sign_out` revoking without banning, an admin password set
ending every session, `app_metadata` merging and unreachable from `PUT /user`, the
full tombstone with the address freed and a new id on re-registration, a second
delete answering 404, a malformed id answering 400, and one project's service_role
key seeing none of another's users. Both mutations above were run and both failed
as they should.
### Nightly repair — the T6 kill matrix had not completed a provision since P3a · 11/11 · 5 fixes

**The nightly workflow had been red for four consecutive nights** and nobody was
reading it. Found while checking CI on P4g; it predates all of Phase 4. This is
the second unwatched-signal failure of the phase, and the more embarrassing one:
T6 is the drill that proves crash-resume works, and STATUS has been claiming that
as verified.

The output said `DID NOT CONVERGE in 120s` for every kill point, with four lines
of worker log. **The error that explained everything was in memory and outside
that window:**

```
backups are required (SH_REQUIRE_BACKUPS) but no repo is configured —
set SH_BACKUP_S3_ENDPOINT/_BUCKET/_KEY/_SECRET (./scripts/staging.sh backup-store)
job row: state=dead_letter, attempts=5/5
checkpoint: allocate_node … wait_healthy
```

**Five distinct faults, four of them in the drill and none in the product:**

1. **The drill's environment never carried the object-store settings**
   (**D-358**), so `configure_backups` — a step P3a added *after* T6 was written —
   failed every scenario. It now loads `backup-store.env` the way the e2e suites
   do, and refuses to start without it: a drill that runs for twenty minutes and
   then reports eleven mysterious failures is worse than one that will not begin.
2. **The create-project call's status was never checked** (**D-359**), so an API
   refusal left `ref` and `projectId` as `undefined` and the scenario carried on.
   This is what hid the *local* symptom, which was different again: the API
   correctly refuses to guess an organization when the caller belongs to several,
   and my own auth suites had created some.
3. **It destructured `{ref, id}` from a `{project, job}` response** (**D-359**) —
   the shape has been wrapped since P1d. So even a successful create yielded
   `undefined`, and every convergence poll watched a project that did not exist
   while provisioning succeeded perfectly. *That is what CI was actually
   reporting.*
4. **The failure paths printed four lines of a two-minute failure** (**D-360**).
   They now print the whole replacement worker's log, the `provisioning_jobs` row
   and the project's status. Fifth instance in this repository of a diagnostic
   that discards what it knows, and the cheapest of them to have prevented.
5. **The credential invariant asserted a stale total** — exactly 3, the number a
   project had at Milestone 0, against the 11 it legitimately carries now (the
   pooler's credential from P2b, the signing keypair and both API keys from P1e,
   the repo cipher-pass from P3a, the auth role from P4a). The count was never the
   property: the property is that a resumed saga did not regenerate a password it
   had already stored, which is a *duplicate*, and `count(*)` against
   `count(DISTINCT name)` catches that whatever the credential set grows to. Same
   lesson as D-350.

**Result: T6 PASS, 11/11, zero duplicates**, resume time min 30.9 s / p50 31.9 s /
max 39.7 s. Crash-resume was working the whole time — the drill could not see it.

**And T7 and T8 had the same two faults, which only became visible once T6
stopped failing** — they had been *skipped* behind it, so four nights of "T7
skipped" read as "not reached" rather than "never run". Both were missing the
object-store settings (D-358) and both omitted `org_id` (D-361); `node-reboot`
additionally never checked the create's status (D-359). All four harnesses now
share one loader and one org resolver in `bench/staging-env.mts`, because four
copies of a precondition is four places for it to rot. **T7 PASS** (2 cycles,
node and control plane clean) and **T8 PASS** (node rebooted, every project came
back with no human, the orphan reported rather than removed) locally.

**T5f had never run at all**, and the reason was a missing import:
`bench/provision.mts` calls `appDatabaseUrl` it does not import, so the drill
died on its first line. It was invisible because T5f was skipped behind T6.

So the harnesses are now **inside the worker's `tsc` pass** (**D-363**) — they
were outside every typecheck, which is how that survived. One line of tsconfig,
and it immediately found a second latent bug: `density.mts` read
`env.SH_PG_IMAGE` from an object that never carried it, so the `??` always took
its fallback and the probe silently pinned an image the fleet may have moved off.
It now imports `IMAGE` from `container-spec.ts` and cannot drift. The check is not
a cure — `res.json()` is `any`, so the `{ref, id}` drift would still have slipped
past — but a missing import or a renamed export is caught at commit time instead
of at 03:17.

**All four drills pass locally**: T6 11/11, T7 2 cycles clean, T8 node rebooted
with no human, T5f 2/2 ready and usable (~7 s each) with its per-step breakdown
intact — `wait_healthy` ~5.4 s and `verify_archiving` ~1.2 s dominate, everything
else under 600 ms. In CI, **T6, T7 and T8 all pass**; T5f found one more thing.

**And the structural flaw behind the whole episode is fixed** (**D-365**): the
nightly now runs **one job per drill** instead of four steps in one. Steps in a
job are sequential and skip once one fails, so T6 breaking in P3a made the other
three report "skipped" — which reads as "not reached" and is indistinguishable
from "never once run". That is why four nights of red produced one visible
failure and hid three. *A signal that hides three other signals behind it is
worse than no signal.* A fresh runner each is also more faithful: after T6, T7
and T8 had churned roughly fifty provisions and a node reboot on one host, T5f
hit `driver failed programming external connectivity` — bridge and port state
exhausted by the drills before it, not a fault in anything being measured.

On its own fresh runner T5f then got all the way to **19 of 20 creates
succeeding** — p50 9.5 s, none within a mile of the 60 s budget — and failed on
the twenty-first with `409: This organization already has 20 projects`. P1d added
a per-org ceiling of 20 *after* this bench was written to make a warm-up plus 20
measured creates, and nothing ran it to notice. It now raises the ceiling for its
own run, the way `density.mts` already did: what is being measured is
provisioning, not quota enforcement, and the bench knows how many it will ask
for. That is the fifth harness-vs-product drift this repair turned up, and every
one has the same shape — the product grew a rule and a harness written before it
kept assuming the old world.

**T5f's other failure was a product finding, not a harness one** — which is
what the drill is for. On a loaded runner:

```
pgbackrest stanza-create failed (exit 50): unable to acquire lock on
'/tmp/pgbackrest/main-archive-1.lock': Resource temporarily unavailable
```

`stanza-create` is the one pgBackRest command that runs while the archiver is
*failing in a loop*: the container archives from the moment it is healthy,
`archive-push` cannot succeed until the stanza exists, and async retries keep
re-taking that lock throughout. Every other command runs against a working repo
where the lock is held only for a real push — so D-267's general 6 s budget was
right for them and never right for this one. It now waits 30 s (**D-364**), still
bounded because a lock held that long really is stuck; what changes is that a slow
object store stops looking like one, and the saga stops spending a whole retry on
it. The ordering cannot avoid the race — the container has to be healthy before
anything can exec into it.

**Also fixed: the PITR test's intermittent failure** (**D-362**), which CI
surfaced on P4g as `expected [ 1 ] to include 2`. The test took its restore target
from `now()` (microsecond precision) through a JS `Date` and `toISOString()`
(millisecond), and **truncation moves a target backwards** — past the commit it
was meant to include. Row 2 committed at `…22.123456`, `now()` returned
`…22.123789`, the target became `…22.123`, and the restore correctly came back one
transaction short. Green whenever the microseconds happened to be small. It is
**D-295 one order of magnitude down**, the identical class of bug; the target is
now rounded up to the next whole millisecond, which cannot lose a transaction.
### P4h — the signing-key rotation runbook · done · 7 tests

**Phase 4's second exit criterion is met**: the rotation runbook runs against
staging and a session created before it survives it. `begin` → `cutOver` →
`retire`, plus the verification changes that make the middle of that sequence
survivable.

**Three commands, not one function** (**D-367**), because the runbook's value is
the *waiting* between its steps and a single `rotateKey()` would collapse exactly
that. `begin` publishes the new key without signing anything, so a verifier
caching JWKS for ten minutes already holds it before a token signed with it can
arrive. `cutOver` refuses to run before that window has passed, naming both
elapsed and required seconds — the operator's next question is "how much longer",
and an error that makes them compute it is an error that gets forced past.
`force` is the emergency path for a confirmed leak, where every outstanding token
dying at once is the intent.

**The signing key never moves** (**D-366**). `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`
and `JWT_KID` keep their meaning exactly and an unrotated project is untouched;
`project_signing_keys` holds only the keys a project publishes *without* signing
with them. `project_secrets` could not express this — it enforces one active
version per name, which is right for a password and wrong for a key set whose
entire purpose is to have two members. Public keys sit in the clear there, which
also turns JWKS from an envelope decryption per key into one query, on an endpoint
every verifier hits on every cold start.

**Every published key verifies, for API keys and access tokens alike**
(**D-368**), and this is the change that makes rotation survivable rather than an
outage. Step 4's parenthetical in the doc is the main event: D-029's anon and
service_role keys *are* JWTs under this keypair, and a customer's deployed
frontend holds one for as long as it takes them to ship. Restricting verification
to the active key was run, and the old anon key stops resolving the instant of
cut-over.

**Retirement is gated on the API-key window, not on token expiry** (**D-369**).
Tokens die within an hour; a deployed anon key does not. So the refusal reports
the days remaining *and* that the consequence is a broken frontend rather than
lost sessions. The scheduled sweep only ever closes a window an operator opened —
it never begins or cuts over a rotation, because both are judgement calls with a
wait in the middle and a scheduler making them would log a customer out on a
timer.

**One product-level trap found, and it produced the worst possible failure mode**
(**D-370**). `SecretStore.put` is `ON CONFLICT DO NOTHING` at version 1 — a
create-if-absent, right for provisioning and a trap everywhere else. The
cut-over called it expecting a swap and got a silent no-op: **JWKS published both
keys, the cut-over reported success, and every token still carried the old kid.**
A rotation in which nothing rotates is worse than one that fails, because it
reports success. `replace` now stores a caller-supplied value as the new active
version with `rotate`'s transaction, locking and version arithmetic.

**And two of my own probes were green for the wrong reason**, which only the
*negative* assertion could reveal. "The old key still works during the window"
passed while testing nothing, twice: first against `/auth/v1/health`, which
resolves no project at all and so ignores the `apikey` header, and then against
`POST /auth/v1/token` with no `grant_type`, which checks the grant *before*
resolving the project. Only "retiring the old key kills it" — which needs the key
to *stop* working — could tell the difference. That is the argument for writing
the negative case even when the positive one looks sufficient.

**Verification:** 7 integration tests — the full runbook with a pre-rotation
session surviving cut-over and refreshing onto the new kid, both JWKS endpoints
publishing the same set, the cut-over guard refusing and then forcing, both API
key generations working during the window and the old generation dying exactly at
retirement, `begin` twice returning the key already waiting, and the sweep
selecting only closed windows. Both mutations were run and both failed as they
should.
### P4i — the Phase 4 demo · done · Phase 4 complete

The roadmap's demo for this phase: *a plain HTML page signs a user up against a
project, verifies email, logs in, shows the JWT claims.* `demo/auth/` plus
`./scripts/auth-demo.sh`, which creates the project, points its `site_url` at the
page, hands it the anon key and serves it.

**It found a bug before it was finished, which is why the plan asks for it.**
`apikey` — required on every `/auth/v1/*` endpoint (D-029) — was **not in the
allowed CORS request headers**, and `PUT` was not in the allowed methods. A custom
header forces a preflight, the preflight lists only the allowed ones, and the
browser refuses before the request leaves: **every signup and login from a
customer's frontend had been failing for the whole of Phase 4** (**D-371**). The
allowlist was written for the dashboard, which talks to the control plane and
never sends an apikey, and the data plane inherited it — and the CORS suite only
ever preflighted `/v1/projects`, so it asserted exactly the wrong client's needs
and could not notice. There is now a case that preflights `/auth/v1/signup`, and
removing `apikey` again makes it fail.

**And `./scripts/dev.sh` could not create a project at all** — the seventh
instance of D-358's drift and the first one in the path a person actually types.
It never loaded `backup-store.env`, so `configure_backups` refused to finish and
every locally created project dead-lettered at 5/5 having completed five steps.
It now loads both env files and **exits** when the backup one is missing
(**D-373**), because the one thing the script exists for is a working dev loop.

The page is plain — no build, no framework, no dependency — and that earns its
keep twice: it is the auth API's first browser client, so anything that fails in
it is a thing a customer's own frontend would hit. It carries the **anon** key
only, and the generated config says why a service_role key must never be added
where somebody would be tempted to add one.

Step 2 uses a **genuinely delivered** message rather than skipping the step
(**D-372**): `serve.py` proxies the sink's read API under `/inbox` on the same
origin, so one click pulls the token out of the mail the worker actually sent over
SMTP. The proxy forwards `GET` to two allowlisted prefixes and nothing else — a
dev tool that forwards arbitrary methods to an arbitrary host is an open proxy,
and this one runs beside a credentialed API. `autoconfirm` stays **off**, which is
both the default and the point.

The mailed link points at `https://<ref>.<domain>/auth/v1/verify` — correct for
production, unreachable from a laptop without wildcard DNS and a TLS terminator.
The page says so rather than bending the product to be locally convenient.

**Verification:** driven end to end in a real browser — signup, one-click inbox,
verify, login, logout, four steps and zero console errors, with the claims table
showing `sub`, `aud`, `role`, `ref`, `session_id`, `kid` and what each is *for*.
Two bugs in my own `serve.py` were found that way: a `log_message` override that
crashed on `send_error`'s int status and answered an empty reply instead of the
403 it had just decided on, and the path allowlist — now proven against a
traversal attempt and a non-allowlisted path, both 403.
## 4c. Phase 5 — data API and RLS

### P5a — the data-plane traffic signal · done · 5 unit + 1 integration

D-236's first signal, built because Phase 5 cannot add PostgREST without it — and
building it found that **the gap had already opened, one phase early, through a
door the tripwire was not watching**.

The tripwire asserts a project is exactly two containers, on the reasoning that a
third would be a new way to use a project. The auth module became one **without
adding a container**: it is a shared multi-tenant process. So since P4b,
`/auth/v1/*` has served per-project traffic while the idle scan still concluded
from database connections alone — and the auth module's own connections open as
`steadhold_auth`, which the scan deliberately excludes along with every internal
role. For that entire period **a project whose users only signed up and logged in
looked idle**, and would have been paused under them after seven days with nothing
to wake it, because resume-on-request is Phase 5 work. Nothing failed, which is
exactly what the tripwire existed to prevent (**D-375**).

**The signal writes the column the design already had** (**D-374**).
`project_databases.last_active_at` already means "last known active" and the scan
already filters candidates on it, so a project touched by traffic simply stops
being a candidate — and **the scan needed no change at all**. It is fired from
`resolveProject`, which is the one place every data-plane request passes through:
the auth endpoints today, whatever the gateway routes tomorrow.

Postgres rather than Redis, despite this being the hot path, because Redis is a
delivery mechanism and never the truth (D-018) and a lost timestamp fails in the
dangerous direction — it reads as *idle*. The throttle is what keeps it off the
hot path instead: one write per project per minute, against a window measured in
days, so a minute of staleness cannot change the decision. The write is never
awaited and never throws, and losing one releases the memo so the next request
retries rather than waiting out the interval.

**Verification:** 5 unit tests (fifty requests cost one write; the interval
reopens it; projects throttle independently, or a busy project would suppress a
quiet one's only request of the hour; a failed write neither throws nor blocks and
releases the memo; the memo is bounded, since an unbounded map fed by an
unauthenticated endpoint is a leak with a public trigger) and one integration test
that is a **controlled comparison**: two identical projects, both backdated thirty
days, one scan, and the traffic signal the only difference between them — one
stays `ready`, its twin pauses. Breaking the meter makes it fail.

Its first version ran a scan merely to assert the project *was* a candidate, and
that scan paused it — a setup step with the very side effect the test exists to
prevent. The comparison needs no such ordering and proves more.

### P5b — PostgREST, a third container per project · done · 6 tests

The data API itself. PostgREST 12.2.3 (D-011), one container per project (D-101,
a direct connection rather than through the pooler), reloading its schema cache
on `NOTIFY` (D-100) rather than on a timer.

**Five failures in sequence, and the useful thing is that four were invisible to
`docker build`.** An em dash in a config comment killed the process at startup —
the base image's locale is POSIX, so a non-ASCII byte in a file it reads is
`invalid argument`. An apostrophe inside a `${VAR:?message}` default broke the
entrypoint at EOF while the image still built cleanly. `information_schema` was
revoked from `PUBLIC` by P1b's hardening, so PostgREST could not introspect and
answered 503 forever with a message about neither. Granting `USAGE` on the
`steadhold` schema turned out not to grant `EXECUTE` on the function in it, and
the pre-request hook failed the request it was supposed to annotate. And the data
node published no port for the range the placement had picked.

Each was a build that succeeded and a container that would not serve. What made
them tractable was making the failure path print what it already held —
`waitPostgrestHealthy` now dumps PostgREST's own log on timeout, which turned
"unhealthy" into the actual message in one run instead of five.

**Verification:** 6 integration tests against a real container — the identity
pipeline end to end (anon sees nothing, `authenticated` sees only its own rows,
`service_role` bypasses), the schema-cache reload firing on DDL, the pre-request
hook stamping the request id into `application_name`, and the container surviving
a pause/resume cycle with its port intact.

### P5c — the gateway · done · 13 unit + 5 integration

Hops 3–7 of the request pipeline: resolve the project, validate the apikey,
apply three rate-limit layers, proxy to that project's PostgREST. The mandate is
a **negative** one, and stating it that way is the point — every future feature
will want to violate it. No query parsing, no control-plane query on the hot
path, no response-body inspection, no customer data. The hot path is a map
lookup, one ES256 verification, three Redis buckets and a proxy.

**The routing table is in memory because of blast radius, not speed** (**D-376**).
A gateway that queried per request would make every customer's data API depend on
the control plane being up, so one control-plane incident would take out the
fleet. In memory, a control-plane outage costs *changes* — new projects,
rotations, resumes — and nothing already running. The staleness that buys is safe
per field: status is the one that matters and its window matches the cache and
retry windows already in front of it; keys are stale in the safe direction by
construction, since P4h publishes before it signs precisely so verifiers may lag;
ports change only on a re-placement, which cannot happen while a project runs.

**The order of the admission checks is the design** (**D-377**), and each is a
denial of service on somebody else if it moves. Resolution before key validation,
because a key cannot be checked against a project not yet identified. Key
validation before rate limiting, so an unauthenticated flood cannot spend a valid
key's budget. Rate limiting before the paused check, so a burst at a paused
project cannot enqueue one resume per request.

The `Host` header is an unverified assertion — anyone can send any Host — so
resolving it is only half the job: the apikey's `ref` claim must match the
resolved project, and *that* is what turns an assertion into an identity. Neither
half is sufficient alone. Auto-resume goes through the control plane's own
lifecycle path rather than pushing a job (**D-378**), because that path owns the
`paused → resuming` transition, the in-flight dedupe and the audit row — and the
burst arriving the instant a paused project is touched is exactly what the dedupe
is for.

**Verified live, and the live check found what the tests could not.** The e2e
suite builds its routing table by hand, so `createRoutingTable`'s SQL had never
run against the real schema — a column typo there would have passed every test
and failed only in production. Running it against the staging control plane
proved the query, and turned up that a failing `activeKey` was caught silently:
an unreachable KEK and a project with no key were indistinguishable, and both
present as *every request 401ing with nothing anywhere saying why*. It now
reports through `onError` while still not failing the fleet's refresh over one
project (**D-379**). Booting the wired `main.ts` against staging confirmed the
rest: an unknown host 404s, a real ref reaches hop 4, `evil-steadhold.test` is
refused by the suffix check in the production wiring and not merely in a unit
test, and the control plane is untouched.

**Verification:** 13 unit tests (a forged key, a key naming another project, a
user token in the apikey slot, a revoked key, a paused project answering 503 while
still recording traffic and enqueueing exactly one resume per *admitted* request,
and the routing table reporting rather than swallowing a key it cannot load) plus
5 against a real PostgREST — a real hop, D-109's injection, the verbatim body,
the query string reaching a gateway that deliberately cannot parse it, and the
request id arriving in `application_name` through both hops.

One assertion was wrong and instructive: it expected a `PGRST` code for an unknown
relation and got the Postgres SQLSTATE `42P01`. The contract is "PGRST/SQLSTATE" —
both are upstream's to choose and neither is ours to normalise — so it now accepts
either, which is what the doc actually promises.

**A process gap worth recording:** P5b was committed without its STATUS and
README entries, which rule 2 of the definition of done exists to prevent. Both
were written afterwards, from the commits and the code. Nothing was lost, but the
rule was broken and the entry says so rather than reading as though it were
written at the time.

### CI repair after P5b — one omission, and three faults it uncovered · 8/8 green

P5b went in red and stayed red for four pushes. The omission was small; what it
exposed was not.

**The omission:** P5b made `steadhold/postgrest:12.2` mandatory and never taught
either workflow to build it. `seed-images` refused to run, which is the guard
doing its job — the failure landed on the commit that added the requirement
rather than as a timeout deep inside provisioning.

**Its remediation line was wrong.** The guard's `case` matched `*postgres*`
before `*postgrest*`, and "postgrest" contains "postgres", so the specific arm
was dead code and every run named the wrong image and the wrong directory. A
shell `case` is first-match; the looser pattern must never come first.

**The image was not the same image on every architecture.** The build then failed
on CI with `unable to find user root: no matching entries in passwd file`, from a
Dockerfile that builds cleanly on an arm64 laptop. The official PostgREST image is
Ubuntu-based on arm64 and a *single scratch layer* on amd64 — no shell, no
`/etc/passwd`, no apt — so `USER root` names a user that does not exist. The
binary is now copied onto a base we choose, which is portable, gives the
entrypoint its shell and `gosu`, and makes the uid it drops to ours rather than
the base image's. `RUN postgrest --version` inside the build proves the binary
runs there instead of deferring that to a container that will not start.

**And a dormant ordering dependency surfaced on an unrelated commit.** Vitest
shards by file, so *adding* `postgrest.e2e.test.ts` reshuffled which files share a
shard. Two files had been inheriting node state instead of declaring it:
`registerNode` is a heartbeat and deliberately does not reset `status` — one that
did would silently revert an operator draining a node — so a node cordoned by
`placement.e2e` (which cordons with no WHERE clause) stayed cordoned for every
file that ran after it. Fixing the status then moved the same five failures onto
`disk_reserved_gb`, still at 190 of 200 GB: **normalising one dimension of a
shared fixture is not normalising it.**

**A project is three containers now**, and T8's exact-count assertion still said
two. It stays exact rather than becoming a floor, for the same reason the idle
scan's tripwire is exact: a fourth container should have to come here and say what
it means for drift.

**Verification:** every fix reproduced before it was made. The cordoned-node
failure was reproduced by cordoning the staging nodes by hand; the disk failure by
inserting a node at 7000/8192 MB and 190/200 GB, which fails all five with CI's
exact message on the old code and passes 5/5 on the new one. The image was built
for both `linux/amd64` and `linux/arm64`, and the 11-test live suite re-run
against the rebuilt image since its base changed underneath it. CI is 8/8.

Two things earned their keep. The placement error printed the node, both
dimensions, the ceiling and the percentage — one run to locate instead of a
bisect. And `seed-images` refusing to start is why a missing image was a clear
red rather than a mystery hang. Both are §5 rules paying for themselves.

### P5e — the tenant-isolation suite · done · 38 tests · release-blocking

Proposal §74 — "create projects A and B, prove A cannot touch B, run it
continuously" — is the single most important test in this repository, because
tenant isolation is risk #1. `tests/isolation/` turns that paragraph into 38
executable rows, and **it is a release gate from today** (D-162: retrofitting a
security gate never happens under launch pressure).

**The suite found four real faults, two of them in controls that had never been
built.** That is the whole argument for building it now rather than at launch.

| Row | What it found |
|---|---|
| API-9 | `kid` was **decorative**. The verifier looped over every published key and ignored the header, so a token naming a kid that exists nowhere was accepted (**D-382**) |
| API-5 | A claim naming another project was folded into 401. It is now **403**, and the signature is checked *before* the ref so the distinction cannot become an oracle (**D-383**) |
| NET-4 | **Egress default-deny had never been built.** The open internet was reachable from every project container — exfiltration and mining both need outbound reach, and both had it. Not recorded as a gap anywhere (**D-384**) |
| NET-3 | And with the FORWARD rules in place, the **Engine API was still reachable** at the default gateway: the node's own bridge address is a *local* destination, so it is INPUT, not FORWARD. Blocking the world while leaving the fleet's control surface open on the near side was the worse of the two holes |

Neither of the last two permitted a cross-tenant read today, and neither would
have been found by any test that asks the platform what it intends rather than
what it does.

**The rule that shapes the harness** (**D-380**): assertions may use only the
surfaces an attacker has — HTTP, the pooler port, a psql session opened with the
fixture's own advertised credentials. No test reads a container log or host
firewall state to decide whether an attack was blocked, because a test that
*observes* through privilege proves the rule exists rather than that it works.
Privileged setup is legal and confined to the fixture phase: seeding the canary
needs the superuser, and minting a forged token needs the project's private key.

That minting is the harness's sharpest tool. An attacker cannot sign, so a
correctly-signed forgery that is *still* refused shows the refusal rests on the
design rather than on the attacker's inability to sign. API-4 and API-5 rewrite a
claim to name another project and re-sign it with the real key; API-7 is the
asymmetric-to-symmetric confusion, signing HS256 with a public key as the HMAC
secret, which defeats any verifier that picks its algorithm from the token's own
header.

**Fixtures are provisioned by the real saga, every step in order** (**D-381**) —
provisioning is part of what the suite claims is isolation-safe, so a fixture
assembled by hand would test a platform that does not exist. Two projects, six
containers, about 15 seconds, which is what makes running this per deploy
affordable. They land on one node because co-tenancy is the interesting case
(D-084): two projects on separate machines are isolated by the machines.

**Every deny assertion has a positive control**, because this suite's real failure
mode is passing for the wrong reason. A container with no networking at all
satisfies every network row, so A must still reach its own database. A pooler that
refuses everyone satisfies DB-1, so A's own pooler must still serve. The canaries
assert an exact *set* of ids, never a count — a policy returning the wrong three
rows passes any count assertion, and "the user saw someone else's row" is the
entire failure mode.

**Three tests were wrong before they were right, and each looked green or looked
like a platform bug:**

- The FORCE canary first read the seeded table as `developer` and passed on
  *permission denied* — a missing grant, which never reaches RLS at all. FORCE
  could have been off the whole time.
- Rewritten to use a table the role owns, it then asserted FORCE was applied and
  failed. That was the **test** being wrong: **D-191** supersedes the FORCE half of
  D-083 deliberately, because FORCE affects the owner — the customer's own role —
  and would break the first `INSERT` after the first `CREATE TABLE` on every ORM.
  The decision log wins (CLAUDE.md), so the test now pins the *decided* posture in
  both directions, including that the owner **can** read its own table — the half a
  future change back to FORCE would break.
- NET-3 read an **empty string** for the node's address twice (no iproute2 in the
  image; then `strtonum`, a gawk extension, against the image's mawk). Either would
  have made the reachability check probe nothing while reporting green. Only
  asserting the *input* to the check caught it.

**The gate** (**D-385**) is its own job, never sharded, and runs without
`--passWithNoTests`: a shard that silently holds no files reports green, and this
is the one suite where "no tests ran" and "no attack succeeded" must never look
alike. A CI guard now also fails if any `*.isolation.test.ts` is written outside
`tests/isolation/` — such a file would be a release gate nothing runs, which is
worse than a missing test because the gate still reports green. The guard was
proven by planting a stray file.

**Verification:** 38/38 against two genuinely provisioned projects — 10 API rows,
11 canaries, 9 database rows, 8 network rows. The egress hardening was
regression-checked against the suites it could plausibly have broken: the object
store is still reachable from a project network, and backup (8), postgrest (11),
restore and wal (11) pass unchanged.

**Not built, and honestly so:** the storage rows ST-1..4 need Phase 6 — there is
no storage service to attack yet. The cross-node variant D-084 also wants cannot
run on a single-node staging substitute. The persistent prod canaries (daily,
non-destructive) need a prod fleet. All three are in §8 rather than quietly
dropped from the matrix.

### P5d — the RLS posture and the policy cookbook, through the gateway · done · 15 tests

Phase 5's exit criterion — *the full filter/embed/RPC surface works through the
gateway against a seeded project* — plus the posture and the cookbook that make
the surface safe to expose. Everything runs through the gateway rather than in
psql, because a policy that works in psql and not through the API is the failure
that matters: the claims arrive as a GUC PostgREST sets, and a policy is only
correct if it reads them the way the request delivers them.

**The step's largest finding is that the entire cookbook was impossible to
write** (**D-387**). Every pattern calls `auth.uid()`; resolving that inside a
`CREATE POLICY` needs USAGE on schema `auth`; the image granted it to `anon`,
`authenticated` and `service_role` — the roles a *request* runs as — and to
nobody else. The role a customer runs migrations as had none of it, so the first
policy anyone copied out of the docs failed with `permission denied for schema
auth`. Confirmed on a saga-provisioned project, not only in the test's own
container: Phase 5's whole subject was unusable from the connection string Phase 2
hands out. `create schema app` failed too, which put the SECURITY DEFINER pattern
out of reach as well.

Neither grant widens exposure. USAGE on a schema is the right to *name* things in
it, never to read them — `auth.users`, `auth.refresh_tokens` and
`auth.one_time_tokens` stay unreadable, and the isolation suite's DB-3 now
asserts that at the table rather than at the schema. That is the boundary drawn
more precisely rather than moved, and the exact-message assertion is the only
reason the change was visible at all.

**Cookbook pattern 5 could not work through the API, as written** (**D-386**). It
filtered tombstones in the SELECT policy; PostgREST writes with `RETURNING`, so
Postgres applies the SELECT policy to the *new* row, and the whole purpose of the
tombstoning UPDATE is to move that row out of the read policy's reach. It failed
on the one operation it exists to perform, and no request shape avoided it —
`return=minimal`, `return=representation` and `count=none` were each tried. The
doc now states the general rule (**an UPDATE may not move a row outside its own
SELECT policy**) and hides tombstones in a `security_invoker` view. That keyword
is the load-bearing token: without it the view runs as its owner and quietly
becomes the bypass the policies exist to prevent.

**The posture is asserted per role, because default-deny is three different
mechanisms** — a privilege error for `anon` (no table grant at all, D-108), `200
[]` for `authenticated` (grant held, zero policies), and full rows for
`service_role` (BYPASSRLS by attribute, D-082, which is why it works on a table
nobody wrote a policy for). A test that only checked "nothing leaked" would pass
with any two of them broken. The grants come from the *customer role's own*
default privileges, which is a trap worth pinning: `ALTER DEFAULT PRIVILEGES` is
per creating role, so the image's settings cover platform migrations and nothing
a customer does.

**Three tests were wrong first, and two of them were passing.** The InitPlan test
put `(select auth.uid())` in the query's own WHERE clause — an InitPlan duly
appeared, proving a fact about scalar subqueries rather than anything about
*policy* predicates, and against tables with no policies at all, whose plans were
`One-Time Filter: false` and short-circuited before any predicate mattered. The
index test gave every row the same owner, so the planner kept choosing a
sequential scan *correctly* (an index matching every row is worse than none) and
the test read that as the index having no effect. And `toContain` on an array is
exact element equality, so the `search_path` assertion never matched what
Postgres stores.

**Verification:** 15/15 — the posture per role, all five cookbook patterns plus
the SECURITY DEFINER helper run verbatim, the InitPlan and indexing claims read
off real plans, and the exit criterion's surface: filters (`eq`, `gt`, `like`,
`in`, `or`), ordering, limit/offset, Range headers, embeds in both directions,
and RPC by POST and GET. The embed tests are the security-relevant ones — every
child row is readable and only the parent is policy-scoped, so an embed that
ignored the parent's policy would surface the other user's name; it returns null.
Isolation stayed green at 39/39, and credentials + auth-schema (34) unchanged.

### P5f — the latency budget under k6 · done · budget met, one real regression fixed

Phase 5's third exit criterion. `tests/load/` holds the k6 scripts, `pnpm --filter
@steadhold/worker load` stands up the real thing — the real API process with the
gateway wired, a project provisioned by the real saga, 4000 rows behind a real
RLS policy — and it is the nightly's fifth drill.

**Result:** read **p50 6.79 ms** against a 20 ms budget and **p99 62 ms** against
100 ms, zero errors and 100% RLS correctness across ~15,500 requests. The origin
budget holds.

**The measurement found a real regression, and the harness's first version found
nothing at all.** Both are worth recording, because the second is the more
instructive.

**The harness reported a beautiful 0.9 ms p50 across 47,351 requests — every one
of them a 403.** It had set `SH_JWT_ISSUER` to a flat `https://steadhold.test`, so
every project's keys were minted under an issuer no project's gateway accepts.
Rejections are fast. **A load test that does not check its own responses measures
the error path and reports it as the happy path, and the faster the error the
better the result looks.** Nothing is measured now until one request per arm is
proven correct — right status, rows actually returned, none of them another
owner's — and k6's own failed *checks* are listed as run failures ahead of any
latency number, because a check failure invalidates every number above it.

**The regression: the rate limiter cost six Redis round-trips per request**
(**D-389**). Each `hit()` issued `INCR` then `TTL` as separate awaits, and the
gateway makes three checks per request for D-033's layers — 2.06 ms of a measured
6.5 ms overhead against a budget of ~1.5 ms. It is now one round-trip of three
commands, with `EXPIRE ... NX` preserving the semantics that matter: the window
starts at the first attempt and does not slide, or the ceiling would never be
reached. Verified live against the staging Redis. Overhead at 10 VUs fell from
6.50 ms to 4.60 ms.

The three checks **stay sequential** even though pipelining them saves another
~0.9 ms, and that was measured before it was rejected: fired together, every
bucket counts a request an earlier bucket already refused, so a flood from one IP
burns the *project's* ceiling on its way to being rejected and denies everyone
else. Short-circuiting is what stops a rate limit from being an amplifier.

**Which numbers block is the design** (**D-388**, resolving **OQ-151**). Absolute
latency is a property of the machine, and a threshold that pretends otherwise
buys a red build whenever the runner is busy — which is how a performance gate
gets muted, leaving nothing. So the error rate, the RLS-correctness rate and the
gateway's *added* cost block anywhere; the absolute p50/p99 are reported unless
`SH_LOAD_STRICT=1` says the hardware is production-shaped. The added cost is the
only figure in the budget that travels between machines: two arms, same box, same
interleaved run, so a noisy neighbour hits both equally.

**And it is measured at 1 VU** (**D-390**). At concurrency the gateway is one
single-threaded Node process while PostgREST is thread-pooled, so the latency gap
includes event-loop queuing — real for a client, but not the per-request cost the
doc's figure describes, and enforcing it would enforce a property of the load
generator. Serial 2.91 ms, concurrent 4.60 ms, both printed.

**Two traps, documented where they bit.** Node's `fetch` treats `Host` as a
forbidden header and silently drops it, so every preflight request arrived
announcing `127.0.0.1:8097` and was answered `project_not_found` — while k6, a Go
program, sent what it was told and resolved the project fine. A guard failing
where the thing it guards succeeds is the most confusing arrangement available.
And the A/B first shared one path across both arms: the gateway strips `/rest/v1`
before proxying, so the direct arm requested a path PostgREST does not have, and
a 404 is fast — the run reported a 6 ms "overhead" that was the difference
between a real query and a miss.

**Honest limits.** Cloudflare and the client's own network are the budget's top
two hops and neither exists here; Caddy is not in the staging stack either, so
"origin" means the gateway's socket rather than Caddy's — one loopback hop short,
in the direction that flatters us. The doc's ~1.5 ms gateway figure is not met at
2.91 ms on a laptop whose Redis round-trips are Docker-forwarded, and whether it
is achievable at all is now **OQ-184** rather than a silent miss.

### P5g — the Phase 5 demo · done · Phase 5 complete

The proposal's §80 five-minute flow minus storage: a table and its policies via
SQL, an insert as `service_role`, and an authenticated user reading only their own
rows. `./scripts/data-demo.sh` stands it up; `demo/data/` is the page.

**The split between the script and the page is the demo.** The script plays the
customer's backend — it applies the migration over the project's own
`DATABASE_URL`, printing the SQL, and inserts the seed rows with the
`service_role` key. The page plays the frontend and holds nothing but the anon
key. That is not staging convenience: `service_role` carries `BYPASSRLS`, so a
page holding one would show every visitor every user's notes.

**`serve.py` is the edge, and it exists because of a real constraint.** The
gateway resolves a project from the `Host` header, and a browser is *forbidden*
from setting `Host` — so something in front of the gateway must supply it. In
production that is Cloudflare and Caddy; here it is forty lines of Python
forwarding two path prefixes to one fixed upstream. It also puts the page and the
API on one origin, which takes CORS out of a demo whose subject is RLS.

**The script's first version reached past a boundary this repository asserts
elsewhere.** It read the demo users' ids from `auth.users` over the project's
DATABASE_URL and got `permission denied for table users` — correctly, and the
isolation suite's DB-3 is the test that says so. It reads them from each user's
own access token now: `sub` is right there, it needs no privilege, and it is what
a real backend does.

**Verified in a browser, every step:** Alice sees only her rows and Bob only his
from a byte-identical request; the anon key alone gets `401 permission denied for
table notes` (D-108's asymmetry); posting a row owned by the other user gets `403
new row violates row-level security policy` (the `WITH CHECK` half); the same post
owned by *you* returns `201`, which is the control proving the refusal was the
policy and not a broken endpoint.

The browser also caught the page making a small false claim: it reported "N of M
rows" using a total the script had captured with `service_role` before the page
loaded, so after step 5 writes a row both that fraction and "the other M − N"
were wrong. It now asserts only what it can verify from where it stands — who
owns what came back.

### Phase 5 — exit criteria, honestly

| Criterion | Status |
|---|---|
| The full filter/embed/RPC surface works through the gateway against a seeded project | **met** — P5d, 15 tests: filters, `or=`, ordering, limit/offset, Range headers, embeds both directions, RPC by POST and GET |
| The isolation suite passes and is release-blocking | **met** — P5e, 39 tests, its own CI job, `--passWithNoTests` deliberately absent. The §74 cross-tenant test runs per deploy rather than "continuously in staging": hourly needs a scheduler this repo does not have yet |
| Latency budget met under k6 smoke load | **met for the origin SLO** — P5f: read p50 6.79 ms against 20 ms, p99 62 ms against 100 ms. The doc's ~1.5 ms *gateway overhead* figure is **not** met at 2.91 ms on this hardware (OQ-184) |
| A request to a paused project resumes it per the specified UX | **met** — P5c: 503 + `Retry-After: 5` + `project_resuming`, one resume enqueued per admitted request, through the control plane's lifecycle path (D-378) |

Four criteria, three met outright and one met in the half that staging can
measure. Phase 5 also carries the storage rows of the isolation matrix (ST-1..4),
the cross-node isolation variant and the prod canaries as named gaps rather than
quiet omissions — all three need something a single-node Docker substitute does
not have.

## 4g. Phase 6 — storage

### P6a — the `storage` schema in every project database · done · 9 tests

Object metadata lives in the project's own Postgres (D-017), which is
load-bearing twice: RLS on these tables **is** the file-permission system — there
is no second ACL engine anywhere — and `steadhold export` carries a customer's
file inventory out with a plain `pg_dump`. Installed at initdb like the `auth`
schema, for the same reasons: fleet-wide, identical per project, and the one
moment no client can observe a half-created schema.

**Running the documented policies as a customer found two ways they could not
work, and both failed silently.**

The first is the one that matters (**D-392**): every documented object policy
resolved a bucket name with `(SELECT id FROM storage.buckets WHERE name = …)`,
and a policy's subselect **runs as the caller** — against a table that is
RLS-enabled with no policies. So it returned NULL for `anon` and `authenticated`,
every policy built on it was false for every row, and the symptom was not an
error: reads came back empty and writes affected *zero rows without complaint*. A
customer following this repository's own documentation would have installed a
policy that looked correct and governed nothing. Fixed with a SECURITY DEFINER
`storage.bucket_id(name)` — the same fix, for the same reason, that P5d's RLS
cookbook already uses for a policy needing to read a membership table the caller
cannot.

The second: **pattern 3 was incomplete.** It gates a bucket on the customer's
`org_members`, read by a subselect that also runs as the caller — and the event
trigger puts RLS on that table at creation. With no policy on it the caller sees
no memberships, so the bucket was closed to everyone. The doc now carries the
missing policy and points at the cookbook's helper for large memberships.

**The tables belong to the customer** (**D-393**), because only a table's owner
may create a policy on it. That is the opposite call from the `auth` schema and
deliberately so: those tables hold password hashes no customer role may read,
these hold the customer's own file inventory they are expected to govern.
`storage.usage` stays with the platform — a customer who owned it could edit
their way to unlimited quota — and so does the schema, so it cannot be dropped
from under the service. **Schema USAGE had to come with ownership, which is P5d's
lesson repeating inside one phase**: owning a table is useless without the right
to reach the schema it lives in, and the error was the same
`permission denied for schema …`.

**Grants reach `anon` too** (**D-391**), departing from D-108's asymmetry. D-108
protects *customer* tables a customer can `GRANT` on; this is platform DDL whose
documented way to open a bucket is a policy naming `TO anon`, and withholding the
grant turns every such example into a privilege error. Default-deny is unaffected
— RLS is on with zero policies either way.

Two smaller decisions worth their lines. The **path constraint lives in the
column**, not only in the service: object keys are assembled from the
authenticated project ref plus this name, so a name containing `..` is the one
input that could climb out of the prefix, and a service-only check is one
refactor from being skipped. And the **quota trigger is SECURITY DEFINER**,
because it fires as whoever inserted the object and that role has no business
writing the usage table; its read grant goes to `service_role` alone and is not
optional, since the service checks quota before accepting a byte — the first
version revoked everything and granted nobody, which would have failed every
upload on a permission error.

**The harness was wrong once, instructively:** it had the customer's role
`SET ROLE authenticated` and failed with `permission denied to set role` —
correctly, because the isolation suite's DB-3 forbids exactly that. It
impersonates through `authenticator` now, the role that legitimately holds that
power and the one the storage service will connect as.

**Verification:** 9/9 — the schema arriving closed, all three documented patterns
run verbatim by a customer, the avatars own-path case (this phase's first exit
criterion), quota tracked across insert/overwrite/delete, a customer unable to
edit their own quota row, and path traversal refused by the constraint while
`v1.2/photo..png` is accepted. Plus auth-schema, credentials and the RLS cookbook
(49) unchanged.

### P6b — the storage module, and bucket CRUD · done · 9 tests

`/storage/v1/*` as a module of the data-plane monolith (D-121), structured like
auth: its own routes, its own boundary, splittable later if bandwidth profiles
demand it.

**There is no object-store call anywhere in this step, and that is the
demonstration.** Every route is a metadata operation, so every one is a single
statement run *as the caller* inside a transaction with `SET LOCAL ROLE` and
their claims in place. The customer's policies decide; the storage service holds
no ACL engine at all, and there is no second place where permissions could
disagree with them.

**Storage connects as `authenticator`, not as a role of its own** — the switching
role, NOINHERIT, able to do nothing as itself. That is not a detail: storage
authorization *is* RLS on the metadata tables, and RLS can only decide for a role
it can see. A module with its own role would have to reimplement the customer's
policies to decide anything, which is the design being avoided. The credential
joins `ProjectContext` in the same parallel fetch as the signing keys, and is
optional there — a project predating the role model gets a 503 naming the reason
rather than silently running as something else.

`SET LOCAL` and `set_config(..., true)` rather than their session-wide forms,
because a `SET ROLE` outliving its transaction would leak one caller's identity
into whoever got the connection next. On a pooled port that is a cross-user
authorization bug, not an untidiness. The role name is matched against a closed
set before it reaches SQL, since `SET ROLE` cannot be parameterised — a literal
match rather than escaping is the difference between "cannot be injected" and "is
escaped correctly", and only the first survives someone later taking a role name
from a claim.

Three smaller calls, each in the code with its reason. A refusal gets one meaning
in one place, because Postgres reports a blocked *write* as an error and a
blocked *read* as an empty result. `GET /bucket/:name` answers **404 rather than
403** for a bucket the caller cannot see — "not yours" and "not there" are the
same answer, or the endpoint is a probe for which buckets exist. And bucket
deletion checks emptiness inside the deleting transaction *as the caller*, so an
object they cannot see still blocks them: refusing over a row you may not know
about is an inconvenience, while succeeding would strand somebody else's bytes
with no row left to sweep them by.

Storage error codes are lowercase like auth's, for the same reason (D-317): a
client branches on them. `file_size_limit_exceeded` and `storage_quota_exceeded`
stay separate because one means *this file* is too big and a smaller one would
work, while the other means the project is full and none will.

**Verification:** 9/9 against a saga-provisioned project. The sequence is the
argument — `service_role` creates a bucket and sees it, `anon` gets `200 []`
because it holds the grant and no policy, then the customer writes one policy and
the same request returns it. Plus: an anon key with a user token creates where the
same key alone is refused (the difference is the token and nothing else), a
broken token is refused rather than downgraded to anonymous, PATCH moves only
what was sent, and a non-empty bucket is a 409.

### P6c — the proxied object path · done · 17 unit + 15 integration

D-122's ≤ 50 MB half: upload, download, info, list, delete and batch delete,
with the bytes going through the service so size and content can be enforced
inline.

**The two orderings are the entire consistency model** (D-124). Upload writes the
object first and then the row; delete removes the row first and then the object.
Postgres and the object store share no transaction, so the orderings *are* the
guarantee, and the invariant they buy is that a metadata row never references
bytes that do not exist. A row without bytes is a visible 500 and a false quota
charge; bytes without a row are invisible garbage. Both failure directions cost
money, never correctness — which is why the sweep (P6f) is a requirement rather
than a nicety. The RLS check always precedes the bytes, and when a row is
refused *after* an object is written the object is deleted immediately, which the
suite asserts against the store — otherwise "best effort" quietly means "never".

**Key construction is where project isolation in object storage lives, and
nowhere else.** One bucket per region with projects as key prefixes (D-120) means
the store draws no boundary between customers; the only thing that does is
deriving `projects/<ref>/` from the authenticated context. Percent-encoded
separators are refused *unparsed*, because a client sending `a%2f..%2fb` is
betting on something downstream decoding after the check — refusing the encoded
form is the only version that does not depend on guessing how many decode passes
the path will see. Half the tests assert the opposite direction: `v1.2/photo..png`,
spaces and Unicode must be **accepted**, or the check is a bug wearing security's
clothes.

**Two Fastify scopes, split by body type** (**D-395**), and that split cost two
rounds of debugging. Uploads take bytes of any content type — including the two
Fastify parses by default, so a `.json` or `.txt` upload arrived parsed and the
handler answered "send the object bytes as the request body", which is a baffling
thing to be told when you did. The first correction grouped by *subject* and was
still wrong: `POST /object/list` has a JSON body, so in the bytes scope its
`prefix` read as `undefined` and the endpoint **silently listed the whole
bucket**. Nothing errored. Grouping by body type is the distinction that actually
exists.

**The S3 client became shared and learned to carry bytes.** A hand-written SigV4
client already existed for repo destruction; writing a second would have put two
implementations of one specified algorithm in the repo, whose drift shows up as a
signature that works for one caller and not the other. It moved to
`packages/s3` and gained `putObject`/`getObject`/`headObject`. The substantive
change is that bodies are Buffers: the old `string` signature is right for a
delete's XML and silently wrong for an object, since decoding a PNG to UTF-8
corrupts both the payload hash and the bytes.

Smaller calls, each with its reason in the code: measured size rather than
`Content-Length`, because the header is a claim and the body is the fact; the
*store's* etag in the row, because that is what lets a sweep tell "the bytes this
row describes" from "something overwrote them"; keyset paging rather than OFFSET,
since offset pagination over a bucket being written to means a client missing
files without knowing; a conditional GET answered from the row; 404 rather than
403 for an object a policy hides; and **502 rather than 404** for a row whose
bytes are gone, because reporting a platform fault as "never existed" hides it.

Bucket enforcement config is read through a SECURITY DEFINER function
(**D-394**) — the service needs it for an unauthenticated public-bucket GET,
which has no caller identity at all.

**Verification:** 17 unit tests over the two pure modules (the refused path set,
the accepted path set, the dangerous-signature sniff, the allowlist, the serving
headers) and 15 integration tests against a real object store — bytes verified at
the derived key, the row's etag matching the store's, a refused upload leaving
nothing behind, Range answering 206, and each refusal paired with a control that
succeeds. 24/24 in the storage suite, 202/202 in the api package.

### P6d — signed URLs and public buckets · done · 14 unit + 11 integration

Two ways to reach an object without an API key, and what they have in common is
the interesting part: **neither has a caller to evaluate policies against**
(**D-399**). A signed URL is redeemed by someone who may not be able to
authenticate at all; a public object is fetched by anyone. Running RLS as nobody
would deny every one of them, so the permission question is answered *earlier* —
at minting, under the requester's own policies, and at the moment a bucket is
marked public. That is what "the bucket is the ACL" means in practice, and it is
why minting checks visibility first: without that, the endpoint launders access
("I cannot read this, but here is a link that can").

**The tokens are ours, not the store's presigning**, for three reasons that each
stand alone: they work through the project's own hostname, so a customer's links
do not point at a third party; they survive rotation of the store credential,
which otherwise turns credential hygiene into a customer-visible outage; and they
never expose `projects/<ref>/…`, so the physical key layout stays an
implementation detail rather than appearing in every shared link.

**Deliberately not a JWT** (**D-396**). A JWT names its algorithm in the token,
which is the root of every algorithm-substitution attack; these have no header,
no negotiation, and one algorithm that is never stated on the wire, so it cannot
be talked down. Nothing about a bearer capability in a URL benefits from being
extensible.

**The verification order is the security** (**D-397**): kid, then signature, then
expiry, then target. An unaccepted kid is refused *before any key is derived*,
because the kid is the HKDF salt and honouring an arbitrary one lets the attacker
choose the key. And `verifyToken` takes the request's target rather than handing
the payload back, because a signature proves the token is ours while only that
comparison proves it is for *this* object — the isolation matrix's ST-2 is a valid
signature with the path swapped, and it is refused.

The master secret is created **lazily** (**D-398**), which is race-safe for a
precise reason: `put` is `ON CONFLICT DO NOTHING`, so two requests racing to
create it produce one secret — first writer wins, loser reads it back. `replace`
would have been the bug, invalidating every URL signed a moment earlier. Lazy
also means projects provisioned before this step are not permanently unable to
sign.

Every refusal on the redeem path returns **one status and one message**. Expired,
forged, wrong object and unknown kid all answer `403 That signed URL is not
valid.`, and the distinction goes to the logs — handing it to the holder of a bad
token turns the endpoint into an oracle for which objects exist and when links
expire. A private bucket on the public path answers **404, not 403**, so it does
not confirm its own existence to a prober.

The public path resolves its project from the routed **Host**, never from
anything the client chose — a `?ref=` parameter would make it a way to read any
project's public buckets from any hostname. Resolution is cached in process for
30 seconds, the doc's own figure: this path has no apikey, so identifying a
project means a control-plane query and D-051 wants none on a read path. The cost
is the documented one, and it is documented: a `public` flip takes up to 30 s to
propagate.

Revocability is stated rather than left to be discovered. A signed URL **cannot**
be revoked before `exp` short of rotating the project's kid, which kills every
outstanding URL at once — so one hour by default, seven days hard maximum, and
the response body itself carries `revocable: false`.

**Verification:** 14 unit tests, every one an attack that costs nothing to
attempt because the token travels in a URL — swapped path, swapped bucket,
swapped project, a neighbour's signature, edited payload, edited expiry,
attacker-chosen kid, a short signature that would make `timingSafeEqual` throw,
and seven shapes of garbage that must refuse rather than 500. Plus 11 integration
tests: redemption with no apikey at all, the ST-2 path swap refused with a body
that reveals nothing, per-object RLS skipped on the public path while the
authenticated path for the same object still denies `anon`, a lookalike domain
resolving to nothing, and a year-long lifetime clamped to seven days.

### P6e — presigned direct upload · done · 8 tests

D-122's other half: objects above 50 MB bypass the service entirely, because
every proxied byte costs a node's ingress twice. The price is that **nothing here
watches the upload happen**, and the intent row is what makes that gap
recoverable — it records exactly what was authorised, so completion can be
checked against it and an abandoned upload can be swept (D-124's F4).

**Authorization is a trial `INSERT`, rolled back** (**D-400**). The doc asks for
"an RLS check on the intended path", and the only way to ask Postgres whether
*this* caller may create *this* row is to try — the customer's `WITH CHECK` can
depend on the path, the bucket, their claims or a membership table, so no
expression of the question avoids running their policy. Re-implementing it in
TypeScript would create two authorities that can disagree; deferring the check to
completion would let a client upload gigabytes before being told no. The savepoint
rollback takes the usage trigger's effect with it, which the tests assert against
both the object row and the project's usage total — a probe that leaked into the
quota would bill a customer for an upload that never happened.

**The cap is a signed `content-length`, not a range** (**D-401**), which departs
from the doc's wording deliberately: `content-length-range` is a POST-policy
construct for browser form uploads, while for a presigned PUT the exact-length
signature is the stronger equivalent — the store refuses a mismatch before a byte
of ours is involved. `content-type` is signed beside it, so a leaked URL cannot be
repurposed for a different file shape. `UNSIGNED-PAYLOAD` is unavoidable, since
the bytes do not exist when the URL is signed — and that is exactly why
completion trusts nothing the client says.

**Completion re-reads the truth from the store** (**D-402**): true size, true
etag. The size is checked against the intent even though the signed
`content-length` should make a mismatch impossible, because an impossible state
reached anyway means the assumption was wrong, and finalising on it would write a
false number into the customer's quota. The content sniff can only happen here —
no earlier moment had bytes to inspect — and it reads the first 512 bytes by
*range*, since every signature lives in the first twelve and fetching a 4 GB
video to see its header would reintroduce the cost this path exists to avoid. A
refusal deletes the object immediately rather than deferring to the sweep: the
service knows now that those bytes are unwanted.

The row is finalised as `service_role` using the *intent's* owner rather than the
completing caller — P6d's pattern again, since the authorisation decision was made
when the URL was signed, and the row should record whose upload it was rather than
who pressed the button. The intent is deleted after the row exists, so a crash
between them leaves an intent whose object already has a row, which the sweep
reads as complete and drops. An expired intent answers 410 rather than
finalising: the bytes may be there, but the authorisation behind them has lapsed.

**Verification:** 8 tests, the first being the whole path — sign, `PUT` straight
at the object store over HTTPS from the test process, complete, and then download
the result byte-identically through the ordinary authenticated route, which is
what proves the two halves produced one coherent object rather than a row and
some bytes that merely coexist. Plus: a wrong length and a wrong content type both
refused *by the store*; completing before uploading is a 409 with no row; a
`image/png` declaration over a Windows binary caught at completion with the bytes
deleted; signing refused before a URL exists when the policy would refuse the row;
and the trial insert leaving nothing behind in either the table or the quota.

### P6f — the reconciliation sweep and the quota true-up · done · 11 tests · two exit criteria

The other half of D-124. The write orderings make every two-system failure land
in the same harmless direction — bytes with no row, which nothing can see — and
that is a deliberate trade of correctness for cost. **The sweep is what stops
"harmless" from becoming "we pay for it forever."** The orderings plus this file
are the entire consistency model.

**Four passes, separate because they fail differently.** An unreachable store must
stop orphan collection *without* letting the true-up conclude a project holds
nothing and zero a customer's usage (**D-405**).

1. **Orphans** — no row, no live intent, older than the grace window.
2. **Expired intents** (F4) — object first, then the intent, the same ordering
   discipline as a delete: dropping the intent first would leave bytes nothing
   knows about, which is an orphan this pass had the information to avoid making.
3. **Rows with no bytes** — quarantined and alerted, **never deleted**
   (**D-403**).
4. **Quota true-up** — after the deletions, so the total reflects what is left.

**A live upload intent protects its key** as well as the grace window
(**D-404**). The window covers an upload whose row is milliseconds away; it does
not cover a presigned upload whose bytes arrived quickly and whose completion has
not run, which can be older than any window while still legitimately in flight.

**Rows with no bytes are the direction the orderings make impossible**, so
finding one means an assumption broke — and the response is to preserve the
evidence, not tidy it away. Auto-deleting the row would erase both the platform
fault and a file the customer believes they have. The queue lives in the control
plane because an operator hunting faults should not visit two hundred project
databases; a repeat sighting raises a count rather than duplicating the row.

The sweep connects as `postgres` rather than switching into an API role — the one
place in storage where RLS is deliberately not the authority, and safe because
nothing here returns data to a caller: it compares two inventories and deletes
from one of them. A project that fails is recorded and the run continues, because
aborting lets one unreachable node stop garbage collection for the whole fleet.

It logs **every** run rather than only failures: "the sweep ran and found
nothing" is what tells an operator the system is healthy, and a sweep that speaks
up only on trouble is indistinguishable from one that is not running. With no
object store configured it says so loudly, since a deployment whose sweep never
runs accumulates cost in silence.

**Both exit criteria, verified.** The crashes are injected through the raw
object-store client rather than by killing a process, because the states under
test are precisely the ones the API *cannot* produce — which is the point of the
orderings. Bytes with no row are collected with the reclaimed total reported; a
row with no bytes is quarantined with the row intact and the seen-count rising on
a second pass. Convergence is asserted plainly too — a second sweep over a
healthy project finds nothing, because a sweep that always reports deletions is
one nobody can read as a health signal.

**The cap test is the pricing contract in one place:** over quota means uploads
rejected and existing files still serving. The proxied path refuses with 413 and
stores nothing; the presigned path refuses at signing, before a URL exists; reads
keep working; deletes keep working, because a quota that blocked deletion would
be a trap; and an upsert that *shrinks* an object is allowed, since only the delta
counts — refusing it would leave a customer unable to reduce their own usage
through the API they uploaded with.

One fixture is worth a note as a lesson rather than a detail: building the
unreachable project's `project_databases` row from an explicit column list needed
a new column on each attempt and then tripped two *partial* unique indexes that
do not appear in `pg_constraint`. It copies the whole row through a temp table now
and repoints only the ports — shorter, and immune to the next column.

### P6g — the storage isolation rows · done · 13 tests · gate now 52/52

ST-1 through ST-4 of the matrix, which P5e recorded as a named gap because there
was no storage service to attack. There is now, so the gap closes and the release
gate covers all four boundaries rather than three.

**ST-1's premise in the doc does not survive contact with the API, and the tests
say so rather than working around it.** The doc frames it as "A's token against
B's bucket, expect 401" — which assumes the project is named in the request, true
for `/rest/v1` where the Host says which project and the key must match it.
`/storage/v1` identifies the project from the **apikey itself**, so there is no
such thing as pointing A's key at B: the request simply operates on A. The
isolation is therefore *stronger* than a 401 and shows up differently — the same
URL with two different keys returns two different projects' bytes, and neither
ever sees the other's.

The first version of the file asserted 401 and failed. That was the test being
wrong about the mechanism, not the platform being wrong — and the 401 the doc was
reaching for does exist: a **forged key naming the other project**, which is now
its own test.

**The fixture had to be redesigned mid-step for a reason worth keeping.** Both
projects seed their vault under the *same* owner uid — deliberately, since
`auth.uid()` matching is not isolation and two projects can mint the same
subject. But that means "A's path" and "B's path" were the identical string, so a
path-swap test swapped nothing and five assertions passed or failed for reasons
unrelated to what they claimed. Each project now also seeds an object named after
its own ref, existing in exactly one of them, which is what makes a substitution a
substitution.

Every assertion checks the response *body* for the neighbour's seeded content, not
just the status: storage returns bytes, and a status code cannot distinguish
"refused" from "refused after leaking". Every secret embeds its own project's ref
so that check needs no knowledge of which project answered.

The write direction gets its own test because it is the more dangerous one — a
leak reads, a misrouted write *modifies* a neighbour. ST-2 swaps to a path that
exists only in B and fails for two independent reasons (the signature covers the
path; the token names A), and checking both is the point. ST-3 asserts a replayed
URL is refused with the *same message* as a forged one. ST-4 is tested in the
shape that matters — B's own public anon key gets past resolution while A's user
token supplies the identity, and it fails on the signature — then mirrored, so a
token B minted for the same uid legitimately reads B's file, which is what proves
the separation is the project binding rather than the uid.

The suite refuses to run without an object store rather than skipping these rows.
An isolation suite covering three boundaries out of four is a release gate
reporting green over an untested one.

**Verification:** 13/13, and the whole gate at 52/52 across five files.

### P6h — the Phase 6 demo · done · Phase 6 complete

The plan's three items — avatar upload, public URL renders, signed URL expires —
built on Phase 4's flow rather than beside it: a *signed-in user* uploads their
own avatar. That is the only version that shows anything, because the avatars
pattern is entirely about the path carrying the owner's id and the policy
enforcing it.

**The demo found a bug that five green steps had missed** (**D-406**). The quota
check read `storage.usage` directly, and that table is granted to `service_role`
alone — so for a real user the read raised `permission denied` (42501), which the
module maps to 403 with the message *"the project's policies do not allow this
operation."* Every authenticated user's upload failed, blaming a policy that was
correct.

It survived because **every automated upload test used the service_role key.**
P6c, P6e and P6f all uploaded as a backend; the demo was the first caller
anywhere in this codebase to upload as a person, and it failed on the first
click. The comment at that line had even asserted the opposite — that a
non-service caller "simply sees no row" — which was a confident statement about
behaviour nobody had exercised. The missing test now exists: an upload by a user,
plus its refusal in somebody else's folder, plus the presigned path that had the
identical read and the identical bug.

**Verified in a browser, all four steps.** Upload: 201, 8,676 bytes, the store's
own etag, and the image rendered back through the authenticated endpoint — an
`<img src>` cannot carry an apikey, so each avatar is fetched and turned into a
blob URL, which is what a real frontend must do too. The other user's folder:
403 from `WITH CHECK`, with the bytes never stored because the policy is
evaluated before the object store is touched. Public: a 64×64 PNG with no apikey
and no token, `Cache-Control: public, max-age=3600`. Signed URL: 200 immediately
with no credential, 403 six seconds later, worded identically to a forged token.
And signing in as the second user shows the asymmetry the pattern rests on — Bob
sees Alice's avatar (reads are wider than writes) and can only replace his own.

**The demo proxy is now shared** (`demo/proxy.py`), because this was going to be
the third copy of a handler that exists for one reason: a browser is forbidden
from setting `Host`, and both the gateway and the storage service identify a
project from it. It forwards bytes rather than text — this demo uploads a PNG and
renders one back — and sends `cache-control: no-store` on the demos' own files,
which is paid for in debugging time: `config.js` names a specific project and is
regenerated every run, so a cached copy points at a project that may no longer
exist and presents as "sign-in failed (HTTP 401)" on a page whose API answers
perfectly to curl.

Two fixture faults of my own, fixed and worth recording. The `auth.users` insert
ran as the *customer* role and was refused — the boundary working, since DB-3
asserts exactly that, so the fixture moved to the superuser rather than the grant
being widened. And P6f's cap test pinned the usage counter at its ceiling and
never restored it, so every later upload in the file failed with an unrelated
quota error.

### Phase 6 — exit criteria, honestly

| Criterion | Status |
|---|---|
| Policy examples from the docs work as written (avatars own-path case) | **met** — P6a runs all three documented patterns verbatim as a customer, and found two that could not work as written; both were fixed in the docs (D-392). The avatars own-path case is proven in P6a, in the storage suite, and in the browser in P6h |
| Orphan sweep provably converges both failure directions (crash-injected tests) | **met** — P6f, crashes injected through the raw object-store client because the states under test are ones the API cannot produce. Orphans collected; rows-with-no-bytes quarantined rather than deleted (D-403); a second sweep over a healthy project finds nothing |
| Quota enforcement blocks uploads at cap | **met** — P6f, and it is the pricing contract in one test: both upload paths refused at the cap, reads and deletes still working, and a shrinking upsert allowed |

**Demo:** avatar upload, public URL renders, signed URL expires — all three
verified in a real browser (P6h).

Three criteria, three met. Phase 6 also closes the isolation matrix's storage
rows (P6g), which Phase 5 had recorded as a named gap.

## 4h. Brand — the name and the mark

This is not a numbered plan step. It sits between Phase 6 and Phase 7 because the
dashboard cannot be rebuilt against a visual layer that does not exist yet, and the
name had to settle before the repository was rewritten around it.

### The name · Corebase → Steadhold · done · 352 files

`corebase.co` was taken, as were the `.dev`/`.io` pairs around "corebase", and the
name was generic besides — "core" plus "base" names a category, not a position.
**Steadhold** is *stead* (a holding, a place one stands) plus *hold* (to keep; a
stronghold): a backend you own outright rather than rent. **D-407.**

Applied mechanically, in this order, because order is load-bearing (**D-412**):

| From | To | Note |
|---|---|---|
| `corebase.com` | `steadhold.dev` | marketing, dashboard, API |
| `corebase.co` | `steadhold.app` | project subdomains — **a separate apex on purpose** (D-411) |
| `Corebase` / `corebase` / `COREBASE` | `Steadhold` / `steadhold` / `STEADHOLD` | includes `@corebase/*` → `@steadhold/*` and the `corebase.{test,local,managed,role,project,…}` label namespaces |
| `CB_` | `SH_` | 799 environment references |
| `cb-` | `sh-` | CSS tokens, container names, Docker resources |
| `cb_` | `sh_` | SQL identifiers, session keys, metric names |

The domain rules **must** run before the generic word rule, or `corebase.com`
becomes `steadhold.devm`. Every prefix was rewritten on a word boundary, after
checking that no `cb`-prefixed identifier in the repository belonged to anything
else and that no `sh-`/`SH_`/`sh_` name already existed to collide with.

**The two apexes stay two apexes (D-411).** Collapsing them would have silently
deleted a documented security property: projects live on a different registrable
domain from the dashboard so a tenant XSS cannot reach dashboard sessions. Both
replacements happen to be HSTS-preloaded gTLDs, which forces HTTPS on
tenant-served content — a side benefit, not the reason.

**What it broke, and what that taught.** Three things, all now fixed:

1. **The rename erased its own history.** D-407, this section's own heading and the
   README all read "Steadhold → Steadhold" afterwards, because "Corebase" was the
   *subject* of those sentences rather than a reference to be updated. A rename
   cannot be applied to the record of the rename. Repaired by hand.
2. **Gitignored generated state was invisible to it** (**D-413**).
   `infra/docker/staging/app-role.env` and `mail-sink.env` still held `CB_*` keys;
   `staging.sh` sourced them, found no `SH_APP_DB_PASSWORD` and stopped on
   `unbound variable` — the good outcome, because `set -u` turned a silent empty
   password into a halt. Deleted and regenerated. The mTLS certificates are the same
   class and matter more: they carry `steadhold.test` SANs now, and a stale
   `corebase.test` cert would have failed at a far less obvious layer.
3. **Two of the three project images changed content, not just tags.** Retagging
   `corebase/postgres` would have been wrong: the Dockerfiles moved
   `/etc/corebase/postgresql.base.conf` and
   `/usr/local/bin/corebase-entrypoint.sh`. All three were rebuilt.

`pnpm install --lockfile-only` regenerates the lockfile but does **not** relink
`node_modules`, so the first typecheck after the rename failed on
`@steadhold/config/tsconfig.base.json not found` — a stale workspace symlink, not a
rename error. A full `pnpm install` fixes it.

**The rename is a breaking change for any live deployment, in four ways.** None
matter on a staging stack that is rebuilt from empty, and all four would matter on a
running one:

- The session cookie is `sh_session` and the refresh-token prefix is `sh_rt_`
  (`services/api/src/kernel/sessions.ts:20`, D-112). Every existing session and
  refresh token stops being recognised — everyone is logged out once.
- Migrations are **checksummed**, and the rename rewrote the body of applied ones
  (`steadhold_app`, `steadhold_control`). An existing control database fails the
  checksum gate on the next run; there is no in-place path, only a restore.
- The compose project name changed, so `docker compose` creates fresh
  `steadhold_*` volumes and leaves the old `corebase_*` ones orphaned rather than
  migrating them.
- Two of the three project images changed content, so the node's image store has to
  be re-seeded, not re-tagged.

**The GitHub repository is renamed**, by the owner: `AbdallaEmadEldinAbdalla/Corebase`
→ `abdallaemadeldin/Steadhold`. The account handle changed alongside the repository,
so `git remote set-url` was needed rather than relying on GitHub's redirect, and
anyone with an existing clone needs the same:

```bash
git remote set-url origin https://github.com/abdallaemadeldin/Steadhold.git
```

**Still outward-facing and open:** `steadhold.dev` and `steadhold.app` are not
registered — deliberately deferred until the product is closer to production. The
local working directory is still `~/Desktop/Corebase`; renaming it mid-session
would break every absolute path in flight, and it has no effect on anything the
repository builds.

### The mark · done · four rounds, 30 candidates, 1 shipped

A **chiselled S cut at the waist**: ink upper bowl, terracotta lower bowl. The
accent is the stratum the letter stands in — *founded, not rented*. **D-408.**

Built and judged with the `logo-maker` skill. Everything is generated from one
authored path by
[`build-identity.py`](design-exports/steadhold/build-identity.py) — geometry lives
in exactly one place, because a favicon that has drifted from its logo drifts
invisibly (**D-409**). Eleven assets: two 1024-grid masters, `favicon.svg` +
`.ico` + three PNGs, a maskable SVG, two PWA PNGs, and an opaque
`apple-touch-icon.png`. Rasterisation goes through headless Chrome; `rsvg-convert`
and ImageMagick are not on this machine, and the script warns and continues rather
than pretending it wrote an `.ico` it could not.

The mark ships free-standing everywhere. The favicon is the single exception that
carries an ink field, because the ink upper bowl vanishes against a dark browser tab
and the terracotta base alone is not the letter (**D-410**). The maskable icon
scales the glyph to `0.82`: at full size its half-diagonal is 443px against the
409px safe radius, so an unscaled maskable icon would have had its corners clipped
by the OS.

Palette: ink `#171310`, paper `#FAF6F0`, terracotta `#B4502E` / deep `#8E3D22` /
bright `#E07A52`. Type: Zilla Slab 600/700 display, Space Grotesk 400/500/600 UI.
Signature tilt `−15°`.

**What it broke:** nothing — no source file changed. The existing dashboard still
renders the old Pencil-derived tokens, which is now a known inconsistency rather
than a regression.

**Verification:** by looking, at every round. Headless-Chrome screenshots read at
128 / 64 / 32 / 24 / 20 / 16px on both finishes, plus the actual rasterised
`favicon-16.png` inspected at 4× nearest-neighbour to confirm the letter survives
the pixel grid. The showcase is
[`design-exports/steadhold/identity.html`](design-exports/steadhold/identity.html).

**The round that mattered most was the one that failed.** Rounds 1 and 2 both built
the S from three horizontal bars and two stems. It does not work: that construction
*is* a numeral **5** — a 5 is the same shape minus one corner, and that corner is
the first thing to disappear at favicon size. Only the two opposing curved bowls
distinguish an S. The full record of what was cut and why is in
[`design-exports/steadhold/README.md`](design-exports/steadhold/README.md); the
rejected rounds are kept rather than deleted.

## 4i. The token layer, rebuilt

Not a numbered plan step either. It sits before Phase 7 because a dashboard cannot
be rebuilt against a visual layer that contradicts the brand.

### Palette · done · D-417

Terracotta `#B4502E` on warm clay neutrals, replacing Electric Violet. It comes from
the identity rather than a bake-off. **D-177 chose violet over coral on two
practical grounds and both had to be answered, not waved past:**

1. *White must clear AA on the accent in both themes.* The fix is that the accent
   **does not lift in dark mode** — one fill value, white at 5.09:1 everywhere,
   `on-accent` unconditional. `accent-bright` is a *text* colour for dark surfaces,
   never a fill.
2. *Error must never be a hue the brand also uses.* Terracotta is red-adjacent, so
   the semantics moved: error to the **cool** side of red (~346°), warning to a true
   ochre (~41°), both ≥25° from the accent and asserted in the suite.

**The pre-existing defect this uncovered:** `violet/600`, the *dark* accent, is
4.23:1 against white and 4.36:1 against ink. It failed AA with **either** label, for
as long as the system existed. §7 of the design-system doc justified the accent by
citing only `violet/500`, the light value — the claim lived in prose, and prose does
not run. That is why the whole contrast floor is now executable.

**The limitation, recorded rather than hidden:** the accent *tint* cannot be
hue-separated from both semantic tints at once, because the brand hue sits between
error and warning; 20° is already near-equidistant. Separation is carried by chroma
and a deeper foreground instead. Permanent consequence of a warm brand.

### Generated, not hand-written · done · D-418

`tokens.css` is emitted by
[`tokens.build.mjs`](apps/dashboard/src/styles/tokens.build.mjs) and the test asserts
byte-equality. A theme pair has to be declared three times in plain CSS, and the old
file carried all three by hand under a comment reading *"keep the two blocks in
sync"* — a hope, not a mechanism. `light-dark()` would collapse them and was
rejected for a concrete reason: a custom property parses permissively, so an
unsupported `light-dark()` is accepted and then fails at *substitution* time, which
unsets the colour rather than falling back to the light value. That is a broken UI on
an older browser, not a degraded one. Generating the duplication is the only option
with a single source **and** no compatibility floor — the same reasoning as the logo
(D-409).

### Type · done · D-419

Zilla Slab (display/h1/h2, 600/700 only), Space Grotesk (interface), JetBrains Mono
(copyable). Three families widens D-179's two; its loading-budget argument is
respected by confining the slab to three roles at two weights. D-179's real point
survives intact: mono means "data you can copy".

### Spacing · done

Named by value — `--sh-space-16` is 16px — with 20 added because three components
genuinely wanted it. The old scale was a skipping index, which is what made
`--sh-space-5` read as a real token (D-414). Migrated in one atomic pass keyed on the
old index, because old `space-4` meant 16px and new `space-4` means 4px: a partial
rename would have silently shrunk 54 paddings. Verified by resolved pixel value — all
158 references preserved exactly.

### What the rebuild found · four defects, all fixed

| Defect | Why it survived |
|---|---|
| `violet/600` dark accent fails AA either way | The doc measured only the light value |
| `badge--accent` was 4.33:1 (accent over its own tint) | No constraint existed for that pairing; a screenshot found it |
| `.sh-skeleton` at 1.09:1 on a dark card | Reused `surface-alt`; a placeholder nobody can see |
| `color:#BEB4D6` in `.sh-code__copy` — the old violet | D-178's guard matched ramp *names*; a hex literal has none |

The last one is the instructive one: it sat in the code panel through the entire
brand rebuild. A literal is the same violation as a ramp step and harder to see, so
it is now the same rule, enforced over stylesheets **and** components (D-420).

**Verification.** Dashboard suite **74/74** (from 13), typecheck 14/14, `next build`
green, `tokens.css` byte-identical to its generator. Every new guard was proven by
breaking it and watching it fail: a hand-edited `tokens.css`, an accent fill pushed
below AA, error moved back next to the accent hue, `--sh-space-5: 20px`, and
`#BEB4D6` put back. Looked at in a browser in both themes — login and signup in the
real app, plus every component class rendered against the real `components.css`.
Ran the D-224 `ux-review` gate: pass, two gate failures fixed in the change, none
recorded as gaps.

**What it broke:** nothing outside the dashboard. No service, migration or test
outside `apps/dashboard` changed.

## 4j. Phase 7 — the dashboard

### P7a — the paused-project experience · done · D-425

D-131's dashboard half. The API half already existed and my first survey of Phase 7
said otherwise, wrongly: `POST /v1/projects/:ref/pause` and `/resume` are complete,
including the 409-with-state that an idempotent auto-resume reads. They were missed
because they are registered in a `for` loop over a template literal and the survey
grepped for string-literal routes — the same methodology error as D-422, one file
apart.

What shipped:

- **Auto-resume from the project layout**, so a deep link to Connect or API keys
  resumes as readily as the overview. No confirmation dialog: opening the project
  after clicking it is not a decision to re-confirm.
- **A resuming banner** with `aria-live`, and no error state during a normal
  few-second transition — a panel saying "failed to load" while a project resumes
  teaches the user their data is at risk when it is not.
- **A failure card** carrying code, message, `request_id` + copy button (D-032) and
  Retry. Never a dead end.
- **An inline Resume on paused grid rows** — the IA's "resume without opening". The
  grid's most likely action should not be two clicks deep in a ⋯ menu.

The sequence rules are in `lib/resume-machine.ts`, tested against ordered status
sequences rather than through a DOM the dashboard has no tooling for. The hook is
the thin half; if the decision lived in it the test would guard a copy of it.

**What verifying it found — two production bugs, both in the backup path.** Neither
was Phase 7 work and both are now fixed: the Engine API client held every
pgbackrest exec to 30 seconds (**D-421**), and a resumed project came back with no
pgbackrest config at all (**D-423**). The second was found by pausing a real
project, opening the dashboard, watching it resume, and pausing it again — which
dead-lettered. No unit test would have found either.

**Verification.** Dashboard 87/87, typecheck 14/14, `next build` green. Live on
staging: a real project provisioned, paused, opened in the browser, seen to
auto-resume with the banner and the badge, and the duplicate-banner bug that first
attempt introduced found by looking and fixed.

### The rest of Phase 7 — not started, and what blocks it

The scope is ~30 routes. What is missing is mostly **API, not UI**:

| Surface | Blocker |
|---|---|
| Table editor, SQL editor | No query/DDL execution endpoint exists |
| Auth users, storage browser | Data-plane only (`/auth/v1/admin/*`, `/storage/v1/*`), which needs a `service_role` key — and a session-cookie dashboard (D-062) must never hold one in the browser. Needs a control-plane proxy, which is an architectural decision, not a screen |
| Logs, metrics, backups list, audit | No endpoints |
| Org members, settings, account, invites | **API exists** — these are the genuinely UI-only steps |

`D-130` specifies Tailwind + shadcn/ui and the dashboard has neither, using the
hand-written token layer instead. That divergence predates this phase and is still
unrecorded, which CLAUDE.md calls a doc bug; it needs a decision either way before
the screens are built on it.

**Exit criterion 1 — "the first-five-minutes flow completable without docs,
hallway-tested on ≥3 people, timed <5 min" — cannot be self-certified and will be
recorded unmet** no matter how well the flow works. The checklist can be built and
instrumented; three people cannot.

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

**A harness checks what it is told.** Every HTTP status, every response shape,
every precondition it depends on — because a harness that does not will
confidently blame the one component that is working (**D-359**). The T6 drill spent
four nights reporting a worker fault that did not exist, twice over: once from an
unchecked status and once from reading `{ref, id}` out of a `{project, job}`
response.

**A failure path prints everything it already holds.** Five separate bugs in this
repository have been prolonged by a diagnostic that had the answer in memory and
printed a window that excluded it (**D-360**). If a harness keeps a log, its
failure path prints the log.

**A branch that never runs where it was written is untested.** Both CI failures of
Phase 4 were tests whose conditional half only executes on the *other* machine —
one needs a kernel with `io.weight`, one needs an Engine that refuses `exec` on a
dead container. Where the two environments genuinely differ, the test injects the
harder case rather than waiting for it (**D-351**); where an assertion depends on
a number some implementation produced rather than a property the mechanism
guarantees, it asserts the property (**D-350**).

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

**A test file declares the fixture it needs; it never inherits one.** Vitest
shards by file, so adding a file reshuffles which files share a shard — and a
dormant coupling then surfaces as a red CI on a commit that has nothing to do with
it. Shared rows (`nodes` above all) must be normalised in `beforeEach`, in *every*
dimension: status, RAM and disk. Normalising one of three just moves the failure.

**A base image is not the same image on every architecture.** `FROM` inherits
whatever the registry serves for the builder's platform, and "it built on my
machine" says nothing about the other one. An image whose userland matters should
build *from a base we choose* and copy in what it needs, and should exercise the
thing it copied during the build.

**A performance test asserts correctness first.** Errors are faster than
successes, so a benchmark that does not check its responses will happily report
the latency of a rejection as a record time — and the worse the break, the better
the number looks. Every load run proves one correct request per arm before it
measures anything, and treats a failed check as invalidating every latency figure
above it.

**A surface used by two kinds of caller is tested with both.** The storage API is
reached by a customer's *backend* holding a `service_role` key and by their
*users* holding an access token, and those callers have different database
privileges — so a test suite that only ever presents one of them leaves half the
surface unexercised. Five steps of storage work were green while every
authenticated user's upload failed, because every test was a backend. Whenever a
role distinction exists, the tests present each role.



**A long-lived Docker-in-Docker node degrades, and a degraded one looks like a
hung test.** `interlocks.e2e.test.ts` took **8 hours 8 minutes** and failed on a
node that had been up nine hours across two full worker-lane runs — thousands of
container create/destroy cycles. The same file on a freshly built stack passes in
**62 seconds**. Its six tests cap at 600s each, so the arithmetic alone says the
stall was below the test layer. Recycle the stack between full lane runs rather
than trusting a long-lived one; CI gets this for free because every job builds its
own, and it is only the local loop that accumulates.

**The node's healthcheck was red for its entire existence, and it did not matter
until it did** (**D-416**). It offered dind's *server* certificate as a client
credential, which `x509` refuses on key usage, so `docker ps` has always said
`unhealthy` while every T2 check passed — `staging.sh` probes from the host with
the correct pair. A permanently red signal is worse than no signal: it is the one
an operator learns to scroll past. While diagnosing the stall above I treated
"unhealthy" as the cause and spent real effort on it before checking whether it had
ever been green.

**A test's fixture includes the environment it did not set.** §5 already said a
test declares its fixture in every dimension; two files were still reading ambient
configuration. `project-auth.e2e.test.ts` and `credentials-guard.test.ts` now delete
the variables they depend on (**D-415**), because exporting STATUS §2's run-by-hand
recipe — which is a recipe for running the *services* — turned 78 passing tests into
78 failures that read exactly like a rename regression: every request expecting
success returned 401, and the only tests that stayed green were the ones asserting
that things are refused. The lesson is the failure *shape*: when a suite fails and
its negative tests all pass, suspect the fixture before the product.

**A guard covers every surface that can break the rule, not the surface where it
was first broken.** The token guard was written after five `var(--sh-space-5)`
references with no fallback collapsed five paddings to zero. It scanned the
stylesheets. The same bug then reappeared in five `.tsx` inline styles and survived
the entire dashboard shell, because `style={{}}` can write a custom property just
as easily as a rule can and nothing was looking there. Ask what *else* can express
the mistake, and put the guard around that instead (D-414).

**A failed job is not a failed thing.** The nightly latency drill went red with
every number inside budget: 22,139 requests, zero failures, gateway overhead P99
3.9 ms. What failed was k6 writing its summary file, and the harness reporting a
missing summary as a failed measurement (D-426). Read what actually broke before
believing the label on it — and the reverse of the same rule bit earlier the same
day, when two shards failing on a CSS-only commit turned out to be a real
production defect rather than the flake it looked like.

**Vitest compiling a file is not the file typechecking.** Vitest transpiles per
file and does not resolve types across modules, so a test that imports a type from
a module which declares it locally without re-exporting runs green and fails
`tsc --noEmit`. That shipped in a commit here because the new test was verified
with vitest and the typecheck was run afterwards, on the next commit — the same
shape as the standing rule that `tsc` passing does not mean `next build` will,
pointed the other way. Run `turbo run typecheck` before committing, not after.

**Ask what a step wrote, and where.** A container is not a project. Provisioning
writes into two different places — the mounted volume, which survives, and the
container filesystem, which does not — and pause/resume replaces the container. The
resume saga has now lost something for that reason twice: PostgREST once, recorded
in its own comment, and then pgbackrest's config, which took backups and deletion
down silently for every project that had ever been resumed (D-423). Both times the
saga read as complete because every step in it succeeded. The question that finds
this is not "does resume work" — it does — but "what did provisioning write that
resume does not".

**A test suite that has been tuned until it passes is hiding something.** The
worker's e2e files each built their Docker client with a different timeout — 20s,
30s, 60s, 120s — numbers arrived at by raising whichever file was failing. That
spread was the symptom of a real defect underneath it (D-421): the client applied
one timeout to *every* request including the exec that waits on a command, so the
production worker held pgbackrest to 30 seconds and every backup past a certain
size failed at the transport. It surfaced only when two CI shards failed on a
commit that changed nothing but CSS, and the honest read of "these tests need
different timeouts" is that the thing being timed is not what the number thinks it
is. The per-file values are now vestigial and worth normalising; they are left for
a separate change rather than folded into the fix.

**A rename is applied to references, never to the record of the rename.** A
find-and-replace cannot tell a mention of the old name apart from a statement
*about* the old name, so it rewrites "Corebase → Steadhold" into
"Steadhold → Steadhold" and quietly deletes the only text that explained why. Three
places said that after the rename: D-407, §4h's own heading and the README. The
rule is to sweep for self-referential text afterwards and repair it by hand, and to
leave a provenance line on any document preserved as a historical artifact.

**A verification written from the same assumption as the change cannot fail.**
The rename swept `CB_`, `cb-` and `cb_` because the survey looked for those three,
and then the post-rename check confirmed success using the same three patterns. It
was clean, and it was clean about the wrong thing: `cb:` and `cb.` had never been
considered, so Redis key prefixes (`cb:session:`, `cb:rl:`, `cb:mail:`) and the
browser storage keys for CSRF and last-visited org survived untouched (D-422).
Found weeks later by reading unrelated code. When a check and a change share an
assumption, the check is a restatement — so the invariant now lives in CI as a
grep for the *old* thing, which can only pass by the old thing being absent.

**A rename also has to reach what `git grep` cannot see.** Gitignored generated
state, the contents of built images, and workspace symlinks all carry the old name
and none of them appear in a search of tracked files. Each bit here: staging's
`app-role.env` still held `CB_*` (caught only because `set -u` halted the script),
two of three project images had the old name in a *path* rather than a tag so
retagging would have been wrong, and `pnpm install --lockfile-only` left
`node_modules` pointing at `@corebase/*`. Delete and regenerate that class of state
rather than rewriting it.

**Prove a mechanical change was mechanical.** The rename touched 352 files, which
is far past reading. Re-applying the substitution rules to every removed line in
the staged diff and asserting it equals the added line turns "I think that was just
the rename" into a check — and it is the only thing standing between a 352-file
commit and something unrelated riding along in it.

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
| D-202 | Hand-written metrics registry; no `steadhold_*` metric carries `project_ref`, asserted by a check | D-146's budget is a constraint: one per-project histogram would be 600k series |
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
| D-216 | The API connects as `steadhold_app`, which owns nothing and cannot run DDL; `steadhold` owns the schema | Three claims in the corpus were untrue while one role did both jobs |
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
| D-228 | Each project gets a private bridge network, `sh-<ref>-net`, with Postgres aliased `db`; the name is derived, not stored | The pooler and PostgREST both configure `host=db`, so a stable alias keeps those templates from ever learning a project's ref |
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
| D-240 | `SH_STATIC_TOKEN` has no default; a short or placeholder value refuses to boot | It defaulted to `dev-token`, so an unconfigured API accepted that header as the bootstrap owner — verified, 200 |
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
| D-277 | `steadhold_backup_last_success_ts` means the last base backup; WAL has its own gauge | Pointed at WAL, the ">26h" alert stays green for a project whose nightly full has failed all week |
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
| D-299 | `SH_REQUIRE_FINAL_BACKUP` defaults on | The failure is invisible: a recovery window with nothing behind it looks exactly like one |
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
| D-315 | `steadhold_auth` alone holds table privileges in `auth`, with its own password | `service_role` has BYPASSRLS, so the absent grant is the only thing between it and every password hash |
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
  produces 156 `steadhold_*` series, **none carrying `project_ref`**. Says the
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
- ~~**Idle detection is missing its first signal**~~ — **built in P5a** (D-374).
  What follows is kept for the reasoning, and for the correction underneath it:
  the tripwire described here was watching the container count, and the data plane
  arrived as a shared *process* instead (D-375), so the gap it guarded against had
  already been open since P4b.
- **Idle detection was missing its first signal**, deliberately. The doc requires both
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
  but inert until an operator names the node's data device (`SH_IO_DEVICE`); no
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
- **Phase 4 is complete** (P4a–P4i) with **two of its three exit criteria met**.
  The third — mail delivering to Gmail, Outlook and Yahoo with SPF, DKIM and DMARC
  green — needs a real domain at a real provider and cannot be met on Docker at
  all; it is unmet rather than waived.
- **Step 3 of the rotation runbook is not built**, and cannot be yet: reloading
  PostgREST's configured public-key set needs PostgREST (Phase 5), and the gateway
  half needs a gateway. So a rotation today is complete for everything that
  verifies *through the auth module* — which is everything that exists — and will
  need that step before the data plane lands, or a rotation will leave PostgREST
  verifying against a key the module has stopped signing with. OQ-112 owns the
  mechanism.
- **Self-serve deletion does not exist** (`DELETE /user`), which is V1.x by D-114:
  it needs a grace window and a data-export story that do not gate V1. So a user
  asking to be deleted is deleted *by the developer*, through `/admin/users/:id`,
  and the platform has no opinion about how they were asked.
- **The project-database `auth` schema has no migration path** — surfaced by P4f
  and not closed by it. The tables are created at `initdb` (D-314), which is right
  for a fleet-wide identical schema and means **an existing project's schema is
  frozen at whatever its image created**. P4f wanted a column on `auth.sessions`
  and used a JWT claim instead (D-343), which was the better mechanism anyway — so
  nothing is broken today. What is missing is the machinery for the first change
  that has no such alternative: a per-project schema version, a step that applies
  pending DDL to every running project, and a way to do it without a window where
  the module and the schema disagree. It is a step, not a patch.
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
  records exist — `mail.steadhold.app`, its SPF `-all`, its DKIM selector, its DMARC
  policy and its aligned return path are all Terraform that has not been written.
- **Nothing populates the suppression lists.** Both lists and the enqueue-time
  check are built and tested; the webhook endpoint that would feed them is not,
  because there is no provider sending webhooks. So a suppression arrives today
  only by an operator inserting a `manual` row, and the complaint score, the
  ≥3-project promotion to the global list, and the >10% bounce / >0.1% complaint
  auto-pause are all part of that same unbuilt half (D-116).
- **No deliverability monitoring and no canary.** `steadhold_email_sends_total` and
  `steadhold_email_failures_total` exist and are labelled by template, not by
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
- `steadhold_auth` is still not in the pooler's `auth_query` allowlist, and OQ-110
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
- **Provisioning a project per test is now the integration lane's binding
  constraint, and it stopped being merely slow.** `project-auth.e2e.test.ts` grew
  to 63 tests across P4b–P4f, each standing up a real Postgres container at ~6 s of
  `initdb` and health-gating — about seven minutes for one file. Vitest shards by
  *file*, so the slowest file sets the floor for whichever shard holds it, and on
  `b2bbcb1` that shard was **cancelled at 20m32s** having never failed a test. The
  immediate fix was arithmetic — six shards instead of four, and a 35-minute job
  timeout — and the durable one is not: most of these tests need a clean `auth`
  schema, not a private database, so a project shared across a describe block with
  `truncate auth.users cascade` between tests would remove almost all of the cost.
  The P3d suite has the same shape (a source project per test, four provisions)
  and the same fix.
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
- `SH_REQUIRE_BACKUPS` and `SH_REQUIRE_FINAL_BACKUP` are both **on** now that
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
- `steadhold_admin` exists as a role with no password; the audited dashboard path that
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

**The isolation matrix is nearly complete, and what remains is named.**
~~ST-1 through ST-4 (storage-path isolation)~~ — **closed by P6g**, 13 tests in
the release gate. D-084 still asks for a **cross-node** variant alongside the
same-node one — staging has a single data node, so adjacency is automatic and the
cross-node path is untested. And the **persistent prod canaries** (daily,
non-destructive, against the live fleet) need a prod fleet to live on; today only
the ephemeral staging half of D-084 exists, which proves the build is
isolation-safe but not that a running system has stayed that way.

**The egress policy is applied by `staging.sh`, not by a node agent.** D-081 makes
it part of the node baseline, so in production it belongs to the agent at join
time. Today a node that is brought up without `./scripts/staging.sh harden-egress`
has no egress control at all, and nothing detects that except the isolation suite
failing — which is the right detector but the wrong moment. The DNS allowlist is
also broader than it should be: any host on port 53, rather than the node's
resolver.



**The rename is applied in the code and to the repository, but the names are not
owned.** Everything here says Steadhold (§4h, D-407) and the GitHub repository is
`abdallaemadeldin/Steadhold`, but `steadhold.dev` and `steadhold.app` are **not
registered** — deferred until closer to production — and OQ-099, whether
"Steadhold" is registrable as a word mark in EU/US software classes, is still open.
Both are commercial tasks outside this corpus, and the second could in principle
force a second rename, which is the one that would be expensive: this one cost 352
files and four days' worth of decisions to do carefully.

**One test reads the ambient environment.**
`services/api/src/credentials-guard.test.ts` builds `buildApp({})` and asserts an
unconfigured API rejects `Bearer dev-token`, but `buildApp` falls through to
`process.env.SH_STATIC_TOKEN` — so the test fails for anyone who has exported the
variable from the run recipe in §2. It passes under `env -u SH_STATIC_TOKEN` and in
CI, which sets neither. The assertion is right and the fixture is incomplete: it
should clear the variable itself (§5 already says a test declares its fixture in
every dimension). Pre-existing, not rename fallout — the same sensitivity existed
against `CB_STATIC_TOKEN`.

**The token layer is rebuilt; the components on top of it are not.** §4i replaced
`tokens.css`, `Logo.tsx` and the palette/type system, and `components.css` still
carries the Pencil boards' *component* geometry — the class library was repointed at
the new tokens and its three colour literals removed, but the shapes, densities and
component inventory are unchanged. Phase 7 is where the screens get rebuilt; this
step only means they will be rebuilt against a layer that is correct.

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
