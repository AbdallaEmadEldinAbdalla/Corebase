# Auth Architecture

## Purpose

The build-vs-adopt decision for Steadhold Auth (D-013) with its honest tradeoffs, the deployment shape of the auth service, the per-project `auth` schema, and the V1 API surface. This is **customer-app auth**: every Steadhold project gets an auth service for *its* end-users, the way Supabase Auth (GoTrue) serves a Supabase project. Dashboard login to Steadhold itself is control-plane auth — session cookies and PATs against platform accounts — and is specified in [platform API](../02-control-plane/02-platform-api.md), not here. The two share nothing: no tables, no tokens, no keys.

The critical review was blunt that auth "is also an entire product" ([critical review §2.3](../00-foundation/03-critical-review.md)) — the proposal's §16–18 list of features hides refresh rotation, reuse detection, JWKS, enumeration resistance, and an entire email subsystem. This doc and its four siblings ([sessions & tokens](02-sessions-and-tokens.md), [flows](03-flows.md), [email infrastructure](04-email-infrastructure.md), [OAuth & future](05-oauth-and-future.md)) are the correction.

## Design

### Build vs adopt (D-013) — the comparison, honestly

Two credible options existed. D-013 locked the second; the reasoning deserves a permanent record because it is the riskiest build-vs-buy call in the corpus.

| | Fork/embed GoTrue | Build minimal in TypeScript |
|---|---|---|
| Security maturity | **Battle-tested flows**: a decade of production hardening, CVEs found and fixed by someone else, enumeration/timing/rotation edge cases already handled | Every security mistake is **ours** — no inherited hardening |
| Language & stack | Go service in an otherwise-TS monolith (D-010): second toolchain, second deploy artifact, second set of reviewers | One language across API/auth/CLI/SDK; auth is a module of the monolith (D-020) |
| Schema control | GoTrue brings **its own schema and migration history**; forking means tracking upstream migrations or diverging forever | Full control of the `auth` schema — it can be designed for `steadhold export` (D-004) from day one |
| Ops surface | Separate process per deployment, its own config surface, health checks, version upgrades; multi-tenant GoTrue is not its native mode | Zero additional process; rides the monolith's deploy, logging, OTel |
| Scope pressure | Ships ~15 providers, SAML, phone, MFA — features V1 must **not** expose but must still patch | Frozen V1 scope: email/password, verification, reset, JWT + rotating refresh tokens with reuse detection. Nothing else (see the scope-freeze rule in [OAuth & future](05-oauth-and-future.md)) |
| Effort | Days to first boot, weeks to make it multi-tenant and fit our key model (D-014/D-029) | Weeks to build, but every line is in-scope |

The honest statement of the risk: **the single argument for GoTrue is the only argument that matters in auth — inherited hardening.** D-013 accepts that risk with two mitigations: (1) the scope is frozen — a small, boring surface is auditable; (2) GoTrue's threat mitigations are adopted **as a checklist, not as code**. The revisit trigger stands: any CVE-class bug found in our implementation reopens D-013.

### The GoTrue threat-mitigation checklist

Every item below is a hard requirement on the V1 implementation. Each is enforced where noted and tested per [testing strategy](../13-quality/01-testing-strategy.md).

