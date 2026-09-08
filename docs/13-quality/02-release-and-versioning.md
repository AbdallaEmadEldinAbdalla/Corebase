# Release & Versioning

## Purpose

What Steadhold promises not to break, surface by surface, and the protocol for the times it must. A BaaS has an unusual number of public surfaces — two APIs, an SDK, a CLI, a Postgres version, and (easy to forget) the SQL helper functions customers embed in their own RLS policies. Each gets an explicit versioning policy here, because "we version the API" (proposal §60, D-039) is only one row of the table. This doc also fixes the release cadence, the changelog discipline, and the feature-flag mechanism for risky platform changes.

## Design

### Versioning policy per surface

| Surface | Scheme | Breaking changes | Detail |
|---|---|---|---|
| Platform API `/v1` | URL-versioned (D-039) | Only via `/v2`; deprecation protocol D-153 | below |
| Data API `/rest/v1` | Pinned to embedded PostgREST behavior (D-011) | PostgREST major bumps = customer-visible; fleet-staged with per-project pin (D-154) | below |
| SDK `@steadhold/core` | semver | Majors only; min-supported-API handshake | below |
| CLI `steadhold` | semver | Majors only; warns when outdated | below |
| Postgres | One major fleet-wide, PG 17 at launch (D-037) | Fleet upgrade per playbook | [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) |
| Auth schema + helper functions (`auth.uid()` …) | Treated as public API | Same protocol as `/v1` (D-153) | below — the one everyone forgets |
| Internal services | None | Anytime; deployed atomically | below |

### Platform API `/v1` (D-039)

**Additive changes are allowed within `/v1` without notice**: new endpoints, new optional request fields, new response fields, new enum values *in fields documented as open enums*, new optional query parameters. Clients must be written to ignore unknown response fields (stated in the API docs and enforced in the SDK).

**What counts as breaking** (any of these requires `/v2`, or the deprecation protocol if `/v1` must shed it):

| Change | Breaking? | Notes |
|---|---|---|
| Add endpoint / optional field / response field | No | Additive |
| Add value to a documented-open enum | No | e.g. new project `status` values are documented as expected |
| Remove or rename a field or endpoint | **Yes** | |
| Change a field's type or format | **Yes** | Including widening `string` → `string\|null` |
| Change a field's semantics (same shape, new meaning) | **Yes** | The sneakiest class — reviewers look for it explicitly |
| Tighten validation on existing inputs | **Yes** | A request that used to succeed now 4xx's — breaking even though the schema didn't change |
| Change an error `code` for an existing failure mode | **Yes** | Error codes in the D-032 envelope are contract; clients branch on them |
| Change HTTP status for an existing failure mode | **Yes** | Same reason |
| Change default page size / sort order | **Yes** | Observable behavior clients bake in |
| Fix a response that violated the documented contract | No (with changelog entry) | Documented behavior wins over accidental behavior; announced, not silent |

**Deprecation protocol (D-153)** — how anything leaves `/v1`:

1. Mark deprecated in the OpenAPI spec and docs; responses gain `Deprecation: true` and `Sunset: <RFC 8594 date>` headers on the affected endpoint/field usage.
2. Changelog entry on the day of deprecation, naming the replacement.
3. **Minimum 6-month window** between deprecation and removal — longer if usage says so.
4. **Usage monitoring before removal**: per-endpoint/per-field call metrics by API key; removal requires usage below an agreed floor (and direct outreach to the remaining callers — they are countable and, pre-PMF, few).
5. Removal ships in its own release, changelog-flagged, never bundled silently into a feature release.

### Data API `/rest/v1` (D-011 implication)

The filter/embed/RPC surface is **largely pinned to the embedded PostgREST's behavior** — that was the point of D-011 (inherit a decade of edge cases, offer a Supabase-compatible mental model). The honest consequence: **a PostgREST major upgrade is a customer-visible change to `/rest/v1`**, even though Steadhold wrote none of the changed code. Steadhold therefore cannot silently roll PostgREST majors across the fleet.

**Mechanism (D-154): PostgREST version bumps are fleet-staged with a project-level pin during the transition.** Concretely:

- `project_databases` carries a `postgrest_image_tag` column ([data model](../02-control-plane/01-data-model.md)); the provisioner and reconciler materialize exactly that image for the project's PostgREST container. The fleet default lives in platform config.
- Steady state: every project runs the fleet default tag. One PostgREST version fleet-wide is the same ops-tax logic as D-037 — per-project pinning is a *transition* mechanism, not a menu.
- On a PostgREST major bump: new projects get the new tag immediately; existing projects keep the old tag (pinned); the changelog + dashboard announce the migration window with the upstream breaking-change list; projects are rolled in batches (canaries first), with a customer-visible "defer until <window end>" control for projects that need time.
- At window end (same 6-month ceiling as D-153), remaining pins are rolled forward on a announced date. Pins do not outlive the window — a permanently heterogeneous PostgREST fleet would recreate the problem D-037 exists to prevent.
- PostgREST **minor/patch** upgrades that upstream documents as non-breaking roll fleet-wide without pinning, changelog-noted.
- Steadhold-added surface at the gateway (key validation, rate-limit headers, error envelope) follows the `/v1` table above, not PostgREST's cycle.

