# Corebase

**The backend foundation for modern applications.**

Corebase is a developer-focused Backend-as-a-Service: a developer creates a project and receives a production-ready backend — PostgreSQL, auto-generated APIs, authentication, row-level security, object storage, and (later) realtime — in minutes, without assembling infrastructure themselves.

> One command to get a production backend: `corebase create my-app`

## Status

**Milestone 0 complete; Phase 1 complete; Phase 2 started.**

**The provisioning spine (Milestone 0).** `POST /v1/projects` returns a real, isolated PostgreSQL 17.5 database on a data node about **2.5 seconds** later, with its own volume, cgroup limits, the full role model, envelope-encrypted credentials, and a connection string you can `psql` into immediately. Twenty consecutive creates are measured end to end.

The worker has also been SIGKILLed at eleven points in that saga to prove it resumes with no duplicate containers, volumes, credentials or capacity bookings.

Deleting a project keeps its data for a 7-day recovery window and then a scheduled purge destroys it and returns the capacity; twenty create+delete cycles leave nothing behind on the node or in the control plane.

Reboot the data node and every project is serving queries again seconds later with no human involved; whatever the control plane and the node disagree about is reported, and anything holding data is reported *without* being touched.

All of it is visible: Prometheus scrapes both services, Grafana has a provisioned dashboard, logs are in Loki and findable by project ref or request id, and the "job stuck" alert has been watched firing.

The [retro](docs/14-roadmap/06-milestone-0-retro.md) reconciled the cost model with six measurements and its main output is a refusal: the RAM and density planning numbers did not move, even though the first data is 3× favourable, because every number was taken in the cheapest corner of the state space.

**The platform surface (Phase 1).** You can sign up and log in — scrypt hashing, rate-limited per identifier and per address, with nothing distinguishing an unknown email from a wrong password including the response time — and hold either a session cookie or a `cbp_` personal access token. You can create organizations, invite people to them, and hold one of three roles that genuinely decides what you can do: a member creates and pauses projects but cannot delete them, an admin does everything except delete the org or grant owner, and no admin can strip an owner to take the org. Projects belong to organizations, so listing them shows *yours*.

Every mutating call leaves a row in an append-only audit table — enforced by a trigger, because `REVOKE` does not bind a table's owner, and by an application role that owns nothing and cannot run DDL. A test enumerates every mutating route and fails if one is unaudited.

Each project gets its own ES256 keypair with `anon` and `service_role` keys, and publishes `GET /v1/projects/:ref/.well-known/jwks.json` so a customer's services can verify tokens without calling us.

**The dashboard shell (P1g).** A Next.js app that is a pure client of the platform API — no BFF, no server-side control-plane access. Sign in, switch organizations, see your projects in a dense table, create one and watch it go `creating` → `ready` without reloading, then copy a connection string that works. Context lives in a breadcrumb where every segment is a switcher, the chrome never re-renders when you navigate inside it, and everything is reachable from the keyboard: `⌘K` for a command palette that navigates, switches, creates and copies, `g p` / `g o` / `g c` / `g k` to jump, `?` for the list.

It is built on the design system that already existed in `design-exports/` rather than on Tailwind + shadcn (D-220): those exports turned out to be a complete component library, and a second component system for the same design would only drift from it. Both themes ship, and tests enforce the three rules that decay silently — no stylesheet may name a ramp step, no drop shadows, and no reference to a token that does not exist.

**How the UI stays consistent.** The first version of this shell was right in every colour and wrong in every mechanic, so the fix was not nicer screens but a written interaction contract: [docs/09-dashboard/05-ux-standards.md](docs/09-dashboard/05-ux-standards.md), ending in a 20-question gate that **runs on every UI change** (D-224) as the `ux-review` role in [.claude/skills/](.claude/skills/ux-review/SKILL.md). Its first run found two real failures in the code written to satisfy it — the palette was missing two actions a row menu already had, and the project list printed "Showing 20 of 20" while hiding a second page.

**Deleting a project takes a final backup first, and stops if it cannot.** Nothing about a `DELETE` distinguishes "we are done with this" from "I typed the wrong ref", so the seven-day recovery window exists — and a recovery window with nothing behind it looks exactly like a recovery window, right up to the moment somebody needs it. Always a full, never an incremental: this is the only copy that will outlive the project. Proven by reading the repo from a *different* container after the project is gone, because a database row saying `succeeded` is our own bookkeeping and the promise is about the archive.

