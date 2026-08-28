# Backups & PITR

## Purpose

Implements D-019: pgBackRest per project with continuous WAL archiving to object storage, PITR, restore-always-to-new (proposal §36), retention by plan (§35), and — expanding the proposal's three words "test actual recovery" (§92) into a system — automated restore verification. Also specifies the interaction with pause/resume (D-008), which the naive design silently breaks. Operating rule for everything below: **a backup that has not been restore-tested is treated as not existing.**

## Design

### 1. Repo-per-project in object storage

One pgBackRest **stanza and repo path per project**, in R2 (D-017, D-023). Repo-per-project is what makes per-project retention, per-project encryption keys, per-project deletion (D-038 requires provable destruction), and per-project restore all trivial — a shared repo would entangle every one of those.

```ini
# /etc/pgbackrest/pgbackrest.conf  (rendered per project on its node)
[global]
repo1-type=s3
repo1-s3-endpoint=<account>.r2.cloudflarestorage.com
repo1-s3-bucket=corebase-backups-eu-central
repo1-s3-region=auto
repo1-retention-full-type=time
process-max=2                       # small tenants; bounded so backups can't starve neighbors
compress-type=zst
compress-level=3
start-fast=y                        # immediate checkpoint at backup start

[<project_id>]
pg1-path=/data/projects/<project_id>/pgdata
repo1-path=/projects/<project_id>
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<per-project secret>          # see §6
repo1-retention-full=<per plan, §3>
```

Postgres side (already in the [provisioning config template](01-postgres-provisioning.md)):

```ini
archive_mode = on
archive_command = 'pgbackrest --stanza=<project_id> archive-push %p'
archive_timeout = 300      # Free — forces a WAL segment switch at least every 5 min
                           # 60 on Pro and above (bounds RPO at ~1 min)
```

`archive-push` runs asynchronously with a small spool (`archive-async=y`, spool on the project volume — inside the disk quota, so a runaway spool is the tenant's ceiling, not the node's). **Archiving failure is a first-class alert**: WAL-archive lag alerts at **>5 min (warn)** and **>15 min (page)** per the [observability](../11-infrastructure/03-observability.md) alert catalog; the `pgbackrest check` job that runs every 15 min per project via the node agent feeds that same alert rather than owning a separate threshold — a project whose WAL isn't landing in R2 is a project whose PITR is silently rotting.

### 2. Backup schedule per plan

Small databases make fulls cheap; incrementals earn their complexity only when fulls stop being cheap.

| Plan | Base backups | WAL archiving | Rationale |
|---|---|---|---|
| Free | Nightly **full** (03:00–06:00 local region, jittered) | Continuous, `archive_timeout = 300` | DB cap is small (per [pricing](../12-business/02-pricing-and-plans.md)); a full of ≤500 MB compressed is trivial; no incremental chain to verify |
| Pro | Weekly **full** + nightly **incremental** | Continuous, `archive_timeout = 60` | Bigger DBs; weekly full bounds the restore chain length (≤7 links) |
| Team | Weekly full + nightly incremental (+ 6-hourly incrementals when DB > 20 GB) | Continuous, `archive_timeout = 60` | Shorter replay distance for large DBs |
| Enterprise | Custom | Custom | Not V1 (D-003) |

Scheduling is a control-plane job per project (BullMQ, D-018) — *not* per-node cron — so the scheduler can jitter backups across the node fleet, skip paused projects (§7), and record every run's outcome in `backup_runs(project_id, type, started_at, finished_at, size_bytes, wal_start/stop, status, error)`.

### 3. Retention per plan *(provisional — numbers align with [pricing & plans](../12-business/02-pricing-and-plans.md) and move with it)*

| Plan | PITR window (restore to any second within…) | Backup retention | Implementation |
|---|---|---|---|
| Free | **7 days** | 7 daily fulls | `repo1-retention-full=7` (time) |
| Pro | **30 days** | 5 weekly fulls + incrementals + 30 d WAL | `repo1-retention-full=35` (time) — slack so day-30 PITR always has a base older than the target |
| Team | **90 days** | 14 weekly fulls + incrementals + 90 d WAL | `repo1-retention-full=98` (time) |

Notes: WAL expiry follows full-backup expiry in pgBackRest, so the retention-full window is the PITR window; R2's zero egress (D-017) means retention cost is storage-only, which is why even Free gets true PITR — it is a differentiation-lane feature (D-006) that costs cents. Deleted projects: the 7-day recovery window (D-038) is the pre-purge recovery period; the restore-verified final backup is kept **30 days past purge** (D-066), and only after purge + 30 d does `pgbackrest stop` + repo path destruction run, with the destruction recorded in the audit log.

### 4. Restore-to-new-instance flow (the only restore flow)

