# Infrastructure Phases

## Purpose

Proposal §33 says "Phase 1: VMs + Docker. Phase 2: orchestration. Phase 3: Kubernetes where it provides actual value." This doc makes that concrete: the exact Phase A node inventory Corebase launches with (D-022, D-023), the entry/exit criteria that gate each phase transition (so the move is *measured*, not aspirational), the provider-abstraction interfaces from proposal §31–32 as real TypeScript sketches, and an honest provider-exit analysis — because D-023's "abstractions keep exit possible" is only true if someone has priced the exit.

## Design

### Phase A — VMs + Docker Compose under systemd (V1, launch)

**Entry criterion:** none — this is where we start (D-022).
**Exit criteria (any → begin Phase B planning):** see Phase B entry below.

#### Node inventory at launch

Four production nodes plus one staging node, all Hetzner Falkenstein (FSN1, D-024), all on one Hetzner Cloud private network. Models and prices are **assumptions to be re-quoted at purchase time** (Hetzner cloud pricing drifts; the *shape* is the decision, the SKU is not).

| Node | Role | Proposed model | Specs (assumed) | ~€/mo (assumed) | Runs (Compose stacks under systemd) |
|---|---|---|---|---|---|
| `cp-1` | Control plane + app node | CCX23 (dedicated vCPU) | 4 vCPU, 16 GB RAM, 160 GB NVMe | ~€25 | Caddy (D-050), the monolith (platform API + gateway + auth + storage modules, D-010/D-020), the worker, Redis (D-018), control-plane Postgres 17 + pgBackRest (D-012) |
| `data-1` | Data plane | CCX43 (dedicated vCPU) | 16 vCPU, 64 GB RAM, 360 GB NVMe + 1 TB attached volume (XFS `prjquota`, D-070) | ~€96 + ~€50 volume | Project triplets (D-054), SNI TCP router, warm pool (D-071), node_exporter, cAdvisor, Alloy, per-node postgres_exporter (see [observability](03-observability.md)) |
| `data-2` | Data plane | CCX43 | same as `data-1` | ~€146 | same as `data-1` |
| `mon-1` | Monitoring | CPX41 (shared vCPU) | 8 vCPU, 16 GB RAM, 240 GB NVMe | ~€29 | Prometheus, Grafana, Loki, Alertmanager (D-021) |
| `staging-1` | Staging (all roles combined) | CPX41 | 8 vCPU, 16 GB, 240 GB | ~€29 | Everything above scaled to 1 node (see [IaC & CI/CD](02-iac-and-cicd.md)) |

Total ≈ **€325/mo** at launch — inside proposal §118's "cheap: 1–3 compute nodes" intent. Two data nodes (not one) from day one: node loss must be a rehearsable event, not a novel one ([disaster recovery](04-disaster-recovery.md)), and the isolation suite's cross-node variant (D-084) needs two nodes to exist.

Dedicated-vCPU (CCX) for data nodes is deliberate: customer Postgres on shared-vCPU steal time is a support-ticket generator. `mon-1` and `staging-1` tolerate shared vCPU. Hetzner **dedicated servers** (AX line, ~2× RAM per €) are the known cost lever once fleet size justifies Robot-console ops and vSwitch networking — deferred (OQ-140).

64 GB data nodes match the density math in [multi-tenancy & isolation](../01-architecture/03-multi-tenancy-and-isolation.md): up to 150 active free-tier triplets per node (design max) at the 0.85 reservation fill line (D-090), ~1,000 planned, 1,200 hard cap (D-090) provisioned with pause (D-008).

#### How each node runs software

Per D-022: each node carries one or more **Docker Compose files rendered from the release manifest** ([IaC & CI/CD](02-iac-and-cicd.md)), each owned by a systemd unit (`corebase-<stack>.service`, `Restart=always`, `docker compose up` in the foreground). systemd is the process supervisor; Compose is the container spec; nothing hand-started. **Exception:** per-project triplets on data nodes are *not* Compose files — they are containers created directly by the worker's reconciler (D-052/D-053) and labeled with `project_ref`. Compose covers the platform's own standing services; the reconciler covers the per-tenant fleet.

#### The node-agent question (analyzed, and settled by D-052)

Two ways to execute provisioning on a data node:

| | (a) Node-agent daemon | (b) Worker drives Docker Engine API over mTLS |
|---|---|---|
| Extra deployables | A custom agent to build, version, roll fleet-wide, and keep protocol-compatible with the worker | None — Docker Engine API is the "agent", already installed, already versioned |
| Failure modes | Agent crash = node unmanageable until agent redeployed; agent/worker version skew | Docker daemon down = node unmanageable (but then containers are down anyway); no skew — one client |
| Security surface | Custom RPC protocol to harden | Docker API guarded by mutual TLS on the private network; certs per node, worker holds client cert |
| Local autonomy | Can act when control plane is dark | Cannot — but *nothing needs to*: triplets have `restart: unless-stopped`, pgBackRest timers run locally (D-019), and the failure-domain table in [control vs data plane](../01-architecture/02-control-vs-data-plane.md) requires no node-local decisions |
| Latency-sensitive local tasks (disk ladder D-073, health probes) | Natural fit | Worker evaluates the ladder from Prometheus quota metrics and applies actions via `docker exec` over the same mTLS channel; health = Docker healthchecks + exporter scrapes |

**(b) wins, and is already binding as D-052** (no custom per-node agent in V1). This doc adds no counter-decision; it records the consequence: everywhere the corpus says "node agent" informally (e.g. [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) §4–5), read "the worker acting on the node via Docker mTLS, informed by the node's exporters" (OQ-141 tracks cleaning up the wording). A real agent becomes worth revisiting in Phase B if worker→node round-trips measurably bottleneck reconciliation.

