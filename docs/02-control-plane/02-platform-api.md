# Platform API (`/v1`)

## Purpose

The REST contract of the control plane (D-039, proposal §104–106): the API the dashboard and the CLI call to manage orgs, projects, keys, and secrets. This is **not** the data-plane API customers' apps call (that is [REST API design](../04-data-api/01-rest-api-design.md)); it never touches customer data. Served by the modular monolith (D-010) at `api.steadhold.dev/v1`.

## Design

### Authentication

Two principals, one permission model:

| Client | Mechanism | Notes |
|---|---|---|
| Dashboard (browser) | **Session cookie** — httpOnly, Secure, SameSite=Lax, opaque session id backed by Redis; a CSRF token echoed in `x-csrf-token` on mutating requests, issued by login, signup and `GET /v1/auth/me` (D-473) | Sessions expire after 7 days idle, 30 days absolute |
| CLI / CI / scripts | **Personal Access Token (PAT)** — `Authorization: Bearer shp_<40 chars>`; created in dashboard or via `steadhold login` device flow | Stored hash-only per D-060; optional expiry; scoped (see D-062) |

Both resolve to a `user_id`; every request is then authorized against `organization_members.role`. Rules the API enforces (not the schema — see [data model](01-data-model.md)):

- `owner`: everything, including org deletion, billing, member role changes.
- `admin`: everything except org deletion, billing changes, and owner-role grants.
- `member`: read everything, mutate projects (create/pause/resume), no member/key/secret management.
- The last `owner` cannot leave or be demoted (`409 LAST_OWNER`).

Operator (staff) access is a separate surface — see [audit & admin access](05-audit-and-admin-access.md).

### Conventions

- **Errors** (D-032, §105): every non-2xx body is
  ```json
  { "error": { "code": "PROJECT_NOT_FOUND", "message": "No project with ref \"abcd1234efgh5678\".", "request_id": "req_01J8ZK3V9M" } }
  ```
  Never a stack trace, never a bare string.
- **`X-Request-ID`** (D-032, §106): honored if the client sends one (sanitized, ≤128 chars), generated otherwise; echoed on **every** response including errors; propagated into logs, audit rows, and enqueued jobs' payloads so a support ticket's id traces end-to-end.
- **Pagination**: cursor-based everywhere (D-039). `?limit=` (default 20, max 100) and `?cursor=`; responses carry `pagination.next_cursor` (opaque, base64 of `(created_at, id)`) or `null`. No offset pagination anywhere.
- **Idempotency**: mutating endpoints (POST/PATCH/DELETE) accept `Idempotency-Key: <uuid>`. Required on `POST /v1/projects` and all lifecycle endpoints; recommended elsewhere. Semantics: first request stores `(key, endpoint, request_hash, response)` for 24h; a replay with the same key + same body returns the stored response; same key + different body → `409 IDEMPOTENCY_KEY_REUSED`. For provisioning endpoints the key flows through to `provisioning_jobs.idempotency_key` ([job queue](04-job-queue-and-workers.md)).
- **Timestamps** RFC 3339 UTC; ids are `usr_/org_/prj_`-prefixed uuids in transport for greppability (`prj_` + uuid).

