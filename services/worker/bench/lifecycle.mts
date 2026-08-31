/**
 * Milestone 0 · T7 — the done-signal: "create+delete loop ×20 leaves node and
 * control plane clean (asserted by listing Docker + volumes)".
 *
 * Runs the whole lifecycle through the real HTTP API and the real worker:
 *
 *   POST /v1/projects → ready → use it → DELETE → soft_deleted → purge → deleted
 *
 * The purge is normally days later (D-038's 7-day window), so the loop runs with
 * a one-second window rather than by calling the purge saga directly — the
 * scheduled path is the one that has to work, and a harness that bypasses the
 * scan would not exercise it.
 *
 * The assertion that matters is at the end and is about *residue*: nothing named
 * `cb-*` left on the node, and a control plane whose reserved RAM is back to
 * zero. A capacity leak of 350 MB per deleted project is invisible until a node
 * refuses to place work it has room for.
 *
 * Usage (staging up, migrated, image seeded):
 *   pnpm --filter @corebase/worker lifecycle
 *   CB_LC_COUNT=3 pnpm --filter @corebase/worker lifecycle
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { Pool, Client } from 'pg';

const ROOT = resolve(import.meta.dirname, '../../..');
const COUNT = Number(process.env.CB_LC_COUNT ?? 20);
const PORT = Number(process.env.CB_LC_API_PORT ?? 8096);
const TOKEN = 'lc-token';
const STEP_BUDGET_MS = Number(process.env.CB_LC_BUDGET_MS ?? 90_000);
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR ?? join(ROOT, 'infra/docker/staging/certs');
const DOCKER_HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const DOCKER_PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);

const env = {
  ...process.env,
  CB_CONTROL_DATABASE_URL: process.env.CB_CONTROL_DATABASE_URL
    ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control',
  CB_REDIS_URL: process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379',
  CB_DOCKER_HOST: DOCKER_HOST,
  CB_DOCKER_PORT: String(DOCKER_PORT),
  CB_DOCKER_CERT_DIR: CERT_DIR,
  CB_KEK_DIR: process.env.CB_KEK_DIR ?? join(ROOT, 'infra/docker/staging/kek.d'),
  CB_BOOTSTRAP_SECRET: process.env.CB_BOOTSTRAP_SECRET ?? 'lc-bootstrap-secret-0123456789',
  CB_PROJECT_DOMAIN: process.env.CB_PROJECT_DOMAIN ?? 'localhost',
  CB_PG_PORT_MIN: process.env.CB_PG_PORT_MIN ?? '5433',
  CB_PG_PORT_MAX: process.env.CB_PG_PORT_MAX ?? '5462',
  CB_NODE_RAM_MB: process.env.CB_NODE_RAM_MB ?? '16384',
  CB_NODE_HOSTNAME: 'data-1',
  CB_STATIC_TOKEN: TOKEN,
  PORT: String(PORT),
  // Its own metrics port: a harness must not fight a worker someone is already
  // running from scripts/dev.sh for the same port.
  CB_METRICS_PORT: process.env.CB_METRICS_PORT ?? '9112',
  // The recovery window, compressed. Everything else about the purge path — the
  // scan, the job row, the verify_purgeable guard — runs exactly as it would
  // after seven real days.
  CB_SOFT_DELETE_WINDOW: process.env.CB_SOFT_DELETE_WINDOW ?? '1 second',
  CB_PURGE_SCAN_MS: process.env.CB_PURGE_SCAN_MS ?? '2000',
};

const pool = new Pool({ connectionString: env.CB_CONTROL_DATABASE_URL, max: 6 });
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

const tls = {
  ca: readFileSync(join(CERT_DIR, 'ca.pem')),
  cert: readFileSync(join(CERT_DIR, 'cert.pem')),
  key: readFileSync(join(CERT_DIR, 'key.pem')),
  checkServerIdentity: () => undefined,
};
function nodeApi<T>(path: string, method = 'GET'): Promise<T> {
  return new Promise((res, rej) => {
    const req = httpsRequest({ host: DOCKER_HOST, port: DOCKER_PORT, path, method, timeout: 20_000, ...tls },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((r.statusCode ?? 0) >= 300) return rej(new Error(`${path} → ${r.statusCode}: ${text}`));
          res((text ? JSON.parse(text) : undefined) as T);
        });
      });
    req.on('error', rej);
    req.end();
  });
}
const nodeContainers = () => nodeApi<Array<{ Names: string[]; State: string }>>('/containers/json?all=true');
const nodeVolumes = () => nodeApi<{ Volumes: Array<{ Name: string }> | null }>('/volumes');

const children: ChildProcess[] = [];
const logs: Record<string, string[]> = { api: [], worker: [] };

function start(name: 'api' | 'worker'): void {
  const child = spawn('node', ['--experimental-strip-types', 'src/main.ts'], {
    cwd: join(ROOT, 'services', name), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) logs[name]!.push(l); };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  children.push(child);
}
const stopAll = () => { for (const c of children) c.kill('SIGTERM'); };

async function waitFor(what: string, ok: () => Promise<boolean>, budgetMs = STEP_BUDGET_MS) {
  const until = Date.now() + budgetMs;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > until) throw new Error(`${what} did not happen within ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const statusOf = async (ref: string): Promise<string> => {
  const { rows } = await pool.query<{ status: string }>(
    'select status::text as status from projects where ref = $1', [ref]);
  return rows[0]?.status ?? 'gone';
};

interface Cycle { i: number; ref: string; createMs: number; deleteMs: number; purgeMs: number }

async function oneCycle(i: number): Promise<Cycle> {
  const t0 = Date.now();
  const created = await fetch(`http://127.0.0.1:${PORT}/v1/projects`, {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': `lc-${process.pid}-${String(i).padStart(3, '0')}` },
    body: JSON.stringify({ name: `lc-${process.pid}-${i}`, region: 'eu-central' }),
  });
  if (created.status !== 202) throw new Error(`create returned ${created.status}: ${await created.text()}`);
  const { ref } = (await created.json()) as { ref: string };
  await waitFor(`${ref} ready`, async () => (await statusOf(ref)) === 'ready');
  const createMs = Date.now() - t0;

  // Prove it is a real database before deleting it, so a cycle that "worked"
  // cannot mean "created something broken and then removed it".
  const detail = await fetch(`http://127.0.0.1:${PORT}/v1/projects/${ref}`, { headers: auth })
    .then((r) => r.json() as Promise<{ database?: { connection_strings?: { direct: string } } }>);
  const url = detail.database?.connection_strings?.direct;
  if (!url) throw new Error(`${ref} is ready with no connection string`);
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try {
    await c.query('create table lc (id serial primary key)');
    await c.query('insert into lc default values');
  } finally { await c.end().catch(() => {}); }

  const t1 = Date.now();
  const deleted = await fetch(`http://127.0.0.1:${PORT}/v1/projects/${ref}`, {
    // No content-type: a bodyless request that claims to carry JSON is rejected,
    // and finding that out here is how the error handler's 4xx-as-500 bug
    // surfaced.
    method: 'DELETE', headers: { authorization: auth.authorization },
  });
  if (deleted.status !== 202) throw new Error(`delete returned ${deleted.status}: ${await deleted.text()}`);
  await waitFor(`${ref} soft_deleted`, async () => (await statusOf(ref)) === 'soft_deleted');
  const deleteMs = Date.now() - t1;

  // Now the scheduled path: the purge scan notices the closed window, writes the
  // job, and the worker runs it. Nothing here calls the purge saga directly.
  const t2 = Date.now();
  await waitFor(`${ref} purged`, async () => (await statusOf(ref)) === 'deleted');
  const purgeMs = Date.now() - t2;

  return { i, ref, createMs, deleteMs, purgeMs };
}

interface Residue { containers: string[]; volumes: string[]; bookedMb: number; secrets: number; placements: number }

async function residue(): Promise<Residue> {
  const containers = (await nodeContainers())
    .flatMap((c) => c.Names).filter((n) => n.startsWith('/cb-')).map((n) => n.slice(1));
  const volumes = ((await nodeVolumes()).Volumes ?? [])
    .map((v) => v.Name).filter((n) => n.startsWith('cb-'));
  const { rows } = await pool.query<{ bookedMb: number; secrets: number; placements: number }>(
    `SELECT COALESCE((SELECT sum(ram_reserved_mb)::int FROM nodes), 0) AS "bookedMb",
            (SELECT count(*)::int FROM project_secrets) AS secrets,
            (SELECT count(*)::int FROM project_databases) AS placements`);
  return { containers, volumes, ...rows[0]! };
}

async function main() {
  console.log(`▸ T7 — ${COUNT} create+delete cycles, then assert nothing is left behind\n`);

  await pool.query(
    'truncate provisioning_jobs, project_secrets, project_databases, projects, nodes cascade');
  for (const name of (await nodeContainers()).flatMap((c) => c.Names).filter((n) => n.startsWith('/cb-'))) {
    await nodeApi(`/containers/${name.slice(1)}?force=1&v=0`, 'DELETE').catch(() => {});
  }
  for (const v of ((await nodeVolumes()).Volumes ?? []).filter((x) => x.Name.startsWith('cb-'))) {
    await nodeApi(`/volumes/${v.Name}`, 'DELETE').catch(() => {});
  }

  start('api');
  start('worker');
  await waitFor('api healthy', async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; }
  }, 30_000);
  await waitFor('worker registered',
    async () => logs.worker!.some((l) => l.includes('worker started')), 60_000);

  const cycles: Cycle[] = [];
  let failed = 0;
  for (let i = 1; i <= COUNT; i++) {
    try {
      const c = await oneCycle(i);
      cycles.push(c);
      console.log(`  ${String(i).padStart(2)}/${COUNT}  ${c.ref}  ` +
        `create ${String(c.createMs).padStart(5)}ms  delete ${String(c.deleteMs).padStart(5)}ms  ` +
        `purge ${String(c.purgeMs).padStart(5)}ms`);
    } catch (err) {
      failed++;
      console.log(`  ${String(i).padStart(2)}/${COUNT}  FAILED: ${(err as Error).message}`);
      // Let the child's stderr land before snapshotting it; a log line written
      // after the HTTP response is easy to miss otherwise.
      await new Promise((r) => setTimeout(r, 500));
      console.error('    api log tail:\n      ' + logs.api!.slice(-12).join('\n      '));
      console.error('    worker log tail:\n      ' + logs.worker!.slice(-4).join('\n      '));
    }
  }

  const left = await residue();
  console.log('\n▸ residue after the loop');
  console.log(`  containers named cb-*        ${left.containers.length}`);
  console.log(`  volumes named cb-*           ${left.volumes.length}`);
  console.log(`  node RAM still booked        ${left.bookedMb} MB`);
  console.log(`  credential rows              ${left.secrets}`);
  console.log(`  placement rows               ${left.placements}`);
  if (left.containers.length) console.log(`  ✗ ${left.containers.slice(0, 5).join(', ')}`);
  if (left.volumes.length) console.log(`  ✗ ${left.volumes.slice(0, 5).join(', ')}`);

  const { rows: statuses } = await pool.query<{ status: string; n: number }>(
    `select status::text as status, count(*)::int as n from projects group by status order by status`);
  console.log(`  project statuses             ${statuses.map((r) => `${r.status}=${r.n}`).join(' ')}`);

  const clean = left.containers.length === 0 && left.volumes.length === 0
    && left.bookedMb === 0 && left.secrets === 0 && left.placements === 0;
  const allDeleted = statuses.length === 1 && statuses[0]?.status === 'deleted'
    && statuses[0]?.n === cycles.length;

  const summary = (label: string, arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return `${label} p50 ${s[Math.floor(s.length / 2)]}ms  max ${s.at(-1)}ms`;
  };
  if (cycles.length) {
    console.log('\n▸ timings');
    console.log(`  ${summary('create→ready  ', cycles.map((c) => c.createMs))}`);
    console.log(`  ${summary('delete→soft   ', cycles.map((c) => c.deleteMs))}`);
    console.log(`  ${summary('window→deleted', cycles.map((c) => c.purgeMs))}`);
  }

  stopAll();
  await pool.end();
  const pass = failed === 0 && clean && allDeleted && cycles.length === COUNT;
  console.log(pass
    ? `\n▸ T7 PASS — ${COUNT} cycles, node and control plane clean`
    : `\n▸ T7 FAIL — ${failed} cycle(s) failed; residue clean: ${clean}; all deleted: ${allDeleted}`);
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  stopAll();
  await pool.end().catch(() => {});
  process.exit(1);
});
