# Credentials & Secrets

## Purpose

Enumerates every credential a project carries, draws the customer-visible / Steadhold-internal line, specifies generation and storage (envelope encryption per D-035, with the master-key backend chosen here for a bootstrap-stage company), and gives step-by-step rotation flows — including what happens to connections that are alive when a credential rotates. The proposal's treatment (§13, §48: "encrypted secrets, rotation, never plaintext unnecessarily") was directionally right and operationally empty; this doc is the operational content.

## Design

### 1. Credential inventory per project

Database roles (created at provision/claim time, [provisioning §4](01-postgres-provisioning.md)):

| Credential / role | Login? | Purpose | Who sees the secret |
|---|---|---|---|
| `postgres` (superuser) | yes | Steadhold-internal only: provisioner specialization, pgBackRest, node agent, break-glass ops (JIT, audited — [audit & admin access](../02-control-plane/05-audit-and-admin-access.md)) | **Never the customer** |
| `authenticator` | yes, `NOINHERIT` | PostgREST's login role; immediately `SET ROLE`s per request | Never the customer (lives only in PostgREST config) |
| `pgbouncer_auth` | yes | auth_query lookup ([pooling §4](02-connection-pooling.md)) | Never the customer |
| `developer` | yes | The customer's `DATABASE_URL` / `DIRECT_DATABASE_URL` role: owns application schemas, can create tables/policies/functions; `NOSUPERUSER NOCREATEROLE NOREPLICATION`, no server-file/program role grants ([threat model](../06-security/01-threat-model.md)) | **Customer** |
| `anon` | **NOLOGIN** | Assumed via `SET ROLE` by PostgREST for anonymous requests (D-029) | n/a — no password exists |
| `authenticated` | **NOLOGIN** | Assumed via `SET ROLE` for JWT-bearing user requests | n/a |
| `service_role` | **NOLOGIN** | Assumed via `SET ROLE` for service-key requests; `BYPASSRLS` per [RLS design](../06-security/02-rls-design.md) | n/a |

The NOLOGIN trio is deliberate: API-facing privilege levels have **no password to leak, phish, or rotate** — they are reachable only through `SET ROLE` from `authenticator`, which is reachable only inside the project network. Compromising an API key never yields a database login.

Non-role credentials:

| Credential | Purpose | Who sees it |
|---|---|---|
| Project JWT keypair (ES256, D-014) | Signs auth-service tokens and the two API keys; public half at the project JWKS endpoint | Customer sees **public** key only |
| `anon` API key (long-lived JWT, D-029) | Client-side key; maps to `anon`/`authenticated` roles | Customer (publishable) |
| `service_role` API key (long-lived JWT) | Server-side key; bypasses RLS | Customer (secret — server-side only, loudly documented) |
| pgBackRest repo cipher-pass | Per-project backup encryption ([backups §6](05-backups-and-pitr.md)) | Never the customer |
| Internal service tokens | Control-plane ↔ node-agent / gateway auth | Never the customer |
| Customer app secrets (proposal §48: env vars, OAuth creds) | Arbitrary customer-defined secrets | Customer (write + read-back per project role) |

### 2. Generation

- All passwords/tokens: **32 bytes from the platform CSPRNG (`crypto.randomBytes`), base64url — 43 chars, ~256 bits**. No wordlists, no ambiguity trimming (these are never typed by hand).
- Postgres stores only SCRAM-SHA-256 verifiers (`password_encryption = scram-sha-256`, [provisioning §3](01-postgres-provisioning.md)). The plaintext exists in the control plane solely to render connection strings for the customer — encrypted as §3, never logged, never in `project_databases` proper (proposal §58 honored).
- JWT keypairs: P-256 generated in the control plane at provision; private key immediately envelope-encrypted; `kid` per the api-keys scheme `cbk_YYYY_MM_<4hex>` (e.g. `cbk_2026_08_7f3a`).
- API keys: JWTs signed with the project key — `{ iss, ref, role: "anon" | "service_role", iat, exp: iat+10y }` with the `kid` in the header ([api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md), D-107). The `ref` claim binds the key to its project — the gateway cross-checks it against the resolved Host. Keys carry **no `jti`** and are never stored as JWTs: they are deterministically re-derived on demand (RFC 6979 signing over fixed claims with the stored `iat`), byte-identical across reveals. Revocation is by SHA-256 `key_hash` in the gateway's in-memory revocation set (≤30 s propagation, D-104) — never a control-plane registry check per request (D-051).

### 3. Storage: envelope encryption (D-035) and the master-key choice

Every secret row is encrypted with its **own data key (DEK)**; DEKs are wrapped by a **master key (KEK)**:

```sql
-- control-plane table (full DDL in ../02-control-plane/01-data-model.md)
project_secrets(
  id uuid pk, project_id, name,
  ciphertext bytea,        -- XChaCha20-Poly1305(secret, DEK), nonce prepended
  dek_wrapped bytea,       -- crypto_secretbox(DEK, KEK)
  kek_id text,             -- which master key wrapped this DEK (enables KEK rotation)
  version int, created_at, rotated_at
)
```

