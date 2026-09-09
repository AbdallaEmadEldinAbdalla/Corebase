import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@steadhold/crypto';
import { createSecretStore, SECRET_NAMES } from '@steadhold/secrets';
import { buildApp } from './app.ts';
import { createUserStore } from './modules/auth/store.ts';
import { createOrgStore } from './modules/orgs/store.ts';
import { createTokenStore } from './kernel/tokens.ts';
import { createMemorySessionStore, SESSION_COOKIE, CSRF_HEADER } from './kernel/sessions.ts';
import { createMemoryRateLimiter } from './kernel/rate-limit.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';

/**
 * P7l: `POST /v1/projects/:ref/db/query`, the D-132 execution path.
 *
 * These tests do **not** need a project container. Every one of them is either a
 * refusal that must happen before a connection is opened, or an authorization
 * decision — and those are precisely the parts that must not be able to regress
 * silently, because a rail that stops refusing looks exactly like a rail that is
 * working. The rails that need a live database (the transaction, the role
 * switcher, the timeout actually firing) are verified against staging in the
 * step's own verification and cannot be asserted here without a provisioned
 * project, which is the `*.e2e.` suite's own boundary (D-223).
 *
 * The refusal ordering is the thing worth protecting: rail 2 runs before any
 * connection, so a `DROP TABLE` with no confirmation costs nothing and cannot be
 * used to open connections against a paused project.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const PASSWORD = 'a-perfectly-fine-password';

let pool: Pool; let up = false; let reason = ''; let kekDir: string;
let app: ReturnType<typeof buildApp>;
let secrets: ReturnType<typeof createSecretStore>;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 8, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'sh-kek-p7l-'));
  writeFileSync(join(kekDir, 'kek_2026_08.key'), randomBytes(32));
  try {
    const organizationId = await ensureBootstrapOrg(pool);
    // This suite's own placement rows, from a previous run. `(node_id, port)` is
    // unique and the port counter restarts with the process, so without this the
    // second run of the file collides with the first one's leftovers — which
    // presents as a constraint violation in every test and looks like a bug in
    // the code under test. They are recognisable by `volume_name`.
    await pool.query(`DELETE FROM project_databases WHERE volume_name = 'v-p7l'`);
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
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
      db: {
        pool, secrets, principals,
        orgs: { roleOf: orgStore.roleOf.bind(orgStore) },
      },
    });
    up = true;
  } catch (err) { reason = (err as Error).message; up = false; }
}, 20_000);

afterAll(async () => {
  await pool?.end();
  rmSync(kekDir, { recursive: true, force: true });
});

const t = (n: string, fn: () => Promise<void>, ms = 30_000) =>
  it(n, async () => {
    if (!up) throw new Error(`staging control DB not ready (${reason})`);
    await fn();
  }, ms);

let seq = 0;
/**
 * A port in the ephemeral range with nothing listening on it, unique per call.
 *
 * Unique because `project_databases` has a unique `(node_id, port)`, and dead
 * because that is the fixture's whole design: if a rail ever stops refusing, the
 * request reaches the connection and fails there, which is a loud failure rather
 * than a quiet pass.
 */
let portSeq = 0;
const deadPort = () => 64000 + (portSeq += 2);

interface Who { userId: string; email: string; cookie: string; csrf: string }

async function account(): Promise<Who> {
  const addr = `p7l-${Date.now()}-${++seq}@steadhold.test`;
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/signup', payload: { email: addr, password: PASSWORD } });
  const body = res.json() as { user: { id: string }; csrf_token: string };
  return { userId: body.user.id, email: addr, csrf: body.csrf_token,
    cookie: /sh_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]! };
}
const as = (w: Who) => ({
  cookie: `${SESSION_COOKIE}=${w.cookie}`, [CSRF_HEADER]: w.csrf });

