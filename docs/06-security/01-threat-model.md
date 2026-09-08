# Threat Model

## Purpose

The structured threat inventory for Steadhold, organized by trust boundary rather than by STRIDE category (every entry still names spoofing/tampering/info-disclosure/DoS/elevation implicitly through its vector and impact). The proposal touched security in §20, §47, §49–50, §65–67 and §74 but analyzed only the API path; this doc adds the boundary the proposal missed entirely — **what a tenant can attempt from inside SQL on a shared node** — and closes with the accepted-risks register: what V1 consciously does not defend against, and why that is acceptable under the priority stack (D-002: isolation & security first, but scoped to a three-person team shipping a V1).

Scoring: **Likelihood** and **Impact** are High/Med/Low, judged for a public BaaS in its first year. Anything High/High is a launch blocker if unmitigated.

## Design

### Trust boundaries

```
(a) Internet ──► Cloudflare ──► Gateway            (public edge)
(b) Tenant A ──► Gateway ──► Project B's API       (cross-tenant, API path)
(c) Tenant A SQL ──► shared node resources         (cross-tenant, SQL path)  ◄— missed by the proposal
(d) Tenant container ──► node kernel / other containers   (container escape)
(e) Anyone ──► control plane                       (crown jewels)
(f) Upstream code ──► our build ──► the fleet      (supply chain)
```

### (a) Internet → gateway

Context: the `anon` key is **public by design** (D-029) — it ships in browser bundles and mobile apps. Threats here must be modeled assuming every attacker already holds a valid anon key for any project they care about.

| Threat | Actor | Vector | Impact | Likelihood | Mitigation | Residual risk |
|---|---|---|---|---|---|---|
| Credential stuffing against auth endpoints | Botnets with breached password lists | `POST /auth/v1/token` with email/password pairs; anon key is public so nothing gates the attempt | Account takeover in customer apps; reputational damage to Steadhold | **High** — arrives within days of any public auth endpoint | Per-IP and per-identifier rate limits on auth endpoints (D-033, numbers in [platform security](04-platform-security.md)); timing-safe password checks; enumeration-resistant responses (identical response for unknown email vs wrong password); breached-password check deferred (accepted risk) | Slow, distributed stuffing under the rate limit still succeeds against weak passwords. Customer's problem to enforce password policy; we provide the knobs |
| Anon key scraping | Anyone | View-source on any customer's frontend | None by itself — anon key grants only what RLS grants `anon` role | **High** (certain) | This is the design (D-029): anon key ≈ project identifier + role claim. Default-deny RLS ([RLS design](02-rls-design.md)) means a scraped key with no policies yields nothing | Customers who write careless `anon` policies expose their own data. Mitigate with dashboard warnings ("table exposed to anon") and docs |
| service_role key leaked (committed to GitHub, shipped in an app) | Opportunistic scanners | Public repo scanning; the key bypasses RLS entirely | Full read/write of that project's data | **Med** — happens constantly to Supabase/Firebase users | Key rotation UI + CLI ([api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md)); docs shout "server only"; post-V1: our own GitHub secret-scanning registration for the key format | Between leak and rotation the project is fully exposed. Blast radius is one project (per-project keys, D-014) |
| Project/endpoint enumeration | Curious attackers | Guessing `<ref>.steadhold.app` subdomains | Discovery of which projects exist; each is still gated by its own keys | Low | Project refs are random (not sequential); unknown ref → generic 404 with no timing oracle; wildcard DNS means NXDOMAIN doesn't confirm anything either way | Existence disclosure of guessed refs. Harmless given key gating |
| Volumetric DDoS | Anyone with a booter | L3/L4/L7 floods on `*.steadhold.app` | Platform-wide unavailability | Med | Cloudflare in front of everything (D-016, D-023): origin IPs not published, only Cloudflare IP ranges allowed at the origin firewall; L7 limits at the gateway (D-033) | Sophisticated L7 attacks with valid anon keys degrade one project until its rate bucket empties; per-project buckets prevent cross-tenant collateral |
| Request smuggling / desync | Skilled attackers | CL/TE ambiguity between Cloudflare → origin → gateway → PostgREST hops | Cache poisoning, auth bypass on the shared gateway | Low | HTTP/1.1 normalization at Cloudflare; the gateway (Fastify) rejects ambiguous framing; **exactly one** parsing hop inside our origin (gateway → per-project PostgREST over a fresh connection, no shared reverse-proxy pool across tenants); no shared response cache in V1 | Parser differentials in dependencies. Covered by dependency pinning (boundary f) and the isolation suite's smuggling probes |
| Abuse-of-platform (mining via SQL, phishing pages in storage) | Fraudulent signups | Free tier + fake email | Cost burn, IP-reputation damage | High | Covered in [abuse prevention](../12-business/03-abuse-prevention.md): email verification before provisioning, per-plan quotas, egress caps, CPU cgroup limits (D-009) make mining uneconomical | Determined abusers with stolen cards. Ongoing operational cost, not an isolation failure |

