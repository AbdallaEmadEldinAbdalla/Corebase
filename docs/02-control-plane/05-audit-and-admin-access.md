# Audit & Admin Access

## Purpose

Two intertwined guarantees (proposal §59, §65–66): every consequential action on the platform leaves an immutable record, and no Steadhold operator has standing access to customer databases. The first makes the second verifiable. Covers the audit event catalog, what gets recorded, retention and tamper-resistance, the JIT operator-access flow, break-glass, and the customer-facing audit surface. The `audit_logs` table itself is defined in the [data model](01-data-model.md).

## Design

### Audit event catalog

Actions are dot-namespaced `resource.verb` strings. The catalog is a versioned constant in code (`packages/types`); events outside it fail CI, not runtime. V1 catalog:

| Namespace | Events | Actor is usually |
|---|---|---|
| `org` | `org.created`, `org.renamed`, `org.deleted` | user |
| `member` | `member.invited`, `member.invite_revoked`, `member.joined`, `member.role_changed`, `member.removed` | user |
| `project` | `project.created`, `project.renamed`, `project.paused`, `project.resumed`, `project.deleted` (soft), `project.restored`, `project.purged`, `project.provision_failed`, `project.retried` | user / system |
| `database` | `database.reset`, `database.credentials_rotated`, `database.pg_version_upgraded` | user / system |
| `api_key` | `api_key.created`, `api_key.rotated`, `api_key.revoked` | user |
| `secret` | `secret.created`, `secret.updated`, `secret.deleted` | user |
| `backup` | `backup.created`, `backup.restored`, `backup.restore_verified`, `backup.deleted` | system / user |
| `auth` (platform accounts) | `auth.login`, `auth.login_failed`, `auth.password_changed`, `auth.password_reset_requested`, `auth.pat_created`, `auth.pat_revoked`, `auth.session_revoked` | user |
| `billing` | `billing.plan_changed`, `billing.payment_failed`, `billing.subscription_canceled` | user / system |
| `job` | `job.dead_lettered`, `job.operator_retried`, `job.operator_aborted` | system / operator |
| `admin` | `admin.access_requested`, `admin.access_granted`, `admin.access_denied`, `admin.access_revoked`, `admin.access_expired`, `admin.breakglass_used`, `admin.impersonation_started`, `admin.impersonation_ended` | operator |

Data-plane traffic (customer app requests) is **not** audit — that is request logging ([observability](../11-infrastructure/03-observability.md)). Audit records *control* actions: things a person or the platform decided.

### What gets recorded

Every row (schema in [data model](01-data-model.md)):

| Field | Content | Rules |
|---|---|---|
| `actor_user_id` + `actor_type` | Who: platform user, `system` (scheduler/reconciler), `operator` (staff), `api_key` (PAT) | System events carry the job id in metadata |
| `action`, `resource_type`, `resource_id` | What, on what | Resource ids are copied strings, not FKs — audit outlives its subjects |
| `metadata` | Before/after diff for mutations | **Secrets never appear**: secret events record the name and key_version only; key events record the prefix only; password fields are structurally excluded by a redaction layer that runs *before* insert (allowlist of loggable fields per event type — not a blocklist) |
| `ip`, `request_id` | Where from, correlated to logs and support via D-032 | |
| `created_at`, `id` (monotonic bigint) | When, in insertion order | Gaps in `id` are a tamper signal |

Writes happen in the same transaction as the mutation they record wherever possible (API-path events); worker events insert at step completion. An audit insert failure fails the mutation — a change that can't be recorded doesn't happen.

### Tamper-resistance and retention

- **Append-only at the database layer**: the application role has `INSERT, SELECT` only; `UPDATE, DELETE, TRUNCATE` are revoked from all non-superuser roles (DDL in [data model](01-data-model.md)). No code path can rewrite history, including compromised application code.
- The control-plane DB superuser is not used by any service; access to it is itself JIT-gated (below) — the audit trail's integrity assumptions are the same as the customer-data assumptions.
- Nightly, audit rows are exported (append-only object-lock bucket on R2, D-023) so even control-plane DB compromise cannot silently erase them; the export job records row-count + max(id) checkpoints, making truncation detectable.
- **Retention**: hot in Postgres 13 months (covers "what changed last year" support cases), then archived in object storage; archive retention 3 years in V1 (revisit for compliance tiers at enterprise time, D-003). Deleting a project or org does **not** delete its audit rows.

### Operator access model: no standing access

Baseline (§66): **zero** standing operator access to customer databases, customer containers, or plaintext secrets. Not "restricted" — none. Dashboards, metrics, and logs (which exclude row data) cover routine operations; anything more requires JIT.

#### JIT access flow

