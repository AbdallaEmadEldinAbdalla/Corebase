import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@steadhold/crypto';
import { createSecretStore, SECRET_NAMES } from '@steadhold/secrets';
import { buildApp } from '@steadhold/api';
import { createMemoryRateLimiter } from '@steadhold/api/kernel/rate-limit.ts';
import { createMemorySessionStore, SESSION_COOKIE, CSRF_HEADER } from '@steadhold/api/kernel/sessions.ts';
import { createNullMailer } from '@steadhold/api/modules/project-auth/mail.ts';
import type { Role } from '@steadhold/types';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { IMAGE, LABEL_MANAGED } from './container-spec.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P7s — the dashboard's end-users surface, against a real project database.
 *
 * ## Why it lives here and not in `services/api`
 *
 * `auth.users` only exists on a genuinely provisioned project, and the whole
 * point of this endpoint is *which role reads it*. A suite with a mocked
 * database would pass with the privilege boundary removed — which is the one
 * thing worth proving, because the reason this module exists at all is that
 * `steadhold_admin` cannot read that table and `steadhold_auth` can.
 *
 * ## What is load-bearing here
 *
 * The happy path is the least of it. The assertions that matter are:
 *
 * - **A member is refused**, and refused for the *named* capability. That is the
 *   entire content of D-478, and it is the one line of this feature that decides
 *   who can read a customer's users' email addresses.
 * - **`encrypted_password` reaches no response.** It is a field on the type this
 *   module hands around, so leaking it is one careless spread away.
 * - **A ban revokes sessions.** D-113 makes a ban a login-time check, so without
 *   the revoke a banned user keeps working for up to an hour while the dashboard
 *   shows them banned.
 * - **A stranger cannot tell a real ref from an invented one** (D-474).
 * - **A missing end user says `RESOURCE_NOT_FOUND`,** not `PROJECT_NOT_FOUND`.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const CERT_DIR = process.env.SH_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.SH_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SH_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

let pool: Pool; let docker: Docker; let orgId: string; let kekDir: string;
let secrets: ReturnType<typeof createSecretStore>;
let up = false; let reason = '';

beforeAll(async () => {
  delete process.env['SH_PROJECT_DOMAIN'];
  delete process.env['SH_JWT_ISSUER'];
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'sh-kek-p7s-'));
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
      `insert into organizations (name, slug) values ('P7s','p7s-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P7s integration setup FAILED:', reason);
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
    if (!up) throw new Error(`P7s preconditions not met (${reason}) — `
      + './scripts/staging.sh up && seed-images. '
      + 'This is the P7s done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'p' + String(Date.now() % 100000) + String(++seq).padStart(14, 'r');

interface Fixture { id: string; ref: string; anonKey: string }

async function provision(): Promise<Fixture> {
  await registerNode(pool, {
    hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,'free','ready') returning id, ref::text as ref`,
    [orgId, ref, 'p7s-' + seq]);
  const p = rows[0]!;
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 120_000 });
  const steps = sagas['provision_project']!;
  const job = { id: 'j', project_id: p.id } as unknown as JobRecord;
  for (const name of ['allocate_node', 'create_volume', 'create_network', 'start_container',
    'wait_healthy', 'create_base_roles', 'store_credentials', 'generate_api_keys',
    'write_connection']) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`the provision saga has no step named ${name}`);
    await step.run({ job, log: () => {} });
  }
  const { rows: place } = await pool.query<{ volume_name: string }>(
    `select volume_name from project_databases where project_id=$1`, [p.id]);
  created.volumes.add(place[0]!.volume_name);
  return { ...p, anonKey: (await secrets.get(p.id, SECRET_NAMES.anonKey))! };
}

/**
 * The API with both surfaces wired, plus a dashboard session at a chosen role.
 *
 * `orgs.roleOf` is a stub returning whatever `role` is set to, and that is the
 * right level of fake for this suite: what is under test is `require_` against a
 * named capability, which is a property of the route. Standing up real
 * organizations and memberships to reach it would test the membership store
 * twice and this once.
 */