Production is never overwritten (§36). Customer picks a target time in the dashboard (bounded by their PITR window) →

1. **Provision** a fresh stack for the restore target — normal provisioning path ([provisioning §4](01-postgres-provisioning.md)) but skipping base-schema init (the restore brings everything), placed by the same bin-packing (§7 there). Status: `RESTORING`.
2. **Restore**: `pgbackrest --stanza=<project_id> restore --type=time --target='2026-08-27 14:03:00+00' --target-action=pause` into the new volume. pgBackRest picks the correct base backup + chain automatically.
3. **Recover**: start Postgres; it replays WAL to the target; with `--target-action=pause` the instance holds at the target for inspection; the restore job then promotes it (`pg_wal_replay_resume`) once replay confirms the target was reached. Failure to reach the target (missing WAL) fails the job loudly — never silently serve an earlier point.
4. **Credentials**: the restored cluster contains the *original* roles; the restore job resets the `developer` password to a fresh secret ([credentials §4a](03-credentials-and-secrets.md)) and rewires `authenticator`/`pgbouncer_auth` to new internal secrets. The restored instance gets its own connection string and (dashboard-only) endpoint.
5. **Customer validates** against the new endpoint — SQL editor, their app pointed at the new URL, row spot-checks. The restored instance runs with API access disabled by default (it is a copy, and double-serving live traffic against two databases is a data-loss generator).
6. **Optional promote** — which is a **credential/endpoint swap, not a data move**: control plane repoints the project's routes (gateway project-resolution entry, SNI routes, DNS name) at the new stack, swaps the active connection strings, and marks the old stack `retired` (kept **72 h** for regret, then destroyed; its final state is captured by a last backup first). Promote is explicit, confirmed, audited.
7. If not promoted, the restored instance auto-expires after 48 h (it bills as a temporary instance on paid plans; one free restore-validate at a time on Free).

Same flow serves: point-in-time recovery, "clone my prod as of yesterday into a scratch project", node-loss recovery (target = latest), and resume-onto-a-different-node ([provisioning §5](01-postgres-provisioning.md)).

### 5. RTO/RPO honesty table

RPO is bounded by `archive_timeout` plus archiving lag; RTO is dominated by base-backup download + WAL replay distance, so it scales with DB size and time-since-last-base. No SLA is offered at V1 (§68) — these are engineering targets, published as such:

| Plan | RPO (worst case) | RTO target (DB ≤ 1 GB) | RTO target (10 GB) | RTO target (50 GB) |
|---|---|---|---|---|
| Free | ≤ ~5 min | < 10 min | n/a (over plan cap) | n/a |
| Pro | ≤ ~1–2 min | < 10 min | < 30 min | < 90 min |
| Team | ≤ ~1–2 min | < 10 min | < 25 min | < 60 min (6-hourly incrementals shorten replay) |

Honesty notes we publish verbatim: WAL not yet archived at the moment of a node loss is gone — RPO is not zero and no daily-backup product's is; a restore's wall-clock time includes queueing if many projects restore at once (node loss), and the restore fleet is sized for single-node blast radius, not region loss ([disaster recovery](../11-infrastructure/04-disaster-recovery.md) owns the bigger scenario).

### 6. Backup encryption

- pgBackRest repo encryption: `aes-256-cbc` with a **per-project cipher-pass**, generated at provision, stored envelope-encrypted in the control plane (D-035, [credentials §3](03-credentials-and-secrets.md)), rendered into the node-side config root-only. Compromise of the R2 bucket alone yields ciphertext.
- R2 server-side encryption on top (defense in depth), bucket-scoped API token per region, write-mostly: nodes hold tokens allowing put/get/list on their projects' prefixes; **delete rights live only with the control plane** — a compromised node can read its own tenants' encrypted repos but cannot destroy history.
- Cipher-pass rotation is repo re-creation ([credentials §4d](03-credentials-and-secrets.md)) — compromise-only.

### 7. Automated restore verification (D-019 made operational)

The scheduler runs a **continuous verification loop**, not a monthly ceremony:

- **Sampling**: the verifier runs **weekly batches**, prioritizing never-verified and longest-unverified backup chains, with binding per-plan floors (D-176): **every project's backups are restore-verified at least every 90 days (Free) and 30 days (Pro/Team)**. Every *paused* project is verified once within 30 days of pausing (its backup is its only life, §8).
- **Job**: provision a scratch container on a designated verification node (not customer capacity) → `pgbackrest restore` to latest → recover → checks:
  1. recovery reached consistency and the expected timeline;
  2. `pg_amcheck --all` (btree integrity) and data-checksum verification (possible because `initdb --data-checksums`, [provisioning §3](01-postgres-provisioning.md));
  3. sanity counts: `corebase_migrations.schema_migrations` row count matches control-plane knowledge; the five largest user tables return `count(*) > 0` where the live stats say they're non-empty;
  4. wall-clock restore time recorded → feeds the §5 RTO table with *measured* numbers instead of aspirations.