### SDK (`@steadhold/core`)

**semver, breaking only in majors.** Additive in minors, fixes in patches. The SDK sends `X-Steadhold-Client: core-js/<version>` on every request; the platform API answers with a warning header when the client version is below the **minimum-supported-API line**, and the SDK surfaces it once per process (console warning, never a hard fail mid-flight). Hard minimum enforcement (426-style rejection) is reserved for security-critical cases only. Each SDK major documents which platform API versions it speaks; the previous major receives security fixes for 12 months after the next major ships.

### CLI (`steadhold`)

**semver**, distributed via npm (D-026). Same client-header handshake as the SDK. The CLI additionally **checks for newer versions** (against the npm registry, at most once per 24h, cached, disable-able via config/env for CI) and prints a one-line warning when outdated. Commands whose *file formats* are contracts — migration filenames, `steadhold export` tarball layout (D-004), `steadhold.json` — version those formats explicitly: a format change is a CLI major.

### Postgres

**Fleet single-version, PostgreSQL 17 at launch (D-037).** Not per-project selectable. Major upgrades are an operational program, not a release: the standing upgrade playbook is owned by [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) (announcement, per-project restore-based upgrade to a new instance, verification, window). Extension version bumps ride the same playbook. From the customer's view a Postgres major is a breaking change and gets the full D-153 protocol treatment (announcement, window, changelog).

### The auth schema and helper functions — the one everyone forgets

Customers write RLS policies like `using (user_id = auth.uid())`. That makes `auth.uid()`, `auth.role()`, `auth.jwt()`, the `auth.users` columns customers are told to foreign-key against, and the JWT claim names those helpers read **public API embedded in customer databases** — in *their* schemas, *their* migrations, *their* exported dumps. Changing a helper's signature, return type, or claim source silently breaks every policy that calls it, which means silently breaking customers' *security*, the worst possible failure class under D-002.

Policy: these objects are versioned under the **same regime as `/v1`** (D-153 protocol). Additive is fine (new helper functions, new nullable columns on `auth.users`). Anything else — renaming a helper, changing `auth.uid()`'s type, renaming a JWT claim a helper reads, dropping or retyping a documented `auth.users` column — is a breaking change with the full deprecation window, during which old and new helpers coexist (e.g. a new function name, the old one kept as a delegating alias until sunset). The docs mark exactly which `auth.*` objects are public; everything unmarked is internal and prefixed `auth._` to make the boundary mechanical. ([auth architecture](../05-auth/01-auth-architecture.md), [RLS design](../06-security/02-rls-design.md).)

### Internal services

Everything behind the public surfaces — monolith module boundaries, worker job payload shapes, gateway↔PostgREST config conventions, control-plane schema — carries **no compatibility guarantees**. The modular monolith plus the single separate worker (D-010, D-020) deploy **atomically from one release artifact**; the only skew window is worker-vs-API during a rolling deploy, so job payloads follow one rule: *state is re-read inside the job, never trusted from the payload* (already required by the [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md)), which makes payload-shape skew harmless. Internal shape changes never appear in the public changelog.

**What the headers look like** (so the contract is concrete — RFC 9745 `Deprecation`, RFC 8594 `Sunset`):

```
HTTP/1.1 200 OK
Deprecation: @1767225600
Sunset: Sat, 04 Jul 2026 00:00:00 GMT
Link: <https://steadhold.app/changelog/2026-01-deprecate-legacy-keys>; rel="deprecation"
X-Request-ID: req_01hv…
```

Gateway metrics count every response that carried a `Deprecation` header, tagged by endpoint and API key — that counter *is* the D-153 usage monitor; no separate telemetry system is built for it.

### Release artifacts and platform version numbers

Customers see per-surface versions (the table above); internally there is exactly **one deployable platform artifact per release** — the monolith + worker image set, tagged `platform/vYYYY.MM.DD-<sha>` (calendar-ish because the platform itself is not semver: it has no importable API, so semver would be theater). The tag is what staging promotes to prod, what the changelog anchors to, what `X-Steadhold-Platform` returns on `/health`, and what a rollback rolls back to. Rollbacks follow the same gate as forward deploys (golden path + isolation green on the rolled-back artifact) — an old artifact is not presumed safe just because it once shipped; the fleet state around it has changed.

### Release cadence & changelog discipline

- **Cadence**: continuous deploy to staging on merge; promotion to prod gated on the golden path + isolation suite ([testing strategy](01-testing-strategy.md)). No fixed release train in V1 — trains exist to batch coordination costs the team doesn't have yet. Deploys freeze during D-085 isolation failures, full stop.
- **Public changelog from day one** — it is marketing *and* a contract: the deprecation protocol (D-153) is only as credible as the changelog it publishes to. Mechanism: **conventional commits** (enforced by CI lint) → generated draft grouped by surface (`platform-api`, `data-api`, `sdk`, `cli`, `dashboard`) → **human-edited before publish** — the generator guarantees completeness, the human makes it readable and strips internal noise. Entries touching a public surface are mandatory; a PR that changes a public contract without a changelog-visible commit fails CI.
- Every deprecation, sunset, PostgREST window, and Postgres upgrade announcement is a changelog entry with a date — the changelog is the single public timeline.

