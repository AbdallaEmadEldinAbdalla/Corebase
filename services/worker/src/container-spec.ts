import { createHmac } from 'node:crypto';
import type { ContainerSpec } from './docker.ts';

/**
 * The container spec for a project's Postgres. Pure function, so what we ask
 * Docker for is testable without Docker.
 */

export const IMAGE = process.env.CB_PG_IMAGE ?? 'corebase/postgres:17.5';
export const CONTAINER_PREFIX = 'cb-';
export const LABEL_REF = 'com.corebase.project.ref';
export const LABEL_MANAGED = 'com.corebase.managed';

export const containerName = (ref: string) => `${CONTAINER_PREFIX}${ref}`;

/**
 * The project's private network, and the name Postgres answers to on it.
 *
 * Derived from the ref rather than stored, like the container name and unlike the
 * volume: there is exactly one network per project and nothing allocates it, so a
 * column would be a second place for the same fact to be wrong.
 *
 * `db` is the alias because that is what the rendered configs say — the pooler's
 * `pgbouncer.ini` uses `host=db` and PostgREST's `db-uri` will too
 * ([pooling §3–§5](../../../docs/03-database-platform/02-connection-pooling.md)).
 * Keeping the alias stable means those templates never learn a project's ref.
 */
export const networkName = (ref: string) => `${CONTAINER_PREFIX}${ref}-net`;
export const DB_ALIAS = 'db';

/**
 * Bootstrap superuser password: HMAC(secret, project_id).
 *
 * Deterministic on purpose. The container is created in T5d but real
 * credentials are not stored until T5e, so a crash between the two must not
 * leave a database whose password nobody knows. Deriving it means any retry
 * recomputes the same value without storing a plaintext secret anywhere.
 *
 * This is a BOOTSTRAP credential: T5e rotates it and stores the result under
 * envelope encryption (D-035). It never reaches a customer.
 */
export function bootstrapPassword(secret: string, projectId: string): string {
  if (!secret || secret.length < 16) {
    throw new Error('CB_BOOTSTRAP_SECRET must be at least 16 characters');
  }
  return createHmac('sha256', secret).update(`pgboot:${projectId}`).digest('hex').slice(0, 32);
}

export interface SpecArgs {
  ref: string;
  projectId: string;
  volumeName: string;
  hostPort: number;
  ramLimitMb: number;
  cpuLimit?: number;      // whole cores, e.g. 0.5
  bootstrapSecret: string;
  image?: string;
  restartPolicy?: string;
  /** Absent keeps the pre-Phase-2 behaviour: published port, no private network. */
  networkName?: string;
}

export function buildContainerSpec(a: SpecArgs): ContainerSpec {
  const memBytes = a.ramLimitMb * 1024 * 1024;
  return {
    Image: a.image ?? IMAGE,
    Env: [
      `POSTGRES_PASSWORD=${bootstrapPassword(a.bootstrapSecret, a.projectId)}`,
      'POSTGRES_DB=postgres',
      'PGDATA=/var/lib/postgresql/data/pgdata',
    ],
    Labels: {
      [LABEL_REF]: a.ref,
      [LABEL_MANAGED]: 'true',
    },
    HostConfig: {
      // cgroup limits from day one (D-055). MemorySwap == Memory disables swap:
      // a tenant that swaps degrades every neighbour on the node.
      Memory: memBytes,
      MemorySwap: memBytes,
      NanoCpus: Math.round((a.cpuLimit ?? 0.5) * 1e9),
      // Created with NO restart policy on purpose (D-184): a container that
      // fails to initialise would otherwise flap forever, burning node CPU and
      // hiding the failure behind a perpetual "restarting" state. wait_healthy
      // promotes it to unless-stopped once the database actually answers.
      RestartPolicy: { Name: a.restartPolicy ?? 'no' },
      Mounts: [{ Type: 'volume', Source: a.volumeName, Target: '/var/lib/postgresql/data' }],
      PortBindings: { '5432/tcp': [{ HostPort: String(a.hostPort) }] },
    },
    ExposedPorts: { '5432/tcp': {} },
    // The published host port stays. The private network is how the pooler and
    // later PostgREST reach Postgres; the published port is how a *customer*
    // reaches it directly, and D-015's DIRECT_DATABASE_URL depends on it.
    ...(a.networkName
      ? { NetworkingConfig: { EndpointsConfig: { [a.networkName]: { Aliases: [DB_ALIAS] } } } }
      : {}),
  };
}