Pausing has the same interlock, for a reason that is easy to miss: a paused project has no running Postgres, so WAL archiving stops with the container. Left alone, the only current copy of a customer's data would be one node's disk with a backup behind it that is already older than the pause. So pause takes a backup after the checkpoint, confirms it landed, and **refuses to stop the containers** if either fails — a paused project whose backup failed is strictly worse than a running one, which is the opposite of what pausing is for.

**A restored copy has a deadline — 48 hours, never more than a week.** It holds a second full dataset and two capacity bookings while serving no traffic, and nothing about it ever finishes on its own: without a deadline the copy a customer validated on Tuesday is still on the node in March. Expiry hands it to the *normal* deletion pipeline rather than destroying it, which matters more here than anywhere — the customer restored because they lost data, so the copy may be the only surviving version of something. What the deadline ends is the copy *running*; its data stays recoverable for the usual week behind that, and the screen says so rather than reading "your copy will be deleted".

**Restoring to a point in time works.** `POST /v1/projects/:ref/restore` provisions a *new* project and replays write-ahead log into it up to the second you name — the original is never touched, and the copy is marked `restored` rather than `ready`, because two databases serving one application loses data by construction. Proven the only way that counts: a row written before the target is there, the row written after it is not, and the original still has both.

Getting there found the bug that would have mattered most. The target was formatted for pgBackRest by trimming the milliseconds off a timestamp, which moves the requested instant backwards by up to a second — so a restore would come back looking perfectly correct and one transaction short, and a customer restoring to the second before a bad migration would have lost that second's writes with no way to tell. It also found a guard of mine that could not fail: checking for a file with `ls` and a substring match passes whether the file exists or not, because `ls` prints the path in its own error message.

**Backups happen without being asked, and failures are visible.** A nightly full on the free tier, weekly fulls with nightly incrementals on paid plans, jittered across a maintenance window so a node with 150 projects does not read 150 databases at 03:00. Every attempt is recorded — including the ones that fail, which is the point: a repo can tell you what it holds but never what was tried, so a project whose nightly full has failed for six days looks exactly like one whose retention window starts six days ago.

Two of my own earlier mistakes surfaced here. Retention was set as a *count* of full backups where the design says days — identical on the free tier, where fulls are nightly, and about eight times too much storage on a plan whose fulls are weekly. And the "no backup in 26 hours" alert was reading the WAL-archiving timestamp rather than the base-backup one, so it would have stayed green for a project whose nightly full had been failing all week while its WAL flowed perfectly.

**When archiving breaks, something notices.** WAL-archive lag is measured every two minutes, and the definition turned out to be the whole problem: the obvious one — time since the last successful archive — pegs every *healthy* idle free-tier project at the alert threshold, because `archive_timeout` closes a segment every five minutes and nothing happens in between. An alert that always fires is worse than no alert, since it discredits the ones that matter. What is measured instead is the age of the oldest segment closed but not yet archived, so nothing waiting means zero lag.

Proving it works meant breaking it, and breaking it found something worse: pointing a project's repo at a bucket that did not exist made the **database restart its whole cluster**. pgBackRest's async archiver double-forks, which reparented its worker onto PID 1 — the postmaster — where a non-zero exit is indistinguishable from a crashed backend. An archiving failure had become an availability incident, which is exactly backwards.

**Every project has an encrypted backup repo in object storage — and nothing has been restored from one yet.** Phase 3 leads with the backups doc's own rule: a backup that has not been restore-tested is treated as not existing. So what is true today is narrower than "backups work": each project gets its own pgBackRest repo under its own cipher-pass, and provisioning does not finish until `pgbackrest check` has forced a WAL switch and confirmed the segment landed. Point-in-time restore and the verification loop are the next two steps, and until they exist Corebase has an archive, not a recovery path.

Building it turned up that `initdb` was never given `--data-checksums`, which the restore-verification checks require. That absence is silent twice over: page corruption goes undetected, and a verification pass then reports a healthy restore of a rotting cluster — a backup system whose checks cannot fail is worse than none.

**One hundred projects run on one node.** 100/100 provisioned in 99 seconds, 200 containers, 200 client connections attached, 1.4 million statements — and each project's actual working set is 13 MiB under load against the 350 MB placement books for it. The interesting number is the one nobody was watching: RAM was over-booked 27-fold while **CPU sat at 82% of the node**. The cost model books RAM and does not model cores at all. That does not re-base anything — the density model may only move on a measurement with the full three-container stack on x86 hardware, and this is neither, which is a rule the project wrote for itself precisely because the data came back *favourable*.

