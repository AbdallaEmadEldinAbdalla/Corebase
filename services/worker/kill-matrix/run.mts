/**
 * Milestone 0 · T6 — the crash-resume kill matrix.
 *
 * SIGKILL the worker at every interesting point in the provisioning saga and
 * prove the job converges on restart with **zero duplicate containers, volumes,
 * placement rows, credentials or RAM bookings**.
 *
 * SIGKILL, not SIGTERM, on purpose: SIGTERM runs the graceful shutdown that
 * finishes in-flight work, which is the case that cannot fail. A killed process
 * gets no chance to tidy up, leaves its `provisioning_jobs` row claimed, its
 * BullMQ delivery locked, and whatever half-finished state the step had reached
 * on the data node. That is the case worth proving.
 *
 * Two kinds of kill point:
 *
 *   boundary  — after step N completed and its checkpoint was written. The
 *               resumed job should skip N and continue at N+1.
 *   mid-step  — after a step logged progress but before it finished, so no
 *               checkpoint exists. The resumed job re-runs the whole step, which
 *               is only safe because every step is check-then-act.
 *
 * Usage (staging up, migrated, image seeded):
 *   pnpm --filter @corebase/worker kill-matrix
 *   CB_KM_ONLY=start_container pnpm --filter @corebase/worker kill-matrix
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { Pool, Client } from 'pg';
import {
  appDatabaseUrl, ownerDatabaseUrl, backupStoreEnv, bootstrapOrgId,
} from '../bench/staging-env.mts';

const ROOT = resolve(import.meta.dirname, '../../..');
const PORT = Number(process.env.CB_KM_API_PORT ?? 8097);
const TOKEN = 'km-token-harness-token-long-enough-for-the-boot-check';
const CONVERGE_BUDGET_MS = Number(process.env.CB_KM_CONVERGE_MS ?? 120_000);
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR ?? join(ROOT, 'infra/docker/staging/certs');
const DOCKER_HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const DOCKER_PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);

/**
 * The object store. Without these, `configure_backups` refuses to finish
 * (`CB_REQUIRE_BACKUPS`) and every scenario dead-letters at 5/5 attempts having
 * completed five steps — which is what this drill has been doing since P3a added
 * that step, reporting it as "DID NOT CONVERGE" with the actual error four lines
 * out of reach.
 */
const backupEnv = backupStoreEnv(ROOT);
if (!backupEnv['CB_BACKUP_S3_ENDPOINT']) {
  // Loud and up front. A drill that runs for twenty minutes and then reports
  // eleven mysterious failures is worse than one that refuses to start.
  throw new Error(
    'no object-store settings found at infra/docker/staging/backup-store.env — '
    + 'run ./scripts/staging.sh backup-store. Every scenario provisions a project, '
    + 'and provisioning requires a backup repo (CB_REQUIRE_BACKUPS).');
}

const env = {
  ...process.env,
  ...backupEnv,
  CB_CONTROL_DATABASE_URL: appDatabaseUrl(ROOT),
  CB_REDIS_URL: process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379',
  CB_DOCKER_HOST: DOCKER_HOST,
  CB_DOCKER_PORT: String(DOCKER_PORT),
  CB_DOCKER_CERT_DIR: CERT_DIR,
  CB_KEK_DIR: process.env.CB_KEK_DIR ?? join(ROOT, 'infra/docker/staging/kek.d'),
  CB_BOOTSTRAP_SECRET: process.env.CB_BOOTSTRAP_SECRET ?? 'km-bootstrap-secret-0123456789',
  CB_PROJECT_DOMAIN: process.env.CB_PROJECT_DOMAIN ?? 'localhost',
  CB_PG_PORT_MIN: process.env.CB_PG_PORT_MIN ?? '5433',
  CB_PG_PORT_MAX: process.env.CB_PG_PORT_MAX ?? '5462',
  CB_NODE_RAM_MB: process.env.CB_NODE_RAM_MB ?? '16384',
  CB_NODE_HOSTNAME: 'data-1',
  CB_STATIC_TOKEN: TOKEN,
  PORT: String(PORT),
  CB_METRICS_PORT: process.env.CB_METRICS_PORT ?? '9114',
};

