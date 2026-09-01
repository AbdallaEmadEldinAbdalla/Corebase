import { createHmac } from 'node:crypto';
import type { ContainerSpec } from './docker.ts';

/**
 * The container spec for a project's Postgres. Pure function, so what we ask
 * Docker for is testable without Docker.
 */

export const IMAGE = process.env.CB_PG_IMAGE ?? 'corebase/postgres:17.5';
export const CONTAINER_PREFIX = 'cb-';

/* ------------------------------------------------------------------ *
 * The rest of D-055's noisy-neighbour walls (P2f).
 *
 * Memory and CPU were set from day one. These are the axes that were still
 * open: process count and disk I/O.
 * ------------------------------------------------------------------ */

/**
 * Process ceiling per project container (cgroup v2 `pids.max`).
 *
 * Postgres forks a backend per connection, so this has to clear
 * `max_connections` (20) plus the postmaster and its auxiliary processes —
 * checkpointer, background writer, WAL writer, archiver, autovacuum launcher and
 * its workers, the stats collector, the logger — plus room for a maintenance
 * shell. Around 35 in normal operation; 256 is generous headroom.
 *
 * The wall is not for Postgres, which is well-behaved about this. It is for
 * everything else that can run inside the container once someone is in it: a
 * fork bomb in a `COPY ... PROGRAM` or a compromised extension exhausts the
 * *node's* pid namespace, and a node that cannot fork cannot run any tenant's
 * database, or the reconciler that would notice.
 */
export const PIDS_LIMIT = Number(process.env.CB_PIDS_LIMIT ?? 256);

/**
 * Relative disk-I/O share (cgroup v2 `io.weight`, 10–1000, Docker's default 500).
 *
 * Weight rather than a hard IOPS cap, because a hard cap has to name a block
 * device and the device a project's volume lives on is a property of the node,
 * not of the project. `CB_IO_DEVICE` supplies it where an operator knows it, and
 * `ioDeviceLimits` below turns it into the free tier's read/write ceilings; where
 * it is unset, the weight alone still keeps one tenant's checkpoint storm from
 * starving its neighbours — it just does not cap the absolute rate.
 *
 * Free tier sits below the default so a paid project wins a contended disk. That
 * is the whole intent: proportional, so an idle fleet gives a free project the
 * full device, and a busy one gives it a smaller slice.
 */
export const PLAN_IO_WEIGHT: Record<string, number> = {
  free: 200,
  pro: 500,
  team: 500,
  enterprise: 800,
};

/** Free tier's absolute I/O ceiling in bytes/s, applied only when the device is known. */
export const FREE_IO_BPS = Number(process.env.CB_FREE_IO_BPS ?? 50 * 1024 * 1024);

/**
 * Per-device byte-rate caps for a plan, or an empty pair when no device is
 * configured.
 *
 * Returning nothing rather than guessing a device is deliberate. Docker rejects
 * a `BlkioDeviceWriteBps` entry whose path is not a block device on the node,
 * which would turn a wrong guess into a provisioning failure for every project —
 * a much worse outcome than an uncapped absolute rate behind a weight that still
 * works.
 */
export function ioDeviceLimits(plan: string, device = process.env.CB_IO_DEVICE): {
  BlkioDeviceReadBps?: Array<{ Path: string; Rate: number }>;
  BlkioDeviceWriteBps?: Array<{ Path: string; Rate: number }>;
} {
  if (!device || plan !== 'free') return {};
  return {
    BlkioDeviceReadBps: [{ Path: device, Rate: FREE_IO_BPS }],
    BlkioDeviceWriteBps: [{ Path: device, Rate: FREE_IO_BPS }],
  };
}
export const LABEL_REF = 'com.corebase.project.ref';
export const LABEL_MANAGED = 'com.corebase.managed';
/** Which of a project's containers this is: absent means the database (P2b). */
export const LABEL_ROLE = 'com.corebase.role';

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

/** The pooler's container and the name it answers to on the project network. */
export const poolerName = (ref: string) => `${CONTAINER_PREFIX}${ref}-pooler`;
export const POOLER_ALIAS = 'pooler';
export const POOLER_IMAGE = process.env.CB_POOLER_IMAGE ?? 'corebase/pgbouncer:1.23';
/** PgBouncer's listen port inside the container. The host port is allocated. */
export const POOLER_PORT = 6432;

