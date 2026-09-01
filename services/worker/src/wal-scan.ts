import type { Pool } from 'pg';
import { Client } from 'pg';
import type { Docker } from './docker.ts';
import { containerName } from './container-spec.ts';
import { check as pgbackrestCheck, pgbackrestFailure } from './backup.ts';

/**
 * WAL-archive lag, and the alert that makes it matter (P3b).
 *
 * A project whose WAL is not reaching object storage is a project whose PITR is
 * silently rotting: the database keeps serving, the dashboard keeps saying ready,
 * and the recovery window stops advancing. Nothing about that is visible from the
 * outside, which is why the alert catalog puts archive lag at **>5 min warn** and
 * **>15 min page** — the RPO promise in D-148 is 5 minutes, so 5 minutes of lag is
 * the promise already broken.
 *
 * ## What "lag" means here, and what it deliberately does not
 *
 * The obvious definition is *time since the last successful archive*, and it is
 * wrong. `archive_timeout` forces a WAL switch every 300 s on Free (D-077), so an
 * idle, perfectly healthy project archives one segment every five minutes and
 * nothing in between. Under that definition its "lag" sits at up to 300 s
 * permanently and crosses the 5-minute warn line on every sweep — the alert would
 * fire constantly for the entire free tier, and an alert that always fires is an
 * alert nobody reads.
 *
 * The honest measure is **the age of the oldest WAL segment that has been closed
 * and not yet archived**, which `pg_ls_archive_statusdir()` gives directly: each
 * `.ready` file is a segment waiting, and its modification time is when it started
 * waiting. Nothing waiting ⇒ zero lag, whatever the clock says about the last
 * push. A project that writes nothing has no lag because it has nothing to lose.
 */

/** Thresholds in seconds, from the observability alert catalog. */
export const ARCHIVE_LADDER = { warn: 300, critical: 900 } as const;

export type ArchiveState = 'unknown' | 'ok' | 'warn' | 'critical';

/**
 * Which rung a lag sits on.
 *
 * No hysteresis, unlike the disk ladder (D-251). Nothing here changes the
 * database's behaviour — the rungs are notifications — so a project flapping
 * across the line costs a duplicate Slack message rather than an application
 * seeing writes fail and succeed with no deploy.
 */
export function archiveRungFor(
  lagSeconds: number, ladder: { warn: number; critical: number } = ARCHIVE_LADDER,
): ArchiveState {
  if (lagSeconds >= ladder.critical) return 'critical';
  if (lagSeconds >= ladder.warn) return 'warn';
  return 'ok';
}

export interface ArchiveSample {
  /** Age of the oldest segment closed but not yet archived, in seconds. */
  lagSeconds: number;
  /** How many segments are waiting. */
  pending: number;
  /**
   * Optional keys rather than `| undefined` values: `exactOptionalPropertyTypes`
   * is on, so an explicit `undefined` is not an absent key and the conditional
   * spreads below would not type-check against a required field.
   */
  lastArchivedAt?: Date;
  lastArchivedWal?: string;
  failedCount: number;
  lastFailedWal?: string;
}

/**
 * The query behind the sample.
 *
 * `pg_ls_archive_statusdir()` rather than `pg_ls_dir('pg_wal/archive_status')`:
 * it is purpose-built, returns the modification time this depends on, and is
 * grantable to `pg_monitor` instead of requiring superuser — so the day this moves
 * to a least-privilege monitoring role, the query does not have to change.
 */
export const ARCHIVE_SQL = `
  SELECT
    COALESCE((SELECT count(*) FROM pg_ls_archive_statusdir()
               WHERE name LIKE '%.ready'), 0)::int AS pending,
    (SELECT extract(epoch FROM now() - min(modification))::int
       FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready') AS lag_seconds,
    a.last_archived_wal, a.last_archived_time,
    a.failed_count, a.last_failed_wal
  FROM pg_stat_archiver a`;

