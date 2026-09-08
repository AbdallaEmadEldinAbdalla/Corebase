# SDK Spec (`@steadhold/core`)

## Purpose

The API surface of `@steadhold/core` (proposal §46, §79, §108): the TypeScript-first client library for the data plane — database queries, auth, storage, and a reserved realtime namespace. Defines the `{ data, error }` contract, token persistence and refresh behavior, the generated-types story, and the compatibility policy. The REST semantics the query builder maps onto are owned by [REST API design](../04-data-api/01-rest-api-design.md); the key/role model by [API keys & roles](../04-data-api/03-api-keys-and-roles.md).

## Design

### Packaging & runtime constraints

- **TypeScript-first**, shipped as **ESM + CJS** with bundled `.d.ts`.
- Runs in **browser, Node ≥ 20, and edge runtimes** (Workers, Deno): built entirely on **`fetch`** and Web APIs — **zero node-only dependencies**, no `Buffer`, no `node:` imports. One build, everywhere.
- **Size budget: < 15 kB gzipped** for the core (client + database + auth; storage may be a subpath export if it threatens the budget). Enforced in CI with a size check; a PR that busts the budget needs a stated reason.
- Apache-2.0 from first public release (D-034).

### `createClient(url, key, options?)`

```ts
import { createClient } from "@steadhold/core";

const steadhold = createClient<Database>(
  "https://kxqwrtplmzensfba.steadhold.app",   // or http://localhost:54321 — nothing else changes
  process.env.STEADHOLD_ANON_KEY!,
  {
    auth: {
      persist: "localStorage",   // "localStorage" | "memory" | StorageAdapter
      autoRefresh: true,          // default true
    },
    global: {
      headers: { "x-app-version": "1.4.2" },  // merged into every request
      fetch: customFetch,                      // override (proxies, test doubles, instrumented fetch)
    },
  }
);
```

- `StorageAdapter` is `{ getItem(k): Promise<string|null>; setItem(k, v): Promise<void>; removeItem(k): Promise<void> }` — the custom-adapter escape hatch for React Native, extensions, and server session stores. Defaults: `localStorage` in browsers, `memory` elsewhere.
- The one-URL-swap between local and prod is a platform invariant (D-138, [local development](02-local-development.md)) — the SDK never special-cases environments.

### Headers: `apikey` + `Authorization`

Per [API keys & roles](../04-data-api/03-api-keys-and-roles.md), every request carries **both**:

| Header | Value | Role |
|---|---|---|
| `apikey` | the key given to `createClient` (usually `anon`) | Identifies the project + baseline key at the gateway (D-029, D-033 rate buckets) |
| `Authorization` | `Bearer <access token>` — the signed-in user's JWT when a session exists, otherwise the `apikey` value again | Determines the Postgres role: `authenticated` + RLS claims, or `anon` |

Sign-in upgrades `Authorization` automatically on every subsequent request; sign-out reverts it to the apikey. `service_role` keys work identically (server-side code only — the SDK docs carry the standard warning, and the dashboard nags on browser-origin service_role traffic).

### Database interface

A PostgREST-compatible fluent builder (D-011) — each chain compiles to one REST request using the grammar in [REST API design](../04-data-api/01-rest-api-design.md):

| Method | REST mapping | Notes |
|---|---|---|
| `.from(table)` | `/rest/v1/<table>` | Entry point |
| `.select(cols?, { count? })` | `GET ?select=…` (+ `Prefer: count=exact\|planned\|estimated`) | `cols` supports embedding: `"id, author:users(name)"`; count returned alongside data |
| `.insert(rows, { upsert?, onConflict? })` | `POST` (+ `Prefer: resolution=merge-duplicates` when upsert) | Single object or array; returns rows with `.select()` chained |
| `.update(values)` | `PATCH` | **Must** be filtered (`.eq()` etc.) — unfiltered update/delete is rejected client-side before any request is sent |
| `.delete()` | `DELETE` | Same mandatory-filter rule |
| `.eq/.neq/.gt/.gte/.lt/.lte(col, v)` | `?col=eq.v` … | Chainable, ANDed |
| `.in(col, values)` | `?col=in.(a,b)` | |
| `.like/.ilike(col, pattern)` | `?col=like.*x*` | |
| `.is(col, null\|bool)` | `?col=is.null` | |
| `.or(filterString)` | `?or=(a.eq.1,b.gte.2)` | Raw PostgREST or-grammar, escape hatch included |
| `.order(col, { ascending?, nullsFirst? })` | `?order=col.desc.nullslast` | Repeatable |
| `.range(from, to)` | `Range: from-to` header | Pagination |
| `.limit(n)` | `?limit=n` | |
| `.single()` | `Accept: application/vnd.pgrst.object+json` | Exactly one row or `error` |
| `.maybeSingle()` | same, tolerant | Zero rows → `data: null`, no error |
| `.rpc(fn, args?)` | `POST /rest/v1/rpc/<fn>` | Postgres functions; read-only fns may use GET per the REST doc |

