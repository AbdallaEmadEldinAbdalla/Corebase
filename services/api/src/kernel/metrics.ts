import type { FastifyInstance } from 'fastify';
import { Registry, Counter, Histogram } from '@steadhold/metrics';

/**
 * Control-plane API metrics (T9 seed).
 *
 * `route` here is Fastify's *pattern* (`/v1/projects/:ref`), never the resolved
 * path. The distinction is the whole cardinality story: the pattern is a handful
 * of values, while the resolved path carries a project ref and would put D-146's
 * ×10,000 multiplier on a histogram — the mistake that sinks a single-node
 * Prometheus.
 */
export const registry = new Registry();

export const requestsTotal = registry.register(new Counter({
  name: 'steadhold_api_requests_total',
  help: 'Control-plane API requests, by method, route pattern and status class.',
  labelNames: ['method', 'route', 'status'],
}));

export const requestSeconds = registry.register(new Histogram({
  name: 'steadhold_api_request_seconds',
  help: 'Control-plane API request duration.',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
}));

export function registerMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    // Unrouted requests would otherwise create a series per bad URL a scanner
    // tries; they all collapse to one bucket.
    const route = req.routeOptions?.url ?? 'unrouted';
    if (route === '/metrics') return;          // never measure the measurement
    const method = req.method;
    // 2xx/4xx/5xx rather than every code: the error-rate alert asks "what
    // fraction failed", and three values answer it at a fifth of the series.
    const status = `${Math.floor(reply.statusCode / 100)}xx`;
    requestsTotal.inc({ method, route, status });
    requestSeconds.observe({ method, route }, reply.elapsedTime / 1000);
  });

  // Unauthenticated on purpose: Prometheus scrapes it from the private network,
  // and a scrape target behind the customer's bearer token is a scrape target
  // that stops working the first time the token rotates. It exposes no customer
  // data — that is what the label discipline above is for.
  app.get('/metrics', async (_req, reply) => {
    const text = await registry.metricsText();
    return reply.header('content-type', Registry.CONTENT_TYPE).send(text);
  });
}
