/**
 * Milestone 0 · T8 — the done-signal: "reboot the data node; all READY projects
 * come back without human action; an orphan container is detected and reported".
 *
 * This is the drill that cannot be faked by a unit test: the node genuinely goes
 * away and comes back, and nothing between the reboot and the assertion is
 * allowed to be a human.
 *
 * It proves two different things at once, and it is worth being clear about which
 * mechanism does which:
 *
 *   - Containers with a restart policy come back because *Docker* restarts them
 *     (D-173 is explicit that container crashes are the restart policy's job, not
 *     reconciliation's). The drill checks that the policy is actually doing it.
 *   - A container that does *not* come back — here, one deliberately removed
 *     while the node is down — is reconciliation's job, and the drill checks the
 *     sweep notices and repairs it with no human involved.
 *
 * Usage (staging up, migrated, image seeded):
 *   pnpm --filter @corebase/worker node-reboot
 *   CB_NR_COUNT=3 pnpm --filter @corebase/worker node-reboot
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { appDatabaseUrl, ownerDatabaseUrl } from './staging-env.mts';
import { Pool, Client } from 'pg';

const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../..');
const COUNT = Number(process.env.CB_NR_COUNT ?? 5);
const PORT = Number(process.env.CB_NR_API_PORT ?? 8094);
const TOKEN = 'nr-token';
const CONVERGE_MS = Number(process.env.CB_NR_CONVERGE_MS ?? 180_000);
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR ?? join(ROOT, 'infra/docker/staging/certs');
const DOCKER_HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const DOCKER_PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const NODE_CONTAINER = process.env.CB_NR_NODE_CONTAINER ?? 'cb-data-node';

const env = {
  ...process.env,
  // The services run as the least-privilege app role (P1b); this harness's own
  // queries below use the owner, because fixtures are admin work.
  CB_CONTROL_DATABASE_URL: appDatabaseUrl(ROOT),
  CB_REDIS_URL: process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379',
  CB_DOCKER_HOST: DOCKER_HOST,
  CB_DOCKER_PORT: String(DOCKER_PORT),
  CB_DOCKER_CERT_DIR: CERT_DIR,
  CB_KEK_DIR: process.env.CB_KEK_DIR ?? join(ROOT, 'infra/docker/staging/kek.d'),
  CB_BOOTSTRAP_SECRET: process.env.CB_BOOTSTRAP_SECRET ?? 'nr-bootstrap-secret-0123456789',
  CB_PROJECT_DOMAIN: process.env.CB_PROJECT_DOMAIN ?? 'localhost',
  CB_PG_PORT_MIN: process.env.CB_PG_PORT_MIN ?? '5433',
  CB_PG_PORT_MAX: process.env.CB_PG_PORT_MAX ?? '5462',
  CB_NODE_RAM_MB: process.env.CB_NODE_RAM_MB ?? '16384',
  CB_NODE_HOSTNAME: 'data-1',
  CB_STATIC_TOKEN: TOKEN,
  PORT: String(PORT),
  // Its own metrics port: a harness must not fight a worker someone is already
  // running from scripts/dev.sh for the same port.
  CB_METRICS_PORT: process.env.CB_METRICS_PORT ?? '9113',
  // Sweep fast so the drill finishes in a minute rather than five. The interval
  // is a policy number; what is under test is whether the sweep converges at all.
  CB_RECONCILE_INTERVAL_MS: process.env.CB_RECONCILE_INTERVAL_MS ?? '5000',
};

const pool = new Pool({ connectionString: ownerDatabaseUrl(), max: 6 });
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
const containers = () => nodeApi<Array<{ Id: string; Names: string[]; State: string; Labels: Record<string, string> }>>(
  '/containers/json?all=true');

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

async function waitFor(what: string, ok: () => Promise<boolean>, budgetMs = CONVERGE_MS) {
  const until = Date.now() + budgetMs;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > until) throw new Error(`${what} did not happen within ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Can this project actually serve a query right now? */
async function usable(ref: string): Promise<boolean> {
  const detail = await fetch(`http://127.0.0.1:${PORT}/v1/projects/${ref}`, { headers: auth })
    .then((r) => r.json() as Promise<{ database?: { connection_strings?: { direct: string } } }>)
    .catch(() => ({} as { database?: undefined }));
  const url = detail.database?.connection_strings?.direct;
  if (!url) return false;
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 4_000 });
  try {
    await c.connect();
    await c.query('select 1');
    return true;
  } catch { return false; } finally { await c.end().catch(() => {}); }
}

