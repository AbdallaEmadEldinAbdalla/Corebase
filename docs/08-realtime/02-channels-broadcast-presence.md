# Channels, Broadcast & Presence

## Purpose

The non-WAL 80% of realtime's user value — ephemeral pub/sub (broadcast) and who's-online state (presence) over WebSockets — which per **D-030 ships first** when realtime is built, because it touches no replication slot and therefore carries none of the [§2.4 hazard](../00-foundation/03-critical-review.md). This whole subsystem is **post-V1**; the doc exists now to fix the wire protocol and the connection-auth contract so V1's gateway, tokens, and schemas don't foreclose it. WAL CDC ([01-realtime-architecture.md](01-realtime-architecture.md)) later rides on the channel plumbing defined here.

### What V1 must preserve for this

1. The **gateway must pass WebSocket upgrades** (Cloudflare proxies WS; the Fastify gateway per D-016 must not assume request/response-only) and the path prefix `/realtime/v1` on project subdomains is **reserved** ([../01-architecture/04-domain-and-region-model.md](../01-architecture/04-domain-and-region-model.md)).
2. JWT claims stay realtime-sufficient: `sub`, `role`, `exp`, project binding via the per-project keypair (D-014, D-029) — verifying a WS connection must need nothing but the project JWKS.
3. Redis (already in the stack, D-018) reachable from data-plane nodes — it becomes the fan-out bus here; **Redis remains never-source-of-truth** (presence state is rebuilt from live connections, not persisted).
4. Reserved names: the `realtime` schema and the function convention `realtime.can_join(...)` (same reservation list as [01-realtime-architecture.md](01-realtime-architecture.md)).
5. Plan schema models `realtime_max_connections` / `realtime_max_channels` columns now, surfaced later (the D-031 pattern; [../02-control-plane/01-data-model.md](../02-control-plane/01-data-model.md)).

## Design

### A. Endpoint and connection auth

```
wss://<project_ref>.corebase.co/realtime/v1?apikey=<anon-or-service_role-key>
```

- **`apikey` (required):** one of the two project keys (D-029). The gateway resolves `<project_ref>` → project, verifies the key against the project keypair, and binds the connection to exactly that `project_id` — proposal §24's rule: no channel on this connection can ever reference another project.
- **User JWT (optional, for `authenticated`-level channels):** sent as the first protocol message rather than a query param (keeps user tokens out of URLs/logs):

```json
{"v":1,"type":"access_token","payload":{"token":"<user-jwt>"}}
```

- **Re-auth on mid-connection expiry (specified):** the server tracks the earliest `exp` on the connection. At `exp − 60 s` it sends `{"v":1,"type":"token_expiring","payload":{"expires_at":"2026-08-27T11:00:00Z"}}`. The client answers with a fresh `access_token` message. If no valid token has arrived by `exp + 30 s` grace, the server closes with code **4401 `token_expired`**. A token downgrade (new token lacks a claim a joined private channel required) forces a server-initiated leave of that channel with an `error` message, not a disconnect.

### B. Channel model and wire protocol

Channels are project-scoped named topics: `room:42`, `game:lobby:7`, `cdc:public.messages`. All frames are JSON text frames, protocol version `v:1`, client message ids echoed in replies.

**Join** (with optional auth payload for private channels, and optional presence registration):

```json
{"v":1,"type":"join","id":"c1","channel":"room:42","payload":{"presence":{"key":"user_a1b2","meta":{"name":"Ada","cursor":null}}}}
```

**Join reply** — success (includes the presence snapshot, §E) or error:

```json
{"v":1,"type":"joined","id":"c1","channel":"room:42","payload":{"presence":{"user_a1b2":[{"name":"Ada","cursor":null}]}}}
{"v":1,"type":"error","id":"c1","channel":"room:42","payload":{"code":"channel_unauthorized","message":"private channel: claim prefix mismatch"}}
```

**Leave / broadcast / presence diff / heartbeat:**

```json
{"v":1,"type":"leave","id":"c2","channel":"room:42"}
{"v":1,"type":"broadcast","id":"c3","channel":"room:42","event":"cursor_move","payload":{"x":312,"y":88}}
{"v":1,"type":"presence_diff","channel":"room:42","payload":{"joins":{"user_c9d0":[{"name":"Lin"}]},"leaves":{"user_a1b2":[{"name":"Ada"}]}}}
{"v":1,"type":"heartbeat","id":"hb17"}   →   {"v":1,"type":"heartbeat_ack","id":"hb17"}
```

Heartbeat is **client-driven every 30 s**; the server closes connections silent for **60 s** (two missed beats) with code 4402 `heartbeat_timeout`. Error codes are strings in a registered set (`channel_unauthorized`, `rate_limited`, `payload_too_large`, `invalid_message`, `channel_limit`, `slow_consumer`); close codes: 4401 token_expired, 4402 heartbeat_timeout, 4408 slow_consumer, 4429 rate_limit_hard.

