/**
 * Phase 2 · P2g — the density measurement behind exit criterion 1.
 *
 * The criterion: *"100 test projects on one node within RAM budget; density
 * matches the [cost model](../../../docs/12-business/01-cost-model.md)
 * assumptions or the model is corrected."*
 *
 * **Read D-209 before quoting anything this prints.** The 350 MB per-active-project
 * budget and D-091's 150-active/node may only be re-based on a measurement with
 * the full triplet, x86 launch-SKU-class hardware, ≥50 co-resident projects, and
 * client load attached. This harness satisfies the last two and cannot satisfy the
 * first two: PostgREST is Phase 5, and this is a Docker-in-Docker node on an ARM
 * laptop. So the numbers below inform the risk register and go no further — which
 * is exactly what D-209 exists to enforce, since Milestone 0's numbers came in ~3×
 * *under* the assumption and a planning figure lowered on convenient data is how a
 * density model becomes confidently wrong.
 *
 * What it therefore measures honestly: whether the platform *functions* at 100
 * co-resident projects on one node, what a project's working set actually is with
 * clients attached, and how far booked RAM sits from used RAM at that scale.
 *
 * Usage (staging up, migrated, images seeded):
 *   pnpm --filter @corebase/worker density
 *   CB_DN_PROJECTS=100 CB_DN_CONNS=2 pnpm --filter @corebase/worker density
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Client } from 'pg';
import { appDatabaseUrl, ownerDatabaseUrl } from './staging-env.mts';
import { createDocker } from '../src/docker.ts';
import { PLAN_RAM_MB, FILL_CEILING } from '../src/placement.ts';
import { IMAGE } from '../src/container-spec.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const TARGET = Number(process.env.CB_DN_PROJECTS ?? 100);
const CONNS = Number(process.env.CB_DN_CONNS ?? 2);
const LOAD_SECONDS = Number(process.env.CB_DN_LOAD_SECONDS ?? 30);
const CONCURRENCY = Number(process.env.CB_DN_CONCURRENCY ?? 4);
const PORT = Number(process.env.CB_DN_API_PORT ?? 8098);
const TOKEN = 'dn-token-harness-token-long-enough-for-the-boot-check';
const BUDGET_MS = Number(process.env.CB_DN_BUDGET_MS ?? 120_000);

/**
 * The node is declared far larger than the VM it runs in, deliberately, and this
 * is the one number in the run that is a fiction.
 *
 * Placement books the *plan budget* (D-174): 350 MB per active Free project, so
 * 100 of them reserve 35 GB and the 85% stop (D-090) needs a node declaring at
 * least ~41 GB. The VM has 8. Declaring the truth would make this a test of the
 * bin-packer's refusal — which P2f already proves, twice — and would measure
 * nothing about density. M-002 made the same choice for the same reason.
 *
 * What it costs: this run says nothing about whether 100 projects fit *within the
 * booking model*. It says what 100 projects actually consume, which is the number
 * the booking model is supposed to be conservative about.
 */
const DECLARED_RAM_MB = Number(process.env.CB_DN_NODE_RAM_MB
  ?? Math.ceil((TARGET * (PLAN_RAM_MB['free'] ?? 350)) / FILL_CEILING / 1024) * 1024);
const DECLARED_DISK_GB = Number(process.env.CB_DN_NODE_DISK_GB ?? Math.ceil(TARGET / FILL_CEILING) + 50);

const PG_PORT_BASE = Number(process.env.CB_DN_PG_PORT_BASE ?? 5433);
const POOLER_PORT_BASE = Number(process.env.CB_DN_POOLER_PORT_BASE ?? 6433);