### (b) Tenant → tenant via the API

The classic BaaS kill-shot: a token minted by project A accepted by project B. **Per-project ES256 keypairs (D-014) eliminate this class structurally** — B's PostgREST verifies signatures against *B's JWKS only*. There is no shared HMAC secret anywhere in the data plane, so there is nothing to confuse.

| Threat | Actor | Vector | Impact | Likelihood | Mitigation | Residual risk |
|---|---|---|---|---|---|---|
| A's JWT (anon, authenticated, or service_role) replayed against B | Any A tenant | Send A's token to `https://<B-ref>.steadhold.app/rest/v1/...` | Would be total cross-tenant compromise | Low (post-mitigation) | Signature verification fails: A's tokens are signed with A's private key; B verifies against B's JWKS. No fallback verifier, no shared key, ever | Key-management bug (B's JWKS accidentally containing A's key). Guarded by the isolation suite ([tests](03-tenant-isolation-tests.md)) on every deploy |
| Project-ref confusion | Attacker crafting requests | Token claims `project_ref: A` but request targets B's subdomain; or gateway resolves project from a client-controlled header instead of the SNI/Host it routed on | Cross-tenant read/write | Med if sloppy, Low as designed | **Single source of project identity: the Host header that Cloudflare routed on**, resolved once at the gateway and pinned to the request context ([request pipeline](../04-data-api/02-request-pipeline.md)). Any `project_ref` claim in the token must *match* the resolved project or the request is rejected — the claim is a cross-check, never the source. Client-supplied `X-Project-*` headers are stripped at the edge (proposal §20 adopted) | Gateway bugs. Isolation suite includes tampered-claim cases |
| Algorithm confusion (`alg=none`, ES256→HS256 downgrade using the public key as HMAC secret) | Skilled attackers | Crafted JWT headers | Auth bypass within (not across) a project | Med | Verifier pins `alg: ES256` and rejects everything else — the accepted-algorithms list is hardcoded, not read from the token; `kid` must resolve within the project's JWKS ([sessions & tokens](../05-auth/02-sessions-and-tokens.md)) | None meaningful if the pin holds; suite tests both downgrades explicitly |
| Cross-tenant data through the pooler | A tenant with their DATABASE_URL | Connect A's credentials to B's pooler port | Cross-tenant SQL | Low | Per-project pooler containers (D-015); B's PgBouncer has only B's auth entries — A's credentials fail auth; network policy additionally prevents reaching another project's pooler from outside its allowed peers (boundary c) | Credential-reuse bugs in provisioning. Suite tests A's URL against B's pooler |

### (c) Tenant → tenant via SQL — the boundary the proposal missed

The proposal's isolation test (§74) checks the API path only. But every paying tenant holds `service_role` and a **direct DATABASE_URL** — they can execute arbitrary SQL as the most privileged role we hand out. On a shared node, model the tenant's SQL session as **hostile code execution inside the container**. The design stance: **Postgres privileges are the first fence; the container boundary (D-009) is the real wall.** We harden the first fence because it's cheap, but we *assume* it fails and make the container absorb it.

What a hostile `service_role` session can attempt, and what stops it:

| Attempt | What it would achieve unmitigated | Mitigation | Residual risk |
|---|---|---|---|
| `CREATE EXTENSION` of an untrusted extension (e.g. anything with arbitrary file/exec reach) | Native code execution in the postgres process | Customer roles are **not superuser** (D-080) and lack the privileges to install non-allowlisted extensions; only the curated allowlist of trusted/vetted extensions in [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md) is even present in the image — non-allowlisted `.so`/control files are not on disk | Vulnerability in an allowlisted extension → contained by the container |
| `COPY ... TO/FROM PROGRAM 'sh ...'` | Shell execution as the postgres OS user | Requires `pg_execute_server_program` membership — never granted to customer roles (D-080). If a privilege bug lands it anyway: container runs non-root postgres, `no-new-privileges`, seccomp, read-only rootfs, cap-drop ALL (D-081); egress-deny network policy stops exfil and mining | Attacker gets shell *inside their own project's container* — annoying, not cross-tenant. Boundary (d) takes over |
| `pg_read_server_files` / `pg_write_server_files` roles; `pg_read_file()`, file-reading FDWs (`file_fdw`) | Read/write files in the postgres filesystem | Roles never granted (D-080); `file_fdw` not on the allowlist. Worst case: the container's filesystem contains only that tenant's cluster — there is nothing cross-tenant to read | Reading their own data files: no confidentiality loss |
| `dblink` / `postgres_fdw` loopback | Connect out from the DB to internal services or other projects' poolers with attacker-chosen credentials | Both are on the allowlist *conditionally* (real use cases exist) but the **network policy makes them useless as a weapon**: the postgres container's egress allows only its own pooler/PostgREST/gateway peers, the control-plane agent, and the WAL-archive object-storage endpoint (D-081). Connections toward other projects' containers, node metadata, or the internet are dropped | Loopback into the tenant's own database: harmless. If the allowlist review concludes even that is too risky, they move off the V1 allowlist (tracked in [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md)) |
| Large-object abuse: `lo_import('/etc/passwd')`, `lo_export` to disk paths | Server-side file read/write via the LO facility | `lo_import`/`lo_export` (server-side variants) require the same server-file roles — not granted. Client-side `\lo_import` only moves the tenant's own bytes. LO storage counts toward the project's disk quota so it can't be used to evade limits | None meaningful |
| Resource exhaustion: `generate_series` bombs, runaway parallel queries, temp-file floods, connection floods | Starve co-tenants on the node (noisy neighbor → DoS) | cgroup CPU/memory/blkio limits per container (D-009); `temp_file_limit`, `statement_timeout` defaults, per-project `max_connections` sized with the pooler; disk quota per volume with disk-full handling in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md) | Brief latency blips for co-tenants under pathological I/O until the cgroup throttles bite. Accepted |
| Crypto-mining in SQL (or via any code-exec foothold) | Steal compute | CPU cgroup ceilings make it slow; egress-deny blocks pool protocols; anomaly detection on sustained CPU ([abuse prevention](../12-business/03-abuse-prevention.md)) | Mining within their own paid quota — economically self-defeating |

**Non-negotiables for this boundary** (mirrored in [postgres provisioning](../03-database-platform/01-postgres-provisioning.md)):

1. The role handed to customers as "owner" is `NOSUPERUSER NOCREATEROLE` with no membership in `pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files` (D-080). Superuser exists only for the platform's provisioning agent, used through audited automation, never interactively.
2. Container hardening baseline (D-081): non-root `postgres` UID, `no-new-privileges:true`, default seccomp profile (no `unshare`, no `bpf`), `cap_drop: [ALL]` + only `CHOWN/SETUID/SETGID/DAC_OVERRIDE` for postgres startup, read-only rootfs with writable data volume and tmpfs for `/tmp`, PID limits.
3. Per-container network policy: postgres accepts connections **only** from its own pooler/PostgREST and the node agent; egress default-deny with a named allowlist (WAL archiving endpoint, DNS via the node resolver, control-plane agent). No tenant container can address another tenant's containers or the node's metadata/Docker socket.

### (d) Tenant → node (container escape)

