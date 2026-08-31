import type { Pool } from 'pg';
import type { SagaStep, SagaContext } from './runner.ts';
import { allocateNode, releaseNode } from '../placement.ts';

export interface SagaDeps {
  pool: Pool;
  region?: string;
}

/**
 * T5c implements allocate_node. The remaining steps stay named no-ops until
 * T5d/T5e fill them; their NAMES are checkpoint keys and must not change
 * casually, because a rename makes in-flight checkpoints meaningless.
 */
const pending = (name: string): SagaStep<SagaContext> => ({
  name,
  async run(ctx) { ctx.log(`step ${name} (not implemented yet)`); },
});

/** Project fields the steps need, read once per step from the row of record. */
async function loadProject(pool: Pool, projectId: string) {
  const { rows } = await pool.query<{ id: string; ref: string; plan: string; name: string }>(
    `SELECT id, ref::text AS ref, plan::text AS plan, name FROM projects WHERE id = $1`,
    [projectId]);
  if (!rows[0]) throw new Error(`project ${projectId} no longer exists`);
  return rows[0];
}

export function buildSagas(deps: SagaDeps): Record<string, SagaStep<SagaContext>[]> {
  const allocate: SagaStep<SagaContext> = {
    name: 'allocate_node',
    async run(ctx) {
      const projectId = ctx.job.project_id;
      if (!projectId) throw new Error('provision_project job has no project_id');
      const project = await loadProject(deps.pool, projectId);
      const placement = await allocateNode(deps.pool, {
        projectId, ref: project.ref, plan: project.plan,
        ...(deps.region ? { region: deps.region } : {}),
      });
      ctx.log(placement.replayed ? 'placement already existed — reusing' : 'placed project on node', {
        node: placement.hostname, port: placement.port, pooler_port: placement.poolerPort,
        volume: placement.volumeName, booked_mb: placement.bookedMb,
      });
    },
  };

  const release: SagaStep<SagaContext> = {
    name: 'release_capacity',
    async run(ctx) {
      const projectId = ctx.job.project_id;
      if (!projectId) { ctx.log('no project_id — nothing to release'); return; }
      const project = await loadProject(deps.pool, projectId);
      const r = await releaseNode(deps.pool, { projectId, plan: project.plan });
      ctx.log(r.released ? 'released node capacity' : 'capacity already released', { freed_mb: r.freedMb });
    },
  };

  return {
    provision_project: [
      allocate,                      // T5c
      pending('create_volume'),      // T5d
      pending('start_container'),    // T5d
      pending('wait_healthy'),       // T5d
      pending('create_base_roles'),  // T5e
      pending('store_credentials'),  // T5e
      pending('write_connection'),   // T5e
      pending('mark_ready'),         // T5e
    ],
    delete_project: [
      pending('stop_container'),     // T7
      pending('remove_container'),
      pending('remove_volume'),
      release,                       // T5c gives the inverse now
      pending('mark_deleted'),
    ],
  };
}
