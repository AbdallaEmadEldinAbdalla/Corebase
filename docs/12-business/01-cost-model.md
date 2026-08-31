# Cost Model

## Purpose

The first-pass unit-economics math the v0.1 proposal deferred (§52: "exact numbers after infrastructure cost modeling") and the critical review flagged as the single biggest gap (§2.1). This doc answers: what does a free project cost per month, paused and active? How many projects fit on a node? At what scale does revenue cover infrastructure? What breaks the model?

**Every number in this doc is an assumption to re-verify against live quotes before launch.** Prices are 2025/2026-era ballparks; the *structure* of the math is the deliverable, the constants are placeholders. This model is what makes lane 3 (economics, D-006) a claim we can defend rather than a slogan.

## Design

### A. Input assumptions (all provisional — re-verify at purchase time)

> **Launch-SKU note (D-140/OQ-140):** the scenarios below price data nodes as Hetzner **AX52 dedicated ~€64/mo** — but the **locked launch SKU is CCX43 cloud + 1 TB volume ≈ €146/node** (D-140). AX dedicated is the *deferred* cheaper path (OQ-140: trigger ≥6 data nodes or compute >40% of COGS). Until the scenarios are re-based, their €-figures are **optimistic by ~2.3× on data-node compute**, and the D-090 guardrails derived from them are provisional accordingly.

#### A.1 Compute prices

| Item | Assumed price | Basis / note |
|---|---|---|
| Hetzner AX52 dedicated (8c/16t Ryzen, **64 GB** DDR5, 2×1 TB NVMe) | **~€64/mo** | ASSUMPTION; 2025-era list price ± setup fee, per D-023 |
| Hetzner AX102 dedicated (16c/32t, **128 GB**, 2×1.92 TB NVMe) | **~€116/mo** | ASSUMPTION; the "big node" option |
| Hetzner EX44 dedicated (i5, 64 GB, 2×512 GB NVMe) | **~€44/mo** | ASSUMPTION; cheapest viable 64 GB box |
| Hetzner cloud VM CPX41 (8 vCPU, 16 GB) | **~€30/mo** | ASSUMPTION; control-plane / monitoring nodes |
| Hetzner cloud VM CPX31 (4 vCPU, 8 GB) | **~€17/mo** | ASSUMPTION |
| Reference: AWS r6i.2xlarge (8 vCPU, 64 GB), on-demand | **~$340/mo** | ASSUMPTION; ~5× Hetzner for the same RAM — this gap *is* lane 3 |

#### A.2 Per-project RAM budget (active, container-per-project per D-009)

| Component | Assumed idle RSS | Note |
|---|---|---|
| PostgreSQL 17, tuned small (`shared_buffers` 128 MB, low `max_connections`) | **150–300 MB** | ASSUMPTION; grows with connections, extensions, cache pressure |
| PgBouncer (transaction mode, D-015) | **~15 MB** | ASSUMPTION |
| PostgREST (per project, D-011) | **~60 MB** | ASSUMPTION; JVM-free Haskell binary, stable RSS |
| Container/cgroup overhead | ~10–25 MB | ASSUMPTION |
| **Total per ACTIVE project** | **~250–400 MB** | **Planning number: 350 MB** |

A **paused** project (D-008) is a stopped container: **~0 MB RAM, ~0 CPU**. Its residual cost is disk (volume retained) + backup objects in R2 + a row in the control plane. ASSUMPTION: residual ≈ 0.5–2 GB NVMe + ~0.2–1 GB R2 ≈ **€0.01–0.04/mo**.

#### A.3 Density per node

| Quantity | Value | Derivation |
|---|---|---|
| Usable RAM on a 64 GB node | ~56 GB | ASSUMPTION: reserve ~8 GB for OS, Docker, node agent, monitoring, page-cache headroom |
| Active projects per 64 GB node | **~120–180** | 56 GB ÷ 350 MB ≈ 160; range covers 300–450 MB actuals. **Planning number: 150** — the *per-node design max* at D-090's 85% placement stop; fleet-wide the D-148 75% reserved-RAM ceiling makes **~135–140 active/node** the fleet-planning average (D-174) |
| Pause rate on mature free fleet | **80–90%** | ASSUMPTION; industry-typical for free tiers (Supabase pauses at 7 days inactivity; most free projects are experiments). **Planning number: 85%** |
| **Total projects per node (free-dominated fleet)** | **~750–1,200** (hard cap 1,200, D-090) | 150 active slots ÷ (1 − pause rate). At 85% paused: 150 ÷ 0.15 = **1,000**; the raw formula exceeds the cap at >87.5% paused, and the D-090 cap binds first. The pause multiplier is **×5–10** on effective density |
| Disk check | Not binding | 1,000 free projects × ≤500 MB DB cap, realistic average ~100 MB ⇒ ~100 GB of 2 TB NVMe. RAM binds first |

