# Tenant Isolation Tests

## Purpose

The proposal's §74 — "create projects A and B, prove A cannot touch B, run it continuously" — is Steadhold's single most important test, because tenant isolation is risk #1 (§115). This doc turns that one paragraph into an executable spec: the harness that provisions the fixtures, the full matrix of attacks with exact expected results across the API, database, storage, and network boundaries from the [threat model](01-threat-model.md), the RLS regression canaries, the run cadence, and the **hard rule that a failure here freezes all releases** (D-085). This suite is the continuous, automated proof behind every isolation claim in the corpus.

## Design

### Harness architecture

Two project fixtures, **A** and **B**, each fully provisioned (container, pooler, PostgREST, keys, JWKS, an auth user, a seeded schema with known RLS policies). Two placement strategies, and the suite uses **both**:

| | Ephemeral A/B per run (staging) | Persistent canaries (prod) |
|---|---|---|
| Where | Staging node, on-demand | Real production fleet |
| Lifecycle | Provisioned at suite start, destroyed at end | Long-lived project pair `canary-a` / `canary-b`, seeded once |
| Proves | The *current build's* provisioning + policy code is isolation-safe before it ships | The *live platform* is still isolated right now, including config/network drift |
| Cost | A full provision+destroy cycle per run (also exercises the provisioning path — a bonus) | Two idle projects + hourly traffic |
| Weakness | Doesn't catch prod-only network/firewall drift | Can't be destructive; can't test provisioning itself |

**Decision (D-084): run both.** Ephemeral A/B on every deploy and hourly in staging (destructive tests allowed — extension installs, COPY TO PROGRAM, resource bombs); persistent canaries daily against prod (non-destructive subset only). Neither alone is sufficient: ephemeral proves the code, canaries prove the running system. Critically, **A and B must land on the same physical node** whenever possible (co-tenancy is the interesting case) — the harness pins placement to force adjacency; a variant also runs them cross-node to confirm both paths.

Harness is a standalone test package (`tests/isolation/`, [testing strategy](../13-quality/01-testing-strategy.md)) that talks to fixtures only through the same public surfaces a real attacker has: HTTPS endpoints, the pooler port, the S3/storage API, and (for the SQL/network cases) a psql/loopback session opened with the fixture's own advertised DATABASE_URL. It holds **no privileged backdoor** — if it needs superuser to set something up, that runs in the seed phase, never in the assertion phase.

### The attack matrix

Legend for expected result: the test asserts the *exact* status/outcome, not merely "denied" — a 500 where we expect 401 is a failure (it means we broke differently than designed).

#### API-path isolation (threat model boundary b)

| # | Attack | Expected result | Asserts |
|---|---|---|---|
| API-1 | A's `anon` key → `GET https://<B>.steadhold.app/rest/v1/<table>` | **401** (invalid key for project B) or **empty per default-deny** if B's table is anon-readable-nothing; assert no B rows ever returned | Project resolution binds to B's key set; A's anon key isn't valid at B |
| API-2 | A's `service_role` key → B's REST endpoint | **401** — signature verifies against B's JWKS and fails (A's key signed by A's keypair, D-014) | Per-project keypairs kill cross-tenant service_role replay |
| API-3 | A's valid `authenticated` JWT → B's REST endpoint | **401** — same JWKS mismatch | The whole JWT class is project-bound |
| API-4 | A's JWT with the `project_ref`/`aud` claim rewritten to B, re-signed with A's key | **401** — still fails B's signature check | Tampering the claim doesn't help without B's private key |
| API-5 | A's JWT with `project_ref` claim = B but sent to A's endpoint | **403** (claim/route mismatch) — the resolved project is A (from Host), the claim says B, reject | Project identity comes from the routed Host, and a mismatched claim is refused, not trusted ([request pipeline](../04-data-api/02-request-pipeline.md)) |
| API-6 | `alg=none` JWT (unsigned) to A's endpoint | **401** — verifier pins ES256, rejects `none` | Algorithm pin |
| API-7 | HS256-downgrade: JWT signed with HMAC using A's **public** key as the secret | **401** — verifier pins ES256, never treats the key as an HMAC secret | The classic asymmetric→symmetric confusion is blocked |
| API-8 | Expired JWT (`exp` in the past) to A's endpoint | **401** | Expiry enforced |
| API-9 | JWT with a `kid` not in A's JWKS | **401** — no verifier resolves | `kid` must resolve within the project |
| API-10 | Client-supplied `X-Project-Ref: A` header while hitting B's Host | **B's context ignored the header** — request resolves to B, header stripped at edge | Client headers can't override routing (proposal §20) |