export interface WalScanOptions {
  pool: Pool;
  docker?: Docker | undefined;
  batchSize?: number;
  probeTimeoutMs?: number;
  /** How often to spend a `pgbackrest check` on a project (backups §1: 15 min). */
  checkIntervalMs?: number;
  /**
   * Thresholds, overridable.
   *
   * Not a knob for operators — the production numbers are the alert catalog's and
   * the unit test pins them there. It exists so an integration test can prove a
   * real transition end to end without waiting five minutes of wall clock for a
   * constant it is not testing.
   */
  ladder?: { warn: number; critical: number };
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** Reports each sample so the caller can put it on a gauge. */
  onSample?: (s: { ref: string; node: string; sample: ArchiveSample; state: ArchiveState }) => void;
}

export interface WalScanResult {
  checked: number;
  unreachable: number;
  transitions: Array<{ ref: string; from: ArchiveState; to: ArchiveState; lag: number }>;
  checksRun: number;
  checksFailed: number;
}

export function createWalScan(opts: WalScanOptions) {
  const batchSize = opts.batchSize ?? 20;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  const checkIntervalMs = opts.checkIntervalMs ?? 15 * 60_000;
  const log = opts.log ?? (() => {});
  const ladder = opts.ladder ?? ARCHIVE_LADDER;

  /**
   * Sample a project's archiver.
   *
   * As `postgres`, because `pg_ls_archive_statusdir()` is superuser-or-pg_monitor
   * and the monitoring role does not exist yet. Reading it as the customer's
   * `developer` role would need a grant that also lets them list a directory of
   * the server's filesystem, which is a worse trade than one admin connection per
   * sweep.
   */
  async function sample(
    host: string, port: number, passwords: string[],
  ): Promise<ArchiveSample | undefined> {
    for (const password of passwords) {
      const client = new Client({
        host, port, user: 'postgres', password, database: 'postgres',
        connectionTimeoutMillis: probeTimeoutMs, ssl: false,
      });
      try {
        await client.connect();
        const { rows } = await client.query<{
          pending: number; lag_seconds: number | null;
          last_archived_wal: string | null; last_archived_time: Date | null;
          failed_count: string; last_failed_wal: string | null;
        }>(ARCHIVE_SQL);
        const r = rows[0]!;
        return {
          // No `.ready` files ⇒ nothing is waiting ⇒ no lag. The null coalesce is
          // the whole difference between this and the naive definition.
          lagSeconds: Math.max(0, r.lag_seconds ?? 0),
          pending: r.pending,
          ...(r.last_archived_time ? { lastArchivedAt: r.last_archived_time } : {}),
          ...(r.last_archived_wal ? { lastArchivedWal: r.last_archived_wal } : {}),
          failedCount: Number(r.failed_count ?? 0),
          ...(r.last_failed_wal ? { lastFailedWal: r.last_failed_wal } : {}),
        };
      } catch {
        continue;
      } finally {
        await client.end().catch(() => {});
      }
    }
    return undefined;
  }

  return {
    async scanOnce(deps: {
      superuserPasswordsFor: (projectId: string) => Promise<string[]>;
    }): Promise<WalScanResult> {
      const { rows: candidates } = await opts.pool.query<{
        id: string; ref: string; port: number; node_address: string | null;
        node_hostname: string; archive_state: ArchiveState;
        wal_archive_failed_count: string | null;
        check_age_ms: number | null;
        backup_check_ok: boolean | null;
      }>(
        `SELECT p.id, p.ref::text AS ref, d.port, n.address AS node_address,
                n.hostname AS node_hostname, d.archive_state::text AS archive_state,
                d.wal_archive_failed_count, d.backup_check_ok,
                extract(epoch FROM now() - d.backup_checked_at) * 1000 AS check_age_ms
           FROM projects p
           JOIN project_databases d ON d.project_id = p.id
           JOIN nodes n ON n.id = d.node_id
          WHERE p.status = 'ready' AND d.status = 'running'
          ORDER BY d.backup_checked_at NULLS FIRST
          LIMIT $1`, [batchSize]);

      const transitions: WalScanResult['transitions'] = [];
      let unreachable = 0, checksRun = 0, checksFailed = 0;

      for (const c of candidates) {
        if (!c.node_address) { unreachable++; continue; }
        const s = await sample(c.node_address, c.port, await deps.superuserPasswordsFor(c.id));
        if (!s) {
          // Cannot measure ⇒ cannot conclude. A project we failed to reach is not a
          // project whose archive is healthy, and it is not one whose archive is
          // broken either; the stored rung stays where it was and the count of
          // unreachable projects is itself the signal.
          unreachable++;
          log('warn', 'wal scan could not reach a project — rung left as it was',
            { ref: c.ref, state: c.archive_state });
          continue;
        }

        const next = archiveRungFor(s.lagSeconds, ladder);
        opts.onSample?.({ ref: c.ref, node: c.node_hostname, sample: s, state: next });

        // A failure count that moved since the last sample is Postgres telling us
        // `archive_command` is erroring *right now*. Worth surfacing even at zero
        // lag, because a push that fails and is retried successfully inside one
        // sweep window leaves no other trace.
        const before = c.wal_archive_failed_count === null
          ? null : Number(c.wal_archive_failed_count);
        const failuresMoved = before !== null && s.failedCount > before;

        // `pgbackrest check` answers a different question from lag and is spent on a
        // schedule because it costs a WAL switch: lag says whether WAL is flowing,
        // check says whether the repo would accept a backup at all. A project can
        // have zero pending segments and a repo whose credentials expired last week.
        //
        // But the schedule is a cost control, not a policy, and it is overridden by
        // trouble: a project past the warn rung or with a moved failure count gets
        // the second signal on this sweep rather than in fifteen minutes. Waiting
        // out the interval while a project is visibly failing to archive is paying
        // for the check and then not using it. Deliberately *not* triggered by
        // `pending > 0` alone — async batching means a busy healthy project has
        // segments waiting most of the time, so that gate would run a check every
        // sweep for exactly the projects that can least afford the WAL switch.
        const due = c.check_age_ms === null
          || c.check_age_ms >= checkIntervalMs
          || next !== 'ok'
          || failuresMoved
          // Already failing ⇒ re-check every sweep until it passes. Recovery has
          // to be noticed as promptly as failure: the alert on this gauge pages
          // after five minutes, so a stale `false` left standing until the next
          // scheduled check keeps the pager ringing for a quarter of an hour after
          // the problem was fixed. Cheap, because it only applies to projects that
          // are actually broken.
          || c.backup_check_ok === false;
        let checkOk: boolean | undefined;
        let checkError: string | undefined;
        if (due && opts.docker) {
          try {
            const r = await pgbackrestCheck(opts.docker, containerName(c.ref));
            checkOk = r.ok;
            if (!r.ok) checkError = pgbackrestFailure(r.output, 400);
            checksRun++;
            if (!r.ok) checksFailed++;
          } catch (err) {
            checkOk = false;
            checkError = (err as Error).message.slice(0, 400);
            checksRun++; checksFailed++;
          }
        }

        await opts.pool.query(
          `UPDATE project_databases
              SET wal_archive_lag_seconds = $2,
                  wal_archive_pending = $3,
                  wal_last_archived_at = $4,
                  wal_archive_failed_count = $5,
                  archive_state = $6,
                  backup_checked_at = CASE WHEN $7::boolean THEN now() ELSE backup_checked_at END,
                  backup_check_ok = COALESCE($8::boolean, backup_check_ok),
                  backup_check_error = CASE WHEN $8::boolean IS NULL THEN backup_check_error
                                            WHEN $8::boolean THEN NULL ELSE $9 END
            WHERE project_id = $1`,
          [c.id, s.lagSeconds, s.pending, s.lastArchivedAt ?? null, s.failedCount, next,
           checkOk !== undefined, checkOk ?? null, checkError ?? null]);

        if (checkOk === false) {
          log('error', 'pgbackrest check failed — this project cannot reach its repo',
            { ref: c.ref, error: checkError });
        }
        if (failuresMoved) {
          log('warn', 'archive_command is failing', {
            ref: c.ref, failed_count: s.failedCount, was: before,
            last_failed_wal: s.lastFailedWal,
          });
        }

        if (next !== c.archive_state) {
          transitions.push({ ref: c.ref, from: c.archive_state, to: next, lag: s.lagSeconds });
          log(next === 'ok' ? 'info' : 'error', 'wal archive rung transition', {
            ref: c.ref, from: c.archive_state, to: next,
            lag_seconds: s.lagSeconds, pending: s.pending,
          });
        }
      }

      return { checked: candidates.length - unreachable, unreachable, transitions,
        checksRun, checksFailed };
    },
  };
}
