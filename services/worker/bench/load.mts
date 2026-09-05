/**
 * P5f — the latency budget under k6 smoke load.
 *
 * Phase 5's third exit criterion. Stands up the real thing — the real API process
 * with the gateway wired, a genuinely provisioned project, a seeded table with an
 * RLS policy — points k6 at it twice, and decides whether the budget held.
 *
 * ## Which numbers block, and why they are not the same numbers
 *
 * The budget in the request-pipeline doc is a hop table whose top two rows are
 * Cloudflare and the client's own network. Neither exists here, and Caddy is not
 * in the staging stack either, so what is measured is the **origin** surface —
 * the one the doc calls "what we control and alert on" — one loopback hop short
 * of the doc's definition, and short in the direction that flatters us.
 *
 * More importantly: **absolute latency is hardware.** A GitHub runner shares a
 * CPU with whoever else is on the box. A p50 that passes there proves the code is
 * not pathological; it never proves the production SLO is met, and a threshold
 * that pretends otherwise buys a red build every time the runner is busy, which
 * is how a performance gate gets muted.
 *
 * So the run separates the two kinds of claim:
 *
 *   - **Hardware-independent, and therefore blocking anywhere**: the error rate,
 *     the RLS-correctness rate, and the *gateway's added cost* — measured as the
 *     difference between two arms of the same interleaved run on the same box.
 *     That difference is a property of the code.
 *   - **Hardware-dependent, and therefore reported**: the absolute p50 and p99
 *     against the doc's numbers. Enforced only under `CB_LOAD_STRICT=1`, which is
 *     what a production-shaped node would set.
 *
 * OQ-151 asked when the k6 suite stops being record-only. The answer is now for
 * the first group and "on production hardware" for the second (D-388).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { request as httpRequest } from 'node:http';
import { Client, Pool } from 'pg';
import { appDatabaseUrl, backupStoreEnv, bootstrapOrgId } from './staging-env.mts';

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');
const PORT = Number(process.env.CB_LOAD_API_PORT ?? 8097);
const TOKEN = 'load-token-harness-token-long-enough-for-the-boot-check';
const VUS = process.env.CB_LOAD_VUS ?? '10';
const DURATION = process.env.CB_LOAD_DURATION ?? '30s';
const STRICT = process.env.CB_LOAD_STRICT === '1';
const DOMAIN = 'corebase.test';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OUT_DIR = process.env.CB_LOAD_OUT ?? join(ROOT, 'docs/14-roadmap/measurements');

const backupEnv = backupStoreEnv(ROOT);
if (!backupEnv['CB_BACKUP_S3_ENDPOINT']) {
  throw new Error(
    'no object-store settings at infra/docker/staging/backup-store.env — '
    + 'run ./scripts/staging.sh backup-store. This harness provisions a project, '
    + 'and provisioning requires a backup repo (CB_REQUIRE_BACKUPS).');
}

const env = {
  ...backupEnv,
  ...process.env,
  CB_CONTROL_DATABASE_URL: appDatabaseUrl(ROOT),
  CB_REDIS_URL: process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379',
  CB_DOCKER_HOST: process.env.CB_DOCKER_HOST ?? '127.0.0.1',
  CB_DOCKER_PORT: process.env.CB_DOCKER_PORT ?? '2376',
  CB_DOCKER_CERT_DIR: process.env.CB_DOCKER_CERT_DIR ?? join(ROOT, 'infra/docker/staging/certs'),
  CB_KEK_DIR: process.env.CB_KEK_DIR ?? join(ROOT, 'infra/docker/staging/kek.d'),
  CB_BOOTSTRAP_SECRET: process.env.CB_BOOTSTRAP_SECRET ?? 'load-bootstrap-secret-0123456789',
  // The gateway resolves a project from the Host header, so the domain here and
  // the Host k6 sends must agree or every request is a 404 that looks like a
  // broken route rather than a mismatched setting.
  CB_PROJECT_DOMAIN: DOMAIN,
  // CB_JWT_ISSUER is deliberately **not** set. The worker falls back to
  // `https://<ref>.<domain>` per project, which is exactly what the gateway
  // checks (D-319, and P5e's issuer check). Setting it to a flat
  // `https://corebase.test` mints every project's keys under an issuer no
  // project's gateway will accept, and the entire run comes back 403 — which is
  // how the first version of this harness produced a beautiful 0.9 ms p50 that
  // was measuring the latency of a rejection.
  CB_NODE_RAM_MB: process.env.CB_NODE_RAM_MB ?? '16384',
  CB_NODE_HOSTNAME: process.env.CB_NODE_HOSTNAME ?? 'data-1',
  CB_STATIC_TOKEN: TOKEN,
  PORT: String(PORT),
  CB_METRICS_PORT: process.env.CB_METRICS_PORT ?? '9112',
  // The rate limiter must not be what this measures. The gateway's buckets are
  // P5c's concern and a 429 mid-run would show up as a latency cliff and an error
  // rate, i.e. as a performance regression that is nothing of the kind.
  CB_GW_IP_RPS: '1000000',
  CB_GW_KEY_RPS: '1000000',
  CB_GW_PROJECT_RPS: '1000000',
};

const children: ChildProcess[] = [];
const logLines: Record<string, string[]> = { api: [], worker: [] };

function start(name: 'api' | 'worker'): ChildProcess {
  const child = spawn('node', ['--experimental-strip-types', 'src/main.ts'], {
    cwd: join(ROOT, 'services', name), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (buf: Buffer) => {
    for (const line of buf.toString().split('\n')) if (line.trim()) logLines[name]!.push(line);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`\n${name} exited with code ${code}. Last lines:`);
      console.error(logLines[name]!.slice(-12).join('\n'));
    }
  });
  children.push(child);
  return child;
}
const stopAll = () => { for (const c of children) c.kill('SIGTERM'); };

async function waitFor(what: string, probe: () => Promise<boolean>, ms: number, log: 'api' | 'worker') {
  const until = Date.now() + ms;
  for (;;) {
    if (await probe().catch(() => false)) return;
    if (Date.now() > until) {
      console.error(`${log} log:\n` + logLines[log]!.slice(-15).join('\n'));
      throw new Error(`${what} did not happen within ${ms}ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

interface Detail {
  project: { ref: string; id: string; status: string };
  database?: { host: string; port: number };
}

async function createProject(): Promise<string> {
  const orgId = await bootstrapOrgId(`http://127.0.0.1:${PORT}`, auth as Record<string, string>);
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/projects`, {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': `load-${process.pid}` },
    body: JSON.stringify({ name: `load-${process.pid}`, region: 'eu-central', org_id: orgId }),
  });
  if (res.status !== 202) throw new Error(`create returned ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { project: { ref: string } }).project.ref;
}

async function pollReady(ref: string, budgetMs = 180_000): Promise<Detail> {
  const until = Date.now() + budgetMs;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/projects/${ref}`, { headers: auth });
    const body = (await res.json()) as Detail;
    if (body.project?.status === 'ready') return body;
    if (body.project?.status === 'failed') throw new Error(`project ${ref} failed to provision`);
    if (Date.now() > until) throw new Error(`project ${ref} was not ready within ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The table under load: a simple indexed single-table read, which is exactly what
 * the budget's Postgres row is specified against — "indexed read". Anything more
 * elaborate measures the customer's schema rather than the pipeline.
 *
 * The `OTHER-OWNER-SECRET` rows are the point of the policy. k6 asserts on every
 * response that they never appear, so a regression that made the gateway fast by
 * dropping RLS would fail the run rather than improve the numbers.
 */
