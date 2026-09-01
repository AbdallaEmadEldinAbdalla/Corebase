/**
 * Phase 2 · P2c — the measurement behind exit criterion 2.
 *
 * The criterion has two halves. "No data loss across 50 pause/resume cycles" is
 * asserted by `pause.e2e.test.ts`; this harness measures the other half, the one
 * with a number on it: **resume p50 < 5s, p95 < 15s**
 * ([provisioning §5](../../../docs/03-database-platform/01-postgres-provisioning.md)).
 *
 * It goes through the real HTTP API and the real worker, and it times the thing a
 * customer waits for: from `POST /v1/projects/:ref/resume` returning 202 to the
 * project reporting `ready`. Timing the saga directly would measure our code and
 * miss the queue hop, which is part of what the customer waits for.
 *
 * Usage (staging up, migrated, images seeded):
 *   pnpm --filter @corebase/worker pause-bench
 *   CB_PB_CYCLES=50 pnpm --filter @corebase/worker pause-bench
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { appDatabaseUrl } from './staging-env.mts';

const ROOT = resolve(import.meta.dirname, '../../..');
const CYCLES = Number(process.env.CB_PB_CYCLES ?? 20);
const PORT = Number(process.env.CB_PB_API_PORT ?? 8097);
const TOKEN = 'pb-token-harness-token-long-enough-for-the-boot-check';
const BUDGET_MS = Number(process.env.CB_PB_BUDGET_MS ?? 60_000);

const env = {
  ...process.env,
  CB_CONTROL_DATABASE_URL: appDatabaseUrl(ROOT),
  CB_REDIS_URL: process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379',
  CB_DOCKER_HOST: process.env.CB_DOCKER_HOST ?? '127.0.0.1',
  CB_DOCKER_PORT: process.env.CB_DOCKER_PORT ?? '2376',
  CB_DOCKER_CERT_DIR: process.env.CB_DOCKER_CERT_DIR ?? join(ROOT, 'infra/docker/staging/certs'),
  CB_KEK_DIR: process.env.CB_KEK_DIR ?? join(ROOT, 'infra/docker/staging/kek.d'),
  // The id is the key file's basename, which staging.sh generates as
  // kek_<year>_<month>. Hard-coding 'local' produced a startup crash naming the
  // keys it did have, which is exactly the diagnostic that made this a one-line fix.
  ...(process.env.CB_KEK_ID ? { CB_KEK_ID: process.env.CB_KEK_ID } : {}),
  CB_BOOTSTRAP_SECRET: process.env.CB_BOOTSTRAP_SECRET ?? 'bench-bootstrap-secret-0123456789',
  CB_STATIC_TOKEN: TOKEN,
  CB_PG_PORT_MIN: '5433', CB_PG_PORT_MAX: '5462',
  CB_POOLER_PORT_MIN: '6433', CB_POOLER_PORT_MAX: '6462',
  PORT: String(PORT),
  CB_METRICS_PORT: '9115',
  CB_PROJECT_DOMAIN: 'localhost',
};

const children: ChildProcess[] = [];
const start = (name: string, cwd: string, script: string) => {
  const c = spawn('node', ['--experimental-strip-types', script], {
    cwd: join(ROOT, cwd), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', (b) => { if (process.env.CB_PB_VERBOSE) process.stdout.write(`[${name}] ${b}`); });
  c.stderr.on('data', (b) => process.stderr.write(`[${name}] ${b}`));
  children.push(c);
  return c;
};
const stopAll = () => { for (const c of children) c.kill('SIGTERM'); };
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
               ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function waitFor(ref: string, want: string): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < BUDGET_MS) {
    const { body } = await api(`/v1/projects/${ref}`);
    if (body?.project?.status === want) return Date.now() - t0;
    if (body?.project?.status === 'failed') throw new Error(`project ${ref} failed`);
    await sleep(100);
  }
  throw new Error(`project ${ref} never reached ${want} within ${BUDGET_MS}ms`);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

async function main() {
  console.log(`▸ P2c pause/resume timing · ${CYCLES} cycles`);
  start('api', 'services/api', 'src/main.ts');
  start('worker', 'services/worker', 'src/main.ts');

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  // Resolve the organization rather than creating one (D-231). A fresh org would
  // not have the static token's user as a member, and the API is right to refuse —
  // which is exactly the failure this replaced.
  const orgList = await api('/v1/orgs');
  const orgs: Array<{ id: string; slug: string }> = orgList.body?.orgs ?? [];
  const org = orgs.find((o) => o.slug === 'dev') ?? orgs[0];
  if (!org) throw new Error(`no organization for this token: ${JSON.stringify(orgList.body)}`);
  console.log(`  organization ${org.slug}`);

  const name = `pb-${Date.now().toString(36)}`;
  const created = await api('/v1/projects', {
    method: 'POST',
    headers: { 'idempotency-key': `pb-${Date.now()}` },
    body: JSON.stringify({ name, region: 'eu-central', org_id: org.id }),
  });
  const ref: string = created.body?.project?.ref;
  if (!ref) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const provisionMs = await waitFor(ref, 'ready');
  console.log(`  provisioned ${ref} in ${(provisionMs / 1000).toFixed(1)}s`);

  const pauses: number[] = [];
  const resumes: number[] = [];
  for (let i = 1; i <= CYCLES; i++) {
    const p0 = Date.now();
    const pr = await api(`/v1/projects/${ref}/pause`, { method: 'POST' });
    if (pr.status !== 202) throw new Error(`pause ${i}: ${pr.status} ${JSON.stringify(pr.body)}`);
    await waitFor(ref, 'paused');
    pauses.push(Date.now() - p0);

    const r0 = Date.now();
    const rr = await api(`/v1/projects/${ref}/resume`, { method: 'POST' });
    if (rr.status !== 202) throw new Error(`resume ${i}: ${rr.status} ${JSON.stringify(rr.body)}`);
    await waitFor(ref, 'ready');
    resumes.push(Date.now() - r0);
    if (i % 5 === 0 || i === CYCLES) {
      console.log(`  cycle ${i}/${CYCLES}  pause p50 ${pct(pauses, 50)}ms  resume p50 ${pct(resumes, 50)}ms`);
    }
  }

  const summary = {
    measurement: 'M-007',
    what: 'pause and resume latency through the HTTP API and the real worker',
    cycles: CYCLES,
    pause_ms: { p50: pct(pauses, 50), p95: pct(pauses, 95), max: Math.max(...pauses) },
    resume_ms: { p50: pct(resumes, 50), p95: pct(resumes, 95), max: Math.max(...resumes) },
    target: { resume_p50_ms: 5000, resume_p95_ms: 15000 },
    provisioned_ms: provisionMs,
    // What the numbers are *of*, so nobody quotes them past their conditions (D-210).
    conditions: {
      arch: process.arch, platform: process.platform,
      substrate: 'Docker-in-Docker on a developer laptop',
      co_resident_projects: 1,
      client_load: 'none beyond the harness',
      stack: 'postgres + pgbouncer (no PostgREST — Phase 5)',
    },
  };
  const dir = join(ROOT, 'docs/14-roadmap/measurements');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'm-007-pause-resume.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log('');
  console.log(`  pause   p50 ${summary.pause_ms.p50}ms  p95 ${summary.pause_ms.p95}ms  max ${summary.pause_ms.max}ms`);
  console.log(`  resume  p50 ${summary.resume_ms.p50}ms  p95 ${summary.resume_ms.p95}ms  max ${summary.resume_ms.max}ms`);
  console.log(`  target  resume p50 < 5000ms, p95 < 15000ms`);
  const ok = summary.resume_ms.p50 < 5000 && summary.resume_ms.p95 < 15000;
  console.log(ok ? '▸ within target' : '▸ OUTSIDE target');

  stopAll();
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error('▸ failed:', (err as Error).message);
  stopAll();
  process.exit(1);
});