const env = {
  ...process.env,
  CB_CONTROL_DATABASE_URL: appDatabaseUrl(ROOT),
  CB_REDIS_URL: process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379',
  CB_DOCKER_HOST: process.env.CB_DOCKER_HOST ?? '127.0.0.1',
  CB_DOCKER_PORT: process.env.CB_DOCKER_PORT ?? '2376',
  CB_DOCKER_CERT_DIR: process.env.CB_DOCKER_CERT_DIR ?? join(ROOT, 'infra/docker/staging/certs'),
  CB_KEK_DIR: process.env.CB_KEK_DIR ?? join(ROOT, 'infra/docker/staging/kek.d'),
  ...(process.env.CB_KEK_ID ? { CB_KEK_ID: process.env.CB_KEK_ID } : {}),
  CB_BOOTSTRAP_SECRET: process.env.CB_BOOTSTRAP_SECRET ?? 'bench-bootstrap-secret-0123456789',
  CB_STATIC_TOKEN: TOKEN,
  CB_NODE_RAM_MB: String(DECLARED_RAM_MB),
  // The per-org ceiling (20 live projects) is an abuse control, not a capacity
  // one — it exists so a single account cannot consume a node's whole RAM budget
  // and turn a billing question into an outage. It is also the wall this run hit
  // first: 20 projects created, 80 refused with 409, and the node never came near
  // its limits. Raised here because a *node* density measurement is not what that
  // ceiling is protecting against.
  //
  // What it costs: all 100 projects belong to one organization, so this says
  // nothing about cross-tenant behaviour in the control plane. It says nothing
  // about density either way — isolation is per container, and an org is a
  // control-plane grouping the node has never heard of.
  CB_PROJECTS_PER_ORG: String(process.env.CB_DN_ORG_LIMIT ?? TARGET + 20),
  CB_NODE_DISK_GB: String(DECLARED_DISK_GB),
  // One published host port per container, two containers per project, and the
  // allocator must be narrowed to exactly what the data node republishes —
  // `dind` puts project ports in its own namespace, so a port the compose file
  // does not publish is a port the worker's health gates cannot reach. Getting
  // this wrong does not fail at allocation: every project provisions
  // successfully and then dies at `wait_pooler_healthy` with `ECONNREFUSED`,
  // nine steps in, which reads like a broken pooler.
  CB_PG_PORT_MIN: String(PG_PORT_BASE), CB_PG_PORT_MAX: String(PG_PORT_BASE + TARGET - 1),
  CB_POOLER_PORT_MIN: String(POOLER_PORT_BASE), CB_POOLER_PORT_MAX: String(POOLER_PORT_BASE + TARGET - 1),
  // The disk and idle sweeps would otherwise run mid-measurement and their
  // `pg_database_size` queries are themselves client load.
  CB_DISK_SCAN_MS: '3600000',
  CB_IDLE_SCAN_MS: '3600000',
  PORT: String(PORT),
  CB_METRICS_PORT: '9116',
  CB_PROJECT_DOMAIN: 'localhost',
};

const children: ChildProcess[] = [];
const start = (name: string, cwd: string, script: string) => {
  const c = spawn('node', ['--experimental-strip-types', script], {
    cwd: join(ROOT, cwd), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  c.stdout.on('data', (b) => { if (process.env.CB_DN_VERBOSE) process.stdout.write(`[${name}] ${b}`); });
  c.stderr.on('data', (b) => process.stderr.write(`[${name}] ${b}`));
  children.push(c);
  return c;
};
const stopAll = () => { for (const c of children) c.kill('SIGTERM'); };
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MiB = (b: number) => b / (1024 * 1024);
const pct = (xs: number[], p: number) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const round = (n: number, d = 1) => Number(n.toFixed(d));

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
               ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function waitFor(ref: string, want: string): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < BUDGET_MS) {
    const { body } = await api(`/v1/projects/${ref}`);
    if (body?.project?.status === want) return;
    if (body?.project?.status === 'failed') throw new Error(`project ${ref} failed`);
    await sleep(200);
  }
  throw new Error(`project ${ref} never reached ${want} within ${BUDGET_MS}ms`);
}

const docker = createDocker({
  host: env.CB_DOCKER_HOST, port: Number(env.CB_DOCKER_PORT),
  certDir: env.CB_DOCKER_CERT_DIR, timeoutMs: 30_000,
});