**This multiplier is the whole model.** Without pause/resume (D-008), a 64 GB node hosts ~150 free projects; with it, ~1,000. That is the difference between a free tier that costs €0.45/project and one that costs €0.06/project.

#### A.4 Storage, bandwidth, fixed base

| Item | Assumed price | Note |
|---|---|---|
| Cloudflare R2 storage | **~$0.015/GB-mo** | ASSUMPTION; per D-017 |
| R2 egress | **$0** | The structural margin protector: file downloads (the classic BaaS bandwidth killer) cost nothing at the storage layer |
| R2 operations | ~$4.50/M writes, ~$0.36/M reads | ASSUMPTION; negligible until high scale |
| Hetzner dedicated bandwidth | ~unmetered 1 Gbit (fair use) | ASSUMPTION; API/DB egress effectively free vs AWS's ~$0.09/GB. Fair-use limits are a sensitivity item (§E) |
| Backups (pgBackRest → R2, D-019) | included in R2 storage line | ASSUMPTION: compressed base + WAL ≈ 0.5–2× DB size |
| **Control-plane fixed base** | **~€120–150/mo** | ASSUMPTION: 2–3 cloud VMs (control-plane API+DB, monitoring/Grafana/Loki node, gateway/LB) + DNS + snapshots |
| Misc fixed (email provider, domains, error tracking) | ~€30–60/mo | ASSUMPTION; email costs detailed in [email infrastructure](../05-auth/04-email-infrastructure.md) |

### B. Modeled scenarios

Shared assumptions: Pro ≈ **$25/mo ≈ €23** (see [pricing](02-pricing-and-plans.md)), Team ≈ **$99/mo ≈ €91**; paid projects never pause and get a larger RAM budget (ASSUMPTION: ~1 GB reserved each); EUR/USD ≈ 1.08. All figures monthly.

#### Scenario 1 — 100 projects (launch; ~97 free, 3 Pro)

Early fleets pause less (everything is new): ASSUMPTION 60% paused ⇒ ~42 active. One 64 GB node holds everything. *(Data-node line priced at AX52; ~€146 at the locked CCX43 launch SKU — see the launch-SKU note in §A.)*

| Line | Cost |
|---|---|
| 1× data node (AX52) | €64 |
| Control-plane fixed base | €130 |
| R2 (storage + backups, ~50 GB) | €5 |
| Email + misc fixed | €40 |
| **Total infra** | **~€240** |
| Revenue (3 × Pro) | ~€70 |
| **Net** | **−€170/mo** (expected: fixed base dominates) |
| Cost per free project (blended) | ~€1.80 — *misleading*; marginal cost per free project is ~€0.10, the rest is fixed-base amortization |

Verdict: at launch the model is a fixed-cost story, not a unit-cost story. Total burn ~€240/mo is within proposal §118's "cheap" budget.

#### Scenario 2 — 1,000 projects (5% paid: 50 Pro, 950 free)

85% of free paused ⇒ ~143 active free + 50 paid ≈ **~195 active**. *(Data-node lines priced at AX52; ~2.3× at the locked CCX43 launch SKU — launch-SKU note, §A.)*

| Line | Cost |
|---|---|
| Data nodes: 2× AX52 (free fleet) + 1× AX52 (paid, lower density) | €192 |
| Control-plane fixed base (add gateway redundancy) | €160 |
| R2 (~1.5 TB storage + backups) | €22 |
| Email + misc | €55 |
| Headroom/buffer (~15%) | €65 |
| **Total infra** | **~€495** |
| Revenue (50 × €23) | **~€1,150** |
| **Gross margin on infra** | **~57%** |
| Cost per free project, blended (free-attributed ≈ €270 ÷ 950) | **~€0.28** |
| — paused free project (marginal) | **~€0.02–0.05** ✅ single-digit cents |
| — active free project (marginal) | **~€0.40–0.50** ✅ under the €0.50 target |

