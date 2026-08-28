# Realtime Architecture (WAL CDC)

## Purpose

The design for database-change streaming (CDC) over WebSockets — proposal §23/§93 — done with respect for the hazard the critical review flagged in [§2.4](../00-foundation/03-critical-review.md): **a logical replication slot pins WAL on the customer's primary; a stalled consumer fills the disk and takes the database down.** Per **D-030** this entire subsystem is **post-V1**, and within realtime it ships *last* — after [broadcast/presence](02-channels-broadcast-presence.md). This doc exists now for one reason: so V1 doesn't paint the architecture into a corner. The slot-hazard section is the centerpiece; everything else is arranged around not triggering it.

### What V1 must preserve for this

1. **`wal_level = logical` as the fleet default from day one** (decided below, D-125). Changing it later requires a restart of *every* customer primary.
2. Headroom params in the V1 Postgres template: `max_wal_senders = 4`, `max_replication_slots = 2` (both unused in V1; shared-memory cost is negligible).
3. **`max_slot_wal_keep_size` set even in V1** (a slot created by accident or by a support operator must still be capped).
4. The names `realtime` (schema), `corebase_realtime` (publication), and `corebase_rt_*` (slot prefix) are **reserved** — migrations tooling ([../03-database-platform/04-migrations.md](../03-database-platform/04-migrations.md)) must reject user objects with these names.
5. A network path from the node agent to each project container's Postgres port that **bypasses PgBouncer** — logical replication connections cannot go through a transaction-mode pooler (D-015).
6. Disk-usage and WAL-volume metrics per project already exported ([../11-infrastructure/03-observability.md](../11-infrastructure/03-observability.md)); slot lag is one more gauge on an existing pipeline.
7. Per-plan realtime quota columns modeled in the control-plane schema (same "model now, surface later" pattern as D-031; see [../02-control-plane/01-data-model.md](../02-control-plane/01-data-model.md)).

**The cost of `wal_level = logical` preemptively vs. later:** logical adds modest WAL volume (old-key/metadata records; low single-digit % for typical workloads, ASSUMPTION to benchmark in OQ-127) and near-zero idle cost while no slot exists. Enabling it *later* means a coordinated restart of thousands of container-per-project primaries (D-009) — a fleet-wide maintenance event with per-customer downtime, for a setting we know we'll want. Default it on. (Verify the WAL-volume delta during the OQ-127 benchmark; if it materially hurts paused-project storage costs, revisit — but WAL volume on idle projects is ~0 regardless.)

## Design

### A. Pipeline

```
project Postgres (publication: corebase_realtime)
   │  logical replication protocol, slot corebase_rt_<project_ref>, plugin pgoutput
   ▼
per-project decoder  (inside the per-node realtime agent, colocated with the project's containers)
   │  decoded change events (JSON), project-scoped
   ▼
channel broker       (same agent process; Redis pub/sub only when fan-out crosses nodes)
   │
   ▼
WebSocket gateway    (same connection surface as broadcast/presence: wss://<ref>.corebase.co/realtime/v1)
   │
   ▼
clients (subscribed to cdc:<schema>.<table> channels with optional filters)
```

One slot per project **with at least one active CDC subscriber**, not one per project: slots are created lazily on first subscribe and dropped after an idle grace period (default 60 s with zero subscribers). A slotless project carries zero WAL-pinning risk.

### B. Decoder plugin: pgoutput vs wal2json

| Criterion | `pgoutput` | `wal2json` |
|---|---|---|
| Availability | Built into Postgres, versioned with the server | Extension to install and version across the fleet (touches the curated allowlist, [../03-database-platform/06-extensions-and-upgrades.md](../03-database-platform/06-extensions-and-upgrades.md)) |
| Output | Binary protocol; decode in the consumer | JSON emitted by the *database* |
| Where CPU is spent | Realtime agent (our hardware budget) | Customer primary (their RAM/CPU cgroup, D-009) |
| Table scoping | Native publications: `FOR TABLE` lists, row/column filters (PG15+) | Slot options; coarser |
| Ecosystem | The plugin native logical replication uses; Node decoding via `pg-logical-replication` (one language, D-010) | Simpler to consume, smaller ecosystem |

