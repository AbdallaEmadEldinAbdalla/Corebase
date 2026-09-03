# Auth Flows

## Purpose

Every V1 auth flow as a numbered sequence — client ↔ auth module ↔ email ↔ project DB — with security notes inline, exact endpoints, token lifetimes, and failure modes. This doc **is** the V1 auth scope: the scope-freeze rule in [OAuth & future](05-oauth-and-future.md) says nothing ships in auth V1 beyond the flows on this page (D-013). Token mechanics are specified in [sessions & tokens](02-sessions-and-tokens.md); email sending in [email infrastructure](04-email-infrastructure.md).

## Design

### Shared conventions

- All endpoints: `https://<ref>.corebase.co/auth/v1/…`, `apikey` header required (anon key unless noted), error envelope `{error: {code, message, request_id}}` (D-032).
- **Enumeration resistance is a response-shape contract**: where marked "same-shape", the 2xx status, body, and header set are byte-identical whether or not the account exists; latency is equalized with a dummy hash verify ([checklist item 1](01-auth-architecture.md)).
- **Redirects**: any `redirect_to` is validated against the project's `site_url` + additional-redirects allowlist; unlisted values are silently replaced with `site_url` ([checklist item 6](01-auth-architecture.md)).
- Every flow writes an `auth.audit_log_entries` row (success and failure).

**Token lifetimes (V1 defaults)**

| Token | Lifetime | Single-use | Where defined |
|---|---|---|---|
| Access JWT | 1 h (config 5 min–24 h) | n/a (stateless) | [sessions & tokens](02-sessions-and-tokens.md) |
| Refresh token | session-bound; idle expiry 30 d | yes (rotation, D-112) | [sessions & tokens](02-sessions-and-tokens.md) |
| Confirmation (signup / email change) | **24 h** | yes | this doc |
| Recovery (password reset) | **1 h** | yes | this doc |

**Auth-tier rate limits (V1 defaults, Redis buckets at the gateway per D-033; email-send caps additionally apply per [email infrastructure](04-email-infrastructure.md))**

| Endpoint | Per identifier (email) | Per IP |
|---|---|---|
| `POST /signup` | — | 30 / hour |
| `POST /token?grant_type=password` | 10 / 5 min | 30 / 5 min |
| `POST /token?grant_type=refresh_token` | — | 60 / 5 min |
| `POST /recover`, `POST /resend` | 4 / hour | 10 / hour |
| `POST /verify` | 10 / hour | 30 / hour |

Exceeding any bucket → `429 over_rate_limit` + `Retry-After`. Limits are per project; identifier buckets are keyed `(project, lower(email))` so an attacker cannot dodge them by rotating IPs.

---

### Flow 1 — Signup

`POST /signup` `{email, password, data?}` (`data` → `raw_user_meta_data`)

1. Client → auth: signup request. Gateway: ref resolution, anon-key check, rate limits.
2. Auth validates password policy (min 8 chars, ≤1024 bytes; [D-111 context](01-auth-architecture.md)).
3. Auth → project DB: look up `lower(email)`.
   - **New email** → `INSERT auth.users` (argon2id hash, `email_confirmed_at = NULL`); insert `auth.one_time_tokens (token_type='confirmation', expires_at = now()+24h)`; enqueue verification email.
   - **Existing confirmed email** → no insert; enqueue "you already have an account" notice email (or nothing, config); **response identical**.
   - **Existing unconfirmed email** → refresh the confirmation token, re-enqueue verification (subject to email caps).
4. Auth → email provider: verification mail with link `https://<ref>.corebase.co/auth/v1/verify?token=<one-time>&type=signup&redirect_to=<allowlisted>` ([email infrastructure](04-email-infrastructure.md)).
5. Auth → client: **200 with the SAME response shape in all three cases** — `{id?, email, confirmation_sent_at}` where `id` for the already-exists case is a freshly generated decoy uuid. No signal that the email was taken. *(Security note: signup is the classic enumeration oracle; the decoy response is what closes it.)*
6. **Autoconfirm option** (per-project config, meant for development): skip 3b's token + email, set `email_confirmed_at = now()`, return a full session (access + refresh) immediately. Dashboard shows a persistent warning when autoconfirm is on.

| Failure | Response | Notes |
|---|---|---|
| Password fails policy | `422 weak_password` | Safe to be specific — reveals nothing about accounts |
| Invalid email syntax | `400 validation_failed` | |
| Rate limited | `429 over_rate_limit` | |
| Email send fails | 200 anyway; send retried via job queue (D-018) | User can `POST /resend` |
| Email exists | **200, same shape** | Never 409 |