1. **Timing-safe comparisons** for every secret: password verification via the hash library's constant-time verify; token-hash lookups compare digests with `crypto.timingSafeEqual`. When an email does not exist, verify against a **dummy hash** anyway so response time does not reveal account existence.
2. **Enumeration resistance**: signup, `/recover`, `/verify`, and resend endpoints return the same status code, body shape, and (statistically) latency whether or not the email exists. Login returns one generic `invalid_credentials` error for wrong-email and wrong-password alike. (Concrete shapes per flow: [flows](03-flows.md).)
3. **Rate limits per identifier**, not just per IP: buckets keyed on `(project, email)`, `(project, IP)`, and `(project, IP, endpoint)` in Redis at the gateway (D-033), with auth-specific tighter tiers (numbers in [flows](03-flows.md) and [email infrastructure](04-email-infrastructure.md)).
4. **Secure token generation**: all opaque tokens (refresh, one-time) are ≥256 bits from `crypto.randomBytes`, base64url-encoded; never UUIDs, never `Math.random`.
5. **Tokens stored hashed, single-use, expiring**: the database holds SHA-256 digests only (`token_hash`), every one-time token has `expires_at` and `used_at`, and reuse is a hard failure (or a theft signal, for refresh tokens — [sessions & tokens](02-sessions-and-tokens.md)).
6. **No user-controlled redirect without an allowlist**: every `redirect_to` parameter is validated against the project's configured `site_url` + explicit additional-redirects list, exact-match on origin and path prefix. Unlisted → fall back to `site_url`, never to the supplied value. This is the control that prevents verification/recovery links from becoming open redirects and token exfiltrators.
7. **Password hash never leaves the database tier**, is never logged, never serialized into any API response (the user object is an explicit allowlist of fields, not `SELECT *`).
8. **Sessions revocable server-side**; refresh rotation with family revocation on reuse (D-013, spec in [sessions & tokens](02-sessions-and-tokens.md)).
9. **Auth events audited** into `auth.audit_log_entries` (login, logout, failed login, token reuse, password/email change, user created/deleted).
10. **Generic 4xx errors externally, rich detail internally**: error responses never distinguish "user not found" from "wrong password" from "user banned"; the distinction lives in audit rows and logs keyed by `request_id` (D-032).

### Deployment shape: one multi-tenant auth module

Auth is a **module of the modular monolith** (D-020) on the app node — but it serves **data-plane** traffic at `https://<ref>.steadhold.app/auth/v1/*` (request lifecycle C in [system architecture](../01-architecture/01-system-architecture.md)). One process serves all projects:

```text
client ── https://<ref>.steadhold.app/auth/v1/token?grant_type=password
  1. Cloudflare → Caddy → gateway module: extract ref from Host,
     routing-table lookup (D-051), auth-tier rate limits (D-033)
  2. in-process dispatch to the auth module with the resolved
     project context {project_id, node ip, pooler port, key handle}
  3. auth module loads (cached) per-project state:
       - signing keypair: ES256 private key via KMS-decrypt, memory-cached (D-014, D-035)
       - auth config: site_url, redirect allowlist, email templates,
         autoconfirm flag, token lifetimes (control-plane `project_settings`)
  4. auth module connects to the PROJECT's database through its
     PgBouncer (reserved `steadhold_auth` role) and operates on the
     project's `auth` schema
  5. tokens issued with the project's key; response to client
```

Tenant separation inside the shared module is structural, not conventional: every query runs on a connection scoped to the resolved project's database (physically separate per D-009 — there is no cross-project table to leak through), and every signing operation uses the keypair the routing entry carries. The cross-tenant test suite ([tenant isolation tests](../06-security/03-tenant-isolation-tests.md)) covers the auth path explicitly: a token minted for project A must fail verification at project B's PostgREST.

**Rejected: per-project auth containers.** The symmetric design — an auth container in each project's triplet, like PostgREST — was rejected on economics. The container-per-project budget is already three containers and a hard RAM floor per project; D-008 exists because idle RAM is the business-model killer ([cost model](../12-business/01-cost-model.md)). A Node auth container idles at ~80–120 MB RSS; across 1,000 mostly-idle free projects that is ~100 GB of RAM doing nothing — the exact mistake the critical review's §2.1 calls out, repeated in a new subsystem. Auth traffic is also the *lightest* per-project load (a handful of logins/minute at the 95th percentile project), i.e. the best possible candidate for multi-tenant pooling. PostgREST earns its per-project container because it holds a per-database schema cache and long-lived pool; auth holds neither beyond a small per-project config/key cache.

What we give up: per-project crash/upgrade isolation for auth, and the option of per-project auth versions. Accepted — the monolith's deploy discipline covers it, and a bug in shared auth code would be equally present in every per-project container anyway.

### The `auth` schema — lives in each project's database

Customers' users are **their** data. The schema below is created in every project's Postgres at provision time (step 5d of lifecycle A in [system architecture](../01-architecture/01-system-architecture.md)), so `steadhold export` (D-004) carries users, sessions, and identities out with a plain `pg_dump`. Nothing about a project's end-users is stored in the control plane.

