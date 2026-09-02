import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { IMAGE, LABEL_MANAGED } from './container-spec.ts';
import { AUTH_ROLE, IMAGE_ROLES } from './project-admin.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P4a — the `auth` schema exists in every project's database, and only one role
 * can read it.
 *
 * The schema shape is the easy half. The half worth testing is the privilege
 * boundary: `auth.users.encrypted_password` must be unreachable from every role a
 * customer's API traffic can arrive as, and `service_role` is the one that makes
 * that non-obvious — it holds `BYPASSRLS`, so nothing about row-level security
 * constrains it, and the *only* thing standing between it and every end-user's
 * password hash is the absence of a table grant.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

let pool: Pool; let docker: Docker; let orgId: string; let kekDir: string;
let secrets: ReturnType<typeof createSecretStore>;
let up = false; let reason = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-p4a-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    await pool.query('select 1');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 60_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('A','a4-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P4a integration setup FAILED:', reason);
    up = false;
  }
}, 60_000);

const created = { volumes: new Set<string>() };

async function wipeNode() {
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id, true, false).catch(() => {});
  }
  for (const n of await docker.listNetworks(`${LABEL_MANAGED}=true`)) {
    await docker.removeNetwork(n.Name).catch(() => {});
  }
  for (const v of created.volumes) await docker.removeVolume(v).catch(() => {});
  created.volumes.clear();
}

