# Observability

## Purpose

Wire D-021 (OpenTelemetry SDK everywhere; Prometheus + Grafana + Loki self-hosted on `mon-1`) into a concrete design: what scrapes what, the metric inventory with an explicit cardinality budget (per-project labels are the thing that quietly kills a 10k-project Prometheus), where logs flow and how long they live, whether V1 ships traces, the dashboard and alert catalogs with thresholds, and the path by which *customers* see their own logs and metrics (proposal §37–38) without ever touching Loki or Prometheus directly.

## Design

### Metrics topology

Prometheus on `mon-1` ([infra phases](01-infra-phases.md), D-140) scrapes over the private network. Targets come from control-plane `http_sd` (the node registry and project placements are already the source of truth — no static scrape config to drift).

| Exporter | Where | What |
|---|---|---|
| node_exporter | every node | CPU, RAM, disk, filesystem (incl. XFS quota via textfile collector), network |
| cAdvisor | every node | **per-container CPU/RAM/IO/net — the per-project resource view**, keyed by the `project_ref` container label (D-054) |
| postgres_exporter | **one per data node, multi-target** | per-project DB internals: connections, TPS, cache hit, DB size, oldest xact, WAL position — probed per project container over the node-local Docker network |
| monolith `/metrics` | cp-1 | API/gateway/auth/storage request rates, latencies, error rates; routing-table freshness (D-051) |
| worker `/metrics` | cp-1 | queue depths, job durations/outcomes, reconcile-pass stats, drift-repair counts (D-053) |
| Redis/pgBouncer/pgBackRest | cp-1 / data nodes | queue + pool + backup/archive telemetry (pgBackRest via textfile collector from timer runs) |
| blackbox_exporter | mon-1 | external probes of `api.corebase.co`, a canary project's REST endpoint, cert expiry |

**Exporter-per-project vs multi-tenant collector — analyzed, picked (D-146).** A postgres_exporter sidecar per project would (a) make the tenant unit four containers, breaking D-054's triplet shape and every reconciler diff; (b) cost ~10–20 MB RSS × 200 active projects ≈ **2–4 GB/node of pure exporter overhead** — several paid projects' worth of density (D-002 ranks isolation over cost, but exporters aren't isolation: a read-only monitoring role gains nothing from a per-tenant process); (c) multiply scrape-config churn by project count. Instead: **one postgres_exporter per data node in multi-target mode**, target list = that node's placements from `http_sd`, connecting as a per-project `corebase_monitor` role (read-only, `pg_monitor`, created at provision time — added to the base-schema template in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md)). Blast radius accepted: one exporter crash loses *metrics* for one node's projects, never the projects.

### Metric inventory and the cardinality budget

**The warning first:** `project_ref` at 10k projects is a ×10,000 multiplier on anything it touches. A per-project HTTP latency histogram (12 buckets × 5 routes × 10k) is 600k series from one metric family — that alone can sink a single-node Prometheus. The budget (D-146): **per-project series are capped at ~25 per project** (~250k series at 10k projects — comfortable for one Prometheus with 15s/60s intervals), and `project_ref` may **never** co-exist with high-cardinality labels (route, status code, bucket `le`) except on the two coarse histograms noted below at reduced bucket counts.

