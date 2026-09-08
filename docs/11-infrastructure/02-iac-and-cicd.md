# IaC & CI/CD

## Purpose

Proposal §71 ("no manual dashboard-click dependencies") and §72 (PR → tests → deploy) made executable under D-022 (Terraform + cloud-init, Compose under systemd, no K8s). This doc fixes the Terraform layout, where state lives, what cloud-init actually writes onto a node, how secrets enter IaC, the staging/prod environment contract, the exact GitHub Actions pipelines, and — the part K8s users get for free and we must spec ourselves — deploy mechanics: how a release rolls node-by-node and rolls back.

## Design

### Terraform layout

```text
infra/terraform/
├── modules/
│   ├── network/        # Hetzner private network, subnets, firewall rules (deny-all default,
│   │                   #   allow: CF ranges→443 on cp-1, private-net node↔node ports)
│   ├── node/           # one Hetzner server: model, role label, cloud-init render,
│   │                   #   private-net attach, optional XFS volume (data nodes)
│   ├── dns/            # Cloudflare zone records: api./app./*.steadhold.app → cp-1,
│   │                   #   db.* wildcard → data-node SNI router IPs; origin-pull config
│   ├── r2/             # R2 buckets: storage objects, pgBackRest repos, TF state bucket itself
│   │                   #   (imported, not created — see bootstrap note), lifecycle rules
│   └── monitoring/     # mon-1 node + Grafana/Prometheus/Loki volumes, alert routes
└── envs/
    ├── staging/        # 1× combined node + its DNS + a staging R2 bucket set
    │   ├── main.tf     #   module instantiations, counts, sizes
    │   ├── backend.tf
    │   └── terraform.tfvars.sops.yaml
    └── prod/           # cp-1, data-{1,2}, mon-1 per D-140
        ├── main.tf
        ├── backend.tf
        └── terraform.tfvars.sops.yaml
```

Rules: environments differ only in `envs/*` (counts, sizes, names) — modules are shared; nothing is created in provider dashboards (§71), and anything that was gets `terraform import`ed the day it's discovered.

### State backend

**Decision (D-142): Terraform state lives in a dedicated R2 bucket per environment, via the S3 backend with native lockfile locking (`use_lockfile = true`, S3 conditional writes — supported by R2).** No new vendor, encrypted at rest, versioned bucket for state history.

Two honest caveats, accepted: (1) *bootstrap circularity* — the state bucket itself can't be managed by the state it holds; it is created once by a documented `bootstrap.sh` (aws-cli against R2) and marked `prevent_destroy`; (2) *Cloudflare-account correlation* — a lost Cloudflare account would take TF state with it, so nightly `terraform state pull` copies land in the off-Cloudflare backup location (D-149). Fallback if R2 conditional-write locking misbehaves in practice: Terraform Cloud free tier, state-only (OQ-143).

### cloud-init for a data-plane node (template contents)

Rendered by the `node` module; the node is **replaceable, not precious** — config changes mean a new node + evacuate, not SSH surgery (until Phase B config management, [infra phases](01-infra-phases.md)).

```yaml
#cloud-config (abridged — the real template is versioned in infra/terraform/modules/node/)
users:            # 'ops' user, SSH key-only; root login disabled
package_update: true
packages: [docker-ce (pinned), xfsprogs, wireguard-tools, chrony, unattended-upgrades]
write_files:
  - /etc/docker/daemon.json        # API on private-net IP:2376, tlsverify, live-restore: true,
                                   #   log-driver json-file with rotation (Alloy tails these)
  - /etc/ssh/sshd_config.d/hard.conf   # key-only, no root, no forwarding
  - /etc/sysctl.d/99-steadhold.conf     # vm.overcommit_memory=2 tuning deferred; somaxconn,
                                       #   inotify limits for many containers
  - /etc/systemd/system/steadhold-nodeinfra.service   # Compose stack: SNI router, node_exporter,
                                                     #   cAdvisor, postgres_exporter, Alloy
runcmd:
  - mkfs.xfs (attached volume) && mount -o prjquota /var/lib/steadhold/projects   # D-070
  - <join private network>            # Hetzner cloud-net attach is TF-side; WireGuard NOT used in V1 —
                                      #   all nodes share one Hetzner private net; wireguard-tools installed
                                      #   as the ready escape hatch for future dedicated/Robot nodes (OQ-144)
  - <bootstrap node identity>         # one-time token (TF-injected, single-use, 15-min TTL) calls the
                                      #   control-plane API: registers node row, obtains Docker server cert
                                      #   + the worker's client CA, exporter scrape creds  — this replaces
                                      #   any persistent "agent" install (D-052)
  - docker pull <postgres:17|pgbouncer|postgrest pinned digests>   # pre-pull, D-071
  - systemctl enable --now steadhold-nodeinfra
final_message: node ready; worker reconciler takes over from here
```