### Error-code catalog

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body/query failed schema validation; `details[]` lists field errors |
| 401 | `UNAUTHENTICATED` | Missing/expired session or PAT |
| 403 | `FORBIDDEN` | Authenticated but role insufficient |
| 403 | `CSRF_REQUIRED` | Session cookie present, `x-csrf-token` missing or stale. Recoverable without the user: `GET /v1/auth/me` re-issues the token (D-473) |
| 403 | `PROJECT_SUSPENDED` | Project suspended for abuse/billing ([abuse prevention](../12-business/03-abuse-prevention.md)) |
| 404 | `PROJECT_NOT_FOUND` / `ORG_NOT_FOUND` / `RESOURCE_NOT_FOUND` | Also returned instead of 403 for resources in orgs the caller cannot see (no existence oracle) |
| 409 | `PROJECT_NOT_READY` | Lifecycle action invalid in current state (e.g. pause while `provisioning`) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different request body |
| 409 | `LAST_OWNER` | Would leave the org ownerless |
| 410 | `PROJECT_PURGED` | Restore attempted after the 7-day window (D-038) |
| 422 | `QUOTA_EXCEEDED` | Plan quota hit (project count, secret count, ...); `details.quota` names it |
| 429 | `RATE_LIMITED` | Includes `Retry-After` header |
| 500 | `INTERNAL` | Logged with `request_id`; message is generic |
| 503 | `PROVISIONING_UNAVAILABLE` | No placement capacity; job accepted=false |

### Resources

#### Auth & session (dashboard login — platform accounts, not customer-app auth)

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /v1/auth/signup` | Create platform account | Email verification required before project creation |
| `POST /v1/auth/login` | Password login → sets session cookie | Rate-limited per identifier; timing-safe |
| `POST /v1/auth/logout` | Destroy session | |
| `POST /v1/auth/verify-email` | Consume verification token | |
| `POST /v1/auth/password-reset` / `POST /v1/auth/password-reset/confirm` | Reset flow | Enumeration-resistant (always 202) |
| `GET /v1/auth/me` | Current user + org memberships | Also returns `csrf_token` for a cookie session, so a tab that did not itself log in can mutate (D-473); absent for a PAT |
| `GET/POST/DELETE /v1/auth/tokens` | List / create / revoke PATs | Create returns the token **once** |

#### Organizations & members

| Method & path | Purpose |
|---|---|
| `POST /v1/orgs` · `GET /v1/orgs` · `GET/PATCH/DELETE /v1/orgs/:org_id` | CRUD; delete requires zero non-purged projects |
| `GET /v1/orgs/:org_id/members` · `PATCH/DELETE /v1/orgs/:org_id/members/:user_id` | List, change role, remove |
| `POST /v1/orgs/:org_id/invites` · `GET .../invites` · `DELETE .../invites/:id` | Invite by email, list pending, revoke. Create returns the token **once** until the Phase-4 email sender exists |
| `POST /v1/invites/accept` | Accept an invite (D-213). The invite's email must match the accepting account, or a forwarded email is a join token |
| `POST /v1/invites/accept` | Accept with invite token (auth required) |

#### Projects

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /v1/projects` | Create → returns `202` + project in `creating` | `Idempotency-Key` required |
| `GET /v1/projects?org_id=` | List (cursor-paginated); excludes `deleted`, includes `soft_deleted` with `restorable_until`. Scoped to the caller's own organizations | |
| `GET /v1/projects/:ref/keys` | `anon` returned in the clear (publishable by design); `service_role` needs `?reveal=true`, the `key.manage` capability, and writes a `key.revealed` audit row | Prefix is a label — `shk_anon_<ref4>` (D-218) |
| `GET /v1/projects/:ref/.well-known/jwks.json` | Per-project JWKS (D-014). Unauthenticated and cacheable: a public key is public, and a JWKS behind auth breaks every verifier when a credential rotates | |
| `GET /v1/projects/:ref` | Detail incl. `database` block when `ready` | |
| `PATCH /v1/projects/:ref` | Rename, change `project_group_id` | `ref`, `region`, `environment` immutable |
| `POST /v1/projects/:ref/pause` | → `pausing` (D-008) | 202; `PROJECT_NOT_READY` unless `ready` |
| `POST /v1/projects/:ref/resume` | → `resuming` | 202; also auto-triggered by data-plane traffic ([provisioning](../03-database-platform/01-postgres-provisioning.md)) |
| `DELETE /v1/projects/:ref` | → `deleting` → `soft_deleted` (D-038) | Requires `confirm: "<ref>"` in body |
| `POST /v1/projects/:ref/restore` | Soft-deleted → `resuming` → `ready` | `410 PROJECT_PURGED` after window |
| `GET /v1/projects/:ref/health` | Per-service status (db/pooler/postgrest/auth/storage) | |

