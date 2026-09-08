import type { Pool } from 'pg';
import type { Docker } from './docker.ts';
import { createSecretStore, SECRET_NAMES } from '@steadhold/secrets';
import { createVerifier, floorFor, type VerifyOutcome } from './verify-restore.ts';
import { restoreVerificationsTotal, projectsVerifiedRatio } from './metrics.ts';

/**
 * The verification scheduler (P3h, D-176).
 *
 * D-176 replaced D-019's "monthly" with **continuous sampling plus binding
 * per-plan floors**, and the reason is worth keeping in view: a monthly ceremony
 * puts the entire fleet's restore load on one boundary, and a fleet that verifies
 * everything on the 1st has no idea on the 2nd whether the projects created since
 * are restorable. Sampling spreads the load and, more importantly, always works on
 * the *worst* case first — never-verified chains before long-unverified ones.
 *
 * The floors are what make it a guarantee rather than a best effort: every
 * project's backups are restore-verified at least every 90 days (Free) or 30
 * (Pro/Team). Paused projects are included, and are the ones that need it most —
 * their backup is their only life (D-077).
 */

export interface VerifyScanOptions {
  pool: Pool;
  docker: Docker;
  secrets?: ReturnType<typeof createSecretStore> | undefined;
  /** How many projects one sweep will verify. Restores are expensive. */
  batchSize?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface VerifyScanResult {
  candidates: number;
  verified: number;
  failed: number;
  outcomes: Array<{ ref: string; passed: boolean; failedCheck?: string | undefined }>;
}

export function createVerifyScan(opts: VerifyScanOptions) {
  const batchSize = opts.batchSize ?? 1;
  const log = opts.log ?? (() => {});

  return {
    async scanOnce(): Promise<VerifyScanResult> {
      const result: VerifyScanResult = { candidates: 0, verified: 0, failed: 0, outcomes: [] };
      const secrets = opts.secrets;
      if (!secrets) {
        log('error', 'RESTORE VERIFICATION DISABLED — no secret store, so no project\'s ' +
          'backups are being restore-tested and none of them count as existing', {});
        return result;
      }

      /**
       * Candidates: never verified first, then longest since a *passing*
       * verification, and only those past their plan's floor.
       *
       * `last_passed IS NULL FIRST` is the important half. A project nobody has
       * ever verified is the one whose backups are most likely to be broken in a
       * way nobody has noticed — a misconfigured repo, a cipher-pass that never
       * matched, a schedule that never fired — and it is also the one a
       * longest-unverified ordering would rank *last*, because it has no timestamp
       * to be old.
       *
       * A failed verification does not count as verified, which is the whole point
       * of D-176's rule that a failure treats the project's backups as
       * nonexistent: the project stays at the front of the queue until a
       * verification passes.
       */
      const { rows: candidates } = await opts.pool.query<{
        id: string; ref: string; plan: string; days_since: number | null;
        db_status: string; port: number; node_address: string | null;
      }>(
        `SELECT p.id, p.ref::text AS ref, p.plan::text AS plan,
                extract(epoch FROM now() - v.last_passed) / 86400 AS days_since,
                d.status::text AS db_status, d.port, n.address AS node_address
           FROM projects p
           JOIN project_databases d ON d.project_id = p.id
           JOIN nodes n ON n.id = d.node_id
           LEFT JOIN LATERAL (
             SELECT max(finished_at) AS last_passed
               FROM restore_verifications rv
              WHERE rv.project_id = p.id AND rv.result = 'passed'
           ) v ON true
          WHERE p.status IN ('ready', 'paused')
            AND (v.last_passed IS NULL
                 OR v.last_passed < now() - make_interval(days =>
                      CASE p.plan::text WHEN 'free' THEN 90 ELSE 30 END))
          ORDER BY v.last_passed ASC NULLS FIRST
          LIMIT $1`, [batchSize]);
      result.candidates = candidates.length;

      for (const c of candidates) {
        const cipherPass = await secrets.get(c.id, SECRET_NAMES.backupCipherPass);
        if (!cipherPass) {
          log('error', 'cannot verify a project with no repo cipher-pass — its backups ' +
            'are unreadable and therefore do not exist', { project: c.ref });
          continue;
        }

        const { rows: started } = await opts.pool.query<{ id: string }>(
          `INSERT INTO restore_verifications (project_id, result) VALUES ($1, 'running')
           RETURNING id`, [c.id]);
        const runId = started[0]!.id;

        const verifier = createVerifier({ pool: opts.pool, docker: opts.docker, log });

        // The live project's own view of what should be in the restore. A paused
        // project has nothing running to ask, and that is not a reason to skip it —
        // D-176 verifies paused projects precisely because their backup is their
        // only life. The sanity check is simply skipped for them.
        let expectation;
        if (c.db_status === 'running' && c.node_address) {
          const su = await secrets.get(c.id, SECRET_NAMES.postgres);
          if (su) expectation = await verifier.expectationFrom(c.node_address, c.port, su);
        }

        let outcome: VerifyOutcome;
        try {
          outcome = await verifier.verify({
            projectId: c.id, ref: c.ref, plan: c.plan, cipherPass, expect: expectation });
        } catch (err) {
          outcome = { passed: false, failedCheck: 'restore', durationMs: 0,
            reason: (err as Error).message.slice(0, 1000) };
        }

        await opts.pool.query(
          `UPDATE restore_verifications
              SET result = $2, finished_at = now(), duration_ms = $3, restore_ms = $4,
                  backup_label = $5, failed_check = $6, failure_reason = $7,
                  bytes_restored = $8
            WHERE id = $1`,
          [runId, outcome.passed ? 'passed' : 'failed', outcome.durationMs,
           outcome.restoreMs ?? null, outcome.backupLabel ?? null,
           outcome.failedCheck ?? null, outcome.reason?.slice(0, 2000) ?? null,
           outcome.bytesRestored ?? null]);

        restoreVerificationsTotal.inc({
          result: outcome.passed ? 'passed' : 'failed',
          failed_check: outcome.failedCheck ?? 'none',
        });
        result.outcomes.push({
          ref: c.ref, passed: outcome.passed, failedCheck: outcome.failedCheck });

        if (outcome.passed) {
          result.verified++;
          log('info', 'restore verification passed', {
            project: c.ref, backup: outcome.backupLabel,
            restore_ms: outcome.restoreMs, days_since_last: c.days_since });
        } else {
          result.failed++;
          // The severity D-176 asks for. Until a verification passes, this
          // project's backups are treated as not existing — the runbook's response
          // is an immediate fresh full and a re-verify, and the project stays at
          // the front of this queue until one passes.
          log('error', 'RESTORE VERIFICATION FAILED — this project\'s backups are ' +
            'treated as nonexistent until a fresh full is taken and verified', {
              project: c.ref, failed_check: outcome.failedCheck,
              backup: outcome.backupLabel, reason: outcome.reason });
        }
      }

      // The standing SLO: what fraction of the fleet has a passing verification
      // inside its own plan's floor. A single number, because "are our backups
      // real" is a single question and an average of per-project ages does not
      // answer it — one project at 200 days is the whole story and an average
      // hides it.
      const { rows: slo } = await opts.pool.query<{ total: number; fresh: number }>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE v.last_passed IS NOT NULL
                  AND v.last_passed > now() - make_interval(days =>
                    CASE p.plan::text WHEN 'free' THEN 90 ELSE 30 END))::int AS fresh
           FROM projects p
           JOIN project_databases d ON d.project_id = p.id
           LEFT JOIN LATERAL (
             SELECT max(finished_at) AS last_passed FROM restore_verifications rv
              WHERE rv.project_id = p.id AND rv.result = 'passed'
           ) v ON true
          WHERE p.status IN ('ready', 'paused')`);
      const total = slo[0]?.total ?? 0;
      projectsVerifiedRatio.set({}, total === 0 ? 1 : (slo[0]!.fresh / total));

      return result;
    },
  };
}

export { floorFor };