AAD binds `(project_id, name, version)` into the AEAD so ciphertexts cannot be swapped between rows undetected.

**Master-key backend — the bootstrap-stage analysis:**

| | Cloud KMS (AWS/GCP KMS) | Sealed keyfile (libsodium/age) on control plane |
|---|---|---|
| Key material exposure | Never leaves HSM; unwrap is an API call | Key in memory of the control-plane process; file on disk (root-only) |
| Dependency | Adds a second cloud to a Hetzner+Cloudflare stack (D-023); KMS outage blocks provisioning and secret reads | None — self-contained |
| Latency/cost | Per-unwrap network call (mitigable with caching that weakens the model) | Zero |
| Audit | Native per-unwrap audit log | Only our own application audit log |
| Compliance story | Strong (SOC 2 answer is one sentence) | Weaker — "key next to data" objection is real |
| Bootstrap ops | IAM, credentials for the KMS itself (turtles) | One file + offline copies |

**Choice: sealed keyfile now, KMS later by design** (D-075). At bootstrap stage, the realistic threat is a leaked control-plane *database* (backup theft, SQL injection, misconfigured dump) — envelope encryption with a KEK that is **not in the database** fully answers that, and a file-based KEK answers it as well as KMS does. The threats KMS additionally covers (compromise of the control-plane *host* itself) already imply game-over for a company whose control plane orchestrates every project. Mechanics:

- KEK generated offline, 32 bytes; lives at `/etc/steadhold/kek.d/<kek_id>.key`, `root:steadhold 0440`, on control-plane nodes only; loaded into process memory at boot; **excluded from every backup** (a control-plane DB backup without the KEK is safe by construction).
- Two offline copies (sealed envelopes, separate physical locations) — loss of the KEK is loss of every secret.
- `kek_id` column makes KEK rotation an online re-wrap job (unwrap DEK with old, wrap with new, flip `kek_id`; ciphertexts untouched).
- **Migration trigger to a real KMS:** first enterprise/compliance-driven customer, SOC 2 start, or >2 people with control-plane root. The `kek_id` indirection makes the migration a re-wrap job, not a redesign.

### 4. Rotation flows

All rotations are audited events (proposal §59) and run as idempotent jobs.

**4a. Developer DB password** (customer-initiated, dashboard/CLI):

1. Generate new password (§2); begin control-plane transaction: write new secret version, keep old marked `retiring`.
2. `ALTER ROLE developer WITH PASSWORD '<new>'` via internal admin connection (direct, not pooled).
3. Commit; dashboard now renders the new `DATABASE_URL` / `DIRECT_DATABASE_URL`.
4. PgBouncer needs **nothing** — auth_query reads `pg_shadow` live (the payoff of D-074).
5. **Running connections: unaffected.** Postgres authenticates at connect time only; established sessions survive a password change. New connections with the old password fail immediately.
6. Optional `--terminate` flag: `pg_terminate_backend` for all `developer` sessions + `RECONNECT`/`KILL` on the pooler — offered for compromise response, not default.
7. Old secret version purged after 24h (kept briefly for support diagnosis of "which credential is my app on").

**4b. Project JWT keypair** (rare; compromise or policy):

Constraint: the keypair signs both auth-service tokens *and* the two API keys (D-014, D-029) — so keypair rotation **includes** API-key reissue, and the JWKS needs a dual-publish window so in-flight access tokens stay verifiable.

1. Generate keypair B (new `kid`, e.g. `cbk_2026_11_a91c`); store encrypted.
2. **Dual-publish JWKS**: endpoint serves public A + public B. Data-plane verifiers (gateway, PostgREST config, auth service) already select by `kid`.
3. Auth service signs all *new* access/refresh-derived tokens with B.
4. Reissue API keys under B — re-derived deterministically per D-107 ([api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md)); customer swaps them at their pace within the window.
5. Wait out the JWKS dual-publish/retirement window — default **30 days**, gated on the customer's API-key swap (OQ-104, [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md)); access tokens are short-lived per [sessions & tokens](../05-auth/02-sessions-and-tokens.md) and never the binding constraint. Compressible to minutes in compromise mode.
6. Remove A from JWKS; gateway rejects `kid=A`; mark A destroyed. Anything still on old API keys now fails loudly with `invalid_api_key_rotated` and a docs link.

**4c. API keys (anon / service_role)** — there is **no per-key rotation flow**: the keys are deterministic derivations of the project keypair (D-107), so rotating them *is* rotating the keypair — flow 4b, which reissues both keys under the new `kid`. Revocation of the old keys is by `key_hash` in the gateway revocation set at retirement (step 6; ≤30 s propagation, D-104). Rotating keys never touches DB roles — the NOLOGIN design means nothing database-side changes.

