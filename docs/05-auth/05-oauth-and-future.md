# OAuth & the Auth Roadmap

## Purpose

The post-V1 auth roadmap in dependency order, with effort and complexity notes per item, and the security design for the nearest items (OAuth social login, account linking, magic links) done now so their V1-era groundwork (the `auth.identities` table, the `magic_link` token type, the redirect allowlist) is not accidental. Closes with the scope-freeze rule that protects auth V1 from all of it. Aligned with the [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md) and gated by D-003 (no enterprise features before PMF).

## Design

### Roadmap at a glance (dependency order)

| # | Feature | Target | Effort | Depends on |
|---|---|---|---|---|
| 1 | OAuth social login (Google, GitHub) | **V1.1** | M — 2–3 wk incl. dashboard config UI | V1 sessions/tokens, redirect allowlist, `auth.identities` |
| 2 | Magic links | **V1.1** | S — days | `one_time_tokens` + email pipeline, both exist in V1 |
| 3 | Anonymous sign-in | **V1.2** | S–M — 1 wk | `is_anonymous` column (modeled in V1), linking rules from #1 |
| 4 | MFA / TOTP | **V1.2** | M — 2–3 wk | Sessions model; introduces `aal` claim |
| 5 | Passkeys / WebAuthn | **V2** | L — UX/recovery design dominates | MFA's factor model + `aal` |
| 6 | Phone / SMS OTP | **deferred, no target** | M code, L ops/fraud | — (deliberately parked) |
| 7 | SAML / enterprise SSO | **V3** | L–XL | Enterprise tier existing at all (D-003) |

### 1. OAuth social login — V1.1 (Google + GitHub first)

Google and GitHub cover the two dominant end-user populations of Corebase customers' apps (consumer + developer tools) and have the two best-behaved OAuth implementations; every further provider is config, not architecture. Apple is deliberately third (OQ-118): its signed-JWT client secret, name-only-on-first-consent quirk, and paid developer account make it the wrong first implementation target.

**The flow** (authorization-code, server-side exchange — tokens never transit the browser):

1. Client → `GET /auth/v1/authorize?provider=google&redirect_to=<app url>`. Auth validates `redirect_to` against the allowlist (same control as every other flow — see security note below), generates `state` (CSRF, 10 min TTL, stored server-side with the validated `redirect_to` and PKCE material), 302 → provider consent URL with Corebase's per-project client_id and callback.
2. User authenticates at the provider.
3. Provider → `GET https://<ref>.corebase.co/auth/v1/callback?code=…&state=…` — **one fixed callback per project host**, registered with the provider; the app-level destination rides the server-side `state` record, never the provider redirect.
4. Auth verifies `state`, then **exchanges `code` server-side** (client_secret from per-project provider credentials, envelope-encrypted per D-035) for provider tokens; fetches the identity (OIDC `id_token` verified against provider JWKS for Google; `/user` + `/user/emails` API for GitHub).
5. **Find-or-create**: look up `auth.identities (provider, provider_user_id)`.
   - Found → sign in that user.
   - Not found → account-linking rules (below) → either attach an identity row to an existing user or `INSERT auth.users` (no password, `email_confirmed_at` set only if the provider attests the email is verified) + `INSERT auth.identities` with `identity_data` (provider profile snapshot).
6. Issue **Corebase tokens** — ordinary session + refresh + ES256 access JWT per [sessions & tokens](02-sessions-and-tokens.md); provider tokens are not the session. 302 → the `redirect_to` captured in step 1, tokens in the URL fragment.

**PKCE** (S256) is supported end-to-end for mobile/SPA clients: the SDK generates `code_verifier`, Corebase's `/authorize` records the challenge and plays the confidential-client role against the provider, and the final code exchange at `/token` requires the verifier. Public clients get code interception protection without a client secret in the binary.

