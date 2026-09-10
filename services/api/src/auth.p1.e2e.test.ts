import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.ts';
import { createUserStore } from './modules/auth/store.ts';
import { createTokenStore } from './kernel/tokens.ts';
import { createMemorySessionStore, SESSION_COOKIE, CSRF_HEADER } from './kernel/sessions.ts';
import { createMemoryRateLimiter } from './kernel/rate-limit.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';

/**
 * P1c: the auth endpoints.
 *
 * The tests that matter most are the enumeration ones — an unknown email and a
 * wrong password must be indistinguishable in status, body *and* time — and the
 * CSRF ones, because that rule differs by credential and a route that gets it
 * wrong is exploitable rather than merely broken.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const PASSWORD = 'a-perfectly-fine-password';

let pool: Pool; let up = false; let reason = '';
let users: ReturnType<typeof createUserStore>;
let tokens: ReturnType<typeof createTokenStore>;
let organizationId: string;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  try {
    organizationId = await ensureBootstrapOrg(pool);
    users = createUserStore(pool);
    tokens = createTokenStore(pool);
    up = true;
  } catch (err) { reason = (err as Error).message; up = false; }
}, 20_000);
afterAll(async () => { await pool?.end(); });

let seq = 0;
const email = () => `p1c-${Date.now()}-${++seq}@steadhold.test`;

function app() {
  return buildApp({
    store: createPgStore({ pool, organizationId }),
    staticToken: 'static-token',
    auth: {
      pool, users, tokens,
      sessions: createMemorySessionStore(),
      loginLimiter: createMemoryRateLimiter({ limit: 5, windowSeconds: 60 }),
      signupLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
      secureCookies: false,
      staticToken: 'static-token',
      // The stores are the same objects the routes resolve principals through.
      get staticUserId() { return null; },
    },
  });
}

const t = (n: string, fn: () => Promise<void>, ms = 40_000) =>
  it(n, async () => {
    if (!up) throw new Error(
      `staging control DB not reachable or not migrated (${reason}) — ` +
      './scripts/staging.sh up && ./scripts/migrate-staging.sh');
    await fn();
  }, ms);

async function signup(a = app(), addr = email()) {
  const res = await a.inject({
    method: 'POST', url: '/v1/auth/signup',
    payload: { email: addr, password: PASSWORD, display_name: 'Test User' },
  });
  const cookie = /sh_session=([^;]+)/.exec(String(res.headers['set-cookie'] ?? ''))?.[1];
  return { res, addr, cookie, csrf: (res.json() as { csrf_token: string }).csrf_token, app: a };
}

describe('P1c — signup', () => {
  t('creates an account and signs it in', async () => {
    const { res, cookie, csrf } = await signup();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.id).toMatch(/^usr_/);
    expect(body.user.email_verified).toBe(false);
    expect(cookie).toBeTruthy();
    expect(csrf).toBeTruthy();
    // Said out loud rather than left for the client to discover.
    expect(body.email_verification).toBe('not_sent_yet');
    // The password must not come back in any form.
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
  });

  t('never stores the password, only a scrypt hash', async () => {
    const { addr } = await signup();
    const { rows } = await pool.query<{ h: string }>(
      `select password_hash as h from users where email = $1`, [addr]);
    expect(rows[0]!.h).toMatch(/^scrypt\$65536\$8\$2\$/);
    expect(rows[0]!.h).not.toContain(PASSWORD);
  });

  t('refuses a duplicate email', async () => {
    const a = app();
    const { addr } = await signup(a);
    const again = await a.inject({
      method: 'POST', url: '/v1/auth/signup', payload: { email: addr, password: PASSWORD } });
    expect(again.statusCode).toBe(409);
  });

  t('refuses a short password with a message that says the rule', async () => {
    const res = await app().inject({
      method: 'POST', url: '/v1/auth/signup', payload: { email: email(), password: 'short' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/12/);
  });

  t('audits user.created', async () => {
    const { addr } = await signup();
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from audit_logs
        where action = 'user.created' and metadata->>'email' = $1`, [addr]);
    expect(rows[0]!.n).toBe(1);
  });
});

describe('P1c — login', () => {
  t('returns a session cookie and a CSRF token', async () => {
    const a = app();
    const { addr } = await signup(a);
    const res = await a.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: addr, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(res.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(res.json().csrf_token).toBeTruthy();
  });

  t('an unknown email and a wrong password are indistinguishable', async () => {
    const a = app();
    const { addr } = await signup(a);
    const wrong = await a.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: addr, password: 'not the password' } });
    const unknown = await a.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email: email(), password: PASSWORD } });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    // Same status, same code, same message. Any difference is an enumeration oracle.
    expect(unknown.json()).toEqual({ ...wrong.json(), error: { ...wrong.json().error, request_id: unknown.json().error.request_id } });
  });

  t('spends comparable time on both, so the timing is not an oracle either', async () => {
    const a = app();
    const { addr } = await signup(a);
    const time = async (payload: object) => {
      const t0 = performance.now();
      await a.inject({ method: 'POST', url: '/v1/auth/login', payload });
      return performance.now() - t0;
    };
    const wrong = await time({ email: addr, password: 'not the password' });
    const unknown = await time({ email: email(), password: PASSWORD });
    // Loose on purpose: same order of magnitude is what closes the oracle, and a
    // tight bound would be a flaky test.
    expect(unknown).toBeGreaterThan(wrong / 5);
  });

  t('refuses an account with no password, without saying why', async () => {
    // The bootstrap owner is seeded without a hash on purpose.
    const res = await app().inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: 'dev@steadhold.local', password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Email or password is incorrect.');
  });

  t('rate-limits by identifier', async () => {
    const a = app();
    const { addr } = await signup(a);
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const res = await a.inject({
        method: 'POST', url: '/v1/auth/login', payload: { email: addr, password: 'wrong' } });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });

  t('audits both success and failure, with a reason only operators see', async () => {
    const a = app();
    const { addr } = await signup(a);
    await a.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: addr, password: 'wrong' } });
    await a.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: addr, password: PASSWORD } });
    const { rows } = await pool.query<{ action: string; reason: string | null }>(
      `select action, metadata->>'reason' as reason from audit_logs
        where metadata->>'email' = $1 and action like 'user.log%' order by id`, [addr]);
    expect(rows.map((r) => r.action)).toEqual(['user.login_failed', 'user.logged_in']);
    // Credential stuffing is invisible until someone gets in, without this.
    expect(rows[0]!.reason).toBe('bad_password');
  });
});

describe('P1c — sessions and CSRF', () => {
  t('a session authenticates GET /v1/auth/me', async () => {
    const { app: a, cookie, addr } = await signup();
    const res = await a.inject({
      method: 'GET', url: '/v1/auth/me', headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe(addr);
    expect(res.json().principal).toBe('session');
  });

  t('a cookie-authenticated mutation without the CSRF header is refused', async () => {
    // The browser attaches the cookie whether or not the page meant to — which
    // is what CSRF is.
    const { app: a, cookie } = await signup();
    const res = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` }, payload: { name: 'no-csrf' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/x-csrf-token/);
  });

  t('the same mutation succeeds with the CSRF header', async () => {
    const { app: a, cookie, csrf } = await signup();
    const res = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf },
      payload: { name: 'with-csrf' } });
    expect(res.statusCode).toBe(201);
  });

  t('the refusal carries CSRF_REQUIRED, not a generic UNAUTHORIZED', async () => {
    // The distinction the client needs: this 403 is recoverable without the user
    // doing anything, and "your role is insufficient" is not (D-473).
    const { app: a, cookie } = await signup();
    const res = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` }, payload: { name: 'code' } });
    expect(res.json().error.code).toBe('CSRF_REQUIRED');
  });

  t('GET /me re-issues the CSRF token, so a tab that did not log in can mutate',
    async () => {
    // The bug this closes: `sessionStorage` is per tab and the cookie is per
    // origin, so a new tab, a pasted URL or a restored window had the session
    // and no token — authenticated for every GET, 403 on every mutation, and no
    // way out but logging in again (D-473).
    const { app: a, cookie, csrf } = await signup();

    const me = await a.inject({ method: 'GET', url: '/v1/auth/me',
                                headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    const reissued = (me.json() as { csrf_token?: string }).csrf_token;
    expect(reissued).toBe(csrf);

    // And it is the real thing, not a plausible-looking string.
    const res = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: reissued as string },
      payload: { name: 'from-me' } });
    expect(res.statusCode).toBe(201);
  });

  t('a bearer principal gets no csrf_token from /me', async () => {
    // CSRF does not apply to a token, and a field for it would imply otherwise.
    const { app: a, cookie, csrf } = await signup();
    const made = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf },
      payload: { name: 'pat' } });
    const token = (made.json() as { token: string }).token;

    const me = await a.inject({ method: 'GET', url: '/v1/auth/me',
                                headers: { authorization: `Bearer ${token}` } });
    expect(me.json().principal).toBe('token');
    expect(me.json()).not.toHaveProperty('csrf_token');
  });

  t('logout ends the session', async () => {
    const { app: a, cookie, csrf } = await signup();
    const out = await a.inject({
      method: 'POST', url: '/v1/auth/logout',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    const after = await a.inject({
      method: 'GET', url: '/v1/auth/me', headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(after.statusCode).toBe(401);
  });
});

describe('P1c — personal access tokens', () => {
  t('is returned once and never again', async () => {
    const { app: a, cookie, csrf } = await signup();
    const created = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf },
      payload: { name: 'laptop' } });
    const token = created.json().token as string;
    expect(token).toMatch(/^shp_[A-Za-z0-9_-]{40}$/);

    const list = await a.inject({
      method: 'GET', url: '/v1/auth/tokens', headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    // The list can be wrong and still not leak a credential (D-060).
    expect(JSON.stringify(list.json())).not.toContain(token.slice(12));
    expect(list.json().tokens[0].prefix).toBe(token.slice(0, 12));
  });

  t('authenticates a request, needs no CSRF, and records its use', async () => {
    const { app: a, cookie, csrf } = await signup();
    const created = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf },
      payload: { name: 'ci' } });
    const token = created.json().token as string;

    // No cookie, no CSRF header: a bearer token has to be put there by the
    // caller, so there is nothing to forge.
    const me = await a.inject({
      method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().principal).toBe('token');

    const mutate = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { authorization: `Bearer ${token}` }, payload: { name: 'second' } });
    expect(mutate.statusCode).toBe(201);

    const { rows } = await pool.query<{ used: string | null }>(
      `select last_used_at as used from user_access_tokens where token_prefix = $1`,
      [token.slice(0, 12)]);
    // A live token cannot be used without leaving a trace.
    expect(rows[0]!.used).not.toBeNull();
  });

  t('a revoked token stops working', async () => {
    const { app: a, cookie, csrf } = await signup();
    const created = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf },
      payload: { name: 'doomed' } });
    const { token, id } = created.json() as { token: string; id: string };

    const del = await a.inject({
      method: 'DELETE', url: `/v1/auth/tokens/${id}`,
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, [CSRF_HEADER]: csrf } });
    expect(del.statusCode).toBe(204);
    const after = await a.inject({
      method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });

  t('cannot revoke someone else\'s token', async () => {
    const a = app();
    const one = await signup(a);
    const two = await signup(a);
    const created = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE}=${one.cookie}`, [CSRF_HEADER]: one.csrf },
      payload: { name: 'mine' } });
    const { id } = created.json() as { id: string };

    const res = await a.inject({
      method: 'DELETE', url: `/v1/auth/tokens/${id}`,
      headers: { cookie: `${SESSION_COOKIE}=${two.cookie}`, [CSRF_HEADER]: two.csrf } });
    // 404, not 403: whether that id exists is not two's business.
    expect(res.statusCode).toBe(404);
  });

  t('a forged or unknown shp_ token is refused', async () => {
    const res = await app().inject({
      method: 'GET', url: '/v1/auth/me',
      headers: { authorization: 'Bearer shp_' + 'x'.repeat(40) } });
    expect(res.statusCode).toBe(401);
  });

  t('the static token authenticates but is nobody', async () => {
    const a = app();
    const me = await a.inject({
      method: 'GET', url: '/v1/auth/me', headers: { authorization: 'Bearer static-token' } });
    expect(me.json().user).toBeNull();
    expect(me.json().principal).toBe('static');
    // And it cannot act on a user's own resources.
    const res = await a.inject({
      method: 'POST', url: '/v1/auth/tokens',
      headers: { authorization: 'Bearer static-token' }, payload: { name: 'nope' } });
    expect(res.statusCode).toBe(403);
  });
});
