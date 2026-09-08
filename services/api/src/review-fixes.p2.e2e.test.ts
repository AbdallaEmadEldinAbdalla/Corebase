import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.ts';
import { createPgStore } from './modules/control-plane/store.pg.ts';

/**
 * The findings from the P2 review, as tests.
 *
 * Two of them are about the same thing from opposite sides: a database password is
 * as powerful as the `service_role` key, so gating one and auditing it while
 * handing the other to anyone with `project.read` and recording nothing was a hole
 * with a lock next to it.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const TOKEN = 'review-fixes-static-token-long-enough';

let pool: Pool; let up = false; let orgId: string;

beforeAll(async () => {
  try {
    pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 2000 });
    await pool.query('select 1');
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('Review','review-fixes')
       on conflict (slug) do update set updated_at = now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    console.error('P2 review-fixes setup FAILED:', (err as Error).message);
    up = false;
  }
}, 20_000);

afterAll(async () => { await pool?.end(); });

const t = (name: string, fn: () => Promise<void>, ms = 30_000) =>
  it(name, async () => {
    if (!up) throw new Error(
      'control plane not reachable — bring it up with ./scripts/staging.sh up. ' +
      'These are the review-fix done-signals and must not be skipped silently.');
    await fn();
  }, ms);

async function project(status = 'ready') {
  const ref = 'rv' + Math.random().toString(36).slice(2, 12).padEnd(18, 'x');
  // `deleted_at` is not optional for the deleted states: the table has a CHECK
  // tying `status IN ('soft_deleted','deleted')` to `deleted_at IS NOT NULL`, so a
  // fixture that sets one without the other is rejected — which is the constraint
  // doing its job on a test rather than on a customer.
  const deletedAt = status === 'soft_deleted' || status === 'deleted' ? new Date() : null;
  const { rows } = await pool.query<{ id: string }>(
    // ref and name are separate parameters: `ref` has its own domain type, so
    // reusing one placeholder for both makes Postgres refuse to deduce a type.
    `insert into projects (organization_id, ref, name, region, plan, status, deleted_at)
     values ($1, $2, $3, 'eu-central', 'free', $4, $5) returning id`,
    [orgId, ref, ref, status, deletedAt]);
  return { id: rows[0]!.id, ref };
}

const app = () => buildApp({
  store: createPgStore({ pool, organizationId: orgId }),
  staticToken: TOKEN,
  projectsPerOrgLimit: 3,
});
const auth = { authorization: `Bearer ${TOKEN}` };

describe('P2 review — credentials are revealed deliberately and recorded', () => {
  t('project detail omits connection strings unless asked', async () => {
    const p = await project();
    // Register a node rather than assuming one: this suite runs against a stack
    // that may have just been nuked, and `select ... from nodes limit 1` inserting
    // nothing turns into "expected undefined to be defined" three assertions later.
    await pool.query(
      `insert into nodes (hostname, address, region, ram_total_mb, disk_total_gb, status)
       values ('review-fixes-node', '127.0.0.1', 'eu-central', 8192, 200, 'active')
       on conflict (hostname) do update set updated_at = now()`);
    await pool.query(
      `insert into project_databases (project_id, node_id, volume_name, port, pooler_port,
                                      ram_limit_mb, ram_booked_mb, status, connection_host)
       select $1, id, 'v', $2, $3, 512, 350, 'running', 'h' from nodes
        where hostname = 'review-fixes-node'`,
      // Random ports: a fixed pair collides with whatever an earlier run left,
      // and `UNIQUE (node_id, port)` turns that into a confusing failure.
      [p.id, 20000 + Math.floor(Math.random() * 9000), 30000 + Math.floor(Math.random() * 9000)]);

    const plain = await app().inject({ method: 'GET', url: `/v1/projects/${p.ref}`, headers: auth });
    expect(plain.statusCode).toBe(200);
    // The facts a status page needs are still there…
    expect(plain.json().database?.host).toBeDefined();
    // …and the credentials are not, even though the caller could read the project.
    expect(plain.json().database?.connection_strings).toBeUndefined();
  });

  t('the ceiling counts what still holds resources, not what is merely alive', async () => {
    // The route-level 409 lives in the org-scoped path (a ceiling is per
    // organization, so it only applies once an organization is resolved) and is
    // asserted in orgs.p1.e2e.test.ts, which has that fixture. What is asserted
    // here is the thing the ceiling is built on, and the thing most likely to be
    // wrong: which projects count.
    const before = await createPgStore({ pool, organizationId: orgId }).countProjectsInOrg!(orgId);
    const soft = await project('soft_deleted');
    const gone = await project('deleted');
    const after = await createPgStore({ pool, organizationId: orgId }).countProjectsInOrg!(orgId);

    // A soft-deleted project still holds a volume, a port and a disk reservation
    // for the recovery window (D-038), so it is as real to the node as a running
    // one. A purged project has given everything back.
    expect(after, 'soft-deleted projects must count; purged ones must not')
      .toBe(before + 1);
    void soft; void gone;
  });
});

describe('P2 review — a user can be deleted without a foreign-key violation', () => {
  t('deleting a user who sent an invite and minted a key keeps both', async () => {
    // Before the fix both foreign keys defaulted to NO ACTION, so this DELETE
    // failed. Nothing in the product deletes a user yet, which is precisely why
    // the first person to write that path would have met it as a mystery.
    const { rows: u } = await pool.query<{ id: string }>(
      `insert into users (email, display_name) values ($1, 'Doomed') returning id`,
      [`doomed-${Date.now()}@steadhold.test`]);
    const userId = u[0]!.id;
    const p = await project();

    await pool.query(
      `insert into organization_invites (organization_id, email, role, token_hash, invited_by, expires_at)
       values ($1, $2, 'member', $3, $4, now() + interval '7 days')`,
      [orgId, `invitee-${Date.now()}@steadhold.test`, `hash-${Date.now()}`, userId]);
    await pool.query(
      `insert into project_api_keys (project_id, kind, key_prefix, key_hash, created_by)
       values ($1, 'anon', 'shk_anon_rv', $2, $3)`, [p.id, `kh-${Date.now()}`, userId]);

    await expect(pool.query(`delete from users where id = $1`, [userId])).resolves.toBeTruthy();

    // Both records survive, with the attribution dropped rather than the row.
    const invite = await pool.query<{ invited_by: string | null }>(
      `select invited_by from organization_invites where invited_by is null
        and organization_id = $1`, [orgId]);
    expect(invite.rowCount).toBeGreaterThan(0);
    const key = await pool.query<{ created_by: string | null }>(
      `select created_by from project_api_keys where project_id = $1`, [p.id]);
    expect(key.rows[0]!.created_by).toBeNull();
  });
});