- **Record**: `restore_verifications(project_id, backup_label, started_at, duration, result, failure_reason)`; per-project `last_verified_restore_at` surfaces in the ops dashboard; fleet metric "% of projects verified in last 90 d" is a standing SLO.
- **Failure = page**, at the same severity as a failed backup, because it is one: the runbook treats the project's backups as nonexistent until a verified backup exists (immediate fresh full + re-verify).
- `pgbackrest verify` (repo-side checksum audit) additionally runs monthly per repo — cheap, catches bit-rot without a full restore.

### 8. Pause/resume interaction (D-008 × D-019)

A paused project has no running Postgres ⇒ **WAL archiving stops with the container**. Unhandled, that means a paused project's PITR window silently ages out while its only current state sits on one node's disk. Therefore (**D-077**):

- **On pause** (step 2 of the [pause procedure](01-postgres-provisioning.md)): take a final backup — incremental if the chain is fresh (< 7 d since last base), else full — after the final checkpoint, and confirm the last WAL segment archived (`pgbackrest check`) **before** the container stops. Pause does not complete until the project is restorable from R2 alone.
- **While paused**: retention expiry is **frozen** — the final backup chain and its WAL are pinned regardless of age (a pgBackRest expire exclusion managed by the scheduler). The PITR *window* is frozen at the pause instant; nothing new to protect, nothing allowed to rot. Verification per §7 covers paused projects on their own cadence.
- **On resume**: archiving resumes with the container; the scheduler takes a fresh incremental within the first hour, and normal retention/expiry unfreezes.

## Decisions

**D-077 — Backup policy per plan *(numbers provisional with pricing)*: Free = nightly full + continuous WAL (`archive_timeout=300`), 7-day PITR; Pro = weekly full + nightly incremental (`archive_timeout=60`), 30-day PITR; Team = same + 6-hourly incrementals over 20 GB, 90-day PITR. Pause interlock: pause is not complete until a final backup + confirmed WAL archival lands in R2; while paused, expiry of the final chain is frozen; resume takes a fresh incremental within an hour.** *(Rationale: fulls-only keeps Free restores chain-free and cheap at small DB caps while R2's zero egress makes even Free-tier PITR a near-zero-cost differentiator (D-006, D-017); the pause interlock closes the hole where a paused project's only current state is one node disk with an expiring backup behind it.)*

**D-176 — Restore verification is continuous sampling with binding per-plan floors: the verifier runs weekly batches, prioritizing never-verified and longest-unverified backup chains; every project's backups are restore-verified at least every 90 days (Free) and 30 days (Pro/Team). A failed verification treats that project's backups as nonexistent: immediate fresh full backup, re-verify, page. Supersedes D-019's "monthly" clause.** *(Rationale: continuous sampling spreads restore load instead of a month-boundary thundering herd and catches never-verified chains first; the floors keep the per-plan guarantee explicit — a 180-day Free floor was too weak against D-019's monthly intent, and at a ≤500 MB Free cap a 90-day floor costs pennies.)*

(D-019 governs tooling, restore-to-new, and the verification mandate — its "monthly" verification clause is superseded by D-176 above; D-038 governs the pre-purge recovery window and D-066 the 30-days-past-purge retention of the final backup.)

## Open Questions

- **OQ-078** — Cross-region repo replication: R2 buckets are resilient but region-scoped from our access-model view; do we replicate backup repos to a second location (R2 → S3 deep archive?) before or after multi-region compute (D-024)? Owned with [disaster recovery](../11-infrastructure/04-disaster-recovery.md).
- **OQ-079** — Customer-visible restore self-service limits: restores are compute-costly — per-plan concurrent-restore caps and Free-tier restore frequency need numbers with [pricing & plans](../12-business/02-pricing-and-plans.md) and [abuse prevention](../12-business/03-abuse-prevention.md).

## Dependencies

- Builds on: [decision log](../00-foundation/05-decision-log.md) (D-017, D-018, D-019, D-038), [postgres provisioning](01-postgres-provisioning.md) (config template, pause procedure, placement), [credentials & secrets](03-credentials-and-secrets.md) (cipher-pass, restore credential reset), [job queue & workers](../02-control-plane/04-job-queue-and-workers.md)
- Feeds: [disaster recovery](../11-infrastructure/04-disaster-recovery.md), [observability](../11-infrastructure/03-observability.md) (archiving/verification alerts), [pricing & plans](../12-business/02-pricing-and-plans.md), [risk register](../15-risks/01-risk-register.md), [dashboard IA](../09-dashboard/01-dashboard-ia.md) (Backups screen)
