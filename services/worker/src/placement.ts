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

/**
 * Plan → the database-size cap the customer is told about, in MB
 * ([pricing](../../../docs/12-business/02-pricing-and-plans.md)).
 *
 * The ladder's percentages (D-073) are measured against this. The *quota* the
 * filesystem enforces is `quotaMbFor()` below — deliberately larger.
 */
export const PLAN_DISK_CAP_MB: Record<string, number> = {
  free: 500,
  pro: 8192,
  team: 8192,
  enterprise: 32768,
};

/**
 * The hard quota: the plan cap plus 20% headroom (D-073).
 *
 * The headroom is not generosity, it is what makes the recovery path possible.
 * Freeing space means `DELETE`, `DROP` or `VACUUM`, and all three *write* — a
 * filesystem with nothing left cannot accept the WAL that would free space, so a
 * quota set exactly at the cap deadlocks the customer at the moment they try to
 * fix it. The 20% is the room the fix runs in.
 */
export const QUOTA_HEADROOM = 1.2;
export const quotaMbFor = (plan: string): number =>
  Math.ceil((PLAN_DISK_CAP_MB[plan] ?? PLAN_DISK_CAP_MB['free']!) * QUOTA_HEADROOM);

/** Disk booked on the node, in whole GB — the quota, rounded up. */
export const diskBookingGbFor = (plan: string): number =>
  Math.max(1, Math.ceil(quotaMbFor(plan) / 1024));

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

/* ------------------------------------------------------------------ *
 * Bin-packing (P2f)
 *
 * The doc's rule is one sentence: new placements go to the active node in the
 * region with the **lowest RAM fill ratio** that still fits the booking on RAM
 * *and* disk (provisioning §7, spread-first). Three things about it are easy to
 * get wrong, and the first two were wrong here.
 * ------------------------------------------------------------------ */

/** A node as the packer sees it: both axes, no Docker, no I/O. */
export interface NodeCandidate {
  id: string;
  hostname: string;
  ramTotalMb: number;
  ramReservedMb: number;
  diskTotalGb: number;
  diskReservedGb: number;
}

/** What one project asks the node for. */
export interface Booking { ramMb: number; diskGb: number }

/**
 * How full a node is: **the worse of its two axes**, as a fraction of the
 * ceiling — 1.0 means "exactly at the placement stop".
 *
 * Ratio, not absolute reserved. `ORDER BY ram_reserved_mb ASC` reads as
 * "emptiest first" and is not: a 4 GB node holding 1 GB sorts ahead of a 64 GB
 * node holding 2 GB, so the packer hands projects to the *fullest* node in the
 * fleet as soon as the nodes differ in size. Homogeneous fleets hide this
 * completely, which is why it survived until there was a second node.
 *
 * Both axes, not just RAM. A node at 20% RAM and 80% disk is 80% full for
 * placement purposes; ranking it on RAM alone sends projects to the one node
 * that is about to run out of the resource they will actually consume.
 */
export function fillRatio(n: NodeCandidate, ceiling = FILL_CEILING): number {
  const ramCap = n.ramTotalMb * ceiling;
  const diskCap = n.diskTotalGb * ceiling;
  const ram = ramCap > 0 ? n.ramReservedMb / ramCap : Infinity;
  const disk = diskCap > 0 ? n.diskReservedGb / diskCap : Infinity;
  return Math.max(ram, disk);
}

/** Does the booking fit under the 85% stop on both axes (D-090)? */
export function fits(n: NodeCandidate, b: Booking, ceiling = FILL_CEILING): boolean {
  if (b.ramMb <= 0 || b.diskGb <= 0) throw new Error('booking must be positive on both axes');
  const ramOk = Math.floor(n.ramTotalMb * ceiling) - n.ramReservedMb >= b.ramMb;
  const diskOk = Math.floor(n.diskTotalGb * ceiling) - n.diskReservedGb >= b.diskGb;
  return ramOk && diskOk;
}

