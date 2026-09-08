import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

/**
 * P5f — what the gateway costs, measured rather than asserted.
 *
 * The latency budget's structural claim is a single sentence: *"everything
 * Steadhold added around PostgREST (hops 3–7) costs ~1.5 ms p50 — the gateway must
 * stay cheap enough that nobody is ever tempted to bypass it."* That is the
 * number worth defending, because it is the one that decides whether the thin
 * gateway (D-016) stays thin.
 *
 * It is also the only number in the budget that **travels between machines**. An
 * absolute p50 measured on a laptop or a CI runner says nothing about a
 * production node; the *difference* between two paths measured on the same box,
 * in the same run, under the same load, is a property of the code.
 *
 * So this script sends the identical query twice per iteration — once straight at
 * PostgREST, once through the gateway — and reports both. Interleaved rather than
 * run in sequence, so a noisy neighbour or a CPU frequency change hits both arms
 * equally instead of landing entirely on whichever ran second.
 */

const DIRECT = __ENV.SH_LOAD_DIRECT_URL;     // straight at PostgREST
const GATEWAY = __ENV.SH_LOAD_BASE_URL;      // through the gateway
const HOST = __ENV.SH_LOAD_HOST;
const ANON = __ENV.SH_LOAD_ANON_KEY;
const USER = __ENV.SH_LOAD_USER_TOKEN;

const direct = new Trend('sh_direct_latency', true);
const viaGateway = new Trend('sh_gateway_latency', true);

export const options = {
  // k6's exported summary carries only p(90) and p(95) by default, and the budget
  // is written in p50 and p99. Without this the runner compares `undefined`.
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    ab: {
      executor: 'constant-vus',
      vus: Number(__ENV.SH_LOAD_VUS || 10),
      duration: __ENV.SH_LOAD_DURATION || '30s',
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    // Deliberately absent: the overhead threshold itself. k6 cannot express "the
    // difference between two trends", so the runner computes it from the summary
    // and decides — see load.mts, which is also where the reasoning about what a
    // fair budget is on non-production hardware lives.
  },
};

// The same query on both arms, but **not the same path**: the gateway serves it
// under `/rest/v1` and strips that prefix before proxying, so PostgREST itself
// answers at `/bench`. Sharing one string sent the direct arm to a path PostgREST
// does not have, and a 404 is fast — the A/B then reported a 6 ms "gateway
// overhead" that was really the difference between a real query and a miss.
const q = `select=id,body&owner=eq.${__ENV.SH_LOAD_OWNER}&limit=20`;
const directPath = `/bench?${q}`;
const gatewayPath = `/rest/v1/bench?${q}`;

export default function () {
  // PostgREST has no gateway in front of it here, so it needs the Authorization
  // header the gateway would otherwise inject (D-109) and no apikey at all.
  const d = http.get(`${DIRECT}${directPath}`, {
    headers: { Authorization: `Bearer ${USER}` }, tags: { arm: 'direct' } });
  direct.add(d.timings.duration);
  check(d, { 'direct 200': (r) => r.status === 200 });

  const g = http.get(`${GATEWAY}${gatewayPath}`, {
    headers: { Host: HOST, apikey: ANON, Authorization: `Bearer ${USER}` },
    tags: { arm: 'gateway' } });
  viaGateway.add(g.timings.duration);
  check(g, { 'gateway 200': (r) => r.status === 200 });
}
