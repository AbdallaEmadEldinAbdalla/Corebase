import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { verify as verifyJwt, decodeUnverified, sign as signJwt } from '@corebase/jwt';
import { buildApp } from '@corebase/api';
import { createMemoryRateLimiter } from '@corebase/api/kernel/rate-limit.ts';
import { createNullMailer } from '@corebase/api/modules/project-auth/mail.ts';
import { createMailer } from '@corebase/api/modules/project-auth/mailer.ts';
import { createRedis, createAuthEmailQueue } from '@corebase/queue';
import { createSmtpProvider } from '@corebase/email';
import { createEmailSender } from './email-sender.ts';

const MAILPIT = process.env.CB_MAILPIT_API ?? 'http://127.0.0.1:58025';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { IMAGE, LABEL_MANAGED } from './container-spec.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P4b — signup and password login, end to end, against a real project database.
 *
 * ## Why this test lives in the worker package
 *
 * It needs both halves of the thing it is testing: a genuinely provisioned
 * project (this package's saga, a real Postgres container, real roles and
 * credentials) and the HTTP surface that serves it (`@corebase/api`, a
 * devDependency here). A version of this test with only one of those cannot prove
 * what P4b claims — a mocked database would pass with the privilege boundary
 * removed, and a mocked API would pass with the routes unwired.
 *
 * ## What it is actually for
 *
 * The happy path is table stakes. The load-bearing assertions are the ones about
 * things *not* happening: a taken email address producing a byte-identical
 * response, an unknown email costing the same time as a wrong password, and no
 * response anywhere carrying `encrypted_password`.
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
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-p4b-'));
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
      `insert into organizations (name, slug) values ('B','b4-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P4b integration setup FAILED:', reason);
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
    if (!up) throw new Error(`P4b preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && seed-images. ' +
      'This is the P4b done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'b' + String(Date.now() % 100000) + String(++seq).padStart(14, 'r');

interface Fixture { id: string; ref: string; port: number; anonKey: string; serviceKey: string }

