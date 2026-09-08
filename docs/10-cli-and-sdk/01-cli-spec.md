# CLI Spec (`steadhold`)

## Purpose

The full command surface of the `steadhold` CLI (proposal §45, §91): authentication against the control plane, project scaffolding and linking, migrations, local development, secrets, logs — and `steadhold export`, the D-004 portability flagship. This doc is the contract for the CLI package; the [local development](02-local-development.md) doc owns everything behind `steadhold dev`, and [migrations](../03-database-platform/04-migrations.md) owns the exact `db push/pull/reset` semantics (summarized here, never contradicted).

## Design

### Distribution & implementation

Per **D-026**: TypeScript, lives in the monorepo (D-010), distributed via npm — `npm install -g steadhold` — with standalone binaries later. Implementation choices (D-135):

- **Framework: commander** — boring, ubiquitous, zero-dependency-drama. Clipanion's class-per-command model buys type rigor the CLI's flat command tree doesn't need.
- **Node ≥ 20** required (matches the monorepo toolchain); the CLI refuses to start on older runtimes with a clear message rather than failing mid-command.
- All control-plane calls go to the [platform API](../02-control-plane/02-platform-api.md) (`api.steadhold.dev/v1`) authenticated with a PAT (`Authorization: Bearer shp_...`, D-062); the CLI sends `Idempotency-Key` on every mutating call it generates.

### Credential storage (D-135)

`steadhold login` stores the PAT in the **OS keychain** (macOS Keychain, Windows Credential Manager, libsecret on Linux) via a keytar-equivalent native binding, under service `steadhold-cli`, account = the platform user's email. Where no keychain is available (headless Linux, CI containers, WSL without a secret service):

- fallback file `~/.steadhold/credentials` (TOML), created with mode **0600** and `~/.steadhold/` with 0700;
- on every read, the CLI checks the mode and **refuses to use the file if it is group/world-readable** (exit 3, message tells the user to `chmod 600`);
- `STEADHOLD_ACCESS_TOKEN` env var overrides both (the CI path — no file ever written).

### Configuration precedence

Highest wins: **command-line flags → `STEADHOLD_*` environment variables → `steadhold/config.toml` → built-in defaults.** Env var names are the flag name upper-snake-cased with the prefix (`--project` → `STEADHOLD_PROJECT`; `STEADHOLD_ACCESS_TOKEN`, `STEADHOLD_API_URL` for self-host/staging).

### Project directory & `config.toml`

`steadhold init` scaffolds:

```
steadhold/
├── config.toml
├── migrations/          # timestamped .sql files (D-028)
└── seed.sql             # applied by `steadhold dev` after migrations; never applied to remote
```

```toml
# steadhold/config.toml
[project]
# Set by `steadhold link`; empty until linked.
ref = "kxqwrtplmzensfba"

[local]
# Ports the `steadhold dev` stack binds on localhost (see 02-local-development.md).
gateway_port = 54321     # /rest/v1, /auth/v1, /storage/v1 — same paths as prod
db_port      = 54322     # direct Postgres
pooler_port  = 54329     # PgBouncer, transaction mode (D-015)
minio_console_port = 54323
mail_port    = 54324     # local mail viewer UI

[db]
major_version = 17       # must match the fleet version (D-037); dev refuses others

[dev]
seed = true              # apply seed.sql on `steadhold dev` start/reset
```

`config.toml` is committed to the user's repo; credentials never live in it.

### Global flags

| Flag | Effect |
|---|---|
| `--project <ref>` | Override the linked project for this invocation |
| `--json` | Machine-readable output: exactly one JSON document on stdout, human text moves to stderr; stable field names are part of this spec's compat surface |
| `--yes` / `-y` | Skip interactive confirmations (destructive commands still require their typed/explicit confirmation — see `projects delete`, `db reset`) |
| `--api-url <url>` | Control-plane base URL (self-host / staging) |
| `--debug` | Verbose HTTP + Docker tracing to stderr; secrets redacted |

### Command reference

#### `steadhold login`

```
steadhold login [--token <pat>] [--no-browser]
```

**Behavior:** OAuth-style **device-code flow** against the control plane: the CLI calls `POST /v1/auth/device/code`, prints a short user code and verification URL (`app.steadhold.dev/cli/verify`), opens the browser (unless `--no-browser`), and polls `POST /v1/auth/device/token` (5s interval, honoring `slow_down`) until the user approves in the dashboard. The control plane mints a PAT scoped `write` (D-062) named `cli-<hostname>`; the CLI stores it per D-135 and prints the account it is logged in as. `--token` skips the flow and stores a pre-created PAT (the CI escape hatch, though `STEADHOLD_ACCESS_TOKEN` is preferred there).
**Failure modes:** device code expired (15 min) → exit 3 with re-run hint; user denied → exit 3; no keychain and fallback file unwritable → exit 1; already logged in → re-login replaces the stored token after confirming.

