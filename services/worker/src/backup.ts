import type { Docker } from './docker.ts';

/**
 * pgBackRest per project (P3a) — config rendering and the commands the sagas run.
 *
 * The design is [backups & PITR](../../../docs/03-database-platform/05-backups-and-pitr.md):
 * one stanza and one repo path per project (§1), repo encryption under a
 * per-project cipher-pass (§6), and object storage as the only destination. The
 * operating rule the whole phase hangs on is that document's first line: **a
 * backup that has not been restore-tested is treated as not existing.** Nothing
 * here claims a project is protected; it makes a repo that P3d and P3e can prove.
 */

/**
 * Where the repo lives and how to reach it. One per fleet, not per project — the
 * bucket and credentials are the node's, the *path* inside it is the project's.
 */
export interface RepoTarget {
  /**
   * Host **only** — no port. pgBackRest takes the port separately in
   * `repo1-storage-port`, and putting `host:9000` in the endpoint while the port
   * option said something else produced a 60-second connect timeout and exit 49,
   * which reads exactly like an unreachable network.
   */
  endpoint: string;
  /** Defaults to 443: pgBackRest speaks S3 over TLS and has no plain-HTTP mode. */
  port: number;
  bucket: string;
  key: string;
  secret: string;
  region: string;
  /** MinIO needs `path`; R2 accepts it. Host-style would need per-bucket DNS. */
  uriStyle: 'path' | 'host';
  /**
   * Whether to verify the store's certificate. Off against the staging store,
   * whose cert is self-signed — the protocol is still TLS either way, which is the
   * part that is not negotiable.
   */
  verifyTls: boolean;
}

export function repoTargetFromEnv(env = process.env): RepoTarget | undefined {
  const endpoint = env['SH_BACKUP_S3_ENDPOINT'];
  const bucket = env['SH_BACKUP_S3_BUCKET'];
  const key = env['SH_BACKUP_S3_KEY'];
  const secret = env['SH_BACKUP_S3_SECRET'];
  // All four or nothing. A partial configuration is how a fleet ends up with
  // projects whose archiving has been failing since they were created, because
  // `archive_command` retries forever and nothing else notices.
  if (!endpoint || !bucket || !key || !secret) return undefined;
  return {
    endpoint, bucket, key, secret,
    port: Number(env['SH_BACKUP_S3_PORT'] ?? 443),
    region: env['SH_BACKUP_S3_REGION'] ?? 'auto',
    uriStyle: env['SH_BACKUP_S3_URI_STYLE'] === 'host' ? 'host' : 'path',
    verifyTls: env['SH_BACKUP_S3_VERIFY_TLS'] !== 'n',
  };
}

/**
 * The stanza name, the same for every project.
 *
 * Not `<project_id>` as the doc's example shows. `archive_command` lives in the
 * fleet-wide `postgresql.base.conf` baked into the image, so a per-project stanza
 * name would force a per-project Postgres config file — which is precisely the
 * drift D-186 removed by ruling that the config carries only tuning. Isolation
 * comes from `repo1-path`, which is per project and lives in the rendered
 * pgbackrest.conf; two projects with a stanza called `main` cannot see each
 * other's objects because they are looking at different prefixes with different
 * cipher-passes.
 */
export const STANZA = 'main';

export interface PgbackrestResult { exitCode: number | null; stdout: string; stderr: string }

/** Where in the bucket a project's repo lives. Prefix isolation is the boundary. */
export const repoPathFor = (projectId: string) => `/projects/${projectId}`;

/**
 * Retention in **days**, by plan (backups §3) — a time policy, not a count.
 *
 * This was `count` and that was wrong. The two coincide on Free, where a nightly
 * full makes "7 fulls" and "7 days" the same thing, which is exactly why the error
 * was invisible: every project in the fleet is Free. On Pro the fulls are *weekly*,
 * so `count=35` keeps thirty-five weekly fulls — about eight months of them —
 * against a 30-day PITR promise. Roughly eight times the storage the plan is
 * priced on, discovered by nobody until the bill.
 *
 * Time also gives the guarantee the count cannot. pgBackRest expires a full older
 * than the window only if another backup at least that old remains, so there is
 * always a base older than the oldest restorable point. That is what the "slack" in
 * Pro's 35-against-30 is for: a day-30 target needs a base *before* it to replay
 * from, and a policy that expired the last such base would leave the window
 * nominally open and practically unreachable.
 */