/** A provisioned project with roles, credentials and API keys in place. */
async function provision(): Promise<Fixture> {
  await registerNode(pool, {
    hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,'free','ready') returning id, ref::text as ref`,
    [orgId, ref, 'pauth-' + seq]);
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
  const { rows: place } = await pool.query<{ volume_name: string; port: number }>(
    `select volume_name, port from project_databases where project_id=$1`, [p.id]);
  created.volumes.add(place[0]!.volume_name);
  const anonKey = (await secrets.get(p.id, SECRET_NAMES.anonKey))!;
  const serviceKey = (await secrets.get(p.id, SECRET_NAMES.serviceRoleKey))!;
  return { ...p, port: place[0]!.port, anonKey, serviceKey };
}

/**
 * The API, built in-process with only the data-plane auth module wired.
 *
 * Memory rate limiters rather than Redis, with the doc's limits: what is under
 * test is that the limit is *checked before the hash*, which is a property of the
 * route and not of the counter's storage.
 */
function api(over: Partial<Record<string, number>> = {}) {
  // The mailer is returned alongside the app because there is no sender until
  // P4d: what a flow *owes* is the observable, and the token in the handed-over
  // job is the only way a test can hold the link a real user would click.
  const mailer = createNullMailer();
  const app = buildApp({
    projectAuth: {
      pool, secrets, mailer,
      signupLimiter: createMemoryRateLimiter({ limit: over['signup'] ?? 30, windowSeconds: 3600 }),
      loginEmailLimiter: createMemoryRateLimiter({ limit: 10, windowSeconds: 300 }),
      loginIpLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 300 }),
      recoverEmailLimiter: createMemoryRateLimiter(
        { limit: over['recoverEmail'] ?? 4, windowSeconds: 3600 }),
      recoverIpLimiter: createMemoryRateLimiter({ limit: 10, windowSeconds: 3600 }),
      verifyIpLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 3600 }),
    },
  });
  return Object.assign(app, { mailer });
}

/** The token out of the link a real user would click. */
function tokenFromJob(job: { variables: Record<string, string> }): string {
  const url = new URL(job.variables['action_url']!);
  const token = url.searchParams.get('token');
  if (!token) throw new Error(`no token in action_url: ${job.variables['action_url']}`);
  return token;
}

const setSite = (projectId: string, siteUrl: string | null, extra: string[] = []) =>
  pool.query(
    `insert into project_auth_config (project_id, site_url, additional_redirects)
     values ($1, $2, $3)
     on conflict (project_id) do update
        set site_url = $2, additional_redirects = $3`,
    [projectId, siteUrl, extra]);

const autoconfirm = (projectId: string) => pool.query(
  `insert into project_auth_config (project_id, autoconfirm) values ($1, true)
   on conflict (project_id) do update set autoconfirm = true`, [projectId]);

const asAuthRole = async (p: Fixture) => {
  const c = new Client({
    host: '127.0.0.1', port: p.port, user: 'corebase_auth', database: 'postgres',
    password: (await secrets.get(p.id, SECRET_NAMES.authRole))!,
    connectionTimeoutMillis: 8000,
  });
  await c.connect();
  return c;
};

describe('P4b — signup', () => {
  t('creates a user in the project\'s own database and returns no session unconfirmed', async () => {
    const p = await provision();
    const app = api();
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/signup',
      headers: { apikey: p.anonKey },
      payload: { email: 'ada@example.com', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe('ada@example.com');
    // Confirmation required by default, so no tokens — a session here would mean
    // an unverified address could log in.
    expect(body.access_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();

    // The row is in the *project's* database, not the control plane's (D-004).
    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ email: string; confirmed: Date | null; hash: string }>(
        `select email, email_confirmed_at as confirmed, encrypted_password as hash
           from auth.users`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.email).toBe('ada@example.com');
      expect(rows[0]!.confirmed).toBeNull();
      // scrypt, per D-313 — and never the plaintext.
      expect(rows[0]!.hash.startsWith('scrypt$')).toBe(true);
      expect(rows[0]!.hash).not.toContain('correct horse');
    } finally { await db.end(); }

    // And nothing about this user reached the control plane.
    const { rows: cp } = await pool.query<{ n: number }>(
      `select count(*)::int as n from users where email = 'ada@example.com'`);
    expect(cp[0]!.n).toBe(0);
    await app.close();
  });

  t('EXIT CRITERION: a taken address is indistinguishable from a fresh one', async () => {
    const p = await provision();
    const app = api();
    const payload = { email: 'dup@example.com', password: 'correct horse battery' };
    const first = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey }, payload });
    const second = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey }, payload });

    // Status, and the *set of keys*, byte-identical. Comparing whole bodies would
    // fail on the uuid and the timestamp, which are exactly the fields designed to
    // differ — so the assertion is on the shape, which is what leaks.
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.statusCode).toBe(200);
    expect(Object.keys(second.json()).sort()).toEqual(Object.keys(first.json()).sort());
    expect(second.json().email).toBe('dup@example.com');
    // The decoy is a *different* uuid, not the real user's id — returning the
    // real one would confirm the account exists just as loudly as a 409.
    expect(second.json().id).not.toBe(first.json().id);

    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from auth.users`);
      expect(rows[0]!.n).toBe(1);              // no second row, despite the 200
      const { rows: audit } = await db.query<{ action: string }>(
        `select action from auth.audit_log_entries order by created_at`);
      // The response cannot say it, so the audit log must.
      expect(audit.map((r) => r.action)).toContain('signup_duplicate_email');
    } finally { await db.end(); }
    await app.close();
  });

  t('rejects a weak password specifically, and a bad email generically', async () => {
    const p = await provision();
    const app = api();
    const weak = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'x@example.com', password: 'short' } });
    expect(weak.statusCode).toBe(422);
    expect(weak.json().error.code).toBe('weak_password');
    // Specific on purpose: it reveals nothing about any account and it is the
    // difference between a usable sign-up form and an unusable one.
    expect(weak.json().error.message).toMatch(/at least 8/);

    const bad = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'not-an-email', password: 'correct horse battery' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('validation_failed');
    await app.close();
  });

  t('autoconfirm returns a full session, and the token verifies against the JWKS', async () => {
    const p = await provision();
    await autoconfirm(p.id);
    const app = api();
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'auto@example.com', password: 'correct horse battery' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token_type).toBe('bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.refresh_token.startsWith('cb_rt_')).toBe(true);
    // The allowlisted user object, and specifically not the hash (store.ts).
    expect(body.user.email).toBe('auto@example.com');
    expect(JSON.stringify(body.user)).not.toContain('encrypted_password');
    expect(JSON.stringify(body.user)).not.toContain('scrypt$');

    const pub = (await secrets.get(p.id, SECRET_NAMES.jwtPublicKey))!;
    const claims = verifyJwt(body.access_token, {
      publicKeyPem: pub, issuer: `https://${p.ref}.corebase.co/auth/v1` });
    // Every one of these is load-bearing downstream: PostgREST enforces `aud`,
    // `role` maps to a Postgres role, and `sub` is what auth.uid() reads.
    expect(claims['aud']).toBe('authenticated');
    expect(claims['role']).toBe('authenticated');
    expect(claims['ref']).toBe(p.ref);
    expect(claims['email']).toBe('auto@example.com');
    expect(typeof claims['session_id']).toBe('string');

    // The session id in the token is the session the refresh token belongs to.
    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ id: string; n: number }>(
        `select s.id, (select count(*)::int from auth.refresh_tokens r
                        where r.session_id = s.id) as n from auth.sessions s`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(claims['session_id']);
      expect(rows[0]!.n).toBe(1);
    } finally { await db.end(); }
    await app.close();
  });
});

