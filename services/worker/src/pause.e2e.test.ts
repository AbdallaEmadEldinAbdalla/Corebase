import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore } from '@corebase/secrets';
import { SECRET_NAMES } from '@corebase/secrets';
import { createDocker, type Docker } from './docker.ts';
import { createRedis, createQueue, type Redis, type Queue, type ProvisioningJobData } from '@corebase/queue';
import { buildSagas } from './jobs/sagas.ts';
import { createIdleScan } from './idle-scan.ts';
import { registerNode } from './placement.ts';
import { containerName, poolerName, LABEL_MANAGED, LABEL_REF, networkName } from './container-spec.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P2c against a real node: pause, resume, and what must survive both.
 *
 * Phase 2's exit criterion 2 is "no data loss across 50 pause/resume cycles", and
 * the interesting word is *data*. A cycle that loses the port, the volume or the
 * password loses the connection string, which is data loss from where a customer
 * stands even though every byte in the database is intact. So the assertions here
 * are about the whole promise: the rows come back, and they come back at the same
 * address with the same credentials.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? new URL('../../../infra/docker/staging/certs', import.meta.url).pathname;
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';
/** Kept low: this file runs the full provisioning saga several times. */
const CYCLES = Number(process.env.CB_PAUSE_CYCLES ?? 3);

let pool: Pool; let docker: Docker; let secrets: ReturnType<typeof createSecretStore>;
let redis: Redis; let queue: Queue<ProvisioningJobData>;
let kekDir: string; let orgId: string; let up = false; let seq = 0;

const mkRef = () => 'q' + String(Date.now() % 100000) + String(++seq).padStart(14, 'x');

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'cb-p2c-'));
  writeFileSync(join(kekDir, 'k1.key'), randomBytes(32));
  try {
    pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 2000 });
    await pool.query('select 1');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    secrets = createSecretStore(pool, createEnvelope({ kekDir, kekId: 'k1' }));
    redis = createRedis(process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379');
    await redis.ping();
    queue = createQueue(redis);
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('P2C','p2c-test')
       on conflict (slug) do update set updated_at = now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    console.error('P2c pause e2e setup FAILED:', (err as Error).message);
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
  await queue?.close();
  await redis?.quit();
  await pool?.end();
  rmSync(kekDir, { recursive: true, force: true });
}, 120_000);

beforeEach(async () => {
  if (!up) return;
  // Containers first, then rows. Truncating the placement table hands the next
  // project the same port, and a container from the previous test is still bound
  // to it — which surfaces as "port is already allocated" from deep inside
  // container start, three tests later.
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id).catch(() => {});
  }
  await pool.query('truncate provisioning_jobs, project_databases, projects cascade');
  // Every node, not just ours — and status too. `registerNode` is a heartbeat and
  // deliberately will not un-cordon a node, so one that another file cordoned
  // stays cordoned and every test here fails with "no active node in region
  // eu-central". See rotation.e2e for the full reasoning; the short version is
  // that a file must declare the fixture it needs instead of inheriting one,
  // because vitest shards by file and adding a file reshuffles the shards.
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

async function runSaga(kind: string, projectId: string, log: string[] = []) {
  const steps = sagas()[kind]! as SagaStep<SagaContext>[];
  const job = { id: 'j', project_id: projectId } as unknown as JobRecord;
  for (const step of steps) {
    await step.run({ job, log: (m, e) => log.push(m + (e ? ' ' + JSON.stringify(e) : '')) });
  }
  return log;
}

