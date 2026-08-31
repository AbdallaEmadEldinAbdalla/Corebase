import type { Pool } from 'pg';
import type { SagaStep, SagaContext } from './runner.ts';
import { allocateNode, releaseNode } from '../placement.ts';
import type { Docker } from '../docker.ts';
import {
  buildContainerSpec, bootstrapPassword, containerName, IMAGE, LABEL_MANAGED, LABEL_REF,
} from '../container-spec.ts';
import type { SecretStore } from '@corebase/secrets';
import { SECRET_NAMES } from '@corebase/secrets';
import {
  auditImageRoles, connectAsSuperuser, ensureDeveloperRole, setRolePassword,
  DEVELOPER_ROLE,
} from '../project-admin.ts';

export interface SagaDeps {
  pool: Pool;
  docker?: Docker;
  bootstrapSecret?: string;
  region?: string;
  healthTimeoutMs?: number;
  /** Credential persistence (D-035). Absent means the T5e steps cannot run. */
  secrets?: SecretStore;
  /** Domain the customer's connection host is built from. */
  projectDomain?: string;
}

/** Placement row for a project — every Docker step needs it. */
async function loadPlacement(pool: Pool, projectId: string) {
  const { rows } = await pool.query<{
    volume_name: string; port: number; pooler_port: number; ram_limit_mb: number;
    container_id: string | null; node_address: string | null; node_hostname: string;
  }>(`SELECT d.volume_name, d.port, d.pooler_port, d.ram_limit_mb, d.container_id,
             n.address AS node_address, n.hostname AS node_hostname
        FROM project_databases d JOIN nodes n ON n.id = d.node_id
       WHERE d.project_id = $1`, [projectId]);
  if (!rows[0]) throw new Error('no placement row — allocate_node must run first');
  return rows[0];
}

function requireSecrets(deps: SagaDeps): SecretStore {
  if (!deps.secrets) {
    throw new Error('no secret store configured — the control plane needs its KEK (CB_KEK_DIR)');
  }
  return deps.secrets;
}

/**
 * Where the control plane reaches this project's database. `address` is the
 * route; `hostname` is only an identity, and using it as a route works right up
 * until an environment where it does not resolve.
 */