#### Keys, secrets, usage, audit

| Method & path | Purpose | Notes |
|---|---|---|
| `GET /v1/projects/:ref/api-keys` | List `anon`/`service_role` (prefix only) | |
| `POST /v1/projects/:ref/api-keys/rotate` | Rotate one kind; old key grace period 24h | Enqueues `rotate_credentials` |
| `GET /v1/projects/:ref/secrets` | Names + metadata only, **never values** | |
| `PUT /v1/projects/:ref/secrets/:name` · `DELETE ...` | Upsert / remove (value write-only) | Audited as `secret.updated`, value redacted |
| `GET /v1/projects/:ref/usage?metric=&from=&to=` | Aggregated `usage_records` | |
| `GET /v1/orgs/:org_id/usage` | Org rollup for billing page | |
| `GET /v1/orgs/:org_id/audit-logs` · `GET /v1/projects/:ref/audit-logs` | Customer-visible audit surface ([detail](05-audit-and-admin-access.md)) | Cursor-paginated, filter by `action`, `actor` |
| `GET /v1/regions` | Static in V1: `eu-central` (D-024) | |

### Examples

**Create project**

```http
POST /v1/projects
Content-Type: application/json
Idempotency-Key: 7f9c2e1a-6b0d-4e5f-9a3c-d21b84e7c901
Cookie: sh_session=...

{
  "org_id": "org_a1b2c3d4-...",
  "name": "acme-production",
  "region": "eu-central",
  "plan": "free",
  "environment": "production"
}
```

```http
HTTP/1.1 202 Accepted
X-Request-ID: req_01J8ZK3V9M
Location: /v1/projects/kxqwrtplmzensfba

{
  "project": {
    "id": "prj_e5f6a7b8-...",
    "ref": "kxqwrtplmzensfba",
    "name": "acme-production",
    "org_id": "org_a1b2c3d4-...",
    "region": "eu-central",
    "plan": "free",
    "environment": "production",
    "status": "creating",
    "created_at": "2026-08-27T14:03:22Z"
  },
  "job": { "id": "job_9c8d7e6f-...", "type": "provision_project", "state": "pending" }
}
```

The client polls `GET /v1/projects/kxqwrtplmzensfba` (or subscribes to dashboard SSE) until `status: "ready"`, at which point the response includes:

```json
{
  "project": { "ref": "kxqwrtplmzensfba", "status": "ready", "...": "..." },
  "database": {
    "host": "kxqwrtplmzensfba.steadhold.app",
    "port": 5432, "pooler_port": 6543, "pg_version": "17",
    "connection_strings": {
      "pooled": "postgres://...@kxqwrtplmzensfba.steadhold.app:6543/postgres",
      "direct": "postgres://...@kxqwrtplmzensfba.steadhold.app:5432/postgres"
    }
  },
  "api_keys": [
    { "kind": "anon", "prefix": "shk_anon_kxqw" },
    { "kind": "service_role", "prefix": "shk_srv_kxqw" }
  ]
}
```

(Full keys and DB password are returned exactly once, in the first `ready` response after creation or rotation — D-060.)

**List projects with cursor pagination**

```http
GET /v1/projects?org_id=org_a1b2c3d4&limit=2 → 200

{
  "projects": [
    { "ref": "kxqwrtplmzensfba", "name": "acme-production", "status": "ready", "...": "..." },
    { "ref": "ymzpalrkcnexqvtd", "name": "acme-staging", "status": "paused", "...": "..." }
  ],
  "pagination": { "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wOC0y...", "has_more": true }
}
```

**Quota failure**

