import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './kernel/errors.ts';
import { registerCors } from './kernel/cors.ts';
import { registerControlPlane, type Enqueue, type ControlPlaneDeps } from './modules/control-plane/routes.ts';
import { createMemoryStore, type ControlPlaneStore } from './modules/control-plane/store.ts';
import { registerMetrics } from './kernel/metrics.ts';
import { registerAuth, type AuthDeps } from './modules/auth/routes.ts';
import { registerOrgs, type OrgDeps } from './modules/orgs/routes.ts';
import type { PrincipalDeps } from './kernel/principal.ts';

export interface BuildOptions {
  store?: ControlPlaneStore;
  enqueue?: Enqueue;
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
   * Origins allowed to call this API from a browser (P1g). Absent or empty means
   * none — see kernel/cors.ts for why that is the default rather than localhost.
   */
  corsOrigins?: readonly string[];
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

  registerControlPlane(app, {
    store: opts.store ?? createMemoryStore(),
    staticToken: opts.staticToken ?? process.env.CB_STATIC_TOKEN ?? 'dev-token',
    ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}),
    ...(opts.projects ? { orgs: opts.projects.orgs, principals: opts.projects.principals } : {}),
    ...(opts.projectSecrets ? { secrets: opts.projectSecrets.secrets } : {}),
    ...(opts.auth ? { pool: opts.auth.pool } : {}),
    ...(opts.enqueue ? { enqueue: opts.enqueue } : {}),
    ...(opts.onEnqueueError ? { onEnqueueError: opts.onEnqueueError } : {}),
  });
  return app;
}
