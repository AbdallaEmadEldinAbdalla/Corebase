# Sessions & Tokens

## Purpose

The complete token mechanics for customer-app auth: the ES256 access JWT and its claims (D-014), JWKS publication, the refresh-token rotation protocol with reuse detection (the part of D-013 where precision is the security property), the session model, honest revocation semantics, the signing-key rotation runbook, and what belongs in JWT claims versus application tables. [Auth architecture](01-auth-architecture.md) defines where these mechanisms run; [flows](03-flows.md) shows them in end-to-end sequences.

## Design

### Access token: ES256 JWT, per-project keypair

Per D-014: each project gets an ES256 (ECDSA P-256 + SHA-256) keypair generated at provision time, private key envelope-encrypted (D-035) and cached in the auth module's memory after KMS decrypt, public key published via JWKS and distributed to the project's PostgREST config. `kid` in every JWT header. Per-project keys contain blast radius: a leaked private key compromises one project, not the fleet.

**Header**

```json
{ "alg": "ES256", "typ": "JWT", "kid": "cbk_2026_08_7f3a" }
```

**Claims**

| Claim | Value | Notes |
|---|---|---|
| `iss` | `https://<ref>.corebase.co/auth/v1` | Verifiers pin this per project |
| `sub` | `auth.users.id` (uuid) | What `auth.uid()` reads for RLS |
| `aud` | `"authenticated"` | Audience check enforced by PostgREST |
| `role` | `"authenticated"` | Mapped to the Postgres role of the same name (D-029); `anon`/`service_role` appear only in API-key JWTs, never in user tokens |
| `email` | user's email | Convenience for policies/apps |
| `session_id` | `auth.sessions.id` | Ties the JWT to a revocable session; constant across refreshes |
| `iat` | issue time (epoch s) | |
| `exp` | `iat` + access-token TTL | **Default 3600 s (1 h)**, per-project configurable 300 s – 86400 s |
| `user_metadata` | *omitted by default* | See "JWT bloat" below; opt-in per project, size-capped |

Reserved for later, not emitted in V1: `aal` (MFA assurance level, V1.2 — [OAuth & future](05-oauth-and-future.md)), `amr` (auth methods). Adding claims is non-breaking; that is why they are not stubbed now.

*P4f emits `amr` after all, with exactly one value: `["recovery"]`, on the access
token a recovery link mints (**D-343**). It is what lets `PUT /user` accept a new
password with no `current_password`, and it is a claim rather than a session
column because `auth.sessions` lives in the project-database image and there is
no per-project migration path — plus the claim gives the tighter property, since
the capability expires with the token instead of lasting the session. `aal` is
still unemitted.*

**Verification** (PostgREST, storage-api, and customer backends): signature against the project JWKS, `exp`/`iat` with **±60 s clock-skew leeway**, `aud = authenticated`, `iss` exact match. The gateway does *not* verify user JWTs on the REST path — that is PostgREST's job (one verification, not two); the gateway verifies only the `apikey` project key ([request pipeline](../04-data-api/02-request-pipeline.md)).

### JWKS: `https://<ref>.corebase.co/auth/v1/.well-known/jwks.json`

```json
{ "keys": [ { "kty": "EC", "crv": "P-256", "x": "…", "y": "…",
              "kid": "cbk_2026_08_7f3a", "alg": "ES256", "use": "sig" } ] }
```

- Served by the auth module from the routing-table's cached public key(s); no control-plane query on the hot path (D-051).
- `Cache-Control: public, max-age=600` — verifiers may cache 10 minutes; during key rotation both keys are published (runbook below), so a stale cache stays valid.
- Customer backends verifying Corebase JWTs themselves (a supported, portability-friendly pattern) should use a JWKS client honoring `kid` and cache headers.
- PostgREST in V1 is *configured* with the project's public JWK at provision (it does not fetch the JWKS URL); a rotation therefore includes a config-reload step (runbook step 3, OQ-112).

### Refresh tokens: rotation with reuse detection — the precise protocol

Refresh tokens are **opaque 256-bit values** from a CSPRNG, base64url-encoded with prefix `cb_rt_` (prefixes make leaked tokens greppable by secret scanners). The database stores only `sha256(token)` in `auth.refresh_tokens.token_hash` ([schema](01-auth-architecture.md)). A refresh token belongs to exactly one session and one lineage:

**On login** (any grant that creates a session):

1. `INSERT auth.sessions` → `session_id`.
2. Generate refresh token R0; `INSERT auth.refresh_tokens (token_hash, user_id, session_id, parent_id=NULL)`.
3. Issue access JWT (claims above, `session_id` set) + R0.

**On `POST /token?grant_type=refresh_token`** with presented token R:

1. Look up by `sha256(R)`. Not found → `401 invalid_grant` (indistinguishable from any other refresh failure).
2. Load the token row and its session. If `session.revoked_at` is set, or the token's `revoked` flag is set → `401 invalid_grant`.
3. If the session is **idle-expired** (`now() - session.last_refreshed_at > 30 days`, default, per-project configurable) → revoke session, `401 invalid_grant`.
4. If `used_at IS NULL` (normal case):
   a. In one transaction: set `used_at = now()`; insert child token R′ with `parent_id = R.id`, same `session_id`; update `session.last_refreshed_at`.
   b. Issue new access JWT (same `session_id`) + R′. Response: `{access_token, token_type, expires_in, refresh_token, user}`.
5. If `used_at IS NOT NULL` — the token was already spent. Two cases:
   - **Grace window (D-112): `now() - used_at ≤ 10 s`** → treat as a network race (client retried, or two tabs refreshed simultaneously): return the **already-issued child** R′ and a fresh access JWT — do *not* mint a second child. Idempotent-replay semantics; requires reading the child row via `parent_id`. If the child is itself already used, fall through to the theft case.
   - **Beyond the grace window → theft signal.** Someone is replaying an old refresh token: either the attacker used the stolen token first (client's later legitimate refresh trips this) or the client did (attacker trips it). Either way: **revoke the entire session family** — set `sessions.revoked_at`, set `revoked = true` on every token with that `session_id` — write `auth.audit_log_entries(action='token_reuse_detected')`, and return `401 invalid_grant`. The legitimate user is forced to re-authenticate; the attacker's stolen lineage dies with them.

**Built in P4e, with one deviation that matters.** Step 5's grace branch says to
"return the already-issued child R′", and that cannot be done as written: only
`sha256(R′)` was ever stored, so R′'s plaintext cannot be handed out a second
time. What P4e does instead is issue a **replacement** child under the same parent
and revoke the one it replaces (**D-338**). The property the window exists for is
delivered exactly — a client whose response was lost gets a working token instead
of a forced logout, and no second lineage appears — and what changes is that the
lost child's plaintext stops working, which is right: the only party who might
hold it is whoever received the response the retrying client did not.

Two other things are stricter than the numbered steps imply. Step 4a's spend is a
single `UPDATE … WHERE used_at IS NULL`, so two concurrent refreshes with one
token cannot both mint a child — the loser falls into step 5 and the grace window
turns it into a replay rather than a false theft signal. And idle expiry is
measured from `COALESCE(last_refreshed_at, created_at)` (**D-341**): a NULL read as
"never idle" would make a session that was never refreshed immortal, which is
precisely the session on a device nobody uses any more.

Why 10 seconds and not zero: mobile clients on flaky networks genuinely retry refresh calls, and SPAs in multiple tabs race; a zero-tolerance policy converts those into forced logouts at a rate that trains developers to disable rotation. Why 10 seconds and not 60: the window is exactly the period during which a stolen-and-immediately-replayed token goes undetected; 10 s covers TCP/TLS retry behavior without giving an attacker a meaningful operating window. GoTrue ships the same order of magnitude for the same reason.

Refresh tokens have **no independent absolute expiry in V1**: lineage lifetime is bounded by session idle expiry (30 days default) and session revocation. An absolute session cap ("force re-login every N days") is a per-project config candidate for V1.x (OQ-113).

### Session model

One `auth.sessions` row per login. The `session_id` claim makes every access JWT attributable to a session, which is what makes the following meaningful:

| Operation | Endpoint | Semantics |
|---|---|---|
| List own sessions | `GET /auth/v1/sessions` | Rows for the bearer's user: id, created_at, last_refreshed_at, user_agent, ip; current session flagged |
| Revoke one session | `DELETE /auth/v1/sessions/:id` | Sets `revoked_at`; that session's refresh lineage is dead immediately |
| Logout (this session) | `POST /auth/v1/logout` | Revokes the bearer's `session_id` |
| Sign out everywhere | `POST /auth/v1/logout?scope=global` | Revokes **all** the user's sessions |
| Everywhere but here | `POST /auth/v1/logout?scope=others` | All sessions except the bearer's |

**Built in P4e:** all five rows of the table above. Two notes on what the code
does that the table cannot say. A bearer token is refused unless its `role` claim
is `authenticated` (**D-340**) — a project's anon and service_role keys are valid
JWTs under the same keypair, so without that check an API key works as a user
credential — and the session lookup is keyed on `(session_id, user_id)`, so a
token naming somebody else's session cannot act on it. `POST /logout` answers 204
even for an already-revoked session: logout is the one operation a client must be
able to complete unconditionally, and there is nothing to protect.

Password reset and password change revoke sessions per the rules in [flows](03-flows.md). Developer-side (service_role) session revocation rides `/admin/users/:id` (ban / force sign-out).

### Revocation semantics — the honest part

**Access JWTs are stateless.** PostgREST verifies a signature; it does not consult `auth.sessions`. Therefore: after a session is revoked (logout, reuse detection, admin ban, "sign out everywhere"), an already-issued access token **keeps working until its `exp` — up to 1 hour by default.** Refresh is dead immediately; the residual risk window is exactly one access-token lifetime. Anyone who claims stateless JWTs plus instant revocation is selling something.

The mitigations menu, with V1 stances (D-113):

| Mitigation | Cost | V1 stance |
|---|---|---|
| Short `exp` (down to 5 min) | More refresh traffic; auth module load scales with 1/exp | **Available** — per-project config, default stays 1 h |
| Strict mode: PostgREST/gateway checks session liveness per request | Adds a lookup to *every* data-plane request — the hot path D-051 exists to keep DB-free; needs a replicated session-state cache (Redis) + invalidation, and turns auth availability into data-API availability | **Deferred to V1.x** — design sketch only; do not build until a customer with a real compliance need exists. Benchmark first (OQ-112) |
| `banned_until` enforced at refresh + short exp | Nothing per-request | **V1 behavior** — a banned user survives ≤ exp |
| Key rotation as a kill switch | Invalidates *every* token in the project | Emergency lever only (runbook below) |

**The V1 stance, plainly: revocation means "refresh is dead now; access dies within `exp` (≤1 h default)." Projects that need a tighter window configure a shorter `exp`. Per-request session checking is explicitly out of V1.**

*Built in P4e, and worth stating precisely because the boundary is easy to
misread (**D-339**): the **auth endpoints** do check session liveness on every
bearer request, so a token discarded at logout is refused there immediately —
that is what makes `/logout` mean anything at all. The **data plane** does not,
and will not before the strict-mode row above is built. So the sentence above is
the whole guarantee, and the pair of behaviours is deliberate rather than
inconsistent.*

### Signing-key rotation runbook (per project)

Routine (credential hygiene or suspected exposure without active abuse):

1. **Generate** new ES256 keypair, new `kid`; envelope-encrypt (D-035); status `next` in the control plane.
2. **Dual-publish**: JWKS now serves old + new keys. Wait ≥ JWKS cache TTL (10 min) before signing with the new key so cached verifiers already have it.
3. **Reload verifiers**: push new public-key set to the project's PostgREST config and reload it (mechanism: OQ-112); gateway routing-table entry updated via Redis pub/sub (D-051).
4. **Cut over signing**: auth module signs new access JWTs (and the anon/service_role project keys are re-derived — D-029 keys are JWTs under the same keypair, so rotation here is also API-key rotation; the swap/overlap window is owned by [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md)).
5. **Retire**: removal of the old `kid` is gated on the API-key swap window (default **30 days**, OQ-104) — because the same keypair signs the long-lived anon/service_role keys (D-029, D-107), user-token validity alone would allow retirement after `max(exp)` (default 1 h, worst-case configured 24 h) plus skew, but the API keys are the binding constraint. At window end, remove the old `kid` from JWKS; mark key `retired`, keep ciphertext for audit.

Emergency (private key confirmed leaked): steps 1, 3, 4 immediately; skip dual-publish patience; old `kid` removed at once. Every outstanding access token and both API keys die instantly — a project-wide forced re-auth, which is the point. Refresh tokens survive (they are opaque, not signed), so users transparently recover on next refresh.

### What goes in `raw_user_meta_data` vs app tables

*Built in P4f: `PUT /user {data}` **merges** into `raw_user_meta_data` rather than
replacing it, so a client sending one field does not silently wipe the others, and
it cannot reach `raw_app_meta_data` by construction — the store function only
writes the user half, which is the entire reason the two columns exist
separately.*

- `raw_user_meta_data` is **user-writable** (`PUT /auth/v1/user`). It must never carry authorization data: no roles, no plan tiers, no feature flags. RLS policies must not read it. Privileged attributes go in `raw_app_meta_data` (service_role-writable) or, better, in the app's own tables joined by `user_id`.
- Keep it to display-ish scalars (name, avatar URL, locale). Anything queried, joined, or constrained belongs in a `public.profiles` table with RLS — that is the documented pattern in the [SDK spec](../10-cli-and-sdk/03-sdk-spec.md).
- **JWT bloat warning**: `user_metadata` is not in the access token by default (claims table above). Projects that opt in get a hard cap — the serialized JWT must stay under 4 KB. JWTs ride an HTTP header on *every* API request; headers >8 KB break proxies and the per-request byte tax is pure waste. Claims are for identity and coarse authorization context, not for shipping a profile document.

## Decisions

- **D-112 — Refresh-token protocol: opaque 256-bit CSPRNG tokens (`cb_rt_` prefix), SHA-256 hash stored only; strict rotation (each use marks the token spent and issues one child in the same session lineage); replay of a spent token within a 10-second grace window idempotently returns the already-issued child; replay beyond it is a theft signal that revokes the entire session family and audits `token_reuse_detected`. Session idle expiry 30 days (refresh extends); no absolute session cap in V1.** *(Rationale: rotation with family revocation converts token theft from a silent long-lived breach into a detectable, self-limiting event — the precise property the critical review §2.3 demanded; the 10 s grace absorbs real mobile/multi-tab races without giving an attacker a useful window.)*
- **D-113 — Revocation stance for V1: access JWTs are stateless and are never checked against session state on the data-plane hot path; revocation kills refresh immediately and access tokens within `exp` (default 3600 s, per-project configurable 300–86400 s); clock-skew leeway is ±60 s. Strict per-request session validation is deferred to V1.x behind a benchmark.** *(Rationale: per-request session lookup couples data-API latency and availability to auth state and violates the DB-free hot path (D-051); a bounded ≤1 h residual window, shrinkable per project via `exp`, is the industry-standard tradeoff and we state it instead of hiding it.)*

## Open Questions

- **OQ-112** — Verifier key reload mechanics and the strict-mode benchmark: how does a project's PostgREST pick up a rotated public key (config reload via SIGUSR2 vs container restart via the reconciler), and what is the measured p99 cost of a Redis session-liveness check per data-plane request if strict mode is ever built? Owner: [request pipeline](../04-data-api/02-request-pipeline.md) + [realtime-era infra review](../11-infrastructure/03-observability.md) for the benchmark harness.
- **OQ-113** — Absolute session lifetime ("force re-login every N days") as per-project config: V1.x candidate; interacts with refresh idle expiry and enterprise compliance asks (D-003 says don't build for enterprise yet).

## Dependencies

- Builds on: [01-auth-architecture.md](01-auth-architecture.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-013, D-014, D-029, D-035, D-051), [../04-data-api/02-request-pipeline.md](../04-data-api/02-request-pipeline.md)
- Feeds: [03-flows.md](03-flows.md), [05-oauth-and-future.md](05-oauth-and-future.md), [../04-data-api/03-api-keys-and-roles.md](../04-data-api/03-api-keys-and-roles.md), [../06-security/01-threat-model.md](../06-security/01-threat-model.md), [../06-security/02-rls-design.md](../06-security/02-rls-design.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md)
