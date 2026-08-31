# Platform Security

## Purpose

The platform-wide security baseline that isn't specific to one tenant boundary: where TLS ends and network-trust begins (and how honest V1 is about that), what's encrypted at rest and with what, which service holds which credential (the least-privilege matrix), the rate-limiting architecture in operational detail (D-033), the input-validation stance, security headers, CI dependency/image scanning, and the pre-1.0 posture on vulnerability disclosure and incident response. This doc adopts proposal §49–50, §65–67 and gives them numbers.

## Design

### TLS everywhere — the map

```
browser/app ──TLS 1.3──► Cloudflare edge ──TLS 1.3 (Full Strict)──► origin (Caddy/gateway on Hetzner)
                                                                       │  origin cert = Cloudflare Origin CA,
                                                                       │  firewall allows only Cloudflare IP ranges
gateway ──► internal services (auth, storage, worker)  : private network + service tokens (V1)   ◄— not mTLS yet
gateway/PostgREST ──► project pooler ──► postgres       : loopback / private-net, scram-sha-256 DB auth + TLS
services ──► control-plane Postgres                     : TLS (verify-full), scram-sha-256
node agent ──► object storage (R2)                      : TLS (S3 API)
```

**V1 honesty (AR-2 in the [threat model](01-threat-model.md)):** internal service-to-service traffic is **network-trust + bearer service tokens, not mTLS**. Justification: single region (D-024), one private network, a handful of first-party services, no third-party software on the internal net. mTLS buys defense against an attacker already on the private network — a scenario that, in V1's topology, also implies node compromise (game over for that node regardless). The cost (cert issuance, rotation, rotation-outage debugging) is real ops load for a 3-person team.

**mTLS trigger (D-086):** adopt internal mTLS when *any* of — a second region (cross-region links leave the trusted net), any third-party/untrusted workload on the internal network, or a compliance requirement — first occurs. Until then: private networking, per-service scoped tokens, and the origin firewall are the controls. Database connections use TLS + `scram-sha-256` from day one regardless (credentials must never cross even the private net in the clear).

### Encryption at rest — inventory

| Asset | Mechanism | Key custody | Decision |
|---|---|---|---|
| Customer database volumes | **LUKS full-disk encryption** on the node's data volumes (dm-crypt) | Node-boot key from the control plane's sealed store, never persisted to the node's own disk in plaintext | D-087 |
| Backups (base + WAL) | **pgBackRest native encryption** (`repo-cipher-type=aes-256-cbc`), per-project passphrase | Per-project backup key in the KMS/sealed store; the node holds it only transiently during a backup ([backups & PITR](../03-database-platform/05-backups-and-pitr.md)) | D-019, D-087 |
| Object storage (customer files) | R2 server-side encryption (provider-managed) | Cloudflare-managed; customer-managed keys are a post-V1 enterprise ask | D-017 |
| Secrets (JWT keypairs, DB creds, OAuth secrets) | **Envelope encryption** — per-secret data keys wrapped by a KMS master key; ciphertext in control-plane tables | Master key in KMS/sealed store; plaintext never lands in a control-plane table or its backups | D-035 |
| Control-plane database | LUKS + pgBackRest encryption, same tooling as customer DBs | Same sealed store | D-012, D-087 |

**Decision rationale for LUKS over "provider encryption only" (D-087):** Hetzner does not offer transparent managed-volume encryption comparable to a hyperscaler EBS-with-KMS, so LUKS is how "customer volumes encrypted at rest" becomes true rather than assumed. It also means a pulled/RMA'd disk is inert without the boot key. The cost is a boot-time key-delivery dance (node fetches its LUKS key from the control-plane sealed store over TLS at boot, key never written to node disk) — documented in [infra phases](../11-infrastructure/01-infra-phases.md).

### Least-privilege credential matrix

The governing rule (proposal §65–66): **each component holds the minimum credential to do its job and nothing that would widen a compromise. Nothing, anywhere, holds a customer's plaintext password — auth stores only password *hashes* — argon2id as specified here, superseded in the build by scrypt per D-211, which records the reasoning and a revisit trigger — and the DB uses scram verifiers.**

