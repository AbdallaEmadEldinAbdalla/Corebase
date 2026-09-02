import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas, superuserCandidates } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { LABEL_MANAGED } from './container-spec.ts';
import { createDiskScan } from './disk-scan.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P2e against a real project: exit criterion 3's testable half — "a project that
 * fills its disk quota goes read-only and recovers when space is freed".
 *
 * The cap is lowered for the test rather than writing 475 MB of rows: the ladder
 * acts on a *percentage* of `disk_limit_mb`, so shrinking the cap moves the rungs
 * to where a few megabytes reach them. What is being tested is the ladder and the
 * recovery, not Postgres's ability to store data.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? new URL('../../../infra/docker/staging/certs', import.meta.url).pathname;
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

let pool: Pool; let docker: Docker; let secrets: ReturnType<typeof createSecretStore>;
let kekDir: string; let orgId: string; let up = false; let seq = 0;

const mkRef = () => 'd' + String(Date.now() % 100000) + String(++seq).padStart(14, 'x');

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'cb-p2e-'));
  writeFileSync(join(kekDir, 'k1.key'), randomBytes(32));
  try {
    pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 2000 });
    await pool.query('select 1');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    secrets = createSecretStore(pool, createEnvelope({ kekDir, kekId: 'k1' }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('P2E','p2e-test')
       on conflict (slug) do update set updated_at = now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    console.error('P2e disk e2e setup FAILED:', (err as Error).message);
    up = false;
  }
}, 30_000);

afterAll(async () => {
  if (up) {
    for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
      await docker.removeContainer(c.Id).catch(() => {});
    }
    for (const n of await docker.listNetworks(`${LABEL_MANAGED}=true`)) {
      await docker.removeNetwork(n.Name).catch(() => {});
    }
    for (const v of await docker.listVolumes(`${LABEL_MANAGED}=true`)) {
      await docker.removeVolume(v.Name).catch(() => {});
    }
    docker.close();
  }
  await pool?.end();
  rmSync(kekDir, { recursive: true, force: true });
}, 120_000);

beforeEach(async () => {
  if (!up) return;
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id).catch(() => {});
  }
  await pool.query('truncate provisioning_jobs, project_databases, projects cascade');
  await pool.query(`update nodes set ram_reserved_mb = 0, disk_reserved_gb = 0, status = 'active'`);
}, 60_000);

async function runSaga(kind: string, projectId: string) {
  const steps = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET,
    healthTimeoutMs: 60_000, projectDomain: 'corebase.test',
  })[kind]! as SagaStep<SagaContext>[];
  const job = { id: 'j', project_id: projectId, payload: {} } as unknown as JobRecord;
  for (const step of steps) await step.run({ job, log: () => {} });
}

