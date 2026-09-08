# Disaster Recovery

## Purpose

Failure-mode-by-failure-mode runbook skeletons with RTO/RPO targets, for the D-140 topology (cp-1, data-1/2, mon-1, single region per D-024). This doc defines the two decisions the rest of the corpus already leans on — **D-148** (the DR headroom rule + node-loss RPO/RTO) and **D-149** (cross-repo backup copies to a second location) — plus the drill cadence that keeps the runbooks true and the incident-response frame (severities, status page, comms). Governing stances inherited: restore always to new (D-019), the reconciler is the recovery engine (D-053), data-destroying repairs are never automatic (D-065), and a backup that hasn't been restore-tested doesn't exist ([backups & PITR](../03-database-platform/05-backups-and-pitr.md)).

## Design

### RTO/RPO summary *(all targets provisional until drills produce measured numbers)*

| # | Failure mode | Blast radius | RPO | RTO target | Runbook |
|---|---|---|---|---|---|
| FM-1 | Project container crash | 1 project | 0 (volume intact) | seconds–minutes (auto) | RB-1 |
| FM-2 | Data-plane node loss | ~150 active + up to ~1,000 paused projects (D-091) | ≤5 min (WAL archive lag, D-148) | <60 min for the node's active projects (D-148); paused restore lazily on resume | RB-2 |
| FM-3 | Control-plane loss (cp-1 or control PG) | no new/paused/resumed projects; V1 caveat: cp-1 *node* loss also drops the data-plane HTTP path | control PG: ≤5 min (own pgBackRest WAL) | <2 h control plane restored | RB-3 |
| FM-4 | R2 / object-storage outage | backups pause; storage reads/writes degrade | 0 for DBs (WAL spools on node) | rides out the outage; no action that can't wait | RB-4 |
| FM-5 | Cloudflare outage | all HTTP entry (DNS, TLS, DDoS) | 0 | hours (direct-DNS escape hatch) | RB-5 |
| FM-6 | Region loss (FSN1) | everything | ≤24 h (second-copy sync age, D-149) | **days** — rebuild-from-backups, stated honestly | RB-6 |
| FM-7 | mon-1 loss | observability only, customers unaffected | n/a | <1 day rebuild | RB-7 |

RPO honesty (published verbatim, same as [backups §5](../03-database-platform/05-backups-and-pitr.md)): WAL not yet archived at the instant of loss is gone; ≤5 min is the Free-tier worst case (`archive_timeout=300`, D-077 — ~1–2 min on Pro/Team).

### FM-1 — Project container crash (RB-1)

The non-event. Docker `restart: unless-stopped` + the reconciler's ≤60s drift pass (D-053) restart a crashed triplet member; the volume is untouched, so data loss is zero.

1. Nothing — auto-restart handles it. Reconciler records the repair (drift-repair metric).
2. If crash-looping (>3 restarts/10 min): reconciler alerts (D-065 — it will not "repair" by recreating a volume); operator inspects container logs via the per-project drill-down dashboard.
3. Common causes ladder: OOM (check cAdvisor; plan limits, D-055) → disk-full (D-073 ladder state) → corrupt state (last resort: restore-to-new per D-019, customer-communicated).

### FM-2 — Data-plane node loss (RB-2) — the big one

A data node dies (hardware, kernel, unreachable >2 min = "Node down" page). Its projects are down until restored elsewhere from base backup + archived WAL (target=latest). Two facts make this rehearsable rather than novel: pgBackRest archives autonomously with the control plane dark (D-019), and evacuation is already a reconciler motion — rewrite `node_id`, converge ([control vs data plane](../01-architecture/02-control-vs-data-plane.md)).

**The capacity-headroom rule this implies (D-148).** Restoring a node's worth of projects requires somewhere to put them. Reconciled with the existing guardrails:

- **D-090** stops *placement* at 85% reserved RAM per node — a packing stop, not DR headroom.
- **D-091** plans 150 active / 64 GB node ≈ 82% reserved at full density — the *per-node design max* under D-090's 85% stop, not a fleet operating point: the fleet averages ≤75% per the ceiling below, ~135–140 active/node as the fleet-planning figure (D-174).
- Strict standing N-1 headroom (one node's full load always fits in the survivors under the 85% stop) would cap fleet reservation at `0.85 × (N−1)/N` — **42.5% at N=2**, i.e. half the fleet idle at launch. That violates lane 3 economics for negligible risk reduction, because Hetzner Cloud provisions a replacement CCX43 in ~10–20 min via the existing cloud-init path ([IaC & CI/CD](02-iac-and-cicd.md)).
- So the binding rule is two-part: **fleet-wide reserved-RAM ceiling of 75%** (spare absorbs the highest-priority restores immediately), plus **emergency node provisioning as elastic headroom** for the tail (pre-approved Hetzner quota, pinned images pre-pulled by cloud-init). Warm-pool stacks count as reserved (per OQ-142's proposal; confirmed or revised after the first drill).

Runbook:

1. **Page** fires ("Node down", 2 min without scrapes — [observability](03-observability.md)). On-call confirms it's the node, not mon-1 or the private net (blackbox + a second node's view).
2. Attempt cheap recovery first: Hetzner console reset/reboot (≤10 min budget). Watch for the node rejoining — containers have `restart: unless-stopped`; if it returns healthy, verify triplets via reconciler diff and *stop here* (this was an FM-1-at-scale, not FM-2).
3. **Declare the node lost** — an explicit operator command (`steadhold-ops node declare-lost <node>`, D-157). Never automatic: mass evacuation is data-adjacent and stays operator-gated (D-065). The command cordons the node, marks its placements for evacuation, and starts the replacement-node Terraform apply in parallel.
4. Reconciler executes the evacuation: for each project in priority order **paid → active free → (paused: skipped, restored lazily on their next resume per D-077 — their state is fully in R2 by the pause interlock)** — rewrite `node_id` to a surviving node (bin-packer respects the D-090 85% stop) or to the replacement node as it comes ready → normal restore flow, `--type=default` to latest ([backups §4](../03-database-platform/05-backups-and-pitr.md)), skipping customer-validation steps (this is recovery, not PITR; promote is implicit).
5. Restore concurrency is bounded per target node (OQ-060/OQ-158) so the restore storm doesn't harm healthy tenants.
6. Routing table updates propagate per D-051; SNI/DNS entries for direct DB connections repoint to new nodes.
7. Status page + comms per the incident frame below (Sev-1, ~150 customers affected). Customers whose unarchived WAL was lost (RPO window) get individual notification per the [customer-notification rule](../06-security/04-platform-security.md).
8. Post-incident: destroy the dead node in TF, retro, and record measured restore throughput → feeds OQ-158 and re-baselines the RTO.

RTO accounting behind the <60 min target: detection+triage ~10 min, replacement node ~15–20 min (parallel with first restores into the 25% fleet spare), ~150 mostly-small (≤500 MB Free-cap) restores at measured parallel rate. Every quarterly drill re-validates this arithmetic with real numbers (D-156).

### FM-3 — Control-plane loss (RB-3)

Two sub-scenarios, because [control vs data plane](../01-architecture/02-control-vs-data-plane.md) claims "data plane keeps serving" — verified here with its own caveat:

**(a) Control-plane Postgres (or the control-plane module) down, monolith process alive.** The doc's failure-domain table holds: REST/auth/storage/direct-SQL keep serving from the gateway's cached routing table and cached public keys (D-051, D-014); pgBackRest keeps archiving. **What breaks, exactly:** no dashboard (sign-in, project list, SQL/table editor), no provisioning (create/pause/delete), **no resume of paused projects** — paused free projects stay dark for the duration, no key generation/rotation or plan changes, no new routing entries or invalidations (existing entries serve stale), metering degrades to buffered/dropped events (reconciled later).

**(b) cp-1 node loss.** The honest V1 caveat bites: cp-1 also hosts the monolith (gateway/auth/storage modules, D-020), Caddy, and Redis — so the **data-plane HTTP path goes down with it**. Only direct SQL (`psql` via the data nodes' SNI routers) and backups survive. This is the accepted D-020 trade; the mitigation is that cp-1 is stateless-except-Postgres and rebuilds fast.

Runbook (b subsumes a):

1. Page fires ("Control-plane API error rate" / "Node down" for cp-1).
2. If it's the node: Hetzner console reset first (≤10 min), else provision a replacement cp-1 via Terraform + cloud-init (same path as any node, [IaC & CI/CD](02-iac-and-cicd.md)); apply the current release manifest — Caddy, monolith, worker, Redis come up stateless.
3. Restore control-plane Postgres from **its own pgBackRest repo** (D-012 — same tooling as customer DBs), `--type=default` to latest; RPO ≤5 min via its continuous WAL archiving.
4. Redis state is disposable by design (D-018: never a source of truth): the sweeper rebuilds the queue from `provisioning_jobs`; rate-limit windows and pub/sub reset cold.
5. Gateway boot-hydrates the routing table from restored control PG (D-051); verify a canary project end-to-end.
6. Run the reconciler in observe-first mode for one full pass before enabling repairs: desired state is now ≤5 min stale, and D-065 forbids destructive convergence on stale truth — operator reviews the diff (e.g. projects resumed/created during the outage window that the restored DB doesn't know about; nothing on a node that desired state doesn't describe is investigated, not deleted).
7. **RTO target: <2 h** to a fully restored control plane. In sub-scenario (a), customer data-API impact is zero for the duration; in (b), data-plane HTTP impact lasts until step 2's monolith is up (~20–30 min of it), which prices the D-020 single-process trade honestly.

### FM-4 — R2 / object-storage outage (RB-4)

1. Detection: backup-failure alerts + `pgbackrest check` failures fleet-wide + storage-API 5xx.
2. **Databases: no action.** `archive-async` spools WAL on each project volume (inside the tenant's quota); archiving drains when R2 returns. Backups pause — acceptable: PITR windows age but existing repos are intact. If the outage exceeds ~12 h, watch spool growth on the largest tenants (D-073 ladder protects the node).
3. **Storage API**: uploads fail with the standard error envelope; public-object *reads* are softened by Cloudflare edge cache (D-016) — cached objects keep serving, cache misses 5xx.
4. No failover to the D-149 second copy for serving: it is a backup repo, not a hot mirror. Region-scale judgment stays with FM-6.
5. Comms: Sev-2 (Sev-3 if only backups are affected and the storage API is healthy); status page notes degraded storage.

### FM-5 — Cloudflare outage (RB-5)

Accepted dependency (D-023): DNS, wildcard TLS, DDoS, cache all sit at Cloudflare, and its outage takes the HTTP entry path down. Direct SQL via SNI routers survives if the customer has the IP cached; `db.*` DNS resolution does not.

The escape hatch — hours, not minutes, and DDoS-naked while active:

1. Confirm it's Cloudflare (their status page, direct-to-origin curl against node IPs).
2. If projected to be long (>~2 h): repoint nameservers at the registrar to the standby DNS provider, loading the **nightly-exported zone file** (a small standing job this runbook mandates; stored with the D-149 second copies), with records pointing directly at cp-1 / data-node IPs.
3. Caddy switches from Origin CA certs (trusted only by Cloudflare) to ACME/Let's Encrypt HTTP-01 issuance — pre-configured as a fallback issuer, exercised in the quarterly drill.
4. Origin firewall temporarily opens 443 beyond Cloudflare ranges. Accepted exposure: no DDoS absorption, no edge cache. Revert everything when Cloudflare recovers (NS TTLs bound the tail).
5. Comms: Sev-1 while the entry path is down; the status page is hosted off-Cloudflare precisely for this scenario (D-155).

### FM-6 — Region loss (RB-6) — the V1 posture, stated honestly

Per D-024, one region is an accepted risk: no warm standby, no cross-region replicas, no multi-region serving. The V1 DR posture for losing FSN1 (or the Hetzner account) is **rebuild-from-backups in a new location, RTO measured in days** — and D-149 exists so the backups survive scenarios that R2-only copies would not (Cloudflare account loss is the correlated case the [provider-exit analysis](01-infra-phases.md) prices).

**D-149 second location, decided concretely: Backblaze B2, EU region (Amsterdam).** Off-Cloudflare (breaks the R2/edge/TF-state account correlation), off-Hetzner (breaks the compute/backup correlation — a Hetzner Object Storage bucket would ride the same account and, in FSN, the same campus), geographically separate from Falkenstein, S3-compatible (the same `StorageProvider` impl with a second endpoint; `copyBetween` is the sync primitive, [infra phases](01-infra-phases.md)), ~$6/TB-mo against a low-TB fleet.

What syncs, via a nightly control-plane job per repo (6-hourly for the control-plane repo): pgBackRest repos (already encrypted per-project, D-087 — B2 holds ciphertext), nightly `terraform state pull` copies (D-142), the DNS zone export (RB-5), and the release-manifest archive. Customer *storage objects* (the R2 `steadhold-storage` bucket) are **not** second-copied in V1 — cost-prohibitive at file-storage scale and R2's own durability is the bet; stated in the published posture (OQ-159 revisits for paid tiers). `restore_verifications` sampling (§7 of [backups & PITR](../03-database-platform/05-backups-and-pitr.md)) draws a fraction of its runs from the B2 copy so the second repo is restore-tested, not assumed.

Runbook skeleton (exercised as an annual tabletop, D-156):

1. Declare Sev-1; incident commander; status page (which is off-region and up).
2. Terraform apply of the prod env against a new location (Hetzner NBG/HEL if the account survives; otherwise a new account or provider via the `ComputeProvider` seam — slower).
3. Restore control-plane Postgres from the B2 copy; stand up cp-1 stack; re-key what the sealed store requires (break-glass path, [audit & admin access](../02-control-plane/05-audit-and-admin-access.md)).
4. Restore customer projects from B2 in the same priority order as RB-2 (paid → active free → paused lazily), across as many nodes as restore throughput justifies.
5. DNS cutover; customer comms throughout, including the honest RPO statement: **up to 24 h of data** (second-copy sync age) for anything whose R2 repo is also gone; if R2 survived (Hetzner-only loss), RPO collapses back to ≤5 min.

### FM-7 — mon-1 loss (RB-7)

Observes, doesn't serve — customers unaffected, but on-call is blind. 1. Rebuild via TF + manifest (<1 day; dashboards/alerts are provisioned as code). 2. Metrics gap is accepted; Loki chunks live in R2 and survive. 3. The dead-man's-switch alert is what detects this (its *absence* pages). OQ-148 (a tiny off-node alert replica) remains the open mitigation for a mon-1 loss *during* another incident.

### Restore-drill cadence (D-156)

| Drill | Cadence | What it proves |
|---|---|---|
| Per-project restore verification ([backups §7](../03-database-platform/05-backups-and-pitr.md)) | Continuous restore-verification sampling with per-plan floors (D-176: Pro+Team every ≤30 d, Free every ≤90 d) | Backups exist in the only sense that counts |
| **Full node-loss drill (RB-2) on ephemeral drill infrastructure** | **Quarterly** | Declare-lost → evacuate → restore end-to-end; measures restore throughput (OQ-158) and re-baselines the D-148 RTO; includes one restore sourced from the B2 copy |
| Control-plane restore drill (RB-3) in staging | Semiannual | Control PG restore + reconciler observe-first pass + routing rehydration |
| Cloudflare-bypass drill (RB-5 steps 2–3) | Quarterly, staging DNS only | Zone export is loadable; ACME fallback issues |
| Region-loss tabletop (RB-6) | Annual | The days-RTO estimate stays honest; break-glass material works |

**Node-loss drill substrate (D-175):** the standing staging topology stays one combined node (D-140 unchanged), so each quarterly node-loss drill Terraform-creates **two temporary staging data nodes** — the standing combined staging node acts as the control plane — runs declare-lost → evacuate → restore between them, measures against the D-148 targets, and destroys the nodes. The ephemeral creation is a feature, not a compromise: it exercises the exact node-rebuild path (cloud-init, image pre-pull) that real node-loss recovery depends on, for a few € per drill instead of ~€300/mo standing.

A drill that misses its RTO target files a retro exactly like an incident; the target moves or the system does.

### Incident-response frame (D-155)

Severity levels — extends the security-incident table in [platform security](../06-security/04-platform-security.md) (its Sev-1–3 security definitions are unchanged) with availability definitions:

| Severity | Definition (either column triggers) | Response |
|---|---|---|
| **Sev-1** | Security: cross-tenant exposure, auth bypass, secrets compromise, isolation suite red in prod (D-085). Availability: a node's worth of projects or more down; any confirmed data loss beyond stated RPO; entry path down (FM-5); region loss | Page immediately; incident commander; deploy freeze; status page within 15 min; customer-notification clock starts on any data exposure/loss (72 h rule) |
| **Sev-2** | Security: single-project exposure. Availability: significant degradation (storage outage FM-4, elevated error rates), single-digit projects down | Page on-call; status page within 30 min; affected customers notified individually |
| **Sev-3** | Vulnerability without exploitation; degraded non-critical function; single-project degradation with workaround | Ticket; scheduled fix; status page only if customer-visible |
| **Sev-4** | No customer impact: near-misses, failed drills, redundancy loss (FM-7, one alert channel down) | Ticket + retro note; feeds drill/alert backlog |

**Status page:** hosted third-party, run entirely off Steadhold and Cloudflare infrastructure so it survives FM-3/FM-5/FM-6 (candidate vendor Instatus; final pick with the paging vendor, OQ-157/OQ-146). `status.steadhold.app` CNAMEs to it; the vendor-domain URL is published in docs and error pages as the DNS-independent fallback. Manual updates in V1; alert-driven automation later.

**Comms templates** (kept in the ops repo, pre-approved so 3 a.m. incidents don't require prose composition):

- *Initial (≤15 min, Sev-1/2):* what's affected (plain terms: "API requests to projects on one server are failing"), since when, what we're doing, next update time.
- *Update (every 30–60 min):* progress, revised ETA, no speculation about cause.
- *Resolution:* timeline, impact statement (which projects, what data window if any), follow-up commitment.
- *Data-incident notification:* per the [customer-notification rule](../06-security/04-platform-security.md) — any confirmed unauthorized access or loss of a customer's data → that customer notified without undue delay (target ≤72 h of confirmation), interim "we detected X, do Y" first, root cause later. RB-2 step 7 (RPO-window WAL loss) uses this template.

**Alert-to-runbook mapping** (alert names from the [observability alert catalog](03-observability.md); every page-level alert must map to a runbook or it doesn't ship):

| Alert | Runbook |
|---|---|
| Node down (data node) | RB-2 |
| Node down (cp-1) / control-plane API error rate | RB-3 |
| Backup failure / WAL archive lag >15 min | RB-2 preamble checks: R2 reachable? (→ RB-4) node sick? (→ RB-2); else per-project backup triage in [backups & PITR](../03-database-platform/05-backups-and-pitr.md) |
| Restore-verification failure | Backups §7 rule: treat that project's backups as nonexistent — immediate fresh full + re-verify |
| Isolation-suite failure | Sev-1 security path ([tenant isolation tests](../06-security/03-tenant-isolation-tests.md), D-085) — not a DR runbook |
| Node RAM reserved ratio / volume usage | Capacity, not disaster: add node per D-148 ceiling / D-073 ladder |
| Redis down | RB-3 step 4 logic (state disposable); page persists because queue+limits+pub/sub degrade (OQ-052) |
| Second-copy sync age >36 h (warn) / >72 h (page) — *added by D-149* | Re-run sync job; investigate B2 creds/endpoint; FM-6 posture is void while stale |
| mon-1 dead-man's-switch | RB-7 |

## Decisions

- **D-148 — Node-loss recovery objective and the DR headroom rule: RPO ≤5 min (bounded by WAL-archive lag; `archive_timeout=300` Free is the worst case per D-077) and RTO <60 min for a lost node's worth of *active* projects (paused projects restore lazily on resume, priority order paid → active free → paused). To make that possible the fleet runs at a binding **75% fleet-wide reserved-RAM ceiling** across data nodes (warm-pool stacks count as reserved) — breach means add a node before further placement — with pre-approved emergency node provisioning (~15–20 min via the standard cloud-init path) as the elastic remainder; evacuation respects D-090's 85% per-node placement stop.** *(Rationale: strict standing N-1 headroom under the 85% stop would cap the launch fleet at 42.5% reservation — half the fleet idle, violating lane-3 economics — while a 75% ceiling plus Hetzner's minutes-scale provisioning delivers the same RTO for a fraction of the cost; the ≤5 min RPO is what continuous WAL archiving (D-019/D-077) already pays for, and the observability catalog alerts on exactly these two numbers.)* *(Targets provisional until quarterly drills produce measured restore throughput.)*
- **D-149 — Cross-repo backup copies: pgBackRest repos (plus TF-state pulls, the DNS zone export, and release manifests) replicate daily — control-plane repo 6-hourly — from R2 to a second, off-Cloudflare, off-Hetzner S3-compatible location: **Backblaze B2, EU (Amsterdam)**, via the StorageProvider `copyBetween` path; second-copy sync age is monitored (>36 h warn, >72 h page) and a fraction of restore verifications run from the B2 copy. Customer storage objects are not second-copied in V1. This is the V1 region-loss posture (D-024): rebuild-from-backups in a new location, RTO days, region-loss RPO ≤24 h, published honestly.** *(Rationale: the correlated failures worth hedging are account-level — Cloudflare holds R2+edge+TF state, Hetzner holds compute — so the second copy must sit with a third party; B2 is S3-compatible (same provider impl), cheap at low-TB scale, and geographically separate from FSN1; copies that are never restore-tested would be fiction, so verification sampling covers them.)*
- **D-155 — Incident-response frame: severity ladder Sev-1..Sev-4 extending the platform-security table with availability definitions (node-scale outage, RPO-exceeding data loss, and entry-path loss are Sev-1); a hosted third-party status page run off Steadhold and Cloudflare infrastructure with a vendor-domain fallback URL; pre-approved comms templates (initial ≤15 min for Sev-1/2, updates every 30–60 min, resolution, and a data-incident template implementing the 72 h customer-notification rule).** *(Rationale: severity definitions decided during an incident are decided badly; the status page must not share fate with the platform or its edge vendor; templates make the notification rule executable at 3 a.m. by a team of three.)*
- **D-156 — Drill cadence is binding: quarterly full node-loss drill in staging (declare-lost → evacuate → restore on D-175's ephemeral drill nodes, timed against D-148, one restore sourced from the D-149 copy), quarterly Cloudflare-bypass drill (zone load + ACME fallback), semiannual control-plane restore drill, annual region-loss tabletop — on top of the continuous per-project restore verification of D-019/D-077 (§7 of backups & PITR). A missed RTO in a drill files a retro like an incident.** *(Rationale: runbooks rot at exactly the speed nobody rehearses them; the drills are what turn this doc's provisional targets into measured numbers. D-140's two data nodes are the production shape — the standing staging topology is one combined node — so the drill's two-data-node substrate is created ephemerally per D-175.)*
- **D-157 — Node evacuation is operator-initiated, never automatic: a single explicit `declare-lost` command cordons the node, marks placements for evacuation, and triggers replacement provisioning; the reconciler then executes restores at bounded concurrency. Automatic failover on node-unreachable signals is rejected for V1.** *(Rationale: D-065 already forbids automatic data-destroying repairs, and a false-positive mass evacuation (net partition, mon-1 blindness) is itself a disaster; one command keeps the human decision cheap while the reconciler keeps the execution boring — consistent with the failure-domain table's "operator-approved action" in control vs data plane.)*
- **D-175 — Node-loss drills run on ephemeral drill infrastructure: each quarterly drill Terraform-creates two temporary staging data nodes (the standing combined staging node acts as control plane), executes declare-lost → evacuate → restore between them, measures against the D-148 targets, and destroys the nodes; the standing staging topology stays one combined node (D-140 unchanged). Resolves the D-140/D-156 substrate conflict; confirms OQ-145's ephemeral lean for drills.** *(Rationale: a drill needs a node to kill and a node to receive — a topology worth ~€300/mo standing but only a few € for the hours a quarterly drill runs; ephemeral creation also exercises the exact node-rebuild path (cloud-init, image pre-pull) that real node-loss recovery depends on, making the drill more honest, not less.)*

## Open Questions

- **OQ-157** — Status-page and paging vendor selection (with OQ-146): one incident-tooling vendor or two, and does `status.steadhold.app` need to live in a non-Cloudflare DNS zone to be reachable during FM-5, or is the published vendor-domain fallback URL enough? Decide before first paying customer.
- **OQ-158** — Restore-storm throughput: measured parallel restore rate per target node (interacts with OQ-060 reconciler concurrency caps and pgBackRest `process-max`), which is the real bound on D-148's <60 min RTO. First quarterly drill produces the number; the RTO target moves or the concurrency budget does.
- **OQ-159** — Region-loss scope refinements: how much of RB-6 is pre-scripted vs documented-only (a standing `envs/dr/` Terraform env?); whether paid tiers get customer *storage-object* second copies (excluded from D-149 in V1 on cost); and the restore prioritization contract we're willing to publish (paid-first is stated internally — is it stated publicly?). Owned with OQ-078 in [backups & PITR](../03-database-platform/05-backups-and-pitr.md).

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-019, D-021, D-022, D-023, D-024, D-052, D-053, D-065, D-090, D-091), [01-infra-phases.md](01-infra-phases.md) (D-140 topology, provider-exit analysis, StorageProvider), [02-iac-and-cicd.md](02-iac-and-cicd.md) (node rebuild path, D-142/D-144), [03-observability.md](03-observability.md) (detection, alert catalog, RPO measurement), [../01-architecture/02-control-vs-data-plane.md](../01-architecture/02-control-vs-data-plane.md) (failure domains, reconciler), [../03-database-platform/05-backups-and-pitr.md](../03-database-platform/05-backups-and-pitr.md) (D-077 restore flows, verification loop), [../06-security/04-platform-security.md](../06-security/04-platform-security.md) (severity table, customer-notification rule), [../02-control-plane/05-audit-and-admin-access.md](../02-control-plane/05-audit-and-admin-access.md) (break-glass)
- Feeds: [../15-risks/01-risk-register.md](../15-risks/01-risk-register.md), [../12-business/01-cost-model.md](../12-business/01-cost-model.md) (headroom + B2 line items), [../14-roadmap/01-phase-plan.md](../14-roadmap/01-phase-plan.md) (drills as phase exit criteria), [../13-quality/01-testing-strategy.md](../13-quality/01-testing-strategy.md)
