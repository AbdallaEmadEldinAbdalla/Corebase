import type { Pool } from 'pg';
import type { SagaStep, SagaContext } from './runner.ts';
import { allocateNode, releaseNode } from '../placement.ts';
import type { Docker } from '../docker.ts';
import { buildContainerSpec, containerName, IMAGE, LABEL_MANAGED, LABEL_REF } from '../container-spec.ts';

export interface SagaDeps {
  pool: Pool;
  docker?: Docker;
  bootstrapSecret?: string;
  region?: string;
  healthTimeoutMs?: number;
}

/** Placement row for a project — every Docker step needs it. */
async function loadPlacement(pool: Pool, projectId: string) {
  const { rows } = await pool.query<{
    volume_name: string; port: number; ram_limit_mb: number; container_id: string | null;
  }>(`SELECT volume_name, port, ram_limit_mb, container_id
        FROM project_databases WHERE project_id = $1`, [projectId]);
  if (!rows[0]) throw new Error('no placement row — allocate_node must run first');
  return rows[0];
}

function requireDocker(deps: SagaDeps): Docker {
  if (!deps.docker) throw new Error('no Docker client configured (set CB_DOCKER_HOST/CB_DOCKER_CERT_DIR)');
  return deps.docker;
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

  const createVolume: SagaStep<SagaContext> = {
    name: 'create_volume',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      if (await docker.volumeExists(place.volume_name)) {
        ctx.log('volume already exists — reusing', { volume: place.volume_name });
        return;
      }
      await docker.createVolume(place.volume_name, {
        [LABEL_REF]: project.ref, [LABEL_MANAGED]: 'true',
      });
      ctx.log('volume created', { volume: place.volume_name });
    },
  };

  const startContainer: SagaStep<SagaContext> = {
    name: 'start_container',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      const name = containerName(project.ref);

      // Fail early and clearly if the node lacks the image: "image not found"
      // three steps later is a much worse diagnostic (D-071 pre-pull).
      if (!(await docker.imageExists(IMAGE))) {
        throw new Error(`project image is not present on the node — pre-pull it (D-071)`);
      }

      let inspect = await docker.inspectContainer(name);
      if (!inspect) {
        const spec = buildContainerSpec({
          ref: project.ref, projectId, volumeName: place.volume_name,
          hostPort: place.port, ramLimitMb: place.ram_limit_mb,
          bootstrapSecret: deps.bootstrapSecret ?? '',
        });
        const id = await docker.createContainer(name, spec);
        ctx.log('container created', { name, container: id.slice(0, 12) });
        inspect = await docker.inspectContainer(name);
      } else {
        ctx.log('container already exists — reusing', { name, state: inspect.State.Status });
      }

      if (!inspect!.State.Running) {
        await docker.startContainer(inspect!.Id);
        ctx.log('container started', { name });
      } else {
        ctx.log('container already running', { name });
      }

      // Record the id only after it is actually running, so the row never points
      // at a container that was never started.
      await deps.pool.query(
        `UPDATE project_databases SET container_id = $2 WHERE project_id = $1`,
        [projectId, inspect!.Id]);
    },
  };

  const waitHealthy: SagaStep<SagaContext> = {
    name: 'wait_healthy',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const place = await loadPlacement(deps.pool, projectId);
      if (!place.container_id) throw new Error('no container_id — start_container must run first');
      const id = place.container_id;
      const deadline = Date.now() + (deps.healthTimeoutMs ?? 60_000);
      let attempts = 0;
      for (;;) {
        attempts++;
        // pg_isready inside the container, over the Engine exec API — the worker
        // has no network path to the project's port, exactly as in production.
        // exitCode null means the container cannot exec yet (still running
        // initdb, restarting, or stopped); inspect is the authority on whether
        // that is temporary.
        const { exitCode } = await docker.exec(id,
          ['pg_isready', '-U', 'postgres', '-d', 'postgres', '-q']);
        if (exitCode === 0) {
          // Only now is a restart policy safe to attach (D-184).
          await docker.setRestartPolicy(id, 'unless-stopped');
          await deps.pool.query(
            `UPDATE project_databases SET status = 'running' WHERE project_id = $1`, [projectId]);
          ctx.log('database accepting connections', { attempts });
          return;
        }

        const state = await docker.inspectContainer(id);
        if (!state) throw new Error('container disappeared while waiting for it to become healthy');
        // A container that has exited, or that is flapping under a restart
        // policy, will never become healthy on its own — fail in seconds rather
        // than polling to the timeout.
        if (state.State.Restarting || (!state.State.Running && state.State.Status !== 'created')) {
          throw new Error(
            `container exited while starting (status ${state.State.Status}, code ${state.State.ExitCode})` +
            (state.State.Error ? `: ${state.State.Error}` : ''));
        }
        if (Date.now() > deadline) {
          throw new Error(
            `database did not accept connections within ${deps.healthTimeoutMs ?? 60_000}ms ` +
            `(container ${state.State.Status}, ${attempts} probes)`);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    },
  };

  return {
    provision_project: [
      allocate,                      // T5c
      createVolume,                  // T5d
      startContainer,                // T5d
      waitHealthy,                   // T5d
      pending('create_base_roles'),  // T5e
      pending('store_credentials'),  // T5e
      pending('write_connection'),   // T5e
      pending('mark_ready'),         // T5e
    ],
    delete_project: [
      pending('stop_container'),     // T7
      pending('remove_container'),
      pending('remove_volume'),
      release,
      pending('mark_deleted'),
    ],
  };
}
