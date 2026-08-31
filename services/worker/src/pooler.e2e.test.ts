import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { createDocker, type Docker } from './docker.ts';
import {
  buildPoolerSpec, networkName, poolerName, LABEL_MANAGED, LABEL_REF,
  DB_ALIAS, IMAGE, POOLER_IMAGE,
} from './container-spec.ts';

/**
 * P2b against a real node: the pooled path, and the boundary around it.
 *
 * The claim worth proving here is not "PgBouncer starts" — it is that a customer
 * role reaches Postgres *through* the pooler using auth_query, and that no internal
 * role can. The second half is the one that would fail silently: a lookup function
 * without its allowlist works perfectly for `developer` and also hands out the
 * superuser's verifier, and nothing in a happy-path test would notice.
 */
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? new URL('../../../infra/docker/staging/certs', import.meta.url).pathname;
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const REF = 'p2bpoolertestrefxxxx';
const NET = networkName(REF);
const PG = `cb-${REF}`;
const POOL = poolerName(REF);
const HOST_PORT = 6461;                  // inside the published pooler range
const SUPER = 'p2b-superuser-password';
const DEV = 'p2b-developer-password';
const POOLER_PW = 'p2b-pooler-password';

let docker: Docker;
let up = false;

beforeAll(async () => {
  try {
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    up = true;
  } catch (err) {
    console.error('P2b pooler e2e setup FAILED:', (err as Error).message);
    up = false;
  }
}, 20_000);

afterAll(async () => {
  if (!up) return;
  for (const n of [POOL, PG]) {
    const c = await docker.inspectContainer(n).catch(() => undefined);
    if (c) await docker.removeContainer(c.Id, true).catch(() => {});
  }
  await docker.removeNetwork(NET).catch(() => {});
  docker.close();
});

const t = (name: string, fn: () => Promise<void>, ms = 90_000) =>
  it(name, async () => {
    if (!up) throw new Error(
      'data node not reachable — bring it up with ./scripts/staging.sh up. ' +
      'This is the P2b done-signal and must not be skipped silently.');
    await fn();
  }, ms);

/** Connect through the pooler as `role`; returns the row, or throws. */
async function throughPooler(role: string, password: string): Promise<string> {
  const client = new Client({
    host: HOST, port: HOST_PORT, user: role, password,
    database: 'postgres', connectionTimeoutMillis: 4_000, ssl: false,
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ who: string }>(
      `SELECT current_user || '@' || inet_server_port() AS who`);
    return rows[0]!.who;
  } finally {
    await client.end().catch(() => {});
  }
}

describe('P2b — the pooled path on a real node', () => {
  t('brings up a database and its pooler', async () => {
    await docker.createNetwork(NET, { [LABEL_REF]: REF, [LABEL_MANAGED]: 'true' });

    if (!(await docker.inspectContainer(PG))) {
      const id = await docker.createContainer(PG, {
        Image: IMAGE,
        Env: [`POSTGRES_PASSWORD=${SUPER}`, 'POSTGRES_DB=postgres',
              'PGDATA=/var/lib/postgresql/data/pgdata'],
        Labels: { [LABEL_REF]: REF, [LABEL_MANAGED]: 'true' },
        HostConfig: {
          Memory: 268435456, MemorySwap: 268435456, NanoCpus: 500000000,
          RestartPolicy: { Name: 'no' }, Mounts: [], PortBindings: {},
        },
        ExposedPorts: { '5432/tcp': {} },
        NetworkingConfig: { EndpointsConfig: { [NET]: { Aliases: [DB_ALIAS] } } },
      });
      await docker.startContainer(id);
    }
    const pg = await docker.inspectContainer(PG);
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      const { exitCode } = await docker.exec(pg!.Id,
        ['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-q']);
      if (exitCode === 0) ready = true; else await new Promise((r) => setTimeout(r, 500));
    }
    expect(ready, 'the database never became ready').toBe(true);

    // The two things the control plane does at provision time: create the customer
    // role, and give the pooler its own password.
    const { exitCode } = await docker.exec(pg!.Id, ['sh', '-c',
      `PGPASSWORD='${SUPER}' psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -c ` +
      `"create role developer login password '${DEV}'; ` +
      `grant create, usage on schema public to developer; ` +
      `alter role pgbouncer_auth password '${POOLER_PW}';"`]);
    expect(exitCode, 'role setup failed inside the container').toBe(0);

    const poolId = await docker.createContainer(POOL, buildPoolerSpec({
      ref: REF, networkName: NET, hostPort: HOST_PORT, authPassword: POOLER_PW,
    }));
    await docker.startContainer(poolId);
    const pool = await docker.inspectContainer(POOL);
    expect(pool?.State.Running, 'the pooler is not running').toBe(true);
  }, 180_000);

  t('a customer role reaches Postgres through the pooler', async () => {
    let who = '';
    for (let i = 0; i < 30 && !who; i++) {
      try { who = await throughPooler('developer', DEV); }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    // Proves the whole chain: PgBouncer accepted the client, authenticated itself
    // as pgbouncer_auth, resolved developer's verifier through the lookup function,
    // and proxied a real transaction to Postgres on 5432.
    expect(who).toBe('developer@5432');
  });

  t('the pooled port cannot reach any internal role', async () => {
    // The allowlist inside corebase.pgbouncer_lookup is the boundary (D-074): even
    // a fully compromised pooler cannot resolve credentials for these. Tested with
    // the *correct* superuser password, so a pass means the lookup refused rather
    // than the password being wrong.
    for (const role of ['postgres', 'authenticator', 'corebase_admin', 'pgbouncer_auth']) {
      await expect(throughPooler(role, SUPER),
        `${role} was reachable through the pooled port`).rejects.toThrow();
    }
    // …and the one role that should work still does, so the test above is not
    // passing because the pooler is simply broken.
    expect(await throughPooler('developer', DEV)).toBe('developer@5432');
  }, 120_000);

  t('many client connections share few server connections', async () => {
    // The point of transaction mode: 200 client slots against 8 server slots. If
    // this ever reports one backend per client, the pool mode has regressed to
    // session and the density model is wrong.
    const pids = await Promise.all(Array.from({ length: 12 }, async () => {
      const c = new Client({
        host: HOST, port: HOST_PORT, user: 'developer', password: DEV,
        database: 'postgres', connectionTimeoutMillis: 5_000, ssl: false,
      });
      await c.connect();
      try {
        const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        return rows[0]!.pid;
      } finally { await c.end().catch(() => {}); }
    }));
    const distinct = new Set(pids);
    expect(pids).toHaveLength(12);
    // default_pool_size 6 + reserve_pool_size 2.
    expect(distinct.size, `12 clients used ${distinct.size} backends`).toBeLessThanOrEqual(8);
  }, 120_000);
});