describe('P4b — password login', () => {
  async function signedUp(p: Fixture, email = 'user@example.com',
                          password = 'correct horse battery') {
    await autoconfirm(p.id);
    const app = api();
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return { app, email, password };
  }

  t('EXIT CRITERION: the right password logs in and the wrong one does not', async () => {
    const p = await provision();
    const { app, email, password } = await signedUp(p);
    const ok = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email, password } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().access_token).toBeTruthy();

    const bad = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email, password: password + 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_credentials');
    await app.close();
  });

  t('EXIT CRITERION: an unknown email is indistinguishable from a wrong password',
    async () => {
      const p = await provision();
      const { app, email, password } = await signedUp(p);

      const unknown = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: p.anonKey },
        payload: { email: 'nobody@example.com', password } });
      const wrong = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: p.anonKey }, payload: { email, password: 'wrong wrong wrong' } });

      // Identical envelope: status, code, and message. A different message is a
      // different oracle.
      expect(unknown.statusCode).toBe(wrong.statusCode);
      expect(unknown.json().error.code).toBe(wrong.json().error.code);
      expect(unknown.json().error.message).toBe(wrong.json().error.message);

      // And identical *cost*, which is the half a response-shape test misses.
      // Measured on a fresh request each time, taking the better of two runs: the
      // assertion is that the unknown-email path still pays for a scrypt verify,
      // so a factor-of-two bound is generous while still catching the real bug —
      // skipping the decoy hash makes this path ~50x faster, not 1.5x.
      const time = async (payload: Record<string, string>) => {
        const t0 = performance.now();
        await app.inject({
          method: 'POST', url: '/auth/v1/token?grant_type=password',
          headers: { apikey: p.anonKey }, payload });
        return performance.now() - t0;
      };
      const noUser = Math.min(await time({ email: 'ghost1@example.com', password }),
                              await time({ email: 'ghost2@example.com', password }));
      const badPw = Math.min(await time({ email, password: 'nope nope nope' }),
                             await time({ email, password: 'nope nope nopf' }));
      expect(noUser).toBeGreaterThan(badPw / 3);
      await app.close();
    });

  t('an unconfirmed user is told so — but only with the correct password', async () => {
    const p = await provision();
    const app = api();
    const password = 'correct horse battery';
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'unconf@example.com', password } });   // no autoconfirm

    const right = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email: 'unconf@example.com', password } });
    expect(right.statusCode).toBe(400);
    expect(right.json().error.code).toBe('email_not_confirmed');

    // With the wrong password it is generic again: the confirmation state is only
    // ever disclosed to someone who already knows the password, which is why the
    // named code is not an enumeration oracle.
    const wrong = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'unconf@example.com', password: 'wrong wrong wrong' } });
    expect(wrong.json().error.code).toBe('invalid_credentials');
    await app.close();
  });

  t('a banned user gets the generic error, and the audit log gets the real one', async () => {
    const p = await provision();
    const { app, email, password } = await signedUp(p);
    const db = await asAuthRole(p);
    try {
      await db.query(`update auth.users set banned_until = now() + interval '1 day'`);
      const res = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: p.anonKey }, payload: { email, password } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_credentials');
      const { rows } = await db.query<{ action: string }>(
        `select action from auth.audit_log_entries order by created_at desc limit 1`);
      expect(rows[0]!.action).toBe('login_failed_banned');
    } finally { await db.end(); }
    await app.close();
  });

  t('a soft-deleted user cannot log in, and the address is free again', async () => {
    const p = await provision();
    const { app, email, password } = await signedUp(p);
    const db = await asAuthRole(p);
    try { await db.query(`update auth.users set deleted_at = now()`); }
    finally { await db.end(); }

    const res = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email, password } });
    expect(res.json().error.code).toBe('invalid_credentials');

    // The partial index frees the address; signup must therefore succeed rather
    // than hitting a constraint on the tombstone.
    const again = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email, password } });
    expect(again.statusCode).toBe(200);
    expect(again.json().user?.id ?? again.json().id).toBeTruthy();
    await app.close();
  });

  t('the login path is rate limited before it hashes anything', async () => {
    const p = await provision();
    await autoconfirm(p.id);
    // limit 3, so the test is about the ordering rather than about counting to ten.
    const app = buildApp({
      projectAuth: {
        pool, secrets,
        signupLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 3600 }),
        loginEmailLimiter: createMemoryRateLimiter({ limit: 3, windowSeconds: 300 }),
        loginIpLimiter: createMemoryRateLimiter({ limit: 100, windowSeconds: 300 }),
        recoverEmailLimiter: createMemoryRateLimiter({ limit: 4, windowSeconds: 3600 }),
        recoverIpLimiter: createMemoryRateLimiter({ limit: 10, windowSeconds: 3600 }),
        verifyIpLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 3600 }),
      },
    });
    const attempt = () => app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'brute@example.com', password: 'guessing away' } });
    expect((await attempt()).statusCode).toBe(400);
    expect((await attempt()).statusCode).toBe(400);
    expect((await attempt()).statusCode).toBe(400);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('over_rate_limit');

    // The point of the ordering: the 4th attempt must not have cost a 64 MiB
    // scrypt call. It is far faster than a hash, which is the observable proof.
    const t0 = performance.now();
    await attempt();
    expect(performance.now() - t0).toBeLessThan(50);
    await app.close();
  });
});

