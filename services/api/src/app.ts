import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './kernel/errors.ts';
import { registerCors } from './kernel/cors.ts';
import { registerControlPlane, type Enqueue, type ControlPlaneDeps } from './modules/control-plane/routes.ts';
import { createMemoryStore, type ControlPlaneStore } from './modules/control-plane/store.ts';
import { registerMetrics } from './kernel/metrics.ts';
import { registerAuth, type AuthDeps } from './modules/auth/routes.ts';
import { registerOrgs, type OrgDeps } from './modules/orgs/routes.ts';
import { registerProjectAuth, type ProjectAuthDeps } from './modules/project-auth/routes.ts';
import { registerGateway, type GatewayDeps } from './modules/gateway/routes.ts';
import { registerStorage, type StorageDeps } from './modules/storage/routes.ts';
import { registerDbRoutes, type DbDeps } from './modules/db/routes.ts';
import type { PrincipalDeps } from './kernel/principal.ts';

export interface BuildOptions {
  store?: ControlPlaneStore;
  enqueue?: Enqueue;
  /** Retry's delivery path — see `ControlPlaneDeps.enqueueRecovery`. */
  enqueueRecovery?: (job: {
    job_row_id: string; idempotency_key: string; job_type: string; project_id: string | null;
  }, attempt: number) => Promise<void>;
  onEnqueueError?: (err: Error) => void;
  staticToken?: string;
  logger?: boolean;
  /** Attribution for static-token mutations until P1c (see routes.ts). */
  actorUserId?: string | null;
  /**
   * Called for every route as it registers. Exists so the audit guard test can
   * enumerate the mutating endpoints reliably — `printRoutes` emits a tree that
   * has to be parsed, and a guard that silently mis-parses is worse than none.
   */
  onRoute?: (route: { method: string; url: string }) => void;
  /**
   * Platform auth (D-062). Absent means the auth endpoints are not registered at
   * all — better than routes that exist and cannot work, which a client would
   * code against.
   */
  auth?: AuthDeps;
  /** Organizations and membership (P1d). Same rule as auth: absent, not broken. */
  orgs?: OrgDeps;
  /**
   * The SQL console's execution path (P7l, D-132). Absent means
   * `/v1/projects/:ref/db/query` is not registered — the same rule as auth and
   * orgs, because a console endpoint that exists and cannot reach a project
   * database is worse than one that is honestly missing.
   */
  db?: DbDeps;
  /**
   * Org scoping for the project endpoints (P1d). Absent keeps Milestone 0's
   * behaviour — one implicit org, no permission checks — which is what the
   * memory store and the unit tests use.
   */
  projects?: { orgs: OrgDeps['orgs']; principals: PrincipalDeps };
  /**
   * Reads a project's envelope-encrypted keys for the keys and JWKS endpoints
   * (P1e). Absent means those endpoints report the keys' prefixes and nothing
   * more, which is the honest answer for an API with no master key.
   */
  projectSecrets?: { secrets: NonNullable<ControlPlaneDeps['secrets']> };
  /**
   * Lets the control plane's JWKS endpoint dual-publish during a key rotation
   * (P4h). Absent means it serves the signing key alone, which is correct for
   * every project that is not mid-rotation.
   */
  signingKeys?: NonNullable<ControlPlaneDeps['signingKeys']>;
  /**
   * Origins allowed to call this API from a browser (P1g). Absent or empty means
   * none — see kernel/cors.ts for why that is the default rather than localhost.
   */
  corsOrigins?: readonly string[];
  /** Overrides the per-org project ceiling; tests set it low. */
  projectsPerOrgLimit?: number;
  /**
   * The **data-plane** auth API at `/auth/v1/*` (P4b) — a customer's end users,
   * not our operators. Absent means those routes do not exist, which is the right
   * answer for a deployment with no project databases to serve.
   */
  projectAuth?: ProjectAuthDeps;
  /**
   * The data-plane gateway at `/rest/v1/*` (P5c). Absent means the route does not
   * exist — right for a deployment with no projects to route to, and better than
   * a route that 503s every request.
   */
  gateway?: GatewayDeps;
  /**
   * The storage module at `/storage/v1/*` (P6b). Absent means the routes do not
   * exist, for the same reason the others do: a route that exists and cannot
   * work is worse than a 404, because a client codes against it.
   */
  storage?: StorageDeps;
}

/** Composition root: the only place that wires modules together. */
export function buildApp(opts: BuildOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, genReqId: () => `req_${crypto.randomUUID()}` });
  if (opts.onRoute) {
    const report = opts.onRoute;
    app.addHook('onRoute', (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        report({ method, url: route.url });
      }
    });
  }
  registerErrorHandling(app);
  // Before everything: a preflight must be answered even for a route that will
  // go on to reject the real request.
  registerCors(app, { origins: opts.corsOrigins ?? [] });
  registerMetrics(app);

  app.get('/health', async () => ({ status: 'ok', service: 'api' }));
  app.get('/ready', async () => ({ status: 'ready' }));

  if (opts.auth) registerAuth(app, opts.auth);
  if (opts.orgs) registerOrgs(app, opts.orgs);
  // `/auth/v1/*`, which is a different surface from `/v1/auth/*` above. See
  // modules/project-auth/routes.ts for why the two prefixes look alike.
  if (opts.projectAuth) registerProjectAuth(app, opts.projectAuth);
  // After the auth module, which owns `/auth/v1/*` in-process (request pipeline
  // hop 7): the gateway proxies `/rest/v1/*` and nothing else, so the two do not
  // overlap — but registering it first would invite a future wildcard to swallow
  // routes the monolith serves itself.
  if (opts.gateway) registerGateway(app, opts.gateway);
  if (opts.storage) registerStorage(app, opts.storage);
  // Before the control plane, which owns `/v1/projects/:ref` and its children:
  // Fastify's router is exact-match per segment so there is no shadowing today,
  // but the console's route lives under a path the control plane also serves and
  // registering it first keeps that visible.
  if (opts.db) registerDbRoutes(app, opts.db);

  registerControlPlane(app, {
    store: opts.store ?? createMemoryStore(),
    // No fallback. A default here is a credential: an API deployed without
    // SH_STATIC_TOKEN used to accept the literal string 'dev-token' as the
    // bootstrap owner. Absent now means the static-token path does not exist.
    ...(opts.staticToken ?? process.env.SH_STATIC_TOKEN
      ? { staticToken: opts.staticToken ?? process.env.SH_STATIC_TOKEN! }
      : {}),
    ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}),
    ...(opts.projects ? { orgs: opts.projects.orgs, principals: opts.projects.principals } : {}),
    ...(opts.projectSecrets ? { secrets: opts.projectSecrets.secrets } : {}),
    ...(opts.signingKeys ? { signingKeys: opts.signingKeys } : {}),
    ...(opts.auth ? { pool: opts.auth.pool } : {}),
    ...(opts.projectsPerOrgLimit !== undefined
      ? { projectsPerOrgLimit: opts.projectsPerOrgLimit } : {}),
    ...(opts.enqueue ? { enqueue: opts.enqueue } : {}),
    ...(opts.enqueueRecovery ? { enqueueRecovery: opts.enqueueRecovery } : {}),
    ...(opts.onEnqueueError ? { onEnqueueError: opts.onEnqueueError } : {}),
  });
  return app;
}
