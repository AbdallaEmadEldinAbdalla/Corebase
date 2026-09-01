/**
 * Milestone 0 · T9 — the done-signal: "the provisioning-duration panel shows
 * T5's 20 runs", plus structured logs in Loki and one alert that can fire.
 *
 * Runs against the services started by `scripts/dev.sh`, because the whole point
 * is to check the *deployed* path: Prometheus scraping the real endpoints, Alloy
 * tailing the real log files, Grafana serving the provisioned dashboard. A
 * harness that started its own services on private ports would prove that the
 * code can emit metrics, which was never in doubt.
 *
 * Usage:
 *   ./scripts/staging.sh up && ./scripts/dev.sh          # in another terminal
 *   pnpm --filter @corebase/worker observability
 */
import { Pool } from 'pg';

const API = `http://127.0.0.1:${process.env.PORT ?? 8099}`;
const PROM = `http://127.0.0.1:${process.env.PROMETHEUS_PORT ?? 9090}`;
const LOKI = `http://127.0.0.1:${process.env.LOKI_PORT ?? 3100}`;
const GRAFANA = `http://127.0.0.1:${process.env.GRAFANA_PORT ?? 3001}`;
const TOKEN = process.env.CB_STATIC_TOKEN ?? 'observability-harness-token-long-enough';
const COUNT = Number(process.env.CB_OBS_COUNT ?? 20);

const pool = new Pool({
  connectionString: process.env.CB_CONTROL_DATABASE_URL
    ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control',
  max: 4,
});
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

async function waitFor(what: string, ok: () => Promise<boolean>, budgetMs = 60_000) {
  const until = Date.now() + budgetMs;
  for (;;) {
    if (await ok()) return true;
    if (Date.now() > until) { console.log(`  ✗ ${what} (timed out)`); return false; }
    await new Promise((r) => setTimeout(r, 500));
  }
}