describe('P4b — the project boundary', () => {
  t('no apikey, a garbage apikey, and another project\'s apikey are all refused',
    async () => {
      const a = await provision();
      const b = await provision();
      const app = api();
      const payload = { email: 'x@example.com', password: 'correct horse battery' };

      const none = await app.inject({
        method: 'POST', url: '/auth/v1/signup', payload });
      expect(none.statusCode).toBe(401);

      const junk = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: 'not.a.jwt' }, payload });
      expect(junk.statusCode).toBe(401);

      // The real test: B's key is a *valid* JWT signed by a *real* project key.
      // It must work for B and be refused for nothing else — and since the ref
      // comes from inside the signed token, using it simply serves B. So the
      // check that matters is that a token whose claims name A but whose
      // signature is B's is refused.
      const forged = b.anonKey.split('.');
      const aClaims = decodeUnverified(a.anonKey);
      expect(aClaims.claims['ref']).toBe(a.ref);
      const spliced = [forged[0], Buffer.from(JSON.stringify(
        { ...aClaims.claims })).toString('base64url'), forged[2]].join('.');
      const bad = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: spliced }, payload });
      expect(bad.statusCode).toBe(401);

      // Nothing was written to either project.
      for (const p of [a, b]) {
        const db = await asAuthRole(p);
        try {
          const { rows } = await db.query<{ n: number }>(
            `select count(*)::int as n from auth.users`);
          expect(rows[0]!.n).toBe(0);
        } finally { await db.end(); }
      }
      await app.close();
    });

  t('a user access token is not accepted as an apikey — by either of two checks',
    async () => {
      const p = await provision();
      await autoconfirm(p.id);
      const app = api();
      const creds = { email: 'self@example.com', password: 'correct horse battery' };
      const signup = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: creds });
      const access = signup.json().access_token as string;

      // A real access token, signed by the same project key, naming the same ref.
      const res = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: access }, payload: creds });
      expect(res.statusCode).toBe(401);

      // …but *why* it was refused matters, and the first live run of this test
      // showed it passing with the role check disabled: an access token's `iss`
      // ends in `/auth/v1` and an API key's does not, so the issuer pin (D-319)
      // was doing all the work and the role check (D-320) was unproven.
      //
      // So: mint a token that passes the issuer pin and carries a *user's* role.
      // Only the holder of the project's private key can do this, which is
      // exactly why the test can and an attacker cannot — the point is that the
      // role check is the layer that survives if the two issuers are ever
      // unified, and a check no test can fail is a check nobody should trust.
      const priv = (await secrets.get(p.id, SECRET_NAMES.jwtPrivateKey))!;
      const kid = (await secrets.get(p.id, SECRET_NAMES.jwtKid))!;
      const now = Math.floor(Date.now() / 1000);
      const asKeyIssuer = signJwt({
        iss: `https://${p.ref}.corebase.co`,      // the API-key issuer, not the auth one
        ref: p.ref, role: 'authenticated', sub: 'someone', iat: now, exp: now + 3600,
      }, { privateKeyPem: priv, kid });
      const roleRes = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: asKeyIssuer }, payload: creds });
      expect(roleRes.statusCode).toBe(401);
      await app.close();
    });

  t('the module is healthy without any project, and JWKS verifies its own tokens',
    async () => {
      const p = await provision();
      await autoconfirm(p.id);
      const app = api();

      // Health must not depend on a tenant: an operator asking whether auth is up
      // is not asking whether one customer's database is up.
      const health = await app.inject({ method: 'GET', url: '/auth/v1/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().service).toBe('auth');

      const jwks = await app.inject({
        method: 'GET', url: `/auth/v1/.well-known/jwks.json?ref=${p.ref}` });
      expect(jwks.statusCode).toBe(200);
      const keys = jwks.json().keys as Array<Record<string, string>>;
      expect(keys).toHaveLength(1);
      expect(keys[0]!.kty).toBe('EC');
      expect(keys[0]!.crv).toBe('P-256');
      // No private material, ever. `d` is the private scalar.
      expect(keys[0]!['d']).toBeUndefined();
      expect(JSON.stringify(jwks.json())).not.toContain('PRIVATE');
      // And the kid matches what the tokens are signed with, which is the whole
      // point of publishing it.
      const signup = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: 'jwks@example.com', password: 'correct horse battery' } });
      const header = JSON.parse(Buffer.from(
        (signup.json().access_token as string).split('.')[0]!, 'base64url').toString());
      expect(header.kid).toBe(keys[0]!.kid);
      expect(header.alg).toBe('ES256');
      await app.close();
    });

  t('an unsupported grant type says so instead of failing obscurely', async () => {
    const p = await provision();
    const app = api();
    const none = await app.inject({
      method: 'POST', url: '/auth/v1/token', headers: { apikey: p.anonKey },
      payload: { email: 'x@example.com', password: 'y' } });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('validation_failed');

    // Not built yet, and it says which — a client doing the right thing against a
    // server that has not caught up should not be told its token is bad.
    const refresh = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey }, payload: { refresh_token: 'cb_rt_whatever' } });
    expect(refresh.statusCode).toBe(501);
    await app.close();
  });
});