export const PLAN_RETENTION_FULL: Record<string, number> = {
  free: 7,       // 7-day PITR window
  pro: 35,       // 30-day window + slack
  team: 98,      // 90-day window + slack
  enterprise: 98,
};

/**
 * How often each plan takes a base backup, and whether it takes incrementals
 * between them (backups §2).
 *
 * Fulls-only on Free is not laziness: at a ≤500 MB cap a compressed full is
 * trivial, and it leaves no incremental chain to verify — a restore is one link,
 * so there is no way for a middle link to be the thing that is broken.
 */
export interface BackupSchedule {
  /** Days between full backups. */
  fullEveryDays: number;
  /** Days between backups of any kind; 0 means "only fulls". */
  incrEveryDays: number;
}

export const PLAN_SCHEDULE: Record<string, BackupSchedule> = {
  free: { fullEveryDays: 1, incrEveryDays: 0 },
  pro: { fullEveryDays: 7, incrEveryDays: 1 },
  team: { fullEveryDays: 7, incrEveryDays: 1 },
  enterprise: { fullEveryDays: 7, incrEveryDays: 1 },
};

export const scheduleFor = (plan: string): BackupSchedule =>
  PLAN_SCHEDULE[plan] ?? PLAN_SCHEDULE['free']!;

/** Seconds between forced WAL switches — the RPO floor (backups §1). */
export const PLAN_ARCHIVE_TIMEOUT: Record<string, number> = {
  free: 300, pro: 60, team: 60, enterprise: 60,
};

export interface RenderArgs {
  projectId: string;
  plan: string;
  cipherPass: string;
  repo: RepoTarget;
  /** PGDATA, which the container spec owns (D-186). */
  pgPath?: string;
}

/**
 * The per-project `pgbackrest.conf`.
 *
 * `archive-async=y` with the spool on the project's volume is deliberate: an
 * async push returns to Postgres immediately and batches to the repo, and a
 * runaway spool then counts against the tenant's disk quota rather than the
 * node's free space (backups §1). `process-max=2` bounds a backup's parallelism
 * so it cannot starve the neighbours it shares a node with.
 */
export function renderPgbackrestConf(a: RenderArgs): string {
  const retention = PLAN_RETENTION_FULL[a.plan] ?? PLAN_RETENTION_FULL['free']!;
  return [
    '[global]',
    'repo1-type=s3',
    `repo1-s3-endpoint=${a.repo.endpoint}`,
    `repo1-s3-bucket=${a.repo.bucket}`,
    `repo1-s3-region=${a.repo.region}`,
    `repo1-s3-key=${a.repo.key}`,
    `repo1-s3-key-secret=${a.repo.secret}`,
    `repo1-s3-uri-style=${a.repo.uriStyle}`,
    `repo1-storage-port=${a.repo.port}`,
    `repo1-storage-verify-tls=${a.repo.verifyTls ? 'y' : 'n'}`,
    `repo1-path=${repoPathFor(a.projectId)}`,
    'repo1-cipher-type=aes-256-cbc',
    `repo1-cipher-pass=${a.cipherPass}`,
    // Days, not a count of backups — see PLAN_RETENTION_FULL.
    'repo1-retention-full-type=time',
    `repo1-retention-full=${retention}`,
    'compress-type=zst',
    'compress-level=3',
    'process-max=2',
    'start-fast=y',
    'archive-async=y',
    'spool-path=/var/lib/postgresql/data/pgbackrest-spool',
    'log-level-console=info',
    'log-level-file=info',
    'log-path=/var/log/pgbackrest',
    '',
    `[${STANZA}]`,
    `pg1-path=${a.pgPath ?? '/var/lib/postgresql/data/pgdata'}`,
    'pg1-port=5432',
    'pg1-socket-path=/var/run/postgresql',
    '',
  ].join('\n');
}

