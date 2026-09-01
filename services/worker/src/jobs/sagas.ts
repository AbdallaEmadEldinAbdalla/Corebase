import { Client as PgClient, type Pool } from 'pg';
import type { SagaStep, SagaContext } from './runner.ts';
import { allocateNode, releaseNode, releaseRam, bookRam, volumeNameFor } from '../placement.ts';
import type { Docker } from '../docker.ts';
import {
  buildContainerSpec, buildPoolerSpec, bootstrapPassword, containerName, networkName,
  poolerName, IMAGE, POOLER_IMAGE, LABEL_MANAGED, LABEL_REF,
} from '../container-spec.ts';
import type { SecretStore } from '@corebase/secrets';
import { SECRET_NAMES } from '@corebase/secrets';
import { createHash } from 'node:crypto';
import { generateKeypair, sign as signJwt, projectKeyClaims } from '@corebase/jwt';
import {
  auditImageRoles, connectAsSuperuser, ensureDeveloperRole, setRolePassword,
  DEVELOPER_ROLE, POOLER_AUTH_ROLE,
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
  /** `iss` for the project's own JWTs. Defaults to the project domain. */
  jwtIssuer?: string;
  /** Recovery window before a purge may run (D-038 default: 7 days). */
  softDeleteWindow?: string;
  /**
   * Refuse to delete without a verified final backup (D-066). Off in Milestone 0
   * because no backup system exists yet; turning it on with none available makes
   * deletion fail loudly rather than quietly skip the safeguard.
   */
  requireFinalBackup?: boolean;
}