describe('P4c — email confirmation', () => {
  t('EXIT CRITERION: a signup link confirms the address and issues a session', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    const signup = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'conf@example.com', password: 'correct horse battery' } });
    expect(signup.statusCode).toBe(200);
    // No session yet — that is the whole point of requiring confirmation.
    expect(signup.json().access_token).toBeUndefined();

    // Exactly one mail owed, and its link is built by us from a validated
    // redirect (D-116) — never from anything the client sent.
    expect(app.mailer.jobs).toHaveLength(1);
    const job = app.mailer.jobs[0]!;
    expect(job.email).toBe('confirmation');
    expect(job.to).toBe('conf@example.com');
    expect(job.variables['action_url']).toContain(`https://${p.ref}.corebase.co/auth/v1/verify`);

    const token = tokenFromJob(job);
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token, type: 'signup' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBeTruthy();
    expect(res.json().user.email_confirmed_at).toBeTruthy();

    // And the login that was refused before now works.
    const login = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'conf@example.com', password: 'correct horse battery' } });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  t('EXIT CRITERION: a verification link is single-use', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'once@example.com', password: 'correct horse battery' } });
    const token = tokenFromJob(app.mailer.jobs[0]!);

    const first = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token, type: 'signup' } });
    expect(first.statusCode).toBe(200);

    // A forwarded mail, a scanner's prefetch, a browser's back button: all
    // replays, and none of them may produce a second session.
    const second = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token, type: 'signup' } });
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('invalid_token');

    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ n: number; used: Date | null }>(
        `select (select count(*)::int from auth.sessions) as n,
                (select used_at from auth.one_time_tokens) as used`);
      expect(rows[0]!.n).toBe(1);          // one session, not two
      expect(rows[0]!.used).not.toBeNull();
    } finally { await db.end(); }
    await app.close();
  });

  t('concurrent clicks on one link yield exactly one session', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'race@example.com', password: 'correct horse battery' } });
    const token = tokenFromJob(app.mailer.jobs[0]!);

    // The reason `consumeOneTimeToken` is one UPDATE and not select-then-update:
    // both of these pass a `used_at IS NULL` check if the check is its own
    // statement, and both then issue a session.
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
        payload: { token, type: 'signup' } }),
      app.inject({ method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
        payload: { token, type: 'signup' } }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 401]);

    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from auth.sessions`);
      expect(rows[0]!.n).toBe(1);
    } finally { await db.end(); }
    await app.close();
  });

  t('resend replaces the previous link rather than adding another', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'again@example.com', password: 'correct horse battery' } });
    const first = tokenFromJob(app.mailer.jobs[0]!);

    const resend = await app.inject({
      method: 'POST', url: '/auth/v1/resend', headers: { apikey: p.anonKey },
      payload: { email: 'again@example.com' } });
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toEqual({});
    const second = tokenFromJob(app.mailer.jobs[1]!);
    expect(second).not.toBe(first);

    // Ten resends must leave one live credential in an inbox, not ten. The old
    // link is dead the moment a new one is issued.
    const stale = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: first, type: 'signup' } });
    expect(stale.statusCode).toBe(401);

    const fresh = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: second, type: 'signup' } });
    expect(fresh.statusCode).toBe(200);

    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from auth.one_time_tokens`);
      expect(rows[0]!.n).toBe(1);          // the UNIQUE (user, type) doing its job
    } finally { await db.end(); }
    await app.close();
  });

  t('resend to an unknown or already-confirmed address sends nothing and says nothing',
    async () => {
      const p = await provision();
      await setSite(p.id, 'https://app.example.com');
      await autoconfirm(p.id);
      const app = api();
      await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: 'done@example.com', password: 'correct horse battery' } });
      app.mailer.jobs.length = 0;

      for (const email of ['done@example.com', 'nobody@example.com']) {
        const res = await app.inject({
          method: 'POST', url: '/auth/v1/resend', headers: { apikey: p.anonKey },
          payload: { email } });
        // Same 200 and same empty body for both, or the endpoint answers "is
        // this address registered" for anyone who asks.
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({});
      }
      // And no mail either way: re-confirming a confirmed address is a way to
      // make our sending domain deliver to any registered address on demand.
      expect(app.mailer.jobs).toHaveLength(0);

      const db = await asAuthRole(p);
      try {
        const { rows } = await db.query<{ action: string }>(
          `select action from auth.audit_log_entries
            where action like 'resend%' order by created_at`);
        expect(rows.map((r) => r.action))
          .toEqual(['resend_already_confirmed', 'resend_unknown_email']);
      } finally { await db.end(); }
      await app.close();
    });

  t('a signup on a taken unconfirmed address refreshes that user\'s own link', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    const payload = { email: 'twice@example.com', password: 'correct horse battery' };
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey }, payload });
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey }, payload });

    // For someone who never finished signing up, a second attempt is
    // indistinguishable from retrying their own — so they get a working link,
    // not a "you already have an account" notice about an account they cannot
    // use yet.
    expect(app.mailer.jobs.map((j) => j.email)).toEqual(['confirmation', 'confirmation']);
    const fresh = tokenFromJob(app.mailer.jobs[1]!);
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: fresh, type: 'signup' } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  t('a signup on a taken confirmed address notifies the owner and nobody else', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    await autoconfirm(p.id);
    const app = api();
    const payload = { email: 'owner@example.com', password: 'correct horse battery' };
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey }, payload });
    app.mailer.jobs.length = 0;

    const second = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey }, payload });
    expect(second.statusCode).toBe(200);
    // The response cannot say the address is taken, so this mail is the only
    // channel that can — and it goes to an address whose owner already has an
    // account, so it tells the attacker nothing.
    expect(app.mailer.jobs).toHaveLength(1);
    expect(app.mailer.jobs[0]!.email).toBe('account_exists_notice');
    expect(app.mailer.jobs[0]!.to).toBe('owner@example.com');
    // No link in it: there is no token, and a "you already have an account"
    // mail carrying a credential would be a password-reset nobody asked for.
    expect(app.mailer.jobs[0]!.variables['action_url']).toBeUndefined();
    await app.close();
  });
});