export interface PoolerSpecArgs {
  ref: string;
  networkName: string;
  /** Host port from placement (`project_databases.pooler_port`). */
  hostPort: number;
  /** `pgbouncer_auth`'s password — the only secret the pooler holds (D-074). */
  authPassword: string;
  image?: string;
  restartPolicy?: string;
  /** Whole cores; the pooler is single-threaded so more than one buys nothing. */
  cpuLimit?: number;
  ramLimitMb?: number;
}

/**
 * The pooler sidecar.
 *
 * Sized small on purpose: the doc budgets ~10–20 MiB RSS per pooler and PgBouncer
 * is single-threaded, so a generous CPU allowance would only reserve capacity
 * nothing can use. These are the numbers the cost model books per project, and a
 * pooler that exceeds them is a signal worth an OOM rather than a silent tenant
 * that quietly costs three times its booking.
 *
 * No restart policy at create time, promoted after the health gate — the same rule
 * as the database (D-184), and for the same reason: a pooler that cannot reach its
 * database would otherwise flap forever behind a permanent "restarting" state.
 */
export function buildPoolerSpec(a: PoolerSpecArgs): ContainerSpec {
  const memBytes = (a.ramLimitMb ?? 64) * 1024 * 1024;
  return {
    Image: a.image ?? POOLER_IMAGE,
    Env: [`PGBOUNCER_AUTH_PASSWORD=${a.authPassword}`],
    Labels: {
      [LABEL_REF]: a.ref,
      [LABEL_MANAGED]: 'true',
      // Distinguishes the two containers a project now has, so reconciliation and
      // the purge can reason about them separately without parsing names.
      [LABEL_ROLE]: 'pooler',
    },
    HostConfig: {
      Memory: memBytes,
      MemorySwap: memBytes,
      NanoCpus: Math.round((a.cpuLimit ?? 0.25) * 1e9),
      // A pooler is one process with one thread and does no disk I/O worth
      // weighting, so the pid ceiling is the only wall that means anything here —
      // and it means the same thing it does for the database: whatever ends up
      // running inside this container cannot exhaust the node's pids.
      PidsLimit: 64,
      RestartPolicy: { Name: a.restartPolicy ?? 'no' },
      Mounts: [],
      PortBindings: { [`${POOLER_PORT}/tcp`]: [{ HostPort: String(a.hostPort) }] },
    },
    ExposedPorts: { [`${POOLER_PORT}/tcp`]: {} },
    NetworkingConfig: { EndpointsConfig: { [a.networkName]: { Aliases: [POOLER_ALIAS] } } },
  };
}

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
  /** Drives the I/O weight; defaults to the free tier's, the strictest. */
  plan?: string;
  /**
   * Whether this node's kernel can take an I/O weight. Absent means no, because
   * a wrong "yes" costs every provision on the node and a wrong "no" costs
   * fairness on a busy disk.
   */
  ioWeight?: boolean;
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
      [LABEL_ROLE]: 'database',
    },
    HostConfig: {
      // cgroup limits from day one (D-055). MemorySwap == Memory disables swap:
      // a tenant that swaps degrades every neighbour on the node.
      Memory: memBytes,
      MemorySwap: memBytes,
      NanoCpus: Math.round((a.cpuLimit ?? 0.5) * 1e9),
      // Process and I/O walls complete D-055's set (P2f). Every axis a tenant can
      // saturate gets a static ceiling; the ones left open are the ones that take
      // the node down rather than the project.
      PidsLimit: PIDS_LIMIT,
      // The I/O weight is set only where the node's kernel has `io.weight` at all
      // (see node-caps.ts). Setting it on a kernel without a weight-capable I/O
      // policy does not degrade to "no weight" — runc refuses to start the
      // container, so the wall meant to protect neighbours takes down the tenant.
      ...(a.ioWeight
        ? { BlkioWeight: PLAN_IO_WEIGHT[a.plan ?? 'free'] ?? PLAN_IO_WEIGHT['free']! }
        : {}),
      ...ioDeviceLimits(a.plan ?? 'free'),
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
