# Abuse Prevention

## Purpose

Deepens proposal §50 from a checklist into an operating design. Steadhold hands strangers a Postgres instance, an email-sending signup endpoint, public file URLs, and a subdomain — for free. Every one of those is an abuse product with an existing criminal market. This doc enumerates the taxonomy, layers the controls, and defines the enforcement ladder — sized for the reality that a ~3-person team (proposal §117) runs the abuse desk in the margins of their week.

Design tension to hold: lane 1 ([competitive analysis](../00-foundation/02-competitive-analysis.md)) demands frictionless free signup; abuse control wants friction. The resolution is a **friction ladder**: everyone starts frictionless, friction escalates only on risk signals.

## Design

### A. Abuse taxonomy — what attackers actually do with a free BaaS

| # | Abuse | Mechanism on Steadhold | Who gets hurt | Severity |
|---|---|---|---|---|
| A1 | **Phishing hosting** | fake bank/login pages served from storage public URLs and `<project>.steadhold.app` subdomains | victims + **our domain reputation** (Safe-Browsing listing of `steadhold.app` breaks *every* customer) | Critical |
| A2 | **Spam via auth email — the big one** | attacker builds nothing: they script signups against *their own project's* auth endpoint with victim addresses; **our** email infra delivers "verification" spam from our IPs/domain | victims + shared email IP/domain reputation → everyone's verification emails hit spam | Critical |
| A3 | Crypto-mining in SQL | CPU burn via recursive CTEs, plv8/PL functions, `generate_series` loops | node CPU, co-tenants | Medium (bounded, see C2) |
| A4 | File-host abuse | free tier as a CDN for pirated/large files; hot-linking | storage + bandwidth cost, legal exposure | Medium |
| A5 | Botnet C2 / dead-drop | DB or storage bucket as command-and-control mailbox; low volume, looks like a normal app | platform reputation, LE requests | Medium (hard to detect) |
| A6 | Card testing | scripted card attempts against *our* Stripe checkout; or against a tenant's app (their problem, our IPs) | Stripe standing, fraud fees | High |
| A7 | Free-tier fleet farming | one actor, hundreds of accounts, 2 free projects each | economics (breaks [cost model](01-cost-model.md) assumptions) | Medium |
| A8 | Open-proxy / egress abuse | using DB functions or storage as a traffic relay | bandwidth, IP reputation | Low–Medium |

A1 and A2 are the two that can kill the platform in a week (domain blocklisting, email blocklisting). They get the automated controls first.

### B. Control layer 1 — signup friction ladder

Baseline (everyone): **email verification, always** — no project provisioning until verified. That's the entire friction for a clean signup; lane 1 survives.

Escalation is signal-driven, not universal:

| Risk signals (any scoring threshold, PROVISIONAL) | Added friction |
|---|---|
| Disposable-email domain (maintained blocklist), free-mail + suspicious pattern | — signal only, +score |
| IP reputation: VPN/Tor/datacenter ASN, prior-abuse IP/subnet | +score |
| Velocity: >N signups per IP/24 h, >M accounts per device fingerprint, burst patterns | +score |
| Payment signal: prepaid/virtual card at Pro checkout (Stripe Radar) | +score |
| **Score ≥ T1** | phone verification before provisioning |
| **Score ≥ T2** | card-on-file verification ($0 auth, no charge) before provisioning |
| **Score ≥ T3** | manual review queue; account held |

Signals and thresholds live in config, not code, and are tuned weekly at first. False-positive path: a held user can request review from the dashboard (feeds the ladder in §F).

### C. Control layer 2 — quotas as the primary abuse ceiling

The most reliable abuse control is the one that needs no detection: **the per-project resource cap already required by the plan structure**.