The control-plane and monitoring nodes use the same template with different Compose units and no project volume.

### Secrets in IaC

**Decision (D-143): SOPS + age.** Secrets (provider API tokens, bootstrap-token signing key, Grafana admin, SMTP creds) live in the repo as `*.sops.yaml`, encrypted to: each operator's age key + one CI deploy key (stored as a GitHub Actions secret) + one offline recovery key (paper, with the break-glass material from [audit & admin access](../02-control-plane/05-audit-and-admin-access.md)). Rejected: Terraform Cloud variables (splits secret truth from repo history, adds a vendor for exactly one feature) and Vault (a whole HA service to operate — Phase B at the earliest). Runtime *application* secrets are not IaC's business: they follow envelope encryption in control-plane Postgres (D-035).

### Environments

Two, only two (D-031: project == environment is the *customer* story; this is ours):

| | staging | prod |
|---|---|---|
| Shape | 1 combined node (all roles), scaled-down mirror — same modules, same Compose units, same images | Per D-140 |
| Data | Synthetic + isolation-suite fixtures; wiped freely | Customer data |
| DNS | `*.staging.steadhold.app` | `*.steadhold.app` |
| Gets deploys | **Every merge to main, automatically** | Only after staging gates pass + manual approval |
| Isolation suite | Full destructive matrix per deploy + hourly (D-084) | Non-destructive canaries daily |

Staging's known blind spot, stated honestly: one combined node cannot catch cross-node bugs (routing to a remote data node, cross-node restore). Mitigation: the e2e suite runs one cross-node scenario against a second ephemeral staging data node spun up by TF for the run and destroyed after (~€0.10/run at hourly billing).

### CI/CD pipelines (GitHub Actions)

**Per-PR** (required checks, ~5–10 min): lint + typecheck (Turborepo-cached) → unit tests → integration tests against the local Compose stack (`steadhold dev` components, D-027 — Postgres 17, PgBouncer, PostgREST, MinIO, Redis) → build affected images (no push) → `terraform validate` + plan-dry-run on `envs/staging` when `infra/` changed. No deploy from PRs.

**Main merge:**

```text
build: images for changed services → push GHCR, tag = git SHA (immutable) + branch tag
  └─ deploy-staging: render release manifest → roll staging node → smoke
       └─ gates on staging: e2e golden path (§119 flow) + FULL isolation suite (D-084/D-085 —
          red freezes ALL releases, not just this one) + migration-rollback rehearsal
            └─ [manual approval: GitHub environment "prod", any engineer, see D-145]
                 └─ deploy-prod: progressive node-by-node (mechanics below)
                      └─ post-deploy: prod smoke + canary isolation subset + 30-min alert watch;
                         auto-halt (not auto-rollback) on new page-level alert
```

**Image strategy:** monorepo builds **per-service images** — `ghcr.io/steadhold/{api,worker,gateway-caddy,dashboard}`; the per-project data-plane images (`postgres:17`, PgBouncer, PostgREST) are upstream images pinned by digest and *referenced* by, not built from, the manifest. Registry: **GHCR** — already where the code is, free for private, one fewer vendor. Tags are git SHAs; `latest` does not exist; staging/prod difference is which manifest is applied, never which tag floats.

### Deploy mechanics without K8s

**The release manifest is the unit of deploy and rollback (D-144).** A versioned YAML in the repo (`infra/releases/`), produced by CI on main:

```yaml
# infra/releases/2026-08-27.2.yaml
release: 2026-08-27.2
git_sha: 3f9c2ab
images:
  api:      ghcr.io/steadhold/api@sha256:…
  worker:   ghcr.io/steadhold/worker@sha256:…
  dashboard: ghcr.io/steadhold/dashboard@sha256:…
project_stack:                 # consumed by the reconciler's container templates (D-070 §3)
  postgres:  postgres:17.6@sha256:…
  pgbouncer: bitnami/pgbouncer@sha256:…
  postgrest: postgrest/postgrest@sha256:…
control_plane_migrations_through: 0042_add_node_cordon_reason
compose_templates_version: 14   # infra/compose/*.hbs at this tag
```

Rolling a release, node by node with health gates:

1. **Migrate first** (expand-only — see discipline below) against control-plane Postgres.
2. For each node in order `staging→(gate)→mon-1→cp-1→data-1→(gate)→data-2`: render that node's Compose file(s) from templates + manifest → `scp` + `docker compose up -d` over SSH (CI's deploy key; same private-net path the worker uses) → **health gate**: `/health` + `/ready` (§69) green, error-rate stable for 3 min, else halt.
3. `project_stack` image changes do **not** restart customer containers during deploy: the reconciler picks up the new template and rolls tenant containers at a bounded rate (respecting OQ-060 concurrency limits), warm pool first, paused projects at resume.
4. **Rollback = apply the previous manifest** (same pipeline, previous file). Because migrations are expand-only, old code runs on the new schema. Manifests are immutable and retained; "what is deployed" is always answerable from one file + `docker compose ps`.