interface Sample {
  containers: number;
  anon_total_mib: number;
  usage_total_mib: number;
  per_container_anon_mib: { min: number; p50: number; max: number; mean: number };
  by_role: Record<string, { n: number; anon_mib: number }>;
  cpu_total_ns: number;
  node: { mem_total_mib: number; mem_available_mib: number; mem_used_mib: number };
}

/** Read every managed container's memory, plus the node's own view of itself. */
async function sample(): Promise<Sample> {
  const list = await docker.listContainers('com.corebase.managed=true');
  const running = list.filter((c) => c.State === 'running');
  const rows: Array<{ role: string; anon: number; usage: number; cpu: number }> = [];
  for (const c of running) {
    try {
      const s = await docker.containerStats(c.Id);
      const st = s.memory_stats?.stats ?? {};
      // cgroup v2: `anon` is the unreclaimable working set. `usage` includes page
      // cache, which a node under pressure gets back — quoting it as the cost of a
      // project overstates it by whatever the kernel happened to be caching.
      const anon = st['anon'] ?? Math.max(0, (s.memory_stats?.usage ?? 0) - (st['inactive_file'] ?? 0));
      rows.push({
        role: c.Labels?.['com.corebase.role'] ?? 'database',
        anon,
        usage: s.memory_stats?.usage ?? 0,
        cpu: s.cpu_stats?.cpu_usage?.total_usage ?? 0,
      });
    } catch { /* a container that vanished mid-sweep is not a measurement */ }
  }
  const anons = rows.map((r) => r.anon).sort((a, b) => a - b);
  const byRole: Record<string, { n: number; anon_mib: number }> = {};
  for (const r of rows) {
    const e = byRole[r.role] ?? { n: 0, anon_mib: 0 };
    e.n += 1; e.anon_mib = round(e.anon_mib + MiB(r.anon));
    byRole[r.role] = e;
  }
  return {
    containers: rows.length,
    anon_total_mib: round(anons.reduce((a, b) => a + b, 0) / (1024 * 1024)),
    usage_total_mib: round(rows.reduce((a, r) => a + r.usage, 0) / (1024 * 1024)),
    per_container_anon_mib: {
      min: round(MiB(anons[0] ?? 0)),
      p50: round(MiB(anons[Math.floor(anons.length / 2)] ?? 0)),
      max: round(MiB(anons[anons.length - 1] ?? 0)),
      mean: round(anons.length ? MiB(anons.reduce((a, b) => a + b, 0) / anons.length) : 0),
    },
    by_role: byRole,
    // Docker reports `total_usage` in **nanoseconds**, cumulative since the
    // container started. Kept in ns and converted once, at the one place that
    // needs cores — treating ns as µs reported 1547 busy cores on a 10-core
    // machine, which is at least obviously wrong rather than plausibly wrong.
    cpu_total_ns: rows.reduce((a, r) => a + r.cpu, 0),
    node: await nodeMemory(),
  };
}

/**
 * The node's own memory, read from inside it.
 *
 * Summing container working sets is not the same as asking the node how it is
 * doing: `shared_buffers` lands in page cache (M-001), and page cache is where
 * density is expected to actually bind. `MemAvailable` is the kernel's own estimate
 * of what a new workload could have, which is the closest thing to the question
 * "would another project fit".
 */
async function nodeMemory(): Promise<{ mem_total_mib: number; mem_available_mib: number; mem_used_mib: number }> {
  const probe = 'cb-dn-meminfo';
  await docker.removeContainer(probe, true, true).catch(() => {});
  try {
    const id = await docker.createContainer(probe, {
      // The same constant the product reads, rather than this harness's own
      // `env` object — which never carried `CB_PG_IMAGE`, so the `??` always
      // took its fallback and the probe silently pinned an image the fleet may
      // have moved off. Caught the moment these files were added to `tsc`.
      Image: IMAGE,
      Env: [], Labels: { 'com.corebase.role': 'density-probe' },
      Cmd: ['sh', '-c', 'grep -E "^(MemTotal|MemAvailable|MemFree|Cached):" /proc/meminfo'],
      HostConfig: {
        Memory: 64 * 1024 * 1024, MemorySwap: 64 * 1024 * 1024, NanoCpus: 1e8,
        PidsLimit: 16, RestartPolicy: { Name: 'no' }, Mounts: [], PortBindings: {},
      },
      ExposedPorts: {},
    });
    await docker.startContainer(id);
    for (let i = 0; i < 50; i++) {
      const st = await docker.inspectContainer(probe);
      if (st && !st.State.Running) break;
      await sleep(100);
    }
    const out = await docker.containerLogs(probe);
    const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(out)?.[1] ?? '0');
    const total = kb('MemTotal') / 1024, avail = kb('MemAvailable') / 1024;
    return { mem_total_mib: round(total), mem_available_mib: round(avail), mem_used_mib: round(total - avail) };
  } catch {
    return { mem_total_mib: 0, mem_available_mib: 0, mem_used_mib: 0 };
  } finally {
    await docker.removeContainer(probe, true, true).catch(() => {});
  }
}

