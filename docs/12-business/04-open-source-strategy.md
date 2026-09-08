# Open-Source Strategy

## Purpose

Resolves proposal §3.3 ("open-source friendly") and §113 ("Steadhold OSS + Steadhold Cloud") with the analysis the proposal skipped — flagged in the [critical review](../00-foundation/03-critical-review.md) as contradiction C-2 and a missing-topic row ("licensing analysis... invites a strategic mistake; see every relicensing drama 2018–2024"). The failure mode this doc exists to prevent: open everything under a permissive license in a burst of principle, get free-ridden or overwhelmed, then relicense under pressure and burn the community trust that was the point.

The decided position (D-034) is recorded in the [decision log](../00-foundation/05-decision-log.md); this doc supplies the reasoning, the license primer, the concrete trigger conditions for opening the server, and what "self-hostable" actually means.

## Design

### A. The strategic options, compared honestly

| Option | What it is | Upside | Downside | Verdict |
|---|---|---|---|---|
| **(a) Fully-open AGPL core, day one** | Supabase-style: server code public from the first commit | Maximum trust and community story; contributions; "portability" claim backed by inspectable code; recruiting signal | **Cloud competitors** can host it (AGPL deters but doesn't stop hyperscalers with service wrappers); **support/issue burden lands pre-PMF** on a 3-person team; public API churn becomes breaking churn for self-hosters; security issues get public before we can staff response | Right *destination*, wrong *day one* for this team size |
| **(b) Delayed opening under FSL/BSL** | Sentry/HashiCorp-style: build private, open under a source-available license when ready | Keeps every option alive; zero pre-PMF OSS tax; license converts to true OSS on a timer (FSL→Apache-2.0 after 2 years) | Weaker community story at launch ("trust us, it's coming"); source-available ≠ OSI-open and critics will say so; HashiCorp's *relicense* (open→BSL) burned trust — though moving the *other* direction (closed→FSL) avoids that trap | Viable; the trust story needs the SDK/CLI + export to carry it early |
| **(c) Open-core split** | OSS data plane (the per-project stack), closed control plane (provisioning, billing, fleet ops) | Matches the architecture split (§121) naturally — the data plane is mostly *already* OSS components (Postgres, PgBouncer, PostgREST) + our glue; control plane is where the cloud business lives; the [local dev stack](../10-cli-and-sdk/02-local-development.md) ≈ the open half already | The "interesting" Steadhold-authored code (auth service, gateway, storage API) straddles the line; drawing it wrong invites either free-riding or a hollow "open" claim | Structurally correct; sequencing still needed — this composes with (b) |
| **(d) Closed forever** | Proprietary cloud only | No OSS costs at all | Contradicts principle §3.3 and the portability lane (D-006): "you can leave anytime" rings hollow when nothing is inspectable and self-hosting is impossible; kills a real differentiator vs Firebase | **Rejected** |

The decided position (D-034) is **(b) sequenced into (c)**: open the edges immediately (SDK/CLI, Apache-2.0), keep the server private until triggers fire, open it as source-available FSL with the control/data-plane line determining what opens first.

### B. License primer (the table the proposal never made)

| License | Type | What it permits | Hosted-competitor question | Who uses it |
|---|---|---|---|---|
| **MIT / Apache-2.0** | Permissive OSS (OSI) | Anything, incl. proprietary forks and competing hosted services. Apache-2.0 adds an explicit patent grant (prefer it over MIT for anything substantial) | **No protection at all** — AWS can host it tomorrow | React, Postgres (similar), Supabase's client libs, most SDKs |
| **AGPL-3.0** | Copyleft OSS (OSI) | Use/modify/host, but network use = distribution: hosts must publish their modifications | Deters casual competitors; does **not** stop a determined hyperscaler running unmodified code with proprietary tooling around it (the MongoDB experience) | Grafana, MinIO (historically), Supabase server components |
| **BSL 1.1** | Source-available, **not** OSS | Read/modify/self-host per grant; **production/competing use restricted** until the change date (≤4 yrs) → converts to Apache-2.0 | Yes — competing hosted service is exactly what the Additional Use Grant excludes | MariaDB (originator), HashiCorp (post-2023), CockroachDB (variant) |
| **FSL** | Source-available, **not** OSS | Like BSL but simpler and fixed: free for everything except competing use; **auto-converts to Apache-2.0/MIT after 2 years, per release** | Yes — "competing use" excluded for the 2-year window; then fully open | Sentry (originator), GitButler |
| **ELv2** | Source-available, **not** OSS | Use/modify/redistribute; may not provide the software **as a managed service** or break license keys | Yes — the managed-service clause is the whole point; no time-based conversion | Elastic (post-2021), n8n |

Notes for the decision:
- FSL over BSL: same protection, less configurability to get wrong, shorter and more legible to developers, and the per-release 2-year auto-conversion is a built-in credibility mechanism — old versions become genuinely OSS without any future generosity required.
- AGPL is the strongest *OSI-approved* option and remains the candidate if the FSL choice proves too alienating; the D-034 server-license choice is explicitly *(provisional)* for this reason.
- **Never plan to move open→restricted.** Every relicensing drama (Redis, HashiCorp, Elastic) was that direction. Closed→FSL→(auto)Apache only ever gains freedom.

### C. The decided position (D-034, restated with mechanics)

1. **SDK + CLI: Apache-2.0 from first public release.** The pieces users embed in *their* codebases must be unambiguously OSS — nobody ships a proprietary-licensed client library into their app. This also carries the early community story: real, useful, genuinely open code from day one, in the repo users actually touch. Includes `steadhold export` (D-004) — the portability tool is open even while the server is not, which is the credible version of "you can leave anytime."
2. **Server components: private until the trigger conditions in §D fire.** Not secret — *private*: architecture is documented publicly (this corpus can be published), the components are named, the local stack runs them.
3. **At opening: FSL as the default license** for Steadhold-authored server components *(provisional)*, opening the **data-plane components first** (auth service, storage API, gateway glue — the things a self-hoster runs), control-plane fleet machinery (provisioner, billing, pause/resume orchestration, admin tooling) later or never — that's the open-core line from option (c), and it matches §121's plane split.
4. Third-party components keep their own licenses (Postgres/PostgREST/PgBouncer are already OSS — a fact worth stating loudly: **most of a self-hosted Steadhold data plane is upstream OSS today**).

### D. Trigger conditions for opening the server (all three required)

| # | Trigger | Measured by | Why it gates |
|---|---|---|---|
| T1 | **Platform API stable ≥ 6 months** | no breaking change to `/v1` control-plane API or data-plane contracts ([release & versioning](../13-quality/02-release-and-versioning.md)) in the window | open code freezes interfaces socially even when the license doesn't; opening mid-churn breaks every self-hoster on every release |
| T2 | **Self-host docs exist and are tested** | a third party (not the team) has stood up the stack from docs alone, on a clean machine, in < 1 day | code-dump-without-docs generates support load *and* reputational damage — the worst of both |
| T3 | **Team can absorb the issue load** | support/on-call currently < 50% of team capacity AND ≥ 1 person can own triage as a rostered duty (ASSUMPTION: roughly ≥ 4 people or post-PMF revenue) | pre-PMF, every OSS issue competes with survival; unanswered issues are worse than no repo |

Opening earlier than T1–T3 requires overturning D-098. There is deliberately **no calendar deadline** — but if T1–T3 are all true and the server is still closed, the standing default is to open, and *staying* closed becomes the position needing justification (principle §3.3 keeps its teeth).

### E. What "self-hostable" concretely means when it happens

Not "here's a tarball, good luck." The claim is bounded and testable:

- **The Docker Compose data plane from [local development](../10-cli-and-sdk/02-local-development.md) IS the self-host seed** (D-027 already mandates local/prod component parity: Postgres 17, PgBouncer, PostgREST, auth, storage+MinIO). Self-hosting V1 = that compose file, hardened: TLS, real SMTP creds, backup config, upgrade notes. One project per stack, no fleet features.
- **Explicitly in scope:** single-node, single-project (or few-project) deployment; your own domain; your own object store (MinIO/S3); pgBackRest backups.
- **Explicitly out of scope:** the multi-tenant fleet machinery — provisioning-at-scale, pause/resume economics, node placement, billing. Self-host serves "I want to run my app's backend myself," not "I want to run a Steadhold competitor" (and the FSL says the latter plainly rather than pretending).
- Version support: self-host tracks tagged releases; no support SLA, community channel only, until/unless a supported-enterprise-self-host product is ever justified (deferred with Enterprise, D-003).

### F. Community strategy sequencing

| Phase | What's public | Community surface |
|---|---|---|
| Now → launch | This planning corpus (optionally), docs site, SDK/CLI repos (Apache-2.0), `steadhold export` | GitHub issues on SDK/CLI only; Discord/community forum; changelog |
| Launch → triggers | + auth/storage/gateway design docs, self-host preview docs being drafted | contributions to SDK/CLI/docs; server issues via support, not GitHub |
| T1–T3 fire | + server repos (FSL), tested self-host guide | full public issue tracker; contribution guidelines; security policy + disclosure process **published before the repo opens** |
| +2 years rolling | each FSL release auto-converts to Apache-2.0 | the long-term credibility backstop |

Docs and SDK first, server later — the community forms around the surfaces users touch daily, and those are open from day one.

### G. Trademark basics

The code's license and the **name** are separate systems, and the name is the one that must never be open:

- Register **"Steadhold"** (word mark) in EU + US, classes covering SaaS/software (ASSUMPTION: ~€2–5k with counsel; do EU first, D-024 home turf) — *before* the server opens, ideally before launch. OQ-099 tracks the availability/clearance search, which is a prerequisite to everything here.
- Publish a short trademark policy at opening time: forks must rename ("powered by Steadhold" nominative use OK; "Steadhold Cloud Pro" not OK); the FSL restricts competing *services*, the trademark restricts competing *branding* — together they close the "host our code under our name" hole that pure code licenses leave open.
- Domains and the npm org (`@steadhold/*`) secured now; npm package squatting is cheap to prevent and miserable to fix.

## Decisions

- **D-098 — The server opens only when all three triggers hold: (T1) no breaking platform-API change for ≥ 6 months; (T2) self-host docs proven by a third party standing up the stack unaided in < 1 day; (T3) triage capacity exists (support/on-call < 50% of team time and a rostered triage owner). Once all three hold, open is the default and staying closed requires justification. No calendar deadline.** *(Rationale: makes D-034's "until the platform API stabilizes" enforceable instead of vibes; the reversed default after the triggers keeps principle §3.3 from becoming indefinitely deferrable.)*
- **D-099 — "Self-hostable" is defined as the hardened single-node Docker Compose data plane (per D-027 parity), explicitly excluding multi-tenant fleet machinery (provisioner-at-scale, pause/resume orchestration, billing); the Steadhold trademark is registered before the server opens and a fork-renaming trademark policy ships with the first open release.** *(Rationale: bounds the self-host support surface to what a 3-person team can honor; the open-core line lands exactly on the §121 plane split; trademark is the protection that survives any code license.)*

## Open Questions

- **OQ-099:** Trademark clearance: is "Steadhold" actually registrable in EU/US software classes, or does a conflict force a rename? Must be answered **before** public launch — renaming after is far costlier. (Feeds domain/npm-org spend too.)
- **OQ-106:** FSL vs AGPL final call at opening time (D-034 is provisional on this): re-evaluate against the 2027+ landscape — if source-available stigma has grown, AGPL may buy more community than the FSL's competing-use protection is worth to a post-PMF business.
- **OQ-107:** Should this planning corpus itself be published (radical-transparency marketing, fits the lane-5 story) or kept internal (competitors read the cost model too)? Cheap to decide late; decide before launch marketing.

## Dependencies

- Builds on: [../00-foundation/03-critical-review.md](../00-foundation/03-critical-review.md) (C-2, missing-licensing row), [../00-foundation/05-decision-log.md](../00-foundation/05-decision-log.md) (D-034, D-004, D-027), [../00-foundation/01-vision-and-principles.md](../00-foundation/01-vision-and-principles.md) (principle §3.3, portability), [../10-cli-and-sdk/02-local-development.md](../10-cli-and-sdk/02-local-development.md) (the self-host seed), [../13-quality/02-release-and-versioning.md](../13-quality/02-release-and-versioning.md) (T1's measurement), [../01-architecture/02-control-vs-data-plane.md](../01-architecture/02-control-vs-data-plane.md) (the open-core line)
- Feeds: [../01-architecture/05-repo-and-service-layout.md](../01-architecture/05-repo-and-service-layout.md) (repos must be structured for later opening: license headers, no secrets in history, control/data-plane package boundaries), [../14-roadmap/03-post-v1-roadmap.md](../14-roadmap/03-post-v1-roadmap.md), [../15-risks/01-risk-register.md](../15-risks/01-risk-register.md)
