import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';

/**
 * P1a: the schema properties the rest of Phase 1 depends on, asserted against the
 * real database rather than read off the migration file.
 *
 * The audit tests exist because the first version of this migration was wrong in
 * a way that read correctly: `REVOKE … FROM PUBLIC` does not bind a table's
 * owner, and the application connects as the owner, so "append-only at the
 * database layer" was false while looking true.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';

let pool: Pool; let up = false; let reason = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1 from organization_members limit 0');
    // The dev org and its owner are created by startup, not by a migration — see
    // ensureBootstrapOrg. A test that assumes otherwise passes only on a database
    // that has already been through Milestone 0.
    await ensureBootstrapOrg(pool);
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
      `select password_hash as hash from users where email = 'dev@steadhold.local'`);
    expect(rows[0]!.hash).toBeNull();
  });
});

describe('P1b — the application role has only the privileges it needs', () => {
  /**
   * These assertions are the reason the role split exists. They read the grant
   * matrix directly rather than trying statements as the app role, because the
   * test suite connects as the owner — the live runs (bench, lifecycle, demo,
   * observability) are what exercise the restricted role for real.
   */
  const priv = async (table: string) => {
    const { rows } = await pool.query<{ p: string }>(
      `select privilege_type as p from information_schema.table_privileges
        where grantee = 'steadhold_app' and table_name = $1 order by privilege_type`, [table]);
    return rows.map((r) => r.p);
  };

  t('can read and write ordinary tables', async () => {
    expect(await priv('projects')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(await priv('project_secrets')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  t('can only append to audit_logs', async () => {
    // The guarantee that survives someone dropping P1a's trigger: the
    // application is not *able* to rewrite history, not merely discouraged.
    expect(await priv('audit_logs')).toEqual(['INSERT', 'SELECT']);
  });

  t('owns nothing and cannot change the schema', async () => {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_class c
         join pg_roles r on r.oid = c.relowner
        where r.rolname = 'steadhold_app'`);
    expect(rows[0]!.n).toBe(0);
    const { rows: attrs } = await pool.query<{ super: boolean; createdb: boolean; createrole: boolean }>(
      `select rolsuper as super, rolcreatedb as createdb, rolcreaterole as createrole
         from pg_roles where rolname = 'steadhold_app'`);
    expect(attrs[0]).toEqual({ super: false, createdb: false, createrole: false });
  });

  t('has no password in any migration', async () => {
    // A password in a migration is a password in git. Enabling LOGIN is a
    // separate, documented step that reads the secret from the environment.
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('../../../migrations/', import.meta.url).pathname;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
      const sql = readFileSync(dir + f, 'utf8');
      expect(sql).not.toMatch(/PASSWORD\s+'/i);
    }
  });

  t('inherits the same grants on tables added later', async () => {
    // Without default privileges, a new table arrives invisible to the
    // application and the failure surfaces in production rather than in the
    // migration that created it.
    const { rows } = await pool.query<{ acl: string }>(
      `select unnest(defaclacl)::text as acl from pg_default_acl d
         join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname = 'public' and d.defaclobjtype = 'r'`);
    expect(rows.some((r) => r.acl.startsWith('steadhold_app='))).toBe(true);
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
       values ($1, 'anon', $2, 'shk_anon_xx')`, [p[0]!.id, hash]);
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|unique/i);
    await pool.query(`delete from project_api_keys where key_hash = $1`, [hash]);
  });
});
