# API Keys and Roles

## Purpose

Full specification of the two-key model (D-029): what the `anon` and `service_role` keys *are* (long-lived JWTs signed with the project keypair, D-014), the four Postgres roles they map onto with their exact grants, how a Corebase-Auth user JWT relates to the anon key (the dual-header pattern), and the lifecycle — display, storage, rotation, and emergency revocation with its honestly-stated blast radius. This model must be explainable in one paragraph (the D-029 rationale); this doc is the paragraph plus everything an implementer needs.

**The paragraph:** every project has two API keys. The `anon` key identifies your *app* and grants only what Row Level Security allows an anonymous visitor; it is safe to ship in browsers and mobile binaries. The `service_role` key bypasses RLS entirely and belongs only on servers you control. When a user signs in, your app keeps sending the anon key as `apikey` and additionally sends the user's own JWT as `Authorization` — the user's token, not the app's key, decides what rows they can see.

## Design

### Key anatomy

Both keys are ES256 JWTs signed with the project's private key (D-014) — the same keypair that signs user access tokens, so the data plane verifies everything with one cached JWKS.

```text
header   {"alg": "ES256", "typ": "JWT", "kid": "cbk_2026_08_7f3a"}
payload  {
  "iss":  "corebase",
  "ref":  "abck3xw7qpl2vnd8",     // the project — gateway cross-checks vs Host
  "role": "anon",                  // or "service_role" — becomes the PG role
  "iat":  1756252800,              // fixed at keypair issuance (see D-107)
  "exp":  2071785600               // iat + 10 years; rotation, not expiry,
}                                  // is the real lifecycle control
```

Properties that matter:

- **`ref` binds the key to the project.** A key presented against another project's hostname fails at the gateway even though the signature check alone would need the right JWKS anyway — defense in depth against routing bugs ([request pipeline](02-request-pipeline.md) hop 4).
- **`role` is the entire authorization payload.** No scopes, no permissions list — the key selects a Postgres role; everything else is grants + RLS inside the project database. This is what keeps the model one paragraph long.
- **Long `exp`, short *effective* lifetime.** 10 years of validity, but rotation (below) or revocation ends a key at any time. `exp` exists so a leaked pre-rotation key eventually dies even if every revocation mechanism failed.
- **`kid` names the keypair,** enabling dual-publish rotation. JWKS is served per project at `https://<ref>.corebase.co/auth/v1/.well-known/jwks.json` (D-014) and mirrored into the gateway routing entry and each PostgREST's `jwks.json` file.

### The four Postgres roles

Provisioned in every project database at step *d* of the create-project lifecycle ([system architecture](../01-architecture/01-system-architecture.md)); this SQL is the normative form:

```sql
-- The three "impersonation targets" — nobody ever logs in as these.
CREATE ROLE anon          NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role  NOLOGIN NOINHERIT BYPASSRLS;

-- The one login role: PostgREST's connection identity. NOINHERIT is load-
-- bearing — authenticator holds membership in the other three but exercises
-- none of their privileges until an explicit SET ROLE per request (D-015).
CREATE ROLE authenticator LOGIN NOINHERIT NOBYPASSRLS
  CONNECTION LIMIT 20;              -- sized with db-pool, see pooling doc
  -- password set via ALTER ROLE from the secret store (D-035), never in DDL

GRANT anon, authenticated, service_role TO authenticator;

-- Schema access: USAGE only. Table privileges are separate and deliberate.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Default privileges for objects developers create (D-108):
-- authenticated and service_role get full DML; anon gets NOTHING by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

-- Per-role safety valves (values per plan tier):
ALTER ROLE anon          SET statement_timeout = '5s';
ALTER ROLE authenticated SET statement_timeout = '15s';
ALTER ROLE service_role  SET statement_timeout = '60s';
```

| Role | Login? | RLS | Default grants | Who becomes it |
|---|---|---|---|---|
| `anon` | no | enforced | `USAGE` on schema only — **no table access until explicitly granted** | requests carrying only the anon key |
| `authenticated` | no | enforced | DML on developer-created tables (still filtered by RLS) | requests with a Corebase-Auth user JWT (`role: "authenticated"`) |
| `service_role` | no | **`BYPASSRLS`** | DML on developer-created tables, unfiltered | server-side requests with the service_role key; never browsers |
| `authenticator` | **yes** | n/a (never queries as itself) | membership in the other three, `NOINHERIT` | PostgREST's `db-uri`; the *only* data-API login role |

**D-108 makes anonymous access opt-in per table** — a deliberate departure from Supabase's grant-everything-then-RLS default, per the D-002 priority stack (isolation over DX). The dashboard's "allow anonymous access" toggle emits the explicit `GRANT ... TO anon`. And belt-plus-suspenders with D-036, an event trigger installed at provision time force-enables RLS on every new table in the exposed schema:

```sql
CREATE OR REPLACE FUNCTION corebase.force_rls() RETURNS event_trigger AS $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
             WHERE command_tag = 'CREATE TABLE'
               AND schema_name = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END; $$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER corebase_force_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION corebase.force_rls();
```

A new table is therefore deny-by-default for `anon` (no grant) *and* for `authenticated` (grants but RLS with zero policies = no rows) until the developer writes policies — there is never a moment where the API serves unprotected data (D-036). Policy patterns live in [RLS design](../06-security/02-rls-design.md); how the per-request `SET ROLE` + `SET LOCAL request.jwt.claims` executes is [request pipeline](02-request-pipeline.md) step 6.

### The dual-header pattern: app key vs user token

Two credentials travel on every browser request, doing different jobs:

```http
GET /rest/v1/todos?select=*
Host: abck3xw7qpl2vnd8.corebase.co
apikey: eyJhbGciOiJFUzI1NiIsImtpZCI6ImNia18yMDI2XzA4XzdmM2EifQ...   ← the ANON key
Authorization: Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6ImNia18yMDI2...   ← the USER's JWT
```

- **`apikey` authenticates the app to the gateway.** It proves "this traffic belongs to project `abck3xw7…` and is at least anonymous-tier" — it is what the gateway verifies, rate-limits by, and revokes ([request pipeline](02-request-pipeline.md) hops 4–5). It never reaches a `SET ROLE` decision when an Authorization header is present.
- **`Authorization` authenticates the user to the database.** PostgREST verifies it and its `role` claim (`authenticated` for Corebase-Auth-issued user tokens, per [sessions & tokens](../05-auth/02-sessions-and-tokens.md)) selects the Postgres role; its `sub` claim reaches RLS as `request.jwt.claims`.

Signed-out state: the SDK sends the anon key in *both* headers. If a client sends only `apikey`, the gateway injects `Authorization: Bearer <apikey value>` before proxying (**D-109**) so PostgREST always has exactly one code path ("verify Authorization, read role") and `db-anon-role` handles nothing security-relevant on its own. `service_role` usage is the same mechanics — the service key in both headers — and since `role: "service_role"` selects the `BYPASSRLS` role, it must never ship to a browser; the SDK refuses to construct a browser client with it (best-effort guard, documented loudly).

One subtlety worth stating: a user JWT from project A presented to project B fails signature verification (different keypair) — per-project keys are the tenant boundary for tokens, exactly the D-014 blast-radius rationale.

### Key display and storage

The keys are *derivable*: signing the fixed claims above with the project private key reproduces them. So Corebase does not need to store the JWTs to re-display them — and per D-060 ([data model](../02-control-plane/01-data-model.md)) it doesn't: `project_api_keys` holds `key_hash` (SHA-256, for the gateway revocation set) + `key_prefix` (12 chars, for support tickets and dashboard identification) + `kind`, `created_by`, `created_at`, `revoked_at`.

**Display rule (D-107):** these two keys are **not** show-once. The dashboard re-derives them on demand by signing with the project private key (decrypted via KMS per D-035, in worker/API memory only):

- `anon` — displayed freely on the project's API settings page. It ships in client bundles; treating it as a secret would be theater.
- `service_role` — masked by default (`cbk_7f3a…•••`), revealed via an explicit click that emits an `api_key.revealed` audit event (actor, IP, request_id → `audit_logs`, [audit & admin access](../02-control-plane/05-audit-and-admin-access.md)).

For the derived JWT to be byte-identical across reveals (so `key_hash` revocation lookups stay valid), signing uses **deterministic ECDSA (RFC 6979)** and the stored `iat` from keypair issuance. D-060's shown-once rule continues to govern everything *not* derivable from a stored keypair (platform PATs, invite tokens, DB passwords).

### Rotation

Rotation rotates the **keypair**; the API keys and all user tokens follow from it. Normal (non-emergency) flow:

```text
1. generate  — new ES256 keypair, kid cbk_2026_11_a91c; envelope-encrypt (D-035)
2. dual-publish — JWKS now serves BOTH kids (old + new); pushed to gateway
              routing entries (Redis pub/sub, ≤30 s, D-104) and re-rendered into
              each PostgREST jwks.json + `NOTIFY pgrst, 'reload config'` (D-100)
3. reissue   — derive new anon + service_role JWTs under the new kid; new rows
              in project_api_keys; auth module starts SIGNING user tokens with
              the new key immediately (old tokens still VERIFY via old kid)
4. swap      — developer replaces keys in their apps at their own pace;
              dashboard shows per-kid last-seen-at (gateway telemetry) so they
              can see when old-key traffic reaches zero
5. retire    — after the overlap window (default 30 days, shortenable; OQ-104),
              old kid is dropped from JWKS, old key rows get revoked_at, and the
              revocation set update propagates (≤30 s) — old keys now 401
```

The whole flow is a `rotate_credentials` job ([job queue](../02-control-plane/04-job-queue-and-workers.md)); every step is idempotent and resumable from the job checkpoint.