| Component | Holds | Explicitly does NOT hold | Why |
|---|---|---|---|
| Gateway (Fastify, D-016) | JWKS **cache** (public keys only) + a hash-lookup table of API-key → project/role; Redis handle for rate limits | No private signing keys, no DB credentials, no KMS grant | The most internet-exposed component holds only public/verify material; a gateway compromise cannot mint tokens or read secrets |
| Auth service | Project **private** signing keys (to mint JWTs) — fetched from the sealed store per project, held in memory; scrypt password hashes (D-211) | No node SSH, no Docker API, no other project's material beyond what it's actively signing for | Signing is auth's job; it's isolated from infra control |
| Control-plane API | A scoped **KMS grant** (decrypt data keys on demand) | No node SSH/Docker creds; no standing plaintext secrets (decrypts just-in-time, doesn't cache plaintext) | Envelope-encryption consumer; JIT decryption limits exposure window |
| Provisioner **worker** | Node **SSH / Docker API** credentials (per-node scoped), object-storage creds for provisioning | No KMS master, no customer JWT signing keys | Infra actuation is separated from secret custody; a worker compromise is bounded to nodes it already manages ([threat model](01-threat-model.md) e) |
| Node agent | Its own node-scoped token; the node's LUKS key transiently at boot | No cross-node credentials, no control-plane DB access | Node compromise stays node-local |
| PostgREST (per project) | The project's authenticator DB role creds + JWKS (public) to verify | No other project's anything | Per-project isolation extends to the data-API engine |

No single component compromise yields both "can decrypt secrets" and "can reach every node" — that separation (KMS grant in the API, node creds in the worker) is deliberate.

### Rate-limiting architecture (D-033)

**Redis-backed sliding-window** counters at the gateway, evaluated **before** project resolution reaches the database, so floods are shed at the cheapest possible point. Layered buckets, evaluated most-specific-first; a request must pass **every** applicable bucket:

```
Request ──► [IP bucket] ──► [API-key bucket] ──► [project bucket] ──► [endpoint-class bucket] ──► backend
             per source IP    per anon/service   per project (plan)    auth vs REST vs storage
```

Sliding window (not fixed window) to avoid the boundary-burst doubling; implemented as a Redis sorted-set / Lua script for atomic check-and-increment. Health-check and internal IPs are allowlisted (never rate-limited) so liveness probes can't be starved.

**Endpoint classes** (different risk profiles get different budgets):

- **auth** — `/auth/v1/*` (login, signup, reset): the credential-stuffing target, tightest limits.
- **rest** — `/rest/v1/*`: the workhorse, generous.
- **storage** — uploads/downloads: byte-and-request shaped.

**Default numbers (V1 starting point, tunable per plan):**

| Bucket | anon | authenticated | Notes |
|---|---|---|---|
| auth endpoints | per-endpoint budgets | n/a | Stuffing/enumeration defense; owned by the [auth flows](../05-auth/03-flows.md) rate-limit table (normative): login 10 / 5 min per email + 30 / 5 min per IP; `/recover`, `/resend` 4 / h per email + 10 / h per IP; identifier buckets stack on IP buckets (calibration: OQ-086) |
| REST, per IP (anon) | **300 rpm** | — | Public frontend traffic |
| REST, per API-key/user | — | **1,500 rpm** (anon ×5) | Authenticated users get 5× the anon allowance |
| storage, per key | 120 rpm | 600 rpm | Plus per-plan bandwidth caps (metered, [pricing & plans](../12-business/02-pricing-and-plans.md)) |
| **per-project ceiling** | Free: 3k rpm · Pro: 30k rpm · Team: 150k rpm | — | Aggregate cap protects the project's own container and co-tenants; scales by plan |

These are *starting* values to be tuned from real traffic (OQ-086); they're deliberately generous enough not to bite a real app's first users and tight enough to make abuse uneconomical.

**429 semantics:** over-limit responses are `429 Too Many Requests` with a **`Retry-After`** header (seconds until the window frees) and the standard error envelope `{error:{code:"rate_limited", message, request_id}}` (D-032). `RateLimit-Remaining`/`RateLimit-Reset` headers advertise the budget so well-behaved clients back off before hitting the wall. Rate-limit rejections are logged (with request_id, IP, key, bucket) for abuse analytics but at a sampled rate to avoid log floods amplifying the attack.

### Input validation & SQL safety

- **zod at every boundary of the TS monolith** (D-088): control-plane API request bodies, query params, webhook payloads, and job payloads are parsed through zod schemas at the edge of each module; unparsed input never reaches business logic. A parse failure is a `400` with the field path, never a 500.
- **SQL is always parameterized. No string-built SQL anywhere in Corebase's own code** (D-088) — control-plane queries use parameterized queries / a query builder with bound params; dynamic identifiers (rare, e.g. provisioning a per-project role name) go through an allowlist + identifier-quoting helper, never interpolation. The data *API* is PostgREST, which parameterizes by construction; Corebase writes no ad-hoc SQL string concatenation. This is a lint-enforced rule (ban raw-string query construction in CI).
- Output: the uniform error envelope (D-032) never leaks stack traces or SQL to clients (§105).

### Security headers

**Dashboard** (`app.corebase.com`, Next.js): `Content-Security-Policy` (strict, nonce-based, no `unsafe-inline` in scripts), `Strict-Transport-Security` (2y, includeSubDomains, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` / `frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` locking down camera/mic/geo. Auth cookies: `HttpOnly`, `Secure`, `SameSite=Lax` (session) with CSRF tokens on state-changing dashboard actions.

**API** (`*.corebase.co`): HSTS; `X-Content-Type-Options: nosniff`; CORS handled per project (customer-configured allowed origins, default same-origin — a permissive `*` is opt-in and warned about, since with `anon` it can widen exposure); no CSP needed (not HTML). Cloudflare adds a baseline layer; the origin sets the authoritative headers.

### CI dependency & image scanning

Gated in the pipeline ([iac & cicd](../11-infrastructure/02-iac-and-cicd.md)):

- **Dependencies:** pnpm `--frozen-lockfile`; `pnpm audit` / dependency-review on PRs; Renovate with a cooldown (no day-0 auto-merges — supply-chain window, [threat model](01-threat-model.md) f). High-severity advisories block merge.
- **Images:** fleet base images (postgres, PgBouncer, PostgREST, gateway) pinned **by digest**, built in CI, scanned (Trivy/Grype) for known CVEs before promotion; a critical unpatched CVE blocks the image. Deploy verifies the digest it's shipping matches the scanned one.
- **Secrets scanning:** pre-commit + CI secret scanner (gitleaks) so a key/credential never lands in git history.

### Vulnerability disclosure & incident response

**Disclosure (pre-1.0 stance):**

- **`security@corebase.com` private inbox** from day one, plus a published `/.well-known/security.txt` and a short responsible-disclosure policy: report privately, we acknowledge within **1 business day**, triage severity within **3 business days**, and commit to fixing critical isolation/auth issues on an expedited timeline with credit to the reporter.
- **No paid bug bounty before 1.0** (D-089, AR-4): pre-1.0 the code churns and immature areas are known; a bounty pre-PMF mostly funds rediscovery of things we already know are rough, and the payout/triage load is a distraction for a 3-person team. We *do* welcome and credit unpaid disclosures now, and stand up a funded bounty at 1.0 once an external security review has passed. This is a resourcing decision, not a security-value judgment.

**Incident response basics:**

| Severity | Definition | Response |
|---|---|---|
| **Sev-1** | Cross-tenant data exposure, auth bypass, secrets compromise, or the isolation suite red in prod | Page immediately; incident commander; deploy freeze (D-085); begin customer-notification clock |
| **Sev-2** | Single-project data exposure (e.g. a leaked service key we detect), significant availability loss | Page on-call; fix expedited; notify affected customer |
| **Sev-3** | Vulnerability with no confirmed exploitation; degraded non-critical function | Ticket, scheduled fix |

**Customer-notification rule of thumb:** any confirmed unauthorized access to, or exposure of, a customer's data triggers notification of that customer **without undue delay** (target: within 72 hours of confirmation, aligning early with the GDPR breach-notification norm even before a formal compliance program exists, AR-3), with what we know, what we've done, and what they should do (e.g. rotate keys). Notification isn't gated on a complete root-cause — an interim "we detected X, here's the immediate action" goes out first. Post-incident, a written retro with corrective actions (and, for isolation incidents, a new isolation-suite case that would have caught it — [tenant isolation tests](03-tenant-isolation-tests.md)).

## Decisions

- **D-086 — V1 internal service-to-service traffic uses private networking + per-service scoped bearer tokens, not mTLS; database connections use TLS + scram-sha-256 always. Adopt internal mTLS when the first of these occurs: a second region, any third-party/untrusted workload on the internal network, or a compliance requirement.** *(Rationale: in a single-region, all-first-party topology mTLS defends a scenario that already implies node compromise, while costing real cert-rotation ops load a 3-person team can't absorb; the trigger conditions are exactly when that calculus flips.)*
- **D-087 — Encryption at rest: LUKS full-disk encryption on customer and control-plane data volumes (boot key delivered from the sealed store, never persisted to node disk), pgBackRest native per-project encryption for backups, R2 SSE for objects, envelope encryption for secrets (D-035).** *(Rationale: Hetzner lacks transparent managed-volume encryption, so LUKS is what makes "encrypted at rest" true rather than assumed, and renders a pulled disk inert; per-project backup keys contain blast radius.)*
- **D-088 — zod validation at every boundary of the TS monolith; all SQL parameterized with a CI-enforced ban on raw-string SQL construction in Corebase's own code (dynamic identifiers go through an allowlist + quoting helper).** *(Rationale: injection and malformed-input bugs are eliminated structurally and by lint rather than by reviewer vigilance; PostgREST already parameterizes the data API, so this governs only control-plane/first-party code.)*
- **D-089 — No paid bug bounty before 1.0; a private `security@` disclosure inbox with published SLAs (1-day ack, 3-day triage) and `security.txt` exists from day one, with a funded bounty standing up at 1.0 after an external security review.** *(Rationale: pre-PMF a bounty mostly funds rediscovery of known-immature areas and loads a 3-person team; unpaid credited disclosure captures the security value now without the payout/triage overhead.)*

## Open Questions

- **OQ-086 — Rate-limit numbers need real-traffic calibration:** the defaults above are first-guess; the auth-endpoint limit especially must be validated against a real mobile app's login-retry patterns (offline→online bursts) so legitimate users aren't 429'd. Instrument and tune in the first month of a private beta.
- **OQ-087 — KMS / sealed-store choice for V1:** cloud KMS vs a self-hosted sealed store (e.g. an age/SOPS-encrypted store, or Vault) on Hetzner where no managed KMS exists — affects D-035, D-087, and the LUKS boot-key delivery. Decide with [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md); owner: infra.

## Dependencies

- Builds on: [threat model](01-threat-model.md), [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md) (D-035), [backups & PITR](../03-database-platform/05-backups-and-pitr.md) (D-019), [audit & admin access](../02-control-plane/05-audit-and-admin-access.md), [request pipeline](../04-data-api/02-request-pipeline.md) (D-016, D-033), [infra phases](../11-infrastructure/01-infra-phases.md), [iac & cicd](../11-infrastructure/02-iac-and-cicd.md)
- Feeds: [tenant isolation tests](03-tenant-isolation-tests.md) (incident response, release gate), [abuse prevention](../12-business/03-abuse-prevention.md) (rate limits, quotas), [pricing & plans](../12-business/02-pricing-and-plans.md) (per-plan caps), [risk register](../15-risks/01-risk-register.md)
