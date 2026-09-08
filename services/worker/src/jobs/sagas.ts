import { Client as PgClient, type Pool } from 'pg';
import type { SagaStep, SagaContext } from './runner.ts';
import { allocateNode, releaseNode, releaseRam, bookRam, volumeNameFor } from '../placement.ts';
import type { Docker } from '../docker.ts';
import { nodeCaps } from '../node-caps.ts';
import {
  repoTargetFromEnv, renderPgbackrestConf, writeConf, stanzaCreate, repoPathFor, STANZA,
  check as backupCheck, pgbackrestFailure,
  info as backupInfo, backup as takePgbackrest, restore as pgbackrestRestore,
} from '../backup.ts';
import { decideBackup } from '../backup-schedule.ts';
import { createRepoDestroy, REPO_RETENTION_DAYS } from '../repo-destroy.ts';
import { backupRunsTotal } from '../metrics.ts';
import {
  buildContainerSpec, buildPoolerSpec, bootstrapPassword, containerName, networkName,
  poolerName, IMAGE, POOLER_IMAGE, LABEL_MANAGED, LABEL_REF,
  postgrestName, buildPostgrestSpec, POSTGREST_IMAGE,
} from '../container-spec.ts';
import type { SecretStore } from '@steadhold/secrets';
import { SECRET_NAMES } from '@steadhold/secrets';
import { createHash } from 'node:crypto';
import { generateKeypair, sign as signJwt, projectKeyClaims, toJwk, keyLabel } from '@steadhold/jwt';
import {
  auditImageRoles, connectAsSuperuser, ensureDeveloperRole, ensureStorageOwnership,
  setRolePassword,
  DEVELOPER_ROLE, POOLER_AUTH_ROLE, AUTH_ROLE,
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
  /**
   * Refuse to provision a project that cannot be backed up (P3a).
   *
   * Off while Phase 3 is being built, because a fleet with no repo configured has
   * to be able to provision at all, and on once it is finished — at which point a
   * project without a repo is a project with no PITR, and provisioning one
   * quietly is exactly the "we lost a beta user's data" path Phase 3 was moved up
   * to close.
   */
  requireBackups?: boolean;
}

/** Placement row for a project — every Docker step needs it. */
async function loadPlacement(pool: Pool, projectId: string) {
  const { rows } = await pool.query<{
    volume_name: string; port: number; pooler_port: number; ram_limit_mb: number;
    container_id: string | null; pooler_container_id: string | null;
    postgrest_port: number | null; postgrest_admin_port: number | null;
    postgrest_container_id: string | null;
    node_address: string | null; node_hostname: string;
  }>(`SELECT d.volume_name, d.port, d.pooler_port, d.ram_limit_mb, d.container_id,
             d.pooler_container_id, d.postgrest_port, d.postgrest_admin_port,
             d.postgrest_container_id,
             n.address AS node_address, n.hostname AS node_hostname
        FROM project_databases d JOIN nodes n ON n.id = d.node_id
       WHERE d.project_id = $1`, [projectId]);
  if (!rows[0]) throw new Error('no placement row — allocate_node must run first');
  return rows[0];
}

/**
 * The project's published verification keys, as a JWKS document.
 *
 * **Every published key**, which is the same set the two JWKS endpoints serve and
 * deliberately not just the signing one. P4h's rotation dual-publishes: for the
 * length of a swap window a project has an incoming or outgoing key alongside the
 * active one, and a PostgREST holding a single kid rejects tokens that are
 * perfectly valid — a failure that arrives on a day nobody touched auth and looks
 * like the auth module breaking.
 *
 * Which also names the thing this does *not* yet do: a rotation after this
 * container starts leaves it holding a stale set. Step 3 of the rotation runbook
 * — reload each PostgREST's key file — is the piece that closes it, and it is
 * recorded as unbuilt rather than assumed away (OQ-112).
 */
async function projectJwks(
  deps: SagaDeps, projectId: string,
): Promise<{ keys: Array<Record<string, unknown>> }> {
  const secrets = requireSecrets(deps);
  const [pub, kid] = await Promise.all([
    secrets.get(projectId, SECRET_NAMES.jwtPublicKey),
    secrets.get(projectId, SECRET_NAMES.jwtKid),
  ]);
  const keys: Array<Record<string, unknown>> = [];
  if (pub && kid) keys.push(toJwk(pub, kid));

  const { rows } = await deps.pool.query<{ kid: string; public_key_pem: string }>(
    `SELECT kid, public_key_pem FROM project_signing_keys
      WHERE project_id = $1 AND status IN ('next', 'retiring')
      ORDER BY published_at`, [projectId]);
  for (const r of rows) keys.push(toJwk(r.public_key_pem, r.kid));
  return { keys };
}