**Emergency revocation** (leaked `service_role` key — the scenario that matters) collapses steps 1–3 and 5 into one action, and the blast radius must be stated honestly:

| Immediately invalid | Effect |
|---|---|
| Old `anon` + `service_role` keys | every deployed app instance still holding them gets 401s — the customer's app is **hard down** until keys are swapped |
| All user **access tokens** signed with the old kid | verification fails; sessions interrupted |
| All active sessions' UX | refresh tokens are opaque server-side records ([sessions & tokens](../05-auth/02-sessions-and-tokens.md)), *not* signed by the keypair — so refresh still works and mints tokens under the new kid; users recover on next refresh (≤ access-token TTL) without re-login, but in-flight requests fail meanwhile |

The dashboard presents exactly this consequence list behind a type-the-project-ref confirmation, and the action lands in `audit_logs` as `project.keys_emergency_rotated`. Propagation to enforcement is the D-104 ≤ 30 s revocation SLO. There is no partial emergency mode — revoking only `service_role` while keeping the keypair would leave a signing key that the attacker may also hold; if the key leaked, assume the worst and rotate the pair.

### Per-key metadata in the control plane

One row per issued key in `project_api_keys` ([data model](../02-control-plane/01-data-model.md)): `kind`, `key_hash` (unique; feeds the gateway revocation set), `key_prefix`, `created_by`, `created_at`, `revoked_at`. Rotation adds rows rather than mutating them, so the table is also the rotation history; `kid`→key mapping is recoverable from the prefix (the `kid` is in the JWT header, inside the first 12 chars' decode). Gateway per-kid last-seen telemetry (step 4 above) lives in Prometheus, not this table — the control plane stores facts, not time series ([observability](../11-infrastructure/03-observability.md)).

## Decisions

- **D-107 — The anon and service_role keys are not show-once: they are re-derived on demand by deterministic ES256 (RFC 6979) signing over fixed claims (stored `iat`) with the envelope-encrypted project private key. `anon` is always displayable; `service_role` requires an explicit reveal click that writes an `api_key.revealed` audit event. Control-plane tables store hash + prefix only, refining — not overriding — D-060, whose shown-once rule still governs all non-derivable credentials.** *(Rationale: the keys are mathematically derivable from stored material, so "shown once" would be a false promise; deterministic signing keeps the displayed JWT byte-identical so hash-based revocation stays coherent; the asymmetric treatment matches the keys' actual sensitivity — anon ships in browsers, service_role is a database superkey.)*
- **D-108 — Default privileges in the exposed schema grant DML to `authenticated` and `service_role` only; `anon` receives no table privileges until explicitly granted (dashboard toggle emits the GRANT). A provision-time event trigger force-enables RLS on every new table in the exposed schema.** *(Rationale: D-002 puts isolation above DX — a forgotten policy should fail closed, not open; force-RLS plus no-anon-grants means a freshly created table leaks nothing through any role the API can reach, making D-036 structural rather than procedural.)*
- **D-109 — `apikey` is mandatory on every data-plane request; when `Authorization` is absent, the gateway injects `Authorization: Bearer <apikey value>` before proxying, so PostgREST always authorizes from exactly one verified token.** *(Rationale: one code path in the engine ("verify Authorization, map role") eliminates the anon-fallback ambiguity class of bugs; the gateway is the right place because it has already verified the apikey signature at that point.)*

## Open Questions

- **OQ-104** — Rotation overlap window: 30-day default assumed above. Should retirement of the old kid be automatic at window end, or gated on the developer confirming (with per-kid last-seen showing zero old-key traffic)? Automatic is safer against forgotten rotations left half-done; gated avoids breaking a customer's forgotten cron job. Decide with early-customer feedback; the dashboard telemetry exists either way.
- **OQ-105** — Per-plan role settings: the `statement_timeout` values above are flat. Do paid tiers get raised/configurable per-role timeouts (and `work_mem`-class settings), and where does that config live — `ALTER ROLE ... SET` re-rendered by the provisioner on plan change, or a settings table read by the dashboard? Interacts with [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) resource limits.

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-013, D-014, D-015, D-029, D-035, D-036), [../02-control-plane/01-data-model.md](../02-control-plane/01-data-model.md) (D-060), [01-rest-api-design.md](01-rest-api-design.md) (D-100, D-101), [02-request-pipeline.md](02-request-pipeline.md) (D-104), [../05-auth/02-sessions-and-tokens.md](../05-auth/02-sessions-and-tokens.md)
- Feeds: [../06-security/01-threat-model.md](../06-security/01-threat-model.md), [../06-security/02-rls-design.md](../06-security/02-rls-design.md), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md), [../02-control-plane/05-audit-and-admin-access.md](../02-control-plane/05-audit-and-admin-access.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md), [../09-dashboard/01-dashboard-ia.md](../09-dashboard/01-dashboard-ia.md)