/**
 * Every node that fits, emptiest first.
 *
 * A *list*, not a winner. The single-candidate version — pick the emptiest node,
 * then fail if the booking does not fit — reports "no capacity" while the region
 * has plenty, because the emptiest node is not necessarily one that fits (a small
 * node can be the emptiest and still be too small). That failure mode gets more
 * likely the fuller the fleet gets, which is precisely when a false negative
 * costs the most. It is also what makes the lock-then-recheck loop in
 * `allocateNode` possible: losing a race to another provision means trying the
 * next candidate rather than failing the job.
 *
 * Ties break on hostname so the order is total and reproducible. Two identical
 * nodes would otherwise be returned in whatever order the plan happened to
 * produce, and a placement bug that only appears in one of two orderings is a
 * bug nobody can reproduce.
 */
export function rankNodes(
  nodes: readonly NodeCandidate[], b: Booking, ceiling = FILL_CEILING,
): NodeCandidate[] {
  return nodes
    .filter((n) => fits(n, b, ceiling))
    .sort((x, y) => {
      const d = fillRatio(x, ceiling) - fillRatio(y, ceiling);
      return d !== 0 ? d : x.hostname.localeCompare(y.hostname);
    });
}

/**
 * How long a node may go unheard-from and still receive placements.
 *
 * The worker re-registers its node on every reconcile pass (default 5 minutes,
 * jittered up to ~6.5), so this is roughly three missed beats. Placement has to
 * care: `status` stays `active` when a worker dies, and a project sent to a node
 * with nobody driving it does not fail — it sits in `creating` until the saga
 * times out, which reads as "provisioning is slow" and points at nothing.
 */
export const NODE_STALE_SECONDS = Number(process.env.CB_NODE_STALE_SECONDS ?? 900);

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
 * Two adjacent free ports, `n` and `n+1`, for PostgREST's API and admin listeners.
 *
 * Both must be free, and the pair must be adjacent, which is why this is not two
 * calls to `pickPort`: a first call returning `n` and a second returning `n+1`
 * only by luck would silently degrade into a non-adjacent pair as a node fills,
 * and the adjacency is what makes `7434`/`7435` recognisable as one project's
 * while a human is reading `docker ps`.
 *
 * Steps by two from the range's start, so pairs never interleave — a pair taken
 * at `n` cannot leave `n+1` looking free to the next allocation.
 */