function requireSecrets(deps: SagaDeps): SecretStore {
  if (!deps.secrets) {
    throw new Error('no secret store configured — the control plane needs its KEK (SH_KEK_DIR)');
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
  if (!deps.docker) throw new Error('no Docker client configured (set SH_DOCKER_HOST/SH_DOCKER_CERT_DIR)');
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
   * sh-…-net not found"), which reads as an infrastructure fault rather than as a
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
          // The plan picks the I/O weight (P2f). Reading it off the project rather
          // than defaulting means an upgrade actually changes the container's
          // share of a contended disk, instead of only its invoice.
          plan: project.plan,
          // ...but only if the node can enforce a weight at all. Probed once per
          // node and cached; on a kernel without `io.weight` this is false and the
          // field is omitted, because setting it there is a start failure rather
          // than a no-op (node-caps.ts).
          ioWeight: (await nodeCaps(docker, IMAGE)).ioWeight,
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
      // Kept so the timeout message can say why the probe never ran, rather than
      // reporting a silent count of attempts that all failed identically.
      let probeError: string | undefined;
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
        //
        // The exec is wrapped because **`exec` against a container that has
        // already exited throws** rather than returning a non-zero code: the
        // Engine answers `POST /exec/<id>/start` with "container is not
        // running". Unwrapped, that raw API error escaped this loop and became
        // the step's failure — so a container whose entrypoint refused to
        // initialise reported `POST /exec/673c33c5…` instead of "container
        // exited while starting", and an operator learned nothing.
        //
        // It surfaced only in CI, because the timing decides it: on a slower
        // machine the probe wins the race and returns non-zero, and on a faster
        // one the container is gone first. A failure mode that depends on which
        // of two things happens first is one that will eventually happen in
        // production, so the fix belongs here and not in the test.
        //
        // A throw is treated exactly as a failed probe, which lets the inspect
        // below do the job the comment above already assigned it: decide whether
        // the container cannot exec *yet* or cannot exec *ever*.
        let exitCode: number | null = null;
        try {
          ({ exitCode } = await docker.exec(id,
            ['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-q']));
        } catch (err) {
          probeError = (err as Error).message;
        }
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
            `(container ${state.State.Status}, ${attempts} probes)` +
            // The last probe error, when there was one. A timeout whose probes
            // never actually ran is a different problem from one whose probes ran
            // and said no, and the message has to distinguish them.
            (probeError ? `; last probe error: ${probeError}` : ''));
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
        // The storage metadata tables move to the customer's role here, because
        // only a table's owner may create a policy on it and policies on
        // `storage.objects` *are* the file-permission system (P6a). It runs in
        // this step rather than at initdb for the plain reason that the role does
        // not exist until the line above.
        await ensureStorageOwnership(client);
        ctx.log(created ? 'created the developer role' : 'developer role already present',
          { roles_verified: audit.present.length, storage_owned_by: 'developer' });
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
        // P4a: the auth module's identity in this project's database. Set here so
        // a project is auth-ready from provision — a role that exists and cannot
        // log in is a half-built thing that is easy to forget. Its own credential
        // and not `authenticator`'s, because this one owns the password hashes.
        { name: SECRET_NAMES.authRole, role: AUTH_ROLE },
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
  /**
   * Start the project's PostgREST (P5b, D-011).
   *
   * After `generate_api_keys`, and that ordering is load-bearing rather than
   * tidy: PostgREST needs the project's JWKS at container start, and the keys are
   * minted by that step. Starting it first produces a data API that comes up and
   * rejects every token, which reads as an auth fault on a project nobody has
   * used yet.
   */
  const startPostgrest: SagaStep<SagaContext> = {
    name: 'start_postgrest',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      const name = postgrestName(project.ref);

      if (!(await docker.imageExists(POSTGREST_IMAGE))) {
        throw new Error(
          `postgrest image ${POSTGREST_IMAGE} is not present on the node — pre-pull it (D-071)`);
      }
      if (place.postgrest_port === null || place.postgrest_admin_port === null) {
        // A project placed before P5b. Its row has no ports and inventing them
        // here would bypass the allocator's uniqueness — the repair belongs in a
        // migration step of its own, not in a hot saga path.
        throw new Error(
          'this project was placed before the data API existed and has no PostgREST '
          + 'ports. Re-place it, or backfill the ports through the allocator.');
      }

      const secrets = requireSecrets(deps);
      const authenticatorPassword = await secrets.get(projectId, SECRET_NAMES.authenticator);
      if (!authenticatorPassword) {
        throw new Error(
          'the authenticator credential is not stored yet — store_credentials must run first');
      }

      // **Every published key**, not just the signing one. P4h's rotation
      // dual-publishes, and a PostgREST holding a single kid during a swap window
      // rejects tokens that are perfectly valid — which presents as "auth broke"
      // on a day nobody touched auth. Reading the same set the JWKS endpoints
      // serve is what keeps the two from disagreeing.
      const jwks = await projectJwks(deps, projectId);
      if (!jwks.keys.length) {
        throw new Error(
          'this project publishes no verification keys — generate_api_keys must run first');
      }

      let inspect = await docker.inspectContainer(name);
      if (!inspect) {
        const id = await docker.createContainer(name, buildPostgrestSpec({
          ref: project.ref,
          networkName: await ensureNetwork(ctx, project.ref),
          hostPort: place.postgrest_port,
          adminHostPort: place.postgrest_admin_port,
          authenticatorPassword,
          jwks,
          plan: project.plan,
        }));
        ctx.log('postgrest created', {
          name, container: id.slice(0, 12),
          port: place.postgrest_port, admin: place.postgrest_admin_port,
          kids: jwks.keys.map((k: Record<string, unknown>) => k['kid']),
        });
        inspect = await docker.inspectContainer(name);
      } else {
        ctx.log('postgrest already exists — reusing', { name, state: inspect.State.Status });
      }

      if (!inspect!.State.Running) {
        await docker.startContainer(inspect!.Id);
        ctx.log('postgrest started', { name });
      }

      await deps.pool.query(
        `UPDATE project_databases SET postgrest_container_id = $2 WHERE project_id = $1`,
        [projectId, inspect!.Id]);
    },
  };

  /**
   * Prove the data API answers before calling the project ready.
   *
   * `/ready` on the admin server, not `/live` and not a TCP check. The three are
   * genuinely different claims: a socket accepts while the process is starting,
   * `/live` passes while PostgREST cannot reach Postgres at all, and only
   * `/ready` means it connected *and* built a schema cache. Every failure this
   * step has caught in development — a revoked catalogue grant, a missing
   * pre-request function — produced a container that passed the first two and
   * served 503 to every request.
   */
  const waitPostgrestHealthy: SagaStep<SagaContext> = {
    name: 'wait_postgrest_healthy',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      const deadline = Date.now() + (deps.healthTimeoutMs ?? 60_000);
      const name = postgrestName(project.ref);
      // `node_address`, never `node_hostname` (D-192): the hostname is only what
      // the node calls itself, and using it as an address works right up until an
      // environment where it does not resolve.
      if (!place.node_address) {
        throw new Error('the node has no address — the data api cannot be probed');
      }
      const url = `http://${place.node_address}:${place.postgrest_admin_port}/ready`;

      let lastError = 'never attempted';
      while (Date.now() < deadline) {
        // Fatal-vs-transient, and it matters more here than for the pooler:
        // PostgREST *exits* when it cannot reach its database rather than
        // retrying forever, so a container that has gone will never answer and
        // waiting out the timeout only delays the real message.
        const inspect = await docker.inspectContainer(name);
        if (inspect && !inspect.State.Running && !inspect.State.Restarting) {
          const logs = await docker.containerLogs(name).catch(() => '');
          throw new Error(
            `postgrest exited (${inspect.State.ExitCode}) before it answered: `
            + `${String(logs).trim().split('\n').slice(-3).join(' | ') || 'no logs'}`);
        }

        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
          if (res.ok) {
            ctx.log('data api ready', { via: url });
            await docker.setRestartPolicy(inspect!.Id, 'unless-stopped');
            return;
          }
          // 503 is the interesting failure, not a transport error: PostgREST is
          // up and telling us it cannot serve. Its own logs say why, and this is
          // the one place that answer is cheap to get.
          lastError = `${res.status} from ${url}`;
        } catch (err) {
          lastError = (err as Error).message;
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      const logs = await docker.containerLogs(name).catch(() => '');
      throw new Error(
        `the data api did not become ready within ${deps.healthTimeoutMs ?? 60_000}ms `
        + `(last: ${lastError}). postgrest said: `
        + `${String(logs).trim().split('\n').slice(-4).join(' | ') || 'nothing'}`);
    },
  };

  const writeConnection: SagaStep<SagaContext> = {
    name: 'write_connection',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const host = `${project.ref}.${deps.projectDomain ?? 'steadhold.app'}`;
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
   * customer's verifier through `steadhold.pgbouncer_lookup`, and proxied a real
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

  /**
   * Give the project a pgBackRest repo (P3a).
   *
   * Runs after the health gate because `stanza-create` talks to a live database,
   * and before the roles exist because archiving does not care about roles and WAL
   * is already accumulating: `archive_mode` is on from first boot (D-019), so
   * every second between the first checkpoint and this step is a second of WAL the
   * database is holding on the tenant's disk with nowhere to put it.
   *
   * Idempotent in both halves — the cipher-pass is `ensure`d, and `stanza-create`
   * on an existing stanza is reported as "already there" rather than an error.
   */
  const configureBackups: SagaStep<SagaContext> = {
    name: 'configure_backups',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      const container = containerName(project.ref);

      const repo = repoTargetFromEnv();
      if (!repo) {
        // Fail closed only when told to. The gate is what flips at the end of
        // Phase 3; until then an unconfigured fleet has to be able to provision,
        // and the log line is the thing that stops that being invisible.
        if (deps.requireBackups) {
          throw new Error(
            'backups are required (SH_REQUIRE_BACKUPS) but no repo is configured — ' +
            'set SH_BACKUP_S3_ENDPOINT/_BUCKET/_KEY/_SECRET (./scripts/staging.sh backup-store)');
        }
        ctx.log('NO BACKUP REPO CONFIGURED — this project has no PITR and its WAL ' +
          'will accumulate on the node until archiving works', { project: project.ref });
        return;
      }

      const secrets = requireSecrets(deps);
      const { value: cipherPass, created } = await secrets.ensure(
        projectId, SECRET_NAMES.backupCipherPass);
      ctx.log(created ? 'repo cipher-pass generated' : 'repo cipher-pass reused', {});

      await writeConf(docker, container, renderPgbackrestConf({
        projectId, plan: project.plan, cipherPass, repo,
      }));
      void place;
      const { created: madeStanza, output } = await stanzaCreate(docker, container);
      ctx.log(madeStanza ? 'stanza created' : 'stanza already present',
        { repo: repoPathFor(projectId), detail: output.split('\n').slice(-1)[0] });
    },
  };

  /**
   * Prove archiving actually reaches the repo (P3a).
   *
   * `pgbackrest check` forces a WAL switch and confirms the segment arrives, so it
   * tests the whole path — config, credentials, cipher-pass, network egress — in
   * the one place where a failure is still cheap. Without it the first evidence
   * that a project cannot archive is WAL filling its disk days later, and by then
   * the project has no PITR for every second since it was created.
   *
   * Deliberately a separate step from `configure_backups`, for the same reason
   * `wait_pooler_healthy` is separate from `start_pooler`: "we wrote a config" and
   * "the thing works" are different claims and deserve different checkpoints.
   */
  const verifyArchiving: SagaStep<SagaContext> = {
    name: 'verify_archiving',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      if (!repoTargetFromEnv()) {
        if (deps.requireBackups) throw new Error('backups are required but no repo is configured');
        ctx.log('archiving not verified — no repo configured', {});
        return;
      }
      const container = containerName(project.ref);
      const { ok, output } = await backupCheck(docker, container);
      if (!ok) {
        throw new Error('pgbackrest check failed — this project cannot archive WAL: ' +
          pgbackrestFailure(output));
      }
      ctx.log('archiving verified end to end', { stanza: STANZA });
    },
  };

  /* ── scheduled base backups (P3c) ────────────────────────────────────── */

  /**
   * Decide what backup to take and open a row for it.
   *
   * The row is opened *before* the backup runs, deliberately. A `running` row that
   * never finishes is what a killed worker leaves behind, and that is worth being
   * able to see — the alternative is recording only outcomes, which makes a
   * crashed backup indistinguishable from one that was never scheduled.
   *
   * Replay-safe by reuse: a `running` row for this job is adopted rather than
   * duplicated, so a retry does not leave a trail of phantom attempts.
   */
  const planBackup: SagaStep<SagaContext> = {
    name: 'plan_backup',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);

      const existing = await deps.pool.query<{ id: string; type: string }>(
        `SELECT id, type FROM backup_runs
          WHERE project_id = $1 AND job_id = $2 AND status = 'running'
          ORDER BY started_at DESC LIMIT 1`, [projectId, ctx.job.id]);
      if (existing.rows[0]) {
        ctx.log('reusing the run row from a previous attempt',
          { run: existing.rows[0].id, type: existing.rows[0].type });
        return;
      }

      const last = await deps.pool.query<{ full_at: Date | null; any_at: Date | null }>(
        `SELECT max(finished_at) FILTER (WHERE type = 'full') AS full_at,
                max(finished_at) AS any_at
           FROM backup_runs WHERE project_id = $1 AND status = 'succeeded'`, [projectId]);

      // The window is ignored here: by the time a job exists, the scheduler has
      // already decided this project is due. Re-deciding would mean a job enqueued
      // at the end of its slot could find itself outside it and do nothing, which
      // reads as a silently skipped night.
      const decision = decideBackup({
        projectId, plan: project.plan, now: new Date(),
        lastFullAt: last.rows[0]?.full_at ?? undefined,
        lastAnyAt: last.rows[0]?.any_at ?? undefined,
        window: { startHour: 0, endHour: 24 },
      });
      const type = decision.type ?? 'incr';
      const { rows } = await deps.pool.query<{ id: string }>(
        `INSERT INTO backup_runs (project_id, type, status, job_id)
         VALUES ($1, $2, 'running', $3) RETURNING id`, [projectId, type, ctx.job.id]);
      ctx.log('backup planned', { run: rows[0]!.id, type, why: decision.reason });
    },
  };

  /**
   * Take it, and close the row either way.
   *
   * Retention is enforced here too, without a separate step: `pgbackrest backup`
   * runs `expire` when it finishes, so the policy in the rendered config (days per
   * plan, D-276) is applied on every successful backup. A standalone expire step
   * would be a second place for the policy to be wrong.
   */
  const takeBackup: SagaStep<SagaContext> = {
    name: 'take_backup',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const container = containerName(project.ref);

      const runRow = await deps.pool.query<{ id: string; type: 'full' | 'incr' }>(
        `SELECT id, type FROM backup_runs
          WHERE project_id = $1 AND job_id = $2 ORDER BY started_at DESC LIMIT 1`,
        [projectId, ctx.job.id]);
      const run = runRow.rows[0];
      if (!run) throw new Error('no backup_runs row — plan_backup did not run');

      const before = new Set((await backupInfo(docker, container)).labels);

      try {
        await takePgbackrest(docker, container, run.type);
      } catch (err) {
        await deps.pool.query(
          `UPDATE backup_runs SET status = 'failed', finished_at = now(), error = $2
            WHERE id = $1`, [run.id, (err as Error).message.slice(0, 2000)]);
        // The counter the `BackupRunFailed` alert reads. Incremented here rather
        // than derived from the table later, because a counter reconstructed from
        // rows on a timer is a counter that resets when the process does — and
        // `increase()` over a reset is either nothing or nonsense.
        backupRunsTotal.inc({ type: run.type, outcome: 'failed' });
        throw err;
      }

      // Read the outcome from the repo rather than from the command's output. The
      // repo is what a restore will read, so a run row that agrees with the command
      // but not with the repo is a row that lies in the one direction that matters.
      const after = await backupInfo(docker, container);
      const made = after.backups.find((b) => !before.has(b.label));
      await deps.pool.query(
        `UPDATE backup_runs
            SET status = 'succeeded', finished_at = now(), label = $2,
                size_bytes = $3, wal_start = $4, wal_stop = $5, error = NULL
          WHERE id = $1`,
        [run.id, made?.label ?? null, made?.repoBytes ?? null,
         made?.walStart ?? null, made?.walStop ?? null]);

      backupRunsTotal.inc({ type: run.type, outcome: 'succeeded' });
      ctx.log('backup complete', {
        run: run.id, type: run.type, label: made?.label,
        size_bytes: made?.repoBytes,
        // What survived expiry — the visible half of retention working.
        backups_in_repo: after.labels.length,
      });
    },
  };

  /* ── restore to a new instance (P3d, backups §4) ─────────────────────── */

  /**
   * Fill the new project's volume from the *source* project's repo.
   *
   * This has to happen before Postgres has ever started on that volume, and that
   * ordering is the reason this is not simply "provision then restore": the image's
   * entrypoint runs `initdb` on an empty volume, and a restore into a directory
   * that already contains a cluster is either refused or a mess. So the volume is
   * created, filled by a throwaway container that runs nothing but pgBackRest, and
   * only then does the real project container start on top of it.
   *
   * The config written into that throwaway container is the **source's** — its repo
   * path, its cipher-pass. A restore reads someone else's history by definition,
   * and this is the one place in the system where a project's container legitimately
   * holds another project's credentials. It is a container that exists for the
   * duration of one command and is removed in a `finally`.
   */
  /**
   * Write the *source* project's repo config into a container.
   *
   * Needed twice, and the second time is the one that was missing. pgBackRest's
   * restore writes `restore_command = 'pgbackrest --stanza=main archive-get …'`
   * into `postgresql.auto.conf`, and that command runs **inside the project
   * container** every time recovery wants a WAL segment. If the container has no
   * `/etc/pgbackrest/pgbackrest.conf`, archive-get can reach no repo, recovery
   * never gets the segments it needs, and Postgres either dies with
   *   FATAL: could not locate required checkpoint record at 0/4000080
   * — a message about checkpoints that is really about a missing config — or waits
   * for WAL that will never arrive. Both were observed, in that order.
   *
   * It has to be the *source's* config: the WAL being replayed is the source's, and
   * the copy's own repo does not exist until `configure_backups` runs after
   * recovery has finished.
   */
  async function writeSourceRepoConf(
    docker: Docker, container: string, sourceProjectId: string,
  ): Promise<void> {
    const secrets = requireSecrets(deps);
    const repo = repoTargetFromEnv();
    if (!repo) throw new Error('no backup repo configured — a restore has nothing to read');
    const cipherPass = await secrets.get(sourceProjectId, SECRET_NAMES.backupCipherPass);
    if (!cipherPass) {
      throw new Error('no repo cipher-pass stored for the source — its repo cannot be decrypted');
    }
    const sourcePlan = (await loadProject(deps.pool, sourceProjectId)).plan;
    await writeConf(docker, container, renderPgbackrestConf({
      projectId: sourceProjectId, plan: sourcePlan, cipherPass, repo,
    }));
  }

  const restoreIntoVolume: SagaStep<SagaContext> = {
    name: 'restore_into_volume',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);

      const restoreRow = await deps.pool.query<{
        source_project_id: string | null; source_ref: string; target_time: Date | null;
      }>(`SELECT source_project_id, source_ref, target_time
            FROM project_restores WHERE project_id = $1`, [projectId]);
      const r = restoreRow.rows[0];
      if (!r) throw new Error('no project_restores row — this project was not created by a restore');
      if (!r.source_project_id) {
        throw new Error(
          `the source project ${r.source_ref} is gone, so its repo cannot be read — ` +
          'a restore cannot be replayed after its source is purged');
      }

      // Already restored? A `PG_VERSION` in the data directory means a previous
      // attempt got this far, and re-running the restore would throw away whatever
      // recovery has already replayed.
      const probe = `sh-restore-${project.ref}`;

      await docker.removeContainer(probe, true, true).catch(() => {});
      const spec = buildContainerSpec({
        ref: project.ref, projectId, volumeName: place.volume_name,
        hostPort: place.port, ramLimitMb: place.ram_limit_mb,
        bootstrapSecret: deps.bootstrapSecret ?? '', plan: project.plan,
      });
      try {
        const id = await docker.createContainer(probe, {
          ...spec,
          // Nothing but a shell: the entrypoint must not run, or it would initdb
          // the volume we are about to restore into.
          Cmd: ['sleep', '900'],
          Env: [],
          HostConfig: { ...spec.HostConfig, PortBindings: {} },
          ExposedPorts: {},
        });
        await docker.startContainer(id);

        const already = await docker.execCapture(probe, ['sh', '-c',
          'test -f /var/lib/postgresql/data/pgdata/PG_VERSION && echo yes || echo no']);
        if (already.stdout.trim() === 'yes') {
          ctx.log('data directory is already populated — leaving the previous restore alone', {});
          return;
        }

        await writeSourceRepoConf(docker, probe, r.source_project_id);
        const out = await pgbackrestRestore(docker, probe, {
          targetTime: r.target_time ?? undefined });
        // The label pgBackRest chose, for the record: which base it replayed from
        // is the first thing anyone asks when a restore lands somewhere unexpected.
        /**
         * The restore is not finished when pgBackRest exits 0.
         *
         * Postgres needs `recovery.signal` in the data directory to enter archive
         * recovery at all; without it, it finds a `backup_label` pointing at a
         * checkpoint whose WAL it has no way to fetch, and dies with
         *   FATAL: could not locate required checkpoint record at 0/4000080
         * — a message about checkpoints that is really about a missing file. Checked
         * here because this is where it can still be explained; at container start
         * it is a database that will not boot for reasons three layers away.
         */
        // `test -f` and the exit code, not `ls` and a substring: `ls` on a missing
        // file prints the path *in its error message*, so a substring check for the
        // filename passes whether the file is there or not. That version of this
        // guard ran green against a data directory that did not contain the file.
        const signal = await docker.execCapture(probe, ['sh', '-c',
          'cd /var/lib/postgresql/data/pgdata && test -f recovery.signal && echo PRESENT; '
          + 'echo "---"; ls -a | head -30']);
        if (!/\bPRESENT\b/.test(signal.stdout)) {
          throw new Error(
            'pgbackrest restore wrote no recovery.signal, so Postgres cannot enter ' +
            'archive recovery and will refuse to start. ' +
            `Data directory: ${signal.stdout.trim().slice(0, 200)}. ` +
            `Restore output: ${out.output.split('\n').slice(-6).join(' | ').slice(0, 600)}`);
        }

        const label = /restore backup set (\S+)/.exec(out.output)?.[1];
        await deps.pool.query(
          `UPDATE project_restores SET backup_label = $2 WHERE project_id = $1`,
          [projectId, label ?? null]);
        ctx.log('volume restored from the source repo', {
          source: r.source_ref, target: r.target_time?.toISOString() ?? 'latest', backup: label,
        });
      } finally {
        await docker.removeContainer(probe, true, false).catch(() => {});
      }
    },
  };

  /**
   * Start the restored cluster, confirm it stopped where it was told to, and only
   * then let it out of recovery.
   *
   * The confirmation is the point of the whole step. `pg_get_wal_replay_pause_state()`
   * reading `paused` while `pg_is_in_recovery()` is true can only happen if the
   * recovery target was both *understood* and *reached* — if the recovery settings
   * had been ignored, or the WAL had run out before the target, the server would
   * have finished recovery and promoted itself on its own. So this is not a
   * defensive assertion about our own code; it is the difference between a restore
   * and a database quietly holding the wrong day.
   */
  const recoverToTarget: SagaStep<SagaContext> = {
    name: 'recover_to_target',
    async run(ctx) {
      const docker = requireDocker(deps);
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId);
      const name = containerName(project.ref);

      const { rows } = await deps.pool.query<{ target_time: Date | null }>(
        `SELECT target_time FROM project_restores WHERE project_id = $1`, [projectId]);
      const targetTime = rows[0]?.target_time ?? null;

      const source = await deps.pool.query<{ source_project_id: string | null }>(
        `SELECT source_project_id FROM project_restores WHERE project_id = $1`, [projectId]);
      const sourceId = source.rows[0]?.source_project_id;

      let inspect = await docker.inspectContainer(name);
      if (!inspect) {
        const id = await docker.createContainer(name, buildContainerSpec({
          ref: project.ref, projectId, volumeName: place.volume_name,
          hostPort: place.port, ramLimitMb: place.ram_limit_mb,
          bootstrapSecret: deps.bootstrapSecret ?? '', plan: project.plan,
          networkName: await ensureNetwork(ctx, project.ref),
          ioWeight: (await nodeCaps(docker, IMAGE)).ioWeight,
        }));
        ctx.log('restored container created', { name, container: id.slice(0, 12) });
        inspect = await docker.inspectContainer(name);
      }

      /**
       * The source's repo config goes in *before* Postgres starts, and this ordering
       * is the whole step working or hanging.
       *
       * Recovery fetches every WAL segment by running `restore_command` — which is
       * `pgbackrest archive-get` — inside this container. `configure_backups` runs
       * later in the saga and writes the *copy's* config, which is both too late and
       * the wrong repo. Without this the container started, found a `backup_label`
       * pointing at a checkpoint it could not fetch, and either died claiming it
       * could not locate the checkpoint record or sat waiting for WAL forever.
       *
       * Written with the container created but not started, so the file is in place
       * for the first thing the postmaster does.
       */
      if (sourceId) {
        // The container has to be running to exec into it, but Postgres must not
        // have started. `docker start` runs the entrypoint immediately, so instead
        // the config is written into the stopped container's filesystem by a
        // throwaway exec — which Docker cannot do — so the order is: start, write,
        // and accept that the first second or two of archive-get will fail and be
        // retried by Postgres, which retries `restore_command` indefinitely.
        await docker.startContainer(inspect!.Id);
        await writeSourceRepoConf(docker, name, sourceId);
        ctx.log('source repo config in place — recovery can fetch WAL', {});
      } else if (!inspect!.State.Running) {
        await docker.startContainer(inspect!.Id);
      }
      const passwords = sourceId
        ? await superuserCandidates(deps, sourceId)
        : await superuserCandidates(deps, projectId);

      const endpoint = adminEndpoint(place);
      const deadline = Date.now() + (deps.healthTimeoutMs ?? 120_000);
      let state: { in_recovery: boolean; pause_state: string | null; lsn: string | null;
        reached: Date | null } | undefined;
      let lastError = '';
      while (Date.now() < deadline) {
        try {
          const client = await connectAsSuperuser({ ...endpoint, passwords });
          try {
            const q = await client.query<{
              in_recovery: boolean; pause_state: string | null;
              lsn: string | null; reached: Date | null;
            }>(`SELECT pg_is_in_recovery() AS in_recovery,
                       CASE WHEN pg_is_in_recovery()
                            THEN pg_get_wal_replay_pause_state() ELSE NULL END AS pause_state,
                       pg_last_wal_replay_lsn()::text AS lsn,
                       pg_last_xact_replay_timestamp() AS reached`);
            state = q.rows[0]!;
          } finally { await client.end().catch(() => {}); }
          if (!state.in_recovery || state.pause_state === 'paused') break;
          ctx.log('still replaying', { pause_state: state.pause_state, lsn: state.lsn });
        } catch (err) {
          lastError = (err as Error).message;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (!state) {
        // "Never answered" on its own is a dead end: the interesting information is
        // in the cluster's own log, and by the time anyone reads the job error the
        // container may be gone. Recovery failures are exactly where this matters —
        // a missing WAL segment, a permissions problem on restored files, or a
        // config the restore brought with it all look identical from outside.
        const logs = await docker.containerLogs(name).catch(() => '(logs unavailable)');
        throw new Error(`restored cluster never answered: ${lastError}\n` +
          `--- ${name} ---\n${logs.split('\n').slice(-12).join('\n')}`);
      }

      if (targetTime) {
        // Promoted on its own ⇒ recovery ended without stopping at a target, which
        // means either the settings were never applied or the WAL ran out before the
        // target. Both give a database holding an *earlier* point than asked for,
        // and serving it would be the one failure the doc forbids by name.
        if (!state.in_recovery) {
          throw new Error(
            'the restored cluster left recovery without pausing at the target — it holds ' +
            'an earlier point than requested and will not be served. Either the recovery ' +
            'settings were not applied or the WAL needed to reach ' +
            `${targetTime.toISOString()} is missing from the repo`);
        }
        if (state.pause_state !== 'paused') {
          throw new Error(
            `recovery did not reach the target within the timeout (pause state: ` +
            `${state.pause_state}, replayed to ${state.reached?.toISOString() ?? 'unknown'})`);
        }
        ctx.log('recovery paused at the target', {
          requested: targetTime.toISOString(),
          reached: state.reached?.toISOString() ?? 'unknown', lsn: state.lsn,
        });

        const client = await connectAsSuperuser({ ...endpoint, passwords });
        try {
          // Resuming from a pause *at the recovery target* ends recovery and
          // promotes — this is the documented promote step, done only after the
          // target was confirmed.
          await client.query('SELECT pg_wal_replay_resume()');
        } finally { await client.end().catch(() => {}); }

        for (let i = 0; i < 60; i++) {
          const c = await connectAsSuperuser({ ...endpoint, passwords });
          try {
            const q = await c.query<{ r: boolean }>('SELECT pg_is_in_recovery() AS r');
            if (!q.rows[0]!.r) break;
          } finally { await c.end().catch(() => {}); }
          await new Promise((res) => setTimeout(res, 500));
        }
      }

      await deps.pool.query(
        `UPDATE project_restores
            SET reached_time = $2, reached_lsn = $3 WHERE project_id = $1`,
        [projectId, state.reached ?? null, state.lsn ?? null]);
      ctx.log('restored cluster is out of recovery and writable', {
        reached: state.reached?.toISOString() ?? 'unknown' });
    },
  };

  /**
   * The restored project gets its own credentials, and the source's stop working.
   *
   * A restored cluster contains the source's roles with the source's passwords, so
   * without this the copy is reachable with the original's connection string — one
   * password that opens two databases, and a rotation on the original that silently
   * does not cover the copy. Reusing `store_credentials` would be wrong in the one
   * way that matters: it connects with *this* project's stored passwords, which the
   * restored cluster has never heard of.
   */
  const resetRestoredCredentials: SagaStep<SagaContext> = {
    name: 'reset_restored_credentials',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const secrets = requireSecrets(deps);
      const place = await loadPlacement(deps.pool, projectId);
      const source = await deps.pool.query<{ source_project_id: string | null }>(
        `SELECT source_project_id FROM project_restores WHERE project_id = $1`, [projectId]);
      const sourceId = source.rows[0]?.source_project_id;

      const wanted = [
        { name: SECRET_NAMES.postgres, role: 'postgres' },
        { name: SECRET_NAMES.developer, role: DEVELOPER_ROLE },
        { name: SECRET_NAMES.authenticator, role: 'authenticator' },
        { name: SECRET_NAMES.poolerAuth, role: POOLER_AUTH_ROLE },
        // A restored copy gets its own auth-role password too (P4a). The restored
        // cluster carries the *source's*, and leaving it would mean one credential
        // opening two projects' user tables.
        { name: SECRET_NAMES.authRole, role: AUTH_ROLE },
      ];
      const stored: Array<{ role: string; value: string }> = [];
      for (const w of wanted) {
        const { value } = await secrets.ensure(projectId, w.name);
        stored.push({ role: w.role, value });
      }

      // Connect with the *source's* passwords, since that is what the cluster still
      // has, and fall back to this project's in case a previous attempt already
      // rotated them — which is what makes the step replay-safe.
      const passwords = [
        ...(sourceId ? await superuserCandidates(deps, sourceId) : []),
        ...await superuserCandidates(deps, projectId),
      ];
      const client = await connectAsSuperuser({ ...adminEndpoint(place), passwords });
      try {
        for (const s of stored) await setRolePassword(client, s.role, s.value);
      } finally { await client.end().catch(() => {}); }
      ctx.log('restored project has its own credentials; the source\'s no longer open it',
        { roles: stored.map((s) => s.role) });
    },
  };

  /**
   * Mark it `restored` — not `ready`.
   *
   * A restored instance is a copy, and two databases serving one application loses
   * data by construction: the customer writes to whichever one they are pointed at
   * and nothing can reconcile that afterwards. `ready` would make the copy
   * indistinguishable from production in every list, badge and API response, which
   * is exactly the confusion that ends with writes in the wrong place.
   */
  const markRestored: SagaStep<SagaContext> = {
    name: 'mark_restored',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      await deps.pool.query(
        `UPDATE project_restores
            SET status = 'succeeded', finished_at = now(), error = NULL
          WHERE project_id = $1`, [projectId]);
      await deps.pool.query(
        `UPDATE projects SET status = 'restored', updated_at = now() WHERE id = $1`, [projectId]);
      await deps.pool.query(
        `UPDATE project_databases SET status = 'running', updated_at = now()
          WHERE project_id = $1`, [projectId]);
      ctx.log('restore complete — the copy is validatable and serves no traffic', {});
    },
  };

  /**
   * The last backup a project ever gets (P3f, D-066, exit criterion 4).
   *
   * D-066's rule is that the one moment a backup absolutely must work is when
   * everything else is about to be deleted, and the reason is the shape of the
   * mistake it protects against: a customer deletes the wrong project. Nothing
   * about a `DELETE` distinguishes "we are done with this" from "I typed the wrong
   * ref", so the recovery window (D-038) exists — and a recovery window with no
   * backup behind it is a promise about data that no longer exists anywhere.
   *
   * Always a **full**, never an incremental. Everything else in the schedule
   * balances cost against restore time; this one is the only copy that will
   * survive the project, and a chain whose earlier links are expiring is not
   * something to hand a customer who is already having a bad day.
   *
   * Fails the saga when it fails. That is the whole point of the interlock — a
   * deletion that proceeded past a failed final backup would produce exactly the
   * silent state D-066 forbids, and it would do so at the only moment nobody is
   * watching, because the customer has already moved on.
   */
  /**
   * Schedule the repo's destruction (P3g, D-066).
   *
   * Runs at purge and writes the only thing that must outlive it: what still needs
   * deleting and when. The repo itself is *not* touched here — D-066 keeps the
   * final backup for 30 days past purge, so that a customer who deleted the wrong
   * project has a month rather than the week the volume gets.
   *
   * Placed before `delete_credentials` for a reason that only matters on a retry:
   * the bucket comes from the fleet's configuration rather than the project's
   * secrets, but a step that reads *anything* about the project has to run while
   * the project still has it.
   */
  const scheduleRepoDestruction: SagaStep<SagaContext> = {
    name: 'schedule_repo_destruction',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const repo = repoTargetFromEnv();
      if (!repo) {
        // Nothing to destroy that we know how to reach. Recorded with no deadline
        // rather than skipped, so the row exists and a fleet that later gains
        // object storage can be given a schedule for it — an absent row is a repo
        // nobody will ever look for.
        await deps.pool.query(
          `INSERT INTO project_repos (project_id, repo_path, bucket, destroy_after)
           VALUES ($1, $2, 'unconfigured', NULL)
           ON CONFLICT (project_id) DO NOTHING`,
          [projectId, repoPathFor(projectId)]);
        ctx.log('no repo configured — recorded with no destruction deadline', {});
        return;
      }
      await createRepoDestroy({ pool: deps.pool }).schedule(projectId, repo.bucket);
      ctx.log('backup repo scheduled for destruction', {
        repo_path: repoPathFor(projectId), in_days: REPO_RETENTION_DAYS,
      });
    },
  };

  const finalBackup: SagaStep<SagaContext> = {
    name: 'final_backup',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);

      if (!repoTargetFromEnv()) {
        // The pre-P3a behaviour, kept for a fleet with no repo configured. The
        // gate is what turns "there is no backup system" from a log line into a
        // refusal, and it should be on wherever data matters.
        if (deps.requireFinalBackup) {
          throw new Error(
            'a verified final backup is required before deletion (D-066) but no repo ' +
            'is configured — set SH_BACKUP_S3_* or unset SH_REQUIRE_FINAL_BACKUP to ' +
            'delete without one, knowingly');
        }
        ctx.log('FINAL BACKUP SKIPPED — no repo configured, so this project\'s ' +
          'recovery window has nothing behind it', { project: project.ref });
        return;
      }

      const docker = requireDocker(deps);
      const container = containerName(project.ref);

      // Nothing to back up from a container that is already gone: a delete of a
      // paused project is the normal case (D-077 already took its final backup at
      // pause, and it is pinned). Reported rather than skipped silently, because
      // "there was already one" and "we could not take one" must not look alike.
      const inspect = await docker.inspectContainer(container);
      if (!inspect?.State.Running) {
        const priorRuns = await deps.pool.query<{ label: string | null; finished_at: Date }>(
          `SELECT label, finished_at FROM backup_runs
            WHERE project_id = $1 AND status = 'succeeded'
            ORDER BY finished_at DESC LIMIT 1`, [projectId]);
        const prior = priorRuns.rows[0];
        if (!prior && deps.requireFinalBackup) {
          throw new Error(
            `${project.ref} has no running database and no successful backup on ` +
            'record, so deleting it would close a recovery window with nothing ' +
            'behind it (D-066)');
        }
        ctx.log(prior
          ? 'database is not running; relying on the existing backup taken at pause (D-077)'
          : 'database is not running and there is no backup on record',
          { last_backup: prior?.label ?? null,
            taken_at: prior?.finished_at?.toISOString() ?? null });
        return;
      }

      const { rows } = await deps.pool.query<{ id: string }>(
        `INSERT INTO backup_runs (project_id, type, status, job_id)
         VALUES ($1, 'full', 'running', $2) RETURNING id`, [projectId, ctx.job.id]);
      const runId = rows[0]!.id;
      try {
        await takePgbackrest(docker, container, 'full');
      } catch (err) {
        await deps.pool.query(
          `UPDATE backup_runs SET status = 'failed', finished_at = now(), error = $2
            WHERE id = $1`, [runId, (err as Error).message.slice(0, 2000)]);
        backupRunsTotal.inc({ type: 'full', outcome: 'failed' });
        throw new Error(`final backup failed, so this deletion stops here (D-066): ` +
          (err as Error).message);
      }

      const after = await backupInfo(docker, container);
      const made = after.backups[after.backups.length - 1];
      await deps.pool.query(
        `UPDATE backup_runs
            SET status = 'succeeded', finished_at = now(), label = $2, size_bytes = $3,
                wal_start = $4, wal_stop = $5, error = NULL
          WHERE id = $1`,
        [runId, made?.label ?? null, made?.repoBytes ?? null,
         made?.walStart ?? null, made?.walStop ?? null]);
      backupRunsTotal.inc({ type: 'full', outcome: 'succeeded' });
      ctx.log('final backup taken — the recovery window has something behind it',
        { run: runId, label: made?.label, size_bytes: made?.repoBytes });
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

  /**
   * Stop the data API (P5b).
   *
   * First in the deletion order, before the pooler and well before the database:
   * PostgREST is the surface a customer's application is *actively calling*, and
   * a deletion that stopped the database first would turn every in-flight request
   * into a 503 from a service that is supposed to be going away cleanly. Stopping
   * the front door first is what makes the rest of the teardown quiet.
   */
  const stopPostgrest: SagaStep<SagaContext> = {
    name: 'stop_postgrest',
    async run(ctx) {
      const projectId = ctx.job.project_id!;
      const project = await loadProject(deps.pool, projectId);
      const place = await loadPlacement(deps.pool, projectId).catch(() => undefined);
      const docker = requireDocker(deps);
      // Recorded id first, derived name as the fallback — same rule as the
      // pooler: the row may be missing on a retry, and "no row so nothing to
      // stop" would leave a data API serving a project being deleted.
      const target = place?.postgrest_container_id ?? postgrestName(project.ref);
      const state = await docker.inspectContainer(target);
      if (!state) { ctx.log('no data api to stop'); return; }
      if (!state.State.Running) { ctx.log('data api already stopped'); return; }
      await docker.setRestartPolicy(state.Id, 'no');
      await docker.stopContainer(state.Id);
      ctx.log('data api stopped');
    },
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
      // All three of the project's containers (P2b, P5b), by id and by derived
      // name. Missing one here is a container that outlives its project — which
      // reconciliation then reports as an orphan forever, because the placement
      // row it would have been matched against is gone.
      const targets = [
        place?.container_id, containerName(project.ref),
        place?.pooler_container_id, poolerName(project.ref),
        place?.postgrest_container_id, postgrestName(project.ref),
      ].filter(Boolean);
      for (const target of targets) {
        await docker.removeContainer(target as string);
      }
      if (place) {
        await deps.pool.query(
          `UPDATE project_databases
              SET container_id = NULL, pooler_container_id = NULL,
                  postgrest_container_id = NULL
            WHERE project_id = $1`, [projectId]);
      }
      ctx.log('containers removed', { database: true, pooler: true, data_api: true });
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

      const issuer = deps.jwtIssuer ?? `https://${project.ref}.${deps.projectDomain ?? 'steadhold.app'}`;
      for (const role of ['anon', 'service_role'] as const) {
        if (existing.some((r) => r.kind === role)) continue;
        const token = signJwt(
          projectKeyClaims({ ref: project.ref, role, issuer }),
          { privateKeyPem, kid });
        const name = role === 'anon' ? SECRET_NAMES.anonKey : SECRET_NAMES.serviceRoleKey;
        // `shk_anon_kxqw` / `shk_srv_kxqw`, per the platform-API example — a
        // *label*, not a slice of the token. A literal prefix of a JWT is the
        // base64 of its header, which is byte-identical for every key of every
        // project and so identifies nothing: the first live run showed both keys
        // displaying as "eyJhbGciOiJF".
        const prefix = keyLabel(role, project.ref);
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

        /**
         * The pause interlock (P3f, D-077): pause does not complete until the
         * project is restorable from object storage alone.
         *
         * A paused project has no running Postgres, so **WAL archiving stops with
         * the container**. Unhandled, that means the only current copy of the
         * customer's data is one node's disk, with a backup behind it that is
         * already older than the pause and getting older — and the whole economic
         * case for pausing free projects (D-008) is that the node keeps the disk
         * cheaply, not that the data is safe because it is still there.
         *
         * So: a backup *after* the checkpoint, then `pgbackrest check` to confirm
         * the last segment actually landed. Order matters — a backup taken before
         * the checkpoint would not include what the checkpoint flushed, which is
         * precisely the tail of the data.
         *
         * A **full** when the chain is stale, an incremental when it is fresh
         * (backups §8). The chain matters more than usual here because nothing will
         * extend it again until the project resumes: an incremental onto a base
         * that is about to be the oldest thing in the repo is a restore that
         * depends on a link nobody is watching.
         */
        if (repoTargetFromEnv()) {
          const lastFull = await deps.pool.query<{ finished_at: Date }>(
            `SELECT finished_at FROM backup_runs
              WHERE project_id = $1 AND type = 'full' AND status = 'succeeded'
              ORDER BY finished_at DESC LIMIT 1`, [projectId]);
          const ageDays = lastFull.rows[0]
            ? (Date.now() - lastFull.rows[0].finished_at.getTime()) / 86_400_000
            : Infinity;
          const type = ageDays < 7 ? 'incr' : 'full';

          const { rows } = await deps.pool.query<{ id: string }>(
            `INSERT INTO backup_runs (project_id, type, status, job_id)
             VALUES ($1, $2, 'running', $3) RETURNING id`, [projectId, type, ctx.job.id]);
          const runId = rows[0]!.id;
          try {
            const dbContainer = containerName(project.ref);
            await takePgbackrest(docker, dbContainer, type);
            const info = await backupInfo(docker, dbContainer);
            const made = info.backups[info.backups.length - 1];
            await deps.pool.query(
              `UPDATE backup_runs SET status = 'succeeded', finished_at = now(),
                      label = $2, size_bytes = $3, wal_start = $4, wal_stop = $5
                WHERE id = $1`,
              [runId, made?.label ?? null, made?.repoBytes ?? null,
               made?.walStart ?? null, made?.walStop ?? null]);
            backupRunsTotal.inc({ type, outcome: 'succeeded' });

            // The confirmation, and the reason this is an interlock rather than a
            // courtesy: `check` forces a WAL switch and verifies the segment
            // arrived, so passing it means the repo holds everything up to this
            // moment. Without it, "we took a backup" and "the backup is in object
            // storage" are different claims and only the second one matters once
            // the container is gone.
            const verified = await backupCheck(docker, containerName(project.ref));
            if (!verified.ok) {
              throw new Error('pgbackrest check failed after the final backup: ' +
                pgbackrestFailure(verified.output));
            }
            ctx.log('final backup taken and archiving confirmed — this project is ' +
              'restorable from object storage alone', { run: runId, type, label: made?.label });
          } catch (err) {
            await deps.pool.query(
              `UPDATE backup_runs SET status = 'failed', finished_at = now(), error = $2
                WHERE id = $1`, [runId, (err as Error).message.slice(0, 2000)]);
            backupRunsTotal.inc({ type, outcome: 'failed' });
            // Refuse to stop the container. A paused project whose backup failed
            // has its only current copy on a node disk and nothing watching it —
            // strictly worse than a running project, which is the opposite of what
            // pausing is for. Better to leave it running and let the pause retry.
            throw new Error(
              `pause stopped: ${project.ref} is not restorable from object storage, so ` +
              'its containers were left running rather than leaving one node disk as ' +
              `the only copy (D-077). ${(err as Error).message}`);
          }
        } else if (deps.requireBackups) {
          throw new Error(
            'backups are required but no repo is configured, so pausing would leave ' +
            'this node\'s disk as the only copy of the data (D-077)');
        } else {
          ctx.log('NO BACKUP REPO CONFIGURED — pausing anyway leaves this node\'s disk ' +
            'as the only current copy of the data', { project: project.ref });
        }

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
        // The data API first, for the same reason deletion stops it first: it is
        // the surface a customer's application is calling.
        place?.postgrest_container_id, postgrestName(project.ref),
        place?.pooler_container_id, poolerName(project.ref),
        place?.container_id, containerName(project.ref),
      ].filter(Boolean)) {
        await docker.removeContainer(target as string);
      }
      await deps.pool.query(
        `UPDATE project_databases
            SET container_id = NULL, pooler_container_id = NULL,
                postgrest_container_id = NULL
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
      configureBackups,              // P3a — WAL is already piling up by here
      verifyArchiving,               // P3a
      createBaseRoles,               // T5e
      storeCredentials,              // T5e
      generateApiKeys,               // P1e
      startPooler,                   // P2b
      waitPoolerHealthy,             // P2b — proves the whole pooled chain
      startPostgrest,                // P5b — after generate_api_keys: it needs the JWKS
      waitPostgrestHealthy,          // P5b — /ready, not /live: 503 is the failure that matters
      writeConnection,               // T5e
      markReady,                     // T5e
    ],
    // Phase one — reversible. Nothing here destroys data (D-038).
    delete_project: [
      disableApi,                    // T7
      disableWrites,                 // T7
      finalBackup,                   // T7 (gate, unimplemented in M0 — D-066)
      stopPostgrest,                 // P5b — the front door first, see the step
      stopPooler,                    // P2b — before the database, see the step
      stopContainer,                 // T7
      removeNetwork,                 // P2a — holds no data; frees the subnet
      markSoftDeleted,               // T7
    ],
    /**
     * Restore to a new instance (P3d). Production is never overwritten.
     *
     * The first four steps are the provisioning path's, deliberately reused: a
     * restored project is a real project and gets its placement, volume and network
     * the same way. What differs is that `start_container` is *absent* — the volume
     * must be filled before Postgres has ever run on it, so `restore_into_volume`
     * takes that slot and `recover_to_target` starts the container itself.
     */
    restore_project: [
      allocate,
      createVolume,
      createNetwork,
      restoreIntoVolume,
      recoverToTarget,
      resetRestoredCredentials,
      configureBackups,              // the copy gets its own repo, not the source's
      verifyArchiving,
      writeConnection,
      markRestored,
    ],
    // Scheduled base backups (P3c). Two steps rather than one so a crashed
    // worker leaves a visible `running` row rather than no trace at all.
    backup_project: [
      planBackup,
      takeBackup,
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
      /**
       * Backups have to be reconfigured, and this is the same omission the
       * comment below makes about PostgREST — made twice, and worse here because
       * nothing visibly fails.
       *
       * `configure_backups` writes `/etc/pgbackrest/pgbackrest.conf` into the
       * **container filesystem**, and the spec mounts only
       * `/var/lib/postgresql/data` as a volume. Pause removes the container and
       * resume creates a fresh one, so a resumed project came back with no
       * pgbackrest config at all: `archive_command` failing on every WAL segment,
       * scheduled backups failing with `[037] backup command requires option:
       * pg1-path`, the D-078 final-backup gate refusing to let the project ever
       * be *deleted*, and a second pause dead-lettering. All while the dashboard
       * showed READY, because no request anyone makes touches any of it.
       *
       * Placed before the pooler and the data API rather than after, because WAL
       * starts accumulating the moment Postgres is healthy, and archiving is the
       * thing that stops the node filling up. Both steps are idempotent — the
       * cipher-pass is reused, the conf overwritten, `stanza-create` is
       * check-then-act — which is what makes them safe on a path that runs for a
       * project that already has a repo.
       */
      configureBackups,              // P3a — the conf did not survive the pause
      verifyArchiving,               // P3a — prove the segment reaches the repo
      startPooler,                   // P2b
      waitPoolerHealthy,             // P2b
      // Without these a resumed project has a database and a pooler and **no data
      // API** — it would look fully recovered in the dashboard and answer nothing
      // on `/rest/v1`. `start_postgrest` is check-then-act, so it reuses the
      // container the pause left behind rather than creating a second.
      startPostgrest,                // P5b
      waitPostgrestHealthy,          // P5b
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
      scheduleRepoDestruction,       // P3g — before the credentials go
      deleteCredentials,             // T7
      release,                       // T5c's idempotent inverse
      verifyGone,                    // T7 — asserts against the node, last
      markDeleted,                   // T7
    ],
  };
}