async function newProject() {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (organization_id, ref, name, region, plan, status)
     values ($1, $2, $3, 'eu-central', 'free', 'creating') returning id`, [orgId, ref, ref]);
  await registerNode(pool, {
    hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200, address: HOST,
  });
  return { id: rows[0]!.id, ref };
}

/**
 * Scan with its log captured. Without this, a rung that fails to apply is swallowed
 * — the scan logs an error, reverts the stored state and reports no transition, so
 * the test failure reads as "nothing happened" rather than as the actual cause.
 * That cost real time once (D-249's one-way door).
 */
const scanLog: string[] = [];
const scan = () => createDiskScan({
  pool, probeTimeoutMs: 5_000,
  log: (level, msg, extra) => scanLog.push(`[${level}] ${msg} ${JSON.stringify(extra ?? {})}`),
});
const runScan = () => scan().scanOnce({
  developerSecretFor: (id) => secrets.get(id, SECRET_NAMES.developer),
  superuserPasswordsFor: (id) => superuserCandidates(
    { pool, secrets, bootstrapSecret: SECRET } as never, id),
});

async function asCustomer<T>(projectId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const { rows } = await pool.query<{ port: number }>(
    `select port from project_databases where project_id = $1`, [projectId]);
  const password = await secrets.get(projectId, SECRET_NAMES.developer);
  const client = new Client({
    host: HOST, port: rows[0]!.port, user: 'developer', password,
    database: 'postgres', connectionTimeoutMillis: 5_000, ssl: false,
  });
  client.on('error', () => { /* the ladder may end sessions */ });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

/** Move the rungs to where a few MB of data reaches them. */
async function setCapMb(projectId: string, mb: number) {
  await pool.query(
    `update project_databases set disk_limit_mb = $2 where project_id = $1`, [projectId, mb]);
}

async function state(projectId: string) {
  const { rows } = await pool.query<{ disk_state: string; used: string | null }>(
    `select disk_state::text as disk_state, disk_used_bytes::text as used
       from project_databases where project_id = $1`, [projectId]);
  return rows[0]!;
}

const t = (name: string, fn: () => Promise<void>, ms = 240_000) =>
  it(name, async () => {
    if (!up) throw new Error(
      'staging stack not reachable — bring it up with ./scripts/staging.sh up. ' +
      'This is the P2e done-signal and must not be skipped silently.');
    await fn();
  }, ms);

describe('P2e — the disk ladder against a real project', () => {
  t('measures usage from the database itself and stays on `ok` when there is room', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const r = await runScan();
    expect(r.checked).toBe(1);
    expect(r.unreachable).toBe(0);
    const s = await state(p.id);
    expect(s.disk_state).toBe('ok');
    // A real reading, not a placeholder: an empty Postgres database is a few MB.
    expect(Number(s.used)).toBeGreaterThan(1024 * 1024);
  });

  /**
   * Pick an integer-MB cap that puts `mb` inside a band, and say so if none does.
   *
   * The first version of this test computed `ceil(mb / 0.85)` and trusted it. The
   * cap is whole megabytes and a fresh database is only ~8 MB, so one megabyte of
   * cap is more than ten percent of the ratio — and `ceil` always rounds the cap
   * *up*, which pushes the ratio *down*. For some baselines that lands just under
   * 80% and the rung stays `ok`.
   *
   * It broke when P4a added the `auth` tables to every project, shifting the
   * baseline into exactly that gap: a test failure about the disk ladder, caused by
   * a schema change, in a ladder that was never wrong. Searching for a cap and
   * asserting the resulting percentage turns that from an intermittent mystery into
   * a message naming the baseline.
   */
  const capForBand = (mb: number, lo: number, hi: number): number => {
    const target = (lo + hi) / 2;
    let best = Math.max(1, Math.round(mb / (target / 100)));
    for (const cap of [best, best - 1, best + 1, best - 2, best + 2]) {
      if (cap < 1) continue;
      const pct = (mb / cap) * 100;
      if (pct >= lo && pct <= hi) return cap;
    }
    throw new Error(
      `no integer cap puts ${mb.toFixed(2)} MB between ${lo}% and ${hi}% — the ` +
      'database is too small for the ladder\'s bands to be addressable in whole ' +
      'megabytes. Grow it before asserting a rung.');
  };

  t('climbs the rungs as usage rises', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);

    // Grow the database first, and this is not padding: the cap is whole
    // megabytes, so at a fresh project's ~8.5 MB one megabyte of cap moves the
    // ratio by more than ten percent and the ladder's 90–95% band is not
    // addressable at all. `capForBand` says so explicitly now instead of the rung
    // quietly coming back `ok`. Incompressible data for the same reason the
    // exit-criterion test uses it — random hex does not TOAST-compress away.
    await asCustomer(p.id, async (c) => {
      await c.query(`create table rungs(id serial primary key, blob text)`);
      await c.query(
        `insert into rungs(blob)
         select (select string_agg(md5(random()::text), '') FROM generate_series(1, 125))
           from generate_series(1, 2000)`);
    });
    await runScan();
    const used = Number((await state(p.id)).used);
    const mb = used / 1024 / 1024;

    // Comfortably inside warn (>=80, <90) rather than on its edge.
    const warnCap = capForBand(mb, 82, 88);
    await setCapMb(p.id, warnCap);
    let r = await runScan();
    expect((await state(p.id)).disk_state,
      `${mb.toFixed(2)} MB against a ${warnCap} MB cap is ` +
      `${((mb / warnCap) * 100).toFixed(1)}%`).toBe('warn');
    expect(r.transitions[0]).toMatchObject({ from: 'ok', to: 'warn' });

    // And inside critical (>=90, <95).
    const critCap = capForBand(mb, 91, 94);
    await setCapMb(p.id, critCap);
    r = await runScan();
    expect((await state(p.id)).disk_state,
      `${mb.toFixed(2)} MB against a ${critCap} MB cap is ` +
      `${((mb / critCap) * 100).toFixed(1)}%`).toBe('critical');
    expect(r.transitions[0]).toMatchObject({ from: 'warn', to: 'critical' });
  });

  t('EXIT CRITERION: goes read-only past 95%, and recovers when space is freed', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);

    // Real, *incompressible* data. The first version of this used
    // `repeat('x', 4000)`, which TOAST compresses to almost nothing — 3000 rows of
    // it left the database at 8 MB and the ladder had nothing to react to. Random
    // hex does not compress, so the bytes on disk are the bytes inserted.
    await asCustomer(p.id, async (c) => {
      await c.query(`create table bulk(id serial primary key, blob text)`);
      await c.query(
        `insert into bulk(blob)
         select (select string_agg(md5(random()::text), '') FROM generate_series(1, 125))
           from generate_series(1, 4000)`);
    });
    await runScan();
    const used = Number((await state(p.id)).used);

    // Cap just under current usage, so the project is over its plan. The fill has
    // to have actually grown the database for this to mean anything.
    const usedMb = used / 1024 / 1024;
    expect(usedMb, 'the fill did not grow the database — nothing to enforce against')
      .toBeGreaterThan(25);
    await setCapMb(p.id, Math.floor(usedMb / 0.98));
    const r = await runScan();
    expect(r.transitions.at(-1)).toMatchObject({ to: 'read_only' });
    expect((await state(p.id)).disk_state).toBe('read_only');

    // Reads keep working — that is the whole point of a *soft* rung.
    const rows = await asCustomer(p.id, async (c) => {
      const { rows } = await c.query<{ n: number }>(`select count(*)::int as n from bulk`);
      return rows[0]!.n;
    });
    expect(rows).toBe(4000);

    // Writes fail, with an error a developer can act on.
    await expect(asCustomer(p.id, async (c) =>
      c.query(`insert into bulk(blob) values ('nope')`)))
      .rejects.toThrow(/read-only/i);

    // The recovery path: the flag is advisory, so the customer turns it off for
    // their own session, frees space, and the next sweep lifts it for real. Making
    // it unbypassable would lock them out of the only action that fixes it.
    //
    // The *form* matters, and the credentials-doc wording is wrong about it.
    // `SET transaction_read_only = off` does not work: with autocommit each
    // statement is its own transaction, and that GUC applies only to the
    // transaction it runs in — which then commits. What works is the session-level
    // default, verified against a real database rather than assumed (D-249).
    await asCustomer(p.id, async (c) => {
      await c.query(`SET default_transaction_read_only = off`);
      // Enough to land well under the 90% lift line, not just under 95% — the
      // hysteresis is deliberate and the recovery has to clear it.
      await c.query(`delete from bulk where id > 500`);
      await c.query(`vacuum full bulk`);
    });

    scanLog.length = 0;
    const after = await runScan();
    expect(after.transitions.at(-1),
      `read-only did not lift after space was freed. scan log:\n${scanLog.join('\n')}`)
      .toMatchObject({ from: 'read_only' });
    expect((await state(p.id)).disk_state).not.toBe('read_only');

    // And writes work again without the customer doing anything else.
    await asCustomer(p.id, async (c) => {
      await c.query(`insert into bulk(blob) values ('writable again')`);
    });
  });

  t('the recovery instruction has to be the session-level form', async () => {
    // This exists because the doc named a form that does not work, and the doc's
    // form is what a customer would be told to type. A test that pins the working
    // one stops the wrong one coming back.
    const p = await newProject();
    await runSaga('provision_project', p.id);
    await runScan();
    await setCapMb(p.id, 1);                       // far past read-only
    await runScan();
    expect((await state(p.id)).disk_state).toBe('read_only');

    // The doc's form: applies only to its own autocommit transaction, so the next
    // statement is read-only again.
    await expect(asCustomer(p.id, async (c) => {
      await c.query(`SET transaction_read_only = off`);
      await c.query(`create table nope(i int)`);
    })).rejects.toThrow(/read-only/i);

    // The session-level form, which is what the docs must say.
    await asCustomer(p.id, async (c) => {
      await c.query(`SET default_transaction_read_only = off`);
      await c.query(`create table recovery_works(i int)`);
      await c.query(`drop table recovery_works`);
    });
  });

  t('a project it cannot measure is left exactly as it was', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    await setCapMb(p.id, 1);                 // would be far past read-only
    // Point the row at a port nothing answers on: a blip, not a full disk.
    await pool.query(
      `update project_databases set port = 5999 where project_id = $1`, [p.id]);
    const r = await runScan();
    expect(r.unreachable).toBe(1);
    expect(r.transitions).toEqual([]);
    // Crucially still 'ok' — acting on a missing reading would put a healthy
    // project into read-only during a network blip.
    expect((await state(p.id)).disk_state).toBe('ok');
  });

  t('cordons a node whose disk booking passes the ceiling', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    // Every project is quota-capped and every placement is disk-booked, so a node
    // near full means the arithmetic was wrong — cordon and let a human look,
    // rather than throttling a tenant who did nothing.
    await pool.query(`update nodes set disk_reserved_gb = 190 where hostname = 'data-1'`);
    const r = await runScan();
    expect(r.cordoned).toContain('data-1');
    const { rows } = await pool.query<{ status: string }>(
      `select status::text as status from nodes where hostname = 'data-1'`);
    expect(rows[0]!.status).toBe('cordoned');
  });
});
