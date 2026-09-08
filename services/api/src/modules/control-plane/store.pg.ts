import type { Pool, PoolClient } from 'pg';
import type { Project, ProjectStatus } from '@steadhold/types';
import type { ControlPlaneStore, JobRow, DatabaseInfo } from './store.ts';
import type { ProjectUsage } from './serialize.ts';
import type { SecretStore } from '@steadhold/secrets';
import { SECRET_NAMES } from '@steadhold/secrets';
import { writeAudit, SYSTEM, type Actor } from '@steadhold/audit';

/**
 * Postgres implementation of the control-plane store (T4 on T3's schema).
 *
 * The property this file exists to guarantee: a project row and its
 * provisioning_jobs row are written in ONE transaction (two-phase enqueue,
 * D-067). If the job row cannot be written the project must not exist either —
 * a project with no job is a project that silently never provisions, which is
 * the worst failure mode available to us.
 *
 * Redis is not touched here. The row IS the job's existence; enqueueing to
 * BullMQ is a later, retryable step the sweeper can redo (D-018).
 */

const TS = (col: string) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')`;
const PROJECT_COLUMNS = `
  p.id, p.ref::text AS ref, p.name, p.organization_id,
  p.region, p.plan::text AS plan, p.environment::text AS environment,
  p.status::text AS status, ${TS('p.created_at')} AS created_at,
  ${TS('p.deleted_at')} AS deleted_at, ${TS('p.purge_after')} AS purge_after`;

interface ProjectRowDb {
  id: string; ref: string; name: string; organization_id: string; region: string;
  plan: string; environment: string; status: string; created_at: string;
  deleted_at: string | null; purge_after: string | null;
}
const toProject = (r: ProjectRowDb): Project => ({
  id: r.id, ref: r.ref, name: r.name, organization_id: r.organization_id,
  region: r.region, plan: r.plan, environment: r.environment,
  status: r.status as ProjectStatus, created_at: r.created_at,
  // Omitted entirely for a live project rather than serialised as null: an
  // absent field reads as "not applicable", a null reads as "we lost it".
  ...(r.deleted_at ? { deleted_at: r.deleted_at } : {}),
  ...(r.purge_after ? { purge_after: r.purge_after } : {}),
});

export interface PgStoreOptions {
  pool: Pool;
  /**
   * Reader for envelope-encrypted credentials. Optional because the API can run
   * without a KEK — it then serves connection details without the password
   * rather than refusing to answer at all, which is the more useful failure.
   */
  secrets?: SecretStore;
  /**
   * M0 runs with one hardcoded org (milestone 0: "a single hardcoded dev account
   * is fine"). P1 replaces this with the real org resolved from the session.
   */
  organizationId: string;
}

/**
 * Idempotent bootstrap of the dev org, *with an owner*; returns its id.
 *
 * The membership is here and not only in the P1a migration because of an ordering
 * problem a fresh install exposes and an upgraded one hides. The migration links
 * the bootstrap user to the `dev` org by joining on its slug — but on a clean
 * database that org does not exist yet, since this function creates it at startup.
 * So the migration's INSERT matched nothing and a fresh deployment came up with an
 * organization that had no owner, violating the invariant every membership path
 * assumes. My staging database already had the org from Milestone 0, which is
 * exactly why the bug survived until CI ran against an empty one.
 */