async function newProject() {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (organization_id, ref, name, region, plan, status)
     values ($1, $2, $3, 'eu-central', 'free', 'creating') returning id`,
    [orgId, ref, ref]);
  await registerNode(pool, {
    hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200, address: HOST,
  });
  return { id: rows[0]!.id, ref };
}

/** The customer's view: connect on the direct port with the stored password. */
async function asCustomer<T>(projectId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const { rows } = await pool.query<{ port: number }>(
    `select port from project_databases where project_id = $1`, [projectId]);
  const password = await secrets.get(projectId, SECRET_NAMES.developer);
  const client = new Client({
    host: HOST, port: rows[0]!.port, user: 'developer', password,
    database: 'postgres', connectionTimeoutMillis: 5_000, ssl: false,
  });
  await client.connect();
  try { return await fn(client); } finally { await client.end().catch(() => {}); }
}

const t = (name: string, fn: () => Promise<void>, ms = 180_000) =>
  it(name, async () => {
    if (!up) throw new Error(
      'staging stack not reachable — bring it up with ./scripts/staging.sh up. ' +
      'This is the P2c done-signal and must not be skipped silently.');
    await fn();
  }, ms);

/**
 * RAM reserved on the node this project is actually placed on.
 *
 * Not `where hostname = 'data-1'`, which is what this was and what quietly broke:
 * another harness had registered a second node, `allocateNode` picks the emptiest
 * one, and the assertions were reading a node the projects were never on. Deriving
 * it from the placement row makes the test immune to whatever else has registered.
 */
async function nodeReserved(projectId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select n.ram_reserved_mb::int as n
       from project_databases d join nodes n on n.id = d.node_id
      where d.project_id = $1`, [projectId]);
  if (!rows[0]) throw new Error('no placement row — cannot read the node reservation');
  return rows[0].n;
}