function adminEndpoint(place: { node_address: string | null; node_hostname: string; port: number }) {
  if (!place.node_address) {
    throw new Error(
      `node ${place.node_hostname} has no address recorded — the control plane ` +
      'cannot open an admin connection to a node it does not know how to reach');
  }
  return { host: place.node_address, port: place.port };
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

/**
 * The superuser passwords that could be live right now, newest first: the stored
 * random one if store_credentials has already run, then the derived bootstrap
 * password the container was created with.
 */
async function superuserCandidates(deps: SagaDeps, projectId: string): Promise<string[]> {
  const out: string[] = [];
  const stored = await deps.secrets?.get(projectId, SECRET_NAMES.postgres);
  if (stored) out.push(stored);
  if (deps.bootstrapSecret) out.push(bootstrapPassword(deps.bootstrapSecret, projectId));
  if (out.length === 0) throw new Error('no candidate superuser password available');
  return out;
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
        //
        // -h forces a TCP probe (D-190). Without it pg_isready uses the unix
        // socket, which the entrypoint's init-phase server also answers on — so
        // the gate passed while the real server had not started listening, and
        // the next step got ECONNRESET on the published port.
        const { exitCode } = await docker.exec(id,
          ['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-q']);
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


  /**
   * The role model runs at provision time so it is never retrofitted (T5 in
   * milestone 0). The NOLOGIN trio and `authenticator` come from the image's
   * init scripts; this step verifies them and adds the customer's role, which
   * the control plane owns because its password is a control-plane secret.
   */
  const createBaseRoles: SagaStep<SagaContext> = {
    name: 'create_base_roles',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const place = await loadPlacement(deps.pool, projectId);
      const endpoint = adminEndpoint(place);
      const client = await connectAsSuperuser({
        ...endpoint,
        passwords: await superuserCandidates(deps, projectId),
      });
      try {
        const audit = await auditImageRoles(client);
        if (audit.missing.length > 0) {
          // Not recoverable by retrying: the node is running an image without
          // the role model, and a project created against it would have no
          // API-facing privilege levels at all.
          throw new Error(
            `project image is missing roles ${audit.missing.join(', ')} — the node ` +
            'is running an image that predates the role model (init/10-roles.sql)');
        }
        const { created } = await ensureDeveloperRole(client);
        ctx.log(created ? 'created the developer role' : 'developer role already present',
          { roles_verified: audit.present.length });
      } finally {
        await client.end().catch(() => {});
      }
    },
  };

  /**
   * Generate and store every credential, then apply it.
   *
   * Store-then-apply is the whole design (see secrets.ts): a crash after storing
   * leaves a password that is not yet in effect and the retry applies it; a crash
   * after applying but before storing would leave a database whose password does
   * not exist anywhere. The bootstrap password from T5d is replaced here — until
   * this step runs, every project's superuser password is derivable from one
   * fleet-wide secret, which is exactly as bad as it sounds.
   */
  const storeCredentials: SagaStep<SagaContext> = {
    name: 'store_credentials',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const secrets = requireSecrets(deps);
      const place = await loadPlacement(deps.pool, projectId);
      const endpoint = adminEndpoint(place);

      // Control plane first, in a fixed order so a partial run is always a
      // prefix of a complete one.
      const wanted = [
        { name: SECRET_NAMES.postgres, role: 'postgres' },
        { name: SECRET_NAMES.developer, role: DEVELOPER_ROLE },
        { name: SECRET_NAMES.authenticator, role: 'authenticator' },
      ];
      const stored: Array<{ role: string; value: string; created: boolean }> = [];
      for (const w of wanted) {
        const { value, created } = await secrets.ensure(projectId, w.name);
        stored.push({ role: w.role, value, created });
      }
      ctx.log('credentials persisted', {
        generated: stored.filter((s) => s.created).map((s) => s.role),
        reused: stored.filter((s) => !s.created).map((s) => s.role),
      });

      const client = await connectAsSuperuser({
        ...endpoint,
        passwords: await superuserCandidates(deps, projectId),
      });
      try {
        for (const s of stored) await setRolePassword(client, s.role, s.value);
        ctx.log('credentials applied to the project database', { roles: stored.map((s) => s.role) });
      } finally {
        await client.end().catch(() => {});
      }
    },
  };

  /**
   * The customer-facing address. Stored rather than derived because the naming
   * scheme is region- and generation-dependent, and a project must keep
   * answering on the name it was handed.
   */
  const writeConnection: SagaStep<SagaContext> = {
    name: 'write_connection',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const host = `${project.ref}.${deps.projectDomain ?? 'corebase.co'}`;
      const { rows } = await deps.pool.query<{ connection_host: string | null }>(
        `UPDATE project_databases
            SET connection_host = COALESCE(connection_host, $2)
          WHERE project_id = $1
        RETURNING connection_host`, [projectId, host]);
      ctx.log('connection details written', { host: rows[0]?.connection_host });
    },
  };

  /**
   * The only step that makes the project visible as usable. It runs last, and it
   * refuses to run if anything it depends on is not actually true — a project
   * marked ready without credentials is a support ticket that looks like a bug
   * in the customer's code.
   */
  const markReady: SagaStep<SagaContext> = {
    name: 'mark_ready',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const { rows } = await deps.pool.query<{
        db_status: string; connection_host: string | null; container_id: string | null;
        secret_count: number;
      }>(`SELECT d.status::text AS db_status, d.connection_host, d.container_id,
                 (SELECT count(*)::int FROM project_secrets s
                   WHERE s.project_id = d.project_id AND s.state = 'active') AS secret_count
            FROM project_databases d WHERE d.project_id = $1`, [projectId]);
      const row = rows[0];
      if (!row) throw new Error('no placement row — cannot mark a project ready');
      const problems: string[] = [];
      if (row.db_status !== 'running') problems.push(`database status is ${row.db_status}`);
      if (!row.container_id) problems.push('no container recorded');
      if (!row.connection_host) problems.push('no connection host');
      if (row.secret_count < 3) problems.push(`only ${row.secret_count} credentials stored`);
      if (problems.length > 0) {
        throw new Error(`refusing to mark ready: ${problems.join('; ')}`);
      }

      await deps.pool.query(
        `UPDATE projects SET status = 'ready' WHERE id = $1 AND status <> 'ready'`, [projectId]);
      ctx.log('project is ready');
    },
  };

  return {
    provision_project: [
      allocate,                      // T5c
      createVolume,                  // T5d
      startContainer,                // T5d
      waitHealthy,                   // T5d
      createBaseRoles,               // T5e
      storeCredentials,              // T5e
      writeConnection,               // T5e
      markReady,                     // T5e
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