function api(role: Role) {
  const sessions = createMemorySessionStore();
  const app = buildApp({
    projectAuth: {
      pool, secrets, mailer: createNullMailer(),
      signupLimiter: createMemoryRateLimiter({ limit: 50, windowSeconds: 3600 }),
      loginEmailLimiter: createMemoryRateLimiter({ limit: 50, windowSeconds: 300 }),
      loginIpLimiter: createMemoryRateLimiter({ limit: 200, windowSeconds: 300 }),
      recoverEmailLimiter: createMemoryRateLimiter({ limit: 4, windowSeconds: 3600 }),
      recoverIpLimiter: createMemoryRateLimiter({ limit: 10, windowSeconds: 3600 }),
      verifyIpLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 3600 }),
      refreshIpLimiter: createMemoryRateLimiter({ limit: 60, windowSeconds: 300 }),
    },
    projectUsers: {
      pool, secrets,
      orgs: { roleOf: async () => role },
      principals: { sessions },
    },
  });
  return { app, sessions };
}

/** A dashboard session's cookie and CSRF token, as the browser would hold them. */
async function signedIn(sessions: ReturnType<typeof createMemorySessionStore>) {
  const s = await sessions.create('00000000-0000-0000-0000-0000000000aa');
  return {
    cookie: `${SESSION_COOKIE}=${s.id}`,
    csrf: s.csrf,
  };
}

