import type { Pool, PoolClient } from 'pg';

/**
 * Node registry and placement.
 *
 * Capacity is reserved inside the same transaction that claims it, behind a row
 * lock on the node (SELECT ... FOR UPDATE). Two concurrent provisions therefore
 * serialise on that row and cannot oversubscribe. The DDL CHECK
 * (ram_reserved_mb <= ram_total_mb) is the backstop if this logic is ever
 * wrong — belt and braces, deliberately.
 */

/** Plan → booked RAM. Placement books the PLAN BUDGET, not the container's
 *  burst ceiling (D-174): container limits are overcommitted on purpose. */
export const PLAN_RAM_MB: Record<string, number> = {
  free: 350,     // D-091 planning figure for an active project
  pro: 1024,
  team: 1024,
  enterprise: 2048,
};

/** Container memory limit — the cgroup cap, higher than the booking. */
export const PLAN_CONTAINER_LIMIT_MB: Record<string, number> = {
  free: 512,
  pro: 1536,
  team: 1536,
  enterprise: 3072,
};

/** D-090: stop placing on a node at 85% reserved, well before the DDL ceiling. */
export const FILL_CEILING = 0.85;

export interface Capacity { ramTotalMb: number; ramReservedMb: number }

export function remainingMb(cap: Capacity, ceiling = FILL_CEILING): number {
  return Math.floor(cap.ramTotalMb * ceiling) - cap.ramReservedMb;
}

export function canFit(cap: Capacity, bookingMb: number, ceiling = FILL_CEILING): boolean {
  if (bookingMb <= 0) throw new Error('booking must be positive');
  return remainingMb(cap, ceiling) >= bookingMb;
}

/**
 * Lowest free port in the range. Deterministic (not random) so a retry of the
 * same provision tends to reuse the same port, which keeps logs readable.
 */
export function pickPort(used: readonly number[], range: readonly [number, number]): number {
  const taken = new Set(used);
  for (let p = range[0]; p <= range[1]; p++) if (!taken.has(p)) return p;
  throw new NoPortsError(`no free port in ${range[0]}-${range[1]}`);
}

/**
 * A project's volume name is derived from its ref, never stored-only. The purge
 * has to verify the volume is gone *after* the placement row that recorded its
 * name has been deleted — and a check that silently skips when the row is
 * missing is a check that passes vacuously.
 */
export const volumeNameFor = (ref: string) => `cb-${ref}-pgdata`;

export class NoCapacityError extends Error {}
export class NoPortsError extends Error {}

/**
 * Fleet port ranges. Narrowable by env because a local data node republishes the
 * range through a proxy, and 1000 published ports is seconds of startup for no
 * extra coverage — the allocator has to agree with what is actually reachable.
 */
const envRange = (min: string, max: string, dflt: [number, number]): [number, number] =>
  [Number(process.env[min] ?? dflt[0]), Number(process.env[max] ?? dflt[1])];

export const PG_PORT_RANGE = envRange('CB_PG_PORT_MIN', 'CB_PG_PORT_MAX', [5433, 6432]);
export const POOLER_PORT_RANGE = envRange('CB_POOLER_PORT_MIN', 'CB_POOLER_PORT_MAX', [6433, 7432]);

export interface NodeRegistration {
  hostname: string; region?: string; ramTotalMb: number; diskTotalGb: number;
  labels?: Record<string, unknown>;
  /**
   * Address the control plane uses to reach this node's project ports. Separate
   * from `hostname`, which is what the node calls itself: the two differ in
   * every environment where the control plane is not on the node's own DNS.
   */
  address?: string;
}

