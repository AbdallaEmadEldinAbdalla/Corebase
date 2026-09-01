# Risk Register

## Purpose

The ranked register of what can actually kill or badly wound Corebase — technical, economic, and organizational — each with likelihood, impact, the mitigation the corpus commits to, and the early-warning signal to watch. This re-ranks the proposal's §115 list: the proposal's instincts were right about *categories*; this register corrects the *ordering* (cost economics and auth complexity move up) and adds the organizational risks the proposal only gestured at (§116–117).

Scoring: likelihood and impact 1–5; exposure = L×I. Ranked by exposure, ties broken by irreversibility.

## Design

### Tier 1 — existential

| # | Risk | L | I | Exp | Mitigation (committed) | Early-warning signal |
|---|---|---|---|---|---|---|
| R-1 | **Cross-tenant data breach.** One project reads another's data — via API, SQL escape, or storage. Kills the company's reason to be trusted; likely unrecoverable pre-brand. | 2 | 5 | 10 | The whole of [06-security](../06-security/01-threat-model.md): per-project keypairs (D-014), container boundary + hardening (D-081), role restrictions (D-080), default-deny RLS (D-083), and the **release-blocking isolation suite** (D-084/D-085) | Any single isolation-suite failure, even "flaky"; any support ticket containing another tenant's data |
| R-2 | **Free-tier economics failure.** Idle-project cost eats the runway; the proposal never computed this ([critique §2.1](../00-foundation/03-critical-review.md)). | 3 | 5 | 15* | Pause/resume day one (D-008); cost guardrails (D-090: ≤€0.05 paused / ≤€0.50 active per free project); the [Milestone-0 retro](../14-roadmap/06-milestone-0-retro.md) has now run (D-169) and **refused** to bank the favourable first data as headroom (D-209) | Measured RSS > 400 MB/project — **floor now known: 102 MiB idle Postgres alone (M-001), and 8.7 MiB anon idle / 13.1 MiB under load per project at 100 co-resident (M-008), so this signal has a baseline at density**; pause rate <70%; free-fleet cost >25% of MRR (D-090). **New (M-008): watch cores, not only RAM** — at 100 projects with two client connections each, RAM was over-booked 27-fold while CPU sat at 82% of the node. The model books RAM; the resource that ran out first was CPU. |
| R-3 | **Customer data loss.** A project's data gone with no working restore. Durability is priority #2 (D-002). | 2 | 5 | 10 | Backups moved up to Phase 3 ([phase plan](../14-roadmap/01-phase-plan.md)); automated monthly restore verification (D-019); restore-to-new only; WAL-archive lag alerting | Restore-verification failure; WAL-archive lag alert; any manual "we'll fix the backup later" |
| R-4 | **Scope creep / building ahead of users** — the proposal's own §116 top business risk. A year of infrastructure, zero users. | 4 | 4 | 16* | The cut list + scope-change protocol (D-163); trigger-gated post-V1 releases (D-165); three-lane filter (D-006) | Any phase running >2× its intended size; features starting before the previous phase's exit criteria pass |

*R-2 and R-4 carry the highest exposure scores in the register — they are the two the team is most likely to actually commit, because both feel like progress while they happen.*

**Post-Milestone-0 note.** R-4 (building ahead of users) claimed its first scalp in the retro's favour: D-208 defers D-071's warm pool, because the cold create path already runs 18× inside its budget and building the optimisation anyway would have been exactly the "feels like progress" failure this row describes. R-2's exposure is deliberately unchanged despite favourable first data — see [the retro §3](../14-roadmap/06-milestone-0-retro.md), which explains why banking it would be the most expensive available mistake.

### Tier 2 — severe

| # | Risk | L | I | Exp | Mitigation | Early-warning signal |
|---|---|---|---|---|---|---|
| R-5 | **Auth vulnerability** (token forgery, reuse-detection gap, enumeration). Auth is a whole product ([critique §2.3](../00-foundation/03-critical-review.md)) and D-013 chose to build it. | 3 | 4 | 12 | Frozen V1 auth scope (D-013); GoTrue-mitigations checklist; flows specced with failure modes ([05-auth/03](../05-auth/03-flows.md)); external security review before launch (add to Phase 9) | Any internal CVE-class finding — which per D-013 also triggers the build-vs-adopt revisit |
| R-6 | **Provisioning corruption** — sagas half-applied, orphans, double-provisioning; erodes the core product promise. | **2** | 3 | **6** | Idempotent check-then-act steps + reconciliation (D-053); the kill matrix (T6) is **built and green at 11 kill points** ([M-003](../14-roadmap/05-measurements.md)), asserting zero duplicate containers, volumes, credentials or RAM bookings; the reconciliation sweep (T8) reports what it cannot safely repair ([M-005](../14-roadmap/05-measurements.md)) | Orphan-container alerts firing; provisioning-duration p99 drifting up; any kill-matrix scenario going red |
| R-7 | **Node loss with slow recovery** — a data node dies, hundreds of projects down for hours. | 3 | 4 | 12 | DR runbook + capacity-headroom rule ([disaster recovery](../11-infrastructure/04-disaster-recovery.md)); quarterly node-loss drill; RPO ≤ WAL-lag | Fleet utilization above the headroom rule; a drill that misses its RTO |
| R-8 | **Abuse wave** — phishing/spam/mining through free projects burns IP reputation, provider standing, and support time. | 4 | 3 | 12 | [Abuse prevention](../12-business/03-abuse-prevention.md): quotas as ceilings, email caps, friction ladder (D-096), enforcement ladder (D-097) | Email bounce/complaint-rate alerts; provider abuse notices; signup velocity anomalies |
| R-9 | **Operational overload of a tiny team** — pager + support + abuse desk + roadmap on 1–3 people (§117 optimism). | 4 | 3 | 12 | Automate-first ops (alert catalog with runbooks, automated restore checks, abuse triage automation); private beta sized to support capacity (OQ-161); honest launch gate (Phase 9) | On-call interruptions >n/week trend; support backlog age; runbook-less alerts firing |

