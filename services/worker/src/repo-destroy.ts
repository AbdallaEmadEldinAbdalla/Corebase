import type { Pool } from 'pg';
import { createS3, s3FromEnv, type S3 } from '@steadhold/s3';
import { repoPathFor } from './backup.ts';

/**
 * Destroying a purged project's backup repo (P3g, D-038, D-066).
 *
 * D-038 requires *provable* destruction of a deleted project's data, and D-066
 * sets the one part of it that cannot happen at purge time: the final backup is
 * kept **30 days past purge**, so a customer who deleted the wrong project has a
 * month rather than a week, and only then does the repo path go.
 *
 * ## Why the control plane does this and not a node
 *
 * By the time the deadline arrives the container, the volume, the placement row
 * and the credentials are all gone, so there is nowhere to run `pgbackrest`. The
 * control plane has to reach the bucket itself — which is also the access model
 * the design asks for (backups §6): nodes can put/get/list their own prefixes and
 * **delete rights live only with the control plane**, so a compromised node can
 * read its tenants' encrypted repos and cannot destroy history.
 *
 * ## What "provable" means here
 *
 * Deleting and assuming is not proof. Every sweep deletes the prefix and then
 * **lists it again**, and the row is only marked destroyed when that list comes
 * back empty — the same discipline as the purge's `verify_gone` step against the
 * node. An audit row records the destruction with the object count, because
 * "provable" also means someone can be shown the proof later.
 */

/** Days after purge before the repo is destroyed (D-066). */
export const REPO_RETENTION_DAYS = 30;

export interface RepoDestroyOptions {
  pool: Pool;
  /**
   * The store. `undefined` means "build one from the environment"; **`null` means
   * explicitly none** — the fleet has no object storage and destruction is
   * disabled.
   *
   * The distinction is not pedantry: `undefined` reading the environment is what
   * makes the production wiring a one-liner, and without a separate way to say
   * "none" there is no way to test the disabled path at all, because the test
   * environment has credentials.
   */
  s3?: S3 | null | undefined;
  batchSize?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface RepoDestroyResult {
  due: number;
  destroyed: number;
  failed: number;
  objectsDeleted: number;
}

export function createRepoDestroy(opts: RepoDestroyOptions) {
  const batchSize = opts.batchSize ?? 5;
  const log = opts.log ?? (() => {});
  const s3 = opts.s3 === null
    ? undefined
    : opts.s3 ?? (() => { const c = s3FromEnv(); return c ? createS3(c) : undefined; })();

  return {
    /** Record where a project's repo lives and when it must go. Called at purge. */
    async schedule(projectId: string, bucket: string): Promise<void> {
      await opts.pool.query(
        `INSERT INTO project_repos (project_id, repo_path, bucket, destroy_after)
         VALUES ($1, $2, $3, now() + make_interval(days => $4::int))
         ON CONFLICT (project_id) DO UPDATE
           SET destroy_after = COALESCE(project_repos.destroy_after, EXCLUDED.destroy_after),
               bucket = EXCLUDED.bucket,
               updated_at = now()`,
        [projectId, repoPathFor(projectId), bucket, REPO_RETENTION_DAYS]);
    },

    async scanOnce(): Promise<RepoDestroyResult> {
      const result: RepoDestroyResult = { due: 0, destroyed: 0, failed: 0, objectsDeleted: 0 };
      if (!s3) {
        // No credentials ⇒ nothing can be destroyed. Said out loud on every sweep
        // rather than returning quietly: a fleet silently retaining data it
        // promised to destroy is the worst version of this failing.
        log('error', 'REPO DESTRUCTION DISABLED — no object-store credentials, so ' +
          'purged projects\' backups are being retained indefinitely', {});
        return result;
      }

      const { rows: due } = await opts.pool.query<{
        project_id: string; ref: string; repo_path: string; org: string; attempts: number;
      }>(
        `SELECT r.project_id, p.ref::text AS ref, r.repo_path, r.attempts,
                p.organization_id AS org
           FROM project_repos r
           JOIN projects p ON p.id = r.project_id
          WHERE r.destroyed_at IS NULL
            AND r.destroy_after IS NOT NULL
            AND r.destroy_after <= now()
          ORDER BY r.destroy_after
          LIMIT $1`, [batchSize]);
      result.due = due.length;
      if (due.length === 0) return result;

      for (const repo of due) {
        // The prefix as S3 sees it. `repo_path` is stored with a leading slash
        // because that is pgBackRest's spelling of it, and S3 keys have none — a
        // list for `/projects/x` matches nothing at all, silently, and the sweep
        // would then "prove" an untouched prefix empty.
        const prefix = repo.repo_path.replace(/^\//, '') + '/';
        try {
          let deleted = 0;
          for (let round = 0; round < 200; round++) {
            const keys = await s3.list(prefix);
            if (keys.length === 0) break;
            for (let i = 0; i < keys.length; i += 1000) {
              const batch = keys.slice(i, i + 1000);
              const failedKeys = await s3.deleteBatch(batch);
              deleted += batch.length - failedKeys.length;
              // Retried individually: a batch response reports per-key errors, and
              // one unlucky key must not strand the whole prefix.
              for (const k of failedKeys) {
                await s3.deleteObject(k);
                deleted++;
              }
            }
          }

          // The proof. Deleting and assuming is not destruction; this is the same
          // discipline as the purge's verify_gone against the node.
          const remaining = await s3.list(prefix);
          if (remaining.length > 0) {
            throw new Error(
              `${remaining.length} objects still under ${prefix} after deleting ` +
              `${deleted} — not marking this repo destroyed`);
          }

          await opts.pool.query(
            `UPDATE project_repos
                SET destroyed_at = now(), objects_deleted = $2, last_error = NULL,
                    attempts = attempts + 1, updated_at = now()
              WHERE project_id = $1`, [repo.project_id, deleted]);

          // Audited, because D-066 says the destruction is recorded and because
          // "provable" means someone can be shown the proof later.
          await opts.pool.query(
            `INSERT INTO audit_logs
               (organization_id, project_id, actor_type, action, resource_type,
                resource_id, metadata)
             VALUES ($1, $2, 'system', 'project.backup_repo_destroyed', 'project', $3,
                     $4::jsonb)`,
            [repo.org, repo.project_id, repo.ref,
             JSON.stringify({ repo_path: repo.repo_path, objects_deleted: deleted,
               retention_days: REPO_RETENTION_DAYS })]);

          result.destroyed++;
          result.objectsDeleted += deleted;
          log('info', 'backup repo destroyed', {
            project: repo.ref, repo_path: repo.repo_path, objects_deleted: deleted });
        } catch (err) {
          result.failed++;
          await opts.pool.query(
            `UPDATE project_repos
                SET last_error = $2, attempts = attempts + 1, updated_at = now()
              WHERE project_id = $1`,
            [repo.project_id, (err as Error).message.slice(0, 1000)]);
          // Kept due rather than given up on: the deadline has passed, so every
          // sweep should keep trying, and the stored error is what makes a repo
          // that *cannot* be destroyed visible instead of merely retried forever.
          log('error', 'could not destroy a backup repo — it is still retained', {
            project: repo.ref, repo_path: repo.repo_path,
            attempts: repo.attempts + 1, error: (err as Error).message });
        }
      }
      return result;
    },
  };
}