async function seed(control: Pool, projectId: string): Promise<void> {
  const { rows } = await control.query<{ port: number }>(
    `select port from project_databases where project_id = $1`, [projectId]);
  const port = rows[0]!.port;
  const su = new Client({
    host: '127.0.0.1', port, database: 'postgres',
    user: 'postgres', password: await postgresPassword(control, projectId),
    connectionTimeoutMillis: 10_000,
  });
  await su.connect();
  try {
    await su.query(`
      create table public.bench (
        id bigserial primary key, owner uuid not null, body text not null);
      create index on public.bench (owner);
      insert into public.bench (owner, body)
        select '${OWNER}', 'row-' || g from generate_series(1, 2000) g;
      insert into public.bench (owner, body)
        select '${OTHER}', 'OTHER-OWNER-SECRET-' || g from generate_series(1, 2000) g;
      alter table public.bench enable row level security;
      create policy "own rows" on public.bench for select
        to authenticated using ( owner = (select auth.uid()) );
      create policy "insert own" on public.bench for insert
        to authenticated with check ( owner = (select auth.uid()) );
      grant select, insert on public.bench to authenticated;
      grant usage, select on sequence public.bench_id_seq to authenticated;
      analyze public.bench;
      notify pgrst, 'reload schema';
    `);
  } finally { await su.end(); }
}

