import type { Pool } from 'pg';

/**
 * provisioning_jobs is the state of record. Every transition here is written to
 * Postgres BEFORE any side effect, so a crash leaves a row that tells the truth
 * about what was in flight (§75–76).
 */

export interface JobRecord {
  id: string;
  project_id: string | null;
  node_id: string | null;
  job_type: string;
  idempotency_key: string;
  state: 'pending' | 'enqueued' | 'running' | 'succeeded' | 'failed' | 'dead_letter';
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  checkpoint: Record<string, unknown>;
}

const COLS = `id, project_id, node_id, job_type, idempotency_key, state::text AS state,
              attempts, max_attempts, payload, checkpoint`;

export function createJobRepo(pool: Pool) {
  return {
    async byIdempotencyKey(key: string): Promise<JobRecord | undefined> {
      const { rows } = await pool.query<JobRecord>(
        `SELECT ${COLS} FROM provisioning_jobs WHERE idempotency_key = $1`, [key]);
      return rows[0];
    },

    async markEnqueued(id: string): Promise<void> {
      // only from pending: never drag a running job backwards
      await pool.query(
        `UPDATE provisioning_jobs SET state = 'enqueued'
          WHERE id = $1 AND state = 'pending'`, [id]);
    },

    /**
     * Claim for execution. Conditional on state so two workers racing the same
     * delivery cannot both run it — the UPDATE ... RETURNING is the lock.
     * A 'running' row whose heartbeat has expired is reclaimable.
     */
    async claim(id: string, staleAfterMs: number): Promise<JobRecord | undefined> {
      const { rows } = await pool.query<JobRecord>(
        `UPDATE provisioning_jobs
            SET state = 'running',
                attempts = attempts + 1,
                started_at = COALESCE(started_at, now()),
                heartbeat_at = now()
          WHERE id = $1
            AND (state IN ('pending','enqueued')
                 OR (state = 'running' AND heartbeat_at < now() - ($2::int || ' milliseconds')::interval))
        RETURNING ${COLS}`,
        [id, staleAfterMs]);
      return rows[0];
    },

    async heartbeat(id: string): Promise<void> {
      await pool.query(`UPDATE provisioning_jobs SET heartbeat_at = now() WHERE id = $1`, [id]);
    },

    /** Saga cursor: the step just completed, so a retry resumes instead of restarting. */
    async saveCheckpoint(id: string, checkpoint: Record<string, unknown>): Promise<void> {
      await pool.query(
        `UPDATE provisioning_jobs SET checkpoint = $2::jsonb WHERE id = $1`,
        [id, JSON.stringify(checkpoint)]);
    },

    async succeed(id: string): Promise<void> {
      await pool.query(
        `UPDATE provisioning_jobs
            SET state = 'succeeded', finished_at = now(), last_error = NULL
          WHERE id = $1`, [id]);
    },

    /**
     * Failure is either retryable (back to pending for the sweeper/BullMQ) or
     * terminal. Terminal means dead_letter + an operator alert, never a silent
     * drop (D-068).
     */
    async fail(id: string, error: string): Promise<{ terminal: boolean }> {
      const { rows } = await pool.query<{ state: string }>(
        `UPDATE provisioning_jobs
            SET last_error = $2,
                state = CASE WHEN attempts >= max_attempts THEN 'dead_letter'::job_state
                             ELSE 'pending'::job_state END,
                finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
          WHERE id = $1
        RETURNING state::text AS state`,
        [id, error.slice(0, 2000)]);
      return { terminal: rows[0]?.state === 'dead_letter' };
    },

    /**
     * Rows a worker should be told about again: never enqueued (the API crashed
     * between COMMIT and enqueue), or claimed by a worker that died.
     */
    async findOrphans(staleAfterMs: number, limit = 50): Promise<JobRecord[]> {
      const { rows } = await pool.query<JobRecord>(
        `SELECT ${COLS} FROM provisioning_jobs
          WHERE (state = 'pending' AND scheduled_for <= now())
             OR (state = 'enqueued' AND created_at < now() - ($1::int || ' milliseconds')::interval)
             OR (state = 'running'  AND heartbeat_at < now() - ($1::int || ' milliseconds')::interval)
          ORDER BY created_at
          LIMIT $2`,
        [staleAfterMs, limit]);
      return rows;
    },
  };
}
export type JobRepo = ReturnType<typeof createJobRepo>;
