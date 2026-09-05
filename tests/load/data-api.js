import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/**
 * P5f — the request-pipeline smoke (testing strategy §5).
 *
 * Sustained mixed read/write against a seeded project through the whole origin
 * path: gateway → PostgREST → Postgres, with RLS deciding every row.
 *
 * ## What "origin" means here, and what it cannot mean
 *
 * The budget in the request-pipeline doc is a *hop table*, and the top two hops
 * are Cloudflare and the client's own network. Neither exists in a Docker staging
 * substitute, and inventing them would make the number worse than useless — it
 * would look like the advertised client-observed SLO while measuring something
 * else entirely.
 *
 * So this measures the **origin SLO** only: the surface the doc says is "what we
 * control and alert on", from the gateway's inbound socket to its outbound
 * response. Caddy is not in the staging stack either, so the origin boundary is
 * the gateway rather than Caddy — one loopback hop short of the doc's definition,
 * and short in the direction that flatters us, which is why it is written down.
 *
 * The absolute numbers are hardware. A GitHub runner is not a production node, so
 * a p50 that passes here proves the code is not pathological, never that the
 * production SLO is met. The threshold that genuinely travels between machines is
 * the *relative* one, and it lives in gateway-overhead.js.
 */

const BASE = __ENV.CB_LOAD_BASE_URL;
const HOST = __ENV.CB_LOAD_HOST;
const ANON = __ENV.CB_LOAD_ANON_KEY;
const USER = __ENV.CB_LOAD_USER_TOKEN;
const SERVICE = __ENV.CB_LOAD_SERVICE_KEY;

const readLatency = new Trend('cb_read_latency', true);
const writeLatency = new Trend('cb_write_latency', true);
const rlsCorrect = new Rate('cb_rls_correct');

export const options = {
  // k6's exported summary carries only p(90) and p(95) by default, and the budget
  // is written in p50 and p99. Without this the runner compares `undefined`.
  summaryTrendStats: ['avg', 'min', 'med', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    // A smoke, not a capacity test. The exit criterion asks whether the budget is
    // met under load, not where the knee is — finding the knee is Phase 9's
    // load-testing work and needs a production-shaped node to mean anything.
    smoke: {
      executor: 'constant-vus',
      vus: Number(__ENV.CB_LOAD_VUS || 10),
      duration: __ENV.CB_LOAD_DURATION || '30s',
    },
  },
  thresholds: {
    // The doc's origin SLO. Recorded as `abortOnFail: false` so a slow runner
    // reports the number rather than killing the run — the runner script decides
    // what blocks, and it distinguishes "slow machine" from "regression".
    'cb_read_latency': ['p(50)<20', 'p(99)<100'],
    'cb_write_latency': ['p(50)<40', 'p(99)<200'],
    // Sustained error rate ≈ 0. This one is not hardware-dependent and is
    // therefore enforced everywhere: a 500 under 10 VUs is a bug at any speed.
    'http_req_failed': ['rate<0.01'],
    // Every response must also be *correct*. A gateway that 200s with the wrong
    // rows would sail through a latency test, and the fastest possible
    // implementation of this API is one that returns nothing.
    'cb_rls_correct': ['rate>0.99'],
  },
};

const headers = (token) => ({
  Host: HOST,
  apikey: ANON,
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export default function () {
  // ── the read path: a simple indexed single-table query, which is what the
  // budget's row is measured against ───────────────────────────────────────────
  const read = http.get(
    `${BASE}/rest/v1/bench?select=id,body&owner=eq.${__ENV.CB_LOAD_OWNER}&limit=20`,
    { headers: headers(USER), tags: { path: 'read' } });
  readLatency.add(read.timings.duration);

  const readOk = check(read, { 'read 200': (r) => r.status === 200 });
  // RLS is still the thing under test. The seeded table holds rows owned by
  // somebody else, and a correct response never contains them.
  const clean = readOk && !String(read.body).includes('OTHER-OWNER-SECRET');
  rlsCorrect.add(clean);

  // ── the write path, at a tenth the rate: mixed, per the testing strategy, but
  // a write-heavy smoke would measure Postgres's WAL rather than the pipeline ──
  if (__ITER % 10 === 0) {
    const write = http.post(`${BASE}/rest/v1/bench`,
      JSON.stringify({ owner: __ENV.CB_LOAD_OWNER, body: `k6-${__VU}-${__ITER}` }),
      { headers: headers(USER), tags: { path: 'write' } });
    writeLatency.add(write.timings.duration);
    rlsCorrect.add(check(write, { 'write 2xx': (r) => r.status >= 200 && r.status < 300 }));
  }
}