async function postgresPassword(control: Pool, projectId: string): Promise<string> {
  const { createSecretStore, SECRET_NAMES } = await import('@corebase/secrets');
  const { createEnvelope } = await import('@corebase/crypto');
  const secrets = createSecretStore(control, createEnvelope({ kekDir: env.CB_KEK_DIR! }));
  const pw = await secrets.get(projectId, SECRET_NAMES.postgres);
  if (!pw) throw new Error('the project has no stored postgres password');
  return pw;
}

/** A user token signed by the project's own key — what a real session carries. */
async function userToken(control: Pool, projectId: string, ref: string): Promise<string> {
  const { createSecretStore, SECRET_NAMES } = await import('@corebase/secrets');
  const { createEnvelope } = await import('@corebase/crypto');
  const { sign } = await import('@corebase/jwt');
  const secrets = createSecretStore(control, createEnvelope({ kekDir: env.CB_KEK_DIR! }));
  const [priv, kid] = await Promise.all([
    secrets.get(projectId, SECRET_NAMES.jwtPrivateKey),
    secrets.get(projectId, SECRET_NAMES.jwtKid),
  ]);
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: `https://${ref}.${DOMAIN}`, ref, role: 'authenticated', sub: OWNER,
    aud: 'authenticated', iat: now, exp: now + 7200,
  }, { privateKeyPem: priv!, kid: kid! });
}

/**
 * k6 runs in Docker, which means it has to be told how to reach the host.
 *
 * On Linux `--network host` puts it in the host's namespace and `127.0.0.1` is
 * the host. On macOS the daemon runs in a VM, so `--network host` reaches the
 * VM's loopback and the API is not there — `host.docker.internal` is. Getting
 * this wrong produces a connection refused for every request, which reads as "the
 * API is down" rather than "the container is on the wrong network".
 */
const linux = platform() === 'linux';
const hostFromContainer = linux ? '127.0.0.1' : 'host.docker.internal';

/**
 * k6's `--summary-export` shape is flat: each metric maps straight to its stats,
 * with no `values` wrapper. It also emits only p(90) and p(95) unless
 * `summaryTrendStats` asks for more — which is why both scripts set it. Reading
 * the wrong shape here threw `Cannot read properties of undefined`, which at
 * least failed loudly; reading a *missing percentile* would have silently
 * compared `undefined` and passed.
 */
interface Summary {
  metrics: Record<string, Record<string, number | Record<string, boolean>>>;
  root_group?: {
    checks?: Record<string, { passes: number; fails: number; name: string }>;
  };
}