#### `steadhold logout`

```
steadhold logout [--all]
```

**Behavior:** revokes the stored PAT server-side (`DELETE /v1/auth/tokens/:id`), then deletes it from the keychain/fallback file. `--all` revokes every `cli-*` PAT for the account. **Failure modes:** revocation call fails (network/expired) → the local credential is still deleted and a warning tells the user to revoke in the dashboard; exit 0 in that case (local logout succeeded).

#### `steadhold init`

```
steadhold init [--force]
```

**Behavior:** scaffolds the `steadhold/` directory above in the current working directory. Idempotent: existing files are never overwritten without `--force`; missing pieces are added. Does not require login. **Failure modes:** `steadhold/` exists with unrecognized layout → exit 5 listing conflicts; no write permission → exit 1.

#### `steadhold link`

```
steadhold link --project <ref>
```

**Behavior:** verifies the ref exists and the PAT can access it (`GET /v1/projects/:ref`), then writes `project.ref` into `config.toml`. Prints the project name, org, and region as confirmation. **Failure modes:** not logged in → exit 3; ref not found / no access → exit 4 (the platform API deliberately doesn't distinguish, no existence oracle); no `steadhold/` dir → exit 4 with `steadhold init` hint.

#### `steadhold status`

```
steadhold status
```

**Behavior:** two sections. **Local:** whether the dev stack is running, per-container health, ports (from Docker labels — see [local development](02-local-development.md)). **Remote:** linked project's `GET /v1/projects/:ref/health` (db/pooler/postgrest/auth/storage), status (`ready`/`paused`/…), and pending-migration count (local files not yet in the remote migrations table). Works partially: no login → local section only, with a note. `--json` emits both as one object. **Failure modes:** none fatal; unreachable pieces are reported as `unknown`.

#### `steadhold dev` (and `dev stop`, `dev destroy`, `--db-only`)

Owned by [local development](02-local-development.md) — the Docker Compose stack of the same components as prod (D-027), started, migrated, and seeded with one command. This doc only reserves the names: `dev`, `dev stop`, `dev destroy`, flag `--db-only`.

#### `steadhold db push | pull | reset`

Exact semantics — ordering, the remote migrations table, shadow-DB verification, dirty-state handling — are defined in [migrations](../03-database-platform/04-migrations.md) (D-028) and summarized here:

- **`db push [--dry-run]`** — applies local `migrations/*.sql` not yet recorded in the remote project's migrations table, in timestamp order, each in a transaction, recording each as it lands. `--dry-run` lists what would run. Refuses (exit 5) if remote history contains a migration the local dir lacks (divergence → resolve via `db pull`).
- **`db pull`** — introspects the remote schema and writes it as a new local migration file; used to adopt dashboard/SQL-editor changes into version control.
- **`db reset`** — **local stack only** in V1: drops and recreates the local database, replays all migrations, applies `seed.sql`. Never touches the remote (resetting a remote DB is a dashboard-with-typed-confirmation operation, not a CLI habit).
- `db diff` ships in V1.1 (D-028), shadow-DB based; the CLI reserves the name and prints a not-yet message until then.

**Failure modes:** unapplied-migration SQL error → transaction rolls back, remote table untouched, exit 1 with file+line; paused project → the gateway resume flow (D-072) is triggered and push retries once.

#### `steadhold migration new <name>`

```
steadhold migration new add_profiles
```

**Behavior:** creates `steadhold/migrations/<UTC timestamp>_add_profiles.sql` (e.g. `20260827130000_add_profiles.sql`, §43) with a comment header. `migration create` is accepted as an alias for §43 muscle memory. **Failure modes:** name not `[a-z0-9_]+` → exit 2; duplicate timestamp collision → increments one second.

#### `steadhold export` — the D-004 flagship

```
steadhold export [--output <path>] [--include-objects] [--no-data]
```

**Behavior:** produces a complete, self-describing portability snapshot of the linked project as a tarball. Everything needed to stand the project up elsewhere — another Steadhold, a self-hosted stack, or bare Postgres. Layout (D-137, `format_version: 1`):

```
steadhold-export-<ref>-<UTC timestamp>.tar.gz
├── export.json                 # manifest: format_version, ref, created_at, tool version,
│                               #   pg major version, per-file sha256 checksums, contents flags
├── database/
│   ├── schema.sql              # pg_dump --schema-only (plain SQL — readable, greppable)
│   └── data.dump               # pg_dump -Fc custom-format archive (omitted with --no-data)
├── migrations/                 # the migration files as recorded in the remote history
│   └── 20260827130000_....sql
├── auth/
│   ├── users.jsonl             # one user per line: id, email, password hash (argon2id PHC),
│   │                           #   confirmation state, metadata, timestamps
│   └── REIMPORT.md             # hash format + how to load into another Steadhold or your own auth
├── storage/
│   ├── manifest.jsonl          # per object: bucket, key, size, sha256/etag, content_type, owner, created_at
│   └── objects/...             # actual objects, bucket/key layout — only with --include-objects
└── config/
    └── project.json            # project settings, bucket definitions, RLS-relevant roles,
                                #   secret NAMES only (values are write-only server-side, D-035)
```

Notes that are part of the contract:

- **`auth/users.jsonl` includes password hashes.** The CLI prints a security warning before writing and `REIMPORT.md` repeats it: the tarball is now credential material — store it encrypted, treat like a DB backup. Hashes are argon2id PHC strings (D-111); a minority may still be bcrypt — imported users who never logged in again, accepted verify-only per D-111. Re-import into Steadhold is lossless; re-import into other systems needs argon2id verification support (plus bcrypt for that residue) or a reset-passwords-on-import path (all documented in `REIMPORT.md`).
- **Secret values are never exported** — the platform stores them write-only (D-035); names appear in `config/project.json` so the operator knows what to re-provision.
- `--include-objects` streams every storage object through the storage API into `storage/objects/`; without it you get the manifest only (re-fetchable later — the manifest carries enough to verify a separate sync).
- Dumps run through the platform's export endpoint (server-side `pg_dump` against the project DB — the CLI never needs direct DB credentials), streamed to disk; nothing is buffered wholly in memory.

**Failure modes:** project paused → resume triggered, export waits; `--include-objects` on a huge project → progress bar + resumable? no — V1 restarts on failure, exit 6 with partial file removed; disk full → exit 1, partial file removed; checksum mismatch on verify pass → exit 1 (never emit a silently corrupt export).

#### `steadhold projects create | list | delete`

```
steadhold projects create --name <name> --org <org_id> [--region eu-central] [--plan free]
steadhold projects list [--org <org_id>]
steadhold projects delete <ref>
```

**Behavior:** thin wrappers over `POST/GET/DELETE /v1/projects` ([platform API](../02-control-plane/02-platform-api.md)). `create` sends an `Idempotency-Key`, then polls until `ready`, printing keys and connection strings **once** (D-060) with a save-these-now warning. `delete` requires **typed confirmation**: the user must type the project ref exactly (matching the API's `confirm: "<ref>"` body); non-interactively, `--confirm <ref>` must be passed explicitly — **`--yes` alone never suffices for delete.** Prints the 7-day restore window (D-038). **Failure modes:** quota → exit 5 surfacing `QUOTA_EXCEEDED` details; typed ref mismatch → exit 2, nothing sent.

#### `steadhold keys list`

```
steadhold keys list
```

**Behavior:** lists the project's `anon` and `service_role` keys (D-029) — **kind, prefix, created_at only**; full key material is returned exactly once at creation/rotation (D-060) and cannot be re-fetched. Points the user at `POST /v1/projects/:ref/api-keys/rotate` (dashboard or `--json`-scripted call) if a key was lost. **Failure modes:** unlinked → exit 4.

#### `steadhold secrets set | list | unset`

```
steadhold secrets set NAME=value [NAME2=value2 ...] [--env-file <path>]
steadhold secrets list
steadhold secrets unset NAME [NAME2 ...]
```

**Behavior:** `set` upserts via `PUT /v1/projects/:ref/secrets/:name` (values write-only, envelope-encrypted per D-035); `--env-file` bulk-loads a dotenv file. `list` shows names + updated_at, never values. `unset` deletes. Values are read from args or, with `NAME=-`, from stdin (keeps them out of shell history — the CLI also warns when it detects a value passed as a bare argument). **Failure modes:** invalid name (`[A-Z0-9_]+`) → exit 2; secret-count quota → exit 5.

#### `steadhold logs`

```
steadhold logs [--service api|auth|db] [--tail] [--since 1h]
```

**Behavior:** streams the linked project's logs from the control-plane log endpoint (per-project Loki streams, see [observability](../11-infrastructure/03-observability.md)). Default: last 100 lines, all services, newest last. `--tail` follows (SSE); `--service` filters (`api` = gateway+PostgREST, `auth`, `db` = Postgres). `--json` emits one JSON object per line. **Failure modes:** paused project → note + empty stream; retention window exceeded by `--since` → clamped with a warning.

#### `steadhold gen types`

Reserved here, specified in the [SDK spec](03-sdk-spec.md): introspects the linked project (or the local stack with `--local`) and writes TypeScript types for `createClient<Database>()`.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic/unexpected failure (I/O, internal) |
| 2 | Usage error: bad flags, bad arguments, failed typed confirmation |
| 3 | Authentication/authorization failure (not logged in, expired PAT, insufficient scope) |
| 4 | Not found / not linked (project ref, missing `steadhold/` dir) |
| 5 | Refused by state: migration divergence, quota exceeded, conflicting scaffold |
| 6 | Network / control-plane API unavailable (after retries) |
| 7 | Docker unavailable or local stack failure (`dev`, `db reset`) |
| 130 | Interrupted (SIGINT) — partial artifacts cleaned up where possible |

`--json` mode: errors go to stderr as `{ "error": { "code", "message", "request_id" } }` — the same envelope as the platform API (D-032) with CLI-local codes added.

### Update check & telemetry (D-136)

- **Update check:** at most once per 24h, the CLI checks the npm registry for a newer version (cached in `~/.steadhold/update-check.json`) and prints a one-line notice to **stderr**. Disabled by `STEADHOLD_NO_UPDATE_CHECK=1`, in CI (`CI=1`), and in `--json` mode. The check sends nothing but the standard npm registry request.
- **Telemetry: opt-in only.** No usage data, no crash reports, no identifiers leave the machine unless the user runs `steadhold telemetry on` (and `telemetry status` / `off` exist). Default-off is a portability-lane trust signal (D-006) and one less thing to disclose. When enabled: anonymous command name + duration + version, no arguments, no project refs.

## Decisions

- **D-135 — CLI is built on commander (Node ≥ 20); PATs are stored in the OS keychain via a keytar-equivalent, with fallback `~/.steadhold/credentials` created 0600 and refused if group/world-readable; `STEADHOLD_ACCESS_TOKEN` overrides both.** *(Rationale: commander is the boring, universally-understood choice for a flat command tree; keychain-first keeps tokens out of dotfiles, the perms-checked fallback and env override cover headless and CI without weakening the default.)*
- **D-136 — Telemetry is opt-in only (default off, `steadhold telemetry on` to enable); the update check is a 24h-cached npm registry poll, disabled by env var, in CI, and in `--json` mode.** *(Rationale: a portability-pitched tool that phones home by default undercuts its own story; the update nudge is the one growth mechanism cheap enough to keep without collecting anything.)*
- **D-137 — `steadhold export` emits a versioned tarball (`format_version: 1`) with the documented layout: `export.json` manifest with checksums, `database/schema.sql` + `database/data.dump` (pg_dump plain + custom), `migrations/`, `auth/users.jsonl` including password hashes plus `REIMPORT.md`, `storage/manifest.jsonl` (+ objects opt-in), `config/project.json` with secret names only.** *(Rationale: D-004 says portability is the moat — a moat needs a stable, documented artifact format, not a directory of ad-hoc dumps; hashes-with-warning makes exports actually complete, and versioning the format lets it evolve without breaking existing tarballs.)*

## Open Questions

- **OQ-135** — `steadhold import` (the re-import counterpart to export, targeting another Steadhold project or a self-hosted stack): V1.1 candidate or documented-manual-procedure-only? `REIMPORT.md` covers manual paths for now.
- **OQ-136** — PAT scope for the CLI: `login` mints `write` (D-062) — should CI docs steer users to mint read-scoped tokens for verification-only pipelines, and does that need a `--scope` flag on `login --token` creation flows?

## Dependencies

- **Builds on:** [platform API](../02-control-plane/02-platform-api.md) (endpoints, PAT model D-062, error envelope D-032) · [migrations](../03-database-platform/04-migrations.md) (D-028 semantics) · [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md) (D-035) · [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md) (D-029) · [decision log](../00-foundation/05-decision-log.md) (D-004, D-026)
- **Feeds:** [local development](02-local-development.md) (`steadhold dev`) · [SDK spec](03-sdk-spec.md) (`gen types`) · [open-source strategy](../12-business/04-open-source-strategy.md) (CLI is Apache-2.0, D-034) · [testing strategy](../13-quality/01-testing-strategy.md) (CLI in CI) · [open questions](../15-risks/02-open-questions.md)
