import Fastify, { type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './kernel/errors.ts';
import { registerControlPlane, type Enqueue } from './modules/control-plane/routes.ts';
import { createMemoryStore, type ControlPlaneStore } from './modules/control-plane/store.ts';
import { registerMetrics } from './kernel/metrics.ts';

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
  registerMetrics(app);

  app.get('/health', async () => ({ status: 'ok', service: 'api' }));
  app.get('/ready', async () => ({ status: 'ready' }));

  registerControlPlane(app, {
    store: opts.store ?? createMemoryStore(),
    staticToken: opts.staticToken ?? process.env.CB_STATIC_TOKEN ?? 'dev-token',
    ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}),
    ...(opts.enqueue ? { enqueue: opts.enqueue } : {}),
    ...(opts.onEnqueueError ? { onEnqueueError: opts.onEnqueueError } : {}),
  });
  return app;
}