async function k6(script: string, extraEnv: Record<string, string>): Promise<Summary> {
  const summaryPath = `/tmp/k6-${script.replace(/\W/g, '-')}-${process.pid}.json`;
  const args = [
    'run', '--rm', '-i',
    ...(linux ? ['--network', 'host'] : ['--add-host', 'host.docker.internal:host-gateway']),
    '-v', `${OUT_DIR}:/out`,
    ...Object.entries(extraEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-e', `K6_SUMMARY_EXPORT=/out/${script}.summary.json`,
    'grafana/k6:latest', 'run', '--quiet', '--summary-export', `/out/${script}.summary.json`, '-',
  ];
  const scriptBody = readFileSync(join(ROOT, 'tests/load', script), 'utf8');
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  child.stdin.write(scriptBody);
  child.stdin.end();
  const code: number = await new Promise((r) => child.on('exit', (c) => r(c ?? 1)));
  // k6 exits non-zero when a *threshold* fails, which is information rather than
  // an error — the summary is still written and this run wants to read it and
  // decide for itself. Only a missing summary is fatal.
  let summary: Summary;
  try {
    summary = JSON.parse(readFileSync(join(OUT_DIR, `${script}.summary.json`), 'utf8')) as Summary;
  } catch {
    throw new Error(`k6 produced no summary (exit ${code}).\nstdout:\n${out}\nstderr:\n${err}`);
  }
  void summaryPath;
  return summary;
}

const val = (s: Summary, metric: string, stat: string): number | undefined => {
  const v = s.metrics[metric]?.[stat];
  return typeof v === 'number' ? v : undefined;
};

/** Every failed check in the run, so a wrong response can never read as a fast one. */
function failedChecks(s: Summary): Array<{ name: string; fails: number; passes: number }> {
  return Object.values(s.root_group?.checks ?? {})
    .filter((c) => c.fails > 0)
    .map((c) => ({ name: c.name, fails: c.fails, passes: c.passes }));
}
const ms = (n: number | undefined) => (n === undefined ? 'n/a' : `${n.toFixed(2)} ms`);

/**
 * A GET that can actually set `Host`.
 *
 * Node's `fetch` (undici) treats `Host` as a forbidden header and silently drops
 * it, so every preflight request arrived at the gateway announcing
 * `127.0.0.1:8097` and was answered `project_not_found`. k6 is a Go program and
 * sends what it is told, so the *measured* run resolved the project correctly
 * while the check in front of it could not — a harness that fails where the thing
 * it guards succeeds, which is the most confusing arrangement available.
 */
function get(
  port: number, path: string, headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve2, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve2({ status: res.statusCode ?? 0, body }));
      });
    req.on('error', reject);
    req.end();
  });
}

/**
 * One request per arm, fully checked, before any measurement runs.
 *
 * Asserts the status, that rows came back at all, and that they are the *right*
 * rows — a response filtered by RLS to zero rows would also be fast, and would
 * also be wrong.
 */
