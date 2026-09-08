import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import {
  registerNode, allocateNode, releaseNode, NoCapacityError,
  PLAN_RAM_MB, PG_PORT_RANGE,
} from './placement.ts';

/** T5c integration: placement against the real staging control DB. */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';

let pool: Pool; let orgId: string; let up = false;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 12, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1');
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('P','p-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id; up = true;
  } catch (err) {
    console.error('T5c integration setup FAILED:', (err as Error).message); up = false;
  }
}, 20_000);
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects, nodes cascade');
});

const t = (n: string, fn: () => Promise<void>, ms = 20_000) =>
  it(n, async () => {
    if (!up) throw new Error('staging Postgres not reachable — run ./scripts/staging.sh up. ' +
      'This is the T5c done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'p' + String(++seq).padStart(19, 'q');

async function mkProject(plan = 'free') {
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan)
     values ($1,$2,$3,$4::project_plan) returning id, ref::text as ref`,
    [orgId, mkRef(), 'proj-' + seq, plan]);
  return rows[0]!;
}
const nodeRow = async () => (await pool.query<{ ram_reserved_mb: number; ram_total_mb: number }>(
  `select ram_reserved_mb, ram_total_mb from nodes limit 1`)).rows[0]!;

describe('T5c — placement', () => {
  t('registering a node twice updates it rather than duplicating it', async () => {
    const a = await registerNode(pool, { hostname: 'data-1', ramTotalMb: 4096, diskTotalGb: 100 });
    const b = await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200 });
    expect(a).toBe(b);
    const { rows } = await pool.query(`select count(*)::int as n, ram_total_mb from nodes group by ram_total_mb`);
    expect(rows[0]!.n).toBe(1);
    expect(rows[0]!.ram_total_mb).toBe(8192);
  });

  t('books the plan budget and writes the database row', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 4096, diskTotalGb: 100 });
    const p = await mkProject('free');
    const placement = await allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' });
    expect(placement.bookedMb).toBe(PLAN_RAM_MB['free']);
    expect(placement.port).toBe(PG_PORT_RANGE[0]);
    expect(placement.volumeName).toBe(`sh-${p.ref}-pgdata`);
    expect((await nodeRow()).ram_reserved_mb).toBe(350);
    const { rows } = await pool.query(`select status::text, ram_limit_mb from project_databases`);
    expect(rows[0]!.status).toBe('provisioning');
    expect(rows[0]!.ram_limit_mb).toBe(512);      // container cap > booking, by design
  });

  t('replaying the step reuses the placement and does NOT double-book', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 4096, diskTotalGb: 100 });
    const p = await mkProject('free');
    const first = await allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' });
    const again = await allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' });
    expect(again.replayed).toBe(true);
    expect(again.port).toBe(first.port);
    expect((await nodeRow()).ram_reserved_mb).toBe(350);   // still 350, not 700
  });

  t('10 concurrent placements on one node: no duplicate ports, exact capacity', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 100 });
    const projects = await Promise.all(Array.from({ length: 10 }, () => mkProject('free')));
    const results = await Promise.all(projects.map((p) =>
      allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' })));

    const ports = results.map((r) => r.port);
    const poolerPorts = results.map((r) => r.poolerPort);
    expect(new Set(ports).size).toBe(10);              // the FOR UPDATE lock held
    expect(new Set(poolerPorts).size).toBe(10);
    expect((await nodeRow()).ram_reserved_mb).toBe(10 * 350);
    const { rows } = await pool.query(`select count(*)::int as n from project_databases`);
    expect(rows[0]!.n).toBe(10);
  });

  t('refuses placement at the 85% stop instead of filling the node', async () => {
    // 1000 MB node: the stop is 850, so two 350 MB projects fit and a third does not
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 1000, diskTotalGb: 10 });
    for (const _ of [1, 2]) {
      const p = await mkProject('free');
      await allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' });
    }
    expect((await nodeRow()).ram_reserved_mb).toBe(700);
    const third = await mkProject('free');
    await expect(allocateNode(pool, { projectId: third.id, ref: third.ref, plan: 'free' }))
      .rejects.toThrow(NoCapacityError);
    expect((await nodeRow()).ram_reserved_mb).toBe(700);   // failed attempt booked nothing
  });

  t('a failed placement leaves no half-written row', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 500, diskTotalGb: 10 });
    const p = await mkProject('pro');    // 1024 MB cannot fit a 500 MB node
    await expect(allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'pro' }))
      .rejects.toThrow(NoCapacityError);
    const { rows } = await pool.query(`select count(*)::int as n from project_databases`);
    expect(rows[0]!.n).toBe(0);
  });

  t('refuses when no active node exists (cordoned nodes are not candidates)', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 4096, diskTotalGb: 100 });
    await pool.query(`update nodes set status='cordoned'`);
    const p = await mkProject();
    await expect(allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' }))
      .rejects.toThrow(/no active node/);
  });

  t('spreads across nodes: the emptiest node wins', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 4096, diskTotalGb: 100 });
    await registerNode(pool, { hostname: 'data-2', ramTotalMb: 4096, diskTotalGb: 100 });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await mkProject();
      seen.push((await allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' })).hostname);
    }
    expect(seen.filter((h) => h === 'data-1')).toHaveLength(2);
    expect(seen.filter((h) => h === 'data-2')).toHaveLength(2);
  });

  t('release returns capacity, and releasing twice does not over-credit', async () => {
    await registerNode(pool, { hostname: 'data-1', ramTotalMb: 4096, diskTotalGb: 100 });
    const p = await mkProject('free');
    await allocateNode(pool, { projectId: p.id, ref: p.ref, plan: 'free' });
    expect((await releaseNode(pool, { projectId: p.id, plan: 'free' })).released).toBe(true);
    expect((await nodeRow()).ram_reserved_mb).toBe(0);
    const second = await releaseNode(pool, { projectId: p.id, plan: 'free' });
    expect(second.released).toBe(false);
    expect((await nodeRow()).ram_reserved_mb).toBe(0);      // not negative, not credited twice
  });
});