const pool = new Pool({ connectionString: ownerDatabaseUrl(), max: 6 });
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

// ── the data node, over the same mTLS path the worker uses ──────────────────
const tls = {
  ca: readFileSync(join(CERT_DIR, 'ca.pem')),
  cert: readFileSync(join(CERT_DIR, 'cert.pem')),
  key: readFileSync(join(CERT_DIR, 'key.pem')),
  checkServerIdentity: () => undefined,
};
function nodeApi<T>(path: string): Promise<T> {
  return new Promise((res, rej) => {
    const req = httpsRequest(
      { host: DOCKER_HOST, port: DOCKER_PORT, path, method: 'GET', timeout: 15_000, ...tls },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((r.statusCode ?? 0) >= 300) return rej(new Error(`${path} → ${r.statusCode}: ${text}`));
          res(JSON.parse(text) as T);
        });
      });
    req.on('error', rej);
    req.end();
  });
}
const listContainers = () => nodeApi<Array<{ Names: string[]; State: string }>>(
  '/containers/json?all=true');
const listVolumes = () => nodeApi<{ Volumes: Array<{ Name: string }> | null }>('/volumes');

// ── worker process control ─────────────────────────────────────────────────
class WorkerProc {
  private child: ChildProcess | undefined;
  readonly lines: string[] = [];
  /** Arrival time of each line relative to this process starting. */
  readonly timeline: Array<{ ms: number; line: string }> = [];
  private startedAt = 0;
  private watchers: Array<(line: string) => void> = [];

  start(): void {
    this.startedAt = Date.now();
    const child = spawn('node', ['--experimental-strip-types', 'src/main.ts'], {
      cwd: join(ROOT, 'services/worker'), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (buf: Buffer) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        this.lines.push(line);
        this.timeline.push({ ms: Date.now() - this.startedAt, line });
        for (const w of this.watchers) w(line);
      }
    };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    this.child = child;
  }

  /** Resolves on the first line satisfying `match`, then optionally kills. */
  onLine(match: (line: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.watchers = this.watchers.filter((w) => w !== watcher);
        rej(new Error(`no matching log line within ${timeoutMs}ms`));
      }, timeoutMs);
      const watcher = (line: string) => {
        if (!match(line)) return;
        clearTimeout(timer);
        this.watchers = this.watchers.filter((w) => w !== watcher);
        res(line);
      };
      this.watchers.push(watcher);
      // a matching line may already have arrived
      const already = this.lines.find(match);
      if (already) { clearTimeout(timer); this.watchers = this.watchers.filter((w) => w !== watcher); res(already); }
    });
  }

  kill(): void { this.child?.kill('SIGKILL'); }
  stop(): void { this.child?.kill('SIGTERM'); }
  get pid(): number | undefined { return this.child?.pid; }
  async waitReady(): Promise<void> {
    await this.onLine((l) => l.includes('worker started'), 60_000);
  }
}

let api: ChildProcess;
const apiLines: string[] = [];