#### Scenario 3 — 10,000 projects (7% paid: 630 Pro + 70 Team, 9,300 free)

87% of free paused ⇒ ~1,210 active free + 700 paid ≈ **~1,900 active**. *(Data-node lines priced at AX-class dedicated; ~2.3× at the locked CCX43 launch SKU unless OQ-140's dedicated move has landed by this scale — launch-SKU note, §A.)*

| Line | Cost |
|---|---|
| Data nodes: ~13 for active load + paid RAM budgets + N+2 spare ⇒ **16× AX52/AX102 mix** | ~€1,150 |
| Control plane (HA API, bigger monitoring, staging) | €400 |
| R2 (~15 TB storage + backups) | €225 |
| Email (~significant MAU volume) | €150 |
| Bandwidth overages / LB | €100 |
| Buffer (~15%) | €300 |
| **Total infra** | **~€2,300–2,800; planning €2,600** |
| Revenue (630×€23 + 70×€91) | **~€20,900** |
| **Gross margin on infra** | **~87%** ✅ SaaS-grade |
| Cost per free project, blended (free share ≈ €1,200 ÷ 9,300) | **~€0.13** |
| — paused (≈8,090 projects) | **~€0.02–0.04** |
| — active free | **~€0.40–0.55** |

Note what these margins exclude: salaries, support time, Stripe fees (~3%), marketing. "Gross margin" here is strictly revenue vs infrastructure.

### C. Why this beats VM-per-project by ~an order of magnitude

| Model | Cost per free project (paused/active blend at 85% pause) | Basis |
|---|---|---|
| Smallest cloud VM per project (e.g. €4/mo instance) | **~€4.00** — VMs can't be "paused" free of charge; stopped instances still bill for reserved resources on most clouds | ASSUMPTION |
| Container-per-project, no pausing | ~€0.45 | 150/node on €64 hardware |
| **Container-per-project + pause/resume (Corebase, D-008/D-009)** | **~€0.06–0.13** | 1,000/node effective |
| Neon-style storage/compute split | comparable per-project (~cents idle) | but requires a custom storage engine — a 20-engineer problem ([competitive analysis](../00-foundation/02-competitive-analysis.md)) |

The pause/resume + container model captures **most of Neon's idle economics with none of the storage-engine engineering**. The cost: a cold-start on resume (target seconds, handled in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md)) — acceptable for a free tier, unacceptable for paid, which is why Pro projects never pause ([pricing](02-pricing-and-plans.md)).

### D. Where the margin actually comes from (rank order)

1. **Pause/resume** (×5–10 density) — D-008.
2. **Hetzner dedicated vs hyperscaler RAM** (~5× cheaper per GB) — D-023.
3. **R2 zero egress** — removes the classic BaaS margin killer entirely — D-017.
4. Container-per-project density vs VM-per-project (~×10 on its own) — D-009.

### E. Sensitivity analysis — what breaks the model

| Stress | Effect | Threshold where it hurts | Mitigation |
|---|---|---|---|
| **Low pause rate** | The dominant risk. At 50% paused (vs 85%), effective density drops 1,000 → 300/node; free-fleet node cost ~×3.3 | Pause rate < ~70% sustained | 7-day inactivity pause is enforced, not best-effort; monitor pause rate as a first-class metric; tune inactivity window before buying hardware |
| **RAM creep per project** | 350 → 500 MB cuts active density ~30% | avg RSS > ~450 MB | cgroup memory limits per container (D-009); conservative Postgres defaults; extension allowlist ([extensions](../03-database-platform/06-extensions-and-upgrades.md)) |
| **Storage-heavy tenants** | Free cap is 500 MB DB + 1 GB files, so bounded; risk is paid tenants at $0.015/GB COGS vs metered price | only if overage price < COGS (it isn't; see [pricing](02-pricing-and-plans.md)) | hard-stop free caps; overage pricing > COGS by design |
| **Egress abuse / fair use** | R2 egress is free to us, but Hetzner's unmetered bandwidth is fair-use; a tenant proxying video through PostgREST burns node bandwidth | sustained multi-TB per project | per-project egress caps ([abuse prevention](03-abuse-prevention.md)); serve files from R2 URLs, never proxied through nodes |
| **Conversion below plan** | Scenario 2 at 2% paid: revenue €460 vs €495 cost — breakeven-ish, not fatal (fixed base is small) | < ~2% sustained at 1k+ projects | free-tier quotas tight enough that real apps upgrade; see [pricing](02-pricing-and-plans.md) |
| **Node failure blast radius** | 1,000 projects per node = 1,000 angry users per dead disk | — | this is a durability/risk item, not a cost item: pgBackRest restore-to-new (D-019), N+2 spare capacity priced into Scenario 3, [risk register](../15-risks/01-risk-register.md) |
| **Hetzner price/availability shift** | whole model keyed to ~€1/GB-RAM-mo | dedicated RAM > ~€2.5/GB-mo | provider abstraction (D-023 keeps exit possible); model survives at OVH/other EU dedicated prices |

### F. Binding cost guardrails

These are operating rules, not aspirations. Breach ⇒ page/alert and a scheduled review.

| Guardrail | Threshold (provisional) |
|---|---|
| Blended infra cost per **paused** free project | ≤ **€0.05/mo** |
| Blended infra cost per **active** free project | ≤ **€0.50/mo** |
| Free-fleet total infra spend | ≤ **25% of MRR** once MRR > €2,000 (before that, absolute cap €400/mo on free-fleet-attributed spend) |
| Node RAM utilization alert | warn at **75%**, stop new placements at **85%** |
| Fleet pause-rate alert | investigate if **< 70%** for 14 days |
| Per-node project count | hard cap **1,200** regardless of RAM headroom (blast-radius bound) |

## Decisions

- **D-090 — Binding cost guardrails: blended infra cost per paused free project ≤ €0.05/mo and per active free project ≤ €0.50/mo; free-fleet spend ≤ 25% of MRR (absolute cap €400/mo pre-revenue); node placement stops at 85% RAM; per-node hard cap 1,200 projects; fleet pause rate < 70% for 14 days triggers review. All thresholds provisional until re-based on live prices.** *(Rationale: the critical review's §2.1 gap is only closed if the model produces enforceable numbers, not a one-time spreadsheet; these guardrails are what the control plane and monitoring actually alert on.)*
- **D-091 — The standard data-plane unit of scale is a 64 GB Hetzner dedicated node planned at 150 active / 1,000 total projects; per-project planning RAM budget is 350 MB active (Postgres + PgBouncer + PostgREST), ~0 paused.** *(Rationale: one node SKU keeps capacity planning, spares, and the provisioner's placement logic trivial for a 3-person team; the planning numbers are deliberately conservative within the 120–180 measured range and must be re-based on real fleet telemetry within 90 days of launch.)*

## Open Questions

- ***(first data: [M-001](../14-roadmap/05-measurements.md))* OQ-090:** Actual measured RSS of the tuned per-project stack (Postgres 17 + PgBouncer + PostgREST) under realistic idle and light load — the 350 MB planning number needs a benchmark before node purchase.
- **OQ-091:** Resume latency target and its cost: does sub-5-second resume require keeping page-cache-warm snapshots or pre-started shells, and what does that do to effective density? (Owned jointly with [postgres provisioning](../03-database-platform/01-postgres-provisioning.md).)
- **OQ-092:** Hetzner fair-use bandwidth reality: at what sustained per-node egress do we get throttled or a call from Hetzner, and does that force a CDN-in-front-of-API posture earlier than planned?

## Dependencies

- Builds on: [../00-foundation/02-competitive-analysis.md](../00-foundation/02-competitive-analysis.md) (lane 3, D-006/D-008), [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md) (§2.1), [../01-architecture/03-multi-tenancy-and-isolation.md](../01-architecture/03-multi-tenancy-and-isolation.md) (D-009), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md), [../11-infrastructure/01-infra-phases.md](../11-infrastructure/01-infra-phases.md) (D-023), [../07-storage/01-storage-architecture.md](../07-storage/01-storage-architecture.md) (D-017)
- Feeds: [02-pricing-and-plans.md](02-pricing-and-plans.md) (quotas and overage prices must clear these COGS numbers), [03-abuse-prevention.md](03-abuse-prevention.md) (quotas as abuse ceilings), [../14-roadmap/01-phase-plan.md](../14-roadmap/01-phase-plan.md), [../15-risks/01-risk-register.md](../15-risks/01-risk-register.md)