describe('P4c — password recovery', () => {
  t('EXIT CRITERION: recover answers identically for a real and an unknown address',
    async () => {
      const p = await provision();
      await setSite(p.id, 'https://app.example.com');
      await autoconfirm(p.id);
      const app = api();
      await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: 'real@example.com', password: 'correct horse battery' } });
      app.mailer.jobs.length = 0;

      const real = await app.inject({
        method: 'POST', url: '/auth/v1/recover', headers: { apikey: p.anonKey },
        payload: { email: 'real@example.com' } });
      const fake = await app.inject({
        method: 'POST', url: '/auth/v1/recover', headers: { apikey: p.anonKey },
        payload: { email: 'ghost@example.com' } });

      // `/recover` answering honestly is a bare "does this person have an
      // account here" service — worse than signup, which at least needs a
      // password guess.
      expect(real.statusCode).toBe(200);
      expect(fake.statusCode).toBe(200);
      expect(real.json()).toEqual({});
      expect(fake.json()).toEqual({});
      expect(real.headers['content-type']).toBe(fake.headers['content-type']);

      // One mail, to the address that exists.
      expect(app.mailer.jobs.map((j) => j.email)).toEqual(['recovery']);
      expect(app.mailer.jobs[0]!.to).toBe('real@example.com');
      await app.close();
    });

  t('a recovery link is single-use, hands back a session, and expires in an hour',
    async () => {
      const p = await provision();
      await setSite(p.id, 'https://app.example.com');
      await autoconfirm(p.id);
      const app = api();
      await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: 'reset@example.com', password: 'correct horse battery' } });
      app.mailer.jobs.length = 0;
      await app.inject({
        method: 'POST', url: '/auth/v1/recover', headers: { apikey: p.anonKey },
        payload: { email: 'reset@example.com' } });
      const token = tokenFromJob(app.mailer.jobs[0]!);

      const db = await asAuthRole(p);
      try {
        // One hour, not the confirmation token's twenty-four: a recovery token
        // is a password reset sitting in an inbox.
        const { rows } = await db.query<{ secs: number; type: string }>(
          `select extract(epoch from (expires_at - created_at))::int as secs, token_type as type
             from auth.one_time_tokens`);
        expect(rows[0]!.type).toBe('recovery');
        expect(rows[0]!.secs).toBe(3600);
      } finally { await db.end(); }

      const first = await app.inject({
        method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
        payload: { token, type: 'recovery' } });
      expect(first.statusCode).toBe(200);
      expect(first.json().access_token).toBeTruthy();

      const replay = await app.inject({
        method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
        payload: { token, type: 'recovery' } });
      expect(replay.statusCode).toBe(401);
      await app.close();
    });

  t('a recovery link also confirms an unconfirmed address', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'never@example.com', password: 'correct horse battery' } });
    app.mailer.jobs.length = 0;
    await app.inject({
      method: 'POST', url: '/auth/v1/recover', headers: { apikey: p.anonKey },
      payload: { email: 'never@example.com' } });

    // Clicking a recovery link proves control of the mailbox exactly as well as
    // clicking a confirmation link. Leaving them unconfirmed would send them
    // through a successful reset into a login that refuses them.
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: tokenFromJob(app.mailer.jobs[0]!), type: 'recovery' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email_confirmed_at).toBeTruthy();
    await app.close();
  });

  t('a recovery link carries a validated destination, not the one asked for', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    await autoconfirm(p.id);
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'redirreset@example.com', password: 'correct horse battery' } });
    app.mailer.jobs.length = 0;
    await app.inject({
      method: 'POST', url: '/auth/v1/recover', headers: { apikey: p.anonKey },
      payload: { email: 'redirreset@example.com', redirect_to: 'https://evil.test/collect' } });

    // The first version of this endpoint passed `redirect_to` straight into the
    // link, which would have made Corebase send an attacker-chosen destination
    // from its own domain — the exact capability D-116's fixed templates exist
    // to withhold. The mail is the artefact, so the mail is what is asserted on.
    const url = new URL(app.mailer.jobs[0]!.variables['action_url']!);
    expect(url.searchParams.get('redirect_to')).toBe('https://app.example.com');
    expect(app.mailer.jobs[0]!.variables['action_url']).not.toContain('evil.test');
    await app.close();
  });

  t('the per-address bucket stops targeted inbox flooding', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    await autoconfirm(p.id);
    const app = api({ recoverEmail: 2 });
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'flood@example.com', password: 'correct horse battery' } });
    app.mailer.jobs.length = 0;

    const ask = () => app.inject({
      method: 'POST', url: '/auth/v1/recover', headers: { apikey: p.anonKey },
      payload: { email: 'flood@example.com' } });
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    const limited = await ask();
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('over_rate_limit');
    // Two mails owed, not three: the cap is on the sending, not just the reply.
    expect(app.mailer.jobs).toHaveLength(2);
    await app.close();
  });
});