### Feature flags for risky platform changes

**Simple env/config flags, no flag service in V1.** A typed `flags` module in the monolith reads from environment/config at boot; flags are declared in one file with owner + expiry date; CI warns on expired flags. Scope: platform-side rollout control (new provisioning path, new pooler config, gateway behavior changes) — flip in staging, then prod, then delete the flag. Explicitly out of scope for V1: per-project/percentage targeting and runtime toggling (restart-to-flip is acceptable at V1 scale), and customer-facing feature entitlement (that is the plans/quotas system, [pricing & plans](../12-business/02-pricing-and-plans.md)). A flag is a rollout tool, not a permanent branch: expiry is mandatory.

### Who may break what — summary

| Surface | Who may approve a breaking change | Minimum notice | Vehicle |
|---|---|---|---|
| Platform API `/v1` | API owner + one reviewer | 6 months (D-153) | Deprecation+Sunset headers, changelog, usage floor |
| Data API `/rest/v1` (PostgREST-inherited) | Platform team, on PostgREST major | 6-month pin window (D-154) | Per-project image pin, staged fleet roll |
| Data API (Steadhold gateway surface) | API owner + one reviewer | 6 months | Same as `/v1` |
| SDK | SDK owner | Next major, migration guide | semver major |
| CLI (incl. export/migration formats) | CLI owner | Next major, migration guide | semver major |
| Postgres major | Eng lead, scheduled program | Announced window per playbook | [Upgrade playbook](../03-database-platform/06-extensions-and-upgrades.md) |
| `auth.*` public helpers/schema | API owner + security owner | 6 months, coexisting old+new | D-153 protocol in-database |
| Internal services | Any engineer via review | None | Atomic deploy |

## Decisions

- **D-153 — Nothing is removed or broken within `/v1` (or any surface bound to its regime) except via the deprecation protocol: `Deprecation` + `Sunset` headers, a dated changelog entry naming the replacement, a minimum 6-month window, and usage monitoring below an agreed floor (plus outreach) before removal, which ships as its own flagged release.** *(Rationale: §60/D-039 said "no breaking changes without versioning" but left the exit path undefined; an explicit protocol converts "we promise" into a checkable procedure and keeps the changelog honest.)*
- **D-154 — PostgREST major upgrades are treated as customer-visible `/rest/v1` changes and rolled via fleet staging with a per-project pin: `project_databases.postgrest_image_tag` selects the project's PostgREST image during a bounded (≤6 months) transition window, after which remaining pins roll forward on an announced date; minors/patches roll fleet-wide unpinned.** *(Rationale: D-011 outsources the query surface, so upstream majors change Steadhold's contract whether we like it or not; per-project pinning during a bounded window gives customers migration time without recreating the permanent fleet heterogeneity D-037 forbids.)*

## Open Questions

- **OQ-153 — SDK/CLI support horizon:** is 12 months of security fixes for the previous major right, and does the CLI need a longer horizon because it's embedded in customers' CI? Decide before the first public SDK major.
- **OQ-154 — Usage floor for removals:** what counts as "low enough to remove" in D-153 step 4 (absolute calls/day? distinct keys? zero for N weeks?), and who signs off. Decide before the first deprecation is filed.
- **OQ-155 — Forced-unpin ergonomics (D-154):** what happens operationally to a project whose owner never acts within the PostgREST window — auto-roll with email notice only, or require dashboard acknowledgment for projects above a traffic threshold? Needs [dashboard IA](../09-dashboard/01-dashboard-ia.md) input before the first PostgREST major arrives.
- **OQ-156 — Changelog surface for `Sunset` visibility:** should the dashboard actively surface "your project called a deprecated endpoint this week" (per-key deprecation telemetry) in V1, or is the header + changelog enough until the first real deprecation? Cheap to add to the gateway metrics path; decide with [observability](../11-infrastructure/03-observability.md).

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-004, D-010, D-011, D-020, D-026, D-032, D-037, D-039), [../02-control-plane/02-platform-api.md](../02-control-plane/02-platform-api.md), [../04-data-api/01-rest-api-design.md](../04-data-api/01-rest-api-design.md), [../03-database-platform/06-extensions-and-upgrades.md](../03-database-platform/06-extensions-and-upgrades.md), [../05-auth/01-auth-architecture.md](../05-auth/01-auth-architecture.md)
- Feeds: [01-testing-strategy.md](01-testing-strategy.md) (release gates), [../10-cli-and-sdk/01-cli-spec.md](../10-cli-and-sdk/01-cli-spec.md), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md), [../02-control-plane/01-data-model.md](../02-control-plane/01-data-model.md) (`postgrest_image_tag`), [../11-infrastructure/02-iac-and-cicd.md](../11-infrastructure/02-iac-and-cicd.md), [../14-roadmap/03-post-v1-roadmap.md](../14-roadmap/03-post-v1-roadmap.md)