/**
 * A project that is `ready` with a placement and a console credential, without
 * provisioning anything. Nothing here connects to it — every assertion below is
 * about a decision made before the connection — so a row is the honest fixture.
 */
async function readyProject(owner: Who): Promise<{ ref: string; orgId: string }> {
  const org = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner),
    payload: { name: 'Console', slug: `p7l-${Date.now()}-${++seq}`.slice(0, 40) } });
  const orgId = (org.json() as { org: { id: string } }).org.id;
  const created = await app.inject({
    method: 'POST', url: '/v1/projects',
    headers: { ...as(owner), 'idempotency-key': `p7l-${Date.now()}-${++seq}` },
    payload: { name: `p7l-app-${++seq}`, org_id: orgId } });
  const { ref, id } = (created.json() as { project: { ref: string; id: string } }).project;
  const projectId = id.replace('prj_', '');

  await pool.query(`UPDATE projects SET status = 'ready' WHERE id = $1`, [projectId]);
  // A placement pointing at a port with nothing behind it. Deliberate: every
  // assertion in this file is about a decision made *before* the connection, and
  // a dead port is what proves the decision happened first — a rail that let a
  // request through fails at the connection rather than at the rail.
  await pool.query(
    `INSERT INTO project_databases
       (project_id, node_id, connection_host, port, pooler_port, pg_version,
        volume_name, container_id, ram_limit_mb, status)
     VALUES ($1, (SELECT id FROM nodes ORDER BY created_at LIMIT 1),
             '127.0.0.1', $2, $3, '17.5', 'v-p7l', 'c-p7l', 512, 'running')
     ON CONFLICT (project_id) DO UPDATE
       SET connection_host = '127.0.0.1', port = EXCLUDED.port`,
    // `(node_id, port)` is unique, so every fixture needs its own pair — the
    // first version reused 65432 and the second project in the file collided.
    [projectId, deadPort(), deadPort() + 1]);
  await secrets.put(projectId, SECRET_NAMES.adminRole, 'not-used-by-these-tests');
  return { ref, orgId };
}