describe('P2c — pause and resume on a real node', () => {
  t('pausing returns the RAM and keeps everything else', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const bookedWhileRunning = await nodeReserved(p.id);
    expect(bookedWhileRunning).toBe(350);          // D-174's Free budget

    const before = await pool.query<{ port: number; pooler_port: number; volume_name: string }>(
      `select port, pooler_port, volume_name from project_databases where project_id = $1`, [p.id]);

    await runSaga('pause_project', p.id);

    // The economic keystone: RAM back, disk and placement kept.
    expect(await nodeReserved(p.id)).toBe(0);
    const after = await pool.query<{
      port: number; pooler_port: number; volume_name: string; status: string;
      ram_booked_mb: number; container_id: string | null; pooler_container_id: string | null;
    }>(`select port, pooler_port, volume_name, status::text as status, ram_booked_mb,
               container_id, pooler_container_id
          from project_databases where project_id = $1`, [p.id]);
    expect(after.rows[0]!.status).toBe('paused');
    expect(after.rows[0]!.ram_booked_mb).toBe(0);
    // Same address after the cycle, which is what makes the connection string a
    // promise rather than a snapshot.
    expect(after.rows[0]!.port).toBe(before.rows[0]!.port);
    expect(after.rows[0]!.pooler_port).toBe(before.rows[0]!.pooler_port);
    expect(after.rows[0]!.volume_name).toBe(before.rows[0]!.volume_name);
    // Containers gone, not merely stopped — that is where the overhead goes.
    expect(after.rows[0]!.container_id).toBeNull();
    expect(after.rows[0]!.pooler_container_id).toBeNull();
    expect(await docker.inspectContainer(containerName(p.ref))).toBeUndefined();
    expect(await docker.inspectContainer(poolerName(p.ref))).toBeUndefined();
    // The volume and the network survive: they are what resume starts from.
    expect(await docker.volumeExists(before.rows[0]!.volume_name)).toBe(true);
    expect(await docker.networkExists(networkName(p.ref))).toBe(true);
  });

  t('pausing twice is not an error and does not double-credit the node', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    await runSaga('pause_project', p.id);
    expect(await nodeReserved(p.id)).toBe(0);
    // A crash between steps means a step runs twice. Crediting 350 MB again would
    // leave the node believing it has more memory than it has, which is the
    // direction that overloads a node rather than merely wasting it.
    await runSaga('pause_project', p.id);
    expect(await nodeReserved(p.id)).toBe(0);
  });

  t('a paused project cannot be reached, and resume brings back the same address', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    await asCustomer(p.id, async (c) => {
      await c.query(`create table survives(id int primary key, note text)`);
      await c.query(`insert into survives values (1, 'written before the pause')`);
    });

    await runSaga('pause_project', p.id);
    // Nothing is listening: the containers are gone.
    await expect(asCustomer(p.id, async (c) => c.query('select 1'))).rejects.toThrow();

    await runSaga('resume_project', p.id);
    expect(await nodeReserved(p.id)).toBe(350);
    const note = await asCustomer(p.id, async (c) => {
      const { rows } = await c.query<{ note: string }>(`select note from survives where id = 1`);
      return rows[0]!.note;
    });
    expect(note).toBe('written before the pause');
  });

  t('resume needs no WAL replay, because the pause shut Postgres down cleanly', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const log: string[] = [];
    await runSaga('pause_project', p.id, log);
    expect(log.join('\n')).toContain('no WAL to replay on resume');

    await runSaga('resume_project', p.id);
    // Proof rather than inference: a crash-recovered database logs redo. A clean
    // one does not, and that is the difference between a single-digit resume and
    // a slow one.
    const inspect = await docker.inspectContainer(containerName(p.ref));
    const { exitCode } = await docker.exec(inspect!.Id,
      ['sh', '-c', 'grep -qi "redo starts at" /var/lib/postgresql/data/pgdata/log/* 2>/dev/null && exit 1 || exit 0']);
    expect(exitCode, 'the resumed database replayed WAL — the pause was not clean').toBe(0);
  });

  t('EXIT CRITERION (P5b): a provisioned project has three containers and a live data API',
    async () => {
      const p = await newProject();
      await runSaga('provision_project', p.id);

      const { rows } = await pool.query<{
        postgrest_port: number | null; postgrest_admin_port: number | null;
        postgrest_container_id: string | null;
      }>(`select postgrest_port, postgrest_admin_port, postgrest_container_id
            from project_databases where project_id = $1`, [p.id]);
      const place = rows[0]!;
      expect(place.postgrest_container_id).toBeTruthy();
      // Adjacent by construction, so `7434`/`7435` is recognisable as one
      // project's while a human reads `docker ps`.
      expect(place.postgrest_admin_port).toBe(place.postgrest_port! + 1);

      // Three containers, all running and all labelled with the ref — which is
      // what `verify_gone` lists by, so a container missing the label is one the
      // purge would leave behind.
      const running = await docker.listContainers(`com.corebase.project.ref=${p.ref}`);
      const roles = running.map((c) => c.Labels?.['com.corebase.role']).sort();
      expect(roles).toEqual(['database', 'pooler', 'postgrest']);

      // And the data API actually answers. `/ready` rather than `/live`: the
      // failures this catches — a revoked catalogue grant, a missing pre-request
      // function — all produce a PostgREST that is alive and serving 503.
      const node = (await pool.query<{ address: string }>(
        `select n.address from nodes n
           join project_databases d on d.node_id = n.id where d.project_id = $1`,
        [p.id])).rows[0]!.address;
      const ready = await fetch(`http://${node}:${place.postgrest_admin_port}/ready`);
      expect(ready.status).toBe(200);

      // The restart policy is promoted only after the gate passes (D-184), which
      // matters more for PostgREST than for the others: it *exits* when it cannot
      // reach its database, so a policy attached before the gate turns a slow
      // start into a crash loop that hides the real error.
      const inspect = await docker.inspectContainer(place.postgrest_container_id!);
      expect(inspect!.HostConfig?.RestartPolicy?.Name).toBe('unless-stopped');
    }, 300_000);

  t('EXIT CRITERION (P5b): pause removes the data API, resume brings it back',
    async () => {
      const p = await newProject();
      await runSaga('provision_project', p.id);
      const before = (await pool.query<{ postgrest_admin_port: number }>(
        `select postgrest_admin_port from project_databases where project_id = $1`,
        [p.id])).rows[0]!.postgrest_admin_port;

      await runSaga('pause_project', p.id);
      // Gone, not merely stopped: a paused project gives its RAM back, and a
      // stopped-but-present container is a booking nobody credited.
      expect(await docker.listContainers(`com.corebase.project.ref=${p.ref}`)).toHaveLength(0);
      const paused = await pool.query<{ postgrest_container_id: string | null }>(
        `select postgrest_container_id from project_databases where project_id = $1`, [p.id]);
      expect(paused.rows[0]!.postgrest_container_id).toBeNull();

      await runSaga('resume_project', p.id);
      // Without the resume steps a resumed project would have a database and a
      // pooler and **no data API** — fully recovered in the dashboard and
      // answering nothing on /rest/v1.
      const roles = (await docker.listContainers(`com.corebase.project.ref=${p.ref}`))
        .map((c) => c.Labels?.['com.corebase.role']).sort();
      expect(roles).toEqual(['database', 'pooler', 'postgrest']);
      const node = (await pool.query<{ address: string }>(
        `select n.address from nodes n
           join project_databases d on d.node_id = n.id where d.project_id = $1`,
        [p.id])).rows[0]!.address;
      expect((await fetch(`http://${node}:${before}/ready`)).status).toBe(200);
    }, 300_000);

  // ── the idle scan: what actually triggers a pause ─────────────────────────

  const idleScan = (idleDays: number) => createIdleScan({
    pool, queue, docker, idleDays, probeTimeoutMs: 3_000,
  });
  const runIdleScan = (days: number) => idleScan(days).scanOnce({
    secretFor: (projectId) => secrets.get(projectId, SECRET_NAMES.developer),
    poolerSecretFor: (projectId) => secrets.get(projectId, SECRET_NAMES.poolerAuth),
  });

  t('leaves a project alone until it is past the window', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    // A project created moments ago has not been idle for a week. NULL
    // last_active_at means "never observed active", not "idle forever" — getting
    // that backwards would pause every project on the first scan after a deploy.
    const r = await runIdleScan(7);
    expect(r.checked).toBe(0);
    expect(r.paused).toBe(0);
  });

  t('EXIT CRITERION (P5a): auth traffic keeps a project out of the scan\'s reach',
    async () => {
      // Two projects, one scan, one difference between them. The first version of
      // this test ran a scan just to assert the project *was* a candidate, and
      // that scan paused it — a setup step with the side effect the test exists to
      // prevent. A controlled comparison needs no such ordering, and says more:
      // the signal is the only thing separating these two outcomes.
      const used = await newProject();
      const forgotten = await newProject();
      await runSaga('provision_project', used.id);
      await runSaga('provision_project', forgotten.id);
      await pool.query(
        `update project_databases set last_active_at = now() - interval '30 days'
          where project_id = any($1::uuid[])`, [[used.id, forgotten.id]]);

      // Exactly what `resolveProject` does on every data-plane request. Before
      // P5a nothing did this, and a project whose users only signed up and logged
      // in was paused under them: the auth module's connections open as
      // `corebase_auth`, and the scan counts `developer` alone.
      const { createTrafficMeter } = await import(
        '@corebase/api/modules/project-auth/traffic.ts');
      createTrafficMeter(pool).seen(used.id);
      await new Promise((r) => setTimeout(r, 250));

      await runIdleScan(7);

      const status = async (id: string) => (await pool.query<{ status: string }>(
        `select status from projects where id = $1`, [id])).rows[0]!.status;
      // The signal writes `last_active_at`, which is the column the scan already
      // filters candidates on — so a project touched by traffic stops being a
      // candidate and the scan needed no change at all.
      expect(await status(used.id)).toBe('ready');
      // …and its twin, identical but for the signal, is on its way down.
      expect(['pausing', 'paused']).toContain(await status(forgotten.id));
    });

  t('does not pause a project with a live customer connection', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    // Backdate the clock so the project qualifies on age alone; the open
    // connection is the only thing that should save it.
    await pool.query(
      `update project_databases set last_active_at = now() - interval '30 days'
        where project_id = $1`, [p.id]);

    const { rows } = await pool.query<{ port: number }>(
      `select port from project_databases where project_id = $1`, [p.id]);
    const password = await secrets.get(p.id, SECRET_NAMES.developer);
    const held = new Client({
      host: HOST, port: rows[0]!.port, user: 'developer', password,
      database: 'postgres', connectionTimeoutMillis: 5_000, ssl: false,
    });
    await held.connect();
    try {
      const r = await runIdleScan(7);
      expect(r.checked).toBe(1);
      expect(r.active, 'a project with an open customer connection was not seen as active').toBe(1);
      expect(r.paused, 'a project in use was scheduled for pause').toBe(0);
      // The clock restarted, which is what stops a busy project drifting toward a
      // pause between scans.
      const after = await pool.query<{ recent: boolean }>(
        `select last_active_at > now() - interval '1 minute' as recent
           from project_databases where project_id = $1`, [p.id]);
      expect(after.rows[0]!.recent).toBe(true);
    } finally {
      await held.end().catch(() => {});
    }
  });

  t('schedules a pause for a project past the window with nobody connected', async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    await pool.query(
      `update project_databases set last_active_at = now() - interval '30 days'
        where project_id = $1`, [p.id]);

    const r = await runIdleScan(7);
    expect(r.checked).toBe(1);
    expect(r.paused).toBe(1);
    const { rows } = await pool.query<{ job_type: string; key: string; status: string }>(
      `select j.job_type, j.idempotency_key as key, p.status::text as status
         from provisioning_jobs j join projects p on p.id = j.project_id
        where j.project_id = $1 and j.job_type = 'pause_project'`, [p.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pausing');

    // Twice must not produce two pauses: the key is derived from the project, and
    // a scan that runs hourly on two workers would otherwise queue duplicates.
    const again = await runIdleScan(7);
    expect(again.paused).toBe(0);
  });

  t('the scan does not count our own machinery as customer traffic', async () => {
    // The health probe, the admin connections that create roles, and the pooler's
    // auth_query lookups all appear in pg_stat_activity. Counting them would mean
    // no project is ever idle, which is the failure that makes the free tier
    // unaffordable — so this asserts the *provisioning path itself* leaves nothing
    // behind that reads as activity.
    const p = await newProject();
    await runSaga('provision_project', p.id);
    await pool.query(
      `update project_databases set last_active_at = now() - interval '30 days'
        where project_id = $1`, [p.id]);
    const r = await runIdleScan(7);
    expect(r, 'internal connections were counted as customer activity')
      .toMatchObject({ checked: 1, active: 0, unreachable: 0, paused: 1 });
  });

  t(`survives ${CYCLES} pause/resume cycles with the data and the address intact`, async () => {
    const p = await newProject();
    await runSaga('provision_project', p.id);
    const first = await pool.query<{ port: number }>(
      `select port from project_databases where project_id = $1`, [p.id]);
    await asCustomer(p.id, async (c) => {
      await c.query(`create table cycles(n int primary key)`);
    });

    for (let i = 1; i <= CYCLES; i++) {
      await runSaga('pause_project', p.id);
      expect(await nodeReserved(p.id), `cycle ${i}: RAM not returned`).toBe(0);
      await runSaga('resume_project', p.id);
      expect(await nodeReserved(p.id), `cycle ${i}: RAM not re-booked`).toBe(350);
      // Write on every cycle, so a lost volume shows up as a missing row rather
      // than as an empty table nobody notices.
      await asCustomer(p.id, async (c) => {
        await c.query(`insert into cycles values ($1)`, [i]);
      });
    }

    const seen = await asCustomer(p.id, async (c) => {
      const { rows } = await c.query<{ n: number }>(`select n from cycles order by n`);
      return rows.map((r) => r.n);
    });
    expect(seen).toEqual(Array.from({ length: CYCLES }, (_, i) => i + 1));
    const last = await pool.query<{ port: number }>(
      `select port from project_databases where project_id = $1`, [p.id]);
    expect(last.rows[0]!.port).toBe(first.rows[0]!.port);
  }, 600_000);
});
