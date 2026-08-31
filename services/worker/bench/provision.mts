/**
 * Milestone 0 · T5f — the done-signal for T5: "20 consecutive creates <60s each".
 *
 * This is a measurement, not a test, so it lives outside the test run: it starts
 * the real API and the real worker as child processes, drives them over HTTP the
 * way a customer would, and reports numbers.
 *
 * A create only counts if the database it produced is actually usable. Timing
 * POST→status:ready would measure the control plane telling itself it is done;
 * every create here ends with a connection to the project on the credentials the
 * API handed back, and a statement that returns a row.
 *
 * Usage (from the repo root, staging up and migrated):
 *   pnpm --filter @corebase/worker bench
 *   CB_BENCH_COUNT=5 pnpm --filter @corebase/worker bench
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const ROOT = resolve(import.meta.dirname, '../../..');
const COUNT = Number(process.env.CB_BENCH_COUNT ?? 20);
const BUDGET_MS = Number(process.env.CB_BENCH_BUDGET_MS ?? 60_000);
const PORT = Number(process.env.CB_BENCH_API_PORT ?? 8098);
const TOKEN = 'bench-token';
const OUT_DIR = process.env.CB_BENCH_OUT ?? join(ROOT, 'docs/14-roadmap/measurements');

const env = {
  ...process.env,
  CB_CONTROL_DATABASE_URL: process.env.CB_CONTROL_DATABASE_URL
    ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control',
  CB_REDIS_URL: process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379',
  CB_DOCKER_HOST: process.env.CB_DOCKER_HOST ?? '127.0.0.1',
  CB_DOCKER_PORT: process.env.CB_DOCKER_PORT ?? '2376',
  CB_DOCKER_CERT_DIR: process.env.CB_DOCKER_CERT_DIR ?? join(ROOT, 'infra/docker/staging/certs'),
  CB_KEK_DIR: process.env.CB_KEK_DIR ?? join(ROOT, 'infra/docker/staging/kek.d'),
  CB_BOOTSTRAP_SECRET: process.env.CB_BOOTSTRAP_SECRET ?? 'bench-bootstrap-secret-0123456789',
  CB_PROJECT_DOMAIN: process.env.CB_PROJECT_DOMAIN ?? 'localhost',
  CB_PG_PORT_MIN: process.env.CB_PG_PORT_MIN ?? '5433',
  CB_PG_PORT_MAX: process.env.CB_PG_PORT_MAX ?? '5462',
  // The local node is declared larger than the 4 GB default so twenty Free
  // projects (350 MB booked each, D-174) sit well under the 85% fill ceiling
  // (D-090) — a capacity refusal would be a correct outcome measuring the wrong
  // thing. Real Free-tier nodes are 32–64 GB.
  CB_NODE_RAM_MB: process.env.CB_NODE_RAM_MB ?? '16384',
  CB_NODE_HOSTNAME: process.env.CB_NODE_HOSTNAME ?? 'data-1',
  CB_STATIC_TOKEN: TOKEN,
  PORT: String(PORT),
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

function stopAll() {
  for (const c of children) c.kill('SIGTERM');
}

/**
 * Wait until the worker is actually consuming, not merely spawned.
 *
 * Without this the first create absorbs the worker's startup — module loading,
 * the Engine API handshake, node registration — and reports it as provisioning
 * latency. It showed up as a single 10.6s outlier in an otherwise 2.5s run, which
 * is exactly the kind of number that gets quoted out of context later.
 */