**Ordering and reconnect:** ordering is guaranteed **per publisher per channel** when both peers sit on the same node (the common case, §G); across the Redis bridge it is best-effort — clients needing strict order must sequence in their payloads. On any close, SDK reconnect policy is exponential backoff with full jitter, 1 s → 30 s cap, re-sending `access_token` and re-joining channels; joins after reconnect replay presence registration, so the rest of the channel sees a leave/join pair rather than a ghost. Close codes 4401/4429 are terminal until the client obtains a fresh token / reduces load; blind tight-loop reconnects on those codes count against the join rate limits (§C).

A minimal session, in order:

```json
→ {"v":1,"type":"access_token","payload":{"token":"eyJhbGciOiJFUzI1NiIs..."}}
→ {"v":1,"type":"join","id":"c1","channel":"room:42","payload":{"presence":{"key":"user_a1b2","meta":{"name":"Ada"}}}}
← {"v":1,"type":"joined","id":"c1","channel":"room:42","payload":{"presence":{"user_a1b2":[{"name":"Ada"}]}}}
→ {"v":1,"type":"broadcast","id":"c2","channel":"room:42","event":"cursor_move","payload":{"x":312,"y":88}}
← {"v":1,"type":"presence_diff","channel":"room:42","payload":{"joins":{"user_c9d0":[{"name":"Lin"}]},"leaves":{}}}
→ {"v":1,"type":"heartbeat","id":"hb1"}
← {"v":1,"type":"heartbeat_ack","id":"hb1"}
```

### C. Broadcast