**Built in P4b, completed in P4c.** All three branches of step 3 now behave as
written: a new address gets a `confirmation` token and its mail, an *unconfirmed*
existing one gets its token refreshed (for that person a second attempt is
indistinguishable from retrying their own signup), and a *confirmed* one gets the
"you already have an account" notice — the only channel that can say so, and one
that discloses nothing to whoever triggered it. `confirmation_sent_at` is now a
claim we are entitled to make, in the sense that the mail is genuinely handed over
and owed; the thing that **sends** it is P4d, so it waits in the queue.

The hash on the duplicate-address path is spent deliberately (**D-322**): skipping
it makes a taken address answer in 2 ms and a fresh one in 100 ms, which is the
same oracle moved into the clock.

### Flow 2 — Email verification

`GET /verify?token=…&type=signup&redirect_to=…` (link click) or `POST /verify` `{token, type}` (SDK)

1. Client (mail client) → auth: GET with one-time token.
2. Auth → DB: look up `sha256(token)` in `auth.one_time_tokens` (timing-safe digest compare), `token_type='confirmation'`.
3. Checks, in order: exists → not used (`used_at IS NULL`) → not expired (`expires_at > now()`), single transaction.
4. Mark `used_at = now()` *(single-use — a verification link forwarded or leaked via mail-scanner prefetch cannot be replayed)*; set `users.email_confirmed_at = now()`.
5. Issue session (access + refresh) and **302 redirect** to the validated `redirect_to` (allowlist-checked; unlisted → `site_url`) with tokens in the URL fragment (`#access_token=…&refresh_token=…` — fragment, not query, so tokens never hit server logs). POST variant returns tokens as JSON.

| Failure | Response | Notes |
|---|---|---|
| Token unknown / used / expired | GET: redirect to `site_url` `#error=invalid_token`; POST: `401 invalid_token` | One generic code for all three — no oracle for which |
| `redirect_to` not allowlisted | Proceed, redirect to `site_url` | Never redirect to unlisted URL |
| Rate limited | `429` | Mail-scanner prefetch counts; cap is generous |

**Built in P4c.** Two things are stricter than the numbered steps imply. The
consume in steps 3–4 is a **single UPDATE** carrying `used_at IS NULL` rather than
the checks-then-mark the ordering suggests (**D-324**) — two concurrent clicks on
one link both pass a separate check and both issue a session, which is the replay
single-use exists to prevent, and removing the predicate demonstrably produces
exactly that. And step 5's fragment is load-bearing rather than stylistic
(**D-327**). A successful verify of *any* type confirms the address (**D-328**),
not only `signup`: a recovery link proves mailbox control just as well, and not
confirming would send a user through a successful reset into a login that refuses
them.

A project with no `site_url` has no allowlisted destination, so the GET form
degrades to the POST form's JSON rather than guessing one (**D-326**).