**The critical security control is the redirect-URL allowlist** — stated in V1 ([auth architecture](01-auth-architecture.md), checklist item 6) and doubly load-bearing here: the post-OAuth redirect carries tokens in the fragment, so an unvalidated `redirect_to` is a full account-takeover primitive (attacker crafts an authorize URL whose final hop exfiltrates the victim's tokens to attacker.com). Exact-origin + path-prefix matching, no wildcards in origins, validated at step 1 *and* re-checked at step 6 from the server-side state record.

**Per-project provider credentials**: each project registers its own OAuth app (its own consent-screen branding) and stores client_id/client_secret in project config (encrypted, D-035; dashboard UI). No shared Corebase-wide OAuth app in V1.1 — a shared app is a consent-screen phishing surface and a single revocation point for every project at once.

### Account linking rules (with OAuth, V1.1)

The trap first: **account takeover via unverified email.** Attacker signs up with victim@gmail.com by password and never verifies it. Victim later clicks "sign in with Google" (which attests victim@gmail.com, verified). Naive linking attaches the Google identity to the attacker's pre-created user — the attacker's password now opens an account the victim believes is theirs, and everything the victim's app stores lands in an attacker-readable account.

Rules (evaluated at flow step 5, "not found" branch):

1. Provider email **verified by the provider** AND matches an existing user whose `email_confirmed_at` is set → **auto-link**: add identity row to that user, sign them in. (Both sides proved control of the mailbox; this is the safe, expected UX.)
2. Provider email matches an existing user who is **unconfirmed** → **no link, no sign-in**: `409 email_conflict_unverified`. The pre-existing unverified account can complete verification, or the developer resolves via admin API. This rule is the takeover prevention.
3. Provider email **not verified by the provider** (GitHub allows unverified addresses; some OIDC IdPs set `email_verified=false`) → treat as no email match: create a **new** user with unconfirmed email; never auto-link on an unverified assertion from either side.
4. No email match at all → new user.
5. Manual linking/unlinking of additional identities for a logged-in user (`POST/DELETE /auth/v1/user/identities`) requires a fresh session (recent re-auth) and forbids removing the **last** sign-in method.

### 2. Magic links — V1.1

`POST /auth/v1/magiclink` `{email}` → same-shape-200 (enumeration-resistant like `/recover`), email with single-use link → `/verify?type=magic_link` → session. Effort is **small** because it is a recomposition of V1 parts: the `magic_link` token type already exists in `auth.one_time_tokens`, delivery is the [email pipeline](04-email-infrastructure.md) (magic-link sends count against D-116 caps — they are the bulk-mail abuse vector par excellence), consumption is the `/verify` machinery, expiry 15 min. New-user handling: config flag `signup_via_magic_link` (default on) creates the user on first click, `email_confirmed_at = now()` (clicking *is* verification). Design choice inherited from Flow 2: consumed on GET, same OQ-114 scanner caveat.

### 3. Anonymous sign-in — V1.2

Guest users: `POST /auth/v1/signup?anonymous=true` → real `auth.users` row with `is_anonymous = true` (column exists since V1), no email, ordinary session/JWT (so RLS and `auth.uid()` work unchanged — the entire point: carts and drafts persist pre-registration). **Conversion**: setting email+password (or an OAuth link) on an anonymous user flips `is_anonymous`, runs verification, keeps `id` — no data migration for the app. Costs that make it V1.2 not V1.1: row-garbage accumulation (needs a configurable reaper for stale anonymous users), rate-limit tuning (free user-creation endpoint), and linking rules must exist first.

### 6 (out of order because it is parked). Phone / SMS — deferred, justified

- **Cost**: SMS is per-message money in every country, on Corebase's bill under shared infra — a free tier with SMS auth is a subsidy to strangers, hostile to the economics lane (D-006, [cost model](../12-business/01-cost-model.md)).
- **Fraud magnet**: SMS-pumping/toll fraud (attackers trigger OTPs to premium-rate ranges they profit from) is an industry-wide extraction scheme that has cost platforms millions; defending requires per-country allowlists, velocity heuristics, and carrier relationships — an ops capability, not a feature.
- Deliverability is carrier-political (sender-ID registration per country, filtering), and SMS is simultaneously the *weakest* common factor (SIM swap).
- Verdict: no target version. Revisit only on concrete paying demand, and then custom-Twilio-credentials-per-project first (their spend, their fraud surface) — mirroring the D-117 custom-SMTP pattern.

### 4. MFA / TOTP — V1.2

- **Enrollment**: `POST /auth/v1/factors` (authenticated, fresh session) → TOTP secret provisioning URI/QR; `POST /auth/v1/factors/:id/verify` with a valid code activates the factor. New table `auth.mfa_factors` (id, user_id, type `totp`, status, encrypted secret, created_at, last_used_at) + one-time recovery codes (hashed, single-use).
- **Challenge**: password grant against an MFA-enrolled user returns a **partial** token (`aal: "aal1"`, short exp) unusable as `aal2`; `POST /auth/v1/factors/:id/challenge` + code verification upgrades the session and reissues the access JWT with **`aal: "aal2"`** — the claim was reserved (not stubbed) in [sessions & tokens](02-sessions-and-tokens.md). RLS can then gate sensitive tables on `request.jwt.claims ->> 'aal'`.
- TOTP drift window ±1 step (30 s), per-factor replay protection (a code never verifies twice), rate limit 5 attempts/5 min per factor.
- Effort M; the risky part is not the RFC 6238 math but session-upgrade semantics and recovery-code UX.

### 5. Passkeys / WebAuthn — V2, deliberately after MFA

Library maturity is fine (`@simplewebauthn/server` et al.); the load is **product design**: credential naming/management UI, cross-device and cross-ecosystem recovery (user's only passkey lives on a lost phone), fallback-method policy (a passkey account with a weak fallback is exactly as strong as the fallback), and support burden for "it worked on my Mac but not my PC." MFA first also builds the factor model (`auth.mfa_factors`, `aal`) that WebAuthn slots into — passkeys arrive as a factor type plus a primary-credential mode, not a parallel system.

### 7. SAML / enterprise SSO — V3 (enterprise-gated, D-003)

SAML is XML-signature security archaeology (signature-wrapping attack classes), per-customer IdP onboarding (metadata exchange, attribute mapping, SCIM provisioning next), and it monetizes only against an enterprise tier that does not exist pre-PMF. When built, strong bias to wrapping a dedicated component or service rather than parsing XML dsig in-house — same compose-don't-rewrite instinct as D-005/D-011. Nothing earlier in this roadmap depends on it.

### The scope-freeze rule

**D-119 makes it binding: auth V1 is exactly the flows in [flows](03-flows.md).** No provider "while we're in there," no magic links "since it's three days," no TOTP "for our own dashboard's sake" (dashboard/platform MFA is a *control-plane* concern — [platform API](../02-control-plane/02-platform-api.md) — and must not smuggle features into customer-app auth). D-013's entire safety argument is a small, frozen, auditable surface; every unplanned addition spends that argument down. The only sanctioned V1-era work for this doc's features is what is already listed as V1 groundwork: the `auth.identities` DDL, the `magic_link` token type, the `is_anonymous` column, and the redirect-allowlist mechanism.

## Decisions

- **D-118 — OAuth ships in V1.1 with Google and GitHub only: authorization-code flow with server-side code exchange at `/auth/v1/callback`, PKCE (S256) for public clients, per-project provider credentials (no shared Corebase OAuth app), and allowlist-validated redirects checked at authorize time and again at token delivery. Account linking: auto-link only when the provider attests a verified email matching an existing *confirmed* user; a match against an unconfirmed user is a hard `409 email_conflict_unverified` (never a link); unverified provider emails never auto-link and create unconfirmed users.** *(Rationale: code+PKCE with server-side exchange keeps provider tokens out of browsers; the redirect allowlist is the control that stops authorize-URL token exfiltration; the linking rule closes the pre-registered-unverified-email account-takeover trap, which is the classic OAuth-linking breach.)*
- **D-119 — Auth scope freeze: nothing enters auth V1 beyond the flows specified in [03-flows.md](03-flows.md); post-V1 order is fixed as OAuth (V1.1) → magic links (V1.1) → anonymous sign-in (V1.2) → MFA/TOTP (V1.2) → passkeys (V2) → SAML/SSO (V3), with phone/SMS deferred with no target version. Exceptions require a decision-log entry superseding this one.** *(Rationale: D-013's build-in-house bet is only sound while the surface stays small and auditable; a written freeze with a named amendment procedure is what keeps "it's just one endpoint" from eroding it, and the phone deferral removes a per-message cost + SMS-pumping fraud surface the economics lane cannot absorb.)*

## Open Questions

- **OQ-118** — Apple Sign-In timing: demanded by any customer shipping iOS consumer apps (App Store mandates it when other social logins are offered), but carries the signed-JWT client secret and name-only-once quirks. V1.2 candidate after the Google/GitHub pattern proves out.
- **OQ-119** — Magic-link vs 6-digit OTP code delivery for email sign-in: links break in mail-scanner and cross-device cases (OQ-114); codes survive both but are phishable by proxy pages. Offer both under one endpoint or pick one for V1.1? Decide during V1.1 design with SDK ergonomics in view ([SDK spec](../10-cli-and-sdk/03-sdk-spec.md)).

## Dependencies

- Builds on: [01-auth-architecture.md](01-auth-architecture.md) (identities DDL, redirect allowlist), [02-sessions-and-tokens.md](02-sessions-and-tokens.md) (session issuance, `aal` reservation), [03-flows.md](03-flows.md) (the frozen V1 baseline), [04-email-infrastructure.md](04-email-infrastructure.md) (magic-link delivery + caps), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-003, D-005, D-013, D-035)
- Feeds: [../14-roadmap/03-post-v1-roadmap.md](../14-roadmap/03-post-v1-roadmap.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md), [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md) (which tiers gate which providers/factors)