/** Placement row for a project — every Docker step needs it. */
async function loadPlacement(pool: Pool, projectId: string) {
  const { rows } = await pool.query<{
    volume_name: string; port: number; pooler_port: number; ram_limit_mb: number;
    container_id: string | null; pooler_container_id: string | null;
    node_address: string | null; node_hostname: string;
  }>(`SELECT d.volume_name, d.port, d.pooler_port, d.ram_limit_mb, d.container_id,
             d.pooler_container_id,
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

/** The same rule for the pooled port (P2b): the node's address, never its name. */
function poolerEndpoint(
  place: { node_address: string | null; node_hostname: string; pooler_port: number },
) {
  if (!place.node_address) {
    throw new Error(
      `node ${place.node_hostname} has no address recorded — the control plane ` +
      'cannot reach the pooler on a node it does not know how to reach');
  }
  return { host: place.node_address, port: place.pooler_port };
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
  const { rows } = await pool.query<{
    id: string; ref: string; plan: string; name: string; status: string;
  }>(
    `SELECT id, ref::text AS ref, plan::text AS plan, name, status::text AS status
       FROM projects WHERE id = $1`,
    [projectId]);
  if (!rows[0]) throw new Error(`project ${projectId} no longer exists`);
  return rows[0];
}

/**
 * The superuser passwords that could be live right now, newest first: the stored
 * random one if store_credentials has already run, then the derived bootstrap
 * password the container was created with.
 */
/**
 * Superuser passwords to try, newest first. Exported because the disk ladder needs
 * an admin connection too, and a second copy of this would be a second place for
 * the bootstrap fallback to be forgotten.
 */
export async function superuserCandidates(deps: SagaDeps, projectId: string): Promise<string[]> {
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

  /**
   * Idempotently ensure the project's network exists, returning its name.
   *
   * Shared by `create_network` and `start_container` on purpose. Every other step
   * in these sagas is safe to run on its own — `create_volume` checks first,
   * `start_container` checks for an existing container — and `start_container`
   * briefly broke that pattern by depending on a precondition it did not verify.
   * The symptom was a Docker 404 from deep inside container start ("network
   * cb-…-net not found"), which reads as an infrastructure fault rather than as a
   * missing step, and which is exactly what an operator would waste an hour on.
   */
  async function ensureNetwork(ctx: SagaContext, ref: string): Promise<string> {
    const docker = requireDocker(deps);
    const name = networkName(ref);
    if (await docker.networkExists(name)) return name;
    await docker.createNetwork(name, { [LABEL_REF]: ref, [LABEL_MANAGED]: 'true' });
    ctx.log('network created', { network: name });
    return name;
  }

  /**
   * The project's private network (P2a).
   *
   * It exists before the container so the container can join it at create time
   * rather than being attached afterwards — a container that starts unattached
   * resolves nothing for the first moments of its life, and for the pooler that
   * window is exactly when it first reaches for `db`.
   *
   * Postgres does not need a network to serve its published port, so this step is
   * strictly substrate for what comes next: the pooler
   * ([pooling §5](../../../docs/03-database-platform/02-connection-pooling.md)
   * configures `host=db`) and, in Phase 5, PostgREST.
   */
  const createNetwork: SagaStep<SagaContext> = {
    name: 'create_network',
    async run(ctx) {
      const project = await loadProject(deps.pool, ctx.job.project_id!);
      const name = await ensureNetwork(ctx, project.ref);
      ctx.log('network ready', { network: name });
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
          // Ensured rather than assumed — a container create that names a missing
          // network fails with a Docker 404 that looks nothing like "a step was
          // skipped".
          networkName: await ensureNetwork(ctx, project.ref),
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
        // P2b: the pooler authenticates to Postgres as this role to run the
        // auth_query lookup. Generated here like every other credential so the
        // pooler's config is rendered from the store, never from a literal.
        { name: SECRET_NAMES.poolerAuth, role: POOLER_AUTH_ROLE },
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
   * The project's connection pooler (P2b, D-015).
   *
   * It comes after `store_credentials` because the pooler's own credential has to
   * exist and be *applied* to `pgbouncer_auth` before PgBouncer can authenticate
   * to Postgres to run its lookup query. Starting it earlier produces a pooler
   * that is listening and unable to serve anyone, which is the worst of the two
   * failure modes because it looks healthy.
   */
  const startPooler: SagaStep<SagaContext> = {
    name: 'start_pooler',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      const name = poolerName(project.ref);

      if (!(await docker.imageExists(POOLER_IMAGE))) {
        // Same reasoning as the database image: a missing image discovered here is
        // a clear sentence, discovered later it is a container that will not start.
        throw new Error(
          `pooler image ${POOLER_IMAGE} is not present on the node — pre-pull it (D-071)`);
      }

      const secrets = requireSecrets(deps);
      const authPassword = await secrets.get(projectId, SECRET_NAMES.poolerAuth);
      if (!authPassword) {
        // Not a retry-and-hope case: the credential is created by
        // store_credentials, so its absence means that step has not run. Starting
        // a pooler without it would produce one that listens and can serve nobody.
        throw new Error(
          'the pooler credential is not stored yet — store_credentials must run first');
      }

      let inspect = await docker.inspectContainer(name);
      if (!inspect) {
        const id = await docker.createContainer(name, buildPoolerSpec({
          ref: project.ref,
          networkName: await ensureNetwork(ctx, project.ref),
          hostPort: place.pooler_port,
          authPassword,
        }));
        ctx.log('pooler created', { name, container: id.slice(0, 12), port: place.pooler_port });
        inspect = await docker.inspectContainer(name);
      } else {
        ctx.log('pooler already exists — reusing', { name, state: inspect.State.Status });
      }

      if (!inspect!.State.Running) {
        await docker.startContainer(inspect!.Id);
        ctx.log('pooler started', { name });
      }

      await deps.pool.query(
        `UPDATE project_databases SET pooler_container_id = $2 WHERE project_id = $1`,
        [projectId, inspect!.Id]);
    },
  };

  /**
   * Prove the pooled path end to end before calling the project ready.
   *
   * The probe connects as `developer` *through* the pooler and runs a query, which
   * is the only check that exercises the whole chain: PgBouncer accepted the
   * client, authenticated itself to Postgres as `pgbouncer_auth`, resolved the
   * customer's verifier through `corebase.pgbouncer_lookup`, and proxied a real
   * transaction. A TCP check on 6432 would pass for a pooler that can do none of
   * that, and "listening" is the least interesting half of working.
   */
  const waitPoolerHealthy: SagaStep<SagaContext> = {
    name: 'wait_pooler_healthy',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      const secrets = requireSecrets(deps);
      const password = await secrets.get(projectId, SECRET_NAMES.developer);
      if (!password) {
        throw new Error(
          'the developer credential is not stored yet — the pooled path cannot be probed');
      }
      const deadline = Date.now() + (deps.healthTimeoutMs ?? 60_000);

      let lastError = 'never attempted';
      while (Date.now() < deadline) {
        // Fatal-vs-transient, same discipline as the database gate: a pooler that
        // has exited will never answer, so waiting out the timeout only delays the
        // real message.
        const inspect = await docker.inspectContainer(poolerName(project.ref));
        if (inspect && !inspect.State.Running && !inspect.State.Restarting) {
          throw new Error(
            `pooler exited (${inspect.State.ExitCode}) before it answered: ` +
            `${inspect.State.Error || 'no error recorded'}`);
        }

        const endpoint = poolerEndpoint(place);
        const client = new PgClient({
          host: endpoint.host,
          port: endpoint.port,
          user: DEVELOPER_ROLE,
          password,
          database: 'postgres',
          connectionTimeoutMillis: 3_000,
          // PgBouncer terminates the client connection itself; TLS to the pooler
          // is the gateway's job in a later phase, not the pooler's.
          ssl: false,
        });
        try {
          await client.connect();
          const { rows } = await client.query<{ ok: string }>(
            `SELECT current_user || '@' || inet_server_port() AS ok`);
          ctx.log('pooled path verified', {
            via: `${endpoint.host}:${endpoint.port}`, reached: rows[0]?.ok,
          });
          return;
        } catch (err) {
          lastError = (err as Error).message;
        } finally {
          await client.end().catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`pooler never served a connection: ${lastError}`);
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
        pooler_container_id: string | null;
        secret_count: number; api_key_count: number;
      }>(`SELECT d.status::text AS db_status, d.connection_host, d.container_id,
                 d.pooler_container_id,
                 (SELECT count(*)::int FROM project_secrets s
                   WHERE s.project_id = d.project_id AND s.state = 'active') AS secret_count,
                 (SELECT count(*)::int FROM project_api_keys k
                   WHERE k.project_id = d.project_id AND k.revoked_at IS NULL) AS api_key_count
            FROM project_databases d WHERE d.project_id = $1`, [projectId]);
      const row = rows[0];
      if (!row) throw new Error('no placement row — cannot mark a project ready');
      const problems: string[] = [];
      if (row.db_status !== 'running') problems.push(`database status is ${row.db_status}`);
      if (!row.container_id) problems.push('no container recorded');
      if (!row.connection_host) problems.push('no connection host');
      // Four now, not three: the pooler's own credential joined the set in P2b.
      if (row.secret_count < 4) problems.push(`only ${row.secret_count} credentials stored`);
      if (!row.pooler_container_id) {
        // A ready project without a pooler is one whose DATABASE_URL — the string
        // the docs tell every application to use — does not connect.
        problems.push('no pooler recorded');
      }
      if (row.api_key_count < 2) {
        // A ready project with no keys is one the data API cannot serve.
        problems.push(`only ${row.api_key_count} api key(s) minted`);
      }
      if (problems.length > 0) {
        throw new Error(`refusing to mark ready: ${problems.join('; ')}`);
      }

      await deps.pool.query(
        `UPDATE projects SET status = 'ready' WHERE id = $1 AND status <> 'ready'`, [projectId]);
      ctx.log('project is ready');
    },
  };


  // ── deletion, phase one: reversible (D-038) ──────────────────────────────
  //
  // Nothing here destroys data. The container stops, the volume stays, and the
  // project spends 7 days in soft_deleted where a restore is a status flip.

  const disableApi: SagaStep<SagaContext> = {
    name: 'disable_api',
    async run(ctx) {
      // The gateway does not exist yet, so there is no route to darken. Said out
      // loud rather than silently skipped: when the gateway lands, this step
      // becomes real, and a reader of these logs should be able to tell the
      // difference between "done" and "nothing to do yet".
      ctx.log('no gateway route to disable yet — data-plane routing is a later phase');
    },
  };

  const disableWrites: SagaStep<SagaContext> = {
    name: 'disable_writes',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const place = await loadPlacement(deps.pool, projectId);
      if (!place.container_id) { ctx.log('no container — nothing to make read-only'); return; }
      const docker = requireDocker(deps);
      const state = await docker.inspectContainer(place.container_id);
      if (!state?.State.Running) { ctx.log('container is not running — nothing to do'); return; }

      // Defence in depth, not the primary control: the route is already dark.
      // This stops a client holding a direct connection from writing data that
      // the final backup, taken next, would not contain.
      const client = await connectAsSuperuser({
        ...adminEndpoint(place), passwords: await superuserCandidates(deps, projectId),
      });
      try {
        await client.query('ALTER DATABASE postgres SET default_transaction_read_only = on');
        ctx.log('database set read-only');
      } finally {
        await client.end().catch(() => {});
      }
    },
  };

  const finalBackup: SagaStep<SagaContext> = {
    name: 'final_backup',
    async run(ctx) {
      if (deps.requireFinalBackup) {
        // D-066: the one moment a backup absolutely must work is when everything
        // else is about to be deleted. Fail closed.
        throw new Error(
          'a verified final backup is required before deletion (D-066) and no ' +
          'backup system exists yet — unset CB_REQUIRE_FINAL_BACKUP to delete ' +
          'without one, knowingly');
      }
      ctx.log('final backup skipped — no backup system in Milestone 0 (D-066 gate is off)');
    },
  };

  const stopContainer: SagaStep<SagaContext> = {
    name: 'stop_container',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const place = await loadPlacement(deps.pool, projectId);
      if (!place.container_id) { ctx.log('no container recorded — nothing to stop'); return; }
      const docker = requireDocker(deps);
      const state = await docker.inspectContainer(place.container_id);
      if (!state) { ctx.log('container already gone'); return; }
      if (!state.State.Running) { ctx.log('container already stopped'); return; }

      // Clear the restart policy first, or unless-stopped (D-184) brings it
      // straight back and the "stopped" state we just asserted is a fiction.
      await docker.setRestartPolicy(place.container_id, 'no');
      await docker.stopContainer(place.container_id);
      ctx.log('container stopped, volume kept');
    },
  };

  /**
   * Stop the pooler as well (P2b).
   *
   * Its own step rather than a second half of `stop_container`, so a crash between
   * the two is a resumable checkpoint rather than an ambiguous partial. It runs
   * *before* the database stops in the delete saga: a pooler left running against
   * a stopped Postgres answers connections and then fails them, which reads to a
   * customer as "the database is broken" rather than "the project is deleted".
   */
  const stopPooler: SagaStep<SagaContext> = {
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId).catch(() => undefined);
      const docker = requireDocker(deps);
      // Recorded id first, derived name as the fallback — the row may be missing
      // on a retry, and "no row so nothing to stop" would leave it serving.
      const target = place?.pooler_container_id ?? poolerName(project.ref);
      const state = await docker.inspectContainer(target);
      if (!state) { ctx.log('no pooler to stop'); return; }
      if (!state.State.Running) { ctx.log('pooler already stopped'); return; }
      await docker.setRestartPolicy(state.Id, 'no');
      await docker.stopContainer(state.Id);
      ctx.log('pooler stopped');
    },
    name: 'stop_pooler',
  };

  const markSoftDeleted: SagaStep<SagaContext> = {
    name: 'mark_soft_deleted',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const window = deps.softDeleteWindow ?? '7 days';
      // COALESCE so a re-run does not slide the window forward: the clock starts
      // when the customer asked, not when the retry happened.
      const { rows } = await deps.pool.query<{ purge_after: string }>(
        `UPDATE projects
            SET status = 'soft_deleted',
                deleted_at = COALESCE(deleted_at, now()),
                purge_after = COALESCE(purge_after, now() + $2::interval)
          WHERE id = $1
        RETURNING to_char(purge_after, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS purge_after`,
        [projectId, window]);
      await deps.pool.query(
        `UPDATE project_databases SET status = 'deleting' WHERE project_id = $1`, [projectId]);
      ctx.log('project soft-deleted — restorable until the purge', {
        purge_after: rows[0]?.purge_after, window,
      });
    },
  };

  // ── deletion, phase two: irreversible ────────────────────────────────────

  const verifyPurgeable: SagaStep<SagaContext> = {
    name: 'verify_purgeable',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const { rows } = await deps.pool.query<{
        status: string; due: boolean; purge_after: string | null;
      }>(`SELECT status::text AS status,
                 (purge_after IS NOT NULL AND purge_after <= now()) AS due,
                 to_char(purge_after, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS purge_after
            FROM projects WHERE id = $1`, [projectId]);
      const row = rows[0];
      if (!row) throw new Error('project no longer exists');
      if (row.status === 'deleted') { ctx.log('already purged'); return; }

      // The guard that makes the recovery window mean something. Everything
      // after this step destroys data, so a purge that arrives early — a
      // mis-scheduled job, a clock skew, an operator with a stale queue — must
      // be refused, not obeyed.
      if (row.status !== 'soft_deleted') {
        throw new Error(`refusing to purge a project in status ${row.status} — only soft_deleted may be purged`);
      }
      if (!row.due) {
        throw new Error(
          `refusing to purge before the recovery window closes (purge_after ${row.purge_after})`);
      }
      ctx.log('purge is due', { purge_after: row.purge_after });
    },
  };

  const removeContainer: SagaStep<SagaContext> = {
    name: 'remove_container',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId).catch(() => undefined);
      const docker = requireDocker(deps);
      // By name as well as by id: a container created just before a crash may
      // exist with no id recorded, and leaving it behind would be a resource
      // leak invisible to the control plane.
      // Both of the project's containers (P2b), by id and by derived name.
      const targets = [
        place?.container_id, containerName(project.ref),
        place?.pooler_container_id, poolerName(project.ref),
      ].filter(Boolean);
      for (const target of targets) {
        await docker.removeContainer(target as string);
      }
      if (place) {
        await deps.pool.query(
          `UPDATE project_databases
              SET container_id = NULL, pooler_container_id = NULL
            WHERE project_id = $1`, [projectId]);
      }
      ctx.log('containers removed', { database: true, pooler: true });
    },
  };

  const removeVolume: SagaStep<SagaContext> = {
    name: 'remove_volume',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId).catch(() => undefined);
      // Prefer the recorded name, fall back to the derived one: the row may
      // already be gone on a retry, and "no row so nothing to remove" would
      // leave the customer's data on the node forever.
      const volume = place?.volume_name ?? volumeNameFor(project.ref);
      const docker = requireDocker(deps);
      await docker.removeVolume(volume);
      ctx.log('volume removed — this is the irreversible step', { volume });
    },
  };

  /**
   * The project's network, after its container is gone.
   *
   * Order matters: Docker refuses to remove a network with containers attached,
   * so this cannot precede remove_container. It is separate from remove_volume
   * because it destroys no data — a network is routing, not storage — and lumping
   * a reversible step in with the irreversible one blurs which is which.
   */
  const removeNetwork: SagaStep<SagaContext> = {
    name: 'remove_network',
    async run(ctx) {
      const project = await loadProject(deps.pool, ctx.job.project_id!);
      const name = networkName(project.ref);
      const docker = requireDocker(deps);
      await docker.removeNetwork(name);
      ctx.log('network removed', { network: name });
    },
  };

  const deleteCredentials: SagaStep<SagaContext> = {
    name: 'delete_credentials',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const { rowCount } = await deps.pool.query(
        `DELETE FROM project_secrets WHERE project_id = $1`, [projectId]);
      ctx.log('credentials deleted', { rows: rowCount ?? 0 });
    },
  };

  const verifyGone: SagaStep<SagaContext> = {
    name: 'verify_gone',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const docker = requireDocker(deps);
      // List-and-assert, not trust-the-previous-step. "Delete leaves no residue"
      // is a claim about the node, and the only way to make it a property of the
      // code rather than of a test is to check the node here.
      const leftovers: string[] = [];
      const containers = await docker.listContainers(`${LABEL_REF}=${project.ref}`);
      if (containers.length > 0) {
        leftovers.push(`${containers.length} container(s) still present`);
      }
      // By derived name, not by reading the placement row: release_capacity has
      // already deleted that row by now, and a check that skips when the row is
      // missing would pass without checking anything.
      const volume = volumeNameFor(project.ref);
      if (await docker.volumeExists(volume)) leftovers.push(`volume ${volume} still present`);
      // A leaked network is not a data leak, but it is a leak: bridge networks
      // each consume a subnet from Docker's address pool, and a node that has
      // exhausted it cannot create the next project's network at all.
      const network = networkName(project.ref);
      if (await docker.networkExists(network)) leftovers.push(`network ${network} still present`);
      const secrets = await deps.pool.query(
        `SELECT 1 FROM project_secrets WHERE project_id = $1`, [projectId]);
      if (secrets.rowCount) leftovers.push(`${secrets.rowCount} credential row(s) still present`);
      const placement = await deps.pool.query(
        `SELECT 1 FROM project_databases WHERE project_id = $1`, [projectId]);
      if (placement.rowCount) leftovers.push('placement row still present — capacity was not released');

      if (leftovers.length > 0) {
        throw new Error(`purge incomplete: ${leftovers.join('; ')}`);
      }
      ctx.log('verified: no container, no network, no volume, no credentials');
    },
  };

  const markDeleted: SagaStep<SagaContext> = {
    name: 'mark_deleted',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      // The placement row is already gone: release_capacity deletes it, and it
      // must, because `UNIQUE (node_id, port)` means a retained row holds that
      // port forever against a range of a thousand. The projects row stays — the
      // ref is never reused (D-061), so a stale client can never be pointed at
      // someone else's project.
      await deps.pool.query(
        `UPDATE projects SET status = 'deleted' WHERE id = $1 AND status <> 'deleted'`, [projectId]);
      ctx.log('project deleted');
    },
  };


  /**
   * The project's signing keypair and its two API keys (D-014, D-029).
   *
   * Runs at provision time so the role model and the keys that address it arrive
   * together — a project that is ready but has no keys is a project the data API
   * cannot serve, and retrofitting keys means a second code path forever.
   *
   * Check-then-act on the `project_api_keys` rows: if both exist, this has run,
   * and re-minting would hand the customer new keys while their app holds the old
   * ones.
   */
  const generateApiKeys: SagaStep<SagaContext> = {
    name: 'generate_api_keys',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const secrets = requireSecrets(deps);
      const project = await loadProject(deps.pool, projectId);

      const { rows: existing } = await deps.pool.query<{ kind: string }>(
        `SELECT kind FROM project_api_keys
          WHERE project_id = $1 AND revoked_at IS NULL`, [projectId]);
      if (existing.length >= 2) {
        ctx.log('api keys already present — reusing', { kinds: existing.map((r) => r.kind) });
        return;
      }

      // The keypair is generated once and kept; a retry after a partial run must
      // sign with the same key or the first-minted key stops verifying.
      let privateKeyPem = await secrets.get(projectId, SECRET_NAMES.jwtPrivateKey);
      let kid = await secrets.get(projectId, SECRET_NAMES.jwtKid);
      if (!privateKeyPem || !kid) {
        const pair = generateKeypair();
        await secrets.put(projectId, SECRET_NAMES.jwtPrivateKey, pair.privateKeyPem);
        await secrets.put(projectId, SECRET_NAMES.jwtPublicKey, pair.publicKeyPem);
        await secrets.put(projectId, SECRET_NAMES.jwtKid, pair.kid);
        privateKeyPem = pair.privateKeyPem;
        kid = pair.kid;
        ctx.log('signing keypair generated', { kid });
      }

      const issuer = deps.jwtIssuer ?? `https://${project.ref}.${deps.projectDomain ?? 'corebase.co'}`;
      for (const role of ['anon', 'service_role'] as const) {
        if (existing.some((r) => r.kind === role)) continue;
        const token = signJwt(
          projectKeyClaims({ ref: project.ref, role, issuer }),
          { privateKeyPem, kid });
        const name = role === 'anon' ? SECRET_NAMES.anonKey : SECRET_NAMES.serviceRoleKey;
        // `cbk_anon_kxqw` / `cbk_srv_kxqw`, per the platform-API example — a
        // *label*, not a slice of the token. A literal prefix of a JWT is the
        // base64 of its header, which is byte-identical for every key of every
        // project and so identifies nothing: the first live run showed both keys
        // displaying as "eyJhbGciOiJF".
        const prefix = `cbk_${role === 'anon' ? 'anon' : 'srv'}_${project.ref.slice(0, 4)}`;
        // Envelope-encrypted (D-214) so a reveal is byte-identical, and hashed in
        // project_api_keys so revocation is a lookup that never needs the key.
        await secrets.put(projectId, name, token);
        await deps.pool.query(
          `INSERT INTO project_api_keys (project_id, kind, key_hash, key_prefix)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (key_hash) DO NOTHING`,
          [projectId, role, createHash('sha256').update(token).digest('hex'), prefix]);
        ctx.log('api key minted', { role, key_prefix: prefix });
      }
    },
  };

  // ── pause / resume (P2c, D-008) ───────────────────────────────────────────
  //
  // Pause is what makes a database-per-free-project affordable: an idle project
  // gives its RAM back and keeps everything else. The order below is the doc's,
  // and each step is where it is for a reason worth stating.

  /**
   * Announce the intent before touching anything.
   *
   * `pausing` is a state the API and dashboard can read, so a customer who opens
   * the project mid-pause sees "pausing" rather than a project that is briefly
   * lying about being ready.
   */
  const markPausing: SagaStep<SagaContext> = {
    name: 'mark_pausing',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const { rows } = await deps.pool.query<{ status: string }>(
        `UPDATE projects SET status = 'pausing', updated_at = now()
          WHERE id = $1 AND status IN ('ready', 'pausing')
        RETURNING status::text AS status`, [projectId]);
      if (!rows[0]) {
        const cur = await loadProject(deps.pool, projectId);
        // An already-paused project is a *completed* pause, not a bad request.
        // Whole sagas get re-delivered — orphan recovery replays a job whose
        // checkpoints all succeeded — and a re-delivered pause that fails here
        // would raise an alarm about work that is already done.
        //
        // Validating user intent is the API's job, not this one: the endpoint
        // returns 409 for "already paused" because a person asked for something
        // that cannot happen. A job is not a person.
        if (cur.status === 'paused') { ctx.log('already paused — nothing to do'); return; }
        throw new Error(`refusing to pause a project that is ${cur.status}`);
      }
      ctx.log('pausing');
    },
  };

  /**
   * A clean Postgres shutdown, not a container stop.
   *
   * `CHECKPOINT` then a fast, graceful stop means the volume is left with no WAL to
   * replay, which is most of why resume is single-digit seconds rather than tens.
   * Killing the container instead would work — Postgres is crash-safe — and would
   * spend the recovery on every single resume.
   */
  const checkpointAndStop: SagaStep<SagaContext> = {
    name: 'checkpoint_and_stop',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      const docker = requireDocker(deps);

      // The pooler first: it should stop accepting before the database goes, or
      // the last few clients get a connection that dies mid-query.
      const pooler = await docker.inspectContainer(
        place.pooler_container_id ?? poolerName(project.ref));
      if (pooler?.State.Running) {
        await docker.setRestartPolicy(pooler.Id, 'no');
        await docker.stopContainer(pooler.Id);
        ctx.log('pooler stopped');
      }

      const db = await docker.inspectContainer(place.container_id ?? containerName(project.ref));
      if (!db) { ctx.log('no database container — nothing to stop'); return; }
      if (db.State.Running) {
        // CHECKPOINT inside the container, so a slow disk shows up here rather
        // than as a stop timeout. Failure is logged and not fatal: the shutdown
        // below is still clean, it just has more to flush.
        const { exitCode } = await docker.exec(db.Id, ['psql', '-h', '127.0.0.1', '-U', 'postgres',
          '-d', 'postgres', '-c', 'CHECKPOINT']);
        ctx.log(exitCode === 0 ? 'checkpointed' : 'checkpoint did not run cleanly',
          { exit_code: exitCode });

        await docker.setRestartPolicy(db.Id, 'no');
        await docker.stopContainer(db.Id);
        ctx.log('database stopped cleanly — no WAL to replay on resume');
      } else {
        ctx.log('database already stopped');
      }
    },
  };

  /**
   * Remove the containers, keep the volume, the network and the placement row.
   *
   * The doc is explicit that a paused project keeps its volume, network definition
   * and config — so what is removed is only the two containers, and their removal is
   * why a paused project costs no container overhead at all rather than the few MB a
   * stopped container still holds.
   *
   * The placement row is what makes resume give back the *same* connection string:
   * the port, the pooler port and the volume name all live there.
   */
  const removePausedContainers: SagaStep<SagaContext> = {
    name: 'remove_paused_containers',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId).catch(() => undefined);
      const docker = requireDocker(deps);
      for (const target of [
        place?.pooler_container_id, poolerName(project.ref),
        place?.container_id, containerName(project.ref),
      ].filter(Boolean)) {
        await docker.removeContainer(target as string);
      }
      await deps.pool.query(
        `UPDATE project_databases
            SET container_id = NULL, pooler_container_id = NULL
          WHERE project_id = $1`, [projectId]);
      ctx.log('containers removed; volume, network and placement kept');
    },
  };

  /**
   * Give the RAM back and record the state.
   *
   * Last, and deliberately after the containers are gone: crediting the node while
   * containers were still running would let the placer put a new project on memory
   * this one is still using.
   */
  const markPaused: SagaStep<SagaContext> = {
    name: 'mark_paused',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const { released, freedMb } = await releaseRam(deps.pool, { projectId });
      await deps.pool.query(
        `UPDATE project_databases
            SET status = 'paused', paused_at = COALESCE(paused_at, now())
          WHERE project_id = $1`, [projectId]);
      await deps.pool.query(
        `UPDATE projects
            SET status = 'paused', paused_at = COALESCE(paused_at, now()), updated_at = now()
          WHERE id = $1`, [projectId]);
      ctx.log('paused — disk kept, RAM returned', {
        ref: project.ref, freed_mb: freedMb, already_released: !released,
      });
    },
  };

  /**
   * Take the RAM back before starting anything.
   *
   * First, because it is the step that can legitimately fail: a node that filled up
   * while this project slept cannot take it back, and finding that out *after*
   * starting containers means running a project the node never agreed to hold.
   */
  const markResuming: SagaStep<SagaContext> = {
    name: 'mark_resuming',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const { rows } = await deps.pool.query<{ status: string }>(
        `UPDATE projects SET status = 'resuming', updated_at = now()
          WHERE id = $1 AND status IN ('paused', 'resuming', 'pausing')
        RETURNING status::text AS status`, [projectId]);
      if (!rows[0]) {
        const cur = await loadProject(deps.pool, projectId);
        if (cur.status === 'ready') { ctx.log('already ready — nothing to resume'); return; }
        throw new Error(`refusing to resume a project that is ${cur.status}`);
      }
      const { rebooked, bookedMb } = await bookRam(deps.pool, { projectId, plan: project.plan });
      ctx.log('resuming', { booked_mb: bookedMb, already_booked: !rebooked });
    },
  };

  /**
   * Bring the project back and clear the paused marks.
   *
   * The heavy lifting is deliberately *not* here: the resume saga reuses
   * `create_network`, `start_container`, `wait_healthy`, `start_pooler` and
   * `wait_pooler_healthy` unchanged, because those steps are already idempotent and
   * already know how to find an existing volume. A bespoke resume path would be a
   * second, less-tested way to start a project.
   */
  const markResumed: SagaStep<SagaContext> = {
    name: 'mark_resumed',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      await deps.pool.query(
        `UPDATE project_databases
            SET status = 'running', paused_at = NULL, last_active_at = now()
          WHERE project_id = $1`, [projectId]);
      await deps.pool.query(
        `UPDATE projects SET status = 'ready', paused_at = NULL, updated_at = now()
          WHERE id = $1`, [projectId]);
      ctx.log('resumed — same port, same volume, same connection string');
    },
  };

  // ── credential rotation (P2d, credentials doc §4a) ─────────────────────────

  /**
   * Store the new password, then apply it. In that order, always.
   *
   * Store-then-apply is the rule the whole secret design turns on (D-035). A crash
   * between the two leaves a password that is stored and not yet in effect, and the
   * retry applies it — recoverable. The other order leaves a database whose password
   * exists nowhere, which needs the superuser to fix and is exactly the incident
   * this ordering exists to prevent.
   *
   * The payoff of auth_query (D-074) shows up here as an absence: **the pooler needs
   * nothing.** No config to re-render, no file to ship, no reload — it reads
   * `pg_shadow` live through the lookup function, so a rotation is one `ALTER ROLE`
   * and the pooled port keeps working. That absence is the single biggest reason
   * D-074 chose auth_query over a userlist file.
   */
  const rotateDeveloperPassword: SagaStep<SagaContext> = {
    name: 'rotate_developer_password',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const secrets = requireSecrets(deps);
      const place = await loadPlacement(deps.pool, projectId);
      const endpoint = adminEndpoint(place);

      // Store first.
      const { value, previous, version } = await secrets.rotate(
        projectId, SECRET_NAMES.developer);
      ctx.log('new credential stored, not yet in effect', {
        version, had_previous: previous !== undefined,
      });

      // Then apply, over a *direct* admin connection — not the pooled port. A
      // rotation that went through the pooler would be changing the credential the
      // pooler is authenticating with mid-statement.
      const client = await connectAsSuperuser({
        ...endpoint,
        passwords: await superuserCandidates(deps, projectId),
      });
      try {
        await setRolePassword(client, DEVELOPER_ROLE, value);
        ctx.log('credential applied — the pooler needed no reconfiguration (D-074)', {
          role: DEVELOPER_ROLE,
        });
      } finally {
        await client.end().catch(() => {});
      }
    },
  };

  /**
   * Optionally end sessions that authenticated with the old password.
   *
   * **Off by default, and that default is the interesting decision.** Postgres
   * authenticates at connect time only, so a password change does not touch
   * established sessions — a rotation is invisible to a running application, which
   * is what makes it safe to do routinely. A credential you are afraid to rotate is
   * a credential you will leak and keep.
   *
   * But "invisible" is wrong for the case that matters most: a leaked password. If
   * someone else is holding an open session, rotating without terminating changes
   * nothing for them. So the flag exists, it is opt-in, and it is documented as
   * compromise response rather than hygiene.
   */
  const terminateOldSessions: SagaStep<SagaContext> = {
    name: 'terminate_old_sessions',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const payload = (ctx.job.payload ?? {}) as { terminate?: boolean };
      if (!payload.terminate) {
        ctx.log('leaving established sessions alone — rotation is invisible to a ' +
          'running application unless asked otherwise');
        return;
      }
      const place = await loadPlacement(deps.pool, projectId);
      const client = await connectAsSuperuser({
        ...adminEndpoint(place),
        passwords: await superuserCandidates(deps, projectId),
      });
      try {
        // The customer's role only. Terminating our own connections would kill the
        // health probe and the pooler's lookups, which are not the threat.
        const { rows } = await client.query<{ killed: number }>(
          `SELECT count(*)::int AS killed FROM (
             SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE usename = $1 AND pid <> pg_backend_pid()
           ) t`, [DEVELOPER_ROLE]);
        ctx.log('sessions on the old credential terminated', {
          count: rows[0]?.killed ?? 0,
        });
      } finally {
        await client.end().catch(() => {});
      }
    },
  };

  /**
   * Drop the previous version once the support window has passed.
   *
   * Kept for 24 hours so "which credential is my app on" has an answer during an
   * incident; dropped after, because an old password that lives forever in the
   * control plane is an old password that can leak forever.
   */
  const purgeRetiredCredential: SagaStep<SagaContext> = {
    name: 'purge_retired_credential',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const secrets = requireSecrets(deps);
      const dropped = await secrets.purgeRetired(projectId);
      ctx.log(dropped > 0
        ? 'retired credential versions dropped'
        : 'no retired versions old enough to drop yet', { dropped });
    },
  };

  return {
    provision_project: [
      allocate,                      // T5c
      createVolume,                  // T5d
      createNetwork,                 // P2a
      startContainer,                // T5d
      waitHealthy,                   // T5d
      createBaseRoles,               // T5e
      storeCredentials,              // T5e
      generateApiKeys,               // P1e
      startPooler,                   // P2b
      waitPoolerHealthy,             // P2b — proves the whole pooled chain
      writeConnection,               // T5e
      markReady,                     // T5e
    ],
    // Phase one — reversible. Nothing here destroys data (D-038).
    delete_project: [
      disableApi,                    // T7
      disableWrites,                 // T7
      finalBackup,                   // T7 (gate, unimplemented in M0 — D-066)
      stopPooler,                    // P2b — before the database, see the step
      stopContainer,                 // T7
      removeNetwork,                 // P2a — holds no data; frees the subnet
      markSoftDeleted,               // T7
    ],
    // Idle projects give their RAM back and keep everything else (D-008).
    pause_project: [
      markPausing,                   // P2c
      finalBackup,                   // D-078 gate — unimplemented until Phase 3
      checkpointAndStop,             // P2c
      removePausedContainers,        // P2c
      markPaused,                    // P2c — credits the node last
    ],
    // Resume reuses the provisioning steps rather than reimplementing them.
    resume_project: [
      markResuming,                  // P2c — books RAM first; this is what can fail
      createNetwork,                 // P2a — idempotent
      startContainer,                // T5d — finds the kept volume
      waitHealthy,                   // T5d
      startPooler,                   // P2b
      waitPoolerHealthy,             // P2b
      markResumed,                   // P2c
    ],
    // Credential rotation (P2d). The pooler is absent from this list on purpose:
    // auth_query means it needs nothing (D-074).
    rotate_credentials: [
      rotateDeveloperPassword,       // P2d — store, then apply
      terminateOldSessions,          // P2d — opt-in, compromise response
      purgeRetiredCredential,        // P2d — 24h window
    ],
    // Phase two — irreversible, and gated on the window having closed.
    purge_project: [
      verifyPurgeable,               // T7
      removeContainer,               // T7
      removeNetwork,                 // P2a — after the container, which pins it
      removeVolume,                  // T7
      deleteCredentials,             // T7
      release,                       // T5c's idempotent inverse
      verifyGone,                    // T7 — asserts against the node, last
      markDeleted,                   // T7
    ],
  };
}