**Projects are packed onto nodes by how full those nodes actually are.** Placement used to order candidate nodes by absolute megabytes reserved, which sorts a small nearly-full node ahead of a large nearly-empty one — so as soon as a fleet has nodes of different sizes, every new project goes to the fullest one. It also considered a single candidate, so a booking that did not fit that node was refused while the region had room: measured on the old code, 20 concurrent provisions against two nodes with 18 free slots placed 13. Nodes are now ranked by fill ratio across both RAM and disk, and a provision that loses a race for the last slot tries the next node instead of failing.

**Every axis a tenant can saturate has a wall, and the walls are checked against the kernel.** Memory, CPU, processes and disk I/O, read back from `/sys/fs/cgroup` inside the container rather than from `docker inspect` — which only ever echoes what we asked for. That distinction was not academic: setting the disk-I/O weight our own design document calls for made *every container on the node fail to start*, because this kernel has no `io.weight` at all, and no inspect-based test could have seen it.

**A project that fills its disk goes read-only and recovers.** The enforcement ladder warns at 80%, escalates at 90%, and makes the database soft read-only at 95% — reads keep working, writes fail with an error naming the cause, and freeing space lifts it automatically. Building it turned up that our own documentation gave the wrong recovery command: `SET transaction_read_only = off` does nothing under autocommit, so a customer following the docs would have concluded they were locked out of the only action that fixes it. The same mechanism had made the ladder a one-way door, because `ALTER DATABASE` is itself a write.

**Credentials rotate without breaking anything.** One `ALTER ROLE` replaces a project's database password: applications already connected keep working (Postgres only checks the password when a connection opens), a new connection with the old password is refused immediately, and **the connection pooler needs no reconfiguration at all** — it reads `pg_shadow` live, which is the reason `auth_query` was chosen over a credentials file. There is an opt-in flag to disconnect everything, documented as compromise response, because rotating alone does nothing about someone already holding a connection.

**A deep review of everything built** produced eight fixes, recorded as D-240…D-245. Two are worth naming here: `CB_STATIC_TOKEN` defaulted to the literal string `dev-token`, so an API deployed with no configuration accepted that header as the bootstrap owner; and the data node answered *"all predefined address pools have been fully subnetted"* with three networks on it — a per-project-network design runs out of *addresses* at roughly ten projects while Phase 2 aims at a hundred.

**Phase 2 (the database platform) has started.** Every project now gets a **connection pooler** — PgBouncer in transaction mode on its own port — so `DATABASE_URL` is a string an application can actually point at: twelve concurrent clients share one Postgres backend. The pooler resolves credentials through a `SECURITY DEFINER` lookup that allowlists exactly one role, so the pooled port cannot reach `postgres` or any other internal role even if PgBouncer is fully compromised — checked by presenting the correct superuser password and being refused. It sits on a private per-project network added in the same phase, which is also what PostgREST will need in Phase 5.

Projects also **pause and resume** now, which is what makes a database per free project affordable: an idle one returns its RAM and keeps its disk, its port and its credentials, coming back in **546 ms at the median** — measured, with 50 consecutive cycles proving nothing is lost. The idle signal took three attempts to get right, and the wrong versions are instructive: PgBouncer parks server connections under the customer's own role, so counting database backends means no project is ever idle, and subtracting the pooler's count instead pauses a project that has one live session open.

Chasing a test failure along the way turned up something older: the worker was opening unbounded keep-alive connections to data nodes through Node's global HTTP agent, which had been breaking the Docker engine outright and reading as "Docker Desktop is flaky" for weeks.

All three Phase-1 exit criteria are met. Above the database, the data plane is still Phase 2+: no data API (PostgREST), no end-user auth service, no storage, no realtime — and the dashboard is a shell, so there is no table editor, SQL editor, members page or billing yet.

> **[STATUS.md](STATUS.md) is the handover document**: what works, how to run it locally, what every rule in the code is defending against, and what is not built yet. Read it before the corpus if you are here to contribute.

## Run it

```bash
pnpm install
./scripts/staging.sh up && ./scripts/migrate-staging.sh && ./scripts/staging.sh kek
docker build -t corebase/postgres:17.5 infra/docker/postgres
docker build -t corebase/pgbouncer:1.23 infra/docker/pgbouncer
./scripts/staging.sh seed-images && ./scripts/staging.sh backup-store && ./scripts/staging.sh verify
```

`backup-store` creates the bucket, generates the object store's TLS material, and
proves the store is reachable from inside a project's own private network — the
same NAT path a real node takes to R2. Skip it and projects still provision, but
they provision without a backup repo and say so in the log.

