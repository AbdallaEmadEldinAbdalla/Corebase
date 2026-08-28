# Local Development (`corebase dev`)

## Purpose

Specifies the local stack behind `corebase dev` (proposal §44, D-027): the Docker Compose stack the CLI generates and manages, its services and ports, the startup sequence, the local key story, and — stated as an invariant, not a hope — **path parity with production**, so the same SDK code runs locally and in prod by swapping exactly one URL. Also covers teardown, CI usage, and the relationship between this compose file and future self-hosting.

## Design

### The invariant

> **An app built against `http://localhost:54321` works against `https://<ref>.corebase.co` — and vice versa — by changing only the URL and keys passed to `createClient`.**

This is the whole point of D-027 ("local/prod parity is a top-3 Supabase lesson"). It holds because the local stack runs the **same components as prod** — Postgres 17 (D-037), PgBouncer in transaction mode (D-015), PostgREST (D-011), the in-house auth module (D-013), the storage module over MinIO (D-017) — behind a **local gateway shim** that reproduces prod's path dispatch (`/rest/v1`, `/auth/v1`, `/storage/v1` — [system architecture](../01-architecture/01-system-architecture.md), [domain & region model](../01-architecture/04-domain-and-region-model.md)) on one port. Anything that would break the invariant (a local-only path, a local-only header requirement) is a bug against this doc.

### The stack

`corebase dev` renders a Compose file into `corebase/.corebase/compose.yaml` (generated, gitignored, regenerated from `config.toml` on every start — hand edits don't survive and aren't supported) and manages it via the Docker API. Ports come from `config.toml` `[local]`; defaults:

| Service | Image | Host port | Role |
|---|---|---|---|
| `gateway` | `corebase/gateway-local` | **54321** | Mimics `<ref>.corebase.co` routing: `/rest/v1/*` → postgrest, `/auth/v1/*` → auth, `/storage/v1/*` → storage. Injects the same headers the prod gateway would; validates the local keys |
| `db` | `corebase/postgres:17` (the prod image — [provisioning](../03-database-platform/01-postgres-provisioning.md)) | **54322** | Direct Postgres; superuser `postgres`/`postgres` locally |
| `pooler` | `corebase/pgbouncer` | **54329** | Transaction-mode pooling, same config template as prod (D-015) — so prepared-statement surprises surface locally, not in prod |
| `rest` | `postgrest/postgrest` (pinned tag) | — (internal) | Reached only via gateway `/rest/v1`, same as prod |
| `auth` | `corebase/auth-local` | — (internal) | The monolith's auth module in local mode: signs with the dev keypair, sends mail to `mail` instead of real SMTP |
| `storage` | `corebase/storage-local` | — (internal) | The storage module pointed at MinIO instead of R2 (same S3 API, D-017) |
| `minio` | `minio/minio` (pinned tag) | **54323** (console) | Object store; S3 API stays on the compose network. Console login `corebase`/`corebase` |
| `mail` | `axllent/mailpit` (pinned tag) | **54324** (web UI) | Catches every email the auth module sends (verification, reset); SMTP internal only |

All containers sit on one compose network with healthchecks; nothing but the five host ports above is published. Images are pinned by tag+digest in the CLI release, so a given CLI version always starts an identical stack.

### Startup flow

`corebase dev`:

1. Preflight: Docker reachable (else exit 7 with install hint), ports free (else name the squatter), `config.toml` `db.major_version` == 17 (D-037).
2. Pull missing images → start containers → wait for healthchecks in dependency order (db → pooler → rest/auth/storage → gateway).
3. Apply `corebase/migrations/*.sql` in timestamp order against the local db (same code path as `db push`, recorded in the same local migrations table).
4. Apply `corebase/seed.sql` (if present and `[dev] seed = true`).
5. Print the summary block and detach (stack keeps running; `corebase dev` on a running stack re-applies pending migrations and reprints the block).

```
$ corebase dev
✔ Docker ready
✔ Images up to date (8 pinned)
✔ Started: db · pooler · rest · auth · storage · minio · mail · gateway
✔ Applied 4 migrations
✔ Applied seed.sql

  Corebase local stack running — stop with `corebase dev stop`

          API URL:  http://localhost:54321
           DB URL:  postgres://postgres:postgres@localhost:54322/postgres
       Pooled URL:  postgres://postgres:postgres@localhost:54329/postgres
    MinIO console:  http://localhost:54323   (corebase / corebase)
      Mail viewer:  http://localhost:54324
         anon key:  eyJhbGciOiJFUzI1NiIsImtpZCI6ImNvcmViYXNlLWxvY2FsIn0…
 service_role key:  eyJhbGciOiJFUzI1NiIsImtpZCI6ImNvcmViYXNlLWxvY2FsIn0…
```

`--json` emits the same as one object for scripting.

### Local keys — deterministic, and never valid in prod (D-138)

The local `anon` and `service_role` keys are long-lived JWTs (mirroring D-029) signed with a **well-known ES256 dev keypair that ships in the CLI package** — the same on every machine, printed in the docs, deterministic across `dev destroy`. That's deliberate: local keys you can commit to a README remove a whole class of onboarding friction.

Why a leaked/committed dev key can never touch production — guaranteed twice over:

1. **Different `iss` and `kid`:** dev tokens carry `iss: "corebase-local"`, prod tokens carry the project issuer; the prod gateway and PostgREST verify against the **per-project JWKS** (D-014), which never contains the dev public key.
2. The dev private key is public by definition, so it is structurally excluded from every prod signing path — no code path exists that loads it outside `corebase dev`.

The converse also holds: prod keys don't verify locally (the local gateway trusts only the dev public key), so nobody accidentally points local tooling at prod data.

### Honesty table: local ≠ prod

Parity is about **paths and components**, not the whole platform. What the local stack does *not* reproduce:

| Prod behavior | Local behavior |
|---|---|
| Cloudflare edge, WAF, DDoS (D-016) | None — gateway shim on localhost |
| Rate limiting (D-033) | Off |
| Pause/resume (D-008) | N/A — stack runs until you stop it |
| Backups & PITR (D-019) | None — `dev destroy` is data loss, by design |
| Real email delivery ([email infrastructure](../05-auth/04-email-infrastructure.md)) | Mailpit viewer at :54324; nothing leaves the machine |
| R2 object storage (D-017) | MinIO (same S3 API, different operational envelope) |
| TLS everywhere (D-050) | Plain HTTP on localhost |
| Usage metering & quotas | None |
| Multi-project routing by ref | One implicit project; the gateway ignores Host |

### `corebase dev --db-only`

Lightweight mode for schema work and unit tests: starts **db + pooler only**, applies migrations and seed, prints the two DB URLs. No gateway/REST/auth/storage — roughly 10× less RAM and a ~2s start after first pull. `corebase dev` on top of a `--db-only` stack upgrades it in place.

### Teardown & reset

- **`corebase dev stop`** — stops containers, **keeps volumes** (data survives; next `dev` is warm).
- **`corebase dev destroy`** — removes containers **and volumes**. Prompts unless `--yes` (local-only data, so `--yes` suffices here — unlike `projects delete`).
- **`corebase db reset`** — drop + recreate the local database, replay migrations, re-seed, containers untouched (see [CLI spec](01-cli-spec.md)). The everyday "clean slate".

### Relationship to self-hosting

This compose file is the **self-host seed** ([open-source strategy](../12-business/04-open-source-strategy.md), D-034): the local stack is already "Corebase without the control plane", and the eventual self-host distribution is this file plus prod-hardening deltas (real TLS, real keys, real SMTP, backups). Keeping one generated compose definition for both purposes is why hand edits to the generated file are unsupported — the file must stay a build artifact the CLI owns. Local mode is also the natural landing target for a `corebase export` tarball (D-137), which is how the portability claim gets demoed.

### CI usage

The stack is the integration-test fixture ([testing strategy](../13-quality/01-testing-strategy.md)): real Postgres, real PostgREST, real RLS — no mocks of the data plane, ever.

```yaml
# .github/workflows/integration.yml
jobs:
  integration:
    runs-on: ubuntu-latest        # Docker preinstalled
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install -g corebase
      - run: corebase dev --db-only   # or full `corebase dev` for API/auth/storage tests
      - run: npm test                 # tests hit localhost:54322 / :54321
      - run: corebase dev stop
        if: always()
```

`corebase dev` exits 0 only after every healthcheck passes and migrations applied — no sleep-and-hope. `CI=1` disables the update check (D-136) and interactive prompts automatically.

## Decisions

- **D-138 — Local dev keys are JWTs signed by a well-known deterministic ES256 dev keypair shipped in the CLI, with `iss: "corebase-local"`; production validity is impossible because prod verifies only against per-project JWKS (D-014) that never contain the dev key, and the issuer differs. Path parity (`/rest/v1`, `/auth/v1`, `/storage/v1` on one local URL) is a binding invariant of the local gateway shim.** *(Rationale: deterministic keys make local onboarding one command and keep committed dev keys harmless; the double guarantee (key set + issuer) means the safety doesn't hinge on developer discipline. Making path parity an invariant, not a convention, is what lets the SDK promise "swap one URL".)*

(The stack composition itself is D-027, already locked; ports and the generated-compose ownership model are spec details of this doc, not new decisions.)

## Open Questions

- **OQ-137** — Non-Docker-Desktop runtimes: Podman, Colima, OrbStack. The CLI talks the Docker API, so these mostly work — do we test and claim support (a support matrix) or say "Docker only" for V1?
- **OQ-138** — Dev profiles between `--db-only` and the full stack (e.g. db+auth without storage): real demand or flag creep? Deferred until asked for twice.

## Dependencies

- **Builds on:** [CLI spec](01-cli-spec.md) (command surface, config.toml) · [Postgres provisioning](../03-database-platform/01-postgres-provisioning.md) (prod images/stack shape) · [connection pooling](../03-database-platform/02-connection-pooling.md) (D-015) · [migrations](../03-database-platform/04-migrations.md) (apply semantics) · [sessions & tokens](../05-auth/02-sessions-and-tokens.md) (D-014 JWKS) · [storage architecture](../07-storage/01-storage-architecture.md) (D-017 MinIO) · [system architecture](../01-architecture/01-system-architecture.md) (path dispatch being mirrored)
- **Feeds:** [SDK spec](03-sdk-spec.md) (the one-URL-swap promise) · [testing strategy](../13-quality/01-testing-strategy.md) (CI fixture) · [open-source strategy](../12-business/04-open-source-strategy.md) (self-host seed) · [open questions](../15-risks/02-open-questions.md)