| Ceiling | Abuse it bounds | Source |
|---|---|---|
| C1: cgroup CPU/RAM per container (D-009) | A3 mining: a fractional-core cap makes mining revenue ≈ €0.00/day — below electricity. Mining doesn't need detection, only capping | [multi-tenancy](../01-architecture/03-multi-tenancy-and-isolation.md) |
| C2: statement timeout + connection caps per project | CTE burn, connection exhaustion | [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) |
| C3: Free storage 1 GB, bandwidth 2 GB/mo hard-stop (D-094) | A4 file hosting: a 2 GB/mo "CDN" is worthless | [pricing](02-pricing-and-plans.md) |
| C4: **per-project email caps** — Free: ~30 auth emails/hour, ~200/day (PROVISIONAL); recipient-level dedup (max ~3 verification emails per address per day, any project) | A2 spam: caps the blast radius of any single project to noise level | [email infrastructure](../05-auth/04-email-infrastructure.md) |
| C5: MAU cap (10k Free) + signup rate limits per project | A2, A6 | [pricing](02-pricing-and-plans.md), D-033 |
| C6: egress caps + files served from R2 URLs, never proxied through data nodes | A8, node fair-use protection (cost model §E) | [storage architecture](../07-storage/01-storage-architecture.md) |
| C7: API rate limiting IP→key→project (D-033) | scripted everything | [platform security](../06-security/04-platform-security.md) |
| C8: 2 free projects/account + friction ladder | A7 farming (bounds per-account damage; ladder bounds account count) | this doc |

Shared-IP email reputation deserves emphasis: **all tenants share Steadhold's sending domain and IPs.** One spamming project degrades deliverability for every project. Per-project caps (C4), per-recipient dedup, bounce/complaint feedback loops, and instant email-suspension on complaint spikes are specified in [email infrastructure](../05-auth/04-email-infrastructure.md); this doc owns the policy that email caps are **non-negotiable at every plan level** (paid raises the numbers, never removes the cap).

### D. Control layer 3 — automated detection

Detection catches what caps can't (A1, A5, and cap-adjacent behavior). All of it is batch/async — no ML, no real-time pipeline, just queries over data we already collect ([observability](../11-infrastructure/03-observability.md), usage events from [pricing §D](02-pricing-and-plans.md)):

| Detector | Signal | Action |
|---|---|---|
| Usage-pattern anomalies | project age < 24 h with max-rate signups; egress step-function; CPU pegged at cgroup cap for hours | flag → auto-throttle → review queue |
| Known-bad file hashes | hash uploads against known CSAM/malware lists (vendor/NGO lists); periodic rescan | **auto-suspend + report** (CSAM: mandatory reporting, no discretion) |
| Subdomain phishing scan | daily crawl of public storage URLs + project subdomains serving HTML: brand-keyword/logo heuristics, Safe-Browsing API lookups of our own subdomains | flag high-confidence → auto-suspend URL serving → review |
| Email feedback | bounce rate > 10% or any complaint spike per project | auto-suspend project email sending (not the project) |
| Fleet-farming linkage | shared device fingerprint / IP subnet / card across accounts | review queue |
| External abuse reports | `abuse@steadhold.dev` + a report-abuse form on every public storage URL page | triaged queue; phishing reports fast-tracked |

Everything lands in **one review queue** in the admin dashboard with the evidence attached. Detectors that prove >95% precise get promoted from "flag" to "auto-act."

### E. Billing protections

- **Free can never bill** (D-094): no card on file, hard-stops instead of overages — deletes the stolen-card-overage abuse class and the "abuse victim gets the bill" class in one move.
- **Card-required-for-Pro is a natural filter**: paying abusers are rare, identifiable (Stripe Radar, chargeback trail), and prosecutable. Most abuse concentrates on Free by construction — which is where the hard caps are.
- Card testing against our checkout: Stripe Radar + rate limits on checkout attempts + the friction ladder score feeding Radar metadata.
- Pro default-on spend cap ([pricing §C](02-pricing-and-plans.md)) bounds damage from a *compromised customer account* too.

### F. Enforcement ladder

Proportional, logged (audit_logs, §59), reversible until the last rung, with an appeal path at every rung:

| Rung | Action | Trigger | Reversal |
|---|---|---|---|
| 1 | **Warn** — email + dashboard banner, named policy, deadline | low-confidence detection; first soft violation | auto-clears |
| 2 | **Throttle** — cut rate limits / email caps / egress to a trickle | repeat or medium-confidence | auto-lifts on compliance |
| 3 | **Suspend project** — API/serving stopped, data intact, owner can still export (D-004) | high-confidence abuse in one project | support review |
| 4 | **Suspend account** — all projects suspended, login to read-only billing/export | account-level abuse, farming, evasion of rung 3 | founder-level review |
| — | *(Skip-to-4 + preserve evidence + report)* | CSAM, active phishing of a live brand, court order | legal only |
| 5 | Deletion per D-038 retention pipeline | terms-violation after review window | — |

