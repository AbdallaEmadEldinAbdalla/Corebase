import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  registerNode, allocateNode, NoCapacityError, NODE_STALE_SECONDS, FILL_CEILING,
} from './placement.ts';

/**
 * P2f — bin-packing against the real control plane.
 *
 * The arithmetic is covered without a database in binpack.test.ts. What needs a
 * database is the part that is not arithmetic: which nodes are *eligible*, and
 * what happens when two provisions want the same last slot. Both of those are
 * SQL and locking, and neither can be tested by reasoning about them.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';

let pool: Pool; let orgId: string; let up = false;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 16, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1');
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('BP','bp-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id; up = true;
  } catch (err) {
    console.error('P2f integration setup FAILED:', (err as Error).message); up = false;
  }
}, 20_000);
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects, nodes cascade');
});

const t = (n: string, fn: () => Promise<void>, ms = 30_000) =>
  it(n, async () => {
    if (!up) throw new Error('staging Postgres not reachable — run ./scripts/staging.sh up. ' +
      'This is the P2f done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'b' + String(++seq).padStart(19, 'z');

async function mkProject(plan = 'free') {
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan)
     values ($1,$2,$3,$4::project_plan) returning id, ref::text as ref`,
    [orgId, mkRef(), 'bp-' + seq, plan]);
  return rows[0]!;
}

const place = async (plan = 'free') => {
  const p = await mkProject(plan);
  return allocateNode(pool, { projectId: p.id, ref: p.ref, plan });
};

const reserved = async () => (await pool.query<{ hostname: string; ram: number; disk: number }>(
  `select hostname, ram_reserved_mb as ram, disk_reserved_gb as disk from nodes order by hostname`
)).rows;

const age = (host: string, seconds: number) =>
  pool.query(`update nodes set last_seen_at = now() - make_interval(secs => $2) where hostname = $1`,
    [host, seconds]);

describe('P2f — node selection', () => {
  t('goes to the emptiest node by RATIO, not by megabytes booked', async () => {
    // The small node has fewer MB reserved and is nearly full; the big one has
    // more reserved and is nearly empty. The previous ordering
    // (`ORDER BY ram_reserved_mb ASC`) picks the small one — it hands the project
    // to the fullest node in the fleet.
    await registerNode(pool, { hostname: 'small', ramTotalMb: 4096, diskTotalGb: 100 });
    await registerNode(pool, { hostname: 'big', ramTotalMb: 32_768, diskTotalGb: 800 });
    await pool.query(`update nodes set ram_reserved_mb = 3000 where hostname = 'small'`);
    await pool.query(`update nodes set ram_reserved_mb = 8000 where hostname = 'big'`);

    expect((await place()).hostname).toBe('big');
  });

  t('spreads across equal nodes instead of filling one', async () => {
    await registerNode(pool, { hostname: 'n-a', ramTotalMb: 4096, diskTotalGb: 100 });
    await registerNode(pool, { hostname: 'n-b', ramTotalMb: 4096, diskTotalGb: 100 });
    const hosts = [];
    for (let i = 0; i < 6; i++) hosts.push((await place()).hostname);
    // Spread-first: alternating, so each node keeps the resume headroom D-091
    // depends on. Fill-first would put all six on n-a.
    expect(hosts.filter((h) => h === 'n-a')).toHaveLength(3);
    expect(hosts.filter((h) => h === 'n-b')).toHaveLength(3);
  });

  t('falls through to a node that fits when the emptiest one is too small', async () => {
    // The false "no capacity": a single-candidate packer stops at the emptiest
    // node and fails, while the region has room. The emptier the small node, the
    // more confidently the old code refused.
    await registerNode(pool, { hostname: 'tiny', ramTotalMb: 300, diskTotalGb: 100 });
    await registerNode(pool, { hostname: 'roomy', ramTotalMb: 8192, diskTotalGb: 100 });
    expect((await place()).hostname).toBe('roomy');
  });

  t('will not place on a node with RAM to spare but no disk headroom', async () => {
    await registerNode(pool, { hostname: 'nodisk', ramTotalMb: 32_768, diskTotalGb: 2 });
    await registerNode(pool, { hostname: 'ok', ramTotalMb: 4096, diskTotalGb: 100 });
    // nodisk's disk ceiling is floor(2 * 0.85) = 1 GB, and a free project books 1.
    await pool.query(`update nodes set disk_reserved_gb = 1 where hostname = 'nodisk'`);
    expect((await place()).hostname).toBe('ok');
  });

  t('skips a cordoned node entirely, and says so when it is the only one', async () => {
    await registerNode(pool, { hostname: 'only', ramTotalMb: 8192, diskTotalGb: 100 });
    await pool.query(`update nodes set status = 'cordoned' where hostname = 'only'`);
    await expect(place()).rejects.toThrow(NoCapacityError);
    await expect(place()).rejects.toThrow(/no active node in region/);
  });

  t('refuses a node nothing has been heard from, and names that as the reason', async () => {
    // status stays 'active' when a worker dies. A project sent there does not
    // fail — it sits in `creating` until the saga times out, which reads as
    // "provisioning is slow" and points at nothing.
    await registerNode(pool, { hostname: 'ghost', ramTotalMb: 32_768, diskTotalGb: 800 });
    await age('ghost', NODE_STALE_SECONDS + 60);
    await expect(place()).rejects.toThrow(/stale/);
    await expect(place()).rejects.toThrow(/worker is probably not running/);
  });

  t('prefers a live small node over a stale large one', async () => {
    await registerNode(pool, { hostname: 'ghost-big', ramTotalMb: 32_768, diskTotalGb: 800 });
    await registerNode(pool, { hostname: 'live-small', ramTotalMb: 4096, diskTotalGb: 100 });
    await age('ghost-big', NODE_STALE_SECONDS + 60);
    expect((await place()).hostname).toBe('live-small');
  });

  t('a full region reports what the emptiest node actually looks like', async () => {
    await registerNode(pool, { hostname: 'full', ramTotalMb: 4096, diskTotalGb: 100 });
    await pool.query(`update nodes set ram_reserved_mb = 3400 where hostname = 'full'`);
    // 4096 * 0.85 = 3481; 3400 + 350 crosses it.
    await expect(place()).rejects.toThrow(/placement stop/);
    await expect(place()).rejects.toThrow(/the emptiest, full, is at 3400\/4096 MB/);
  });
});

describe('P2f — the stop holds under contention', () => {
  t('20 concurrent provisions on a 9-slot node book exactly 9', async () => {
    // 4096 * 0.85 = 3481 bookable, 350 each → 9 fit. The point is not the number,
    // it is that the losers fail cleanly instead of the node ending up
    // oversubscribed: the DDL CHECK would catch a 10th, but only after the
    // control plane had already told a customer their project was being created.
    await registerNode(pool, { hostname: 'contended', ramTotalMb: 4096, diskTotalGb: 100 });
    const projects = await Promise.all(Array.from({ length: 20 }, () => mkProject('free')));
    const results = await Promise.allSettled(projects.map((p) =>
      allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' })));

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(9);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(NoCapacityError);
    }
    const [node] = await reserved();
    expect(node!.ram).toBe(9 * 350);
    expect(node!.ram).toBeLessThanOrEqual(Math.floor(4096 * FILL_CEILING));

    // Ports are unique too — the same lock that serialises the booking is what
    // makes the port allocator's read-then-pick safe.
    const { rows } = await pool.query<{ n: number }>(
      `select count(distinct port)::int as n from project_databases`);
    expect(rows[0]!.n).toBe(9);
  }, 60_000);

  t('20 concurrent provisions across two nodes spread and do not oversubscribe', async () => {
    await registerNode(pool, { hostname: 'p-a', ramTotalMb: 4096, diskTotalGb: 100 });
    await registerNode(pool, { hostname: 'p-b', ramTotalMb: 4096, diskTotalGb: 100 });
    const projects = await Promise.all(Array.from({ length: 20 }, () => mkProject('free')));
    const results = await Promise.allSettled(projects.map((p) =>
      allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' })));

    // 9 per node, 18 of 20 placed. Every rejection is a capacity refusal, not a
    // lock error or a constraint violation leaking out of the transaction.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(18);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(NoCapacityError);
    }
    const rows = await reserved();
    for (const n of rows) expect(n.ram).toBe(9 * 350);
  }, 60_000);

  t('disk is booked per placement and released only when the project is purged', async () => {
    await registerNode(pool, { hostname: 'd-1', ramTotalMb: 32_768, diskTotalGb: 100 });
    await place(); await place(); await place();
    const [n] = await reserved();
    expect(n!.disk).toBe(3);       // 1 GB each: ceil(500 * 1.2 / 1024)
    expect(n!.ram).toBe(3 * 350);
  });
});