describe('P4c — the redirect allowlist, live', () => {
  t('EXIT CRITERION: an unlisted redirect_to is replaced, never honoured', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com', ['https://staging.example.com/auth']);
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'redir@example.com', password: 'correct horse battery',
                 redirect_to: 'https://evil.test/collect' } });

    // The link in the mail already carries the *substituted* destination: a
    // redirect is validated when the link is built, not only when it is followed.
    const url = new URL(app.mailer.jobs[0]!.variables['action_url']!);
    expect(url.searchParams.get('redirect_to')).toBe('https://app.example.com');

    const token = tokenFromJob(app.mailer.jobs[0]!);
    const res = await app.inject({
      method: 'GET',
      url: `/auth/v1/verify?token=${token}&type=signup&redirect_to=${
        encodeURIComponent('https://evil.test/collect')}`,
      headers: { apikey: p.anonKey } });
    expect(res.statusCode).toBe(302);
    const location = res.headers['location'] as string;
    // The tokens went to the project's own site, and nowhere near evil.test.
    expect(location.startsWith('https://app.example.com#')).toBe(true);
    expect(location).not.toContain('evil.test');
    const frag = new URLSearchParams(location.split('#')[1]);
    expect(frag.get('access_token')).toBeTruthy();
    expect(frag.get('refresh_token')!.startsWith('cb_rt_')).toBe(true);

    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ action: string }>(
        `select action from auth.audit_log_entries
          where action = 'redirect_not_allowlisted'`);
      // Substituting silently is right for the user and invisible to the
      // developer, so it is audited — and this row is also what an exfiltration
      // attempt looks like from our side.
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } finally { await db.end(); }
    await app.close();
  });

  t('the GET form puts tokens in the fragment, never in the query string', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com', ['https://app.example.com/welcome']);
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'frag@example.com', password: 'correct horse battery',
                 redirect_to: 'https://app.example.com/welcome' } });
    const token = tokenFromJob(app.mailer.jobs[0]!);
    const res = await app.inject({
      method: 'GET',
      url: `/auth/v1/verify?token=${token}&type=signup&redirect_to=${
        encodeURIComponent('https://app.example.com/welcome')}`,
      headers: { apikey: p.anonKey } });
    const location = res.headers['location'] as string;
    // A query string reaches the destination's access log, every proxy in
    // between, and the Referer header. A fragment reaches none of them.
    const [head, fragment] = location.split('#');
    expect(head).toBe('https://app.example.com/welcome');
    expect(head).not.toContain('access_token');
    expect(new URLSearchParams(fragment).get('access_token')).toBeTruthy();
    await app.close();
  });

  t('a bad token redirects with a generic error rather than leaking which', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    const res = await app.inject({
      method: 'GET', url: '/auth/v1/verify?token=nonsense&type=signup',
      headers: { apikey: p.anonKey } });
    expect(res.statusCode).toBe(302);
    const frag = new URLSearchParams((res.headers['location'] as string).split('#')[1]);
    // Unknown, spent and expired are one code: telling them apart says whether
    // an address is registered and whether a link was already used.
    expect(frag.get('error')).toBe('invalid_token');
    expect(frag.get('access_token')).toBeNull();
    await app.close();
  });

  t('a project with no site_url gets JSON instead of a guessed redirect', async () => {
    const p = await provision();
    await setSite(p.id, null);
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'nosite@example.com', password: 'correct horse battery' } });
    const token = tokenFromJob(app.mailer.jobs[0]!);
    const res = await app.inject({
      method: 'GET', url: `/auth/v1/verify?token=${token}&type=signup`,
      headers: { apikey: p.anonKey } });
    // Inventing a destination would be exactly the open redirect this module
    // exists to prevent, so it answers in JSON and lets the client decide.
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBeTruthy();
    await app.close();
  });

  t('a token of the wrong type is refused', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'wrongtype@example.com', password: 'correct horse battery' } });
    const token = tokenFromJob(app.mailer.jobs[0]!);

    // A confirmation token presented as a recovery token: same bytes, different
    // authority. `token_type` is part of the lookup for that reason.
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token, type: 'recovery' } });
    expect(res.statusCode).toBe(401);

    // Unspent, so the right type still works — a wrong-type attempt must not
    // burn somebody's link.
    const ok = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token, type: 'signup' } });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  t('only the hash of a token is ever stored', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'hashed@example.com', password: 'correct horse battery' } });
    const token = tokenFromJob(app.mailer.jobs[0]!);

    const db = await asAuthRole(p);
    try {
      // A dump of this table must not be a bag of live links. These tokens are
      // bearer credentials with no second factor at all, so it matters more here
      // than for passwords.
      const { rows } = await db.query<{ hex: string; len: number }>(
        `select encode(token_hash,'hex') as hex, length(token_hash) as len
           from auth.one_time_tokens`);
      expect(rows[0]!.len).toBe(32);                 // sha256
      expect(rows[0]!.hex).not.toContain(Buffer.from(token).toString('hex'));
      const { rows: found } = await db.query<{ n: number }>(
        `select count(*)::int as n from auth.one_time_tokens
          where token_hash::text like $1`, [`%${token.slice(0, 8)}%`]);
      expect(found[0]!.n).toBe(0);
    } finally { await db.end(); }
    await app.close();
  });
});

