import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@steadhold/crypto';
import { createSecretStore } from '@steadhold/secrets';
import { buildApp } from './app.ts';
import { createUserStore } from './modules/auth/store.ts';
import { createOrgStore } from './modules/orgs/store.ts';
import { createTokenStore } from './kernel/tokens.ts';
import { createMemorySessionStore, SESSION_COOKIE, CSRF_HEADER } from './kernel/sessions.ts';
import { createMemoryRateLimiter } from './kernel/rate-limit.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';

/**
 * P7e: `GET /v1/projects/:ref/usage`.
 *
 * The figures are all ones the control plane already maintains, so what needs
 * testing is not that Postgres can add up — it is the four ways this endpoint can
 * lie:
 *
 *  - units, because `disk_limit_mb` and `ram_limit_mb` are megabytes and every
 *    field on the wire is bytes;
 *  - `bigint`, which `pg` hands back as a *string*, so an unconverted
 *    `disk_used_bytes` would serialise as `"9243795"` and any arithmetic on the
 *    client would concatenate;
 *  - nulls, which must survive as nulls — a project that has never been swept has
 *    no disk figure, and a zero there reads as "using nothing";
 *  - and the pairing of a backup's size with its own run, which is the one place
 *    a plausible query returns two halves of different rows.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const PASSWORD = 'a-perfectly-fine-password';

let pool: Pool; let up = false; let reason = ''; let kekDir: string;
let app: ReturnType<typeof buildApp>;
let nodeId: string;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 8, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'sh-kek-p7e-'));
  writeFileSync(join(kekDir, 'kek_2026_08.key'), randomBytes(32));
  try {
    const organizationId = await ensureBootstrapOrg(pool);
    const secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const users = createUserStore(pool);
    const orgStore = createOrgStore(pool);
    const tokens = createTokenStore(pool);
    const sessions = createMemorySessionStore();
    const principals = { sessions, tokens, staticToken: 'static-token' };
    app = buildApp({
      store: createPgStore({ pool, organizationId, secrets }),
      staticToken: 'static-token',
      auth: {
        pool, users,
        loginLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
        signupLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
        secureCookies: false, ...principals,
      },
      orgs: { orgs: orgStore, users, ...principals },
      projects: { orgs: orgStore, principals },
      projectSecrets: { secrets },
    });

    // A node to hang the database row on. Reused if the stack already has one.
    const n = await pool.query<{ id: string }>(
      `INSERT INTO nodes (hostname, region, status, ram_total_mb, ram_reserved_mb,
                          disk_total_gb, disk_reserved_gb, labels)
       VALUES ('p7e-node', 'eu-central', 'active', 16384, 0, 200, 0, '{}'::jsonb)
       ON CONFLICT (hostname) DO UPDATE SET updated_at = now()
       RETURNING id`);
    nodeId = n.rows[0]!.id;
    up = true;
  } catch (err) { reason = (err as Error).message; up = false; }
}, 20_000);

afterAll(async () => {
  await pool?.end();
  rmSync(kekDir, { recursive: true, force: true });
});

const t = (n: string, fn: () => Promise<void>, ms = 40_000) =>
  it(n, async () => {
    if (!up) throw new Error(`staging control DB not ready (${reason})`);
    await fn();
  }, ms);

let seq = 0;
interface Who { userId: string; email: string; cookie: string; csrf: string }

async function account(): Promise<Who> {
  const addr = `p7e-${Date.now()}-${++seq}@steadhold.test`;
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/signup', payload: { email: addr, password: PASSWORD } });
  const body = res.json() as { user: { id: string }; csrf_token: string };
  return { userId: body.user.id, email: addr, csrf: body.csrf_token,
    cookie: /sh_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]! };
}
const as = (w: Who, m = false) => ({
  cookie: `${SESSION_COOKIE}=${w.cookie}`, ...(m ? { [CSRF_HEADER]: w.csrf } : {}) });

async function project(owner: Who): Promise<{ ref: string; projectId: string; orgId: string }> {
  const org = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner, true),
    payload: { name: 'Usage', slug: `p7e-${Date.now()}-${++seq}`.slice(0, 40) } });
  const orgId = (org.json() as { org: { id: string } }).org.id;
  const created = await app.inject({
    method: 'POST', url: '/v1/projects',
    headers: { ...as(owner, true), 'idempotency-key': `p7e-${Date.now()}-${++seq}` },
    payload: { name: `p7e-app-${++seq}`, org_id: orgId } });
  const { ref, id } = (created.json() as { project: { ref: string; id: string } }).project;
  return { ref, projectId: id.replace('prj_', ''), orgId };
}

/** The row the worker writes at provisioning; this suite writes it directly. */
async function database(projectId: string, over: Record<string, unknown> = {}) {
  const cols = {
    disk_limit_mb: 500, disk_used_bytes: 9_243_795,
    disk_checked_at: new Date('2026-09-01T10:00:00Z'), disk_state: 'ok',
    ram_limit_mb: 512, ram_booked_mb: 350,
    archive_state: 'ok', wal_archive_lag_seconds: 3, wal_archive_pending: 1,
    wal_last_archived_at: new Date('2026-09-01T10:05:00Z'),
    wal_archive_failed_count: 2,
    backup_checked_at: new Date('2026-09-01T10:06:00Z'), backup_check_ok: true,
    last_active_at: new Date('2026-09-01T09:00:00Z'),
    ...over,
  };
  const keys = Object.keys(cols);
  await pool.query(
    `INSERT INTO project_databases (project_id, node_id, volume_name, port, pooler_port,
                                    ram_limit_mb, ${keys.filter((k) => k !== 'ram_limit_mb').join(', ')})
     VALUES ($1, $2, $3, $4, $5, ${keys.map((_, i) => `$${i + 6}`).join(', ')})`,
    [projectId, nodeId, `vol-${++seq}`, 6000 + seq, 7000 + seq,
     cols.ram_limit_mb, ...keys.filter((k) => k !== 'ram_limit_mb').map((k) => (cols as never)[k])]);
}