**Standing components on a data-plane node** (the complete list — nothing else may run there, per D-053's "actual state is observable" discipline):

1. Docker Engine, API bound to the private network IP, mTLS required
2. Per-project triplets + warm pool (reconciler-owned, labeled)
3. SNI TCP router for direct DB connections ([domain & region model](../01-architecture/04-domain-and-region-model.md))
4. pgBackRest per-project stanzas + systemd timers (D-019) — archiving continues with the control plane dark
5. node_exporter, cAdvisor, one multi-target postgres_exporter, Alloy log shipper ([observability](03-observability.md))
6. sshd (key-only, operator emergency access, audited per [audit & admin access](../02-control-plane/05-audit-and-admin-access.md))

### Phase B — orchestration (not K8s)

**Entry criteria (any two):**

- Fleet exceeds **~10 data nodes** — the point where "operator picks nothing, bin-packing picks everything" must extend to node lifecycle too
- Manual/spreadsheet reasoning about placement or capacity appears anywhere in ops practice (the bin-packer working D-090's 0.85 placement stop should prevent this; if it leaks, that's the trigger)
- Node-by-node rolling deploys exceed ~30 min end-to-end or regularly need human babysitting
- Drift incidents (reconciler repairs of things humans changed) exceed ~1/week

**What gets added:**

- **A real placement scheduler** — the bin-packing query graduates from "SQL in the worker" to a placement service with rebalancing proposals (still executed by the same reconciler; the *executor* does not change)
- **Config management** for node mutation (Ansible or equivalent): Phase A treats nodes as immutable-ish (cloud-init once, replace to change); at >10 nodes, targeted mutation (cert rotation, sysctl, exporter upgrades) needs tooling, not SSH loops
- **Golden node images** (Packer) to cut node-provision time from cloud-init-minutes to boot-seconds
- Possibly Nomad for the *platform's own* services if Compose-per-node coordination hurts — evaluated then, not promised now

**What does not change:** customer triplets stay reconciler-owned containers on plain Docker. Phase B is about managing *nodes and platform services* at count, not re-homing tenant workloads.

### Phase C — Kubernetes where it pays (only-if)

**Entry criteria (all three, measured):**

- Reconciliation scale: the custom reconciler's scope (placement + health + rollout + eviction across **50+ nodes** or multi-region, D-024 superseded by then) is re-implementing K8s controllers one incident at a time
- Multi-region operations demand federated desired-state distribution the flat model can't express
- Team can staff K8s as a discipline (≥1 person who has operated it in anger), per proposal §117's honesty about headcount

**What would move:** stateless platform services — gateway, monolith/API, auth, storage API, workers, PostgREST-adjacent tooling. These are the workloads K8s is *for*: horizontal, replaceable, health-checked.

**What never moves without extraordinary justification — customer Postgres containers.** The honest K8s-for-databases analysis:

- What K8s would give us: restart supervision (we have systemd/Docker restart policies), placement (we have the bin-packer), rolling config (we have the reconciler + template versioning D-070 §3). The marginal gain is small because **our reconciler already is a purpose-built operator**.
- What K8s would cost us: StatefulSet semantics fight per-project lifecycles (pause = scale-to-zero-with-volume is awkward); local NVMe means pods are node-pinned anyway, deleting the scheduler's main benefit; storage drivers/CSI add a failure layer between Postgres and its disk; the failure modes that hurt (kubelet eviction under node pressure, API-server unavailability blocking pod ops) are *new* ways to take customer databases down; and a Postgres operator (CNPG et al.) assumes replica-based topologies we don't run per-project at free-tier density.
- The industry pattern agrees: managed-Postgres vendors that run K8s run it for the *platform*, and those that put databases on it did so with dedicated storage/compute separation architectures — a different company-sized bet.

So Phase C's honest shape: **K8s for the control plane and stateless data-plane services if criteria hit; customer Postgres stays on reconciler-managed Docker hosts indefinitely.**

### Provider abstraction (proposal §31–32): interfaces from day one, second implementations never (yet)

The rule (**D-141**): the four interfaces below exist in `packages/` from the first commit, every call site depends on the interface, and **exactly one implementation of each exists** until a priced, dated exit decision creates a second. Writing a speculative second implementation is forbidden — it doubles the test matrix for zero users. The interface is the exit *door*; we do not furnish the room behind it.

```typescript
// packages/infra-providers/src/types.ts — sketches, not final signatures

/** Node lifecycle. Impl: HetznerComputeProvider (hcloud API). */
interface ComputeProvider {
  createNode(spec: NodeSpec): Promise<NodeHandle>;        // model, region, cloud-init, private net
  destroyNode(id: NodeId): Promise<void>;
  getNode(id: NodeId): Promise<NodeStatus>;                // running | rebooting | unreachable
  listNodes(filter?: { role?: NodeRole }): Promise<NodeStatus[]>;
  attachVolume(node: NodeId, spec: VolumeSpec): Promise<VolumeHandle>;
  resizeVolume(vol: VolumeId, newGb: number): Promise<void>;
}

/** Per-project database-stack operations on a node — proposal §32's DatabaseProvider,
 *  renamed: it manages *stacks on nodes*, not managed DBs. Impl: DockerEngineProvider
 *  (Engine API over mTLS, D-052). The reconciler (D-053) is its only caller. */
interface DatabaseNodeProvider {
  ensureVolumeDir(node: NodeId, spec: ProjectVolumeSpec): Promise<void>;   // XFS prjquota set
  ensureContainer(node: NodeId, spec: ContainerSpec): Promise<EnsureResult>; // convergent
  stopStack(node: NodeId, ref: ProjectRef): Promise<void>;                  // pause path
  removeStack(node: NodeId, ref: ProjectRef, keepVolume: boolean): Promise<void>;
  inspectNode(node: NodeId): Promise<ActualState>;          // labeled containers + volumes
  exec(node: NodeId, ref: ProjectRef, cmd: string[]): Promise<ExecResult>;  // ladder actions, pgBackRest
}

/** Object storage. Impl: R2Provider (S3 wire protocol, D-017); MinIO locally (same impl, different endpoint). */
interface StorageProvider {
  ensureBucket(name: string, opts: BucketOpts): Promise<void>;
  putObject(loc: ObjectLoc, body: Stream, meta: ObjectMeta): Promise<void>;
  getObject(loc: ObjectLoc): Promise<Stream>;
  deleteObjects(locs: ObjectLoc[]): Promise<void>;
  signUrl(loc: ObjectLoc, op: "get" | "put", ttlSec: number): Promise<string>;
  copyBetween(src: ObjectLoc, dst: ObjectLoc): Promise<void>;   // cross-repo backup copies (D-149)
}

/** DNS + edge config. Impl: CloudflareDnsProvider. */
interface DnsProvider {
  upsertRecord(zone: string, rec: DnsRecord): Promise<void>;
  deleteRecord(zone: string, name: string, type: RecordType): Promise<void>;
  listRecords(zone: string): Promise<DnsRecord[]>;
}
```

Notes: S3-compat (D-017) means `StorageProvider` is nearly free — the interface mostly wraps one SDK. `DatabaseNodeProvider` is where the real coupling risk lives (Docker Engine semantics leak into `ContainerSpec`); the discipline is that `ContainerSpec` stays a Corebase-shaped description (image, limits per D-055, mounts, labels, network), translated inside the impl. Wildcard TLS and DDoS sit *outside* these interfaces — they are Cloudflare product features, and their exit cost is accounted below, not hidden behind an interface that pretends they're portable.

### Provider exit analysis (honest table)

"Could we leave?" priced per component. Estimates assume the fleet at ~10 data nodes / low-TB storage; **all provisional**.

| Component | Leaving means | Coupling beyond the interface | Estimated effort |
|---|---|---|---|
| Hetzner compute → other VM provider | New `ComputeProvider` impl + Terraform provider swap + cloud-init tweaks; then per-node evacuate: provision new node, reconciler restores projects from backup+WAL (same motion as node loss, [DR](04-disaster-recovery.md)) | Low: private-network setup, volume semantics, SKU mapping | Impl + IaC: ~1–2 weeks. Fleet migration: days per handful of nodes (restore-rate-bound); **weeks total**, mostly unattended |
| R2 → other S3 store | New endpoint/creds in the same S3 impl; bulk-copy objects + pgBackRest repos; repoint | Low technically — **but R2's zero egress is a pricing pillar** ([cost model](../12-business/01-cost-model.md)); leaving R2 re-opens the egress line item. Copying *out* of R2 is free, which keeps this exit cheap | Config: days. Data copy: days–2 weeks (TB-scale). Re-pricing storage plans: the real cost. **~2–4 weeks** |
| Cloudflare DNS only | New `DnsProvider` impl; NS migration | Low | **~1 week** incl. TTL-safe cutover |
| Cloudflare edge (TLS, DDoS, cache, origin pulls) | Replace wildcard cert issuance (Caddy/ACME DNS-01 can take over, D-050 already terminates origin TLS), lose DDoS absorption and cache-softening of storage reads | **This is the real Cloudflare dependency** — not DNS. No drop-in for DDoS at Hetzner; would need another edge vendor in front | **~1–2 months** to equivalent posture, and a period of elevated exposure. Exit exists but is the most expensive of the four |
| Cloudflare R2 *and* edge together (full Cloudflare exit) | Both rows above at once | Account-level correlated risk is why backup second-copies live off-Cloudflare (D-149) | **~2–3 months** |

Conclusion the table supports: D-023's choices are safe to commit to because the two expensive exits (Cloudflare edge, R2 pricing) are hedged — origin TLS already works Cloudflare-optionally (D-050), and backups are double-homed (D-149) — while compute, the most likely thing to outgrow, is the cheapest to leave.

## Decisions

- **D-140 — Phase A production topology is exactly four nodes in FSN1 — `cp-1` (control plane + gateway/app, ~CCX23/16 GB), `data-1`/`data-2` (~CCX43/64 GB + 1 TB XFS volume each), `mon-1` (~CPX41) — plus one combined staging node; platform services run as release-manifest-rendered Compose stacks under systemd, per-project triplets are reconciler-owned containers outside Compose; two data nodes from day one.** *(Rationale: matches the 64 GB density math and D-090's fill line; two data nodes make node-loss recovery and cross-node isolation tests (D-084) rehearsable before customers force the issue; SKUs and prices are marked assumptions — the shape is the decision.)*
- **D-141 — The four provider interfaces (ComputeProvider, DatabaseNodeProvider, StorageProvider, DnsProvider) exist from the first commit and are the only path to provider APIs; exactly one implementation each ships until a priced exit decision demands a second — speculative second implementations are forbidden.** *(Rationale: proposal §31–32 adopted with YAGNI teeth; interfaces cost near-zero now and preserve the exit door, while a second impl doubles the test matrix for zero users; the exit table above keeps the door honest.)*
- Phase transitions are gated by the entry criteria enumerated above — adopting Phase B/C tooling without a met criterion violates D-022.

## Open Questions

- **OQ-140** — When does the data-plane fleet move from Hetzner Cloud CCX to dedicated AX servers (~2× RAM/€ but Robot-console ops, vSwitch networking, slower replacement)? Candidate trigger: ≥6 data nodes or compute >40% of COGS. Owner: [cost model](../12-business/01-cost-model.md).
- **OQ-141** — Sweep the corpus's informal "node agent" phrasing ([postgres provisioning](../03-database-platform/01-postgres-provisioning.md) §4–5) into D-052-consistent wording (worker-via-mTLS + exporters), or introduce a real agent in Phase B if worker→node round-trips bottleneck reconciliation — measure first.
- **OQ-142** — Warm-pool + reserved-RAM interplay with the DR headroom rule (D-148): does the 75% fleet ceiling count warm stacks? Proposed: yes (they're booked like projects, D-071). Confirm when [DR](04-disaster-recovery.md) drills produce data.

## Dependencies

- Builds on: [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-022, D-023, D-024), [../01-architecture/02-control-vs-data-plane.md](../01-architecture/02-control-vs-data-plane.md) (D-052/D-053), [../01-architecture/03-multi-tenancy-and-isolation.md](../01-architecture/03-multi-tenancy-and-isolation.md) (density math, D-054/D-055), [../03-database-platform/01-postgres-provisioning.md](../03-database-platform/01-postgres-provisioning.md) (D-070–D-073)
- Feeds: [02-iac-and-cicd.md](02-iac-and-cicd.md), [03-observability.md](03-observability.md), [04-disaster-recovery.md](04-disaster-recovery.md), [../12-business/01-cost-model.md](../12-business/01-cost-model.md), [../14-roadmap/04-milestone-0.md](../14-roadmap/04-milestone-0.md)
