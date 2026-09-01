import type { Pool } from 'pg';
import type { Queue, ProvisioningJobData } from '@corebase/queue';
import { enqueueProvisioning } from '@corebase/queue';
import { decideBackup, type BackupType, type Window } from './backup-schedule.ts';

/**
 * The scan that schedules base backups (P3c, D-018).
 *
 * A *creator* of work, like the purge scan and unlike the sweeper: it decides a
 * project is due and writes the job row, and the enqueue afterwards is a
 * best-effort convenience the sweeper can redo (D-067 — the row is the job's
 * existence, Redis is delivery only).
 *
 * Scheduling in the control plane rather than as cron on each node is what makes
 * three things possible at once: jittering across the fleet so a node does not
 * read 150 databases at 03:00, knowing each project's plan, and skipping paused
 * projects — which must be skipped, because a paused project has no running
 * Postgres and its final backup is already pinned against expiry (D-077).
 */
export interface BackupScanOptions {
  pool: Pool;
  queue: Queue<ProvisioningJobData>;
  batchSize?: number;
  /** Overridden only by tests, to take the clock out of the question. */
  window?: Window;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface BackupScanResult {
  considered: number;
  due: Array<{ ref: string; type: BackupType; reason: string }>;
  created: number;
  enqueued: number;
  skipped: number;
}

export function createBackupScan(opts: BackupScanOptions) {
  const batchSize = opts.batchSize ?? 50;
  const log = opts.log ?? (() => {});

  return {
    async scanOnce(): Promise<BackupScanResult> {
      /**
       * Candidates, with their last successful backups in the same query.
       *
       * `d.status = 'running'` is what excludes paused projects: pause removes the
       * containers and marks the row `paused` (D-008), so there is nothing to back
       * up and nothing to connect to. A scan that tried anyway would produce a
       * failed run row every sweep for every paused project — which is most of the
       * fleet if the pause economics work — and bury the failures that mean
       * something.
       */
      const { rows: candidates } = await opts.pool.query<{
        id: string; ref: string; plan: string;
        last_full_at: Date | null; last_any_at: Date | null;
        open_runs: number;
      }>(
        `SELECT p.id, p.ref::text AS ref, p.plan::text AS plan,
                b.last_full_at, b.last_any_at,
                COALESCE(o.open_runs, 0)::int AS open_runs
           FROM projects p
           JOIN project_databases d ON d.project_id = p.id
           LEFT JOIN LATERAL (
             SELECT max(finished_at) FILTER (WHERE type = 'full') AS last_full_at,
                    max(finished_at) AS last_any_at
               FROM backup_runs r
              WHERE r.project_id = p.id AND r.status = 'succeeded'
           ) b ON true
           LEFT JOIN LATERAL (
             SELECT count(*) AS open_runs FROM backup_runs r
              WHERE r.project_id = p.id AND r.status = 'running'
                AND r.started_at > now() - interval '6 hours'
           ) o ON true
          WHERE p.status = 'ready' AND d.status = 'running'
          ORDER BY b.last_any_at NULLS FIRST
          LIMIT $1`, [batchSize]);

      const result: BackupScanResult = {
        considered: candidates.length, due: [], created: 0, enqueued: 0, skipped: 0,
      };
      const now = new Date();

      for (const c of candidates) {
        // A backup already in flight. Six hours is the cut-off rather than "any
        // running row" so a run abandoned by a killed worker cannot block the
        // project's schedule forever — the row stays for the record, but it stops
        // being a reason not to try again.
        if (c.open_runs > 0) {
          result.skipped++;
          continue;
        }

        const decision = decideBackup({
          projectId: c.id, plan: c.plan, now,
          lastFullAt: c.last_full_at ?? undefined,
          lastAnyAt: c.last_any_at ?? undefined,
          ...(opts.window ? { window: opts.window } : {}),
        });
        if (!decision.type) { result.skipped++; continue; }

        /**
         * The idempotency key carries the *day*, not a timestamp.
         *
         * A sweep runs every few minutes and a project's slot is half an hour wide,
         * so a per-timestamp key would enqueue the same nightly backup several
         * times. Keying on the calendar day makes the schedule what it claims to
         * be: one nightly full, however many times the scan looks.
         *
         * Underscores rather than colons — BullMQ rejects ':' in job ids and the
         * delivery id is this key.
         */
        const day = now.toISOString().slice(0, 10);
        const key = `backup_${c.id}_${decision.type}_${day}`;
        const { rows } = await opts.pool.query<{ id: string }>(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, 'backup_project', $2, $3::jsonb, 'pending')
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [c.id, key, JSON.stringify({ project_id: c.id, ref: c.ref, type: decision.type })]);
        const jobId = rows[0]?.id;
        if (!jobId) { result.skipped++; continue; }   // already scheduled today

        result.created++;
        result.due.push({ ref: c.ref, type: decision.type, reason: decision.reason });

        const { enqueued: ok } = await enqueueProvisioning(opts.queue, {
          job_row_id: jobId,
          idempotency_key: key,
          job_type: 'backup_project',
          project_id: c.id,
        });
        if (ok) result.enqueued++;
        log('backup scheduled', {
          project: c.ref, type: decision.type, why: decision.reason,
          job: jobId, delivered: ok,
        });
      }

      if (result.created > 0) {
        log('backup scan complete', {
          considered: result.considered, created: result.created,
          enqueued: result.enqueued, skipped: result.skipped,
        });
      }
      return result;
    },
  };
}