| Threat | Actor | Vector | Impact | Likelihood | Mitigation | Residual risk |
|---|---|---|---|---|---|---|
| Kernel exploit from inside a container | Skilled attacker who first gained code exec via (c) | Kernel syscall vulnerability reachable through the seccomp filter | **Everything on the node** — all co-tenant databases | Low (requires chaining a code-exec bug with a kernel 0-day) | Minimal, current kernels: Hetzner nodes run a maintained LTS kernel with unattended security updates and a monthly reboot window; seccomp shrinks reachable syscall surface; no privileged containers on tenant nodes, Docker socket never mounted; minimal distroless-style postgres images (no compilers, no curl) | A true container-escape 0-day defeats V1. **Accepted risk** (see register) — the mitigation ladder (gVisor/Kata, VM-per-tenant for enterprise) is a post-V1 trigger, OQ-081 |
| Escape via Docker daemon / runc CVE | Same | runc/containerd vulnerability | Node compromise | Low | Pin and promptly patch the container runtime (fleet-wide version, updated via IaC — [iac & cicd](../11-infrastructure/02-iac-and-cicd.md)); subscribe to runc/containerd security lists | Same as above |
| Node-local lateral movement after escape | Same | Read other containers' volumes from the host | All projects on that node | — (consequence, not entry) | Blast radius = one node, not the fleet: nodes hold no cross-node credentials; per-node agent tokens are node-scoped; backups are encrypted with per-project keys the node doesn't hold ([backups & PITR](../03-database-platform/05-backups-and-pitr.md)) | Data of co-tenants on the compromised node. This is why isolation-sensitive customers get dedicated nodes post-V1 |

### (e) Control-plane compromise

The crown jewels: the control plane holds (references to) every project's master secrets, the KMS grant, provisioning credentials for every node.

| Threat | Actor | Vector | Impact | Likelihood | Mitigation | Residual risk |
|---|---|---|---|---|---|---|
| Control-plane API bug → cross-org data access | External attacker | AuthZ bug in `/v1` endpoints (IDOR on project IDs) | Read/modify other orgs' project metadata, trigger rotations | Med | Org-scoping enforced in one middleware chokepoint, not per-handler; UUIDs not sequential; every handler test includes a cross-org case ([testing strategy](../13-quality/01-testing-strategy.md)) | Logic bugs. Standard, continuous hardening |
| Theft of the secrets store | Attacker with control-plane DB access (SQLi, backup theft, insider) | Dump `project_secrets` | Without envelope encryption: every project's credentials | Med | **Envelope encryption (D-035)**: table holds ciphertext + wrapped data keys; master key lives in the KMS, never in the DB or its backups. DB dump alone is useless | Attacker with *both* DB access and a live KMS grant wins. Minimize KMS grant holders (see least-privilege matrix in [platform security](04-platform-security.md)) |
| Malicious/compromised operator | Insider, phished operator | Standing admin access to customer DBs | Silent exfiltration | Low | **No standing access** (proposal §66 adopted): JIT grants with reason + expiry + full session audit, break-glass separately alarmed — [audit & admin access](../02-control-plane/05-audit-and-admin-access.md) | A JIT-approved operator can still act maliciously *during* the window, visibly. Audit review is the detective control |
| Worker credential theft | Attacker on a compromised node | Node agent's credentials reused against other nodes | Fleet-wide provisioning control | Low | Per-node scoped tokens; workers command nodes, nodes never command workers; token rotation on node rebuild | Control-plane-side worker compromise is close to game over — accepted as the thing the whole section defends |

### (f) Supply chain

| Threat | Vector | Mitigation | Residual risk |
|---|---|---|---|
| Malicious npm dependency | Typosquat / hijacked package in the TS monolith (D-010) | pnpm lockfile committed and frozen in CI (`--frozen-lockfile`); dependency-review + audit gate in CI ([iac & cicd](../11-infrastructure/02-iac-and-cicd.md)); minimal dependency policy; Renovate with cooldown days rather than auto-merge on day-0 releases | A compromised *existing* dependency inside the cooldown window. Industry-wide residual |
| Poisoned base image (postgres, PgBouncer, PostgREST) | Upstream registry compromise | Pin by **digest**, not tag; build our own fleet images from pinned digests in CI; store in our registry; image signature/digest verification at deploy | Upstream compromise before our pin. Low |
| Compromised CI | Secrets exfil from pipeline | CI holds deploy credentials only via short-lived OIDC-issued tokens, no long-lived secrets in CI config; protected branches; review required before deploy workflows run | GitHub-side compromise. Accepted |

### Accepted-risks register (V1)

Explicitly *not* defended against in V1, per D-002's cost/breadth trade-offs. Each has a named trigger for revisiting.