**Pick: `pgoutput` (D-125).** No new extension on the allowlist, table opt-in falls out of publications for free, and encoding cost lands on our agent instead of inside the customer's cgroup. The price is a binary decoder in TypeScript — a solved problem with existing libraries.

### C. The replication-slot hazard — the centerpiece

**The failure mode, spelled out:** a logical slot advances only when its consumer confirms progress. If the consumer stalls (agent crash, network partition, bug, or simply a paused/slow subscriber pipeline), Postgres retains **all WAL** since the slot's `restart_lsn`. On a container with a small disk quota ([../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md)), that is not a degradation — it is `PANIC: could not write to file "pg_wal/..."`, and **the customer's primary is down**. This subsystem can convert a realtime bug into a database outage, which inverts the priority stack (D-002). Every mitigation below is mandatory, layered, and assumes the previous one failed.

**Layer 1 — hard cap: `max_slot_wal_keep_size`.** Set per project to `min(4 GB, 20% of the project's disk quota)` (per-plan values owned by OQ-109). When retained WAL exceeds the cap, Postgres **invalidates the slot** instead of filling the disk. The tradeoff is explicit: subscribers lose their position and must resync from a fresh snapshot of current state. **That is the right trade.** A resync is an inconvenience inside an optional feature; a full disk is an outage of the product's core. We choose losing the cursor over losing the database, always.

**Layer 2 — lag monitoring.** The agent samples `pg_replication_slots` every 15 s and exports `corebase_realtime_slot_lag_bytes` (computed via `pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)`). Alert thresholds as fractions of the Layer-1 cap: **25% warn** (ticket), **50% page**, **75% kill-switch armed**. Also alert on `active = false` for > 5 min while subscribers exist (consumer died but slot remains).

**Layer 3 — kill switch.** At **90% of the cap**, or on any disk-usage alarm for the project volume regardless of slot lag, the agent (or an operator, via a one-command runbook) executes `pg_drop_replication_slot()` — outranking Postgres's own invalidation because it frees WAL *before* the cap is fully consumed and works even if Layer 1 was misconfigured. Dropping a slot is always safe for the *database*; it is only ever unsafe for the *feature*.

**Layer 4 — auto-recreate + client resync protocol.** After an invalidation or drop, the agent: (1) recreates the slot; (2) pushes a `system` event to every affected channel:

```json
{"v":1,"type":"system","channel":"cdc:public.messages","payload":{"code":"cdc_resync_required","message":"change stream position lost; refetch state","last_known_lsn":"0/1A2B3C4D"}}
```

(3) resumes streaming from the new slot. Clients are contractually required (SDK behavior, [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md)) to treat this as "refetch current state via the REST API, then continue on the live stream." The gap between drop and recreate is silent data loss on the stream — acceptable because delivery is at-most-once anyway (§E).

### D. Subscription model

Clients subscribe over the existing channel protocol ([wire shapes](02-channels-broadcast-presence.md)) to CDC channels:

```json
{"v":1,"type":"join","id":"c7","channel":"cdc:public.messages","payload":{"filter":"room_id=eq.42","events":["INSERT","UPDATE","DELETE"]}}
```

- Channel name: `cdc:<schema>.<table>`; filter grammar is a **subset of the PostgREST operator set** already in the product (D-011): `eq, neq, gt, gte, lt, lte, in` on a single column. One filter per subscription in v1.
- **Server-side filter evaluation** in the broker: the decoded row is matched against each subscription's filter before delivery. Filters on UPDATE/DELETE need old-row values → opted-in tables get `REPLICA IDENTITY FULL` set at opt-in time (write-amplification cost benchmarked under OQ-127).
- Delivered event shape:

```json
{"v":1,"type":"cdc","channel":"cdc:public.messages","payload":{"schema":"public","table":"messages","op":"INSERT","commit_lsn":"0/1A2B3D00","commit_ts":"2026-08-27T10:15:04.221Z","new":{"id":9107,"room_id":42,"body":"hi"},"old":null}}
```

**Initial state on subscribe:** there is no snapshot on join — a CDC subscription starts at the slot's current position. The SDK-documented pattern is: (1) join the channel and buffer incoming events; (2) fetch current state via the REST API; (3) apply buffered events, using primary keys for idempotent upserts (at-most-once delivery makes exactly-once reconstruction impossible anyway; the pattern converges regardless of the small join/fetch race). Server-side snapshot-on-subscribe (exported snapshot from `CREATE_REPLICATION_SLOT`) is deliberately out of scope for v1 — it holds a transaction open on the customer primary per join.