async function waitForWorker(deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (logLines.worker!.some((l) => l.includes('node registered'))) return;
    if (Date.now() > until) {
      console.error('worker log:\n' + logLines.worker!.slice(-15).join('\n'));
      throw new Error('the worker never registered its node');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitForHealth(deadlineMs = 30_000) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > until) {
      console.error('api log:\n' + logLines.api!.slice(-15).join('\n'));
      throw new Error('the API never became healthy');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

interface Detail {
  project: { ref: string; status: string };
  database?: {
    host: string; port: number;
    connection_strings?: { direct: string; pooled: string };
  };
}

async function createProject(i: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/projects`, {
    method: 'POST',
    headers: { ...auth, 'idempotency-key': `bench-${process.pid}-${String(i).padStart(3, '0')}` },
    body: JSON.stringify({ name: `bench-${process.pid}-${i}`, region: 'eu-central' }),
  });
  if (res.status !== 202) throw new Error(`create returned ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { ref: string }).ref;
}

async function pollReady(ref: string, budgetMs: number): Promise<Detail> {
  const until = Date.now() + budgetMs;
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/projects/${ref}`, { headers: auth });
    const detail = (await res.json()) as Detail;
    if (detail.project.status === 'ready') return detail;
    if (detail.project.status === 'failed') throw new Error(`project ${ref} failed`);
    if (Date.now() > until) {
      throw new Error(`project ${ref} still ${detail.project.status} after ${budgetMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** A create counts only if the database it produced answers on the credentials given. */
async function proveUsable(detail: Detail): Promise<{ rows: number }> {
  const url = detail.database?.connection_strings?.direct;
  if (!url) throw new Error(`project ${detail.project.ref} is ready with no connection string`);
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  await c.connect();
  try {
    await c.query('create table bench (id serial primary key, note text)');
    await c.query(`insert into bench (note) values ('t5f')`);
    const r = await c.query('select id, note from bench');
    return { rows: r.rowCount ?? 0 };
  } finally {
    await c.end();
  }
}

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

/**
 * Attribute the total to individual saga steps by reading the worker's own
 * per-step duration logs. Without this, an occasional slow create is folklore;
 * with it, it has a name.
 */
function stepBreakdown(): Array<{ step: string; n: number; p50: number; max: number }> {
  const byStep = new Map<string, number[]>();
  for (const line of logLines.worker!) {
    if (!line.includes('"step complete"')) continue;
    try {
      const o = JSON.parse(line) as { step?: string; ms?: number };
      if (!o.step || typeof o.ms !== 'number') continue;
      const arr = byStep.get(o.step) ?? [];
      arr.push(o.ms);
      byStep.set(o.step, arr);
    } catch { /* not a JSON line */ }
  }
  return [...byStep].map(([step, ms]) => {
    const sorted = [...ms].sort((a, b) => a - b);
    return { step, n: sorted.length, p50: pct(sorted, 50), max: sorted.at(-1)! };
  });
}

async function main() {
  console.log(`▸ T5f — ${COUNT} consecutive creates, budget ${BUDGET_MS / 1000}s each\n`);
  start('api');
  start('worker');
  await waitForHealth();
  await waitForWorker();
  // One throwaway create so the measured runs share a warm engine and a warm
  // page cache for the image layers. Reported separately, never averaged in: it
  // is a different thing being measured.
  const warmT0 = Date.now();
  const warmRef = await createProject(0);
  await pollReady(warmRef, BUDGET_MS);
  const warmupMs = Date.now() - warmT0;
  console.log(`  warm-up  ${warmRef}  ready ${warmupMs}ms (reported, not averaged in)\n`);

  const results: Array<{ i: number; ref: string; ms: number; usableMs: number; rows: number }> = [];
  let failed = 0;

  for (let i = 1; i <= COUNT; i++) {
    const t0 = Date.now();
    try {
      const ref = await createProject(i);
      const detail = await pollReady(ref, BUDGET_MS);
      const readyMs = Date.now() - t0;
      const t1 = Date.now();
      const { rows } = await proveUsable(detail);
      const usableMs = Date.now() - t1;
      results.push({ i, ref, ms: readyMs, usableMs, rows });
      const flag = readyMs > BUDGET_MS ? ' OVER BUDGET' : '';
      console.log(
        `  ${String(i).padStart(2)}/${COUNT}  ${ref}  ready ${String(readyMs).padStart(6)}ms  ` +
        `+usable ${String(usableMs).padStart(5)}ms  ${rows} row${rows === 1 ? '' : 's'}${flag}`);
    } catch (err) {
      failed++;
      console.log(`  ${String(i).padStart(2)}/${COUNT}  FAILED: ${(err as Error).message}`);
      console.error('    worker log tail:\n      ' + logLines.worker!.slice(-6).join('\n      '));
    }
  }

  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const over = results.filter((r) => r.ms > BUDGET_MS);
  const summary = {
    at: new Date().toISOString(),
    count: COUNT,
    warmup_ms: warmupMs,
    succeeded: results.length,
    failed,
    budget_ms: BUDGET_MS,
    over_budget: over.length,
    min_ms: times[0] ?? null,
    p50_ms: times.length ? pct(times, 50) : null,
    p95_ms: times.length ? pct(times, 95) : null,
    max_ms: times.at(-1) ?? null,
    mean_ms: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    usable_p50_ms: results.length
      ? pct(results.map((r) => r.usableMs).sort((a, b) => a - b), 50) : null,
    steps: stepBreakdown(),
    per_create: results.map((r) => ({ ref: r.ref, ready_ms: r.ms, usable_ms: r.usableMs })),
  };

  console.log('\n▸ summary');
  console.log(`  succeeded            ${summary.succeeded}/${COUNT}`);
  console.log(`  min / p50 / p95 / max  ${summary.min_ms} / ${summary.p50_ms} / ${summary.p95_ms} / ${summary.max_ms} ms`);
  console.log(`  over budget (${BUDGET_MS}ms)  ${summary.over_budget}`);
  console.log('\n▸ where the time goes (per saga step, all runs)');
  for (const st of summary.steps.sort((a, b) => b.p50 - a.p50)) {
    console.log(`  ${st.step.padEnd(18)} n=${String(st.n).padStart(3)}  p50 ${String(st.p50).padStart(5)}ms  max ${String(st.max).padStart(6)}ms`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, 'm-002-provisioning.json');
  writeFileSync(file, JSON.stringify(summary, null, 2) + '\n');
  console.log(`  raw numbers written to ${file.replace(ROOT + '/', '')}`);

  stopAll();
  const pass = failed === 0 && over.length === 0 && results.length === COUNT;
  console.log(pass
    ? `\n▸ T5f PASS — ${COUNT}/${COUNT} creates ready and usable, none over ${BUDGET_MS / 1000}s`
    : `\n▸ T5f FAIL — ${failed} failed, ${over.length} over budget`);
  process.exit(pass ? 0 : 1);
}

process.on('SIGINT', () => { stopAll(); process.exit(130); });
main().catch((err) => {
  console.error(err);
  stopAll();
  process.exit(1);
});