export function pickPortPair(
  used: readonly number[], range: readonly [number, number],
): number {
  const taken = new Set(used);
  for (let p = range[0]; p + 1 <= range[1]; p += 2) {
    if (!taken.has(p) && !taken.has(p + 1)) return p;
  }
  throw new NoPortsError(
    `no free adjacent port pair in ${range[0]}-${range[1]} — a project needs two, `
    + 'so this range holds half as many projects as its width suggests');
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
/**
 * PostgREST's two listeners (P5b). One range, allocated in pairs: the API port
 * and the admin port next to it.
 *
 * Adjacent rather than two ranges, because the pairing is what a human debugging
 * a project needs — `7434` and `7435` are obviously one project's, while a port
 * from each of two distant ranges is a lookup. The allocator enforces the pairing
 * so the adjacency is a fact rather than a convention.
 */
export const POSTGREST_PORT_RANGE = envRange(
  'CB_POSTGREST_PORT_MIN', 'CB_POSTGREST_PORT_MAX', [7433, 7492]);

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
  /**
   * PostgREST's pair (P5b). Nullable on the replay path: a project placed before
   * this column existed has none, and inventing numbers for a container that does
   * not exist would collide with the allocator the first time it is touched.
   */
  postgrestPort: number | null; postgrestAdminPort: number | null;
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
      postgrest_port: number | null; postgrest_admin_port: number | null;
      volume_name: string; ram_limit_mb: number;
    }>(
      `SELECT d.node_id, n.hostname, d.port, d.pooler_port,
              d.postgrest_port, d.postgrest_admin_port, d.volume_name, d.ram_limit_mb
         FROM project_databases d JOIN nodes n ON n.id = d.node_id
        WHERE d.project_id = $1`,
      [args.projectId],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      const r = existing.rows[0];
      return { nodeId: r.node_id, hostname: r.hostname, port: r.port, poolerPort: r.pooler_port,
        postgrestPort: r.postgrest_port, postgrestAdminPort: r.postgrest_admin_port,
        volumeName: r.volume_name, ramLimitMb: r.ram_limit_mb, bookedMb: booking, replayed: true };
    }

    // Disk is booked on the same ceiling as RAM (P2e, D-250). Booking RAM and
    // ignoring disk is how a node ends up full of projects that each have memory
    // to spare and nowhere to write: "the node itself never suffers" has to be
    // arithmetic, not a hope.
    const diskBooking = diskBookingGbFor(args.plan ?? 'free');
    const want: Booking = { ramMb: booking, diskGb: diskBooking };
    const n = await pickNode(client, args.region ?? 'eu-central', want);

    const ports = await client.query<{
      port: number; pooler_port: number;
      postgrest_port: number | null; postgrest_admin_port: number | null;
    }>(
      `SELECT port, pooler_port, postgrest_port, postgrest_admin_port
         FROM project_databases WHERE node_id = $1`, [n.id]);
    const port = pickPort(ports.rows.map((r) => r.port), PG_PORT_RANGE);
    const poolerPort = pickPort(ports.rows.map((r) => r.pooler_port), POOLER_PORT_RANGE);
    // Both PostgREST ports are excluded from the pool the pair is drawn from, and
    // the pair is adjacent. Taking them from one list rather than two is what
    // makes `n` and `n+1` safe: an admin port allocated independently could land
    // on the next project's API port.
    const takenPgrst = ports.rows.flatMap((r) =>
      [r.postgrest_port, r.postgrest_admin_port].filter((v): v is number => v !== null));
    const postgrestPort = pickPortPair(takenPgrst, POSTGREST_PORT_RANGE);
    const volumeName = volumeNameFor(args.ref);

    await client.query(
      `INSERT INTO project_databases
         (project_id, node_id, volume_name, port, pooler_port,
          postgrest_port, postgrest_admin_port, ram_limit_mb,
          ram_booked_mb, disk_limit_mb, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'provisioning')`,
      [args.projectId, n.id, volumeName, port, poolerPort,
       postgrestPort, postgrestPort + 1, limit, booking,
       PLAN_DISK_CAP_MB[args.plan ?? 'free'] ?? PLAN_DISK_CAP_MB['free']!]);

    await client.query(
      `UPDATE nodes
          SET ram_reserved_mb = ram_reserved_mb + $2,
              disk_reserved_gb = disk_reserved_gb + $3
        WHERE id = $1`, [n.id, booking, diskBooking]);

    await client.query('COMMIT');
    return { nodeId: n.id, hostname: n.hostname, port, poolerPort,
      postgrestPort, postgrestAdminPort: postgrestPort + 1, volumeName,
      ramLimitMb: limit, bookedMb: booking, replayed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Choose a node for `want` and return it **locked**, inside the caller's
 * transaction.
 *
 * Two passes, and the second one is the point. The first reads every eligible
 * node's capacity *without* a lock and ranks them; the second walks that ranking
 * and, for each candidate, takes the row lock and re-reads the numbers before
 * committing to it. The re-read is not defensive coding — under READ COMMITTED a
 * `SELECT ... ORDER BY ... LIMIT 1 FOR UPDATE` can block on a rival transaction
 * and then hand back the row as it looked *before* that rival's booking, so the
 * single-statement version oversubscribes exactly when two provisions race for
 * the last slot on a node. Locking then re-checking makes the loser fall through
 * to the next candidate instead of overbooking the winner's node.
 *
 * Candidates are locked in ranked order, which is a fleet-wide consistent order
 * only by accident. It does not need to be: one node is locked at a time and
 * released with the transaction, and a candidate already held by a rival simply
 * blocks briefly — there is no second lock to deadlock against.
 */
async function pickNode(
  client: PoolClient, region: string, want: Booking,
): Promise<NodeCandidate> {
  const all = await client.query<{
    id: string; hostname: string; ram_total_mb: number; ram_reserved_mb: number;
    disk_total_gb: number; disk_reserved_gb: number; stale: boolean; age_s: number | null;
  }>(
    `SELECT id, hostname, ram_total_mb, ram_reserved_mb, disk_total_gb, disk_reserved_gb,
            (last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => $2)) AS stale,
            EXTRACT(epoch FROM now() - last_seen_at)::int AS age_s
       FROM nodes
      WHERE status = 'active' AND region = $1`,
    [region, NODE_STALE_SECONDS],
  );
  if (all.rows.length === 0) {
    throw new NoCapacityError(`no active node in region ${region}`);
  }

  interface CapacityRow {
    id: string; hostname: string; ram_total_mb: number; ram_reserved_mb: number;
    disk_total_gb: number; disk_reserved_gb: number;
  }
  const row2node = (r: CapacityRow): NodeCandidate => ({
    id: r.id, hostname: r.hostname,
    ramTotalMb: r.ram_total_mb, ramReservedMb: r.ram_reserved_mb,
    diskTotalGb: r.disk_total_gb, diskReservedGb: r.disk_reserved_gb,
  });

  const live = all.rows.filter((r) => !r.stale);
  if (live.length === 0) {
    // Deliberately a different sentence from "full". An operator who reads "no
    // capacity" goes looking for a bigger node; the actual problem is that
    // nothing is driving the ones they have.
    const freshest = all.rows.reduce((a, b) => ((a.age_s ?? 1e9) <= (b.age_s ?? 1e9) ? a : b));
    throw new NoCapacityError(
      `every active node in ${region} is stale — the freshest, ${freshest.hostname}, was last ` +
      `seen ${freshest.age_s === null ? 'never' : `${freshest.age_s}s ago`} ` +
      `(limit ${NODE_STALE_SECONDS}s). Its worker is probably not running.`);
  }

  const ranked = rankNodes(live.map(row2node), want);
  if (ranked.length === 0) {
    const emptiest = live.map(row2node).sort((a, b) => fillRatio(a) - fillRatio(b))[0]!;
    throw new NoCapacityError(
      `no node in ${region} fits ${want.ramMb} MB + ${want.diskGb} GB under the ` +
      `${FILL_CEILING * 100}% placement stop; the emptiest, ${emptiest.hostname}, is at ` +
      `${emptiest.ramReservedMb}/${emptiest.ramTotalMb} MB and ` +
      `${emptiest.diskReservedGb}/${emptiest.diskTotalGb} GB ` +
      `(${Math.round(fillRatio(emptiest) * 100)}% of ceiling)`);
  }

  for (const candidate of ranked) {
    const locked = await client.query<{
      id: string; hostname: string; ram_total_mb: number; ram_reserved_mb: number;
      disk_total_gb: number; disk_reserved_gb: number; status: string;
    }>(
      `SELECT id, hostname, ram_total_mb, ram_reserved_mb, disk_total_gb, disk_reserved_gb, status
         FROM nodes WHERE id = $1 FOR UPDATE`, [candidate.id]);
    const r = locked.rows[0];
    // Cordoned while we were ranking, or deleted outright: both mean "not this one".
    if (!r || r.status !== 'active') continue;
    const fresh = row2node(r);
    if (fits(fresh, want)) return fresh;
  }

  throw new NoCapacityError(
    `${ranked.length} node(s) in ${region} fitted ${want.ramMb} MB + ${want.diskGb} GB when ` +
    'ranked and none still did once locked — a concurrent provision took the last slot. ' +
    'This job should be retried.');
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
    const del = await client.query<{
      node_id: string; ram_booked_mb: number; disk_limit_mb: number;
    }>(
      `DELETE FROM project_databases WHERE project_id = $1
       RETURNING node_id, ram_booked_mb, disk_limit_mb`, [args.projectId]);
    if (!del.rows[0]) { await client.query('COMMIT'); return { released: false, freedMb: 0 }; }
    const freed = del.rows[0].ram_booked_mb;
    // Disk is derived from the recorded cap rather than the plan, for the same
    // reason RAM is read off the row (D-237): the row is the authority on what was
    // actually booked, and a plan can change under a project.
    const freedDiskGb = Math.max(1,
      Math.ceil(Math.ceil(del.rows[0].disk_limit_mb * QUOTA_HEADROOM) / 1024));
    if (freed > 0) {
      await client.query(
        `UPDATE nodes SET ram_reserved_mb = GREATEST(0, ram_reserved_mb - $2) WHERE id = $1`,
        [del.rows[0].node_id, freed]);
    }
    // Unlike RAM, disk is *not* released on pause — a paused project keeps its
    // volume (D-008), so its disk stays booked for as long as the row exists.
    // Which is why this is the only place that returns it.
    await client.query(
      `UPDATE nodes SET disk_reserved_gb = GREATEST(0, disk_reserved_gb - $2) WHERE id = $1`,
      [del.rows[0].node_id, freedDiskGb]);
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