```sql
CREATE SCHEMA auth;

-- Only the platform's reserved role may touch auth tables directly.
-- anon/authenticated get EXECUTE on helper functions only.
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO steadhold_auth;

CREATE TABLE auth.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text,
  encrypted_password  text,                      -- argon2id PHC string (D-111); NULL for OAuth-only users (V1.1)
  email_confirmed_at  timestamptz,
  banned_until        timestamptz,
  raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- user-writable via PUT /user
  raw_app_meta_data   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- service_role-writable only
  is_anonymous        boolean NOT NULL DEFAULT false,      -- modeled now, used in V1.2
  last_sign_in_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX users_email_key ON auth.users (lower(email))
  WHERE deleted_at IS NULL;

CREATE TABLE auth.sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at  timestamptz,
  user_agent         text,
  ip                 inet,
  revoked_at         timestamptz
);
CREATE INDEX sessions_user_id_idx ON auth.sessions (user_id);

CREATE TABLE auth.refresh_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash  bytea NOT NULL UNIQUE,             -- sha256(opaque token); plaintext never stored
  user_id     uuid  NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id  uuid  NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
  parent_id   bigint REFERENCES auth.refresh_tokens(id), -- rotation lineage (reuse detection)
  used_at     timestamptz,
  revoked     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_session_idx ON auth.refresh_tokens (session_id);

CREATE TABLE auth.one_time_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_type  text NOT NULL CHECK (token_type IN
                ('confirmation','recovery','email_change_current',
                 'email_change_new','magic_link')),          -- magic_link used from V1.1
  token_hash  bytea NOT NULL,
  relates_to  text,                                          -- e.g. the proposed new email
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  UNIQUE (user_id, token_type)   -- newest token per type replaces the previous
);

CREATE TABLE auth.identities (         -- created in V1, populated from V1.1 (OAuth)
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          text NOT NULL,                -- 'email' | 'google' | 'github' | ...
  provider_user_id  text NOT NULL,
  identity_data     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at   timestamptz,
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE auth.audit_log_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid,                             -- NULL for anonymous attempts
  action         text NOT NULL,                    -- 'login','login_failed','token_reuse_detected',...
  ip             inet,
  user_agent     text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON auth.audit_log_entries (created_at);
```

Notes:

- **`auth.uid()`** — the RLS helper (`SELECT (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid`) is created alongside this schema; it is plain SQL any Postgres can run, which is what keeps the portability claim honest (contradiction C-1 resolution). Detail: [RLS design](../06-security/02-rls-design.md).
- **`raw_user_meta_data` is user-writable** (via `PUT /auth/v1/user`); RLS policies and application authorization must never trust it. Privileged flags belong in `raw_app_meta_data` or app tables. Guidance in [sessions & tokens](02-sessions-and-tokens.md).
- Row schema mirrors GoTrue's shape where reasonable (`raw_user_meta_data`, `identities`) deliberately: it eases migration *to* Steadhold from Supabase, the same argument as D-011.
- Soft delete (`deleted_at`) frees the email for re-registration via the partial unique index while preserving FK integrity for the app's rows.

### Password hashing (D-111)

**scrypt**, not argon2id (**D-313**, extending D-211): argon2id needs a native module, and this module absorbs every project's login load in one process (D-110) — so the compiled dependency would sit on the hottest auth path on the platform. Parameters live in the hash and a weaker hash is upgraded on the next successful verify, which are D-111's properties and the ones that matter. The argon2id profile below is kept for the record of what was intended and what a native toolchain would buy: `memory = 19456 KiB (19 MiB), iterations = 2, parallelism = 1` (OWASP first-recommendation profile), salt 16 bytes, tag 32 bytes, PHC-encoded in `encrypted_password`. Rationale: memory-hardness is the point — GPU/ASIC resistance per dollar — and the 19 MiB/t2 profile keeps a verify under ~50 ms on app-node cores, which matters because the multi-tenant auth module absorbs every project's login load; parameters are stored per-hash (PHC), so they can be raised later and old hashes **upgraded transparently on next successful login** (verify with old params → rehash with current → update row).