/**
 * Write the config into a running container.
 *
 * Base64 through a single `sh -c`, for the reason D-227 gave up on bind mounts and
 * one more: the file carries the repo cipher-pass, and a config assembled by
 * shell quoting is a config one character away from either breaking or leaking.
 * Base64 has no shell-significant characters, so there is nothing to quote.
 *
 * `docker exec` rather than an env var at create time, because `docker inspect`
 * shows a container's environment to anyone who can reach the Engine API — which
 * is the whole control plane — and the cipher-pass is the one secret that must
 * stay out of it.
 */
export async function writeConf(
  docker: Docker, container: string, conf: string,
): Promise<void> {
  const b64 = Buffer.from(conf, 'utf8').toString('base64');
  const cmd = `set -e
umask 077
printf '%s' '${b64}' | base64 -d > /etc/pgbackrest/pgbackrest.conf
mkdir -p /var/lib/postgresql/data/pgbackrest-spool
test -s /etc/pgbackrest/pgbackrest.conf`;
  const r = await docker.execCapture(container, ['sh', '-c', cmd]);
  if (r.exitCode !== 0) {
    throw new Error(`could not write pgbackrest.conf (exit ${r.exitCode}): ` +
      `${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  }
}

/** Run a pgBackRest command inside a project's container, as the postgres user. */
export async function pgbackrest(
  docker: Docker, container: string, args: string[],
): Promise<PgbackrestResult> {
  return docker.execCapture(container, ['pgbackrest', `--stanza=${STANZA}`, ...args]);
}

/**
 * Is this failure pgBackRest losing a race with its own archiver?
 *
 * `archive-async=y` runs a long-lived `archive-push` worker that holds
 * `/tmp/pgbackrest/main-archive-1.lock` while it batches segments to the repo.
 * Every other pgBackRest command wants that lock too, so any of them can fail
 * with exit 50 and "unable to acquire lock ... Resource temporarily unavailable"
 * simply because WAL happened to be flowing at that moment.
 *
 * It is transient and it is *more* likely the busier the project is, which is the
 * worst possible correlation: the projects whose backups matter most are the ones
 * whose backup commands lose this race. Discovered on a saga replay, where WAL was
 * already moving — the first run had a quiet database and never hit it.
 */
export const isLockContention = (output: string): boolean =>
  /unable to acquire lock/i.test(output) && /Resource temporarily unavailable/i.test(output);

/**
 * Run a pgBackRest command, waiting out the archiver rather than failing the saga.
 *
 * Linear rather than exponential backoff, because the thing being waited on is a
 * batch push that finishes on its own schedule — doubling the delay just
 * overshoots. Bounded: if the lock is still held after this, something is stuck
 * and a saga that keeps waiting is a saga that never reports it.
 */
export async function withLockRetry(
  run: () => Promise<PgbackrestResult>,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<PgbackrestResult> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 750;
  let last: PgbackrestResult | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await run();
    if (last.exitCode === 0) return last;
    if (!isLockContention(last.stdout + last.stderr)) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last!;
}

/**
 * The part of pgBackRest's output worth putting in an error.
 *
 * Every command opens by echoing its full option list — endpoint, paths, every
 * `repo1-*` setting — so the first several hundred characters are guaranteed to be
 * the same banner whatever went wrong. Slicing from the front produces an error
 * message that reliably contains no information about the error, which is how a
 * failing `stanza-create` came back as a wall of configuration.
 *
 * So: the `ERROR:` lines if there are any, else the tail.
 */
export function pgbackrestFailure(output: string, limit = 600): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => /ERROR|WARN|HINT/.test(l));
  const useful = errors.length ? errors : lines.slice(-4);
  return useful.join(' | ').slice(-limit);
}

/**
 * Create the stanza, idempotently.
 *
 * `stanza-create` on an existing stanza exits non-zero with a message saying so,
 * which is a success for a saga step that may replay. `--no-online` is *not*
 * passed: the point of creating it online is that pgBackRest checks it can reach
 * both the database and the repo, so a broken configuration fails here rather
 * than at the first `archive-push` — where the only symptom is WAL quietly piling
 * up on the tenant's disk.
 */
export async function stanzaCreate(
  docker: Docker, container: string,
): Promise<{ created: boolean; output: string }> {
  // A longer lock budget than every other command, and for a reason specific to
  // this one: `stanza-create` runs while the archiver is *failing in a loop*.
  // The container archives from the moment it is healthy, `archive-push` cannot
  // succeed until the stanza exists, and async retries keep re-taking
  // `main-archive-1.lock` the whole time. Every other pgBackRest command runs
  // against a working repo, where the lock is held only for the length of a real
  // push.
  //
  // The default 6 s was enough on a quiet machine and not on a loaded CI runner,
  // where it surfaced as `stanza-create failed (exit 50): unable to acquire lock`
  // and cost the saga a whole retry. 30 s is still bounded — a lock held that
  // long really is stuck — and it removes the retry rather than hiding it.
  const r = await withLockRetry(
    () => pgbackrest(docker, container, ['stanza-create']),
    { attempts: 20, delayMs: 1500 });
  const out = (r.stdout + r.stderr).trim();
  const alreadyThere = /already exists|is already up to date/i.test(out);
  // Exit 0 alone does not mean "created": pgBackRest is idempotent here and
  // reports success either way, distinguishing the two only in the text. A step
  // that logs "stanza created" on every replay is a step whose log cannot be used
  // to tell a first provision from a fifth retry.
  if (r.exitCode === 0) return { created: !alreadyThere, output: out };
  if (alreadyThere) return { created: false, output: out };
  throw new Error(`pgbackrest stanza-create failed (exit ${r.exitCode}): ${pgbackrestFailure(out)}`);
}

/** `pgbackrest check` — the health signal the archive-lag alert reads (backups §1). */
export async function check(
  docker: Docker, container: string,
): Promise<{ ok: boolean; output: string }> {
  const r = await withLockRetry(() => pgbackrest(docker, container, ['check']));
  return { ok: r.exitCode === 0, output: (r.stdout + r.stderr).trim() };
}

export interface BackupEntry {
  label: string;
  type: string;
  /** Bytes this backup occupies in the repo. */
  repoBytes: number;
  walStart?: string;
  walStop?: string;
}

export interface BackupInfo {
  /** Backup labels present in the repo, oldest first. */
  labels: string[];
  /** Total repo size across all backups, in bytes, as pgBackRest reports it. */
  repoBytes: number;
  /** pgBackRest's own view of whether the stanza is usable. */
  status: string;
  /** Per-backup detail — what `backup_runs` records against a completed run. */
  backups: BackupEntry[];
}

/**
 * What the repo actually holds, from `info --output=json`.
 *
 * Parsed rather than scraped: the text output is for humans and changes between
 * releases, and a backup count read out of a shifting table is a number that goes
 * quietly wrong.
 */
export async function info(docker: Docker, container: string): Promise<BackupInfo> {
  const r = await pgbackrest(docker, container, ['info', '--output=json']);
  if (r.exitCode !== 0) {
    throw new Error(`pgbackrest info failed (exit ${r.exitCode}): ` +
      pgbackrestFailure(r.stdout + r.stderr));
  }
  const parsed = JSON.parse(r.stdout) as Array<{
    name: string;
    status?: { message?: string };
    backup?: Array<{
      label: string;
      type?: string;
      archive?: { start?: string; stop?: string };
      info?: { repository?: { delta?: number; size?: number } };
    }>;
  }>;
  const stanza = parsed.find((p) => p.name === STANZA) ?? parsed[0];
  const backups = stanza?.backup ?? [];
  return {
    labels: backups.map((b) => b.label),
    repoBytes: backups.reduce((a, b) => a + (b.info?.repository?.size ?? 0), 0),
    status: stanza?.status?.message ?? 'unknown',
    backups: backups.map((b) => ({
      label: b.label,
      type: b.type ?? 'unknown',
      repoBytes: b.info?.repository?.size ?? 0,
      ...(b.archive?.start ? { walStart: b.archive.start } : {}),
      ...(b.archive?.stop ? { walStop: b.archive.stop } : {}),
    })),
  };
}

/**
 * Take a backup. `full` for Free (no chain to verify), `incr` where a fresh base
 * already exists (backups §2).
 */
export async function backup(
  docker: Docker, container: string, type: 'full' | 'incr' | 'diff' = 'full',
): Promise<{ output: string }> {
  const r = await withLockRetry(
    () => pgbackrest(docker, container, ['--type=' + type, 'backup']),
    // A backup can queue behind a long archive batch, so it gets more patience
    // than a stanza check: failing it means the project has no fresh base.
    { attempts: 20, delayMs: 1500 });
  const out = (r.stdout + r.stderr).trim();
  if (r.exitCode !== 0) {
    throw new Error(`pgbackrest ${type} backup failed (exit ${r.exitCode}): ${pgbackrestFailure(out)}`);
  }
  return { output: out };
}

/**
 * Restore a repo into a volume (P3d, backups §4).
 *
 * `--delta` is not used: the target volume is empty by construction, since a
 * restore always goes to a freshly created project (production is never
 * overwritten). Delta would compare against files that are not there.
 *
 * `--target-action=pause` is the whole safety property. Postgres replays WAL to
 * the target and then *stops*, still in recovery, still read-only — so the control
 * plane can ask whether the target was actually reached before anything is allowed
 * to write. The alternative, `promote`, ends recovery immediately and leaves no
 * moment at which that question can be asked: a restore that ran out of WAL early
 * would come up as a perfectly healthy database holding the wrong day, and nothing
 * downstream could tell. The doc's rule is that failing to reach the target fails
 * loudly and never silently serves an earlier point; pause is what makes "loudly"
 * possible.
 */
export interface RestoreArgs {
  /** Absent means "latest" — the node-loss case, where there is no target. */
  targetTime?: Date | undefined;
}

export async function restore(
  docker: Docker, container: string, a: RestoreArgs = {},
): Promise<{ output: string }> {
  const args = ['restore'];
  if (a.targetTime) {
    /**
     * A Postgres timestamp with an explicit offset, **keeping the milliseconds**.
     *
     * The first version trimmed them — `…T11:23:16.819Z` became `11:23:16+00` —
     * which silently moves the requested instant backwards by up to a second. That
     * is not a rounding detail; it is the failure this whole flow exists to
     * prevent. It cost a real test: a row committed at `11:23:16.5` was *before*
     * the customer's target of `11:23:16.819` and after the truncated
     * `11:23:16.000`, so the restore came back correct-looking and one transaction
     * short. A customer restoring to the second before a bad migration would have
     * lost the writes in that second and had no way to tell.
     *
     * `recovery_target_time` takes fractional seconds, so there is no reason to
     * drop them. A space instead of the `T` and `+00` instead of `Z` is what
     * pgBackRest parses unambiguously.
     */
    const target = a.targetTime.toISOString().replace('T', ' ').replace(/Z$/, '+00');
    args.push('--type=time', `--target=${target}`, '--target-action=pause');
  }
  const r = await withLockRetry(
    () => pgbackrest(docker, container, args),
    { attempts: 20, delayMs: 1500 });
  const out = (r.stdout + r.stderr).trim();
  if (r.exitCode !== 0) {
    throw new Error(`pgbackrest restore failed (exit ${r.exitCode}): ${pgbackrestFailure(out)}`);
  }
  return { output: out };
}