async function startApi(): Promise<void> {
  api = spawn('node', ['--experimental-strip-types', 'src/main.ts'], {
    cwd: join(ROOT, 'services/api'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) apiLines.push(l); };
  api.stdout!.on('data', keep);
  api.stderr!.on('data', keep);
  const until = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return; } catch { /* not yet */ }
    if (Date.now() > until) throw new Error('api never became healthy:\n' + apiLines.slice(-10).join('\n'));
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── invariants ─────────────────────────────────────────────────────────────
interface Invariants {
  ok: boolean;
  problems: string[];
  containers: number;
  volumes: number;
  placements: number;
  secrets: number;
  bookedMb: number;
  status: string;
  usable: boolean;
}

async function checkInvariants(ref: string, projectId: string): Promise<Invariants> {
  const problems: string[] = [];

  const containers = (await listContainers())
    .filter((c) => c.Names.some((n) => n === `/cb-${ref}`)).length;
  const volumes = ((await listVolumes()).Volumes ?? [])
    .filter((v) => v.Name === `cb-${ref}-pgdata`).length;

  const { rows } = await pool.query<{
    placements: number; secrets: number; booked: number; status: string;
    port: number | null; container_id: string | null; conn_host: string | null;
    secret_versions: number; secret_names: number;
  }>(`SELECT (SELECT count(*)::int FROM project_databases WHERE project_id = $1) AS placements,
             (SELECT count(*)::int FROM project_secrets
               WHERE project_id = $1 AND state = 'active') AS secrets,
             (SELECT count(DISTINCT name)::int FROM project_secrets
               WHERE project_id = $1 AND state = 'active') AS secret_names,
             (SELECT count(*)::int FROM project_secrets WHERE project_id = $1) AS secret_versions,
             (SELECT ram_reserved_mb FROM nodes ORDER BY created_at LIMIT 1) AS booked,
             (SELECT status::text FROM projects WHERE id = $1) AS status,
             (SELECT port FROM project_databases WHERE project_id = $1) AS port,
             (SELECT container_id FROM project_databases WHERE project_id = $1) AS container_id,
             (SELECT connection_host FROM project_databases WHERE project_id = $1) AS conn_host`,
    [projectId]);
  const r = rows[0]!;

  if (containers !== 1) problems.push(`${containers} containers named cb-${ref} (want 1)`);
  if (volumes !== 1) problems.push(`${volumes} volumes named cb-${ref}-pgdata (want 1)`);
  if (r.placements !== 1) problems.push(`${r.placements} project_databases rows (want 1)`);
  // Duplication, not a total. This checked for exactly 3 — the number a project
  // had at Milestone 0 — and a project now legitimately carries 11: the pooler's
  // own credential (P2b), the signing keypair and both API keys (P1e), the repo
  // cipher-pass (P3a) and the auth role's password (P4a). The count was never the
  // property; the property is that a resumed saga did not regenerate a password
  // it had already stored, and that is a *duplicate* — which `count(*)` against
  // `count(DISTINCT name)` catches whatever the fleet's credential set grows to.
  //
  // Same lesson as D-350: assert what the mechanism guarantees, not the number
  // some version of it happened to produce.
  if (r.secrets === 0) problems.push('no active credentials at all');
  if (r.secrets !== r.secret_names) {
    problems.push(`${r.secrets} active credentials for ${r.secret_names} distinct names ` +
      '— a second active row for one name means a regenerated password');
  }
  if (r.secret_versions !== r.secrets) {
    problems.push(`${r.secret_versions} credential rows for ${r.secrets} active ` +
      '— an extra version means a credential was stored twice (store-then-apply ran twice)');
  }
  // One Free project booked exactly once. A double-booking is the failure mode
  // that silently shrinks the node's capacity for every future project.
  if (r.booked !== 350) problems.push(`node booked ${r.booked} MB (want 350 for one Free project)`);
  if (r.status !== 'ready') problems.push(`project status is ${r.status} (want ready)`);
  if (!r.container_id) problems.push('no container_id recorded');
  if (!r.conn_host) problems.push('no connection_host recorded');

  // The database itself must work on the credential the API would hand out.
  let usable = false;
  const detail = await fetch(`http://127.0.0.1:${PORT}/v1/projects/${ref}?reveal=true`, { headers: auth })
    .then((res) => res.json() as Promise<{ database?: { connection_strings?: { direct: string } } }>);
  const url = detail.database?.connection_strings?.direct;
  if (!url) {
    problems.push('the API returns no connection string');
  } else {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 8_000 });
    try {
      await c.connect();
      await c.query('create table if not exists km (id serial primary key)');
      await c.query('insert into km default values');
      usable = ((await c.query('select id from km')).rowCount ?? 0) > 0;
      if (!usable) problems.push('the database accepted a connection but returned no row');
    } catch (err) {
      problems.push(`cannot use the database: ${(err as Error).message}`);
    } finally {
      await c.end().catch(() => {});
    }
  }

  return {
    ok: problems.length === 0, problems, containers, volumes,
    placements: r.placements, secrets: r.secrets, bookedMb: r.booked,
    status: r.status, usable,
  };
}