describe('P7s — the dashboard reads a project\'s end users', () => {
  t('a member is refused, by name, while an admin is served', async () => {
    const p = await provision();

    for (const [role, expected] of [['member', 403], ['admin', 200]] as const) {
      const { app, sessions } = api(role);
      const me = await signedIn(sessions);
      const res = await app.inject({
        method: 'GET', url: `/v1/projects/${p.ref}/auth/users`,
        headers: { cookie: me.cookie } });
      expect(res.statusCode, `${role} listing end users`).toBe(expected);
      if (expected === 403) {
        // The named capability, not a bare "forbidden": this message is what
        // tells a developer to ask an admin rather than to file a bug.
        expect(res.json().error.message).toContain('authuser.read');
      }
      await app.close();
    }
  });

  t('a member cannot delete an end user either', async () => {
    const p = await provision();
    const { app, sessions } = api('member');
    const me = await signedIn(sessions);
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${p.ref}/auth/users/00000000-0000-0000-0000-000000000001`,
      headers: { cookie: me.cookie, [CSRF_HEADER]: me.csrf } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('authuser.manage');
    await app.close();
  });

  t('EXIT CRITERION: lists real end users and leaks no password hash', async () => {
    const p = await provision();
    const { app, sessions } = api('admin');
    const me = await signedIn(sessions);

    for (const n of [1, 2, 3]) {
      const signup = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: `u${n}@p7s.test`, password: `Passw0rd-${n}-xyz!` } });
      expect(signup.statusCode).toBe(200);
    }

    const res = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/auth/users`,
      headers: { cookie: me.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { users: { email: string }[]; has_more: boolean };
    expect(body.users.map((u) => u.email).sort())
      .toEqual(['u1@p7s.test', 'u2@p7s.test', 'u3@p7s.test']);
    expect(body.has_more).toBe(false);
    // The field is on the type this module passes around, so leaking it is one
    // careless spread away. Asserted on the raw payload, not the parsed object.
    expect(res.payload).not.toContain('encrypted_password');
    expect(res.payload).not.toContain('$scrypt$');
    await app.close();
  });

  t('search narrows by an email substring and offers no cursor', async () => {
    const p = await provision();
    const { app, sessions } = api('admin');
    const me = await signedIn(sessions);
    for (const email of ['alice@shop.test', 'bob@shop.test', 'carol@other.test']) {
      await app.inject({ method: 'POST', url: '/auth/v1/signup',
        headers: { apikey: p.anonKey }, payload: { email, password: 'Passw0rd-xyz-1!' } });
    }
    const res = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/auth/users?q=shop`,
      headers: { cookie: me.cookie } });
    const body = res.json() as { users: { email: string }[]; next_cursor: string | null };
    expect(body.users.map((u) => u.email).sort()).toEqual(['alice@shop.test', 'bob@shop.test']);
    // A keyset cursor is only valid for one query string, so a search does not
    // hand one out rather than handing out one that means nothing.
    expect(body.next_cursor).toBeNull();
    await app.close();
  });

  t('EXIT CRITERION: a ban revokes the sessions D-113 cannot check per request',
    async () => {
    const p = await provision();
    const { app, sessions } = api('admin');
    const me = await signedIn(sessions);

    await app.inject({ method: 'POST', url: '/auth/v1/signup',
      headers: { apikey: p.anonKey },
      payload: { email: 'banme@p7s.test', password: 'Passw0rd-ban-1!' } });
    const list = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/auth/users?q=banme`,
      headers: { cookie: me.cookie } });
    const id = (list.json() as { users: { id: string }[] }).users[0]!.id;

    // Confirm through the dashboard, then sign in — which also proves the
    // confirm is real rather than a timestamp nothing reads.
    await app.inject({
      method: 'PATCH', url: `/v1/projects/${p.ref}/auth/users/${id}`,
      headers: { cookie: me.cookie, [CSRF_HEADER]: me.csrf },
      payload: { email_confirm: true } });
    const signIn = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'banme@p7s.test', password: 'Passw0rd-ban-1!' } });
    expect(signIn.statusCode).toBe(200);
    const refresh = (signIn.json() as { refresh_token: string }).refresh_token;
    expect(refresh).toBeTruthy();

    const banned = await app.inject({
      method: 'PATCH', url: `/v1/projects/${p.ref}/auth/users/${id}`,
      headers: { cookie: me.cookie, [CSRF_HEADER]: me.csrf },
      payload: { ban_until: '2099-01-01T00:00:00.000Z' } });
    expect(banned.statusCode).toBe(200);
    expect((banned.json() as { banned_until: string }).banned_until)
      .toBe('2099-01-01T00:00:00.000Z');

    // The guarantee. Without the revoke this refresh succeeds and the user keeps
    // working for up to an hour while the dashboard shows them banned.
    const after = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey }, payload: { refresh_token: refresh } });
    expect(after.statusCode).not.toBe(200);
    expect(after.json().error.code).toBe('invalid_grant');
    await app.close();
  });

  t('a delete is a tombstone, and a second one is RESOURCE_NOT_FOUND', async () => {
    const p = await provision();
    const { app, sessions } = api('admin');
    const me = await signedIn(sessions);
    await app.inject({ method: 'POST', url: '/auth/v1/signup',
      headers: { apikey: p.anonKey },
      payload: { email: 'gone@p7s.test', password: 'Passw0rd-del-1!' } });
    const id = (((await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/auth/users?q=gone`,
      headers: { cookie: me.cookie } })).json()) as { users: { id: string }[] }).users[0]!.id;

    const del = await app.inject({
      method: 'DELETE', url: `/v1/projects/${p.ref}/auth/users/${id}`,
      headers: { cookie: me.cookie, [CSRF_HEADER]: me.csrf } });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/auth/users?q=gone`,
      headers: { cookie: me.cookie } });
    expect((list.json() as { users: unknown[] }).users).toHaveLength(0);

    const again = await app.inject({
      method: 'DELETE', url: `/v1/projects/${p.ref}/auth/users/${id}`,
      headers: { cookie: me.cookie, [CSRF_HEADER]: me.csrf } });
    expect(again.statusCode).toBe(404);
    // Not `PROJECT_NOT_FOUND`, which is what every 404 in this codebase used to
    // borrow and which would send a developer to check their project.
    expect(again.json().error.code).toBe('RESOURCE_NOT_FOUND');
    await app.close();
  });

  t('a mutation without the CSRF header is refused', async () => {
    const p = await provision();
    const { app, sessions } = api('admin');
    const me = await signedIn(sessions);
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${p.ref}/auth/users/00000000-0000-0000-0000-000000000001`,
      headers: { cookie: me.cookie }, payload: { sign_out: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_REQUIRED');
    await app.close();
  });

  t('no session cannot tell a real ref from an invented one', async () => {
    const p = await provision();
    const { app } = api('admin');
    const real = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/auth/users` });
    const fake = await app.inject({
      method: 'GET', url: '/v1/projects/nosuchprojectref00/auth/users' });
    expect(real.statusCode).toBe(fake.statusCode);
    expect(real.json().error.code).toBe(fake.json().error.code);
    await app.close();
  });
});