```ts
const { data, error, count } = await steadhold
  .from("posts")
  .select("id, title, author:users(name)", { count: "exact" })
  .eq("published", true)
  .order("created_at", { ascending: false })
  .range(0, 9);
```

### The `{ data, error }` contract

Every terminal call resolves to `{ data, error }` (plus `count`/`status` where meaningful). **API errors never throw.**

```ts
type SteadholdError = {
  code: string;      // PostgREST/PG code ("PGRST116", "23505") or platform code (D-032)
  message: string;
  details: string | null;
  hint: string | null;
  request_id: string | null;  // from the D-032 envelope / X-Request-ID on gateway-minted errors;
                              // null when a PostgREST pass-through body lacks it
};
// exactly one of the two is non-null:
{ data: T, error: null } | { data: null, error: SteadholdError }
```

- `request_id` exists as the support handle: it is what a user pastes into a ticket and what joins a client-side error to the platform's logs (D-032).
- **Throws only for programmer errors:** unfiltered `.update()`/`.delete()`, invalid arguments, calling a builder after it was consumed. These are bugs to surface loudly, not runtime conditions to handle.
- Network failures resolve as `error` with `code: "NETWORK_ERROR"` — a runtime condition, not a bug.
- Rationale: forces error handling into the visible control flow, matches the incumbent's contract (migration ergonomics), and keeps `await` chains safe in UI code.

### Generated types — `steadhold gen types`

```
steadhold gen types [--local] [--schema public] > src/steadhold.types.ts
```

The CLI introspects the linked project's database (or the local stack with `--local`) and emits a `Database` type; `createClient<Database>()` then types every table, column, filter, insert/update payload, and RPC end-to-end. Generated shape, briefly:

```ts
export interface Database {
  public: {
    Tables: {
      posts: {
        Row:    { id: string; title: string; published: boolean; created_at: string };
        Insert: { id?: string; title: string; published?: boolean; created_at?: string };
        Update: { id?: string; title?: string; published?: boolean; created_at?: string };
        Relationships: [{ foreignKeyName: "posts_author_fkey"; columns: ["author_id"]; referencedRelation: "users" }];
      };
      // ...
    };
    Views: { /* Row only */ };
    Functions: { hello: { Args: { name: string }; Returns: string } };
    Enums: { post_status: "draft" | "published" };
  };
}
```

`Row`/`Insert`/`Update` differ by nullability and defaults (columns with defaults are optional in `Insert`). Regenerating after `db push` is the documented habit; CI can diff the generated file to catch schema drift.

### Auth interface

Wraps `/auth/v1/*` ([flows](../05-auth/03-flows.md), [sessions & tokens](../05-auth/02-sessions-and-tokens.md)):

| Method | Behavior |
|---|---|
| `auth.signUp({ email, password })` | Registers; returns session or pending-verification marker per project settings |
| `auth.signInWithPassword({ email, password })` | Session (access JWT + rotating refresh token, D-013) persisted via the adapter |
| `auth.signOut()` | Revokes the refresh token server-side, clears persisted session, reverts headers |
| `auth.refreshSession()` | Manual refresh (rotation + reuse detection are server concerns) |
| `auth.getSession()` | Current session from memory/adapter — no network call |
| `auth.getUser()` | Fetches the user from the server (authoritative — validates the token) |
| `auth.onAuthStateChange(cb)` | `cb(event, session)` on `SIGNED_IN\|SIGNED_OUT\|TOKEN_REFRESHED\|USER_UPDATED`; returns an unsubscribe handle |
| `auth.resetPasswordForEmail(email)` | Always resolves success (enumeration-resistant, mirrors the API) |
| `auth.updateUser({ password?, email?, data? })` | Requires an active session |

**Token persistence & auto-refresh (specified):**

- Sessions persist through the configured adapter under a project-scoped key (`sh-<ref>-auth`).
- With `autoRefresh: true`, a refresh is scheduled at **`exp − 60s`**. Failure → retries with exponential backoff (1s, 2s, 4s… capped 30s, jittered) until success or a terminal auth error (revoked/reused refresh token → `SIGNED_OUT` event, session cleared).
- Timers are coarse (one timer per client, re-armed on refresh), and a refresh is also attempted lazily if a request finds the access token already expired (laptop-asleep case) — the request waits for the refresh, then proceeds; concurrent requests share one in-flight refresh.
- **Multi-tab sync:** with the `localStorage` adapter, the SDK listens to `storage` events; a refresh or sign-out in one tab updates every tab's in-memory session and fires `onAuthStateChange` — and tabs race-protect refresh with a short-lived storage lock so only one tab refreshes per rotation (rotation + reuse detection makes double-refresh a security event, not just waste).

### Storage interface

Wraps `/storage/v1/*` ([storage API & policies](../07-storage/02-storage-api-and-policies.md)):