export async function ensureBootstrapOrg(pool: Pool, slug = 'dev'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET updated_at = now()
     RETURNING id`,
    ['Development', slug],
  );
  const orgId = rows[0]!.id;
  await pool.query(
    `INSERT INTO organization_members (organization_id, user_id, role)
     SELECT $1, u.id, 'owner' FROM users u WHERE u.email = 'dev@steadhold.local'
     ON CONFLICT (organization_id, user_id) DO NOTHING`, [orgId]);
  return orgId;
}

export function createPgStore(opts: PgStoreOptions): ControlPlaneStore {
  const { pool, organizationId } = opts;
  const jobFromDb = (r: {
    id: string; job_type: string; project_id: string | null;
    idempotency_key: string; state: string;
  }): JobRow => ({
    id: r.id,
    kind: r.job_type as JobRow['kind'],
    project_id: r.project_id ?? '',
    idempotency_key: r.idempotency_key,
    state: r.state === 'pending' || r.state === 'enqueued' ? 'queued'
      : r.state === 'running' ? 'running'
      : r.state === 'succeeded' ? 'done' : 'failed',
  });

  return {
    async createProject({ ref, name, region, plan, idempotencyKey, requestId, actor,
                          organizationId: orgOverride }) {
      const orgId = orgOverride ?? organizationId;
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const proj = await client.query<ProjectRowDb>(
          `INSERT INTO projects (organization_id, ref, name, region, plan, status)
           VALUES ($1, $2, $3, $4, $5::project_plan, 'creating')
           RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
          [orgId, ref, name, region, plan],
        );
        const project = toProject(proj.rows[0]!);

        // Same transaction, deliberately. A failure here rolls the project back.
        const job = await client.query(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, 'provision_project', $2, $3::jsonb, 'pending')
           RETURNING id, job_type, project_id, idempotency_key, state::text AS state`,
          [project.id, idempotencyKey,
           JSON.stringify({ project_id: project.id, ref, ...(requestId ? { request_id: requestId } : {}) })],
        );
        // Same transaction as the project and the job. All three land or none
        // do — an audited history with holes in it is not evidence.
        await writeAudit(client, actor ?? { ...SYSTEM, requestId: requestId ?? null }, {
          action: 'project.created',
          resourceType: 'project',
          resourceId: project.ref,
          organizationId: orgId,
          projectId: project.id,
          metadata: { name, region, plan, idempotency_key: idempotencyKey },
        });

        await client.query('COMMIT');
        return { project, job: jobFromDb(job.rows[0]!), replayed: false };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async findByIdempotencyKey(key) {
      const { rows } = await pool.query<ProjectRowDb>(
        `SELECT ${PROJECT_COLUMNS} FROM provisioning_jobs j
           JOIN projects p ON p.id = j.project_id
          WHERE j.idempotency_key = $1`,
        [key],
      );
      return rows[0] ? toProject(rows[0]) : undefined;
    },

    async getProject(ref) {
      const { rows } = await pool.query<ProjectRowDb>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.ref = $1 AND p.status <> 'deleted'`,
        [ref],
      );
      return rows[0] ? toProject(rows[0]) : undefined;
    },

    /**
     * Usage for one project.
     *
     * The backup figures come from a correlated subquery rather than a join,
     * because a project accumulates one `backup_runs` row per run: joining would
     * multiply the single `project_databases` row by the backup history and then
     * need a `DISTINCT` or a `GROUP BY` over every column to undo it. Two scalar
     * subqueries against an indexed `project_id` are cheaper and say what they
     * mean.
     *
     * `size_bytes` is only trustworthy on a run that finished, so both the
     * timestamp and the size are taken from the same latest *succeeded* row —
     * reading them from separate subqueries could pair a size with a different
     * run's time.
     */
    async projectUsage(projectId) {
      const { rows } = await pool.query<ProjectUsage>(
        `SELECT d.disk_limit_mb, d.disk_used_bytes::text AS disk_used_bytes,
                d.disk_checked_at, d.disk_state::text AS disk_state,
                d.ram_limit_mb, d.ram_booked_mb,
                d.archive_state::text AS archive_state,
                d.wal_archive_lag_seconds, d.wal_archive_pending,
                d.wal_last_archived_at,
                d.wal_archive_failed_count::text AS wal_archive_failed_count,
                d.backup_checked_at, d.backup_check_ok, d.last_active_at,
                b.finished_at AS last_backup_at,
                b.size_bytes::text AS last_backup_bytes,
                (SELECT count(*)::text FROM backup_runs
                  WHERE project_id = d.project_id AND status = 'succeeded')
                  AS successful_backup_runs
           FROM project_databases d
           LEFT JOIN LATERAL (
                SELECT finished_at, size_bytes FROM backup_runs
                 WHERE project_id = d.project_id AND status = 'succeeded'
                 ORDER BY finished_at DESC NULLS LAST
                 LIMIT 1
           ) b ON true
          WHERE d.project_id = $1`, [projectId]);
      return rows[0];
    },

    async getProjectDetail(ref) {
      const { rows } = await pool.query<ProjectRowDb & {
        db_host: string | null; db_port: number | null; db_pooler_port: number | null;
        db_version: string | null;
      }>(`SELECT ${PROJECT_COLUMNS},
                 d.connection_host AS db_host, d.port AS db_port,
                 d.pooler_port AS db_pooler_port, d.pg_version AS db_version
            FROM projects p
            LEFT JOIN project_databases d ON d.project_id = p.id
           WHERE p.ref = $1 AND p.status <> 'deleted'`, [ref]);
      const row = rows[0];
      if (!row) return undefined;
      const project = toProject(row);

      // Lineage and deadline, for projects that are a restore. Fetched separately
      // rather than joined above so the common case — every project that is not a
      // restore — pays nothing for a table it has no row in.
      let restore: { source_ref: string; target_time: string | null; expires_at: string | null }
        | undefined;
      if (project.status === 'restoring' || project.status === 'restored') {
        const r = await pool.query<{
          source_ref: string; target_time: Date | null; expires_at: Date | null;
        }>(`SELECT source_ref, target_time, expires_at FROM project_restores
             WHERE project_id = $1`, [project.id]);
        const rr = r.rows[0];
        if (rr) {
          restore = {
            source_ref: rr.source_ref,
            target_time: rr.target_time?.toISOString() ?? null,
            expires_at: rr.expires_at?.toISOString() ?? null,
          };
        }
      }

      if (!row.db_host || row.db_port === null || row.db_pooler_port === null) {
        // Provisioning has not reached write_connection yet; the project exists
        // and has a status, and that is the whole answer.
        return { project, ...(restore ? { restore } : {}) };
      }

      const database: DatabaseInfo = {
        host: row.db_host,
        port: row.db_port,
        pooler_port: row.db_pooler_port,
        pg_version: row.db_version ?? '17',
      };

      // The password is rendered, never stored in cleartext (credentials §2).
      // A KEK-less API omits the strings rather than serving a URL with no
      // credential in it, which would look like a working string and fail.
      const password = opts.secrets
        ? await opts.secrets.get(project.id, SECRET_NAMES.developer).catch(() => undefined)
        : undefined;
      if (password) {
        const auth = `developer:${encodeURIComponent(password)}`;
        database.connection_strings = {
          direct: `postgres://${auth}@${database.host}:${database.port}/postgres`,
          pooled: `postgres://${auth}@${database.host}:${database.pooler_port}/postgres`,
        };
      }
      return { project, database, ...(restore ? { restore } : {}) };
    },

    /**
     * Request a credential rotation (P2d).
     *
     * Not folded into `requestLifecycle`: pause and resume are state transitions
     * with a `from` state to validate, and a rotation is valid from `ready` alone
     * but carries a *payload* — the `terminate` flag — which none of the others do.
     * One function serving both would be a switch on kind at every step.
     *
     * The key is numbered like pause/resume's rather than permanent, because a
     * project's credentials are rotated many times over its life.
     */
    async requestRotation(ref, opts, actor) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query<ProjectRowDb>(
          `SELECT ${PROJECT_COLUMNS.replace(/p\./g, '')} FROM projects
            WHERE ref = $1 AND status <> 'deleted' FOR UPDATE`, [ref]);
        const row = found.rows[0];
        if (!row) { await client.query('ROLLBACK'); return undefined; }

        const inflight = await client.query(
          `SELECT id, job_type, project_id, idempotency_key, state::text AS state
             FROM provisioning_jobs
            WHERE project_id = $1 AND job_type = 'rotate_credentials'
              AND state NOT IN ('succeeded', 'failed', 'dead_letter')
            ORDER BY created_at DESC LIMIT 1`, [row.id]);
        if (inflight.rows[0]) {
          await client.query('COMMIT');
          return {
            project: toProject(row), job: jobFromDb(inflight.rows[0] as never),
            alreadyRequested: true,
          };
        }

        // Only a running project. Rotating a paused one would store a password the
        // database is not up to receive, and the apply step would fail — better to
        // refuse with the state than to queue work that cannot succeed.
        if (row.status !== 'ready') {
          await client.query('ROLLBACK');
          return { conflict: row.status, project: toProject(row) };
        }

        const seq = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM provisioning_jobs
            WHERE project_id = $1 AND job_type = 'rotate_credentials'`, [row.id]);
        const key = `rotate_${row.id}_${(seq.rows[0]?.n ?? 0) + 1}`;

        const job = await client.query(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, 'rotate_credentials', $2, $3::jsonb, 'pending')
           RETURNING id, job_type, project_id, idempotency_key, state::text AS state`,
          [row.id, key, JSON.stringify({
            project_id: row.id, ref, terminate: opts.terminate === true,
          })]);
        await writeAudit(client, actor ?? SYSTEM, {
          action: 'project.credentials_rotation_requested',
          resourceType: 'project', resourceId: ref,
          organizationId: row.organization_id, projectId: row.id,
          // Whether sessions were killed is the part an incident review asks about.
          metadata: { terminate: opts.terminate === true },
        });
        await client.query('COMMIT');
        return {
          project: toProject(row), job: jobFromDb(job.rows[0] as never),
          alreadyRequested: false,
        };
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally {
        client.release();
      }
    },

    async countProjectsInOrg(organizationId) {
      // `deleted` is the only status that has given its resources back; a
      // soft-deleted project still holds a volume and a port for the window.
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM projects
          WHERE organization_id = $1 AND status <> 'deleted'`, [organizationId]);
      return rows[0]?.n ?? 0;
    },

    /**
     * Pause or resume (P2c, D-008).
     *
     * The idempotency key is where this differs from a delete, and it matters. A
     * project is deleted once, so `delete_<id>` is a permanent key. A project is
     * paused and resumed many times — fifty in a row, per Phase 2's exit criterion
     * — so a permanent key would make the second cycle a silent no-op that returns
     * the first cycle's job.
     *
     * So the dedupe is on *in-flight* work rather than forever: an unfinished job
     * of the same kind for this project is returned as-is, and otherwise a new one
     * is inserted under a key numbered by how many have come before. Concurrent
     * requests still collapse — the row lock serialises them and the loser sees the
     * winner's job — while a genuine second cycle gets a genuine second job.
     */
    async requestRetry(ref, actor) {
      const client: PoolClient = await pool.connect();
      /** Only the sagas that *build* a project leave it unusable when they fail. */
      const BUILDING = ['provision_project', 'restore_project'];
      try {
        await client.query('BEGIN');
        const found = await client.query<ProjectRowDb>(
          `SELECT ${PROJECT_COLUMNS.replace(/p\./g, '')} FROM projects
            WHERE ref = $1 AND status <> 'deleted' FOR UPDATE`, [ref]);
        const row = found.rows[0];
        if (!row) { await client.query('ROLLBACK'); return undefined; }

        if (row.status !== 'failed') {
          await client.query('ROLLBACK');
          return { conflict: row.status, project: toProject(row) };
        }

        // The most recent dead-lettered build. `FOR UPDATE` because two retries
        // arriving together must not both reset it and enqueue twice.
        const dead = await client.query<{
          id: string; job_type: string; project_id: string;
          idempotency_key: string; state: string;
        }>(`SELECT id, job_type, project_id, idempotency_key, state::text AS state
              FROM provisioning_jobs
             WHERE project_id = $1 AND job_type = ANY($2::text[])
               AND state = 'dead_letter'
             ORDER BY created_at DESC LIMIT 1
               FOR UPDATE`, [row.id, BUILDING]);
        const job = dead.rows[0];
        if (!job) {
          // The project says failed and no build job gave up, so something else
          // marked it. Saying that beats enqueueing a job nobody asked for.
          await client.query('ROLLBACK');
          return { refused: 'This project has no failed build to retry.' };
        }

        // Monotonic across retries, and derived rather than stored: the delivery
        // id falls back to `key#recover-N` and a repeated N is dropped as a
        // duplicate, so the second retry would silently do nothing.
        const seen = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE project_id = $1 AND action = 'project.retry_requested'`, [row.id]);
        const retryCount = (seen.rows[0]?.n ?? 0) + 1;

        // `checkpoint` is deliberately untouched — the saga resumes from it.
        await client.query(
          `UPDATE provisioning_jobs
              SET state = 'pending', attempts = 0, last_error = NULL,
                  started_at = NULL, finished_at = NULL, heartbeat_at = NULL,
                  scheduled_for = now(), updated_at = now()
            WHERE id = $1`, [job.id]);

        const updated = await client.query<ProjectRowDb>(
          `UPDATE projects SET status = 'creating', updated_at = now() WHERE ref = $1
        RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`, [ref]);

        await writeAudit(client, actor ?? SYSTEM, {
          action: 'project.retry_requested',
          resourceType: 'project', resourceId: ref,
          organizationId: row.organization_id, projectId: row.id,
          metadata: { job_type: job.job_type, retry: retryCount },
        });
        await client.query('COMMIT');
        return {
          project: toProject(updated.rows[0]!),
          job: jobFromDb(job as never),
          retryCount,
        };
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally {
        client.release();
      }
    },

    async requestLifecycle(ref, kind, actor) {
      const client: PoolClient = await pool.connect();
      const jobType = kind === 'pause' ? 'pause_project' : 'resume_project';
      // Pausing is only meaningful for a running project; resuming only for a
      // paused one. Anything else is refused by name so the caller learns why.
      const from = kind === 'pause' ? ['ready'] : ['paused'];
      const to = kind === 'pause' ? 'pausing' : 'resuming';
      try {
        await client.query('BEGIN');
        const found = await client.query<ProjectRowDb>(
          `SELECT ${PROJECT_COLUMNS.replace(/p\./g, '')} FROM projects
            WHERE ref = $1 AND status <> 'deleted' FOR UPDATE`, [ref]);
        const row = found.rows[0];
        if (!row) { await client.query('ROLLBACK'); return undefined; }

        // Already in the transitional state, or already where the caller wants it:
        // return the in-flight job rather than starting a second one.
        const inflight = await client.query(
          `SELECT id, job_type, project_id, idempotency_key, state::text AS state
             FROM provisioning_jobs
            WHERE project_id = $1 AND job_type = $2
              AND state NOT IN ('succeeded', 'failed', 'dead_letter')
            ORDER BY created_at DESC LIMIT 1`, [row.id, jobType]);
        if (inflight.rows[0]) {
          await client.query('COMMIT');
          return {
            project: toProject(row), job: jobFromDb(inflight.rows[0] as never),
            alreadyRequested: true,
          };
        }

        if (!from.includes(row.status)) {
          await client.query('ROLLBACK');
          return { conflict: row.status, project: toProject(row) };
        }

        const seq = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM provisioning_jobs
            WHERE project_id = $1 AND job_type = $2`, [row.id, jobType]);
        const key = `${kind}_${row.id}_${(seq.rows[0]?.n ?? 0) + 1}`;

        const updated = await client.query<ProjectRowDb>(
          `UPDATE projects SET status = $2, updated_at = now() WHERE ref = $1
        RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`, [ref, to]);
        const job = await client.query(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, $2, $3, $4::jsonb, 'pending')
           RETURNING id, job_type, project_id, idempotency_key, state::text AS state`,
          [row.id, jobType, key, JSON.stringify({ project_id: row.id, ref })]);
        await writeAudit(client, actor ?? SYSTEM, {
          action: kind === 'pause' ? 'project.pause_requested' : 'project.resume_requested',
          resourceType: 'project', resourceId: ref,
          organizationId: row.organization_id, projectId: row.id,
          metadata: { previous_status: row.status },
        });
        await client.query('COMMIT');
        return {
          project: toProject(updated.rows[0]!), job: jobFromDb(job.rows[0] as never),
          alreadyRequested: false,
        };
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally {
        client.release();
      }
    },

    /**
     * Start a restore as a new project (P3d, backups §4).
     *
     * Everything in one transaction: the new project row, its restore row, and the
     * job. A partial version of this is worse than a failed one — a project row
     * with no restore row is a `restoring` project the saga cannot explain, and a
     * restore row with no job is a project that stays `restoring` forever.
     */
    async requestRestore({ ref, targetTime, newRef, actor, projectsPerOrgLimit, ttlHours = 48 }) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query<ProjectRowDb>(
          `SELECT ${PROJECT_COLUMNS.replace(/p\./g, '')} FROM projects
            WHERE ref = $1 AND status <> 'deleted' FOR UPDATE`, [ref]);
        const source = found.rows[0];
        if (!source) { await client.query('ROLLBACK'); return undefined; }

        // A paused project can be restored — its repo is complete and pinned — but a
        // project that never finished provisioning has no backup to read, and one
        // mid-delete is about to have its repo destroyed.
        if (!['ready', 'paused', 'restored'].includes(source.status)) {
          await client.query('ROLLBACK');
          return { conflict: source.status, project: toProject(source) };
        }

        // A restore consumes a real node slot, so it counts against the ceiling.
        // Uncomfortable during an incident, which is exactly when a customer wants
        // one — the real per-plan concurrent-restore policy is OQ-079's, and until
        // it exists the honest behaviour is to refuse with the way out named rather
        // than to quietly overrun a limit the rest of the system enforces.
        if (projectsPerOrgLimit !== undefined) {
          const live = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM projects
              WHERE organization_id = $1 AND status <> 'deleted'`, [source.organization_id]);
          if ((live.rows[0]?.n ?? 0) >= projectsPerOrgLimit) {
            await client.query('ROLLBACK');
            return { refused:
              `A restore creates a new project, and this organization already has ` +
              `${live.rows[0]?.n} of its ${projectsPerOrgLimit}. Delete and purge one, ` +
              'or promote a previous restore, to make room.' };
          }
        }

        const created = await client.query<ProjectRowDb>(
          `INSERT INTO projects (organization_id, ref, name, region, plan, status)
           VALUES ($1, $2, $3, $4, $5::project_plan, 'restoring')
           RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
          [source.organization_id, newRef,
           // The name says what it is and when, because a list of projects called
           // "api" and "api (restore)" is unreadable the second time you do this.
           `${source.name} — restore ${targetTime ? targetTime.toISOString().slice(0, 16).replace('T', ' ') : 'latest'}`,
           source.region, source.plan]);
        const project = toProject(created.rows[0]!);

        // The deadline is set here, in the same transaction as the project, so a
        // copy cannot exist without one. A nullable column filled in later is a
        // copy that lives forever if the later step is ever skipped.
        await client.query(
          `INSERT INTO project_restores
             (project_id, source_project_id, source_ref, target_time, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int))`,
          [project.id, source.id, source.ref, targetTime ?? null, ttlHours]);

        const key = `restore_${project.id}`;
        const job = await client.query(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, 'restore_project', $2, $3::jsonb, 'pending')
           RETURNING id, job_type, project_id, idempotency_key, state::text AS state`,
          [project.id, key, JSON.stringify({
            project_id: project.id, ref: newRef, source_ref: source.ref,
            target_time: targetTime?.toISOString() ?? null })]);

        await writeAudit(client, actor ?? SYSTEM, {
          action: 'project.restore_requested',
          resourceType: 'project', resourceId: source.ref,
          organizationId: source.organization_id, projectId: source.id,
          metadata: {
            target_time: targetTime?.toISOString() ?? 'latest',
            restore_ref: newRef, restore_project_id: project.id,
          },
        });
        await client.query('COMMIT');
        return { project, job: jobFromDb(job.rows[0] as never), source: toProject(source),
          expiresAt: new Date(Date.now() + ttlHours * 3_600_000) };
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally {
        client.release();
      }
    },

    async requestDelete(ref, actor) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock the row: two concurrent DELETEs must not both insert a job, and
        // the unique idempotency key would turn the loser into a 500 rather than
        // the no-op it should be.
        const found = await client.query<ProjectRowDb>(
          `SELECT ${PROJECT_COLUMNS.replace(/p\./g, '')} FROM projects
            WHERE ref = $1 AND status <> 'deleted' FOR UPDATE`, [ref]);
        if (!found.rows[0]) { await client.query('ROLLBACK'); return undefined; }

        const key = `delete_${found.rows[0].id}`;
        const existing = await client.query(
          `SELECT id, job_type, project_id, idempotency_key, state::text AS state
             FROM provisioning_jobs WHERE idempotency_key = $1`, [key]);
        if (existing.rows[0]) {
          // Already requested. Return the original outcome, exactly as a replayed
          // create does — a second DELETE is not an error.
          await client.query('COMMIT');
          return {
            project: toProject(found.rows[0]),
            job: jobFromDb(existing.rows[0] as never),
            alreadyRequested: true,
          };
        }

        const updated = await client.query<ProjectRowDb>(
          `UPDATE projects SET status = 'deleting' WHERE ref = $1
        RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`, [ref]);
        const job = await client.query(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, 'delete_project', $2, $3::jsonb, 'pending')
           RETURNING id, job_type, project_id, idempotency_key, state::text AS state`,
          [found.rows[0].id, key,
           JSON.stringify({ project_id: found.rows[0].id, ref })]);
        await writeAudit(client, actor ?? SYSTEM, {
          action: 'project.delete_requested',
          resourceType: 'project',
          resourceId: ref,
          // The *project's* org, not the store's bootstrap default. Getting this
          // wrong files the deletion of an org-A project under org B's history,
          // which is both a wrong answer and a small cross-tenant leak.
          organizationId: found.rows[0].organization_id,
          projectId: found.rows[0].id,
          // The one fact a customer asking "why is my project gone" needs, and
          // the reason this row must outlive the project it describes.
          metadata: { previous_status: found.rows[0].status },
        });

        await client.query('COMMIT');
        return {
          project: toProject(updated.rows[0]!),
          job: jobFromDb(job.rows[0] as never),
          alreadyRequested: false,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async listApiKeys(projectId) {
      const { rows } = await pool.query<{
        id: string; kind: 'anon' | 'service_role'; key_prefix: string; created_at: string;
      }>(`SELECT id, kind, key_prefix, ${TS('created_at')} AS created_at
            FROM project_api_keys
           WHERE project_id = $1 AND revoked_at IS NULL
           ORDER BY kind`, [projectId]);
      return rows;
    },

    async listProjectsPage({ limit, cursor, organizationId }) {
      // Keyset, not offset. `(created_at, id) < (…, …)` is a row comparison, so
      // one index scan serves the page and a row inserted mid-scroll cannot shift
      // the reader's place — which offset pagination does silently.
      const { rows } = await pool.query<ProjectRowDb>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p
          WHERE p.status <> 'deleted'
            AND ($1::uuid IS NULL OR p.organization_id = $1)
            AND ($2::timestamptz IS NULL
                 OR (p.created_at, p.id) < ($2::timestamptz, $3::uuid))
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $4`,
        [organizationId ?? null, cursor?.created_at ?? null, cursor?.id ?? null, limit + 1]);
      return rows.map(toProject);
    },

    async listProjects() {
      const { rows } = await pool.query<ProjectRowDb>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p
          WHERE p.status <> 'deleted' ORDER BY p.created_at DESC`,
      );
      return rows.map(toProject);
    },

    async markStatus(ref, status) {
      const { rows } = await pool.query<ProjectRowDb>(
        `UPDATE projects p SET status = $2::project_status
          WHERE p.ref = $1 AND p.status <> 'deleted'
        RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
        [ref, status],
      );
      return rows[0] ? toProject(rows[0]) : undefined;
    },

    async findByName(name, orgFilter) {
      const { rows } = await pool.query<ProjectRowDb>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p
          WHERE p.name = $1 AND p.status <> 'deleted'
            AND ($2::uuid IS NULL OR p.organization_id = $2)`,
        [name, orgFilter ?? null],
      );
      return rows[0] ? toProject(rows[0]) : undefined;
    },

    async jobs() {
      const { rows } = await pool.query(
        `SELECT id, job_type, project_id, idempotency_key, state::text AS state
           FROM provisioning_jobs ORDER BY created_at`,
      );
      return rows.map(jobFromDb);
    },
  };
}
