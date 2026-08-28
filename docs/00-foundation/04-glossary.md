# Glossary

## Purpose

Shared vocabulary for the corpus. Terms are defined *as Corebase uses them* — where industry usage varies, the Corebase meaning wins inside these docs.

## Platform terms

| Term | Meaning in Corebase |
|---|---|
| **Control plane** | The systems that manage Corebase itself: accounts, orgs, projects, billing, provisioning, infrastructure state. Never in the path of customer application traffic. |
| **Data plane** | The systems that serve customer application traffic: project Postgres, PostgREST, auth endpoints, storage, (later) realtime. A control-plane outage must not take down the data plane. |
| **Organization (org)** | Billing and membership boundary. Owns projects. Roles: owner / admin / member. |
| **Project** | The unit of provisioning: one Postgres instance + pooler + PostgREST + auth config + storage bucket namespace + keys. In V1, project == environment (D-031). |
| **Provisioning** | The async job pipeline that turns a project row into running infrastructure. Driven by a state machine (`CREATING → PROVISIONING → CONFIGURING → READY / FAILED`). |
| **Reconciliation** | Comparing *desired state* (control-plane DB) against *actual state* (what's running on nodes) and converging them. The provisioner is a reconciler, not a script runner. |
| **Node** | A Hetzner VM/dedicated server in the data plane hosting many project containers. |
| **Pause / resume** | Stopping an idle project's containers (Postgres, pooler, PostgREST) while keeping its data volume; recreating them on the next request. The economics keystone (D-008). |
| **Tenant isolation** | The guarantee that no project can read, write, or affect another project's data or resources. The #1 item in the priority stack (D-002). |

## Database terms

| Term | Meaning |
|---|---|
| **WAL (Write-Ahead Log)** | Postgres's append-only log of all changes, written before data pages. Basis of crash recovery, replication, PITR, and CDC. |
| **Logical replication / decoding** | Reading the WAL and decoding it into row-level change events (via a *replication slot*). How realtime CDC works — and why it's dangerous: an unconsumed slot pins WAL and can fill the primary's disk. |
| **Replication slot** | A server-side bookmark guaranteeing WAL retention until a consumer confirms receipt. Powerful; hazardous if the consumer stalls. |
| **PITR (Point-in-Time Recovery)** | Restoring a base backup and replaying archived WAL up to a chosen instant. |
| **Base backup** | A full physical copy of the data directory, the starting point for PITR. |
| **pgBackRest** | The backup tool Corebase standardizes on (D-019): base backups + WAL archiving to S3-compatible storage. |
| **RLS (Row-Level Security)** | Postgres feature attaching per-row `USING`/`WITH CHECK` predicates to tables per role/command. Corebase's authorization model: policies read the request's JWT claims from session context. |
| **`auth.uid()`** | Corebase-provided SQL helper returning the authenticated user's id from the request's session context; used inside RLS policies. Plain SQL — portable to any Postgres. |
| **Session context** | Request-scoped Postgres settings (`SET LOCAL request.jwt.claims = '...'`) carrying identity into the database so RLS can see it. `SET LOCAL` scopes to the transaction — the only pattern that survives transaction pooling. |
| **Shadow database** | A scratch database used to compute migration diffs by applying migrations fresh and comparing schemas. Basis of `db diff` (V1.1, D-028). |

## Connection & API terms

| Term | Meaning |
|---|---|
| **PgBouncer** | Lightweight Postgres connection pooler. Corebase runs one per project (D-015). |
| **Pooling modes** | *Session*: one client ↔ one server connection for the session (safe, no multiplexing). *Transaction*: server connection borrowed per transaction (multiplexes well; breaks prepared statements, `SET`, advisory locks across transactions). *Statement*: per-statement (breaks transactions; unused). |
| **PostgREST** | OSS server that introspects a Postgres schema and serves it as a REST API; enforces auth by switching database roles per request and letting RLS do authorization. Embedded per project (D-011). |
| **anon key / service_role key** | The two project API keys (D-029): long-lived JWTs mapping to the `anon` (public, RLS-restricted) and `service_role` (bypasses RLS; server-side only) Postgres roles. |
| **JWKS** | JSON Web Key Set — the published public keys (per project) that data-plane services use to verify JWTs. Enables key rotation via `kid`. |
| **Refresh-token rotation / reuse detection** | Each refresh issues a new refresh token and invalidates the old; presenting an already-used token signals theft and revokes the whole session family. |
| **Idempotency key** | Client- or system-supplied unique key ensuring an operation (job, API call) executes at most once even when retried. |
| **Cursor pagination** | Pagination via an opaque `after` cursor rather than offsets; stable under concurrent writes. Control-plane API standard (D-039). |

## Infrastructure terms

| Term | Meaning |
|---|---|
| **cgroups** | Linux kernel resource limits (CPU, memory, IO) applied per container — the enforcement mechanism for project resource caps on shared nodes. |
| **Envelope encryption** | Encrypting data with a data key, and the data key with a master key (KMS). Corebase's secrets pattern (D-035). |
| **IaC** | Infrastructure as Code — Terraform + cloud-init here (D-022). |
| **CDC (Change Data Capture)** | Streaming row-level database changes to consumers; the WAL-based flavor of realtime. |
| **Fan-out** | Delivering one event to N subscribed connections (realtime's scaling problem). |
| **Break-glass** | Audited, time-boxed emergency access procedure for operators to reach customer infrastructure. |
| **SNI routing** | Routing TLS connections by the hostname in the TLS handshake — how `<project>.corebase.co` reaches the right backend without per-project certs. |

## Dependencies

- Consumed by: all docs. Terms introduced by later docs should be added here.