| Method | Behavior |
|---|---|
| `storage.from(bucket).upload(path, file, { contentType?, upsert? })` | ≤ 50 MB proxied, larger uses the presigned flow (D-122) — transparent to the caller |
| `.download(path)` | Resolves `{ data: Blob, error }` |
| `.list(prefix?, { limit?, offset?, search? })` | Metadata rows from `storage.objects` |
| `.remove(paths[])` | Batch delete |
| `.createSignedUrl(path, expiresIn)` | Time-limited URL for private objects |
| `.getPublicUrl(path)` | Synchronous string build for public buckets — no network call |

All storage access rides the same two headers, so RLS-on-objects (D-017) applies as the signed-in user.

### Realtime: reserved namespace (D-139)

Realtime is post-V1 (D-030). The SDK **ships the namespace as a typed stub** rather than omitting it:

```ts
steadhold.channel("room-1");
// throws SteadholdNotImplementedError:
// "Realtime ships post-V1 (see roadmap). steadhold.channel() is reserved and will keep this signature."
```

`channel(name).on(event, filter, cb)` / `.subscribe()` signatures are declared (matching [channels, broadcast, presence](../08-realtime/02-channels-broadcast-presence.md)) so app code and types written today survive the feature landing. The stub throws immediately and synchronously — a loud programmer-error, consistent with the contract above (it is not an API error, so it does not return `{ error }`). Cost: ~0.2 kB. Alternative considered — omitting the namespace — rejected: it makes the post-V1 landing a breaking-feeling minor release and invites third-party polyfills squatting on the name.

### Versioning & compatibility

- **SDK follows semver.** Breaking changes to any documented type or method → major. The `{ data, error }` shape and builder method names are the frozen core surface.
- Every request sends `X-Client-Info: steadhold-js/<version>`. The gateway may respond `X-Steadhold-Min-Client: <version>`; an older SDK logs **one** console warning per session (never a failure — the server stays compatible per the [release & versioning policy](../13-quality/02-release-and-versioning.md); the header is the deprecation nudge, not an enforcement gate).
- Data-plane path versions (`/rest/v1` etc.) are pinned per SDK major.

### Supabase-migration ergonomics (one honest paragraph)

The surface is deliberately similar to `supabase-js` — same mental model, near-identical method names, same `{ data, error }` idiom. That is a considered position, not an accident: D-011 already embeds PostgREST, so the query semantics are shared anyway, and a familiar surface lowers switching cost *toward* Steadhold in exactly the lane the [competitive analysis](../00-foundation/02-competitive-analysis.md) says we compete in (portability, D-006 — which cuts both ways, and we accept that). It is a compatible-feeling surface, not a compatibility promise: we do not track their API changes, we omit what V1 doesn't have instead of stubbing it silently (realtime being the one explicit, loudly-throwing exception above), and where their ergonomics have known warts we are free to diverge in a major version.

## Decisions

- **D-139 — The SDK ships the realtime namespace as a typed, reserved stub (`channel()`/`.on()`/`.subscribe()` signatures declared) that throws `SteadholdNotImplementedError` synchronously until realtime ships post-V1 (D-030); API errors otherwise never throw — every terminal call resolves `{ data, error }` with `SteadholdError { code, message, details, hint }`, and throwing is reserved for programmer errors (including unfiltered update/delete, rejected client-side).** *(Rationale: reserving the namespace makes realtime's later arrival additive instead of surface-breaking and keeps types stable for early adopters; the never-throw-for-API-errors contract keeps error handling in visible control flow and matches the ecosystem contract migrating developers already know.)*

(Packaging, the 15 kB budget, and the dual-header scheme are spec details implementing D-026/D-029/D-034, not new decisions.)

## Open Questions

- **OQ-139** — Multi-tab session sync via `storage` events works everywhere but is lossy on same-tab writes; adopt `BroadcastChannel` (with storage-event fallback) once browser-support review confirms the matrix, or keep storage-events-only for V1?
- **OQ-039** — `steadhold gen types` output as a committed file is the V1 story; is a published-per-project types package (registry-hosted, auto-regenerated on `db push`) worth the infrastructure post-V1?

## Dependencies

- **Builds on:** [REST API design](../04-data-api/01-rest-api-design.md) (filter/embed/RPC grammar, D-011) · [API keys & roles](../04-data-api/03-api-keys-and-roles.md) (D-029, dual headers) · [sessions & tokens](../05-auth/02-sessions-and-tokens.md) (JWT/refresh model, D-013/D-014) · [auth flows](../05-auth/03-flows.md) · [storage API & policies](../07-storage/02-storage-api-and-policies.md) (D-122) · [realtime channels](../08-realtime/02-channels-broadcast-presence.md) (reserved signatures, D-030)
- **Feeds:** [CLI spec](01-cli-spec.md) (`gen types`) · [local development](02-local-development.md) (one-URL-swap invariant consumer) · [release & versioning](../13-quality/02-release-and-versioning.md) (client-version handshake) · [open-source strategy](../12-business/04-open-source-strategy.md) (SDK Apache-2.0, D-034) · [open questions](../15-risks/02-open-questions.md)