**Appeal path:** every enforcement email links a form; appeals land in the same review queue with the original evidence; target first response 2 business days (PROVISIONAL). False positives will happen — an appeal path is what separates "abuse desk" from "roulette."

Suspension **never blocks export** except under legal hold: portability (D-004) applies to people we kick out too — it keeps rung-3/4 mistakes survivable for the user and for our reputation.

### G. Abuse-desk operations for a 3-person team

Blunt reality: nobody's job is "trust & safety." The design must make abuse handling a **bounded, scheduled activity**:

1. **Caps do the work** (§C). The default answer to a new abuse vector is a cap or quota, not a detector.
2. **Automate triage, not judgment**: detectors auto-act only above proven precision; everything else is a queue item with evidence pre-gathered. Target: **< 2 hours/week** of human review at 1k projects, < 1 day/week at 10k (PROVISIONAL — if exceeded, that's the trigger to build better tooling or hire).
3. **Weekly abuse review** (30 min, standing): queue stats, false-positive rate, new patterns, threshold tuning. The metric reviewed: abuse actions taken, appeals upheld, email deliverability score.
4. **Playbooks over improvisation**: one-page runbooks for the top scenarios (phishing report, email complaint spike, LE request, CSAM hit) written *before* launch — the CSAM one especially, since it has legal deadlines and zero discretion.
5. On-call abuse pages exist for exactly two conditions: email-reputation collapse (A2) and confirmed phishing on our domain (A1). Everything else waits for business hours.

## Decisions

- **D-096 — Signup friction ladder: email verification always and universally; phone or card verification and manual review are applied only when scored risk signals fire (disposable-email domains, IP reputation, velocity/fingerprint linkage, payment signals). Signal weights and thresholds are config, reviewed weekly.** *(Rationale: resolves the lane-1-vs-abuse tension — clean users keep the frictionless first-five-minutes; friction is spent only on the risky tail; universal phone/card gates are conversion killers that punish everyone for the 1%.)*
- **D-097 — Enforcement ladder warn → throttle → suspend project → suspend account, with mandatory audit logging, an appeal path at every rung, skip-to-suspend reserved for CSAM/active-phishing/legal, and export (D-004) remaining available to suspended users except under legal hold.** *(Rationale: proportional enforcement bounds false-positive damage; preserving export keeps the portability principle honest even in adversarial endings; the skip-rung list is enumerated so "judgment calls" have a boundary.)*

## Open Questions

- **OQ-096:** Phishing-scan implementation: build the daily subdomain/storage crawl in-house vs a vendor (e.g. Safe-Browsing lookups + a URL-scanning API) — cost vs coverage, needs a spike before public launch.
- **OQ-097:** Legal groundwork: which jurisdictions' LE-request, DMCA, and CSAM-reporting obligations bind an eu-central-hosted platform (D-024) with global users, and the minimum ToS/AUP language — needs counsel before launch, not after the first request.
- **OQ-098:** Device fingerprinting for the friction ladder: build (crude, cheap) vs buy (better, GDPR review needed) vs skip until farming is observed.

## Dependencies

- Builds on: [02-pricing-and-plans.md](02-pricing-and-plans.md) (quotas, D-094 hard-stops), [01-cost-model.md](01-cost-model.md) (egress/fair-use exposure), [../05-auth/04-email-infrastructure.md](../05-auth/04-email-infrastructure.md) (email caps, deliverability, feedback loops), [../06-security/04-platform-security.md](../06-security/04-platform-security.md) (D-033 rate limiting), [../06-security/01-threat-model.md](../06-security/01-threat-model.md) (SQL-level escape hatches that quotas assume closed), [../01-architecture/03-multi-tenancy-and-isolation.md](../01-architecture/03-multi-tenancy-and-isolation.md) (cgroup caps, D-009)
- Feeds: [../02-control-plane/05-audit-and-admin-access.md](../02-control-plane/05-audit-and-admin-access.md) (enforcement audit events, admin review queue), [../09-dashboard/01-dashboard-ia.md](../09-dashboard/01-dashboard-ia.md) (warnings/appeals surfaces), [../15-risks/01-risk-register.md](../15-risks/01-risk-register.md)