/** Idempotent: a worker restart re-registers the same node, it does not duplicate it. */
export async function registerNode(pool: Pool, n: NodeRegistration): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO nodes (hostname, region, ram_total_mb, disk_total_gb, labels, address, last_seen_at, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), 'active')
     ON CONFLICT (hostname) DO UPDATE
       SET last_seen_at = now(),
           ram_total_mb = EXCLUDED.ram_total_mb,
           disk_total_gb = EXCLUDED.disk_total_gb,
           labels = EXCLUDED.labels,
           address = COALESCE(EXCLUDED.address, nodes.address)
     RETURNING id`,
    [n.hostname, n.region ?? 'eu-central', n.ramTotalMb, n.diskTotalGb,
     JSON.stringify(n.labels ?? {}), n.address ?? null],
  );
  return rows[0]!.id;
}

export interface Placement {
  nodeId: string; hostname: string; port: number; poolerPort: number;
  volumeName: string; ramLimitMb: number; bookedMb: number; replayed: boolean;
}

/**
 * Allocate a node for a project and reserve its capacity, atomically.
 *
 * Check-then-act: an existing project_databases row means a previous attempt
 * already placed this project, so the row is returned unchanged and no capacity
 * is booked twice. That is what makes the step safe to replay after a crash.
 */
export async function allocateNode(
  pool: Pool,
  args: { projectId: string; ref: string; plan: string; region?: string },
): Promise<Placement> {
  const booking = PLAN_RAM_MB[args.plan] ?? PLAN_RAM_MB['free']!;
  const limit = PLAN_CONTAINER_LIMIT_MB[args.plan] ?? PLAN_CONTAINER_LIMIT_MB['free']!;
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{
      node_id: string; hostname: string; port: number; pooler_port: number;
      volume_name: string; ram_limit_mb: number;
    }>(
      `SELECT d.node_id, n.hostname, d.port, d.pooler_port, d.volume_name, d.ram_limit_mb
         FROM project_databases d JOIN nodes n ON n.id = d.node_id
        WHERE d.project_id = $1`,
      [args.projectId],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      const r = existing.rows[0];
      return { nodeId: r.node_id, hostname: r.hostname, port: r.port, poolerPort: r.pooler_port,
        volumeName: r.volume_name, ramLimitMb: r.ram_limit_mb, bookedMb: booking, replayed: true };
    }

    // Pick the emptiest active node in the region and LOCK it. Ordering by
    // reserved ascending spreads load; the lock is what serialises rivals.
    const node = await client.query<{ id: string; hostname: string; ram_total_mb: number; ram_reserved_mb: number }>(
      `SELECT id, hostname, ram_total_mb, ram_reserved_mb
         FROM nodes
        WHERE status = 'active' AND region = $1
        ORDER BY ram_reserved_mb ASC
        LIMIT 1
        FOR UPDATE`,
      [args.region ?? 'eu-central'],
    );
    if (!node.rows[0]) throw new NoCapacityError('no active node in region');

    const n = node.rows[0];
    if (!canFit({ ramTotalMb: n.ram_total_mb, ramReservedMb: n.ram_reserved_mb }, booking)) {
      throw new NoCapacityError(
        `node ${n.hostname} is at ${n.ram_reserved_mb}/${n.ram_total_mb} MB; ` +
        `${booking} MB would pass the ${FILL_CEILING * 100}% placement stop`);
    }

    const ports = await client.query<{ port: number; pooler_port: number }>(
      `SELECT port, pooler_port FROM project_databases WHERE node_id = $1`, [n.id]);
    const port = pickPort(ports.rows.map((r) => r.port), PG_PORT_RANGE);
    const poolerPort = pickPort(ports.rows.map((r) => r.pooler_port), POOLER_PORT_RANGE);
    const volumeName = volumeNameFor(args.ref);

    await client.query(
      `INSERT INTO project_databases
         (project_id, node_id, volume_name, port, pooler_port, ram_limit_mb,
          ram_booked_mb, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'provisioning')`,
      [args.projectId, n.id, volumeName, port, poolerPort, limit, booking]);

    await client.query(
      `UPDATE nodes SET ram_reserved_mb = ram_reserved_mb + $2 WHERE id = $1`, [n.id, booking]);

    await client.query('COMMIT');
    return { nodeId: n.id, hostname: n.hostname, port, poolerPort, volumeName,
      ramLimitMb: limit, bookedMb: booking, replayed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Inverse of allocate, for the deletion saga (T7). Idempotent: releasing twice
 * must not credit the node twice, so the capacity return is derived from the row
 * being deleted inside the same transaction.
 */
export async function releaseNode(
  pool: Pool, args: { projectId: string; plan?: string },
): Promise<{ released: boolean; freedMb: number }> {
  void args.plan;   // kept for call-site compatibility; the row is the authority now
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Credit what the row says is booked, not what the plan says it would be.
    // Those differ for a paused project, whose booking is zero (P2c) — crediting
    // the plan amount there would return RAM that was never reserved and leave the
    // node permanently under-counted, which is worse than leaking a booking
    // because it makes the node accept projects it cannot hold.
    const del = await client.query<{ node_id: string; ram_booked_mb: number }>(
      `DELETE FROM project_databases WHERE project_id = $1
       RETURNING node_id, ram_booked_mb`, [args.projectId]);
    if (!del.rows[0]) { await client.query('COMMIT'); return { released: false, freedMb: 0 }; }
    const freed = del.rows[0].ram_booked_mb;
    if (freed > 0) {
      await client.query(
        `UPDATE nodes SET ram_reserved_mb = GREATEST(0, ram_reserved_mb - $2) WHERE id = $1`,
        [del.rows[0].node_id, freed]);
    }
    await client.query('COMMIT');
    return { released: true, freedMb: freed };
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}

/**
 * Give a paused project's RAM back to its node, keeping everything else.
 *
 * The difference from `releaseNode` is the whole point of pause (D-008): the
 * placement row survives, so the project keeps its port, its pooler port, its
 * volume and its disk reservation — which is what lets resume hand back the same
 * connection string rather than a new one.
 *
 * Idempotent by the same mechanism `releaseNode` uses: the update is conditional on
 * there being a booking to release, inside the transaction, so a second call finds
 * nothing and credits nothing.
 */
export async function releaseRam(
  pool: Pool, args: { projectId: string },
): Promise<{ released: boolean; freedMb: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Read the booking under a row lock, *then* zero it.
    //
    // The obvious one-statement version is wrong: `UPDATE … SET ram_booked_mb = 0
    // … RETURNING ram_booked_mb` returns the **new** value in Postgres, so it
    // reports zero freed and the node is credited nothing. That is exactly what
    // happened — pause looked successful, released no memory, and the node's
    // accounting silently drifted until a resume double-booked it.
    const cur = await client.query<{ node_id: string; ram_booked_mb: number }>(
      `SELECT node_id, ram_booked_mb FROM project_databases
        WHERE project_id = $1 AND ram_booked_mb > 0
          FOR UPDATE`, [args.projectId]);
    if (!cur.rows[0]) { await client.query('COMMIT'); return { released: false, freedMb: 0 }; }
    const freed = cur.rows[0].ram_booked_mb;
    await client.query(
      `UPDATE project_databases SET ram_booked_mb = 0 WHERE project_id = $1`,
      [args.projectId]);
    await client.query(
      `UPDATE nodes SET ram_reserved_mb = GREATEST(0, ram_reserved_mb - $2) WHERE id = $1`,
      [cur.rows[0].node_id, freed]);
    await client.query('COMMIT');
    return { released: true, freedMb: freed };
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}