// ── scenario execution ─────────────────────────────────────────────────────
type Kind = 'boundary' | 'mid-step';
interface Scenario { name: string; kind: Kind; match: (line: string) => boolean }

const boundary = (step: string): Scenario => ({
  name: step, kind: 'boundary',
  match: (l) => l.includes('"step complete"') && l.includes(`"step":"${step}"`),
});
const midStep = (step: string, marker: string, label: string): Scenario => ({
  name: label, kind: 'mid-step',
  match: (l) => l.includes(marker) && l.includes(`"step":"${step}"`),
});

const SCENARIOS: Scenario[] = [
  boundary('allocate_node'),
  boundary('create_volume'),
  boundary('start_container'),
  boundary('wait_healthy'),
  boundary('create_base_roles'),
  boundary('store_credentials'),
  boundary('write_connection'),
  // The windows with no checkpoint to fall back on.
  midStep('start_container', 'container created', 'start_container/after-create'),
  midStep('start_container', 'container started', 'start_container/after-start'),
  midStep('store_credentials', 'credentials persisted', 'store_credentials/after-persist'),
  midStep('wait_healthy', 'database accepting connections', 'wait_healthy/after-probe'),
];

/** Memoised: one lookup per run, not one per project. See bench/staging-env.mts. */
let cachedOrgId: string | undefined;
const bootstrapOrg = async () =>
  (cachedOrgId ??= await bootstrapOrgId(`http://127.0.0.1:${PORT}`, auth));

async function resetWorld(): Promise<void> {
  await pool.query(
    'truncate provisioning_jobs, project_secrets, project_databases, projects, nodes cascade');
  // Redis too: a leftover delivery for a truncated row would be dropped by the
  // runner ("no row of record"), which is correct but muddies the measurement.
  const { createRedis, createQueue } = await import('@corebase/queue');
  const redis = createRedis(env.CB_REDIS_URL!);
  const q = createQueue(redis);
  await q.obliterate({ force: true }).catch(() => {});
  await q.close(); await redis.quit();

  for (const c of await listContainers()) {
    if (!c.Names.some((n) => n.startsWith('/cb-'))) continue;
    const name = c.Names[0]!.slice(1);
    await new Promise<void>((res) => {
      const req = httpsRequest({ host: DOCKER_HOST, port: DOCKER_PORT, method: 'DELETE',
        path: `/containers/${name}?force=1&v=0`, ...tls }, (r) => { r.resume(); r.on('end', () => res()); });
      req.on('error', () => res()); req.end();
    });
  }
  for (const v of (await listVolumes()).Volumes ?? []) {
    if (!v.Name.startsWith('cb-')) continue;
    await new Promise<void>((res) => {
      const req = httpsRequest({ host: DOCKER_HOST, port: DOCKER_PORT, method: 'DELETE',
        path: `/volumes/${v.Name}`, ...tls }, (r) => { r.resume(); r.on('end', () => res()); });
      req.on('error', () => res()); req.end();
    });
  }
}

interface Result {
  scenario: string; kind: Kind; killed: boolean; convergeMs: number | null;
  resumedSteps: string[]; inv: Invariants | null; error?: string;
}

