# Self-Hosting

## Purpose

How someone runs Steadhold on their own machine or server with `docker compose up`, the way Supabase self-host works. Defines what is in the box, what is deliberately not, and the one thing our architecture did not previously answer: **whether the dashboard ships**.

D-027 already gives us the local stack and D-099 already defines "self-hostable" as the hardened single-node Compose data plane. This doc turns that into an actual distribution.

## Design

### 1. Two different things that share one compose file

| | `steadhold dev` | Self-host |
|---|---|---|
| Audience | a developer building an app *against* Steadhold | someone running Steadhold *as* their backend |
| Lifetime | minutes; torn down constantly | months; upgraded, backed up, monitored |
| Keys | deterministic dev keypair, never valid in prod (D-138) | real ES256 keypair the operator generates |
| Data | disposable, seeded | the actual production data |
| Ports | 5432x range, localhost only | 8000 / 3000 behind the operator's own TLS proxy |
| Mail | Mailpit catches everything | real SMTP (D-115) |
| Backups | none | pgBackRest sidecar, same tool as cloud (D-019) |

Same images, same paths, same RLS model. The difference is configuration and operational posture, which is why one compose definition serves both — the local-dev doc already calls this file the self-host seed.

### 2. What ships, and what does not

**In the box:** Postgres 17, PgBouncer (transaction mode), PostgREST, the auth module, the storage module, MinIO, the gateway (path dispatch + key validation + rate limiting), the dashboard, a schema-introspection service, and a pgBackRest sidecar.

**Deliberately absent** — the multi-tenant fleet machinery, per D-099:

- provisioner and the reconciliation loop (there is one project; nothing to place)
- pause/resume orchestration (nothing is idle-costing you money)
- billing, metering, usage records
- multi-region routing, node bin-packing, capacity accounting
- the org/project/member control plane

Cutting these is not stinginess — they are meaningless for a single project, and every one of them we shipped would be surface a three-person team has to support.

### 3. The dashboard problem

Our dashboard is a pure client of the **platform API** ([dashboard IA](../09-dashboard/01-dashboard-ia.md), D-130), and the platform API *is* the control plane — which self-host excludes. Taken literally, self-hosting Steadhold would give you a working backend and a blank browser tab. Supabase ships Studio; arriving from Supabase and finding no UI would read as the product being unfinished.

The fix is not to ship the control plane. It is to give the dashboard a **single-project shim**:

- **`meta`** — schema introspection and DDL execution over one database, running as the audited `steadhold_admin` role. The dashboard never holds `service_role` (D-132) locally either.
- **`studio` in self-host mode** — the same dashboard build, with `SH_SELFHOST=true`. Org switcher, project switcher, billing, usage and team pages are compiled out; there is exactly one project and it is always READY.

Endpoints the shim must serve for the dashboard to work: project meta (`GET /v1/projects/:ref`), tables/columns/indexes/policies introspection, DDL apply, SQL execute, migrations list/apply, auth users CRUD, storage buckets/objects, API keys reveal, logs tail, and advisor lints. Everything else in the platform API returns `501 not_available_in_selfhost` with a one-line explanation — a documented, honest failure rather than a hang.

Auth for the dashboard is basic auth on the studio port (`DASHBOARD_USER` / `DASHBOARD_PASSWORD`). It is not a login system, and the docs must say plainly: put a real proxy in front, or bind it to localhost and tunnel.

### 4. The stack

| Service | Port | Notes |
|---|---|---|
| `gateway` | **8000** | `/rest/v1`, `/auth/v1`, `/storage/v1` — the only app-facing port |
| `studio` | **3000** | dashboard, basic auth, single-project mode |
| `pooler` | **6543** | transaction mode; app connections go here |
| `db` | not published | reachable in-network only; direct access via `docker compose exec` |
| `rest` · `auth` · `storage` · `meta` · `objects` | internal | no host ports |
| `backups` | — | base + WAL archiving to a volume, restore-to-new |
| `mail` | 8025 | `--profile dev` only |

Postgres is **not published by default**. An exposed 5432 with a weak password is how self-hosted databases get mined, and the pooler is the correct entry point anyway.

