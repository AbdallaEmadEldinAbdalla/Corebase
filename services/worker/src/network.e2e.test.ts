import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDocker, type Docker } from './docker.ts';
import { networkName, LABEL_MANAGED, LABEL_REF, DB_ALIAS, IMAGE } from './container-spec.ts';

/**
 * P2a against a real data node.
 *
 * The claim this file exists to prove is the one the unit test cannot: that a
 * container on the project network can **resolve `db`** and open a TCP connection
 * to it. Everything downstream — the pooler's `host=db`, PostgREST's `db-uri` —
 * is built on that single fact, and asserting the spec contains an alias proves
 * only that we asked for it.
 */
const CERT_DIR = new URL('../../../infra/docker/staging/certs', import.meta.url).pathname;
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const REF = 'p2atestnetworkrefxx';
const NET = networkName(REF);

let docker: Docker;
let up = false;

beforeAll(async () => {
  try {
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    up = true;
  } catch (err) {
    console.error('P2a network e2e setup FAILED:', (err as Error).message);
    up = false;
  }
}, 20_000);

afterAll(async () => {
  if (!up) return;
  // Clean up in dependency order; a network with an attached container will not go.
  for (const name of [`cb-${REF}-probe`, `cb-${REF}`]) {
    const c = await docker.inspectContainer(name).catch(() => undefined);
    if (c) await docker.removeContainer(c.Id, true).catch(() => {});
  }
  await docker.removeNetwork(NET).catch(() => {});
  // Release the client's keep-alive sockets. Each test file builds its own Docker
  // client, so without this every file leaves up to maxSockets parked connections
  // to the node for the rest of the run — which is how the node's listener ended
  // up wedged even after the agent was bounded (D-230).
  docker?.close?.();
});

const t = (name: string, fn: () => Promise<void>, ms = 30_000) =>
  it(name, async () => {
    if (!up) throw new Error(
      'data node not reachable — bring it up with ./scripts/staging.sh up. ' +
      'This is the P2a done-signal and must not be skipped silently.');
    await fn();
  }, ms);

describe('P2a — the project network, on a real node', () => {
  t('creating it twice is not an error', async () => {
    await docker.createNetwork(NET, { [LABEL_REF]: REF, [LABEL_MANAGED]: 'true' });
    expect(await docker.networkExists(NET)).toBe(true);
    // The Engine has no create-if-absent, and two workers can race one provision.
    await docker.createNetwork(NET, { [LABEL_REF]: REF, [LABEL_MANAGED]: 'true' });
    const inspect = await docker.inspectNetwork(NET);
    expect(inspect?.Labels?.[LABEL_REF]).toBe(REF);
  });

  t('the network is listable by label, which is how reconciliation finds orphans', async () => {
    const found = await docker.listNetworks(`${LABEL_MANAGED}=true`);
    expect(found.map((n) => n.Name)).toContain(NET);
  });

  t('a container on the network resolves `db` and connects to Postgres', async () => {
    // A real Postgres, aliased db, exactly as buildContainerSpec does it.
    const pgName = `cb-${REF}`;
    if (!(await docker.inspectContainer(pgName))) {
      const id = await docker.createContainer(pgName, {
        Image: IMAGE,
        Env: ['POSTGRES_PASSWORD=probe-password-long-enough', 'POSTGRES_DB=postgres',
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

    // Wait for it to answer, using the same probe the provisioning saga uses.
    const pg = await docker.inspectContainer(pgName);
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      const { exitCode } = await docker.exec(pg!.Id,
        ['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-q']);
      if (exitCode === 0) ready = true;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(ready, 'the probe database never became ready').toBe(true);

    // Now the actual claim: another container on the same network reaches `db`.
    // Using the project image because it already has psql, and using the alias
    // rather than an IP because the alias is what every rendered config says.
    const probeName = `cb-${REF}-probe`;
    const probeId = await docker.createContainer(probeName, {
      Image: IMAGE,
      Env: ['PGPASSWORD=probe-password-long-enough'],
      Cmd: ['sh', '-c', `for i in $(seq 1 30); do psql -h ${DB_ALIAS} -p 5432 -U postgres ` +
            `-d postgres -tAc "select 'reached-db-by-alias'" && exit 0; sleep 1; done; exit 1`],
      Labels: { [LABEL_REF]: REF, [LABEL_MANAGED]: 'true' },
      HostConfig: {
        Memory: 134217728, MemorySwap: 134217728, NanoCpus: 250000000,
        RestartPolicy: { Name: 'no' }, Mounts: [], PortBindings: {},
      },
      ExposedPorts: {},
      NetworkingConfig: { EndpointsConfig: { [NET]: {} } },
    });
    await docker.startContainer(probeId);

    let exit: number | undefined;
    for (let i = 0; i < 60; i++) {
      const st = await docker.inspectContainer(probeId);
      if (st && !st.State.Running) { exit = st.State.ExitCode; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(exit, 'the probe container never exited').toBeDefined();
    expect(exit, `psql -h ${DB_ALIAS} failed inside the network`).toBe(0);
  }, 120_000);

  t('a network with a container attached refuses removal', async () => {
    // Which is why remove_network comes after remove_container in the purge saga.
    // If Docker ever started allowing this, the ordering comment would be wrong
    // and nothing else would notice.
    await expect(docker.removeNetwork(NET)).rejects.toThrow();
  });
});