**Slot lifecycle vs pause/resume (D-008):** an open CDC subscription does **not** count as project activity for free-tier pause — otherwise any idle app with one forgotten browser tab defeats the economics that D-008 exists for. On pause: the agent drops the slot (there is nothing to stream from a stopped container) and the WebSocket channel stays joined but silent. On resume: the slot is recreated lazily on the next write, and subscribers receive `cdc_resync_required` (§C Layer 4) since the position is gone. Paused projects therefore hold **zero** slots by construction.

### E. Authorization for CDC — the hard problem

RLS applies to *queries*; WAL has no notion of a reader. A change event must be authorized against each subscriber before delivery. Three known approaches:

| Approach | Correctness | Cost | Verdict |
|---|---|---|---|
| **Re-query per event per subscriber** (replay the row through a `SELECT` under the subscriber's RLS context) | Exact | events × subscribers queries against the customer primary — the very database we swore to protect; also resumes paused projects | Rejected as the default path |
| **Policy-evaluation replication** (Supabase's *walrus*: evaluate the relevant policies against the change row once per event for the subscriber set, via prepared statements) | Close (policies referencing *other* rows are evaluated at delivery time, not commit time — a known, documented skew) | Per-event DB work, bounded; significant engineering | The roadmap (OQ-108) |
| **Explicit opt-in tables + publication config + a simple visibility rule** | Coarse | ~zero per event | **Picked for CDC v1 (D-127)** |

**The pick, with its limits stated honestly (D-127):** a table emits events only if the developer runs `ALTER PUBLICATION corebase_realtime ADD TABLE ...` (surfaced as a dashboard toggle / CLI command). The visibility rule is: **an event from an opted-in table is delivered to any subscriber who was authorized to join that channel** (channel auth per [02-channels-broadcast-presence.md](02-channels-broadcast-presence.md) and proposal §24's project binding). Filters are a *convenience, not a security boundary* — a subscriber to `cdc:public.messages` with `room_id=eq.42` could equally have subscribed with `room_id=eq.43`. Documentation must say, in exactly these words: **do not opt a table into CDC if any of its rows must be hidden from some user who can join its channel.** Per-subscriber RLS-faithful delivery (walrus-style) is the explicit successor, tracked as OQ-108; the wire protocol reserves nothing that blocks it.

### F. Delivery semantics

**At-most-once, no replay, in realtime v1.** No acknowledgements, no server-side event buffer beyond the per-connection send queue, no catch-up on reconnect — reconnect means resync (§C Layer 4). Every event carries `commit_lsn`, which is the **cursor a future replay feature will key on**; emitting it from day one costs nothing and makes at-least-once + replay an additive change rather than a protocol break.

### G. Backpressure

Per-connection outbound buffer capped at **1 MiB or 1,000 queued messages** (whichever first). On overflow: close the connection with code `4408 slow_consumer` (client may reconnect and resync). **Never** propagate a slow client upstream — the WAL reader always confirms progress at its own pace, because the only thing backpressure against the WAL reader can achieve is slot lag, i.e., the §C hazard. Dropping one laggard's connection protects every other tenant on the node and the customer's primary.

### H. Scaling shape

Realtime is **the first service to split from the modular monolith** (consistent with D-020's "split on measured constraint" — a long-lived-connection, event-fan-out workload shares nothing with request/response API semantics). Placement of the WAL-reading half:

| Shape | For | Against |
|---|---|---|
| **Per-node realtime agent, colocated with the projects' containers** | Replication streams stay on-node (loopback, no cross-node replication traffic); blast radius of an agent crash = one node; disk/WAL telemetry is already node-local; the SNI/subdomain router ([../01-architecture/04-domain-and-region-model.md](../01-architecture/04-domain-and-region-model.md)) can pin `wss://<ref>...` to the project's node, so most fan-out never crosses nodes | One more per-node daemon to ship and upgrade |
| Central realtime fleet | One deployable; independent capacity scaling | Every replication stream crosses the network; a fleet incident stalls slots for *all* projects at once — a correlated version of the §C hazard |

**Picked: per-node colocated agent (part of D-125).** The WebSocket-serving half starts in the same agent process; if connection counts ever outgrow the node, the WS tier can split off centrally while WAL reading stays colocated — the broker boundary (Redis pub/sub, [02-channels-broadcast-presence.md](02-channels-broadcast-presence.md)) is exactly that seam.

## Decisions

- **D-125 — CDC pipeline: `wal_level=logical` + `max_wal_senders=4` + `max_replication_slots=2` are V1 fleet defaults; decoder plugin is `pgoutput` over a lazily-created per-project slot (`corebase_rt_<ref>`, publication `corebase_realtime`); the consumer is a per-node realtime agent colocated with the project containers, and realtime is the first service split from the monolith when built.** *(Rationale: defaulting `wal_level=logical` now costs low-single-digit % WAL volume; flipping it later costs a fleet-wide restart of every customer primary. pgoutput avoids adding an extension to the allowlist and keeps decode CPU off the customer's cgroup. Colocation keeps replication traffic on-node and the blast radius per-node.)*
- **D-126 — Slot-safety envelope: `max_slot_wal_keep_size = min(4 GB, 20% of project disk quota)` on every project (V1 included); slot-lag alerts at 25%/50%/75% of the cap; automatic kill-switch drops the slot at 90% or on any project disk alarm; auto-recreate then push `cdc_resync_required` to affected channels. Delivery is at-most-once with no replay in realtime v1; every event carries `commit_lsn` as the future replay cursor. Slow clients are disconnected at a 1 MiB / 1,000-message outbound buffer; the WAL reader is never backpressured.** *(Rationale: slot invalidation loses a stream position; a pinned slot loses a customer database. Under D-002 that choice is mechanical — say so in the design and make every layer assume the previous one failed.)*
- **D-127 — CDC authorization v1: tables emit events only when explicitly opted into the `corebase_realtime` publication, and events are visible to any subscriber authorized to join that table's channel; server-side filters are a convenience, not a security boundary, and the docs must say so. Walrus-style per-subscriber policy evaluation is the designated successor; per-event re-query under subscriber RLS is rejected as a default path.** *(Rationale: the only approach whose per-event cost against the customer primary is ~zero; its coarseness is acceptable exactly because it is opt-in and honestly documented. The successor is scoped in OQ-108 rather than promised.)*

## Open Questions

- **OQ-108:** Walrus-style policy evaluation — prototype cost per event per 100 subscribers against a tuned per-project Postgres (D-009 cgroup limits), and the correctness skew (policies referencing other rows evaluated at delivery time) documented as acceptable or not. Gate for CDC v2.
- **OQ-109:** Per-plan values for `max_slot_wal_keep_size` and slot count (Free likely gets CDC disabled or 1 slot/1 GB; link [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md)) — needs the disk-quota-per-plan numbers to land first.
- **OQ-127:** Benchmarks: (a) actual WAL-volume overhead of `wal_level=logical` vs `replica` on representative workloads (the D-125 assumption), and (b) write amplification of `REPLICA IDENTITY FULL` on opted-in tables — if (b) is severe, restrict UPDATE/DELETE filters to primary-key columns instead.

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-002, D-009, D-015, D-020, D-030), [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md) (§2.4), [../00-foundation/00-original-proposal-v0.1.md](../00-foundation/00-original-proposal-v0.1.md) (§23–24, §93), [02-channels-broadcast-presence.md](02-channels-broadcast-presence.md) (wire protocol, channel auth, fan-out — ships first per D-030), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md) (disk quotas, disk-full handling), [../04-data-api/01-rest-api-design.md](../04-data-api/01-rest-api-design.md) (filter grammar), [../06-security/02-rls-design.md](../06-security/02-rls-design.md), [../11-infrastructure/03-observability.md](../11-infrastructure/03-observability.md)
- Feeds: [../14-roadmap/03-post-v1-roadmap.md](../14-roadmap/03-post-v1-roadmap.md) (realtime phase ordering), [../15-risks/01-risk-register.md](../15-risks/01-risk-register.md) (the slot hazard as a registered risk), [../10-cli-and-sdk/03-sdk-spec.md](../10-cli-and-sdk/03-sdk-spec.md) (resync behavior is an SDK contract), [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md) (CDC quotas per plan)