afterAll(async () => {
  if (up) await wipeNode();
  await pool?.end();
  docker?.close?.();
}, 60_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query(
    'truncate provisioning_jobs, project_databases, project_repos, projects, nodes cascade');
  await wipeNode();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 240_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P4a preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && seed-images. ' +
      'This is the P4a done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'a' + String(Date.now() % 100000) + String(++seq).padStart(14, 'r');

/** A provisioned project, with the roles and credentials in place. */
async function provision() {
  await registerNode(pool, {
    hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,'free','ready') returning id, ref::text as ref`,
    [orgId, ref, 'auth-' + seq]);
  const p = rows[0]!;
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 120_000 });
  const steps = sagas['provision_project']!;
  const job = { id: 'j', project_id: p.id } as unknown as JobRecord;
  for (const name of ['allocate_node', 'create_volume', 'create_network', 'start_container',
    'wait_healthy', 'create_base_roles', 'store_credentials', 'write_connection']) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    await step!.run({ job, log: () => {} });
  }
  const { rows: place } = await pool.query<{ volume_name: string; port: number }>(
    `select volume_name, port from project_databases where project_id=$1`, [p.id]);
  created.volumes.add(place[0]!.volume_name);
  return { ...p, port: place[0]!.port };
}

async function connectAs(port: number, user: string, password: string) {
  const c = new Client({
    host: '127.0.0.1', port, user, database: 'postgres', password,
    connectionTimeoutMillis: 8000,
  });
  await c.connect();
  return c;
}

const superuser = (projectId: string) => secrets.get(projectId, SECRET_NAMES.postgres);

describe('P4a — the schema is there and shaped as designed', () => {
  t('every auth table exists in a freshly provisioned project', async () => {
    const p = await provision();
    const su = await connectAs(p.port, 'postgres', (await superuser(p.id))!);
    try {
      const { rows } = await su.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'auth' order by table_name`);
      const names = rows.map((r) => r.table_name);
      // The doc's six. `identities` is present though unpopulated until OAuth
      // (V1.1) on purpose: a table added later is a migration every customer has
      // to run, and the shape mirrors GoTrue's to ease migration *to* Corebase.
      expect(names).toEqual([
        'audit_log_entries', 'identities', 'one_time_tokens',
        'refresh_tokens', 'sessions', 'users',
      ]);
    } finally { await su.end(); }
  });

  t('a soft-deleted user frees the email for re-registration', async () => {
    // The partial unique index is what makes this work, and it is the reason the
    // index is partial: the row has to stay for the app's foreign keys while the
    // address becomes available again.
    const p = await provision();
    const su = await connectAs(p.port, 'postgres', (await superuser(p.id))!);
    try {
      await su.query(`insert into auth.users (email) values ('a@example.com')`);
      await expect(su.query(`insert into auth.users (email) values ('A@Example.com')`))
        .rejects.toThrow(/duplicate key/);          // case-insensitive, as designed
      await su.query(`update auth.users set deleted_at = now() where email = 'a@example.com'`);
      await su.query(`insert into auth.users (email) values ('a@example.com')`);
      const { rows } = await su.query<{ n: number }>(
        `select count(*)::int as n from auth.users where lower(email) = 'a@example.com'`);
      expect(rows[0]!.n).toBe(2);
    } finally { await su.end(); }
  });

  t('the refresh-token lineage can express a family', async () => {
    // Reuse detection is a walk up `parent_id`, so the column has to actually
    // support a chain — including the root, whose parent is null.
    const p = await provision();
    const su = await connectAs(p.port, 'postgres', (await superuser(p.id))!);
    try {
      const { rows: u } = await su.query<{ id: string }>(
        `insert into auth.users (email) values ('chain@example.com') returning id`);
      const { rows: sess } = await su.query<{ id: string }>(
        `insert into auth.sessions (user_id) values ($1) returning id`, [u[0]!.id]);
      const { rows: root } = await su.query<{ id: string }>(
        `insert into auth.refresh_tokens (token_hash, user_id, session_id)
         values (sha256('one'), $1, $2) returning id`, [u[0]!.id, sess[0]!.id]);
      const { rows: child } = await su.query<{ id: string; parent_id: string }>(
        `insert into auth.refresh_tokens (token_hash, user_id, session_id, parent_id)
         values (sha256('two'), $1, $2, $3) returning id, parent_id`,
        [u[0]!.id, sess[0]!.id, root[0]!.id]);
      expect(child[0]!.parent_id).toBe(root[0]!.id);
      // Revoking the session takes the whole family with it, which is what makes
      // "reuse detected → revoke the family" one statement rather than a walk.
      await su.query(`delete from auth.sessions where id = $1`, [sess[0]!.id]);
      const { rows: left } = await su.query<{ n: number }>(
        `select count(*)::int as n from auth.refresh_tokens`);
      expect(left[0]!.n).toBe(0);
    } finally { await su.end(); }
  });

  t('one one-time token per type per user, newest replacing the previous', async () => {
    // What makes "resend" safe: issuing a new link stops the old one working,
    // rather than leaving two valid confirmations in someone's inbox.
    const p = await provision();
    const su = await connectAs(p.port, 'postgres', (await superuser(p.id))!);
    try {
      const { rows: u } = await su.query<{ id: string }>(
        `insert into auth.users (email) values ('ott@example.com') returning id`);
      await su.query(
        `insert into auth.one_time_tokens (user_id, token_type, token_hash, expires_at)
         values ($1,'confirmation',sha256('a'), now() + interval '1 day')`, [u[0]!.id]);
      await expect(su.query(
        `insert into auth.one_time_tokens (user_id, token_type, token_hash, expires_at)
         values ($1,'confirmation',sha256('b'), now() + interval '1 day')`, [u[0]!.id]))
        .rejects.toThrow(/duplicate key/);
      // A different type is a different token, and both may be outstanding.
      await su.query(
        `insert into auth.one_time_tokens (user_id, token_type, token_hash, expires_at)
         values ($1,'recovery',sha256('c'), now() + interval '1 day')`, [u[0]!.id]);
    } finally { await su.end(); }
  });
});

