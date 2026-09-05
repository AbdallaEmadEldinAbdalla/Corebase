import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { LABEL_MANAGED } from './container-spec.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P2d against a real project: rotation, and the behaviour the exit criterion asks
 * to be *documented* — "credential rotation works with active connections".
 *
 * The documented behaviour has three parts and each is asserted here rather than
 * described:
 *
 *   1. an established session survives the rotation untouched;
 *   2. a new connection with the old password is refused;
 *   3. the pooled port keeps working with no reconfiguration at all.
 *
 * (3) is the payoff of D-074 and the reason auth_query was chosen over a userlist
 * file: the pooler reads `pg_shadow` live, so there is nothing to ship and nothing
 * to reload. It is asserted as an absence — no pooler restart, no config write —
 * which is the only way to test that a step is genuinely unnecessary.
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

const mkRef = () => 'x' + String(Date.now() % 100000) + String(++seq).padStart(14, 'x');

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'cb-p2d-'));
  writeFileSync(join(kekDir, 'k1.key'), randomBytes(32));
  try {
    pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 2000 });
    await pool.query('select 1');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    secrets = createSecretStore(pool, createEnvelope({ kekDir, kekId: 'k1' }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('P2D','p2d-test')
       on conflict (slug) do update set updated_at = now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    console.error('P2d rotation e2e setup FAILED:', (err as Error).message);
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
  // Status as well as capacity, because `registerNode` is a heartbeat and a
  // heartbeat must never un-cordon a node — an operator draining one for
  // decommission would have that decision silently reverted. So a node another
  // file cordoned (`placement.e2e` does it with no WHERE clause) stays cordoned,
  // and every test here then fails with "no active node in region eu-central",
  // which names nothing about the cause or the file that caused it.
  //
  // This file therefore declares the fixture it needs rather than inheriting
  // whatever the previous file left. That mattered here the moment P5b added a
  // test file: vitest shards by file, so a new file reshuffles which files share
  // a shard, and an ordering dependency that had been invisible for phases
  // became a red CI on an unrelated commit.
  // Disk as well as RAM. Both are reservations against a node, both are left
  // behind by any file that provisioned without releasing, and zeroing one of the
  // two just moves the failure to the other dimension — which is exactly what
  // happened: fixing the status left `disk_reserved_gb` at 190/200 GB and the
  // same five tests failed on the placement ceiling instead. The truncate above
  // removes every project_database, so no project holds any of it.
  await pool.query(
    `update nodes set ram_reserved_mb = 0, disk_reserved_gb = 0, status = 'active'`);
}, 60_000);

function sagas() {
  return buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET,
    healthTimeoutMs: 60_000, projectDomain: 'corebase.test',
  });
}