const run = (ref: string, w: Who, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/v1/projects/${ref}/db/query`,
               headers: as(w), payload: body });

const msg = (res: { json(): unknown }) =>
  (res.json() as { error: { message: string } }).error.message;

describe('P7l — the console execution path', () => {
  describe('rail 2 refuses before it connects', () => {
    t('a DROP TABLE with no confirmation is 409 and names the object', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await run(p.ref, owner, { sql: 'DROP TABLE public.posts' });
      // 409 rather than 400: the request is well-formed and the answer is "not
      // yet", which is a different thing from "malformed".
      expect(res.statusCode).toBe(409);
      expect(msg(res)).toMatch(/public\.posts/);
      expect(msg(res)).toMatch(/confirm_destructive/);
    });

    t('confirm_destructive alone is not enough for DROP TABLE', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await run(p.ref, owner, {
        sql: 'DROP TABLE public.posts', confirm_destructive: true });
      expect(res.statusCode).toBe(409);
      // The top rung: the flag says the user was asked, the typed name is
      // evidence they read the question.
      expect(msg(res)).toMatch(/Type "public\.posts"/);
    });

    t('the typed name must match what the statement actually names', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await run(p.ref, owner, {
        sql: 'DROP TABLE public.posts',
        confirm_destructive: true, confirm_names: ['posts'] });
      // `posts` is not `public.posts`. Accepting a near-miss would make the
      // typing a formality.
      expect(res.statusCode).toBe(409);
      expect(msg(res)).toMatch(/Type "public\.posts"/);
    });

    t('EXIT CRITERION: a DELETE with no WHERE is refused, and one with a WHERE is not',
      async () => {
        const owner = await account();
        const p = await readyProject(owner);
        const bare = await run(p.ref, owner, { sql: 'DELETE FROM posts' });
        expect(bare.statusCode).toBe(409);
        expect(msg(bare)).toMatch(/no WHERE clause/);

        // With a predicate it clears the guard and goes on to fail at the
        // connection, because port 65432 has nothing behind it. That failure is
        // the proof the guard let it past.
        const guarded = await run(p.ref, owner, { sql: 'DELETE FROM posts WHERE id = 1' });
        expect(guarded.statusCode).not.toBe(409);
      });

    t('BYPASS: a WHERE inside a subquery does not get an unqualified DELETE past', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await run(p.ref, owner, {
        sql: 'DELETE FROM posts USING (SELECT id FROM t WHERE x = 1) s' });
      expect(res.statusCode).toBe(409);
      expect(msg(res)).toMatch(/no WHERE clause/);
    });

    t('BYPASS: a DROP hidden behind a string literal is still a DROP', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await run(p.ref, owner, {
        sql: `SELECT 'x'; DROP TABLE public.posts` });
      expect(res.statusCode).toBe(409);
      expect(msg(res)).toMatch(/public\.posts/);
    });

    t('a harmless statement containing the word DROP in a string is not refused', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await run(p.ref, owner, { sql: `SELECT '; DROP TABLE users; --'` });
      // The false-positive direction matters too: a guard that blocks this is a
      // guard people learn to route around.
      expect(res.statusCode).not.toBe(409);
    });
  });

  describe('the request itself', () => {
    t('an empty script is 400, not a connection attempt', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      expect((await run(p.ref, owner, { sql: '   ' })).statusCode).toBe(400);
      expect((await run(p.ref, owner, { sql: '-- nothing but a comment' })).statusCode)
        .toBe(400);
    });

    t('claims without role=authenticated is refused rather than silently ignored', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await run(p.ref, owner, {
        sql: 'SELECT 1', claims: { sub: 'abc' } });
      expect(res.statusCode).toBe(400);
      expect(msg(res)).toMatch(/claims apply only to role "authenticated"/);
    });

    t('an unknown role is refused by the schema', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      expect((await run(p.ref, owner, { sql: 'SELECT 1', role: 'postgres' })).statusCode)
        .toBe(400);
      expect((await run(p.ref, owner, { sql: 'SELECT 1', role: 'service_role' })).statusCode)
        .toBe(400);
    });

    t('a timeout beyond the 10-minute cap is refused rather than clamped silently',
      async () => {
        const owner = await account();
        const p = await readyProject(owner);
        const res = await run(p.ref, owner, { sql: 'SELECT 1', timeout_ms: 900_000 });
        expect(res.statusCode).toBe(400);
      });
  });

  describe('who may run it', () => {
    t('no session is 401', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await app.inject({
        method: 'POST', url: `/v1/projects/${p.ref}/db/query`, payload: { sql: 'SELECT 1' } });
      expect(res.statusCode).toBe(401);
    });

    t('EXIT CRITERION: a member may run SQL — it is a member capability', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const member = await account();
      await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [p.orgId.replace('org_', ''), member.userId.replace('usr_', '')]);
      // Not 403/404: a member reaching the guard and then the connection is the
      // whole point of D-463 — they can already do this from psql.
      const res = await run(p.ref, member, { sql: 'SELECT 1' });
      expect(res.statusCode).not.toBe(403);
      expect(res.statusCode).not.toBe(404);
    });

    t('an outsider gets 404, not 403 — a ref must not be confirmable', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const outsider = await account();
      expect((await run(p.ref, outsider, { sql: 'SELECT 1' })).statusCode).toBe(404);
    });

    t('an unknown ref is 404', async () => {
      const owner = await account();
      expect((await run('nosuchprojectref0000', owner, { sql: 'SELECT 1' })).statusCode)
        .toBe(404);
    });

    t('the static token is refused: this endpoint runs SQL as a person', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      const res = await app.inject({
        method: 'POST', url: `/v1/projects/${p.ref}/db/query`,
        headers: { authorization: 'Bearer static-token' }, payload: { sql: 'SELECT 1' } });
      // A machine principal has no user to attribute the statement to, and an
      // audited path whose actor is "the platform" is not audited.
      expect(res.statusCode).toBe(403);
      expect(msg(res)).toMatch(/as a person/);
    });
  });

  describe('a project that cannot be reached says why', () => {
    t('a project still creating is 409 and names the state', async () => {
      const owner = await account();
      const org = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner),
        payload: { name: 'C', slug: `p7l-c-${Date.now()}-${++seq}`.slice(0, 40) } });
      const orgId = (org.json() as { org: { id: string } }).org.id;
      const created = await app.inject({
        method: 'POST', url: '/v1/projects',
        headers: { ...as(owner), 'idempotency-key': `p7l-c-${Date.now()}-${++seq}` },
        payload: { name: `p7l-creating-${++seq}`, org_id: orgId } });
      const ref = (created.json() as { project: { ref: string } }).project.ref;

      const res = await run(ref, owner, { sql: 'SELECT 1' });
      expect(res.statusCode).toBe(409);
      expect(msg(res)).toMatch(/is creating, so there is nothing to connect to/);
    });

    t('a paused project is 409 and says to resume it', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      await pool.query(`UPDATE projects SET status = 'paused' WHERE ref = $1`, [p.ref]);
      const res = await run(p.ref, owner, { sql: 'SELECT 1' });
      expect(res.statusCode).toBe(409);
      expect(msg(res)).toMatch(/paused/);
    });

    t('a project with no console credential says so rather than failing to log in',
      async () => {
        const owner = await account();
        const p = await readyProject(owner);
        await pool.query(
          `DELETE FROM project_secrets s USING projects p
            WHERE s.project_id = p.id AND p.ref = $1 AND s.name = $2`,
          [p.ref, SECRET_NAMES.adminRole]);
        const res = await run(p.ref, owner, { sql: 'SELECT 1' });
        expect(res.statusCode).toBe(409);
        expect(msg(res)).toMatch(/before the SQL console existed/);
      });
  });

  describe('the audit trail', () => {
    t('EXIT CRITERION: the attempt is recorded even though the run fails', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      // Port 65432 has nothing behind it, so this cannot succeed — which is
      // exactly the case the ordering exists for.
      await run(p.ref, owner, { sql: 'SELECT 42' });

      const { rows } = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
        `SELECT a.action, a.metadata FROM audit_logs a
           JOIN projects p ON p.id = a.project_id
          WHERE p.ref = $1 AND a.action LIKE 'db.query%'
          ORDER BY a.created_at`, [p.ref]);

      expect(rows.map((r) => r.action)).toContain('db.query');
      expect(rows[0]!.metadata).toMatchObject({ sql: 'SELECT 42', role: 'admin' });
    });

    t('a refused run writes nothing — a refusal is not an attempt on the database',
      async () => {
        const owner = await account();
        const p = await readyProject(owner);
        await run(p.ref, owner, { sql: 'DROP TABLE public.posts' });

        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_logs a
             JOIN projects p ON p.id = a.project_id
            WHERE p.ref = $1 AND a.action LIKE 'db.query%'`, [p.ref]);
        expect(rows[0]!.n).toBe('0');
      });

    t('the audit row names the actor, so a statement is attributable', async () => {
      const owner = await account();
      const p = await readyProject(owner);
      await run(p.ref, owner, { sql: 'SELECT 1' });

      const { rows } = await pool.query<{ actor_user_id: string | null; actor_type: string }>(
        `SELECT a.actor_user_id, a.actor_type FROM audit_logs a
           JOIN projects p ON p.id = a.project_id
          WHERE p.ref = $1 AND a.action = 'db.query'`, [p.ref]);
      expect(rows[0]!.actor_type).toBe('user');
      expect(rows[0]!.actor_user_id).toBe(owner.userId.replace('usr_', ''));
    });
  });
});