Client → channel → all current subscribers. **No database involvement whatsoever** — messages are relayed through the broker and forgotten; no persistence, no replay, at-most-once (same stance as [D-126](01-realtime-architecture.md)'s delivery semantics, minus the LSN since there is no log).

**Server-initiated publish** without holding a WebSocket (e.g., from the customer's own backend):

```
POST https://<project_ref>.corebase.co/realtime/v1/broadcast
Authorization: Bearer <service_role key>
{"channel":"room:42","event":"game_over","payload":{"winner":"Ada"}}
```

`service_role` only (D-029); returns `202` with the standard envelope/`X-Request-ID` (D-032). Fire-and-forget: `202` means accepted for fan-out, not delivered.

**Rate limits (proposed numbers — validate under OQ-128, enforced per D-033's layered model):**

| Limit | Proposed value | On breach |
|---|---|---|
| Messages per connection | 10/s sustained, burst 50 | `error: rate_limited`; repeated → close 4429 |
| Broadcast payload size | 64 KiB | `error: payload_too_large` |
| Aggregate per channel | 500 msg/s fan-in | publishers get `rate_limited` |
| Joins per connection | 10/s; **100 concurrent channels** | `error: channel_limit` |
| REST broadcast per project | 50 req/s | HTTP 429, standard envelope |

### D. Connection limits per plan

Concurrent WS connections per project are a plan quota (numbers owned by [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md); placeholders: Free 200, Pro 500, Team 3,000). Enforced at connect with close code 4429 and surfaced in the dashboard usage page. Connections are cheap but not free (~tens of KB each): the quota exists mainly as an abuse ceiling ([../12-business/03-abuse-prevention.md](../12-business/03-abuse-prevention.md)).

### E. Presence

CRDT-lite per-channel state — deliberately *lite*, because every entry is anchored to a live connection and the source of truth is the connection table itself, not a replicated register:

- **Model:** per channel, a map `presence_key → [meta, ...]` (a list, because one user may hold several connections/tabs). `presence_key` defaults to the JWT `sub`, overridable in the join payload. `meta` ≤ 1 KiB.
- **Sync on join:** the full snapshot rides in the `joined` reply (§B) — one message, no separate sync round-trip.
- **Diff on change:** joins/leaves/meta updates broadcast as `presence_diff` frames; a client's `presence_update` message replaces its own metas.
- **Multi-node merge:** each realtime node owns the presence entries of its local connections and publishes diffs on the Redis bus (§G); remote state is a passive replica keyed by `(node_id, connection_id)`, so merges are trivially conflict-free — no vector clocks needed at this granularity.
- **TTL sweep:** graceful `leave`/close emits the leave diff immediately; ungraceful death is caught by the 60 s heartbeat timeout; a node crash is caught by the node's Redis liveness key expiring (TTL 15 s, refreshed at 5 s), after which peers sweep all entries owned by the dead node.
- **Cap:** 500 tracked presence keys per channel (proposed; above it, joins may subscribe but not register presence — `error: presence_full`). Validate under OQ-130.

### F. Channel authorization

Options considered:

| Option | Mechanics | Cost per join | Notes |
|---|---|---|---|
| Public channels | Any bound connection joins | 0 | Fine for many apps; the default only if the developer says so |
| **JWT-claim prefix rules** | Static per-project rules, e.g. `private:user:{sub}:*` joinable only when `{sub}` matches the token's `sub`; `admin:*` requires `role=service_role` or a listed claim | 0 (pure token inspection) | No DB round-trip — works even when the project DB is **paused** (D-008), which a SQL callback would wake |
| SQL callback | Developer defines `realtime.can_join(channel_name text, claims jsonb) returns boolean`; evaluated under the user's role with claims injected per D-015's `SET LOCAL` pattern | 1 query per join against the customer primary | Maximally expressive; couples join latency and join storms to the customer DB, and resumes paused projects |

**Pick (D-129): claim-prefix rules first.** Channels are **private by default**; a project declares channel rules (dashboard/CLI, stored control-plane side) of the form `{pattern, requirement}` where requirement is `public`, `authenticated`, or a claim-template match as above. The `realtime.can_join` SQL callback is the designated second iteration for apps whose membership lives in tables (its convention name is already reserved so nothing squats on it) — with the stated caveat that it reintroduces a DB dependency into the join path (latency, join storms, paused-project wakes: OQ-129). CDC channels (`cdc:*`) additionally require the table to be opted in per [D-127](01-realtime-architecture.md).

### G. Horizontal fan-out

One realtime process per node (colocated per [D-125](01-realtime-architecture.md)) serves that node's projects; the subdomain router pins `wss://<ref>...` to the project's node, so in the common case **all subscribers of a channel sit on one process and fan-out is in-memory**. When a project's connections outgrow one process (or WS serving splits from the node agent), nodes bridge over **Redis pub/sub**: publish once to `rt:<project_id>:<channel>`, every node holding local subscribers relays. Redis pub/sub is fire-and-forget — which matches the at-most-once contract exactly, and it is **sufficient for a long time**: a single modest Redis instance moves hundreds of thousands of messages/s, far beyond any plausible early fleet. NATS/sharded Redis is a swap behind the broker interface if that ceiling is ever measured, not a thing to build now.

## Decisions

- **D-128 — Realtime wire protocol v1: JSON frames `{v, type, id?, channel?, event?, payload}` over `wss://<ref>.corebase.co/realtime/v1?apikey=...`; user JWT via `access_token` message (never in the URL); token-expiry renegotiation (`token_expiring` → `access_token`, 30 s grace, close 4401); client heartbeat every 30 s with 60 s server timeout; broadcast is DB-free and at-most-once with a `service_role`-only REST publish at `POST /realtime/v1/broadcast`; rate limits per the §C table; cross-node fan-out over Redis pub/sub behind a broker interface.** *(Rationale: the protocol is the compatibility surface SDKs and CDC both ride on — fixing it now is what keeps V1 from foreclosing realtime; every mechanism chosen avoids touching the customer database, which is the entire point of shipping this half first per D-030.)*
- **D-129 — Channel authorization v1: channels are private by default; access is granted by per-project declarative rules — `public`, `authenticated`, or JWT-claim prefix templates (e.g. `private:user:{sub}:*`) — evaluated from the token alone with no database round-trip. The `realtime.can_join(channel_name, claims)` SQL-callback convention is reserved as the follow-on for table-driven membership.** *(Rationale: token-only evaluation keeps the join path independent of the customer primary — no join-storm load, no waking paused projects (D-008) — and covers the dominant "my own room / my own user id" cases; the callback is deferred, not rejected, and its name is reserved so adopting it later is additive.)*

## Open Questions

- **OQ-128:** Load-validate the §C rate-limit numbers (10 msg/s/conn, 500 msg/s/channel, 64 KiB payload, 50 req/s REST) against real node capacity before GA of broadcast — they are proposed from first principles, not measurement.
- **OQ-129:** `realtime.can_join` iteration-2 design: result caching per (connection, channel) with what TTL, behavior when the project DB is paused (fail closed? wake?), and protection against join storms after a mass reconnect.
- **OQ-130:** Presence ceiling: is 500 keys/channel and 1 KiB meta the right cap, and at what channel size does full-snapshot-on-join (§E) need pagination or lazy sync?

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-008, D-014, D-016, D-018, D-029, D-030, D-032, D-033), [../00-foundation/00-original-proposal-v0.1.md](../00-foundation/00-original-proposal-v0.1.md) (§23–24), [../05-auth/02-sessions-and-tokens.md](../05-auth/02-sessions-and-tokens.md) (JWT/JWKS, expiry), [../04-data-api/03-api-keys-and-roles.md](../04-data-api/03-api-keys-and-roles.md) (anon/service_role), [../01-architecture/04-domain-and-region-model.md](../01-architecture/04-domain-and-region-model.md) (subdomain routing), [../06-security/04-platform-security.md](../06-security/04-platform-security.md) (rate-limit tiers)
- Feeds: [01-realtime-architecture.md](01-realtime-architecture.md) (CDC rides these channels and this auth), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md) (client protocol implementation), [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md) (connection/channel quotas), [../14-roadmap/03-post-v1-roadmap.md](../14-roadmap/03-post-v1-roadmap.md) (ships before CDC per D-030)