async function preflight(
  ref: string, anon: string, user: string, postgrestPort: number,
): Promise<void> {
  // A 404 here is not a failure yet: the routing table is refreshed on a timer
  // and holds no entry for a project provisioned seconds ago. That staleness is
  // deliberate (D-376 — the gateway makes no control-plane query on the hot
  // path), so the harness waits for the window rather than treating it as a bug
  // or, worse, measuring it.
  let viaGateway = { status: 0, body: '' };
  const until = Date.now() + 45_000;
  for (;;) {
    viaGateway = await get(PORT, `/rest/v1/bench?select=id,body&owner=eq.${OWNER}&limit=5`,
      { Host: `${ref}.${DOMAIN}`, apikey: anon, authorization: `Bearer ${user}` });
    if (viaGateway.status !== 404 || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const gatewayBody = viaGateway.body;
  if (viaGateway.status !== 200) {
    throw new Error(`the gateway answered ${viaGateway.status} to the query this run is `
      + `about to measure ${Number(VUS) * 1000} times: ${gatewayBody}`);
  }
  const rows = JSON.parse(gatewayBody) as unknown[];
  if (rows.length === 0) {
    throw new Error('the gateway returned 200 and no rows — the policy, the token\'s '
      + 'subject or the seed disagree, and a run against an empty result measures nothing');
  }
  if (gatewayBody.includes('OTHER-OWNER-SECRET')) {
    throw new Error('the seeded policy is not filtering: another owner\'s rows came back '
      + 'through the gateway. That is a security failure and the run stops here');
  }

  const direct = await get(postgrestPort, `/bench?select=id&owner=eq.${OWNER}&limit=5`,
    { authorization: `Bearer ${user}` });
  if (direct.status !== 200) {
    throw new Error(`PostgREST answered ${direct.status} directly: ${direct.body}. `
      + 'The A/B arm needs both paths working or the overhead number is meaningless.');
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  start('api');
  start('worker');
  await waitFor('the API became healthy',
    async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).ok, 60_000, 'api');
  await waitFor('the worker registered its node',
    async () => logLines.worker!.some((l) => l.includes('node registered')), 60_000, 'worker');

  console.log('▸ provisioning a project');
  const ref = await createProject();
  const detail = await pollReady(ref);
  // A Pool rather than a Client: the secret store takes one, and a cast would be
  // a lie about a type that has real methods behind it.
  const control = new Pool({ connectionString: env.CB_CONTROL_DATABASE_URL, max: 4 });
  const { rows } = await control.query<{ id: string; postgrest_port: number }>(
    `select p.id, d.postgrest_port from projects p
       join project_databases d on d.project_id = p.id where p.ref = $1`, [ref]);
  const projectId = rows[0]!.id;
  const postgrestPort = rows[0]!.postgrest_port;
  void detail;

  console.log('▸ seeding 4000 rows behind an RLS policy');
  await seed(control, projectId);

  const { createSecretStore, SECRET_NAMES } = await import('@corebase/secrets');
  const { createEnvelope } = await import('@corebase/crypto');
  const secrets = createSecretStore(control, createEnvelope({ kekDir: env.CB_KEK_DIR! }));
  const anon = (await secrets.get(projectId, SECRET_NAMES.anonKey))!;
  const service = (await secrets.get(projectId, SECRET_NAMES.serviceRoleKey))!;
  const user = await userToken(control, projectId, ref);

  const shared = {
    CB_LOAD_BASE_URL: `http://${hostFromContainer}:${PORT}`,
    CB_LOAD_DIRECT_URL: `http://${hostFromContainer}:${postgrestPort}`,
    CB_LOAD_HOST: `${ref}.${DOMAIN}`,
    CB_LOAD_ANON_KEY: anon,
    CB_LOAD_SERVICE_KEY: service,
    CB_LOAD_USER_TOKEN: user,
    CB_LOAD_OWNER: OWNER,
    CB_LOAD_VUS: VUS,
    CB_LOAD_DURATION: DURATION,
  };

  // ── preflight ──────────────────────────────────────────────────────────────
  //
  // Nothing is measured until one request of each arm is proven *correct*. This
  // exists because the first run of this harness reported a 0.9 ms p50 across
  // 47,351 requests, every one of which was a 403: a misconfigured issuer meant
  // the gateway rejected every key, and rejections are fast.
  //
  // A load test that does not check its own responses measures the error path and
  // reports it as the happy path — and the faster the error, the better the
  // result looks.
  console.log('▸ preflight');
  await preflight(ref, anon, user, postgrestPort);

  // A short warm-up before either measurement. The first requests pay for
  // PostgREST's schema cache, the pool's first connections, Redis's first
  // round-trip and V8's first pass through the gateway — all real costs, none of
  // them steady-state, and all of them landing in the p99 of a 30-second run.
  console.log('▸ warming up');
  for (let i = 0; i < 50; i++) {
    await get(PORT, '/rest/v1/bench?select=id&limit=1',
      { Host: `${ref}.${DOMAIN}`, apikey: anon, authorization: `Bearer ${user}` })
      .catch(() => undefined);
    await get(postgrestPort, '/bench?select=id&limit=1', { authorization: `Bearer ${user}` })
      .catch(() => undefined);
  }

  console.log(`▸ k6: request-pipeline smoke (${VUS} VUs, ${DURATION})`);
  const smoke = await k6('data-api.js', shared);

  // Two A/B runs, and the difference between them is the whole point.
  //
  // At concurrency the gateway is one single-threaded Node process while
  // PostgREST is a Haskell server with a thread pool, so the *latency* gap
  // includes event-loop queuing — real for a client, but not the per-request cost
  // the budget's ~1.5 ms describes. The serial run has no queue to wait in and is
  // therefore the number comparable to the doc; the concurrent one is reported
  // beside it so the queuing cost is visible rather than blamed on the code.
  console.log('▸ k6: gateway overhead A/B (1 VU — per-request cost)');
  const abSerial = await k6('gateway-overhead.js',
    { ...shared, CB_LOAD_VUS: '1', CB_LOAD_DURATION: '15s' });

  console.log(`▸ k6: gateway overhead A/B (${VUS} VUs — with queuing)`);
  const ab = await k6('gateway-overhead.js', shared);

  await control.end();

  // ── the verdict ────────────────────────────────────────────────────────────
  const readP50 = val(smoke, 'cb_read_latency', 'p(50)');
  const readP99 = val(smoke, 'cb_read_latency', 'p(99)');
  const writeP50 = val(smoke, 'cb_write_latency', 'p(50)');
  const writeP99 = val(smoke, 'cb_write_latency', 'p(99)');
  // `http_req_failed` is a Rate, and its summary field is `value`, not `rate`.
  const errorRate = val(smoke, 'http_req_failed', 'value') ?? 1;
  const rlsRate = val(smoke, 'cb_rls_correct', 'value') ?? 0;
  const reqs = val(smoke, 'http_reqs', 'count') ?? 0;

  const sDirect = val(abSerial, 'cb_direct_latency', 'p(50)') ?? 0;
  const sGateway = val(abSerial, 'cb_gateway_latency', 'p(50)') ?? 0;
  const serialOverhead = sGateway - sDirect;

  const directP50 = val(ab, 'cb_direct_latency', 'p(50)') ?? 0;
  const gatewayP50 = val(ab, 'cb_gateway_latency', 'p(50)') ?? 0;
  const directP99 = val(ab, 'cb_direct_latency', 'p(99)') ?? 0;
  const gatewayP99 = val(ab, 'cb_gateway_latency', 'p(99)') ?? 0;
  const overheadP50 = gatewayP50 - directP50;
  const overheadP99 = gatewayP99 - directP99;

  console.log('\n── request-pipeline smoke ──────────────────────────────');
  console.log(`  requests            ${reqs}`);
  console.log(`  read   p50 / p99    ${ms(readP50)} / ${ms(readP99)}   (budget 20 / 100)`);
  console.log(`  write  p50 / p99    ${ms(writeP50)} / ${ms(writeP99)}`);
  console.log(`  error rate          ${(errorRate * 100).toFixed(3)} %`);
  console.log(`  RLS correct         ${(rlsRate * 100).toFixed(3)} %`);
  console.log('\n── gateway overhead, 1 VU (per-request cost) ──────────');
  console.log(`  direct   p50        ${ms(sDirect)}`);
  console.log(`  gateway  p50        ${ms(sGateway)}`);
  console.log(`  added    p50        ${ms(serialOverhead)}   (budget ~1.5, doc's figure)`);
  console.log(`\n── gateway overhead, ${VUS} VUs (adds queuing) ───────────`);
  console.log(`  direct   p50 / p99  ${ms(directP50)} / ${ms(directP99)}`);
  console.log(`  gateway  p50 / p99  ${ms(gatewayP50)} / ${ms(gatewayP99)}`);
  console.log(`  added    p50 / p99  ${ms(overheadP50)} / ${ms(overheadP99)}`);

  const failures: string[] = [];

  // Hardware-independent, so these block everywhere.
  if (errorRate > 0.01) failures.push(`error rate ${(errorRate * 100).toFixed(2)}% exceeds 1%`);
  if (rlsRate < 0.99) {
    failures.push(`RLS correctness ${(rlsRate * 100).toFixed(2)}% — a response contained `
      + 'another owner\'s rows, which is a security failure, not a slow one');
  }
  if (reqs < 100) failures.push(`only ${reqs} requests — the run did not really happen`);

  // Checks are the run's own account of whether it measured the thing it meant
  // to. Any failure here invalidates every latency number above it, so it is
  // listed before them and in full.
  for (const s2 of [smoke, ab]) {
    for (const c of failedChecks(s2)) {
      failures.push(`check "${c.name}" failed ${c.fails} times (passed ${c.passes}) — `
        + 'the latencies above are the latency of that failure');
    }
  }

  // The structural claim. A budget rather than the doc's exact 1.5 ms, because
  // the *absolute* cost of three Redis round-trips and an ES256 verify still
  // scales with the CPU — but a gateway that has quietly grown a query, a parse
  // or a body inspection shows up here as milliseconds, not as noise.
  //
  // Checked against the **serial** number, because that is the one the doc's
  // figure describes. The concurrent delta is reported, not enforced: it is
  // dominated by how many VUs are aimed at a single-threaded process, so
  // enforcing it would be enforcing a property of the load generator.
  const overheadBudget = Number(process.env.CB_LOAD_OVERHEAD_P50_MS ?? (STRICT ? 1.5 : 3));
  if (serialOverhead > overheadBudget) {
    failures.push(`the gateway adds ${serialOverhead.toFixed(2)} ms per request at p50, over `
      + `the ${overheadBudget} ms budget — D-016 says it must stay cheap enough that nobody `
      + 'is tempted to bypass it');
  }

  // Hardware-dependent, so reported unless a production-shaped node says otherwise.
  const absolute: string[] = [];
  if ((readP50 ?? Infinity) > 20) absolute.push(`read p50 ${ms(readP50)} over the 20 ms budget`);
  if ((readP99 ?? Infinity) > 100) absolute.push(`read p99 ${ms(readP99)} over the 100 ms budget`);
  if (absolute.length) {
    if (STRICT) failures.push(...absolute);
    else {
      console.log('\n  ⚠ absolute budget not met, reported and not blocking:');
      for (const a of absolute) console.log(`      ${a}`);
      console.log('      Absolute latency is hardware. Set CB_LOAD_STRICT=1 on a');
      console.log('      production-shaped node to make these block (D-388).');
    }
  }

  const record = {
    at: new Date().toISOString(),
    strict: STRICT, vus: Number(VUS), duration: DURATION,
    host: { platform: platform(), cpus: (await import('node:os')).cpus().length },
    smoke: { reqs, readP50, readP99, writeP50, writeP99, errorRate, rlsRate },
    overhead: {
      serial: { directP50: sDirect, gatewayP50: sGateway, addedP50: serialOverhead },
      concurrent: { directP50, gatewayP50, directP99, gatewayP99, overheadP50, overheadP99 },
    },
    failures,
  };
  writeFileSync(join(OUT_DIR, 'p5f-latency.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`\n  → ${join(OUT_DIR, 'p5f-latency.json')}`);

  if (failures.length) {
    console.error('\n✗ the latency budget was not met:');
    for (const f of failures) console.error(`    ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n✓ the latency budget held');
}

try {
  await main();
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  stopAll();
  // The provisioned project stays on the node deliberately: a failed run is worth
  // inspecting, and the next run gets a fresh ref. `./scripts/staging.sh nuke`
  // is the reset.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
}
