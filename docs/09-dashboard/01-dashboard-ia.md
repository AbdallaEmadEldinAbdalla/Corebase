# Dashboard Information Architecture

## Purpose

The complete information architecture of `app.steadhold.dev`: route map, navigation model, stack and data layer, the project overview page, the paused-project experience, and the V1 page cut-list. The dashboard is a pure client of the [platform API](../02-control-plane/02-platform-api.md) — it holds no state of its own and calls no customer database directly (every DB-touching feature goes through the platform API's audited admin path, defined in [table editor](02-table-editor.md), D-132). Proposal §39–40 adopted; §90's principles made concrete.

## Design

### Stack (D-025, extended)

- **Framework:** Next.js (App Router). Server components render page shells and static chrome; anything data-driven is a client component. No API routes in the dashboard — the platform API at `api.steadhold.dev/v1` is the only backend (no BFF layer, see D-130).
- **UI:** Tailwind + shadcn/ui. shadcn components are vendored (copied in), so there is no design-system dependency to chase.
- **State/data layer:** **TanStack Query** against the platform API. Query keys mirror API resources (`['org', slug]`, `['project', ref]`, `['project', ref, 'tables']`); mutations invalidate the affected keys; `staleTime` defaults to 30 s with refetch-on-focus. No Redux/global store — the server cache *is* the app state; the only client-only state is UI ephemera (open panels, unsaved editor buffers), kept in component state or `localStorage`.
- **Auth:** control-plane **session cookies** (httpOnly, CSRF double-submit) exactly as specified in the [platform API](../02-control-plane/02-platform-api.md) (D-062). The dashboard never sees a token; `fetch` sends credentials, a 401 redirects to `/login?next=…`. Dashboard login is a platform account — entirely distinct from customer-app auth ([auth architecture](../05-auth/01-auth-architecture.md)).

### Route map

```
app.steadhold.dev
├─ /                                → redirect: last-visited org, else /login
├─ /login  /signup  /verify-email  /forgot-password  /reset-password
├─ /accept-invite/[token]           → org invitation acceptance
├─ /account                         → profile, password, PATs, active sessions
│
├─ /org/[slug]                      ← org switcher (top-left dropdown) swaps [slug]
│   ├─ /                            → projects grid (cards: name, ref, region, status badge)
│   ├─ /new                         → create project (name → region(eu-central, D-024) → plan → creating…)
│   ├─ /members                     → list, invite, roles (owner/admin/member)
│   ├─ /billing                     → plan, payment method, invoices, usage summary
│   ├─ /settings                    → org name/slug, danger zone (delete org)
│   └─ /audit                       → audit_logs viewer, filterable by actor/action/project
│
└─ /project/[ref]                   ← ref = immutable project ref (e.g. kxqwrtplmzensfba)
    ├─ /                            → OVERVIEW (spec below)
    ├─ /table-editor
    │   └─ /[schema]/[table]        → grid + structure + RLS panel (02-table-editor.md)
    ├─ /sql
    │   └─ /[queryId]               → SQL editor; deep-link to a saved query (03-sql-editor.md)
    ├─ /database                    → connection info (direct + pooler URLs, D-015)
    │   ├─ /roles                   → anon/authenticated/service_role + customer roles, read-only V1
    │   ├─ /extensions              → curated allowlist, enable/disable (../03-database-platform/06-extensions-and-upgrades.md)
    │   └─ /pooling                 → PgBouncer mode/limits info (read-only V1)
    ├─ /auth
    │   ├─ /users                   → customer end-users: search, view, disable, delete
    │   ├─ /providers               → email/password V1; OAuth providers listed as "coming" (greyed)
    │   ├─ /templates               → verification/reset email templates
    │   └─ /settings                → JWT expiry, redirect URLs, signups on/off
    ├─ /storage
    │   └─ /[bucket]                → buckets list → object browser (upload/download/delete/signed URL)
    ├─ /api
    │   ├─ /keys                    → anon + service_role keys (D-029): reveal, copy, rotate
    │   └─ /docs                    → auto-generated per-project snippets: curl / JS SDK / Python,
    │                                 each with URL + anon key pre-filled and a copy button
    ├─ /logs                        → tail + filter (service, level, time range) — no analytics V1
    ├─ /metrics                     → basics only: CPU, RAM, disk, connections, request rate
    ├─ /backups                     → backup list, PITR restore-to-new flow (D-019)
    └─ /settings                    → project name, pause/resume, danger zone (delete → 7-day recovery, D-038)
```

Navigation: left sidebar within a project (Overview → Settings top-to-bottom in the order above); org-level pages use a slim top nav. The org switcher and a project switcher (within the org) live in the header. Breadcrumb: `org / project / section`.

### Project overview page (`/project/[ref]`)

Three zones, top to bottom:

1. **Health row** — one card per service: **Database, API (PostgREST), Auth, Storage** (no Realtime card in V1, D-030). Each card: green/amber/red status from the control plane's health checks, plus one headline number (DB: size on disk; API: requests last hour; Auth: total users; Storage: bytes stored). Red states link straight to `/logs` pre-filtered to that service.
2. **Sparkline row** — three 24 h sparklines: **API requests**, **DB size**, **storage size**. Click-through to `/metrics`. Data source is OQ-149.
3. **Onboarding checklist** (new projects only) — drives the first-five-minutes flow (proposal §80). Three steps, each auto-detected and each landing the user one click from done:
   1. **Create your first table** → opens table editor's create-table dialog. Completed when a table exists in `public`.
   2. **Get your keys** → opens `/api/keys`. Completed when the anon key is revealed/copied.
   3. **Make your first request** → shows a copyable snippet (curl and JS tabs) with the project URL and anon key already inlined — paste-and-run, zero editing. Completed when the first data-plane request is logged.

   The checklist collapses to a dismissible banner once all three complete; target wall-clock for signup → first successful request is **under 5 minutes** and the checklist is instrumented to measure exactly that.

### The paused-project experience (D-008 meets UX)

A free project idle for 7 days is paused ([cost model](../12-business/01-cost-model.md)); the dashboard must make this feel like a doorbell, not an outage:

- **Projects grid:** paused projects show a grey "Paused" badge and an inline **Resume** button on the card (resume without opening).
- **Auto-resume on open (D-131):** navigating to *any* `/project/[ref]/*` page of a paused project immediately fires `POST /v1/projects/:ref/resume` (idempotent — the [provisioning state machine](../02-control-plane/03-provisioning-state-machine.md) already treats dashboard intent as a resume trigger). No confirmation dialog: opening the project *is* the intent.
- **While RESUMING:** a full-width banner — "This project was paused after 7 days of inactivity. Resuming… (usually a few seconds)" — with a live status (poll `GET /v1/projects/:ref`, or SSE per OQ-043). Pages render their static shells with skeleton loaders in every data panel; nothing shows an error state during resume.
- **On READY:** banner flips to a brief "Resumed" toast; in-flight queries retry automatically (TanStack Query retry-on-resume).
- **On failure:** the banner becomes an error card with `request_id` + copy button and a Retry button — never a dead end.
- Paid projects never pause ([pricing & plans](../12-business/02-pricing-and-plans.md)), so the banner also carries a quiet "Upgrade to keep this project always-on" link — the one place monetization appears in a flow.

### Design principles (§90), each with one enforced practice

| Principle | Concrete practice |
|---|---|
| **Speed** | Sidebar links prefetch their route + primary query on hover; navigations between project pages must not blank the shell (cached queries render instantly, revalidate in background). Budget: route transition renders meaningful content < 200 ms from cache. |
| **Clarity** | Section names in the sidebar are exactly the words used by the CLI and docs (`db push` talks about the same "migrations" the dashboard shows). One page = one question answered; no dashboard page mixes org-level and project-level concerns. |
| **Good defaults** | Every creation flow works with zero fields changed: new table gets `id`/`created_at` and RLS enabled+forced (D-083); new bucket is private; new project lands in eu-central on Free. |
| **Excellent errors** | Every error surface — toast, banner, inline — shows the platform error `code`, human message, and `request_id` with a copy button (D-032), and where actionable, the fix as a link (e.g. `RLS_NO_POLICY` → "Add a policy" → RLS panel). No raw stack traces, ever. |

### V1 page cut-list (explicitly NOT in dashboard V1)

| Cut | Reason | Returns |
|---|---|---|
| Realtime section (nav item, inspector, channel browser) | Realtime is post-V1 (D-030) — no greyed-out teaser nav beyond the providers-style hint | with realtime |
| Metrics beyond basics (custom charts, query builder, per-endpoint breakdowns, retention > 7 days) | Basics answer "is it healthy / is it growing"; the rest is Grafana's job internally ([observability](../11-infrastructure/03-observability.md)) | V2 |
| RLS policy **wizard** (form-builder that hides SQL) | Templates-that-expand-to-SQL only (D-133); a wizard that generates invisible policies violates the every-op-is-SQL rule | maybe never |
| ERD / relationship diagram view | High polish, low necessity | V1.1 |
| Log analytics (saved searches, alerting, aggregation) | Tail + filter covers debugging; analytics is a product of its own | V2 |
| Visual EXPLAIN plan tree | Text plan ships V1 ([SQL editor](03-sql-editor.md)) | V1.1 |
| Org-level usage analytics page | Billing summary suffices until metering matures | V1.1+ |
| In-dashboard database role management (create/grant) | Read-only roles page V1; role surgery via SQL editor | V1.1 |

## Decisions

- **D-130 — The dashboard is a pure frontend: Next.js App Router + Tailwind + shadcn/ui (per D-025) with TanStack Query as the sole data layer, calling only the platform API over session-cookie auth (D-062); no BFF, no dashboard-owned backend, no direct customer-DB connection from dashboard code.** *(Rationale: one API contract serves dashboard and CLI identically, so every dashboard capability is scriptable by definition; a BFF would be a second control-plane API to secure, version, and audit for zero V1 benefit.)*
- **D-131 — Paused projects auto-resume on open: navigating to any page of a paused project fires the idempotent resume call immediately, with a progress banner and skeleton loaders instead of error states; the projects grid additionally offers an explicit per-card Resume button.** *(Rationale: D-008 makes pausing an economic necessity; the UX job is to make it cost the user one page-load wait, not a decision — asking "do you want to resume?" is a question with only one answer.)*

## Open Questions

- **OQ-149 — Overview sparkline/metrics data path:** does the dashboard query a control-plane rollup table (simple, coarse) or a scoped Prometheus proxy endpoint on the platform API (fresh, more moving parts)? Owned jointly with [observability](../11-infrastructure/03-observability.md); decide before the overview page is built.
- (Existing, not new:) OQ-043 — polling vs SSE for creation/resume progress — is the transport for both the create flow and the resume banner here.

## Dependencies

- Builds on: [../02-control-plane/02-platform-api.md](../02-control-plane/02-platform-api.md) (sessions D-062, error envelope D-032, resume endpoint), [../02-control-plane/03-provisioning-state-machine.md](../02-control-plane/03-provisioning-state-machine.md) (PAUSED/RESUMING states), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md) (pause/resume mechanics, D-008), [../12-business/01-cost-model.md](../12-business/01-cost-model.md), [../04-data-api/03-api-keys-and-roles.md](../04-data-api/03-api-keys-and-roles.md) (keys page), [../06-security/02-rls-design.md](../06-security/02-rls-design.md)
- Feeds: [02-table-editor.md](02-table-editor.md), [03-sql-editor.md](03-sql-editor.md), [../14-roadmap/02-v1-scope-and-cutlist.md](../14-roadmap/02-v1-scope-and-cutlist.md), [../14-roadmap/01-phase-plan.md](../14-roadmap/01-phase-plan.md) (Phase 7)