### 5. Hardening deltas over `steadhold dev`

1. Every secret is a required variable — compose refuses to start rather than defaulting (`${VAR:?}`).
2. `wal_level=logical` and WAL archiving are on from first boot, so backups and future CDC never need a restart.
3. PostgREST connects **direct** to Postgres, not through the pooler — it needs LISTEN for schema reload and is itself a pool (D-101).
4. The gateway enforces rate limits locally too, so the self-hoster inherits the same abuse floor.
5. No superuser is ever handed to a service: `authenticator`, `steadhold_auth`, `steadhold_storage` and `steadhold_admin` are separate least-privilege roles created by the init scripts.

### 6. Install flow

```bash
git clone https://github.com/steadhold/steadhold && cd steadhold/selfhost
cp .env.example .env
steadhold keys mint --selfhost >> .env     # ES256 keypair + anon/service_role
docker compose up -d
docker compose --profile dev up -d        # add Mailpit for local mail
```

Target: **under 15 minutes from clone to first query**, and the docs are proven when a third party does it unaided (that is D-098's T2 trigger).

### 7. Upgrades and support boundary

Upgrades are `docker compose pull && docker compose up -d`, with the same one-major-version-at-a-time Postgres rule as the fleet (D-037, D-079). Migrations for our own internal schemas run on service start and are idempotent.

Supported: the compose file as shipped, on a single node, with the documented variables. Not supported: swapping Postgres for a managed instance, running services on separate hosts, Kubernetes translations, or scaling to multiple projects. Those are cloud problems, and the cloud is where we sell the answer.

## Decisions

**D-181 — The dashboard ships in the self-host distribution, in single-project mode: the same build with `SH_SELFHOST=true`, backed by a `meta` introspection service and a control-plane shim serving a documented endpoint subset. Org, billing, usage, team and provisioning routes are compiled out; unimplemented platform-API routes return `501 not_available_in_selfhost`.** *(Rationale: our dashboard is a control-plane client and the control plane is excluded from self-host, so without a shim self-hosting yields no UI at all — which reads as an unfinished product to anyone arriving from Supabase Studio. A shim bounded to one project is a small, well-defined surface; shipping the real control plane would drag orgs, billing and provisioning into the support boundary D-099 exists to protect.)*

**D-182 — Postgres is not published to the host by default; the pooler on 6543 is the only database entry point, and the dashboard is protected by basic auth with the docs instructing a reverse proxy.** *(Rationale: an exposed 5432 is the single most common way self-hosted databases are compromised, and the pooler is the correct entry point regardless; basic auth is honest about being a stopgap rather than pretending to be a login system.)*

**D-183 — Every secret in the self-host compose is a required variable with no default — the stack refuses to boot rather than starting with a known-weak credential.** *(Rationale: default passwords in self-host bundles become the de-facto production credential; failing loudly at `up` is the only reliable prevention.)*

## Open Questions

- **OQ-172** — Does self-host get the Advisors lints? They are pure SQL and the highest-leverage thing we have, but they are also a paid-cloud differentiator. Leaning yes-with-attribution; decide at the open-source release.
- **OQ-173** — Distribution: a `steadhold selfhost init` CLI command that renders the compose file and mints keys, or a plain cloned repo the operator edits? The CLI path is friendlier but couples self-host releases to CLI releases.
- **OQ-174** — Do we publish a single-container "all-in-one" image for evaluation (PocketBase-style, one process, SQLite-free but single-node), alongside the compose stack? Cheap demo win, real support risk.

## Dependencies

- Builds on: [local development](02-local-development.md) (the compose seed, D-027), [open-source strategy](../12-business/04-open-source-strategy.md) (D-098, D-099), [dashboard IA](../09-dashboard/01-dashboard-ia.md), [backups & PITR](../03-database-platform/05-backups-and-pitr.md) (D-019), [rest-api-design](../04-data-api/01-rest-api-design.md) (D-101)
- Feeds: [cli spec](01-cli-spec.md) (`keys mint --selfhost`), [testing strategy](../13-quality/01-testing-strategy.md) (the compose stack is the CI fixture), [risk register](../15-risks/01-risk-register.md)