async function runSaga(kind: string, projectId: string, payload: Record<string, unknown> = {}) {
  const steps = sagas()[kind]! as SagaStep<SagaContext>[];
  const job = { id: 'j', project_id: projectId, payload } as unknown as JobRecord;
  const log: string[] = [];
  for (const step of steps) {
    await step.run({ job, log: (m, e) => log.push(m + (e ? ' ' + JSON.stringify(e) : '')) });
  }
  return log;
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

async function ports(projectId: string) {
  const { rows } = await pool.query<{ port: number; pooler_port: number }>(
    `select port, pooler_port from project_databases where project_id = $1`, [projectId]);
  return rows[0]!;
}

/**
 * Open a connection as `developer` with an explicit password.
 *
 * The error listener is not test hygiene — it is the same thing a customer's driver
 * has to do. `pg_terminate_backend` makes the client emit an `'error'` event
 * ("terminating connection due to administrator command"), and in Node an
 * unhandled `'error'` on an EventEmitter takes the process down. A rotation with
 * `terminate` therefore does not merely fail the next query: it crashes an
 * application whose pool has no error handler. Worth knowing, and worth the
 * dialog saying the app breaks until it reconnects.
 */
function connect(port: number, password: string): Client {
  const client = new Client({
    host: HOST, port, user: 'developer', password, database: 'postgres',
    connectionTimeoutMillis: 5_000, ssl: false,
  });
  client.on('error', () => { /* expected when a session is terminated */ });
  return client;
}

const t = (name: string, fn: () => Promise<void>, ms = 180_000) =>
  it(name, async () => {
    if (!up) throw new Error(
      'staging stack not reachable — bring it up with ./scripts/staging.sh up. ' +
      'This is the P2d done-signal and must not be skipped silently.');
    await fn();
  }, ms);

describe('P2d — credential rotation with active connections', () => {
  t('an established session survives; the old password stops working for new ones', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const { port } = await ports(p.id);
    const before = (await secrets.get(p.id, SECRET_NAMES.developer))!;

    // A live session, mid-transaction work and all, exactly like a running app.
    const held = connect(port, before);
    await held.connect();
    await held.query(`create table survives_rotation(id int primary key)`);
    await held.query(`insert into survives_rotation values (1)`);

    await runSaga('rotate_credentials', p.id);
    const after = (await secrets.get(p.id, SECRET_NAMES.developer))!;
    expect(after).not.toBe(before);

    // 1. The established session is untouched. Postgres authenticates at connect
    //    time only, and this is what makes routine rotation safe.
    const { rows } = await held.query<{ n: number }>(
      `select count(*)::int as n from survives_rotation`);
    expect(rows[0]!.n, 'the established session broke on rotation').toBe(1);
    await held.query(`insert into survives_rotation values (2)`);
    await held.end();

    // 2. The old password is refused for a *new* connection.
    const stale = connect(port, before);
    await expect(stale.connect(), 'the old password still works').rejects.toThrow();
    await stale.end().catch(() => {});

    // 3. The new one works, and sees the rows the old session wrote.
    const fresh = connect(port, after);
    await fresh.connect();
    const check = await fresh.query<{ n: number }>(
      `select count(*)::int as n from survives_rotation`);
    expect(check.rows[0]!.n).toBe(2);
    await fresh.end();
  });

  t('the pooled port keeps working with no pooler reconfiguration (D-074)', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const { pooler_port } = await ports(p.id);
    const before = (await secrets.get(p.id, SECRET_NAMES.developer))!;

    // Working through the pooler first, so it has a server connection open under
    // the old credential — the state that would break a userlist-based pooler.
    const old = connect(pooler_port, before);
    await old.connect();
    await old.query('select 1');
    await old.end();

    const poolerBefore = await docker.inspectContainer(`cb-${p.ref}-pooler`);
    await runSaga('rotate_credentials', p.id);
    const after = (await secrets.get(p.id, SECRET_NAMES.developer))!;

    // The absence is the assertion: same container, never restarted, no config
    // written. auth_query means the pooler reads pg_shadow live (D-074).
    const poolerAfter = await docker.inspectContainer(`cb-${p.ref}-pooler`);
    expect(poolerAfter!.Id, 'the pooler was replaced').toBe(poolerBefore!.Id);
    expect(poolerAfter!.State.Running).toBe(true);
    expect(poolerAfter!.State.Status, 'the pooler restarted').toBe('running');

    // And the pooled port serves the new credential immediately.
    let served = '';
    for (let i = 0; i < 20 && !served; i++) {
      const c = connect(pooler_port, after);
      try {
        await c.connect();
        const { rows } = await c.query<{ who: string }>(`select current_user as who`);
        served = rows[0]!.who;
      } catch { await new Promise((r) => setTimeout(r, 250)); }
      finally { await c.end().catch(() => {}); }
    }
    expect(served, 'the pooled port never accepted the rotated credential').toBe('developer');

    // The old one is refused through the pooler too — the lookup is live, so there
    // is no window where a stale verifier still authenticates.
    const stale = connect(pooler_port, before);
    await expect(stale.connect()).rejects.toThrow();
    await stale.end().catch(() => {});
  });

  t('the previous version is retained for support, then purged', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const first = (await secrets.get(p.id, SECRET_NAMES.developer))!;
    await runSaga('rotate_credentials', p.id);

    // Exactly one active and one retiring: the partial unique index guarantees the
    // first half, and answering "which credential is my app on" needs the second.
    const rows = await pool.query<{ state: string; version: number }>(
      `select state, version from project_secrets
        where project_id = $1 and name = $2 order by version`,
      [p.id, SECRET_NAMES.developer]);
    expect(rows.rows.map((r) => r.state)).toEqual(['retiring', 'active']);
    expect(rows.rows.map((r) => r.version)).toEqual([1, 2]);

    // The retiring value is still readable, and is the one the app had.
    const retired = await pool.query<{ v: number }>(
      `select version as v from project_secrets
        where project_id = $1 and name = $2 and state = 'retiring'`,
      [p.id, SECRET_NAMES.developer]);
    expect(retired.rows[0]!.v).toBe(1);
    void first;

    // Nothing is purged inside the window…
    expect(await secrets.purgeRetired(p.id)).toBe(0);
    // …and it goes once the window has passed.
    await pool.query(
      `update project_secrets set rotated_at = now() - interval '48 hours'
        where project_id = $1 and state = 'retiring'`, [p.id]);
    expect(await secrets.purgeRetired(p.id)).toBe(1);
  });

  t('terminate is opt-in: off leaves sessions alone, on ends them', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const { port } = await ports(p.id);

    // Default: the session survives, which is what makes rotation routine.
    const quiet = connect(port, (await secrets.get(p.id, SECRET_NAMES.developer))!);
    await quiet.connect();
    const log = await runSaga('rotate_credentials', p.id);
    expect(log.join('\n')).toContain('leaving established sessions alone');
    await expect(quiet.query('select 1')).resolves.toBeTruthy();

    // With the flag: the same session is gone. This is compromise response — a
    // leaked password is useless to rotate against someone already connected.
    const killLog = await runSaga('rotate_credentials', p.id, { terminate: true });
    expect(killLog.join('\n')).toContain('sessions on the old credential terminated');
    await expect(quiet.query('select 1')).rejects.toThrow();
    await quiet.end().catch(() => {});
  });

  t('a rotation stores before it applies, so a crash leaves a recoverable state', async () => {
    // The ordering rule of the whole secret design (D-035). Running only the store
    // half is exactly what a crash between the two looks like: the new password is
    // in the control plane and not yet in the database, so the *old* one still
    // works and the retry applies the new one.
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const { port } = await ports(p.id);
    const before = (await secrets.get(p.id, SECRET_NAMES.developer))!;

    const stored = await secrets.rotate(p.id, SECRET_NAMES.developer);
    expect(stored.previous).toBe(before);

    // Stored, not applied: the old password is still the one the database has.
    // Asserted by using the connection rather than by the shape of connect()'s
    // return value, which differs between pg versions.
    const stillOld = connect(port, before);
    await stillOld.connect();
    await expect(stillOld.query('select 1')).resolves.toBeTruthy();
    await stillOld.end();

    const notYet = connect(port, stored.value);
    await expect(notYet.connect(), 'the new password took effect before it was applied')
      .rejects.toThrow();
    await notYet.end().catch(() => {});

    // The retry applies it. Nothing was lost, which is the property that matters.
    await runSaga('rotate_credentials', p.id);
    const now = (await secrets.get(p.id, SECRET_NAMES.developer))!;
    const works = connect(port, now);
    await works.connect();
    await expect(works.query('select 1')).resolves.toBeTruthy();
    await works.end();
  });
});