/** Total bytes across every project database, from the control plane's own source. */
async function diskBytes(refs: string[], conns: Map<string, string>): Promise<number> {
  let total = 0;
  for (const ref of refs) {
    const url = conns.get(ref);
    if (!url) continue;
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 4000 });
    try {
      await c.connect();
      const { rows } = await c.query<{ n: string }>(`select pg_database_size(current_database()) as n`);
      total += Number(rows[0]!.n);
    } catch { /* a project that will not answer is reported by the load phase */ }
    finally { await c.end().catch(() => {}); }
  }
  return total;
}

/**
 * Is the host port actually published by the data node?
 *
 * `docker-proxy` binds every published port whether or not anything is behind it,
 * so a connection that is *accepted* means published-and-empty and a connection
 * *refused* means not published at all. That distinction is the whole check, and
 * it is worth 100 provisions: without it the run reaches
 * `wait_pooler_healthy` on every project and reports a pooler problem.
 */
function portPublished(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port, timeout: 2000 });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(true));   // bound but not answering is still bound
  });
}

async function preflight(): Promise<void> {
  const needed: Array<[string, number]> = [
    ['project', PG_PORT_BASE + TARGET - 1],
    ['pooler', POOLER_PORT_BASE + TARGET - 1],
  ];
  for (const [what, port] of needed) {
    if (!(await portPublished(port))) {
      throw new Error(
        `the data node does not publish ${what} port ${port}, so ${TARGET} projects cannot ` +
        'be health-checked from here. Recreate the node with a wider range:\n' +
        `  PROJECT_PORT_MIN=${PG_PORT_BASE} PROJECT_PORT_MAX=${PG_PORT_BASE + TARGET - 1} \\\n` +
        `  POOLER_PORT_MIN=${POOLER_PORT_BASE} POOLER_PORT_MAX=${POOLER_PORT_BASE + TARGET - 1} \\\n` +
        '  docker compose -f infra/docker/staging/docker-compose.yml up -d --force-recreate data-node');
    }
  }
}