| Metric (family) | Labels | Per-project? | Notes |
|---|---|---|---|
| `container_cpu/memory/io/net_*` (cAdvisor) | node, project_ref, container | ✅ (~10 series) | the noisy-neighbor view (D-055) |
| `pg_up`, `pg_stat_database_*` (conns, TPS, size), WAL lsn | node, project_ref | ✅ (~8) | drives disk ladder + WAL-lag alerts |
| `corebase_project_disk_used_ratio` | node, project_ref | ✅ (1) | XFS quota textfile; feeds D-073 ladder |
| `corebase_gateway_requests_total` | project_ref, plane (rest/auth/storage) | ✅ (3) | **counter only** — no route, no status detail per project; 2xx/4xx/5xx as 3 sub-counters |
| `corebase_gateway_request_seconds` (histogram) | plane only — **no project_ref** | ❌ | platform latency is fleet-level; per-project latency questions go to logs |
| `corebase_provisioning_job_seconds` (histogram) | job_type, outcome | ❌ | provisioning funnel percentiles |
| `corebase_reconcile_{drift_repairs,pass_seconds}` | node, action | ❌ | D-053 health |
| `corebase_backup_{last_success_ts,wal_archive_lag_seconds,check_ok,wal_pending_segments}` | node, project_ref | ✅ (4) | pages (below). `check_ok` is a second, independent signal: a project can have nothing waiting and a repo whose credentials expired last week |
| `corebase_node_{ram,disk}_reserved_ratio` | node | ❌ | bin-packing / headroom (D-148) |
| API/worker internals (event loop lag, pool waits, Redis) | service | ❌ | standard runtime SLIs |

**Mitigations, standing:** recording rules pre-aggregate the per-project families into fleet/node rollups (dashboards query rollups; raw per-project series are only touched by the drill-down and the scoped customer API); per-project series use 60s scrape where 15s buys nothing (DB size, disk ratio); paused projects export nothing (their exporter targets drop out of `http_sd`, which is also the cheapest "is the pause economics working" signal). Growth path past ~10–20k projects: Prometheus per shard or Mimir — a Phase B concern, noted not built.

### Logs