**bcrypt compatibility for imports** *(not yet built — D-313)*: `$2a$/$2b$/$2y$` hashes are to be accepted at verify time so customers can migrate user tables from bcrypt-based systems (Supabase/GoTrue included) without password resets; on the first successful login the hash is upgraded to argon2id. Steadhold never *writes* bcrypt.

Password policy V1: minimum 8 characters, maximum 72 bytes rejected only for bcrypt-imported logins (argon2 has no 72-byte limit; we cap at 1024 bytes to bound hashing cost), no composition rules (NIST 800-63B), optional project-configured minimum length up to 32.

### V1 API surface

All endpoints under `https://<ref>.steadhold.app/auth/v1`. `apikey: <anon JWT>` header required (gateway-enforced, D-029); `Authorization: Bearer <access JWT>` where noted. Uniform error envelope with `request_id` (D-032).

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/signup` | POST | anon key | Create user (unverified unless autoconfirm); triggers verification email |
| `/token?grant_type=password` | POST | anon key | Email+password login → access + refresh tokens |
| `/token?grant_type=refresh_token` | POST | anon key | Rotate refresh token → new pair ([spec](02-sessions-and-tokens.md)) |
| `/logout` | POST | bearer | Revoke current session (or `?scope=global`/`others`) |
| `/verify` | POST / GET | anon key | Consume one-time token (confirmation, recovery, email change); GET is the email-link form with redirect |
| `/recover` | POST | anon key | Request password-reset email (enumeration-safe) |
| `/resend` | POST | anon key | Re-send confirmation/verification email (rate-capped) |
| `/user` | GET | bearer | Current user object (allowlisted fields) |
| `/user` | PUT | bearer | Update password / email / `raw_user_meta_data` (guarded flows in [flows](03-flows.md)) |
| `/sessions` | GET / DELETE | bearer | List own sessions / revoke one ("sign out everywhere" via logout scope) |
| `/.well-known/jwks.json` | GET | none | Per-project public keys (D-014) |
| `/admin/users`, `/admin/users/:id` | GET/POST/PUT/DELETE | service_role key | Developer-side user management incl. deletion (V1 stance in [flows](03-flows.md)) |
| `/health` | GET | none | Module liveness (proposal §69) |

Everything not in this table is not in V1 — see the scope-freeze rule ([OAuth & future](05-oauth-and-future.md)).

## Decisions

- **D-110 — Auth is one multi-tenant module of the monolith serving all projects at `<ref>.steadhold.app/auth/v1/*`; per-project auth containers are rejected. Project context (database, signing key handle, auth config: `site_url`, redirect allowlist, email templates, lifetimes) is resolved by the gateway routing table per request; per-project state in the module is limited to caches of config and KMS-decrypted signing keys.** *(Rationale: an auth container per project re-creates the idle-RAM problem D-008 exists to kill (~80–120 MB × N idle projects) for the lightest per-project workload on the platform; tenant separation is preserved structurally because user data lives in physically separate per-project databases (D-009) and signing uses per-project keys (D-014).)*
- **D-111 — Password hashing is argon2id (m=19456 KiB, t=2, p=1, salt 16 B, tag 32 B, PHC-encoded), with parameter upgrades applied transparently on next successful verify; bcrypt (`$2a/$2b/$2y`) is accepted verify-only for imported users and rehashed to argon2id on first login.** *(Rationale: memory-hard hashing is the current best practice and the OWASP baseline profile bounds per-login CPU/RAM cost on the shared auth module; verify-time bcrypt compatibility makes user-table migration to Steadhold possible without a mass password reset — portability cuts both ways (D-004).)*

### Decided while building (Phase 4)

- **D-317 — The `/auth/v1/*` error codes are lowercase and GoTrue-compatible (`invalid_credentials`, `email_not_confirmed`, `weak_password`, `over_rate_limit`, `invalid_token`, `invalid_grant`), unlike the control plane's `UPPER_SNAKE`.** *(Rationale: these codes are matched by client code — a supabase-js app branches on `error.code === 'invalid_credentials'`. Renaming them to fit our style makes every ported app's error handling fall through to its generic branch. The uniformity within the set is what matters: one code covers a wrong password, an unknown email and a banned user, because distinguishing them is an enumeration oracle.)*
- **D-318 — Until the gateway exists (Phase 5), the module resolves the project from the signed `apikey` rather than the Host header; `/.well-known/jwks.json`, being unauthenticated, takes the ref from the Host subdomain or `?ref=`.** *(Rationale: a Host header is an assertion the caller wrote; the anon key arrives signed by the project's own key, so resolving it is one signature check rather than a lookup plus a trust decision. `apikey` is required on every endpoint anyway (D-029). The gateway will add routing and rate-limit placement, not identity.)*
- **D-319 — A project API key and an access token carry different `iss`, and each is pinned separately: `https://<ref>.steadhold.app` for keys, `https://<ref>.steadhold.app/auth/v1` for tokens.** *(Rationale: the provisioning saga signs keys with the bare origin and the token spec gives tokens the module's base URL. Pinning one string for both 401'd every request on the first live wiring, with a valid signature — the check was comparing an API key against an endpoint URL.)*
- **D-320 — A user access token is refused in the `apikey` slot, though it is signed by the same project key and names the same ref.** *(Rationale: letting a user's own credential select the project is a different trust decision from a project key doing so — the key is published deliberately and is project-scoped, while an access token's `role` claim maps to a Postgres role. Accepting it blurs the two identities exactly where the module chooses a database.)*
- **D-321 — Per-project auth config is a dedicated control-plane table (`project_auth_config`); a project with no row gets the column defaults, and `autoconfirm` defaults off.** *(Settles OQ-111. Rationale: D-110 requires the config outside the module, since there is one process and thousands of projects. A missing row meaning "all defaults" is what lets projects created before the table serve auth with no backfill. `autoconfirm` off is a security default: on, anybody can create an account on somebody else's address and use it.)*
- **D-322 — Signup spends a full scrypt hash on a taken address, and login spends a decoy verify on an unknown email.** *(Rationale: both are mechanically wasted and both are the endpoints' actual security content — skipping either moves the enumeration oracle from the response body into the clock. Affordable only because the endpoint is rate-limited *before* the hash (D-241).)*
- **D-323 — Each auth request opens its own connection to the project's database rather than using a pool; OQ-110 stays open.** *(Rationale: a pooled connection holds a password, P2d rotation replaces it, and every subsequent request fails auth until something rebuilds the pool — every login on a project breaking after a routine rotation, in a subsystem the operator was not touching. A connect is milliseconds against a deliberately expensive verify. Pooling needs a measurement, and OQ-110 must settle first: the pooler's `auth_query` allowlists `developer` only (D-074).)*

### Decided while building (P4c)

- **D-324 — One-time tokens are consumed in a single UPDATE whose predicate includes `used_at IS NULL`; never select-then-update.** *(Rationale: concurrent clicks on one link are common — prefetch, double-click, mail scanners — and a check-then-act lets both pass and both issue a session. Proven by removing the predicate: two simultaneous verifies both returned 200 and left two sessions. The predicate also excludes soft-deleted users, so a tombstone cannot be confirmed back into a session.)*
- **D-325 — A `redirect_to` is validated where the link is built, not only where it is followed; an unlisted value is replaced by `site_url` and the substitution is audited.** *(Rationale: the first `/recover` put `redirect_to` straight into the mailed link, which would have made Steadhold send an attacker-chosen destination from its own domain — the capability D-116's fixed templates exist to withhold. Replacement rather than rejection keeps a mistyped client config from killing valid links; the audit row is the only signal a developer or a responder gets.)*
- **D-326 — A project with no `site_url` permits no redirect, and `GET /verify` then answers in JSON rather than guessing.** *(Rationale: "configured nothing" must not read as "allowed everything", and inventing a destination is the open redirect the allowlist exists to prevent.)*
- **D-327 — Session tokens ride in the fragment of a verification redirect, never the query string.** *(Rationale: a fragment is never sent to a server, so the tokens stay out of the destination's access logs, out of intermediate proxies, and out of `Referer`.)*
- **D-328 — Every successful `/verify` confirms the address, not only `type=signup`.** *(Rationale: a recovery link proves mailbox control as well as a confirmation link. Otherwise a successful reset ends at a login refused for `email_not_confirmed` — a dead end reachable only by the users who most need the reset.)*
- **D-329 — `/resend` replaces the outstanding token; an already-confirmed or unknown address gets a same-shape 200 and no mail.** *(Rationale: the upsert leaves one live link in an inbox rather than ten. Re-confirming a confirmed address would make the shared sending domain deliver on demand to any registered address.)*
- **D-330 — The email boundary is an `AuthMailer.enqueue` that cannot throw, with the delivery id derived from the token.** *(Rationale: the flow has already committed to a same-shape 200, so a send failure becoming a 500 breaks the contract and signals that the address was interesting. `<type>_<user id>` is the stable identity of the link currently owed. D-018 holds: the row of record is the `one_time_tokens` row, so losing Redis loses delivery, not the obligation.)*

### Decided while building (P4g)

- **D-352 — The admin surface is deliberately not enumeration-resistant; an unknown id is a 404.** *(Rationale: service_role is the customer's own server-side credential and can already read every row, so hiding existence protects nothing and breaks a retrying import script. The corollary is that the key check is the only guard, so it runs first on all five routes.)*
- **D-353 — A refused admin call is 403, not 401.** *(Rationale: the credential is valid and simply not this one; 401 sends a developer to check for expiry when they used the published key their frontend already has.)*
- **D-354 — A ban, an admin password set, and `sign_out` each revoke every session; `ban_until: null` lifts a ban.** *(Rationale: a ban that leaves refresh working is not a ban, and D-113 already concedes one access-token lifetime. `sign_out` is separate because "log out of that stolen laptop" and "get off my service" are different requests.)*
- **D-355 — Deletion is soft, and the tombstone keeps the id and nothing else.** *(Rationale: app tables reference `auth.users(id)` under the developer's FK semantics and we do not cascade into their schemas. `deleted+<id>@invalid` frees the real address through the partial index; password, metadata and confirmation are scrubbed, and sessions, lineages and one-time tokens die with it — a deleted user whose recovery link works can be signed back in from an inbox.)*
- **D-356 — A NULL password hash is a legitimate state, creatable only from the admin surface.** *(Rationale: an imported account awaiting a reset, or a provider-only one. `''` was rejected as a value meaning "absent" that the login path's NULL check would miss; the decoy verify keeps such an account indistinguishable from a wrong password.)*
- **D-357 — A malformed id in an admin path is rejected before it reaches a query.** *(Rationale: a diagnosis guard, not an injection one — `invalid input syntax for type uuid` renders as a 500 and points a developer at the server instead of their request.)*

## Open Questions

- **OQ-110** — Auth module → project database connectivity: through the project's PgBouncer (transaction mode, shared with PostgREST) vs a direct connection with a tiny dedicated pool per active project. Pooler keeps one path but auth's short transactions could compete with API traffic under load; direct connections cost Postgres slots. Needs load numbers from [connection pooling](../03-database-platform/02-connection-pooling.md). Current lean: through the pooler with a reserved `steadhold_auth` role. **Still open** — P4b deliberately took the third option, a fresh connection per request (D-323), because credential rotation makes a cached pool a trap. A pooler decision needs load numbers *and* a change to the pooler's `auth_query` allowlist, which is its own step.
- **OQ-111** — *Settled by D-321 (P4b)*: a dedicated `project_auth_config` table, with the column defaults standing in for a missing row. It currently carries only what is built (`autoconfirm`, `disable_signup`, `access_token_ttl_seconds`, `password_min_length`); `site_url`, the redirect allowlist and templates join it with the flows that need them (P4c/P4d).

## Dependencies

- Builds on: [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md) (§2.3), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-004, D-008, D-009, D-013, D-014, D-020, D-029, D-035), [../01-architecture/01-system-architecture.md](../01-architecture/01-system-architecture.md), [../02-control-plane/02-platform-api.md](../02-control-plane/02-platform-api.md) (the control-plane auth this doc is *not*)
- Feeds: [02-sessions-and-tokens.md](02-sessions-and-tokens.md), [03-flows.md](03-flows.md), [04-email-infrastructure.md](04-email-infrastructure.md), [05-oauth-and-future.md](05-oauth-and-future.md), [../06-security/02-rls-design.md](../06-security/02-rls-design.md), [../04-data-api/03-api-keys-and-roles.md](../04-data-api/03-api-keys-and-roles.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md)