**4d. Internal credentials** (`authenticator`, `pgbouncer_auth`, service tokens, backup cipher-pass):

- `authenticator` / `pgbouncer_auth`: same as 4a plus a config re-render and container `SIGHUP`/restart of PostgREST (its `db-uri` embeds the password). Scheduled with the minor-update batching in [extensions & upgrades §5](06-extensions-and-upgrades.md); annual by policy, immediate on incident.
- Internal service tokens: short-lived (hours), auto-rotated; never persisted beyond memory + Redis with TTL.
- Backup cipher-pass: **not rotatable in place** (pgBackRest encrypts the whole repo under it); rotation = new stanza + new full backup under new pass, old repo expires per retention. Done only on compromise.

### 5. What the customer sees — the complete list

`DATABASE_URL`, `DIRECT_DATABASE_URL` (developer role), anon key, service_role key, JWKS/public key, their own app secrets. **Nothing else exists for them**: no superuser, no `authenticator`, no pooler internals, no backup keys. Every customer-visible secret is individually rotatable from the dashboard without a support ticket — rotation UX is a first-class screen ([dashboard IA](../09-dashboard/01-dashboard-ia.md)), because a credential you're scared to rotate is a credential you'll leak and keep.

## Decisions

**D-075 — Envelope-encryption master key (KEK) is a libsodium-sealed keyfile on control-plane nodes for the bootstrap stage: 32-byte KEK at `/etc/steadhold/kek.d/<kek_id>.key` (root-only, excluded from all backups, two offline copies), XChaCha20-Poly1305 for DEKs and secrets with AAD binding `(project_id, name, version)`; `kek_id` indirection makes KEK rotation and the later KMS migration an online re-wrap job. KMS migration triggers: first compliance-driven customer, SOC 2 start, or >2 control-plane root holders.** *(Rationale: the bootstrap-stage threat is a leaked control-plane database, which a non-DB-resident KEK fully answers; a cloud KMS would add a second cloud dependency on the provisioning hot path (D-023) for protection against host compromise that is already game-over; the kek_id column keeps the exit cheap.)*

**D-187 — Envelope crypto is ChaCha20-Poly1305 (IETF, 96-bit nonce) from Node's built-in `crypto`, not XChaCha20-Poly1305.** *(Rationale: XChaCha20 needs libsodium — a native dependency and build step in every image that touches a secret. Its extended nonce exists so random nonces remain safe when one key encrypts an unbounded number of messages; under D-035 each DEK encrypts exactly one secret version, so a random 96-bit nonce has no reuse exposure. The AAD binding of `(project_id, name, version)` is unchanged and is what actually prevents ciphertexts from being swapped between rows. Revisit only if a single key is ever reused across a large message population.)*

**D-189 — The customer's `developer` role is granted `USAGE ON SCHEMA information_schema`.** *(Rationale: the project image revokes `information_schema` from `PUBLIC` so anonymous clients cannot enumerate a project's shape, but that also blocked the customer's own role: `\d` in psql, ORM introspection and every migration tool read `information_schema`, so a brand-new project could not be introspected by its owner. `information_schema` filters itself to objects the caller holds privileges on, so the grant exposes the customer's own database and nothing more; `anon` and `authenticated` keep no access.)*

**D-192 — `nodes.address` is the route to a node; `nodes.hostname` is only its identity.** *(Rationale: the control plane opens direct admin connections to project databases (role DDL, password rotation), and a hostname that does not resolve from the control plane makes that impossible — which is the case in every environment where the control plane is not on the node's DNS. An admin connection to a node with no recorded address is refused, not guessed.)*

(D-035 remains the governing decision; this doc implements it. Role model interlocks with D-029; JWT mechanics with D-014.)

## Open Questions

- **OQ-074** — Should the control plane store customer DB passwords at all after first render (vs. show-once, storing only the SCRAM verifier server-side)? Show-once is strictly safer but makes the dashboard's "copy connection string" affordance worse and support harder. Decide with dashboard UX. (The API-key half of this question is settled by D-107: the two project keys are re-derived on demand, with `service_role` behind a reveal-click — not show-once.)
- **OQ-075** — Formal key-holder policy for the offline KEK copies (who, where, check cadence) — a one-page runbook owed before first paying customer; owned with [audit & admin access](../02-control-plane/05-audit-and-admin-access.md).

## Dependencies

- Builds on: [decision log](../00-foundation/05-decision-log.md) (D-014, D-029, D-035), [postgres provisioning](01-postgres-provisioning.md), [connection pooling](02-connection-pooling.md), [control-plane data model](../02-control-plane/01-data-model.md)
- Feeds: [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md), [sessions & tokens](../05-auth/02-sessions-and-tokens.md), [threat model](../06-security/01-threat-model.md), [platform security](../06-security/04-platform-security.md), [backups & PITR](05-backups-and-pitr.md), [dashboard IA](../09-dashboard/01-dashboard-ia.md)