/**
 * Re-book a paused project's RAM on the node it is already placed on.
 *
 * This can fail, and the failure is the interesting part: a node that filled up
 * while the project was paused cannot take it back. The doc's answer is to place it
 * elsewhere and restore from backup, which needs backups (Phase 3) — so until then
 * this throws `NoCapacityError` with the node named, rather than starting containers
 * whose memory the node has not agreed to.
 *
 * Idempotent: a project that is already booked returns `rebooked: false` and the
 * resume saga carries on, because the booking is the precondition, not the goal.
 */
export async function bookRam(
  pool: Pool, args: { projectId: string; plan: string },
): Promise<{ rebooked: boolean; bookedMb: number }> {
  const booking = PLAN_RAM_MB[args.plan] ?? PLAN_RAM_MB['free']!;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the node first, in the same order allocate() takes it, so a resume and
    // a fresh placement racing for the last slot serialise instead of both winning.
    const row = await client.query<{
      node_id: string; ram_booked_mb: number; hostname: string;
      ram_total_mb: number; ram_reserved_mb: number;
    }>(`SELECT d.node_id, d.ram_booked_mb, n.hostname, n.ram_total_mb, n.ram_reserved_mb
          FROM project_databases d JOIN nodes n ON n.id = d.node_id
         WHERE d.project_id = $1
           FOR UPDATE OF n`, [args.projectId]);
    const r = row.rows[0];
    if (!r) throw new Error('no placement row — a project cannot be resumed onto nothing');
    if (r.ram_booked_mb > 0) {
      await client.query('COMMIT');
      return { rebooked: false, bookedMb: r.ram_booked_mb };
    }
    if (!canFit({ ramTotalMb: r.ram_total_mb, ramReservedMb: r.ram_reserved_mb }, booking)) {
      throw new NoCapacityError(
        `node ${r.hostname} is at ${r.ram_reserved_mb}/${r.ram_total_mb} MB and cannot ` +
        `take back ${booking} MB — resuming this project needs a different node, which ` +
        'means restoring from backup (Phase 3)');
    }
    await client.query(
      `UPDATE project_databases SET ram_booked_mb = $2 WHERE project_id = $1`,
      [args.projectId, booking]);
    await client.query(
      `UPDATE nodes SET ram_reserved_mb = ram_reserved_mb + $2 WHERE id = $1`,
      [r.node_id, booking]);
    await client.query('COMMIT');
    return { rebooked: true, bookedMb: booking };
  } catch (err) {
    await client.query('ROLLBACK'); throw err;
  } finally { client.release(); }
}
