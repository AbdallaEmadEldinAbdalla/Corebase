import type { Pool, PoolClient } from 'pg';
import type { Project, ProjectStatus } from '@corebase/types';
import type { ControlPlaneStore, JobRow } from './store.ts';

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

const PROJECT_COLUMNS = `
  p.id, p.ref::text AS ref, p.name, p.region, p.plan::text AS plan,
  p.status::text AS status, to_char(p.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') AS created_at`;

interface ProjectRowDb {
  id: string; ref: string; name: string; region: string;
  plan: string; status: string; created_at: string;
}
const toProject = (r: ProjectRowDb): Project => ({
  id: r.id, ref: r.ref, name: r.name, region: r.region,
  plan: r.plan, status: r.status as ProjectStatus, created_at: r.created_at,
});

export interface PgStoreOptions {
  pool: Pool;
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

export function createPgStore({ pool, organizationId }: PgStoreOptions): ControlPlaneStore {
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
    async createProject({ ref, name, region, plan, idempotencyKey }) {
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
          [project.id, idempotencyKey, JSON.stringify({ project_id: project.id, ref })],
        );
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
        `SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.ref = $1 AND p.deleted_at IS NULL`,
        [ref],
      );
      return rows[0] ? toProject(rows[0]) : undefined;
    },

    async listProjects() {
      const { rows } = await pool.query<ProjectRowDb>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p
          WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC`,
      );
      return rows.map(toProject);
    },

    async markStatus(ref, status) {
      const { rows } = await pool.query<ProjectRowDb>(
        `UPDATE projects p SET status = $2::project_status
          WHERE p.ref = $1 AND p.deleted_at IS NULL
        RETURNING ${PROJECT_COLUMNS.replace(/p\./g, '')}`,
        [ref, status],
      );
      return rows[0] ? toProject(rows[0]) : undefined;
    },

    async findByName(name) {
      const { rows } = await pool.query<ProjectRowDb>(
        `SELECT ${PROJECT_COLUMNS} FROM projects p
          WHERE p.name = $1 AND p.deleted_at IS NULL`,
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