Then start the services and watch the whole thing work in about five seconds:

```bash
./scripts/dev.sh
```

```bash
./scripts/demo.sh
```

Or use the dashboard, on http://localhost:3000:

```bash
pnpm dev:dashboard
```

There is no seeded password anywhere, so create an account on `/signup`; a new account has no organization, and [STATUS.md](STATUS.md) §2 has the two curl calls that make one (the endpoint exists, the screen does not yet).

The demo script creates a project, waits for it, connects to the database it made with the credentials the API handed back, runs real SQL, and deletes it — using only `curl` and `psql`, which is exactly what a customer has.

The full suite is **586 tests**, integration included; they need the staging stack above and **fail rather than skip** without it:

```bash
pnpm test
```

The unit lane is **216 of those** and needs no infrastructure at all — it is what CI runs first, in about a minute:

```bash
pnpm test:unit
```

Or measure provisioning end to end — twenty creates, each proven usable by connecting to it:

```bash
pnpm --filter @corebase/worker bench
```

Or kill the worker at eleven points mid-provision and watch every one converge:

```bash
pnpm --filter @corebase/worker kill-matrix
```

Or run twenty full create-use-delete-purge cycles and check nothing is left behind:

```bash
pnpm --filter @corebase/worker lifecycle
```

Or reboot the data node and watch it converge on its own:

```bash
pnpm --filter @corebase/worker node-reboot
```

To watch it work, `./scripts/dev.sh` starts both services with the right environment and ships their logs to Loki; Grafana is then at <http://127.0.0.1:3001/d/corebase-provisioning>.

Staging is Docker Compose plus Docker-in-Docker standing in for a control node and a data node. The interface the worker drives is the real one — the Docker Engine API over mutual TLS, no per-node agent (D-052) — so no step of the plan is skipped and nothing is paid for. [STATUS.md §2](STATUS.md) has the details and the environment variables.

## What is built

| | |
|---|---|
| `services/api` | Fastify control-plane API: auth, organizations, invites, project CRUD, project keys and JWKS; the documented `/v1` envelope with `request_id`, keyset pagination, idempotency keys, two-phase enqueue |
| `services/worker` | Provisioning worker: job runner with checkpoints, transactional placement, Docker Engine API client over mTLS, the eight-step provisioning saga |
| `packages/crypto` | Envelope encryption — per-secret data key wrapped by a master key that never enters the database |
| `packages/secrets` | Credential persistence; enforces store-then-apply so a crash cannot lose a password |
| `packages/audit` | The audit writer: joins the caller's transaction, redacts secrets on the way in, truncates rather than rejects |
| `packages/jwt` | ES256 sign/verify, hand-written to support exactly one algorithm — a wrong `alg` is rejected before a signature is computed |
| `packages/queue` `packages/migrate` `packages/types` | BullMQ wiring, the SQL migration runner, shared types and prefixed transport ids |
| `infra/docker/postgres` | The per-project database image: extension allowlist enforced by absence, no `trust` auth anywhere, RLS on at table creation |
| `infra/docker/pgbouncer` | The per-project pooler image: transaction mode, `auth_query` against a lookup that allowlists one role, every rule baked in |
| `infra/docker/staging` | The local stand-in for staging, including Prometheus, Loki, Alloy and Grafana with the dashboard provisioned as code |
| `packages/metrics` | A Prometheus registry — counters, gauges, histograms, with label sets declared up front so the cardinality budget is hard to break |
| `apps/dashboard` | The dashboard shell: login, signup, org switcher, projects grid, create-project flow, project overview — Next.js App Router, TanStack Query, session cookies, no BFF |
| `.github/workflows` | CI in two lanes — a one-minute unit lane run against dead database ports, and an integration lane that stands up the whole Docker stack — plus the nightly crash, lifecycle and reboot drills |

## The planning corpus

Everything lives under [docs/](docs/INDEX.md). Start there — [docs/INDEX.md](docs/INDEX.md) gives the full map and a recommended reading order.

The corpus covers, A to Z:

| Section | What it plans |
|---|---|
| [00-foundation](docs/00-foundation/01-vision-and-principles.md) | Vision, principles, competitive analysis, critical review of the original proposal, glossary, decision log |
| [01-architecture](docs/01-architecture/01-system-architecture.md) | System architecture, control/data plane split, multi-tenancy, domains/regions, repo layout |
| [02-control-plane](docs/02-control-plane/01-data-model.md) | Control-plane data model, platform API, provisioning state machine, job queue, audit |
| [03-database-platform](docs/03-database-platform/01-postgres-provisioning.md) | Postgres provisioning, pooling, credentials, migrations, backups/PITR, extensions & upgrades |
| [04-data-api](docs/04-data-api/01-rest-api-design.md) | Auto-generated REST API, request pipeline, API keys & roles |
| [05-auth](docs/05-auth/01-auth-architecture.md) | Auth architecture, sessions & tokens, flows, email infrastructure, OAuth roadmap |
| [06-security](docs/06-security/01-threat-model.md) | Threat model, RLS design, tenant-isolation test suite, platform security |
| [07-storage](docs/07-storage/01-storage-architecture.md) | Object storage architecture, API and access policies |
| [08-realtime](docs/08-realtime/01-realtime-architecture.md) | Realtime architecture (post-V1), channels/broadcast/presence |
| [09-dashboard](docs/09-dashboard/01-dashboard-ia.md) | Dashboard IA, table editor, SQL editor, [design system](docs/09-dashboard/04-design-system.md) |
| [10-cli-and-sdk](docs/10-cli-and-sdk/01-cli-spec.md) | CLI spec, local development, SDK spec |
| [11-infrastructure](docs/11-infrastructure/01-infra-phases.md) | Infra phases, IaC & CI/CD, observability, disaster recovery |
| [12-business](docs/12-business/01-cost-model.md) | Cost model, pricing & plans, abuse prevention, open-source strategy |
| [13-quality](docs/13-quality/01-testing-strategy.md) | Testing strategy, release & versioning policy |
| [14-roadmap](docs/14-roadmap/01-phase-plan.md) | Full phase plan, V1 scope & cut list, post-V1 roadmap, Milestone 0 |
| [15-risks](docs/15-risks/01-risk-register.md) | Risk register, open questions |

## Two registers keep the corpus honest

- **[Decision log](docs/00-foundation/05-decision-log.md)** — every binding decision (D-001…D-210) with its rationale. If two documents disagree, this log wins. Overturned decisions are annotated, never deleted, so the reasoning stays auditable — D-083's FORCE-RLS half, for instance, is annotated as superseded by D-191, which the build discovered by breaking a customer's first `INSERT`.
- **[Open questions](docs/15-risks/02-open-questions.md)** — 142 questions left deliberately unresolved, each with an owning document and a decide-by trigger.
- **[Measurement log](docs/14-roadmap/05-measurements.md)** — every number the plan assumed and the build later measured, append-only, and each entry states what it does **not** license. The drift between assumption and reality is the finding; the [Milestone-0 retro](docs/14-roadmap/06-milestone-0-retro.md) is where that drift was acted on.

## The design system

Accent is **Electric Violet** — `#7C3AED` light, `#8B5CF6` dark — on cool violet-tinted neutrals. It was chosen over coral, emerald, deep forest and cyan for two reasons that outlived taste: it is the only candidate where white text clears AA contrast on the accent in *both* themes, and it collides with no semantic colour. In a product whose scariest button is *Delete project*, the brand hue must never be confusable with the error hue.

The written spec is [docs/09-dashboard/04-design-system.md](docs/09-dashboard/04-design-system.md). The artefacts are under [design-exports/](design-exports/INDEX.md):

| Folder | What's in it |
|---|---|
| [`06-tokens/`](design-exports/06-tokens) | `tokens.css` (both themes), `colours.json`, `typography.json` |
| [`07-html/`](design-exports/07-html) | Live reference: all 43 components with their markup, plus one standalone file per component |
| `00-boards/` … `05-palette/` | 142 PNGs at 2x — full boards, sections, every component cropped alone, font specimens, palette ramps |

Open the HTML reference with a local server so the relative CSS resolves:

```bash
cd design-exports/07-html && python3 -m http.server 8000
```

Three rules in the token layer are load-bearing, and a naive light-to-dark inversion breaks all three:

- Components reference **role** tokens (`--cb-surface`, `--cb-text`, `--cb-accent`), never ramp steps — which is why flipping `data-theme` is the entire implementation of dark mode.
- The accent **lifts one ramp step** in dark, or it disappears into the surface.
- Danger *fill* stays darker than error *text* in dark, so white labels on destructive buttons keep their contrast.

There is no shadow scale. Elevation is surface tint plus border weight.

## North star

Make one developer love using Corebase. Then 10. Then 100. Then 1,000. The infrastructure evolves alongside the users rather than being built entirely in advance.