| # | Accepted risk | Why acceptable now | Revisit trigger |
|---|---|---|---|
| AR-1 | Kernel/container-escape 0-days defeat node-level isolation | Mitigating (gVisor, Kata, microVMs) costs performance and ops complexity a 3-person team can't carry; attacker cost is very high; blast radius is one node | First enterprise customer, or any public runc/kernel escape exploited in the wild against a comparable platform (OQ-081) |
| AR-2 | No mTLS between internal services (private network + service tokens instead) | Single-region private network (D-024), small service count; mTLS cert rotation is real ops load | Second region, or any third-party software on the internal network — see [platform security](04-platform-security.md) |
| AR-3 | No formal SOC 2 / ISO 27001 program | Audit costs and process load pre-PMF; controls are being built audit-shaped (audit log, JIT access, envelope encryption) so certification is a paperwork exercise later | First customer that contractually requires it |
| AR-4 | No paid bug bounty | Pre-1.0 code churn means bounty spend rewards rediscovery of known-immature areas; private disclosure inbox exists from day one | 1.0 + first external security review passed ([platform security](04-platform-security.md)) |
| AR-5 | Slow distributed credential stuffing below rate limits | Indistinguishable from legitimate traffic without device fingerprinting; that's a post-V1 feature | Auth abuse observed in prod metrics |
| AR-6 | Side channels between co-tenants (timing, cache, Spectre-class) | Requires same-node adjacency + enormous skill; no practical BaaS exploits its class publicly | Enterprise/dedicated tier ships anyway, mooting it for sensitive customers |
| AR-7 | Malicious insider with KMS grant + DB access colluding roles | Two-person integrity for KMS operations is not practical at 3 people | Team ≥ ~8 engineers: split KMS admin from DB admin |

## Decisions

- **D-080 — Customer-facing database roles are never superuser and never members of `pg_execute_server_program`, `pg_read_server_files`, or `pg_write_server_files`; the strongest customer role is a `NOSUPERUSER NOCREATEROLE` owner role, and superuser exists only for the platform's audited provisioning agent.** *(Rationale: removes the entire named class of SQL-level escapes — COPY TO PROGRAM, server-file reads, lo_import server-side — at zero DX cost; tenants keep full DDL/DML over their own database.)*
- **D-081 — Container hardening baseline for every tenant container: non-root postgres, `no-new-privileges`, default seccomp profile, `cap_drop: ALL` plus the minimal postgres set, read-only rootfs with a dedicated writable data volume, PID limits, and a per-container network policy where postgres is reachable only from its own pooler/PostgREST/gateway and node agent, with egress default-deny plus a named allowlist (WAL archive endpoint, DNS, control-plane agent).** *(Rationale: the container is the real isolation wall under D-009; assuming the Postgres privilege fence fails, this baseline turns "code exec in the DB" into "code exec in a box that can reach nothing," blocking exfiltration, mining, and lateral movement.)*

## Open Questions

- **OQ-080 — Exact egress allowlist mechanics for tenant postgres containers:** WAL archiving needs the object-storage endpoint and legitimate `postgres_fdw` use cases may need customer-defined destinations. Options: (a) strict deny + platform-proxied WAL push, (b) NAT egress restricted to named endpoints, (c) per-project customer-editable egress rules (post-V1). Decide during provisioning implementation; owner: infra.
- **OQ-081 — Stronger-than-runc sandboxing (gVisor / Kata / Firecracker) evaluation:** measure the I/O penalty on Postgres workloads before the enterprise tier; the trigger conditions are in AR-1.

## Dependencies

- Builds on: [multi-tenancy & isolation](../01-architecture/03-multi-tenancy-and-isolation.md), [extensions & upgrades](../03-database-platform/06-extensions-and-upgrades.md), [api-keys-and-roles](../04-data-api/03-api-keys-and-roles.md), [sessions & tokens](../05-auth/02-sessions-and-tokens.md), [audit & admin access](../02-control-plane/05-audit-and-admin-access.md), [credentials & secrets](../03-database-platform/03-credentials-and-secrets.md)
- Feeds: [RLS design](02-rls-design.md), [tenant isolation tests](03-tenant-isolation-tests.md), [platform security](04-platform-security.md), [postgres provisioning](../03-database-platform/01-postgres-provisioning.md), [risk register](../15-risks/01-risk-register.md), [abuse prevention](../12-business/03-abuse-prevention.md)