async function main() {
  console.log('▸ T8 — node reboot drill\n');

  await pool.query(
    'truncate provisioning_jobs, project_secrets, project_databases, projects, nodes cascade');
  for (const c of await containers()) {
    if (c.Names.some((n) => n.startsWith('/cb-'))) {
      await nodeApi(`/containers/${c.Id}?force=1&v=1`, 'DELETE').catch(() => {});
    }
  }
  // Volumes too, or the drift report is dominated by residue from previous runs
  // — which the reconciler is right to report, and which makes this run's output
  // unreadable.
  const stale = await nodeApi<{ Volumes: Array<{ Name: string }> | null }>('/volumes');
  for (const v of stale.Volumes ?? []) {
    if (v.Name.startsWith('cb-')) await nodeApi(`/volumes/${v.Name}`, 'DELETE').catch(() => {});
  }

  start('api');
  start('worker');
  await waitFor('api healthy', async () => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { return false; }
  }, 30_000);
  await waitFor('worker started',
    async () => logs.worker!.some((l) => l.includes('worker started')), 60_000);

  // ── 1. a fleet of ready projects ────────────────────────────────────────
  const refs: string[] = [];
  for (let i = 1; i <= COUNT; i++) {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/projects`, {
      method: 'POST',
      headers: { ...auth, 'idempotency-key': `nr-${process.pid}-${String(i).padStart(3, '0')}` },
      body: JSON.stringify({ name: `nr-${process.pid}-${i}`, region: 'eu-central' }),
    });
    const { project } = (await res.json()) as { project: { ref: string } };
    const ref = project.ref;
    refs.push(ref);
  }
  await waitFor(`${COUNT} projects ready`, async () => {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from projects where status = 'ready'`);
    return rows[0]!.n === COUNT;
  });
  console.log(`  ✓ ${COUNT} projects ready`);

  // Plant an orphan: a container whose project row is removed while the node is
  // down, so the sweep has something it must report and must NOT delete.
  const orphanRef = refs.pop()!;
  await pool.query(`delete from project_databases where project_id =
    (select id from projects where ref = $1)`, [orphanRef]);
  await pool.query(`delete from projects where ref = $1`, [orphanRef]);
  console.log(`  ✓ planted an orphan: ${orphanRef} (container kept, rows deleted)`);

  // And remove one container entirely, so something genuinely needs repairing
  // rather than merely restarting.
  const brokenRef = refs[0]!;
  const brokenContainer = (await containers()).find((c) => c.Names.includes(`/cb-${brokenRef}`))!;
  await nodeApi(`/containers/${brokenContainer.Id}?force=1&v=0`, 'DELETE');
  console.log(`  ✓ removed ${brokenRef}'s container (volume kept) — reconciliation must rebuild it`);

  // ── 2. reboot the node ───────────────────────────────────────────────────
  console.log(`\n  ▸ rebooting ${NODE_CONTAINER}`);
  const t0 = Date.now();
  await exec('docker', ['restart', NODE_CONTAINER]);
  await waitFor('node Engine API back', async () => {
    try { await containers(); return true; } catch { return false; }
  }, 120_000);
  console.log(`  ✓ node back after ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ── 3. converge, with no human ───────────────────────────────────────────
  const survivors = refs.filter((r) => r !== brokenRef);
  await waitFor('projects that had a restart policy came back on their own', async () => {
    const live = await containers();
    return survivors.every((r) =>
      live.find((c) => c.Names.includes(`/cb-${r}`))?.State === 'running');
  }, 120_000);
  console.log(`  ✓ ${survivors.length} container(s) restored by Docker's restart policy`);

  await waitFor(`${brokenRef} rebuilt by reconciliation`, async () => usable(brokenRef), CONVERGE_MS);
  const convergeMs = Date.now() - t0;
  console.log(`  ✓ ${brokenRef} rebuilt and serving queries (reconciliation, no human)`);

  for (const r of survivors) {
    if (!(await usable(r))) throw new Error(`${r} came back but does not answer queries`);
  }
  console.log(`  ✓ all ${survivors.length + 1} projects answer queries`);

  // ── 4. the orphan is reported and untouched ──────────────────────────────
  await waitFor('orphan reported', async () => {
    const { rows } = await pool.query<{ report: { drift: Array<{ class: string; ref?: string }> } }>(
      `select last_reconcile as report from nodes where hostname = 'data-1'`);
    return (rows[0]?.report.drift ?? []).some(
      (d) => d.class === 'orphan_container' && d.ref === orphanRef);
  }, 60_000);
  const stillThere = (await containers()).some((c) => c.Names.includes(`/cb-${orphanRef}`));
  console.log(`  ✓ orphan ${orphanRef} reported, and still present: ${stillThere}`);

  const alerts = logs.worker!.filter((l) => l.includes('orphan container')).length;
  console.log(`  ✓ ${alerts} operator alert(s) logged for it`);

  const { rows: final } = await pool.query<{
    report: { clean: boolean; drift: Array<{ class: string; ref?: string; action: string }> };
  }>(`select last_reconcile as report from nodes where hostname = 'data-1'`);
  console.log(`\n▸ last reconcile report: ${final[0]!.report.drift.length} drift item(s)`);
  for (const d of final[0]!.report.drift) {
    console.log(`    ${d.class.padEnd(22)} ${(d.ref ?? '—').padEnd(22)} ${d.action}`);
  }
  console.log(`▸ convergence after reboot: ${(convergeMs / 1000).toFixed(1)}s`);

  stopAll();
  await pool.end();
  const pass = stillThere && alerts > 0;
  console.log(pass
    ? '\n▸ T8 PASS — the node rebooted, every project came back without a human, and the orphan was reported rather than removed'
    : '\n▸ T8 FAIL');
  process.exit(pass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  console.error('worker log tail:\n  ' + logs.worker!.slice(-10).join('\n  '));
  stopAll();
  await pool.end().catch(() => {});
  process.exit(1);
});