*Security note: some corporate mail scanners GET every link. Consuming the token on GET is a known tradeoff; V1 accepts it (the scanner's GET verifies the email, redirect still goes to the allowlisted site). If it bites, the fallback is an interstitial confirm page — tracked as OQ-114.*

### Flow 3 — Login (password grant)

`POST /token?grant_type=password` `{email, password}`

1. Client → auth. Gateway: rate limits per `(project,email)` and IP — *brute force is bounded per identifier, not just per source*.
2. Auth → DB: fetch user row by `lower(email)`.
3. **Timing-safe verify**: argon2id verify against `encrypted_password`; if no user row, verify against a **dummy hash** so timing is uniform. bcrypt hashes verified and upgraded per D-111.
4. Gates (checked *after* hashing, all mapped to the same external error): user exists, password matches, `banned_until` not in the future, `deleted_at IS NULL`, and — if the project requires confirmation (default) — `email_confirmed_at IS NOT NULL` (this one gets its own code, see table; it is not an enumeration oracle because it only fires on a *correct* password).
5. Issue tokens: `INSERT auth.sessions` (ip, user_agent), root refresh token, ES256 access JWT with `session_id` ([sessions & tokens](02-sessions-and-tokens.md)); update `last_sign_in_at`; audit `login`.
6. Auth → client: `{access_token, token_type:"bearer", expires_in:3600, refresh_token, user}`.

| Failure | Response | Notes |
|---|---|---|
| Wrong email OR wrong password | `400 invalid_credentials` — **one generic message** | Never "no such user" |
| Email not confirmed (password correct) | `400 email_not_confirmed` | Actionable for the real owner; useless to an attacker without the password |
| Banned (`banned_until` future) | `400 invalid_credentials` externally; audit says `login_failed_banned` | |
| Rate limited | `429 over_rate_limit` | |

**Built in P4b.** Hashing is scrypt (**D-313**), not argon2id, and bcrypt
verify-only is still unbuilt — so step 3's migration path does not exist yet. Both
rate-limit buckets are checked **before** any hashing (**D-241**), which is what
makes the decoy verify in step 3 affordable: without the limit, a decoy hash per
unknown email is a 64 MiB allocation any anonymous caller can trigger in a loop.
The `email_not_confirmed` code in step 4 is deliberately the one gate with its own
name, and the test that pins it asserts the *wrong* password on an unconfirmed user
still returns the generic error — which is the property that makes it not an
oracle.

### Flow 4 — Token refresh

`POST /token?grant_type=refresh_token` `{refresh_token}` — the full rotation/reuse-detection protocol, including the 10 s grace window and family revocation, is specified in [sessions & tokens](02-sessions-and-tokens.md) (D-112). Failure modes: any invalid/spent/revoked/expired token → `401 invalid_grant` (uniform); reuse beyond grace additionally revokes the session family and audits `token_reuse_detected`.

### Flow 5 — Logout

`POST /logout[?scope=local|global|others]` (bearer)

1. Client → auth with access JWT.
2. Auth verifies JWT, reads `session_id`; sets `sessions.revoked_at` per scope (`local` default = this session; `global` = all the user's sessions; `others` = all but this).
3. `204`. Client discards both tokens.
4. *Honesty note (D-113): the just-discarded access token remains cryptographically valid until `exp`; server-side, its session is dead — refresh is impossible from this instant.*

| Failure | Response |
|---|---|
| Missing/expired access JWT | `401 unauthenticated` |
| Session already revoked | `204` (idempotent) |

### Flow 6 — Password reset request

`POST /recover` `{email}`

1. Client → auth. Rate limits: 4/hour per email, 10/hour per IP — *reset-mail flooding is both an annoyance attack on users and a reputation attack on shared email infra ([email infrastructure](04-email-infrastructure.md))*.
2. Auth → DB: look up email. If found: insert/replace `one_time_tokens (token_type='recovery', expires_at = now()+1h)`; enqueue recovery email with link to `/verify?token=…&type=recovery`.
3. Auth → client: **200 same-shape always** `{}` — *whether or not the account exists. The recovery endpoint is the second classic enumeration oracle.*

| Failure | Response | Notes |
|---|---|---|
| Email not registered | **200, same shape** | Email simply not sent |
| Rate limited | `429` | Per-email bucket stops targeted flooding |
| Email send failure | 200; retried via queue | |

**Built in P4c.** The `redirect_to` is validated *before* it goes into the mailed
link, not only when the link is followed (**D-325**) — the first version of this
endpoint passed it straight through, which would have had Corebase mailing an
attacker-chosen destination from its own domain. `/resend` is built alongside it
and replaces the outstanding token rather than adding one (**D-329**), and sends
nothing at all to an address that is already confirmed or does not exist.

### Flow 7 — Password reset completion

`GET/POST /verify` with `type=recovery`, then `PUT /user`

1. User clicks the recovery link → `/verify` consumes the **single-use** recovery token (checks as Flow 2 steps 2–4) and issues a session, redirecting to the allowlisted recovery page.
2. Client → `PUT /user` `{password}` with that session's bearer token.
3. Auth: hash new password (argon2id), update `encrypted_password`.
4. **Revoke ALL the user's sessions except the current one** — *a reset usually means "someone may have my password"; every existing session is presumed hostile*. Refresh lineages die immediately; stale access JWTs die within ≤1 h (D-113).
5. Enqueue **confirmation email** to the user ("your password was changed") — *the tripwire that tells the real owner if an attacker performed the reset*.
6. `200 {user}`.

| Failure | Response | Notes |
|---|---|---|
| Recovery token invalid/used/expired | `401 invalid_token` at step 1 | 1 h expiry keeps the window small |
| — | — | **Step 1 is built (P4c); steps 2–6 are not.** A recovery link yields a working session, and `PUT /user` does not exist — so the reset gets you logged in and cannot yet change the password. Recorded as a gap in STATUS §8. |
| New password fails policy | `422 weak_password` | Token already spent — user must re-run Flow 6; acceptable, rare |
| Rate limited | `429` | |

### Flow 8 — Password change while logged in

`PUT /user` `{password, current_password}` (bearer)

1. Client → auth with access JWT + both passwords.
2. **Require and timing-safe-verify `current_password`** — *a stolen access token alone (XSS, leaked localStorage) must not be convertible into a permanent password takeover*.
3. Update hash; **revoke all other sessions** (current stays); audit `password_changed`; send notification email.
4. `200 {user}`.

| Failure | Response |
|---|---|
| `current_password` wrong | `400 invalid_credentials` |
| `current_password` missing | `400 validation_failed` |
| New password fails policy | `422 weak_password` |

### Flow 9 — Email change

`PUT /user` `{email: new}` (bearer), then two verifications

1. Client requests the change. Auth stores the proposal in `one_time_tokens`: one token `token_type='email_change_current'` (sent to the **old** address), one `token_type='email_change_new'` with `relates_to = new_email` (sent to the **new** address). Both 24 h, single-use. `202 {}`.
2. User clicks **both** links (any order); each hits `/verify?type=email_change`.
3. Only when both tokens are consumed does auth update `users.email`, reset `email_confirmed_at = now()`, revoke all other sessions, audit, and notify both addresses.

*The why of double confirmation:* confirming only the **new** address lets an attacker with a hijacked session silently re-point the account (then own password reset forever); confirming only the **old** address lets a user lock themselves onto a typo'd unreachable new address. Old-address confirmation proves the legitimate owner approves; new-address confirmation proves the destination is real and theirs. Projects may relax to single (new-only) confirmation via config; default is double.

| Failure | Response | Notes |
|---|---|---|
| New email already registered | `202 {}` **same-shape**; change silently cannot complete; notice mail to the new address | Enumeration resistance again |
| Only one token confirmed within 24 h | Change lapses; tokens expire; email unchanged | |
| Either token replayed | `401 invalid_token` | Single-use |

### Flow 10 — Account deletion

**V1: developer-initiated only** — `DELETE /auth/v1/admin/users/:id` with the **service_role** key (D-114); also surfaced in the dashboard's Auth page (which calls the same admin API via the control plane).

1. Developer/service → auth admin endpoint with service_role key (gateway verifies key class per D-029).
2. Auth: set `users.deleted_at = now()`, scrub `email` → tombstone (`deleted+<id>@invalid`), null `encrypted_password` and metadata, revoke all sessions, delete outstanding one-time tokens; audit `user_deleted`.
3. Rows in the customer's app tables referencing `auth.users(id)` are the **developer's** responsibility (their FK semantics; the docs recommend `ON DELETE` behavior explicitly). Corebase does not cascade into app schemas.
4. `200 {}`.

Self-serve deletion (`DELETE /auth/v1/user`, the end-user deleting their own account, with re-auth and grace period) is **V1.x** — it needs product-level choices (grace window, data export) that don't gate V1.

| Failure | Response |
|---|---|
| Caller not service_role | `403 forbidden` |
| Unknown user id | `404 user_not_found` (admin surface is not enumeration-sensitive — service_role already has full read) |

## Decisions

- **D-114 — Account deletion in V1 is developer-initiated only (service_role admin API / dashboard): soft delete with tombstoned email, session revocation, and no cascade into app schemas. End-user self-serve deletion is deferred to V1.x.** *(Rationale: self-serve deletion is a product flow — re-auth, grace period, export — not an auth-security primitive; the admin path satisfies the operator's legal-request needs (GDPR erasure executed by the controller, i.e. the developer) without expanding the frozen V1 scope (D-013).)*

## Open Questions

- **OQ-114** — Mail-scanner link prefetch consuming single-use `/verify` tokens: ship V1 with direct-GET consumption (simple, standard) and add an interstitial "press to confirm" page only if support tickets prove prefetch breakage in the wild? Measure via `invalid_token`-after-`used` audit frequency.
- **OQ-115** — CAPTCHA (Cloudflare Turnstile) on `/signup` and `/recover`: V1 launch requirement or V1.x knob? Interacts with [abuse prevention](../12-business/03-abuse-prevention.md) (signup-spam economics) and adds SDK surface. Current lean: config-off in V1, wired so it can be enabled per project without a client SDK release.

## Dependencies

- Builds on: [01-auth-architecture.md](01-auth-architecture.md), [02-sessions-and-tokens.md](02-sessions-and-tokens.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-013, D-018, D-029, D-032, D-033)
- Feeds: [04-email-infrastructure.md](04-email-infrastructure.md) (every email this doc enqueues), [05-oauth-and-future.md](05-oauth-and-future.md) (the scope freeze points here), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md), [../13-quality/01-testing-strategy.md](../13-quality/01-testing-strategy.md), [../12-business/03-abuse-prevention.md](../12-business/03-abuse-prevention.md)