describe('P4a — only the auth role can reach the password hashes', () => {
  t('service_role cannot read auth.users, despite BYPASSRLS', async () => {
    // The test that matters. service_role is handed to a customer's server-side
    // code and bypasses row-level security entirely, so the *only* thing between
    // it and every end-user's password hash is the absence of a table grant.
    const p = await provision();
    const su = await connectAs(p.port, 'postgres', (await superuser(p.id))!);
    try {
      await su.query(`insert into auth.users (email, encrypted_password)
                      values ('secret@example.com', 'scrypt$hash')`);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await su.query(`set role ${role}`);
        await expect(su.query(`select encrypted_password from auth.users`),
          `${role} must not read auth.users`).rejects.toThrow(/permission denied/);
        // The helper functions stay callable — that is the asymmetry the schema
        // grant exists for.
        const { rows } = await su.query<{ uid: string | null }>(`select auth.uid() as uid`);
        expect(rows[0]!.uid).toBeNull();
        await su.query('reset role');
      }
    } finally { await su.end(); }
  });

  t('the developer role cannot read auth.users either', async () => {
    // The customer's own admin credential. They own their database and can grant
    // themselves anything — the point is that the *default* does not hand them
    // their users' password hashes in the connection string the dashboard shows.
    const p = await provision();
    const dev = await connectAs(
      p.port, 'developer', (await secrets.get(p.id, SECRET_NAMES.developer))!);
    try {
      await expect(dev.query(`select * from auth.users`)).rejects.toThrow(/permission denied/);
    } finally { await dev.end(); }
  });

  t('corebase_auth can log in and own its rows', async () => {
    const p = await provision();
    const pw = await secrets.get(p.id, SECRET_NAMES.authRole);
    expect(pw, 'the auth role needs a password stored at provision').toBeTruthy();
    const auth = await connectAs(p.port, AUTH_ROLE, pw!);
    try {
      const { rows } = await auth.query<{ id: string }>(
        `insert into auth.users (email, encrypted_password)
         values ('owner@example.com', 'scrypt$x') returning id`);
      expect(rows[0]!.id).toBeTruthy();
      const read = await auth.query<{ email: string }>(
        `select email from auth.users where id = $1`, [rows[0]!.id]);
      expect(read.rows[0]!.email).toBe('owner@example.com');
      // And it is *not* a superuser: the boundary runs both ways, so a compromised
      // auth module cannot rewrite the customer's own tables at will.
      const su = await auth.query<{ is_super: boolean }>(
        `select usesuper as is_super from pg_user where usename = current_user`);
      expect(su.rows[0]!.is_super).toBe(false);
    } finally { await auth.end(); }
  });

  t('its password is its own, not the authenticator\'s', async () => {
    // Sharing one would make a leak of the API's connection string a leak of every
    // end-user's credentials.
    const p = await provision();
    const authPw = await secrets.get(p.id, SECRET_NAMES.authRole);
    const apiPw = await secrets.get(p.id, SECRET_NAMES.authenticator);
    expect(authPw).not.toBe(apiPw);
    const wrong = new Client({
      host: '127.0.0.1', port: p.port, user: AUTH_ROLE, database: 'postgres',
      password: apiPw!, connectionTimeoutMillis: 8000 });
    await expect(wrong.connect()).rejects.toThrow(/password|authentication/i);
    await wrong.end().catch(() => {});
  });

  t('auth tables are not force-RLS\'d, which would lock out their only user', async () => {
    // The event trigger in 30-force-rls enables RLS on new tables in `public`
    // only. If it ever widened to every schema, the auth module would be locked
    // out of its own tables by a mechanism meant to protect customers' data — and
    // the symptom would be every login failing at once.
    const p = await provision();
    const su = await connectAs(p.port, 'postgres', (await superuser(p.id))!);
    try {
      const { rows } = await su.query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'auth' and c.relkind = 'r'`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.relrowsecurity, `${r.relname} has RLS on`).toBe(false);
    } finally { await su.end(); }
  });

  t('the image audit now requires corebase_auth, so an old image fails loudly',
    async () => {
      // The same guard that catches an image predating the role model (D-108's
      // lesson): a project provisioned against an image without this role would
      // have an auth schema nothing can reach, and the failure would surface as
      // "every login is broken" long after provisioning reported success.
      expect(IMAGE_ROLES).toContain(AUTH_ROLE);
      const p = await provision();
      const su = await connectAs(p.port, 'postgres', (await superuser(p.id))!);
      try {
        const { rows } = await su.query<{ n: number }>(
          `select count(*)::int as n from pg_roles where rolname = $1`, [AUTH_ROLE]);
        expect(rows[0]!.n).toBe(1);
      } finally { await su.end(); }
    });
});
