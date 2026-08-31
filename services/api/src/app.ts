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
}

/** Composition root: the only place that wires modules together. */
export function buildApp(opts: BuildOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, genReqId: () => `req_${crypto.randomUUID()}` });
  registerErrorHandling(app);
  registerMetrics(app);

  app.get('/health', async () => ({ status: 'ok', service: 'api' }));
  app.get('/ready', async () => ({ status: 'ready' }));

  registerControlPlane(app, {
    store: opts.store ?? createMemoryStore(),
    staticToken: opts.staticToken ?? process.env.CB_STATIC_TOKEN ?? 'dev-token',
    ...(opts.enqueue ? { enqueue: opts.enqueue } : {}),
    ...(opts.onEnqueueError ? { onEnqueueError: opts.onEnqueueError } : {}),
  });
  return app;
}