async function main() {
  console.log(`▸ P2g density · target ${TARGET} projects on one node`);
  await preflight();
  console.log(`  node declared ${DECLARED_RAM_MB} MB RAM / ${DECLARED_DISK_GB} GB disk ` +
              `(a fiction — see the comment on DECLARED_RAM_MB)`);

  // The node row carries whatever the last worker registered, and — more
  // importantly — whatever reservations previous runs left on it.
  //
  // `ram_reserved_mb` is a counter on `nodes`, not a view over
  // `project_databases`, so truncating the project tables between runs frees
  // nothing: the node still believes it is holding the memory. That is exactly
  // what happened on the first run of this harness — the packer refused half the
  // projects with "the emptiest, data-node-local, is at 2450/3072 MB", correctly,
  // against bookings whose rows no longer existed. Recomputing from the rows is
  // what the reconciler's `reservation_drift` repair does, and it is right for the
  // same reason: the rows are the truth, the counter is a cache.
  const owner = new Client({ connectionString: ownerDatabaseUrl() });
  await owner.connect();
  await owner.query(`delete from nodes where hostname <> $1`, ['data-node-local']);
  await owner.query(
    `update nodes n set
       ram_reserved_mb = coalesce((select sum(d.ram_booked_mb) from project_databases d
                                    where d.node_id = n.id), 0),
       disk_reserved_gb = coalesce((select count(*) from project_databases d
                                     where d.node_id = n.id), 0)`);
  const { rows: nodeRows } = await owner.query<{ hostname: string; ram: number; disk: number }>(
    `select hostname, ram_reserved_mb as ram, disk_reserved_gb as disk from nodes`);
  await owner.end();
  for (const n of nodeRows) {
    console.log(`  node ${n.hostname} starts at ${n.ram} MB / ${n.disk} GB reserved`);
  }

  start('api', 'services/api', 'src/main.ts');
  start('worker', 'services/worker', 'src/main.ts');
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch { /* boot */ }
    await sleep(250);
  }

  const orgList = await api('/v1/orgs');
  const orgs: Array<{ id: string; slug: string }> = orgList.body?.orgs ?? [];
  const org = orgs.find((o) => o.slug === 'dev') ?? orgs[0];
  if (!org) throw new Error(`no organization for this token: ${JSON.stringify(orgList.body)}`);

  // ── provision ────────────────────────────────────────────────────────────
  const refs: string[] = [];
  const conns = new Map<string, string>();
  const failures: Array<{ ref: string; error: string }> = [];
  const progress: Array<{ n: number; sample: Sample; elapsed_s: number }> = [];
  const t0 = Date.now();

  const readyMs: number[] = [];
  let lastReported = 0;
  let barrenBatches = 0;
  const provisionOne = async (i: number) => {
    const started = Date.now();
    const created = await api('/v1/projects', {
      method: 'POST',
      headers: { 'idempotency-key': `dn-${Date.now()}-${i}` },
      body: JSON.stringify({ name: `dn-${Date.now().toString(36)}-${i}`, region: 'eu-central', org_id: org.id }),
    });
    const ref: string = created.body?.project?.ref;
    if (!ref) throw new Error(`create ${i} failed: ${created.status} ${JSON.stringify(created.body)}`);
    await waitFor(ref, 'ready');
    // `?reveal=true` is what hands back the credentialed string, and it is audited
    // (P2d) — a hundred reveals in a run is a hundred audit rows, which is correct
    // and worth knowing before someone reads the audit log afterwards.
    const detail = await api(`/v1/projects/${ref}?reveal=true`);
    const direct: string | undefined = detail.body?.database?.connection_strings?.direct;
    if (direct) conns.set(ref, direct);
    refs.push(ref);
    readyMs.push(Date.now() - started);
  };

  for (let i = 0; i < TARGET; i += CONCURRENCY) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, TARGET - i) }, (_, k) => i + k);
    const settled = await Promise.allSettled(batch.map(provisionOne));
    let won = 0;
    for (const [k, r] of settled.entries()) {
      if (r.status === 'rejected') {
        failures.push({ ref: `#${batch[k]}`, error: String((r.reason as Error).message).slice(0, 200) });
      } else won++;
    }
    // A batch where nothing at all succeeded twice over is a wall, not capacity
    // pressure — an org ceiling, an exhausted port range, a dead node. Grinding
    // through the remaining eighty and reporting eighty copies of the same
    // sentence wastes the run and hides which sentence mattered.
    barrenBatches = won === 0 ? barrenBatches + 1 : 0;
    if (barrenBatches >= 2) {
      console.log(`  stopping early: two consecutive batches failed entirely — ` +
        `${failures[failures.length - 1]?.error ?? 'no error recorded'}`);
      break;
    }
    const done = refs.length;
    // Report on crossing each 20, not on `done % 20 === 0` — when provisioning
    // stalls, `done` stops moving and the modulo stays true, so the run prints
    // the same line every batch and buries the reason it stopped.
    if (done > 0 && done - lastReported >= 20) {
      lastReported = done;
      const s = await sample();
      progress.push({ n: done, sample: s, elapsed_s: round((Date.now() - t0) / 1000) });
      console.log(`  ${done}/${TARGET} ready · ${s.containers} containers · ` +
        `anon ${s.anon_total_mib} MiB · node used ${s.node.mem_used_mib}/${s.node.mem_total_mib} MiB · ` +
        `${round((Date.now() - t0) / 1000)}s`);
    }
  }
  const provisionSeconds = round((Date.now() - t0) / 1000);
  console.log(`  provisioned ${refs.length}/${TARGET} in ${provisionSeconds}s ` +
              `(${failures.length} failed)`);

  // ── idle ─────────────────────────────────────────────────────────────────
  await sleep(5000);
  const idle = await sample();
  const idleDisk = await diskBytes(refs, conns);
  console.log(`  idle: anon ${idle.anon_total_mib} MiB across ${idle.containers} containers, ` +
              `disk ${round(idleDisk / 1024 / 1024)} MiB`);

  // ── client load ──────────────────────────────────────────────────────────
  // D-209's fourth condition. Idle databases are the cheapest corner of the state
  // space and M-001 already showed the difference: 5.0 MiB anon idle against
  // 27.9 MiB with ten backends attached. A density number taken without clients
  // measures the platform, not the product.
  console.log(`  attaching ${CONNS} connection(s) per project for ${LOAD_SECONDS}s…`);
  const clients: Client[] = [];
  let attached = 0;
  const attachFailures: string[] = [];
  for (const ref of refs) {
    const url = conns.get(ref);
    if (!url) continue;
    for (let k = 0; k < CONNS; k++) {
      const c = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
      try { await c.connect(); clients.push(c); attached++; }
      catch (e) { attachFailures.push(`${ref}: ${(e as Error).message}`); break; }
    }
  }
  console.log(`  ${attached} connections attached (${attachFailures.length} projects refused)`);

  // Each connection does real work: a table it owns, rows it writes, and a query
  // that has to touch them. A `SELECT 1` loop would hold a backend open without
  // ever building a working set, which is most of what costs memory.
  let stop = false;
  let statements = 0;
  const loops = clients.map(async (c, idx) => {
    try {
      await c.query(`create table if not exists dn_load_${idx % CONNS} (id int primary key, payload text)`);
      await c.query(`insert into dn_load_${idx % CONNS} (id, payload)
                     select g, md5(random()::text) from generate_series(1, 500) g
                     on conflict (id) do update set payload = excluded.payload`);
      while (!stop) {
        await c.query(`select count(*), max(payload) from dn_load_${idx % CONNS}`);
        statements++;
      }
    } catch { /* a dropped connection during load is reported by the sample */ }
  });

  const before = await sample();
  await sleep(LOAD_SECONDS * 1000);
  const under = await sample();
  stop = true;
  await Promise.allSettled(loops);
  const loadDisk = await diskBytes(refs, conns);
  for (const c of clients) await c.end().catch(() => {});

  const cpuCores = round(((under.cpu_total_ns - before.cpu_total_ns) / 1e9) / LOAD_SECONDS, 2);
  console.log(`  under load: anon ${under.anon_total_mib} MiB · ` +
              `node used ${under.node.mem_used_mib}/${under.node.mem_total_mib} MiB · ` +
              `${statements} statements · ${cpuCores} cores busy`);

  // ── report ───────────────────────────────────────────────────────────────
  const booked = refs.length * (PLAN_RAM_MB['free'] ?? 350);
  const perProjectIdle = refs.length ? round(idle.anon_total_mib / refs.length, 2) : 0;
  const perProjectLoad = refs.length ? round(under.anon_total_mib / refs.length, 2) : 0;

  const summary = {
    measurement: 'M-008',
    what: 'how many projects one node actually holds, and what each costs idle and under load',
    at: new Date().toISOString(),
    target_projects: TARGET,
    provisioned: refs.length,
    failed: failures.length,
    failures: failures.slice(0, 10),
    provision_seconds: provisionSeconds,
    // Per-project create→ready at this much concurrency. Not comparable to
    // M-002's 2463 ms p50, which ran one create at a time and had no pooler.
    create_to_ready_ms: readyMs.length
      ? { p50: pct(readyMs, 50), p95: pct(readyMs, 95), max: Math.max(...readyMs) }
      : null,
    provision_concurrency: CONCURRENCY,
    containers_running: idle.containers,
    ram: {
      booked_mb: booked,
      idle_anon_mib: idle.anon_total_mib,
      load_anon_mib: under.anon_total_mib,
      per_project_idle_mib: perProjectIdle,
      per_project_load_mib: perProjectLoad,
      booked_to_used_ratio_idle: perProjectIdle ? round((PLAN_RAM_MB['free'] ?? 350) / perProjectIdle) : null,
      booked_to_used_ratio_load: perProjectLoad ? round((PLAN_RAM_MB['free'] ?? 350) / perProjectLoad) : null,
      per_container_idle_mib: idle.per_container_anon_mib,
      per_container_load_mib: under.per_container_anon_mib,
      by_role_idle_mib: idle.by_role,
      by_role_load_mib: under.by_role,
    },
    node_memory: { idle: idle.node, under_load: under.node },
    disk: {
      // `pg_database_size`, the same source the ladder and billing use — the
      // logical size of the database, not the footprint of the volume. M-002's
      // ~59 MB per project was volume footprint, which includes WAL and
      // filesystem overhead; the two answer different questions.
      source: 'pg_database_size(current_database())',
      idle_total_mib: round(idleDisk / 1024 / 1024),
      load_total_mib: round(loadDisk / 1024 / 1024),
      per_project_idle_mib: refs.length ? round(idleDisk / 1024 / 1024 / refs.length, 1) : 0,
    },
    load: { connections_attached: attached, connections_refused: attachFailures.length,
            seconds: LOAD_SECONDS, statements, cores_busy: cpuCores },
    // What the numbers are *of*, so nobody quotes them past their conditions
    // (D-210) — and, specifically, which of D-209's four preconditions hold.
    d209: {
      full_triplet: false,          // PostgREST is Phase 5
      x86_launch_sku_class: process.arch === 'x64',
      at_least_50_co_resident: refs.length >= 50,
      client_load_attached: attached > 0,
      may_rebase_planning_numbers: false,
    },
    conditions: {
      arch: process.arch, platform: process.platform,
      substrate: 'Docker-in-Docker on a developer laptop',
      node_declared_ram_mb: DECLARED_RAM_MB,
      node_declared_disk_gb: DECLARED_DISK_GB,
      node_actual_ram_mib: idle.node.mem_total_mib,
      stack: 'postgres + pgbouncer (no PostgREST — Phase 5)',
      connections_per_project: CONNS,
    },
  };
  const dir = join(ROOT, 'docs/14-roadmap/measurements');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'm-008-density.json'), JSON.stringify(summary, null, 2) + '\n');

  console.log('');
  console.log(`  projects        ${refs.length}/${TARGET}   containers ${idle.containers}`);
  console.log(`  RAM booked      ${booked} MB   actually used (anon) ${idle.anon_total_mib} MiB idle, ${under.anon_total_mib} MiB loaded`);
  console.log(`  per project     ${perProjectIdle} MiB idle · ${perProjectLoad} MiB loaded · booked ${PLAN_RAM_MB['free']} MB`);
  console.log(`  node memory     ${under.node.mem_used_mib}/${under.node.mem_total_mib} MiB used under load`);
  console.log(`  disk            ${summary.disk.per_project_idle_mib} MiB per project`);
  console.log(`  D-209           may re-base planning numbers: NO ` +
              `(full triplet ${summary.d209.full_triplet}, x86 ${summary.d209.x86_launch_sku_class})`);
  console.log(`  raw             docs/14-roadmap/measurements/m-008-density.json`);

  docker.close();
  stopAll();
  // The criterion is whether the node holds the target, not whether the numbers
  // flatter the model — the model may not move on this evidence either way.
  process.exit(refs.length >= TARGET ? 0 : 1);
}

main().catch(async (err) => {
  console.error('▸ failed:', (err as Error).message);
  docker.close();
  stopAll();
  process.exit(1);
});
