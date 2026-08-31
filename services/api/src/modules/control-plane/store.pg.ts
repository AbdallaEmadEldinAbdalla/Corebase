import type { Pool, PoolClient } from 'pg';
import type { Project, ProjectStatus } from '@corebase/types';
import type { ControlPlaneStore, JobRow, DatabaseInfo } from './store.ts';
import type { SecretStore } from '@corebase/secrets';
import { SECRET_NAMES } from '@corebase/secrets';
import { writeAudit, SYSTEM, type Actor } from '@corebase/audit';

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

/** Idempotent bootstrap of the dev org; returns its id. */
export async function ensureBootstrapOrg(pool: Pool, slug = 'dev'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET updated_at = now()
     RETURNING id`,
    ['Development', slug],
  );
  return rows[0]!.id;
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
    async createProject({ ref, name, region, plan, idempotencyKey, requestId, actor }) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const proj = await client.query<ProjectRowDb>(
          `INSERT INTO projects (organization_id, ref, name, region, plan, status)
           VALUES ($1, $2, $3, $4, $5::project_plan, 'creating')
           RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
          [organizationId, ref, name, region, plan],
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
          organizationId,
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
      if (!row.db_host || row.db_port === null || row.db_pooler_port === null) {
        // Provisioning has not reached write_connection yet; the project exists
        // and has a status, and that is the whole answer.
        return { project };
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
      return { project, database };
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
          organizationId,
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

    async findByName(name) {
      const { rows } = await pool.query<ProjectRowDb>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p
          WHERE p.name = $1 AND p.status <> 'deleted'`,
        [name],
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
