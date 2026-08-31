# Corebase — Build Status

**Last updated:** 2026-08-31 · **Phase:** Phase 2 (the database platform) · **Milestone 0 complete** · **Phase 1 complete** (P1a–P1g, all exit criteria met) · **Phase 2: P2a–P2b done**

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

Test counts are from `pnpm test` and are all currently green: **400 tests**, of
which **216** need no infrastructure (`pnpm test:unit`).

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

Fifty-two decisions came out of running the thing rather than planning it —
D-184…D-210 from Milestone 0, D-211…D-227 from Phase 1, D-228…D-235 from Phase 2.
Full text in the [decision log](docs/00-foundation/05-decision-log.md); the log holds
D-001…D-235 and is binding when two documents disagree.

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

**Phase 2 is at P2b of seven planned steps.** Done: the per-project network, and
PgBouncer with the `DATABASE_URL`/`DIRECT_DATABASE_URL` contract through the API and
the dashboard. Remaining: pause/resume with idle detection (exit criterion 2),
credential rotation (criterion 4), disk quotas and the disk-full ladder
(criterion 3), bin-packing placement, and the density measurement (criterion 1) —
which D-209 already constrains, since this hardware cannot satisfy its conditions.

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
| What did we measure? | [docs/14-roadmap/05-measurements.md](docs/14-roadmap/05-measurements.md) |
| What do those numbers *not* prove? | [the M0 retro §4](docs/14-roadmap/06-milestone-0-retro.md) — read before quoting any of them |
| How does provisioning actually work? | `services/worker/src/jobs/sagas.ts` — read top to bottom |
| How does a project database get built? | `infra/docker/postgres/` — Dockerfile plus four init scripts |
| What does the UI look like? | run the dashboard (§2), or [design-exports/07-html](design-exports/07-html) served over HTTP |
| How does the dashboard talk to the API? | `apps/dashboard/src/lib/api.ts` — envelope, CSRF, 401, credentials, all in one place |
| Why is the dashboard not Tailwind? | D-220 in the [decision log](docs/00-foundation/05-decision-log.md) |
| **How must a UI change behave?** | [docs/09-dashboard/05-ux-standards.md](docs/09-dashboard/05-ux-standards.md) — §8 is the gate every change runs |
| How do I run that gate? | the `ux-review` skill in [.claude/skills/](.claude/skills/ux-review/SKILL.md) |
