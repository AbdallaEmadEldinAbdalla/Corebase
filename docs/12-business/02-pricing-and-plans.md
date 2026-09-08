# Pricing & Plans

## Purpose

Makes proposal §51–52 concrete: the plan ladder, the quotas, the overage model, and the metering architecture (§53) that feeds billing. Every quota and price below is **provisional** — stated now so the cost model, abuse controls, and metering pipeline have concrete numbers to design against, re-priced before public launch against the final [cost model](01-cost-model.md) constants.

The strategic constraint from [competitive analysis](../00-foundation/02-competitive-analysis.md) lane 5: incumbents meter 8+ dimensions and users hate it. Steadhold's pricing must be explainable in one screen. Transparency is a differentiator we choose on purpose, at the cost of some billing precision.

## Design

### A. The plan ladder (all numbers PROVISIONAL)

| Dimension | **Free** | **Pro ~$25/mo** | **Team ~$99+/mo** | **Enterprise (deferred)** |
|---|---|---|---|---|
| Projects | 2 | 10 | 25 | custom |
| Database size / project | 500 MB | 8 GB included, then metered | 8 GB included, then metered | custom |
| File storage / project | 1 GB | 100 GB included, then metered | 250 GB included, then metered | custom |
| Bandwidth (egress) / mo | 2 GB | 250 GB included, then metered | 1 TB included, then metered | custom |
| Monthly active auth users (MAU) | 10,000 | 100,000 included, then metered | 100,000 included, then metered | custom |
| Backups | PITR, 7-day window | PITR, 30-day window | PITR, 90-day window | custom |
| Idle pausing | **paused after 7 days inactivity** (D-008) | **never paused** | never paused | never paused |
| Org members | 2 | 5 | 15 included, then per-seat | custom, SSO/SAML |
| Environments | — | — | staging/prod project groups (per D-031 schema) | + preview envs later |
| Compute per project | shared baseline (cgroup-capped) | larger cgroup allocation | larger; dedicated node option later | dedicated |
| Support | community | email | priority email | SLA |
| Log retention | 1 day | 7 days | 30 days | custom |

Notes:
- **"No pausing" is the core Free→Pro conversion lever**, exactly as at Supabase — but Steadhold's version is honest: Free pausing is an economics requirement (D-008), and resume is one click / one API call. We do not delete paused free projects; we retain volumes and backups per D-038-style retention (limits on indefinite retention: OQ-094).
- Pro price anchors to Supabase's $25 deliberately (proposal-consistent, §112): the differentiation is lanes 1–3, not a price war.
- Team's job is "a real company uses this": environment groups, more seats, longer PITR — not more features.
- Enterprise is schema-modeled but not built or priced, per **D-003**.

### B. Overage model: exactly three metered dimensions

Pro and Team get **soft caps + metered overages** on exactly three dimensions:

| Metered dimension | Included (Pro) | Overage price (PROVISIONAL) | COGS check (vs [cost model](01-cost-model.md)) |
|---|---|---|---|
| 1. Database storage | 8 GB/project | ~$0.125/GB-mo | NVMe + backup COGS ≈ $0.02–0.04/GB-mo ⇒ healthy margin |
| 2. File storage **+ bandwidth** (one combined line) | 100 GB stored, 250 GB egress | ~$0.021/GB-mo stored; ~$0.03/GB egress | R2 ≈ $0.015/GB-mo, egress ≈ $0 (D-017) ⇒ egress is nearly pure margin *and* abuse brake |
| 3. Monthly active auth users | 100,000 | ~$0.003/MAU | marginal COGS ≈ email + rows ⇒ fine |

**Why only three, when incumbents meter 8+** (compute hours, realtime connections, realtime messages, function invocations, function duration, log ingest, image transforms, ...):

1. Each meter is a billing-pipeline surface, a dashboard surface, a support-ticket category, and a pricing-page paragraph. A 3-person team cannot afford eight of each.
2. The three chosen dimensions are the only ones that (a) scale roughly with customer value, (b) have real marginal COGS, and (c) users can predict. Compute is deliberately **not** metered: it's cgroup-capped per plan instead — you get a bigger slice on a higher plan, never a surprise compute bill.
3. Everything unmetered is either capped (compute, connections, projects, seats) or absorbed as margin (API request count). Predictability is lane-5 differentiation; precision-billing is the incumbents' game.
4. When realtime and functions ship post-V1 (D-030), the default is to fold them into caps-per-plan, **not** new meters. Adding a fourth meter requires overturning D-093.

### C. Free tier: hard stops, never bills

Free has **no payment method on file and no overage path — ever**:

| Cap hit | Behavior |
|---|---|
| DB size 500 MB | project becomes **read-only** (writes rejected with a clear error + dashboard banner + email); never deleted for size |
| File storage 1 GB | uploads rejected; existing files keep serving |
| Bandwidth 2 GB/mo | file egress throttled hard for the remainder of the month |
| MAU 10,000 | new signups rejected on the project's auth endpoint (existing users keep logging in) |
| 7 days no activity | project paused; instant self-serve resume |

A free user's worst possible month costs them **€0.00**. "Never a surprise bill" is a lane-3/lane-5 differentiator worth stating as a binding decision (D-094) — it also kills the entire category of stolen-card overage abuse on Free ([abuse prevention](03-abuse-prevention.md)).

Pro additionally ships with a **spend cap ON by default** (user-settable): overages accrue up to the cap, then soft-cap behavior (throttle/read-only) kicks in. Surprise bills require two explicit opt-ins (card + cap raise).

### D. Metering architecture (proposal §53 concretized)

