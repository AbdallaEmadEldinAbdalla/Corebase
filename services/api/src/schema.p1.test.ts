import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

/**
 * P1a: the schema properties the rest of Phase 1 depends on, asserted against the
 * real database rather than read off the migration file.
 *
 * The audit tests exist because the first version of this migration was wrong in
 * a way that read correctly: `REVOKE … FROM PUBLIC` does not bind a table's
 * owner, and the application connects as the owner, so "append-only at the
 * database layer" was false while looking true.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';

let pool: Pool; let up = false; let reason = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1 from organization_members limit 0');
    up = true;
  } catch (err) { reason = (err as Error).message; up = false; }
}, 20_000);
afterAll(async () => { await pool?.end(); });

const t = (n: string, fn: () => Promise<void>) =>
  it(n, async () => {
    if (!up) throw new Error(
      `staging control DB not reachable or not migrated (${reason}) — ` +
      './scripts/staging.sh up && ./scripts/migrate-staging.sh');
    await fn();
  }, 20_000);

describe('P1a — audit_logs is append-only', () => {
  t('accepts inserts', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into audit_logs (action, resource_type, actor_type)
       values ('test.appended', 'test', 'system') returning id`);
    expect(rows[0]!.id).toBeTruthy();
  });

  t('refuses UPDATE even from the table owner', async () => {
    // The owner is exactly who the application connects as, so a privilege-only
    // defence protects nothing that matters.
    await expect(pool.query(`update audit_logs set action = 'tampered'`))
      .rejects.toThrow(/append-only: UPDATE is not permitted/);
  });

  t('refuses DELETE even from the table owner', async () => {
    await expect(pool.query(`delete from audit_logs`))
      .rejects.toThrow(/append-only: DELETE is not permitted/);
  });

  t('has no foreign keys, so a row outlives what it describes', async () => {
    // An FK here is a promise that audit rows can be cascaded away.
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from information_schema.table_constraints
        where table_name = 'audit_logs' and constraint_type = 'FOREIGN KEY'`);
    expect(rows[0]!.n).toBe(0);
  });

  t('uses monotonic ids, so gap detection is one query', async () => {
    const { rows } = await pool.query<{ gaps: number }>(
      `select (max(id) - min(id) + 1 - count(*))::int as gaps from audit_logs`);
    expect(rows[0]!.gaps).toBe(0);
  });
});

describe('P1a — membership', () => {
  t('a user holds exactly one role per org', async () => {
    const { rows } = await pool.query<{ cols: string }>(
      `select string_agg(a.attname, ',' order by a.attnum) as cols
         from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = 'organization_members'::regclass and i.indisprimary`);
    expect(rows[0]!.cols).toBe('organization_id,user_id');
  });

  t('the bootstrap org has an owner', async () => {
    // Phase 1's model assumes every org has one; the dev org would otherwise be
    // the single row violating the invariant everything else is written against.
    const { rows } = await pool.query<{ role: string; email: string }>(
      `select m.role::text as role, u.email::text as email
         from organization_members m
         join users u on u.id = m.user_id
         join organizations o on o.id = m.organization_id
        where o.slug = 'dev'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('owner');
  });

  t('the bootstrap owner cannot log in', async () => {
    // Seeded without a password hash on purpose: a known-credential account in
    // every environment is how staging becomes a way into production.
    const { rows } = await pool.query<{ hash: string | null }>(
      `select password_hash as hash from users where email = 'dev@corebase.local'`);
    expect(rows[0]!.hash).toBeNull();
  });
});

describe('P1a — api keys are hash-only (D-060)', () => {
  t('stores a hash and a prefix, with no column for the key itself', async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'project_api_keys' order by ordinal_position`);
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('key_hash');
    expect(cols).toContain('key_prefix');
    // If a column existed to hold the JWT, something would eventually fill it.
    expect(cols.some((c) => /^(key|token|secret|jwt)$/.test(c))).toBe(false);
  });

  t('refuses two keys with the same hash', async () => {
    const { rows: p } = await pool.query<{ id: string }>(
      `select id from projects limit 1`);
    if (!p[0]) return;                     // no project in this environment
    const hash = 'sha256:' + Date.now();
    const insert = () => pool.query(
      `insert into project_api_keys (project_id, kind, key_hash, key_prefix)
       values ($1, 'anon', $2, 'cbk_anon_xx')`, [p[0]!.id, hash]);
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i);
    await pool.query(`delete from project_api_keys where key_hash = $1`, [hash]);
  });
});