**Shipper:** Grafana **Alloy** per node (promtail's successor; one binary that can also carry OTel later) tailing Docker json-file logs. Docker labels map to Loki labels: `{node, service}` for platform containers, `{node, project_ref, container}` for tenant containers. Label discipline mirrors metrics: labels are only `node/service/project_ref/container/level` — request IDs, routes, user IDs live in the log *line* (JSON), found by Loki filters, never by labels.

- **Platform logs** (monolith, worker, Caddy, SNI router, reconciler actions): structured JSON, one line per request per §38 (`request_id, project_ref, method, path, status, duration` — never bodies, never tokens/keys; a redaction test in CI greps sampled log output for secret shapes).
- **Per-project Postgres logs**: `log_line_prefix = '%m [%p] %q%u@%d '` plus the container's `project_ref` label carrying project context (the prefix needs no ref — the label has it); `log_min_duration_statement` per plan tier; statements themselves are customer data — retained short and surfaced only to the project's own dashboard.
- **PostgREST/pgBouncer per project**: same label pattern.

**Retention (D-147):** platform logs **30 days** in Loki (R2 backend for chunks — cheap, zero egress D-017); per-project customer-visible logs **1 day Free / 7 days Pro / 30 days Team** (the Team tier added with the pricing ladder — refines D-147) enforced by Loki retention streams on plan-tier label; audit events are *not* Loki's job — they live in control-plane Postgres per [audit & admin access](../02-control-plane/05-audit-and-admin-access.md).

### Traces

**Decision (D-147): no trace backend in V1.** The OTel SDK is wired into API/worker/gateway from day one (D-021: instrumentation is cheap now, retrofit is expensive), context propagates (`traceparent`, and `request_id` = trace ID), but the exporter ships spans nowhere; slow-request forensics ride structured logs joined on `request_id`, which Loki serves adequately at V1 traffic. **Tempo turns on in V1.1** (single binary, R2 backend, tail-sampled ~1–5%) — trigger: first week where a latency investigation takes >1 day for want of traces. Deciding "yes SDK, no backend" now prevents both the V1 ops tax and the V2 instrumentation rewrite.

### Dashboards inventory (Grafana, provisioned as code in the monitoring TF module)

| Dashboard | Contents |
|---|---|
| Fleet overview | nodes up, total/active/paused projects, fleet request rate + error %, queue depths, open alerts |
| Node capacity & bin-packing | per node: RAM/disk **reserved vs actual** ratios, fill line vs D-090's 0.85 placement stop, headroom vs the D-148 75% rule, warm-pool level |
| Per-project drill-down | templated on `project_ref`: cAdvisor set, pg internals, disk ladder position, request counters, recent logs panel |
| Control-plane SLIs | API latency/error rate, routing-table staleness, Redis health, control-PG health, auth token issuance |
| Provisioning funnel | create→READY duration percentiles (target p50 ~1–3s warm, D-071), warm-pool claims vs cold path, resume p50/p95 vs D-072 targets, stuck jobs |
| Backups & DR readiness | per-project last-success age, WAL archive lag heatmap, restore-verification pass rate ([backups & PITR](../03-database-platform/05-backups-and-pitr.md)), second-copy sync age (D-149) |
| Deploy | release manifest version per node, health-gate history ([IaC & CI/CD](02-iac-and-cicd.md)) |

### Alert catalog (Alertmanager)

Routing: **page** = phone/push via on-call app + Slack; **warn** = Slack only; **ticket** = daily digest. Delivery vendor undecided (OQ-146). Thresholds provisional until 3 months of baselines.

| Alert | Threshold | Severity |
|---|---|---|
| Node down (no scrapes) | 2 min | **page** |
| Node RAM reserved ratio | >85% warn (bin-packer ceiling breached = accounting bug) | warn→page at 95% |
| Node volume usage | >75% warn; >85% (auto-cordon fired, D-073) | **page** |
| Project disk 80/90/95% | ladder events (D-073) — 80/90 ticket; 95 (soft read-only applied) warn | ticket/warn |
| Backup failure | any project base-backup failure, or last-success age >26h | **page** (D-019: untested/absent backups are fiction) |
| WAL archive lag | >5 min warn (RPO promise, D-148); >15 min **page**. **Lag is the age of the oldest WAL segment closed but not yet archived** (D-271) — *not* time since the last successful archive, which `archive_timeout=300` would peg at the warn line for every healthy idle Free project | warn/page |
| Restore-verification failure | any (continuous sampling run, D-176) | **page** |
| **Isolation-suite failure** | any (D-085) | **page, Sev-1, freezes releases** |
| Provisioning job stuck | any job >10 min in non-terminal state; queue depth >50 for 10 min | **page** / warn |
| Control-plane API error rate | 5xx >1% of requests over 5 min; or p95 >1s over 15 min | **page** / warn |
| Gateway routing staleness | full-refresh age >15 min (D-051 degraded) | warn |
| Cert expiry | origin or SNI-router certs <14 days | warn; <7 days page |
| Resume latency | p95 >15s over 1h (D-072 target broken) | warn |
| Redis down | 1 min (queue+limits+pubsub degrade, OQ-052) | **page** |
| mon-1 self-monitoring | dead-man's-switch: an always-firing alert whose *absence* at the receiver pages | **page** |

### Customer-facing observability

What surfaces in the dashboard (proposal §37, [dashboard IA](../09-dashboard/01-dashboard-ia.md)): **request logs** (API access lines + Postgres slow/error lines for their project), **DB size vs plan cap** (the D-073 ladder made visible), **connections** (current/limit), request counts and error rates, and backup last-success time. Not surfaced in V1: per-query stats, traces, raw resource metrics beyond CPU/RAM gauges.

**Customers never query Loki or Prometheus.** The path is a scoped control-plane API:

```text
GET /v1/projects/:ref/logs?source=api|db&since=…&until=…&q=…&cursor=…
GET /v1/projects/:ref/metrics?set=overview   (fixed, named series sets — not PromQL)
```

The monolith (a) authorizes dashboard session → project membership, (b) **injects `{project_ref="<ref>"}` as a server-side stream selector** — the customer's `q` is a substring/field filter *within* that stream, never a label selector, so cross-tenant reads are structurally impossible rather than filtered-out, (c) enforces plan retention windows, result caps (1k lines/page), and per-project rate limits (D-033), (d) strips platform-internal fields before returning. Same pattern for metrics: named recording-rule series fetched by ref, no raw query language exposed. This is the observability twin of the RLS principle: scope enforced at the boundary, in one place ([tenant isolation tests](../06-security/03-tenant-isolation-tests.md) gets API-level cases asserting log/metric scoping).

### SLO starter set (internal only — no public SLA per proposal §68)

Measured from day one so V2's public SLA is a promotion of known numbers, not a guess. All targets provisional.

| SLI | Internal objective |
|---|---|
| Gateway availability (5xx-free rate, blackbox + served) | 99.9% monthly |
| Data API p95 latency (gateway→response, fleet) | <250 ms |
| Provisioning: create→READY p95 | <30 s (target p50 ~3 s warm) |
| Resume p95 | <15 s (D-072) |
| Control-plane API availability | 99.5% (deliberately looser — the D-051 split makes this survivable) |
| Backup success rate / restore-verification pass rate | 100% — every miss is investigated |
| WAL archive lag p99 | <5 min (the RPO in [disaster recovery](04-disaster-recovery.md)) |

## Decisions

- **D-146 — Metrics topology: node_exporter + cAdvisor + one multi-target postgres_exporter per node (per-project exporter sidecars rejected), targets served from control-plane `http_sd`; per-project cardinality budget ≤~25 series/project, `project_ref` never combined with route/status/bucket labels, per-project request metrics are coarse counters, fleet rollups via recording rules.** *(Rationale: exporter-per-project breaks the D-054 triplet shape and burns 2–4 GB RAM/node on non-isolation overhead; the label budget keeps 10k projects ≈ 250k series — inside single-node Prometheus headroom — while cAdvisor labels still deliver the per-project CPU/RAM/IO view the density model needs.)*
- **D-147 — Logs: Alloy per node → Loki on mon-1 (R2 chunk storage); labels restricted to node/service/project_ref/container/level; retention 30d platform, 1d Free / 7d Pro for customer-visible project logs. Traces: OTel SDK instrumented in API/worker/gateway from day one but no trace backend in V1 (spans unexported; request_id-joined logs carry forensics); Tempo in V1.1. Customers access logs/metrics only through the scoped `/v1/projects/:ref/logs|metrics` API with server-side stream injection — never Loki/PromQL.** *(Rationale: retention tiers cap Loki cost while making logs a plan feature; instrument-now-store-later avoids both the V1 Tempo ops tax and a V2 rewrite; boundary-enforced scoping makes cross-tenant log reads structurally impossible, mirroring the RLS design.)*
- Alert catalog and SLO starter set above are adopted as provisional baselines; threshold changes are ops-note-level, not new decisions.

## Open Questions

- **OQ-146** — Paging delivery: self-hosted (Alertmanager→Twilio/ntfy) vs a free-tier incident tool (e.g. Grafana OnCall OSS). Needs picking before first paying customer; owner: [disaster recovery](04-disaster-recovery.md) incident frame.
- **OQ-147** — `corebase_monitor` role: exact grants (pg_monitor + per-DB connect) and whether it appears in customer-visible `pg_stat_activity` output or is filtered from the dashboard connections view.
- **OQ-148** — mon-1 is a single point of *observability* failure (accepted — it observes, it doesn't serve). Do we want Prometheus remote_write of the alert-critical series to a tiny secondary (or Grafana Cloud free tier) so a mon-1 loss doesn't blind on-call during an unrelated incident?

## Dependencies

- Builds on: [01-infra-phases.md](01-infra-phases.md) (D-140 node roles), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-021), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md) (D-072/D-073 signals), [../03-database-platform/05-backups-and-pitr.md](../03-database-platform/05-backups-and-pitr.md) (D-019 verification), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md) (D-085 paging), [../06-security/04-platform-security.md](../06-security/04-platform-security.md) (redaction, rate limits)
- Feeds: [02-iac-and-cicd.md](02-iac-and-cicd.md) (deploy health gates), [04-disaster-recovery.md](04-disaster-recovery.md) (detection + RPO measurement), [../09-dashboard/01-dashboard-ia.md](../09-dashboard/01-dashboard-ia.md) (customer logs/metrics UI), [../12-business/02-pricing-and-plans.md](../12-business/02-pricing-and-plans.md) (retention tiers)
