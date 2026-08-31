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
  };
}