const usage = (ref: string, w: Who) =>
  app.inject({ method: 'GET', url: `/v1/projects/${ref}/usage`, headers: as(w) });

describe('P7e — project usage', () => {
  t('reports every figure, in bytes, as numbers', async () => {
    const owner = await account();
    const p = await project(owner);
    await database(p.projectId);

    const res = await usage(p.ref, owner);
    expect(res.statusCode).toBe(200);
    const u = (res.json() as { usage: Record<string, Record<string, unknown>> }).usage;

    // Megabytes in the column, bytes on the wire.
    expect(u.disk!.limit_bytes).toBe(500 * 1024 * 1024);
    expect(u.memory!.limit_bytes).toBe(512 * 1024 * 1024);
    expect(u.memory!.booked_bytes).toBe(350 * 1024 * 1024);

    // `bigint` came back from pg as a string; it must not reach the client as one.
    expect(u.disk!.used_bytes).toBe(9_243_795);
    expect(typeof u.disk!.used_bytes).toBe('number');
    expect(typeof u.archiving!.failed_count).toBe('number');

    expect(u.disk!.state).toBe('ok');
    expect(u.disk!.checked_at).toBe('2026-09-01T10:00:00.000Z');
    expect(u.archiving!).toMatchObject({ state: 'ok', lag_seconds: 3, pending_segments: 1 });
    expect(u.activity!.last_active_at).toBe('2026-09-01T09:00:00.000Z');
  });

  t('keeps an unmeasured figure null rather than zero', async () => {
    const owner = await account();
    const p = await project(owner);
    await database(p.projectId, {
      disk_used_bytes: null, disk_checked_at: null,
      wal_archive_lag_seconds: null, wal_archive_pending: null,
      wal_last_archived_at: null, backup_checked_at: null, backup_check_ok: null,
      last_active_at: null,
    });

    const u = ((await usage(p.ref, owner)).json() as
      { usage: Record<string, Record<string, unknown>> }).usage;
    // A zero here would read as "this project is using no disk", which is a
    // different and false statement from "nobody has measured it".
    expect(u.disk!.used_bytes).toBeNull();
    expect(u.disk!.checked_at).toBeNull();
    expect(u.archiving!.lag_seconds).toBeNull();
    expect(u.backups!.check_ok).toBeNull();
    expect(u.activity!.last_active_at).toBeNull();
    // The limit is a configured value, not a sample, so it is always present.
    expect(u.disk!.limit_bytes).toBe(500 * 1024 * 1024);
  });

  /**
   * The pairing test. A failed run carries a `size_bytes` too, and a query that
   * took "latest finished_at" and "latest size" from separate subqueries would
   * report the failed run's size against the succeeded run's time.
   */
  t('reports the size of the latest SUCCEEDED backup, and counts only those', async () => {
    const owner = await account();
    const p = await project(owner);
    await database(p.projectId);
    await pool.query(
      `INSERT INTO backup_runs (project_id, type, status, started_at, finished_at, size_bytes)
       VALUES ($1,'full','succeeded','2026-09-01T01:00:00Z','2026-09-01T01:10:00Z', 111),
              ($1,'full','succeeded','2026-09-02T01:00:00Z','2026-09-02T01:10:00Z', 222),
              ($1,'full','failed',   '2026-09-03T01:00:00Z','2026-09-03T01:10:00Z', 999),
              ($1,'full','running',  '2026-09-04T01:00:00Z', NULL,                  NULL)`,
      [p.projectId]);

    const u = ((await usage(p.ref, owner)).json() as
      { usage: { backups: Record<string, unknown> } }).usage;
    expect(u.backups.last_success_bytes).toBe(222);
    expect(u.backups.last_success_at).toBe('2026-09-02T01:10:00.000Z');
    expect(u.backups.successful_runs).toBe(2);
  });

  t('has no backup figures before the first successful run', async () => {
    const owner = await account();
    const p = await project(owner);
    await database(p.projectId);
    const u = ((await usage(p.ref, owner)).json() as
      { usage: { backups: Record<string, unknown> } }).usage;
    expect(u.backups.last_success_at).toBeNull();
    expect(u.backups.last_success_bytes).toBeNull();
    expect(u.backups.successful_runs).toBe(0);
  });

  t('refuses with 409, naming the status, when there is no database to measure', async () => {
    const owner = await account();
    const p = await project(owner);   // no project_databases row: still creating

    const res = await usage(p.ref, owner);
    expect(res.statusCode).toBe(409);
    const err = (res.json() as { error: { message: string } }).error;
    // Not a 404 — the project exists — and not zeroes, which would be a lie.
    expect(err.message).toMatch(/no database to measure/i);
    expect(err.message).toMatch(/creating|provisioning/);
  });

  t('is a 404 for a ref that does not exist', async () => {
    const owner = await account();
    expect((await usage('nosuchprojectref0000', owner)).statusCode).toBe(404);
  });

  t('EXIT CRITERION: a member can read usage, and an outsider cannot', async () => {
    const owner = await account();
    const p = await project(owner);
    await database(p.projectId);

    // `project.read` is a member capability, so a member sees it.
    const member = await account();
    await pool.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [p.orgId.replace('org_', ''), member.userId.replace('usr_', '')]);
    expect((await usage(p.ref, member)).statusCode).toBe(200);

    // Someone with no membership at all must not learn the project exists.
    const outsider = await account();
    expect((await usage(p.ref, outsider)).statusCode).toBe(404);
  });

  t('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/projects/anything/usage' });
    expect(res.statusCode).toBe(401);
  });
});