```text
1. REQUEST   Operator (is_staff, MFA-authenticated) requests access via the admin surface:
             target (project ref / node), access level, duration (≤ 60 min, default 15),
             and a REASON — free text plus a required link (ticket, incident, alert id).
2. APPROVE   A second operator approves (four-eyes). Solo-founder reality: while the team
             is < 3 operators, approval falls back to a mandatory 10-minute delay +
             notification to all operators — still recorded as `admin.access_granted`
             with approver = 'delay-fallback'.
3. ISSUE     The control plane mints a time-boxed credential scoped to the target:
             - customer DB: an ephemeral Postgres role (random name/password,
               VALID UNTIL <expiry>) created via the node agent; read-only unless the
               request explicitly asked for write, which requires a stated reason and
               is flagged in the grant event
             - node: short-lived SSH certificate (principals = that node, TTL = grant)
             Credential is displayed once; never stored.
4. USE       All queries through the JIT role run with log_statement=all on that role;
             session logs ship to the audit export bucket, linked to the grant id.
5. REVOKE    At expiry the role is dropped / cert expires — automatic, no human step.
             Early revocation available to any operator and to the customer's org owners.
6. RECORD    Events: admin.access_requested → granted/denied → expired/revoked.
             The grant (who, why, target, scope, duration, ticket link) is visible to
             the CUSTOMER in their project audit log — access is never invisible.
```

#### Break-glass

For emergencies where the JIT machinery itself is down or too slow (control-plane outage, active data-loss incident):

- A sealed break-glass credential per environment (root SSH cert + control-plane DB superuser) lives in the secret manager under a separate policy requiring two named founders' keys to unseal.
- Unsealing fires an immediate, unsuppressable alert to every operator and writes `admin.breakglass_used` through an out-of-band path (direct insert to the audit export bucket if Postgres is unreachable).
- Mandatory postmortem within 72 hours, published internally; the credential is rotated immediately after use, every use, no exceptions.
- Break-glass use during a customer-affecting incident is disclosed to affected customers in the incident report.

#### Dashboard impersonation

Support sometimes needs to *see what the customer sees*. Impersonation is read-only rendering of the customer's dashboard, requires the same JIT request flow, is banner-labeled in the operator's UI, emits `admin.impersonation_started/ended`, and is visible in the customer's audit log. It never grants data-plane access.

### What the customer sees

The dashboard's audit page (and `GET /v1/orgs/:org_id/audit-logs`, [platform API](02-platform-api.md)) shows the org's own trail: all `org/member/project/database/api_key/secret/backup/billing` events, plus — deliberately — `admin.*` events targeting their projects. Filterable by action, actor, project, time range; cursor-paginated; exportable as NDJSON. Customers do **not** see `job.*` internals or other tenants' anything. Showing customers our own access grants is the enforcement mechanism of the no-standing-access promise: a promise the customer can't check is marketing.

## Decisions

- **D-069 — Operator access is JIT-only: no standing credentials to customer databases, containers, or plaintext secrets; grants are reason-and-ticket-bound, four-eyes approved (10-minute-delay fallback below 3 operators), time-boxed ≤ 60 minutes via ephemeral Postgres roles / short-lived SSH certs, auto-revoked, session-logged, and every grant is visible in the affected customer's own audit log. Break-glass requires dual-founder unseal, alerts everyone, and forces rotation + postmortem.** *(Rationale: §66 made the promise; this makes it mechanical and — via customer-visible grant events — verifiable. Standing access is the root cause of most insider incidents and the thing enterprise security reviews ask about first.)*

Design rules carried without their own D numbers (enforced by the [data-model DDL](01-data-model.md) and CI): `audit_logs` is append-only by grants, written in-transaction with the mutation it records (audit failure fails the action), field-allowlisted so secrets are structurally unloggable, exported nightly to an object-locked bucket, and retained 13 months hot / 3 years archived, surviving org and project deletion.

## Open Questions

- OQ-046: Customer audit export — is dashboard NDJSON download enough for V1, or do early customers need streaming (webhook/S3 push) for their SIEMs? Deferred until asked twice; revisit with [post-V1 roadmap](../14-roadmap/03-post-v1-roadmap.md).
- OQ-047: JIT ephemeral-role mechanics on a *paused* project (no running container to create a role in): does support access force a resume (customer-visible, correct?) or operate on the volume offline (more powerful, scarier)? Needs resolution alongside [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) pause internals.
- OQ-048: Where the JIT approval surface lives — the admin area of the main dashboard vs a separate operator tool. A separate tool is cleaner isolation but a second app to secure; decide with [repo & service layout](../01-architecture/05-repo-and-service-layout.md).

## Dependencies

- Builds on: [01-data-model.md](01-data-model.md), [02-platform-api.md](02-platform-api.md), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-023, D-032, D-035), [../06-security/01-threat-model.md](../06-security/01-threat-model.md)
- Feeds: [../06-security/04-platform-security.md](../06-security/04-platform-security.md), [../09-dashboard/01-dashboard-ia.md](../09-dashboard/01-dashboard-ia.md) (audit page), [04-job-queue-and-workers.md](04-job-queue-and-workers.md) (dead-letter operator actions are audited), [../11-infrastructure/04-disaster-recovery.md](../11-infrastructure/04-disaster-recovery.md) (break-glass in runbooks)