```
data-plane services            control plane                     billing
────────────────────           ─────────────────────────────     ─────────────
gateway / storage API   ──►    usage_events (append-only)  ──►   daily rollups ──► usage_records ──► billing engine ──► Stripe
auth service            ──►         (Redis buffer,               (worker job,        (per project,      (invoice items,
node agent (samplers)   ──►          flushed to PG)               idempotent)         per dimension,     proration)
                                                                                      per day)
```

- **Services emit usage events; billing is never computed inside a service** (§53 adopted). Events carry `{project_id, dimension, quantity, occurred_at, idempotency_key}`.
- Rollup worker (BullMQ, D-018) aggregates events into daily `usage_records` rows in the control-plane DB ([data model](../02-control-plane/01-data-model.md) already reserves the table, §54). Rollups are idempotent and re-runnable.
- The billing engine reads **only** `usage_records`, compares against plan quotas, and pushes overage line items to **Stripe** (metered billing / invoice items). Stripe is processor and invoice ledger; Steadhold's `usage_records` is the source of truth for *quantities*, Stripe for *money*.
- Enforcement (caps, throttles, pauses) reads the same rollups plus near-real-time Redis counters for the fast paths (bandwidth throttle, MAU gate) — enforcement must not wait for a daily rollup.

#### What is measured, and how

| Dimension | Mechanism | Sampling |
|---|---|---|
| Database size | `pg_database_size()` via node agent | sampled every ~6 h; billed on daily max (PROVISIONAL) |
| File storage | bucket accounting: `storage.objects` metadata sums (D-017), reconciled weekly against R2 inventory | continuous + weekly reconcile |
| File bandwidth | storage API / gateway egress counters per project | streamed, rolled up daily |
| MAU | distinct users with ≥1 authenticated event per calendar month, from auth-service events | rolled up daily, finalized monthly |
| (unbilled, quota-only) API requests, connections, CPU | gateway counters, cgroup stats | dashboards + abuse detection only |

### E. Grace and dunning (basics; details post-V1)

| Event | Behavior (PROVISIONAL) |
|---|---|
| Payment fails | retry via Stripe smart retries over **14 days**; email at fail, day 7, day 12 |
| Still failing, day 14 | plan downgraded to Free behavior: projects over Free quotas become read-only, pausing eligibility resumes. **Data is not deleted** |
| Cancel Pro | end-of-period downgrade; same read-only mechanics; export (`steadhold export`, D-004) always works, even read-only and even paused — portability applies most when someone leaves |
| Delete account | D-038-style soft delete + staged destruction |

Read-only-not-deleted plus always-available export is the enforcement stance everywhere: **we stop service growth, we do not hold data hostage.**

## Decisions

- **D-092 — Plan ladder is Free / Pro ~$25 / Team ~$99+ / Enterprise-deferred with the quota table in §A; Free pauses after 7 days idle, paid never pauses; all quotas and prices provisional until re-based on the final cost model.** *(Rationale: proposal §51–52 concretized; Pro price anchors to the incumbent to keep the fight on lanes 1–3; pause-exemption is the honest, mechanically-real Free→Pro upgrade trigger per D-008.)*
- **D-093 — Exactly three metered billing dimensions: database storage; file storage+bandwidth; MAU. Compute and everything else is plan-capped, never metered. Adding a meter requires superseding this decision.** *(Rationale: transparent pricing is declared lane-5 differentiation; every meter is pipeline + dashboard + support surface a 3-person team can't afford ×8; the three chosen are the only dimensions that are predictable to users and have real marginal COGS.)*
- **D-094 — The Free tier can never generate a bill: no payment method, no overages, hard-stops only (read-only / throttle / pause at cap), and data is never deleted for exceeding a cap. Pro ships with a default-on spend cap.** *(Rationale: "never a surprise bill" is a felt differentiator against every incumbent horror story, removes stolen-card overage abuse on Free, and costs only quota-enforcement code we need anyway.)*
- **D-095 — Metering pipeline: services emit idempotent usage events → control-plane `usage_records` daily rollups → billing engine → Stripe as processor. `usage_records` is the source of truth for quantities; billing logic never lives inside data-plane services.** *(Rationale: proposal §53 adopted with the source-of-truth boundary made explicit; Stripe buys tax/invoicing/dunning machinery that is negative-value to build.)*

## Open Questions

- **OQ-093:** Annual pricing (2 months free?) and regional pricing — decide before public launch, not before.
- **OQ-094:** Indefinite retention of paused Free projects vs a very long (12-month?) archive-to-R2-then-delete policy — pure cost is tiny (cost model §A.2) but not zero at 100k dead projects; needs a decision before 10k projects.
- **OQ-095:** Is 500 MB the right Free DB cap, or does 1 GB convert better without material COGS change? A/B-able post-launch; the cost model says the marginal cost difference is cents.

## Dependencies

- Builds on: [01-cost-model.md](01-cost-model.md) (every price must clear COGS + D-090 guardrails), [../00-foundation/02-competitive-analysis.md](../00-foundation/02-competitive-analysis.md) (lanes 3 & 5), [../02-control-plane/01-data-model.md](../02-control-plane/01-data-model.md) (`usage_records`, subscriptions), [../02-control-plane/04-job-queue-and-workers.md](../02-control-plane/04-job-queue-and-workers.md) (rollup workers), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md) (pause mechanics), [../05-auth/01-auth-architecture.md](../05-auth/01-auth-architecture.md) (MAU events)
- Feeds: [03-abuse-prevention.md](03-abuse-prevention.md) (quotas are the abuse ceiling; D-094 is a billing protection), [../09-dashboard/01-dashboard-ia.md](../09-dashboard/01-dashboard-ia.md) (usage/billing surfaces), [../14-roadmap/02-v1-scope-and-cutlist.md](../14-roadmap/02-v1-scope-and-cutlist.md)