### Tier 3 — significant

| # | Risk | L | I | Exp | Mitigation | Early-warning signal |
|---|---|---|---|---|---|---|
| R-10 | **PostgREST/embedded-component coupling** — upstream change or abandonment forces a fork or migration (D-011's cost). | 2 | 3 | 6 | Version pinning + fleet-staged upgrades ([release & versioning](../13-quality/02-release-and-versioning.md)); gateway owns the customer contract so the engine is swappable in principle | Upstream release cadence stalling; a needed fix rejected upstream |
| R-11 | **Provider concentration** — Hetzner/Cloudflare/R2 (D-023) each a single point of business failure (account suspension being the acute form). | 2 | 4 | 8 | Provider-abstraction interfaces (day one, per [infra phases](../11-infrastructure/01-infra-phases.md)); exit-cost analysis kept current; backups in a second location (DR doc); abuse prevention (R-8) is also account-standing protection | Any provider abuse notice; exit analysis older than 2 quarters |
| R-12 | **Density/noisy-neighbor failure** — co-tenants degrade each other; the economics model pushes density up against quality. | 3 | 3 | 9 | D-055 noisy-neighbor control set; placement stop at 85% RAM (D-090); per-project metrics for blame attribution ([observability](../11-infrastructure/03-observability.md)). **Unchanged by Milestone 0 on purpose:** 21 co-resident projects cannot show co-tenant page-cache or IO contention, and the per-project exporters that would attribute blame are unbuilt — D-209 blocks any density change until that measurement exists | Cross-project latency correlation on a node; support tickets clustering by node |
| R-13 | **Realtime WAL hazard** (post-V1) — replication slots filling customer disks ([critique §2.4](../00-foundation/03-critical-review.md)). | 3 | 4 | 12→post-V1 | Deferred (D-030); two-step ship order (D-166); slot kill switches specced in advance ([realtime architecture](../08-realtime/01-realtime-architecture.md)) | (When built) slot-lag alerts; any disk-usage alert on a CDC-enabled project |
| R-14 | **Migration/DDL foot-guns** — customers or the table editor corrupting schemas; drift between migrations and reality. | 3 | 2 | 6 | UI→SQL-with-preview rule ([table editor](../09-dashboard/02-table-editor.md)); destructive-statement guards ([sql editor](../09-dashboard/03-sql-editor.md)); drift stance in [migrations](../03-database-platform/04-migrations.md) | Support tickets about "push failed"; drift detections |
| R-15 | **Key/secret compromise of the control plane** — the crown jewels (threat-model boundary e). | 1 | 5 | 5 | Envelope encryption (D-035); least-privilege matrix (D-088 context); JIT operator access ([audit & admin](../02-control-plane/05-audit-and-admin-access.md)); KMS decision pending (OQ-087 — resolve before Phase 1 ends) | Any anomalous control-plane access; audit-log gaps |
| R-16 | **Competitive response** — an incumbent ships "pause-free tier + export" and blunts the lanes. | 3 | 2 | 6 | Lanes are compounding (economics + DX velocity + trust), not single features ([competitive analysis](../00-foundation/02-competitive-analysis.md)); speed of iteration is the real counter | Incumbent pricing/feature announcements matching the lanes |
| R-17 | **Naming/trademark problem** with "Corebase" (OQ-099). | 2 | 3 | 6 | Clearance search before public launch; brand assets kept swappable until then | Clearance search findings |

### Standing review

The register is reviewed at every phase boundary ([phase plan](../14-roadmap/01-phase-plan.md)) and after any Sev-1/Sev-2 incident; scores are re-graded and the Milestone-0/phase retros feed measured data into R-2, R-6, R-12.

**Milestone 0 review (complete).** R-6 re-graded 9 → 6 on built-and-green evidence. R-2 and R-12 held at 15 and 9 respectively, with the reasoning recorded in [the retro](../14-roadmap/06-milestone-0-retro.md) rather than left implicit: favourable measurements taken in the cheapest corner of the state space are not evidence about the expensive corners.

## Decisions

- **D-170 — The risk register is reviewed at every phase boundary and after every Sev-1/2 incident; R-1 (isolation) and R-3 (data loss) mitigations are never traded away, per the priority stack.** *(Rationale: D-002 made operational.)*
- **D-171 — An external security review of auth + the isolation boundary is a Phase-9 launch-gate item.** *(Rationale: R-1/R-5 are existential and self-review is structurally blind; this is the cheapest insurance available.)*

## Open Questions

- OQ-166: Security-review budget/vendor class (a proper pentest vs a focused review of auth+RLS) — decide in Phase 7 timeframe.
- OQ-167: Cyber-insurance — worth it pre-revenue?

## Dependencies

- Builds on: everything — the register is the corpus's integrator.
- Feeds: [open questions](02-open-questions.md), [phase plan](../14-roadmap/01-phase-plan.md) gates.