**Migration-deploy ordering — expand-migrate-contract, enforced:** every control-plane migration in a release must be *additive/compatible* (new tables/columns/indexes `CONCURRENTLY`, backfills as jobs); destructive changes (drop/rename/constraint-tighten) ship **at least one release later**, once no deployed code references the old shape. CI enforces the rehearsal: staging runs new-migrations-then-*previous*-code smoke to prove rollback safety. Customer-project migrations are out of scope here — customers own those ([migrations](../03-database-platform/04-migrations.md)).

### Who can deploy prod

**Decision (D-145): solo-with-audit.** A 1–3-person team (proposal §117) cannot honestly promise a 2-person rule — it would be theater that erodes into rubber-stamping or blocks Saturday incident fixes. Instead: any engineer can approve the prod gate **alone**, and every deploy is (a) preceded by the full staging gate incl. the isolation suite — the *machine* is the second reviewer, and D-085 gives it a veto no human can override; (b) recorded in the platform audit log (actor, manifest, diff link) per [audit & admin access](../02-control-plane/05-audit-and-admin-access.md); (c) announced to the shared ops channel automatically. Revisit trigger: team ≥4 engineers or first SOC 2 conversation → move to 2-person approval on the GitHub environment.

## Decisions

- **D-142 — Terraform state lives in a dedicated, versioned R2 bucket per environment (S3 backend, native lockfile locking); the bucket is bootstrap-created outside TF and `prevent_destroy`; nightly state copies replicate to the off-Cloudflare backup location.** *(Rationale: no new vendor, encrypted, versioned; the Cloudflare-correlation risk is hedged by the D-149 second copy rather than by adding a state-hosting vendor.)*
- **D-143 — IaC secrets are SOPS+age files in the repo, encrypted to operator keys + one CI key + one offline recovery key; runtime application secrets stay under D-035 envelope encryption and never enter Terraform.** *(Rationale: secret history rides git; no Vault to operate and no TF-Cloud vendor for one feature; the split keeps IaC secrets (few, slow) apart from tenant secrets (many, hot).)*
- **D-144 — The unit of deploy and rollback is an immutable versioned release manifest (service image digests, project-stack digests, migration watermark, template version); deploys render Compose per node and roll node-by-node behind `/health`+`/ready`+error-rate gates; rollback is applying the previous manifest; control-plane migrations follow expand-migrate-contract with destructive changes deferred one release and rollback rehearsed in staging.** *(Rationale: this is the K8s-rollout feature set rebuilt at Compose scale — one file answers "what is deployed", one command undoes it; expand-only migrations are what make manifest rollback a real guarantee instead of a hope.)*
- **D-145 — Prod deploys are solo-with-audit: single-engineer approval, gated by the full staging suite (isolation suite red = frozen, D-085), audit-logged and auto-announced; upgrade to a 2-person rule at ≥4 engineers or first compliance demand.** *(Rationale: a 2-person rule at headcount ≤3 is theater that either rubber-stamps or blocks incident response; the honest control at this size is a machine gate with veto power plus an immutable trail.)*
- Registry is GHCR, images tagged by git SHA with digest pins in manifests; no floating tags. *(Folded into D-144's manifest discipline.)*

## Open Questions

- **OQ-143** — If R2's S3-conditional-write lockfile proves unreliable under concurrent CI runs, fall back to Terraform Cloud (state-only)? Decide after 3 months of staging usage.
- **OQ-144** — WireGuard mesh: required the day a Hetzner Robot/dedicated node (OQ-140) or any second location joins, since Hetzner Cloud private nets don't extend there cleanly (vSwitch caveats). Pre-build the module in Phase B or on first need?
- **OQ-145** — Ephemeral second staging data node per e2e run vs a standing one (~€29/mo): cost vs pipeline latency (~2 min node boot). Start ephemeral; revisit if e2e flakes.

## Dependencies

- Builds on: [01-infra-phases.md](01-infra-phases.md) (D-140/D-141, node inventory), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-022, D-023, D-027, D-035), [../06-security/03-tenant-isolation-tests.md](../06-security/03-tenant-isolation-tests.md) (D-084/D-085 gates), [../02-control-plane/05-audit-and-admin-access.md](../02-control-plane/05-audit-and-admin-access.md)
- Feeds: [03-observability.md](03-observability.md) (deploy health gates consume its metrics), [04-disaster-recovery.md](04-disaster-recovery.md) (node rebuild = this doc's cloud-init path), [../13-quality/01-testing-strategy.md](../13-quality/01-testing-strategy.md), [../13-quality/02-release-and-versioning.md](../13-quality/02-release-and-versioning.md)