async function runScenario(sc: Scenario, i: number, total: number): Promise<Result> {
  process.stdout.write(`  ${String(i).padStart(2)}/${total}  ${sc.name.padEnd(34)} `);
  await resetWorld();

  const w1 = new WorkerProc();
  w1.start();
  await w1.waitReady();

  const res = await fetch(`http://127.0.0.1:${PORT}/v1/projects`, {
    method: 'POST', headers: { ...auth, 'idempotency-key': `km-${Date.now()}-${i}` },
    // `org_id` named explicitly. Omitting it works only while the bootstrap user
    // belongs to exactly one organization, and the API refuses to guess when
    // there are several — correctly, since picking one silently is how a project
    // lands in the wrong org. That made this drill depend on global state it does
    // not own: any earlier suite that creates an org (P1d's do) breaks every
    // scenario with a message about the worker.
    body: JSON.stringify({
      name: `km-${Date.now()}-${i}`, region: 'eu-central', org_id: await bootstrapOrg() }),
  });
  const body = await res.text();
  // Checked, and it was not. An unchecked status here destroyed four nights of
  // this drill: a rejected create left `ref` and `projectId` as `undefined`, the
  // scenario carried on, and the worker — correctly having nothing to do — was
  // reported as "never reached the kill point". The diagnosis pointed at the one
  // component that was working.
  if (!res.ok) {
    throw new Error(
      `the API refused to create the project (${res.status}): ${body}\n` +
      'Every scenario depends on this, so the drill stops here rather than ' +
      'reporting eleven mysterious worker failures.');
  }
  // `{project: {...}, job: {...}}`, not a flat object. The drill destructured
  // `{ref, id}` from the top level, which has been `undefined` since P1d wrapped
  // the response — so every convergence check polled for a project whose ref it
  // never captured, and reported "DID NOT CONVERGE" while provisioning was
  // succeeding perfectly. That is what four nights of nightly failures were.
  //
  // The ids are prefixed (`prj_…`), and the database column is not, so the
  // prefix comes off here. Reaching into the database with a prefixed id
  // silently matches nothing, which is the same failure one layer down.
  const parsed = JSON.parse(body) as { project?: { id?: string; ref?: string } };
  const ref = parsed.project?.ref;
  const projectId = parsed.project?.id?.replace(/^prj_/, '');
  if (!ref || !projectId) {
    throw new Error(`the API accepted the create but returned no project ref/id: ${body}`);
  }

  // Wait for the chosen moment, then kill with no warning at all.
  let killed = false;
  try {
    await w1.onLine(sc.match, 90_000);
    w1.kill();
    killed = true;
  } catch (err) {
    // Print what the worker actually said. This path held the entire log in
    // `w1.lines` and reported only "no matching log line within 90000ms", which
    // is the least useful true statement available: the whole question is *what
    // it did instead*, and the answer was already in memory. Four nightly runs
    // failed here with nothing to go on.
    const tail = w1.lines.slice(-25);
    console.log(`\n        the worker's last ${tail.length} lines before giving up:`);
    for (const l of tail) console.log(`        ${l}`);
    if (!tail.length) console.log('        (the worker printed nothing at all)');
    w1.kill();
    return { scenario: sc.name, kind: sc.kind, killed: false, convergeMs: null,
      resumedSteps: [], inv: null, error: `never reached the kill point: ${(err as Error).message}` };
  }
  // Give the OS a moment to actually reap it, so the restart is a genuine restart.
  await new Promise((r) => setTimeout(r, 300));

  const t0 = Date.now();
  const w2 = new WorkerProc();
  w2.start();
  await w2.waitReady();

  // Converged = the project is ready. Everything else is asserted afterwards.
  let convergeMs: number | null = null;
  const until = Date.now() + CONVERGE_BUDGET_MS;
  for (;;) {
    const { rows } = await pool.query<{ status: string }>(
      'select status::text as status from projects where id = $1', [projectId]);
    if (rows[0]?.status === 'ready') { convergeMs = Date.now() - t0; break; }
    if (Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const resumedSteps = w2.lines
    .filter((l) => l.includes('"step complete"'))
    .map((l) => { try { return (JSON.parse(l) as { step: string }).step; } catch { return ''; } })
    .filter(Boolean);

  const inv = convergeMs === null ? null : await checkInvariants(ref, projectId);
  w2.stop();
  await new Promise((r) => setTimeout(r, 200));

  if (convergeMs === null) {
    console.log(`DID NOT CONVERGE in ${CONVERGE_BUDGET_MS / 1000}s`);
    // The *whole* replacement worker's log, and the job row. Four lines was a
    // window onto the last two seconds of a two-minute failure — enough to see
    // that something was wrong and never enough to see what, which is how this
    // stayed unexplained across four nightly runs.
    console.log(`        replacement worker (${w2.lines.length} lines):`);
    for (const l of w2.lines) console.log(`        ${l}`);
    const { rows: job } = await pool.query(
      `select id, state, attempts, max_attempts, last_error,
              checkpoint, heartbeat_at, started_at
         from provisioning_jobs where project_id = $1`, [projectId]);
    console.log(`        job row: ${JSON.stringify(job[0] ?? null)}`);
    const { rows: proj } = await pool.query(
      `select status from projects where id = $1`, [projectId]);
    console.log(`        project status: ${JSON.stringify(proj[0] ?? null)}`);
    return { scenario: sc.name, kind: sc.kind, killed, convergeMs: null, resumedSteps, inv: null,
      error: `no convergence within ${CONVERGE_BUDGET_MS}ms` };
  }
  if (!inv!.ok) {
    console.log(`CONVERGED in ${(convergeMs / 1000).toFixed(1)}s but INVARIANTS FAILED`);
    for (const p of inv!.problems) console.log(`        ✗ ${p}`);
  } else {
    console.log(`ok  resumed in ${(convergeMs / 1000).toFixed(1)}s  ` +
      `(re-ran ${resumedSteps.length} step${resumedSteps.length === 1 ? '' : 's'})`);
  }
  if (process.env.CB_KM_TIMELINE) {
    // What the restarted worker did, and when. The gap before the first claim is
    // the recovery latency, and it is the number worth watching.
    for (const t of w2.timeline) {
      let msg = t.line;
      try { const o = JSON.parse(t.line) as Record<string, unknown>;
        msg = `${o['msg']}${o['step'] ? ' [' + String(o['step']) + ']' : ''}`; } catch { /* raw */ }
      console.log(`        +${String(t.ms).padStart(6)}ms  ${msg}`);
    }
  }
  return { scenario: sc.name, kind: sc.kind, killed, convergeMs, resumedSteps, inv };
}

async function main() {
  const only = process.env.CB_KM_ONLY;
  const scenarios = only ? SCENARIOS.filter((s) => s.name.includes(only)) : SCENARIOS;
  if (scenarios.length === 0) throw new Error(`CB_KM_ONLY=${only} matched no scenario`);

  console.log(`▸ T6 — kill matrix: SIGKILL at ${scenarios.length} points in the provisioning saga\n`);
  await startApi();

  const results: Result[] = [];
  for (const [i, sc] of scenarios.entries()) {
    results.push(await runScenario(sc, i + 1, scenarios.length));
  }

  const passed = results.filter((r) => r.inv?.ok);
  const times = passed.map((r) => r.convergeMs!).sort((a, b) => a - b);
  console.log('\n▸ summary');
  console.log(`  converged with all invariants held   ${passed.length}/${results.length}`);
  if (times.length) {
    console.log(`  resume time  min ${times[0]}ms  p50 ${times[Math.floor(times.length / 2)]}ms  max ${times.at(-1)}ms`);
  }
  for (const r of results.filter((x) => !x.inv?.ok)) {
    console.log(`  ✗ ${r.scenario}: ${r.error ?? r.inv?.problems.join('; ')}`);
  }

  api.kill('SIGTERM');
  await pool.end();
  const pass = passed.length === results.length;
  console.log(pass
    ? `\n▸ T6 PASS — every kill point converges with zero duplicates`
    : `\n▸ T6 FAIL — ${results.length - passed.length} kill point(s) do not converge cleanly`);
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try { api?.kill('SIGKILL'); await pool.end(); } catch { /* shutting down */ }
  process.exit(1);
});