```json
HTTP/1.1 422
{ "error": { "code": "QUOTA_EXCEEDED",
             "message": "Free plan allows 2 active projects; this org has 2.",
             "request_id": "req_01J8ZKQ0AH",
             "details": { "quota": "projects_per_org", "limit": 2, "current": 2 } } }
```

### Rate limits

Layered per D-033, enforced at the gateway with Redis sliding windows, keyed per token/session (not just IP):

| Bucket | Limit (V1 defaults) | Notes |
|---|---|---|
| Per IP, unauthenticated | 30/min | Login, signup, reset |
| Per identifier, auth endpoints | 10/min per email | Brute-force control |
| Per session or PAT, reads | 300/min | |
| Per session or PAT, mutations | 60/min | |
| Project lifecycle ops (create/pause/resume/delete/restore) | 10/hour per org | Provisioning is expensive; abuse lever |

Every 429 carries `Retry-After` plus `X-RateLimit-Limit/-Remaining/-Reset` headers. Numbers are provisional pending [cost model](../12-business/01-cost-model.md) and [platform security](../06-security/04-platform-security.md) tuning.

## Decisions

- **D-062 — Platform API authentication is dual-mode: httpOnly session cookies (+CSRF token) for the dashboard, and prefixed bearer PATs (`shp_...`, hash-stored, optionally expiring) for CLI/CI. PATs carry coarse scopes in V1: `read`, `write`, `admin`.** *(Rationale: cookies give the browser XSS-resistant sessions; bearer tokens are the only sane CLI/CI story; coarse scopes ship now, fine-grained scoping is deferred until someone needs it.)*
- **D-063 — `Idempotency-Key` is required on project-lifecycle mutations and honored on all mutations: 24h replay window, stored-response semantics, `409` on key reuse with a different body, and pass-through into `provisioning_jobs.idempotency_key`.** *(Rationale: makes client retries safe by construction and gives the two-phase enqueue its key for free — one idempotency system end-to-end instead of two.)*

Design rule without its own D number: not-found and no-permission collapse to `404` (`*_NOT_FOUND` codes) for any resource outside the caller's orgs — a 403/404 distinction is a cross-tenant existence oracle, so it is denied by construction (already reflected in the error catalog above).

## Open Questions

- OQ-043: Ready-notification transport for the dashboard — poll `GET /v1/projects/:ref` vs an SSE `/v1/events` stream. Polling ships first; decide SSE before the dashboard's project-creation UX is finalized ([dashboard IA](../09-dashboard/01-dashboard-ia.md)).
- OQ-044: Exact rate-limit numbers per plan tier (table above is a placeholder) — settle with [pricing & plans](../12-business/02-pricing-and-plans.md) and load testing.
- ~~OQ-175: **Response-envelope alignment.**~~ **Closed in P1b.** Every endpoint now returns the documented envelope: `POST` answers `202` with a `Location` header and `{ project, job }`, the list returns `{ projects, pagination }` with real keyset pagination, and ids are `prj_`/`org_`/`job_`-prefixed in transport. Done as one breaking change as the question asked, so it cost one break rather than four. The `api_keys` block is still absent because keys are P1e — that is a missing field in an otherwise correct shape, not a divergent shape.
- OQ-065: PAT lifetime policy — indefinite-by-default with revocation, or forced expiry (90 days) with refresh via `steadhold login`? Security prefers expiry; CI ergonomics prefer indefinite.

## Dependencies

- Builds on: [01-data-model.md](01-data-model.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-032, D-033, D-039), [../06-security/04-platform-security.md](../06-security/04-platform-security.md)
- Feeds: [03-provisioning-state-machine.md](03-provisioning-state-machine.md), [04-job-queue-and-workers.md](04-job-queue-and-workers.md), [../09-dashboard/01-dashboard-ia.md](../09-dashboard/01-dashboard-ia.md), [../10-cli-and-sdk/01-cli-spec.md](../10-cli-and-sdk/01-cli-spec.md), [../13-quality/02-release-and-versioning.md](../13-quality/02-release-and-versioning.md)