#### Database-path isolation (boundaries b, c)

| # | Attack | Expected result | Asserts |
|---|---|---|---|
| DB-1 | A's DATABASE_URL credentials → connect to **B's pooler port** | **auth failure** — B's PgBouncer has no entry for A's role | Per-project pooler credentials (D-015) |
| DB-2 | A's DATABASE_URL → B's pooler host:port even reachable? | **connection refused/timeout** at the network layer (B's pooler only accepts its allowed peers) | Network policy backs up credential separation (D-081) |
| DB-3 | Inside A (authenticated role), `select * from auth.users` | **denied / only safe columns via guarded view**, and never B's users | Internal schemas policy-guarded even within a project ([RLS design](02-rls-design.md)) |
| DB-4 | Inside A (owner role), `create extension <non-allowlisted>` | **permission denied / extension not available** | Extension allowlist + non-superuser owner (D-080, [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md)) |
| DB-5 | Inside A, `copy (select 1) to program 'id > /tmp/pwn'` | **permission denied** (`pg_execute_server_program` not granted) | D-080 |
| DB-6 | Inside A, `select lo_import('/etc/passwd')` (server-side) | **permission denied** | D-080 server-file roles ungranted |
| DB-7 | Inside A, `create extension dblink; select dblink('host=<B-pooler> ...', ...)` | extension create denied if off allowlist; if allowlisted, the **connection fails at the network policy** (can't reach B) | Defense in depth: allowlist *and* egress deny (D-081) |
| DB-8 | Inside A, resource bomb (`select count(*) from generate_series(1,1e11)`) | Query killed by `statement_timeout`; **co-tenant B's latency stays within SLO** (measured during the bomb) | cgroup + timeout limits contain noisy neighbors (D-009) |

#### Storage-path isolation

| # | Attack | Expected result | Asserts |
|---|---|---|---|
| ST-1 | A's token → `GET/PUT` on B's bucket/object via the storage API | **401/403** | Storage authz is project-scoped ([storage API & policies](../07-storage/02-storage-api-and-policies.md)) |
| ST-2 | A holds a valid signed URL for A's object; swap the object key in the path to B's key | **403 / signature mismatch** — the signature covers the path | Signed URLs aren't transferable across objects |
| ST-3 | Replay A's signed URL after its `expires` | **403 expired** | Signed-URL TTL enforced |
| ST-4 | A's `authenticated` user → B's object where B's RLS on `storage.objects` would deny | **empty/403**, never B's bytes | RLS on storage metadata (D-017) |

#### Network / node isolation (boundaries c, d)

| # | Attack | Expected result | Asserts |
|---|---|---|---|
| NET-1 | From A's postgres container, reach the cloud **metadata endpoint** (169.254.169.254) | **timeout/blocked** | Egress deny-list includes link-local metadata (D-081) |
| NET-2 | From A's container, open a TCP connection to **B's container** IP:5432 | **blocked** | Per-container network policy |
| NET-3 | From A's container, reach the **Docker socket / node agent** port | **blocked / not mounted** | Socket never exposed to tenant containers |
| NET-4 | From A's container, arbitrary internet egress (e.g. connect to a mining pool / paste site) | **blocked** except named allowlist (WAL endpoint, DNS) | Exfiltration/mining egress control (D-081) |

### RLS regression canaries

A dedicated seeded table in each fixture with **known policies and known rows**, asserting exact visibility per role — this catches a policy silently breaking (a migration that drops FORCE, a helper function returning null, a botched `service_role` grant):

```sql
-- seed (fixture setup)
create table public.canary (id int primary key, owner uuid, secret text, published bool);
alter table public.canary enable row level security;
alter table public.canary force  row level security;
insert into public.canary values
  (1, '<user-A-uid>', 'A-private', false),
  (2, '<user-A-uid>', 'A-public',  true),
  (3, '<other-uid>',  'other',     true);
create policy p_read_published on public.canary for select to anon, authenticated using (published);
create policy p_read_own       on public.canary for select to authenticated using (owner = (select auth.uid()));
```

| Role / identity | Expected visible ids | Rationale |
|---|---|---|
| `anon` | {2, 3} | published only |
| `authenticated` as user-A | {1, 2, 3} | own (1) + published (2,3) |
| `authenticated` as other-user | {2, 3} | published only; **must NOT see id 1** |
| `service_role` | {1, 2, 3} | BYPASSRLS (D-082) |
| bare owner connection | {} via API role path | FORCE keeps owner honest through the API roles |

Any deviation (e.g. `anon` seeing id 1) is a hard failure — it means default-deny or a policy regressed. A parallel canary asserts **write** paths: `anon` INSERT rejected, `authenticated` INSERT of a row owned by someone else rejected by `WITH CHECK`, own-row UPDATE allowed.

### Cadence, alerting, and the release gate

| When | Which suite | Scope | On failure |
|---|---|---|---|
| Every deploy (CI, pre-promote) | Ephemeral A/B on staging | Full matrix incl. destructive | **Block the deploy.** Red = the artifact never reaches prod (D-085) |
| Hourly | Ephemeral A/B on staging | Full matrix | Page on-call; **auto-freeze deploys** until green |
| Daily | Persistent prod canaries | Non-destructive subset (API-*, ST-1..3, NET-1..4, RLS canaries) | Page on-call at Sev-1 (potential live cross-tenant exposure); incident opened |

Rules:

- **A failure pages.** Isolation failures are Sev-1 by default; a cross-tenant *data* read (any test returning another project's rows/bytes) is the highest severity and triggers the incident-response path in [platform security](04-platform-security.md).
- **A red isolation suite freezes all releases** (D-085) — not just the change that broke it. The reasoning: we cannot reason about which change is safe to ship while isolation is provably broken. Freeze lifts only when the suite is green again.
- **New isolation-relevant surface must arrive with a test.** Adding an extension to the allowlist, a new internal schema, a storage feature, or a network path requires a corresponding matrix row in the same PR (enforced in review, [testing strategy](../13-quality/01-testing-strategy.md)).
- **No fixture backdoors in assertions.** If a test needs privilege to *observe* a result, that's a design smell — rewrite it to observe through the attacker's surface (e.g. confirm NET-2 by the connection timing out, not by reading a host-side firewall log).
- Flakiness policy: an isolation test may **never** be marked flaky-skip. A nondeterministic isolation test is itself a Sev-2 bug (either the test or the boundary is racy); fix or remove, never mute.

## Decisions

- **D-084 — The isolation suite runs against both ephemeral per-run A/B fixtures (staging, destructive tests allowed) and persistent canary projects (prod, non-destructive), pinned to co-locate A and B on one node where possible.** *(Rationale: ephemeral fixtures prove the build's code is isolation-safe and exercise provisioning; persistent canaries prove the live system hasn't drifted; co-location tests the only interesting adjacency; each catches what the other cannot.)*
- **D-085 — Any tenant-isolation test failure freezes all releases fleet-wide until the suite is green, and pages on-call at Sev-1 (cross-tenant data reads at the top severity).** *(Rationale: isolation is risk #1 and priority #1 (D-002); while it's provably broken we cannot reason about which change is safe to ship, so nothing ships.)*

## Open Questions

- **OQ-084 — Prod canary blast-radius guard:** running the full (destructive) matrix against prod would prove the most, but destructive SQL and resource bombs on the live fleet are themselves a stability risk. Current split runs destructive tests on staging only — is a quarantined destructive canary *pool* in prod worth the operational risk? Decide once the fleet has spare-node headroom.
- **OQ-085 — Cross-node vs same-node coverage weighting:** how many node topologies to exercise per run (same-node, cross-node, cross-AZ later) before the run time hurts deploy velocity. Revisit when multi-node staging exists.

## Dependencies

- Builds on: [threat model](01-threat-model.md) (the boundaries under test), [RLS design](02-rls-design.md) (the canary policies), [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md), [request pipeline](../04-data-api/02-request-pipeline.md), [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) (fixture provisioning), [testing strategy](../13-quality/01-testing-strategy.md)
- Feeds: [platform security](04-platform-security.md) (incident response), [iac & cicd](../11-infrastructure/02-iac-and-cicd.md) (the release gate), [risk register](../15-risks/01-risk-register.md)