interface PromResult { data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> } }
const promQuery = async (q: string): Promise<PromResult['data']['result']> => {
  const res = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`);
  return ((await res.json()) as PromResult).data.result;
};
const promScalar = async (q: string): Promise<number | undefined> => {
  const r = await promQuery(q);
  return r[0] ? Number(r[0].value[1]) : undefined;
};

interface LokiResult { data: { result: Array<{ stream: Record<string, string>; values: [string, string][] }> } }
const lokiQuery = async (q: string, sinceMs = 900_000): Promise<LokiResult['data']['result']> => {
  const end = Date.now() * 1e6;
  const start = (Date.now() - sinceMs) * 1e6;
  const url = `${LOKI}/loki/api/v1/query_range?query=${encodeURIComponent(q)}` +
    `&start=${start}&end=${end}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loki ${res.status}: ${await res.text()}`);
  return ((await res.json()) as LokiResult).data.result;
};

async function main() {
  console.log('▸ T9 — observability seed\n');

  // ── the stack is up ──────────────────────────────────────────────────────
  console.log('▸ endpoints');
  check('api /health', (await fetch(`${API}/health`).catch(() => null))?.ok === true);
  check('api /metrics', (await fetch(`${API}/metrics`).catch(() => null))?.ok === true);
  check('worker /metrics',
    (await fetch(`http://127.0.0.1:${process.env.CB_METRICS_PORT ?? 9101}/metrics`)
      .catch(() => null))?.ok === true);
  check('prometheus healthy', (await fetch(`${PROM}/-/healthy`).catch(() => null))?.ok === true);
  check('loki ready', (await fetch(`${LOKI}/ready`).catch(() => null))?.ok === true);
  check('grafana healthy', (await fetch(`${GRAFANA}/api/health`).catch(() => null))?.ok === true);

  if (checks.some((c) => !c.ok)) {
    console.log('\n✗ the stack is not up. ./scripts/staging.sh up, then ./scripts/dev.sh');
    process.exit(1);
  }

  // ── Prometheus is actually scraping our two services ─────────────────────
  console.log('\n▸ scrape targets');
  const targetsUp = await waitFor('both services scraped as up', async () => {
    const up = await promQuery('up{job=~"corebase-.*"}');
    return up.length >= 2 && up.every((t) => t.value[1] === '1');
  }, 30_000);
  const upTargets = await promQuery('up{job=~"corebase-.*"}');
  check('api and worker scraped', targetsUp,
    upTargets.map((t) => `${t.metric['job']}=${t.value[1]}`).join(' '));

  // ── produce the twenty runs the panel is supposed to show ────────────────
  console.log(`\n▸ ${COUNT} creates through the API`);
  const refs: string[] = [];
  const requestIds: string[] = [];
  for (let i = 1; i <= COUNT; i++) {
    const res = await fetch(`${API}/v1/projects`, {
      method: 'POST',
      headers: { ...auth, 'idempotency-key': `obs-${process.pid}-${String(i).padStart(3, '0')}` },
      body: JSON.stringify({ name: `obs-${process.pid}-${i}`, region: 'eu-central' }),
    });
    const body = (await res.json()) as { project: { ref: string } };
    refs.push(body.project.ref);
    requestIds.push(String(res.headers.get('x-request-id')));
  }
  const allReady = await waitFor(`${COUNT} projects ready`, async () => {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from projects where ref = any($1::citext[]) and status = 'ready'`,
      [refs]);
    return rows[0]!.n === COUNT;
  }, 180_000);
  check(`${COUNT} projects reached ready`, allReady);

  // ── the metrics the panel queries ────────────────────────────────────────
  console.log('\n▸ metrics');
  // Absolute, not a delta against a snapshot taken earlier. A counter delta is
  // meaningless across a process restart, and worse: an instant query looks back
  // five minutes, so a `before` reading can come from the *previous* worker's
  // now-stale series and produce a nonsense difference. Assert what the panel
  // shows instead.
  const HIST = 'sum(corebase_provisioning_job_seconds_count' +
    '{job_type="provision_project",outcome="succeeded"})';
  const counted = await waitFor('histogram observations arrived',
    async () => ((await promScalar(HIST)) ?? 0) >= COUNT, 90_000);
  check('provisioning histogram has the runs', counted,
    `${await promScalar(HIST)} successful observations`);

  const p50 = await promScalar(
    'histogram_quantile(0.5, sum by (le) (rate(corebase_provisioning_job_seconds_bucket{outcome="succeeded"}[5m])))');
  check('p50 is a plausible duration', typeof p50 === 'number' && p50 > 0 && p50 < 60,
    `p50 ≈ ${p50?.toFixed(2)}s`);

  const succeeded = await promScalar(
    'sum(corebase_provisioning_jobs_total{outcome="succeeded"})');
  check('job counter separates outcomes', (succeeded ?? 0) >= COUNT,
    `succeeded=${succeeded}`);

  const ratio = await promScalar('max(corebase_node_ram_reserved_ratio)');
  const booked = await promScalar('max(corebase_node_ram_reserved_mb)');
  check('node RAM booking is exported', typeof ratio === 'number' && ratio > 0,
    `${booked} MB = ${((ratio ?? 0) * 100).toFixed(1)}% of the node`);

  const stepFamilies = await promQuery(
    'count by (step) (corebase_provisioning_step_seconds_count)');
  check('per-step durations are exported', stepFamilies.length >= 8,
    `${stepFamilies.length} steps`);

  // ── the two label rules that keep Prometheus alive ───────────────────────
  console.log('\n▸ cardinality discipline (D-146)');
  const withRef = await promQuery('{__name__=~"corebase_.*", project_ref!=""}');
  check('no corebase metric carries project_ref', withRef.length === 0,
    withRef.length ? `LEAK: ${withRef.length} series` : 'per-project questions go to logs');
  const apiSeries = await promQuery('count(corebase_api_requests_total)');
  const apiCount = apiSeries[0] ? Number(apiSeries[0].value[1]) : 0;
  check('api request series stay bounded', apiCount > 0 && apiCount < 40,
    `${apiCount} series across method × route × status class`);

  // ── logs reached Loki, and can be found by ref and by request_id ─────────
  console.log('\n▸ logs in Loki');
  const ref = refs[0]!;
  const requestId = requestIds[0]!;
  const gotStreams = await waitFor('platform streams present', async () => {
    const r = await lokiQuery('{service=~"api|worker"}').catch(() => []);
    return r.length > 0;
  }, 90_000);
  const streams = await lokiQuery('{service=~"api|worker"}').catch(() => []);
  check('platform logs shipped', gotStreams,
    streams.map((s) => `${s.stream['service']}${s.stream['level'] ? '/' + s.stream['level'] : ''}`)
      .join(' '));

  const byRef = await waitFor(`a project's history is one query`, async () => {
    const r = await lokiQuery(`{service="worker"} |= \`${ref}\``).catch(() => []);
    return r.some((s) => s.values.length > 0);
  }, 60_000);
  const refLines = (await lokiQuery(`{service="worker"} |= \`${ref}\``).catch(() => []))
    .reduce((n, s) => n + s.values.length, 0);
  check(`ref=${ref} found in the log line, not a label`, byRef, `${refLines} lines`);

  const byRequest = (await lokiQuery(`{service=~"api|worker"} |= \`${requestId}\``).catch(() => []))
    .reduce((n, s) => n + s.values.length, 0);
  check('request_id joins the API request to the work it caused', byRequest >= 2,
    `${byRequest} lines for ${requestId}`);

  const labelsRes = await fetch(`${LOKI}/loki/api/v1/labels`).then((r) => r.json() as Promise<{ data: string[] }>);
  const labels = labelsRes.data ?? [];
  check('no request_id or ref among Loki labels', !labels.includes('request_id') && !labels.includes('ref'),
    `labels: ${labels.join(', ')}`);

  // ── the alert the plan asks for, proven able to fire ─────────────────────
  console.log('\n▸ alerting');
  const rules = await fetch(`${PROM}/api/v1/rules`).then((r) => r.json() as Promise<{
    data: { groups: Array<{ rules: Array<{ name: string; state?: string }> }> };
  }>);
  const ruleNames = rules.data.groups.flatMap((g) => g.rules.map((r) => r.name));
  check('ProvisioningJobStuck rule loaded', ruleNames.includes('ProvisioningJobStuck'),
    ruleNames.join(', '));

  // Plant a job that has been non-terminal for an hour, and watch the alert go
  // from inactive to firing. A rule that has never fired is a rule nobody knows
  // is broken.
  const { rows: org } = await pool.query<{ id: string }>(
    `insert into organizations (name, slug) values ('Obs','obs')
     on conflict (slug) do update set updated_at = now() returning id`);
  const { rows: stuck } = await pool.query<{ id: string }>(
    `insert into projects (organization_id, ref, name, status)
     values ($1, $2, $3, 'creating') returning id`,
    [org[0]!.id, 'z' + String(Date.now() % 100000) + 'stuckproject'.padEnd(14, 'x').slice(0, 14), 'stuck-probe']);
  await pool.query(
    `insert into provisioning_jobs (project_id, job_type, idempotency_key, state, created_at)
     values ($1, 'provision_project', $2, 'running', now() - interval '1 hour')`,
    [stuck[0]!.id, `stuck_probe_${Date.now()}`]);

  const aged = await waitFor('gauge reflects the aged job', async () =>
    ((await promScalar('corebase_provisioning_oldest_nonterminal_job_seconds')) ?? 0) > 600, 45_000);
  check('oldest-job gauge crosses the threshold', aged,
    `${Math.round((await promScalar('corebase_provisioning_oldest_nonterminal_job_seconds')) ?? 0)}s`);

  const fired = await waitFor('ProvisioningJobStuck fires', async () => {
    const r = await fetch(`${PROM}/api/v1/rules`).then((x) => x.json() as Promise<{
      data: { groups: Array<{ rules: Array<{ name: string; state?: string }> }> };
    }>);
    return r.data.groups.flatMap((g) => g.rules)
      // Specifically `firing`, not `pending`: a rule whose `for` window never
      // elapses would satisfy "pending" forever, and that is exactly the bug an
      // alert test is supposed to catch.
      .some((x) => x.name === 'ProvisioningJobStuck' && x.state === 'firing');
  }, 120_000);
  const state = (await fetch(`${PROM}/api/v1/rules`).then((x) => x.json() as Promise<{
    data: { groups: Array<{ rules: Array<{ name: string; state?: string }> }> };
  }>)).data.groups.flatMap((g) => g.rules).find((x) => x.name === 'ProvisioningJobStuck')?.state;
  check('the alert actually fires on a stuck job', fired, `state=${state}`);

  // Delete the job first. `provisioning_jobs.project_id` is ON DELETE SET NULL,
  // so removing only the project leaves a job that can never succeed — the
  // sweeper re-delivers it, the runner fails it for want of a project_id, and it
  // retries its way to a dead letter. Correct behaviour, pointless noise, and it
  // showed up as "failed 40 / dead_letter 10" on the dashboard.
  await pool.query(`delete from provisioning_jobs where project_id = $1`, [stuck[0]!.id]);
  await pool.query(`delete from projects where id = $1`, [stuck[0]!.id]);

  // ── the dashboard exists and its panel query resolves ───────────────────
  console.log('\n▸ dashboard');
  const dash = await fetch(`${GRAFANA}/api/dashboards/uid/corebase-provisioning`)
    .then((r) => (r.ok ? r.json() as Promise<{ dashboard: { title: string; panels: unknown[] } }> : null))
    .catch(() => null);
  check('provisioned dashboard is present', dash !== null,
    dash ? `"${dash.dashboard.title}" with ${dash.dashboard.panels.length} panels` : 'missing');
  check('datasources provisioned',
    (await fetch(`${GRAFANA}/api/datasources`).then((r) => r.json() as Promise<unknown[]>)).length >= 2);

  await pool.end();
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length === 0
    ? `\n▸ T9 PASS — ${checks.length} checks: metrics scraped, logs queryable by ref and request_id, alert fires, panel shows ${COUNT} runs`
    : `\n▸ T9 FAIL — ${failed.length}/${checks.length} checks failed: ${failed.map((f) => f.name).join('; ')}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