describe('P4c + P4d — a signup link that actually arrives', () => {
  t('EXIT CRITERION: signup → queue → SMTP → the link in the mail confirms the user',
    async () => {
      const p = await provision();
      await setSite(p.id, 'https://app.example.com');

      // The real mailer this time: suppression, caps, a send row, a queued job.
      // Everything before this asserted on what a flow *owed*; this asserts that
      // a user with an inbox can finish signing up.
      const redis = createRedis(process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379');
      const queueRedis = createRedis(process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379');
      const queue = createAuthEmailQueue(queueRedis);
      await queue.obliterate({ force: true }).catch(() => undefined);
      const stale = await redis.keys('cb:mail:*');
      if (stale.length) await redis.del(...stale);
      await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' }).then((r) => r.text());

      const app = buildApp({
        projectAuth: {
          pool, secrets,
          mailer: createMailer({ pool, redis, queue }),
          signupLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 3600 }),
          loginEmailLimiter: createMemoryRateLimiter({ limit: 10, windowSeconds: 300 }),
          loginIpLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 300 }),
          recoverEmailLimiter: createMemoryRateLimiter({ limit: 4, windowSeconds: 3600 }),
          recoverIpLimiter: createMemoryRateLimiter({ limit: 10, windowSeconds: 3600 }),
          verifyIpLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 3600 }),
        },
      });

      try {
        const signup = await app.inject({
          method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
          payload: { email: 'inbox@example.test', password: 'correct horse battery' } });
        expect(signup.statusCode).toBe(200);

        const sender = createEmailSender({
          pool, from: 'auth@mail.corebase.co',
          provider: createSmtpProvider({
            host: process.env.CB_SMTP_HOST ?? '127.0.0.1',
            port: Number(process.env.CB_SMTP_PORT ?? 51025),
            tls: 'off', timeoutMs: 8000 }),
        });
        const jobs = await queue.getJobs(['waiting', 'delayed']);
        expect(jobs).toHaveLength(1);
        for (const job of jobs) await sender.handle(job.data, job.attemptsMade);

        // Read the link out of the delivered message rather than out of our own
        // job payload: what is under test is that the URL survived rendering,
        // MIME encoding and the SMTP conversation intact. Reading the payload
        // would test the same object twice.
        const list = await fetch(`${MAILPIT}/api/v1/messages`).then((r) => r.json()) as
          { messages: Array<{ ID: string; To: Array<{ Address: string }> }> };
        const mail = list.messages.find((m) => m.To[0]?.Address === 'inbox@example.test');
        expect(mail).toBeTruthy();
        const raw = await fetch(`${MAILPIT}/api/v1/message/${mail!.ID}/raw`).then((r) => r.text());
        const decoded = raw.split('Content-Transfer-Encoding: base64')
          .slice(1).map((part) => Buffer.from(
            part.split('--')[0]!.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'))
          .join('\n');
        const link = decoded.match(/https:\/\/[^\s"<]+verify\?[^\s"<]+/)?.[0];
        expect(link).toBeTruthy();

        const url = new URL(link!.replace(/&amp;/g, '&'));
        const token = url.searchParams.get('token')!;
        const verify = await app.inject({
          method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
          payload: { token, type: url.searchParams.get('type') } });
        expect(verify.statusCode).toBe(200);
        expect(verify.json().user.email_confirmed_at).toBeTruthy();

        // And the login that was refused before the mail arrived now works.
        const login = await app.inject({
          method: 'POST', url: '/auth/v1/token?grant_type=password',
          headers: { apikey: p.anonKey },
          payload: { email: 'inbox@example.test', password: 'correct horse battery' } });
        expect(login.statusCode).toBe(200);

        const { rows } = await pool.query<{ status: string }>(
          `select status from email_sends where project_id = $1`, [p.id]);
        expect(rows[0]!.status).toBe('sent');
      } finally {
        await app.close();
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
        await queueRedis.quit();
        await redis.quit();
      }
    }, 300_000);
});
