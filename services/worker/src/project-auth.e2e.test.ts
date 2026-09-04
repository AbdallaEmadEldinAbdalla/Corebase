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
import { createPgStore } from '@corebase/api/modules/control-plane/store.pg.ts';
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
      refreshIpLimiter: createMemoryRateLimiter(
        { limit: over['refresh'] ?? 60, windowSeconds: 300 }),
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
        refreshIpLimiter: createMemoryRateLimiter({ limit: 60, windowSeconds: 300 }),
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

    // Built as of P4e, so a well-formed unknown token is now `invalid_grant`
    // rather than the 501 this asserted while the grant did not exist. The
    // assertion is kept rather than deleted: it is the one place that checks the
    // grant is *dispatched* at all, and a typo in the query-parameter comparison
    // would otherwise show up only as every client silently getting the
    // validation error above.
    const refresh = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey }, payload: { refresh_token: 'cb_rt_' + 'a'.repeat(43) } });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().error.code).toBe('invalid_grant');
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
          refreshIpLimiter: createMemoryRateLimiter({ limit: 60, windowSeconds: 300 }),
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

/**
 * P4e — refresh rotation, reuse detection, logout and sessions.
 *
 * The rotation protocol (D-112) is the densest piece of logic in the auth module
 * and every branch of it is a security decision, so each branch gets its own
 * test. The two that matter most are the pair that pull in opposite directions:
 * a replay inside the grace window must **not** be treated as theft, and a replay
 * outside it must be — and a mistake in either direction is invisible until it is
 * either logging users out constantly or letting a stolen token live forever.
 */
describe('P4e — refresh rotation', () => {
  /** A logged-in user, with their first refresh token. */
  async function session(p: Fixture, email = 'rot@example.com') {
    await autoconfirm(p.id);
    const app = api();
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email, password: 'correct horse battery' } });
    expect(res.statusCode).toBe(200);
    return { app, email, refresh: res.json().refresh_token as string,
             access: res.json().access_token as string };
  }

  const refresh = (app: ReturnType<typeof api>, p: Fixture, token: string) =>
    app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey }, payload: { refresh_token: token } });

  t('EXIT CRITERION: a refresh returns a new pair and keeps the session id', async () => {
    const p = await provision();
    const { app, refresh: r0, access: a0 } = await session(p);
    const res = await refresh(app, p, r0);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.refresh_token).not.toBe(r0);
    expect(body.refresh_token.startsWith('cb_rt_')).toBe(true);
    expect(body.access_token).not.toBe(a0);
    expect(body.expires_in).toBe(3600);

    // Same session across the rotation, which is what makes a session revocable
    // at all: it is the only thing tying a stateless JWT to a revocable row.
    const claim = (tok: string) => JSON.parse(
      Buffer.from(tok.split('.')[1]!, 'base64url').toString()).session_id;
    expect(claim(body.access_token)).toBe(claim(a0));

    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ n: number; used: number; sessions: number }>(
        `select (select count(*)::int from auth.refresh_tokens) as n,
                (select count(*)::int from auth.refresh_tokens where used_at is not null) as used,
                (select count(*)::int from auth.sessions) as sessions`);
      // A lineage of two, one spent, one session — not a second login.
      expect(rows[0]!).toMatchObject({ n: 2, used: 1, sessions: 1 });
      const { rows: lineage } = await db.query<{ parent_id: number | null }>(
        `select parent_id from auth.refresh_tokens order by id`);
      expect(lineage[0]!.parent_id).toBeNull();
      expect(lineage[1]!.parent_id).not.toBeNull();
    } finally { await db.end(); }
    await app.close();
  });

  t('EXIT CRITERION: replaying a spent token beyond the grace window kills the family',
    async () => {
      const p = await provision();
      const { app, refresh: r0 } = await session(p);
      const first = await refresh(app, p, r0);
      const r1 = first.json().refresh_token as string;

      // Backdate the spend so the replay lands outside the 10s window without
      // the test sleeping for eleven seconds.
      const db = await asAuthRole(p);
      try {
        await db.query(
          `update auth.refresh_tokens set used_at = now() - interval '60 seconds'
            where used_at is not null`);
      } finally { await db.end(); }

      const replay = await refresh(app, p, r0);
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('invalid_grant');

      // The whole family, not just the replayed token. Which party tripped it is
      // unknowable — the attacker used the stolen token first and the client's
      // next refresh lands here, or the reverse — and it does not matter.
      const db2 = await asAuthRole(p);
      try {
        const { rows } = await db2.query<{ live: number; revoked: number; sessions: number }>(
          `select (select count(*)::int from auth.refresh_tokens where revoked = false) as live,
                  (select count(*)::int from auth.refresh_tokens where revoked) as revoked,
                  (select count(*)::int from auth.sessions where revoked_at is null) as sessions`);
        expect(rows[0]!.live).toBe(0);
        expect(rows[0]!.revoked).toBe(2);
        expect(rows[0]!.sessions).toBe(0);
        const { rows: audit } = await db2.query<{ action: string }>(
          `select action from auth.audit_log_entries where action = 'token_reuse_detected'`);
        expect(audit).toHaveLength(1);
      } finally { await db2.end(); }

      // And the child the legitimate client is holding is dead too — that is the
      // cost of the policy and the reason the grace window exists.
      expect((await refresh(app, p, r1)).statusCode).toBe(401);
      await app.close();
    });

  t('EXIT CRITERION: a replay inside the grace window is a retry, not a theft signal',
    async () => {
      const p = await provision();
      const { app, refresh: r0 } = await session(p);
      const first = await refresh(app, p, r0);
      expect(first.statusCode).toBe(200);

      // Immediately, so it is inside the 10s window. This is the mobile client
      // whose first response was lost, and the two-tab SPA race. Zero tolerance
      // turns both into forced logouts at a rate that teaches developers to
      // disable rotation — which loses the whole protection.
      const retry = await refresh(app, p, r0);
      expect(retry.statusCode).toBe(200);
      const r1b = retry.json().refresh_token as string;
      expect(r1b).not.toBe(first.json().refresh_token);

      const db = await asAuthRole(p);
      try {
        const { rows } = await db.query<{ children: number; sessions: number }>(
          `select (select count(*)::int from auth.refresh_tokens
                    where parent_id is not null) as children,
                  (select count(*)::int from auth.sessions where revoked_at is null) as sessions`);
        // Two children under one parent, but only one of them live: no second
        // lineage was created and the session is intact.
        expect(rows[0]!.sessions).toBe(1);
        const { rows: live } = await db.query<{ n: number }>(
          `select count(*)::int as n from auth.refresh_tokens
            where revoked = false and used_at is null`);
        expect(live[0]!.n).toBe(1);
        const { rows: audit } = await db.query<{ action: string }>(
          `select action from auth.audit_log_entries
            where action in ('token_reuse_detected','token_refresh_replayed')`);
        expect(audit.map((r) => r.action)).toEqual(['token_refresh_replayed']);
      } finally { await db.end(); }

      // The replacement works and the one the lost response carried does not,
      // which is the documented deviation: the child's plaintext was never
      // stored, so it cannot be handed back a second time.
      expect((await refresh(app, p, r1b)).statusCode).toBe(200);
      expect((await refresh(app, p, first.json().refresh_token)).statusCode).toBe(401);
      await app.close();
    });

  t('two concurrent refreshes with one token both succeed, and make one lineage',
    async () => {
      const p = await provision();
      const { app, refresh: r0 } = await session(p);
      // The race the grace window is for. One of them spends the token; the
      // other finds it spent, sees the spend was milliseconds ago, and replays.
      const [a, b] = await Promise.all([refresh(app, p, r0), refresh(app, p, r0)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 200]);

      const db = await asAuthRole(p);
      try {
        const { rows } = await db.query<{ live: number; sessions: number }>(
          `select (select count(*)::int from auth.refresh_tokens
                    where revoked = false and used_at is null) as live,
                  (select count(*)::int from auth.sessions where revoked_at is null) as sessions`);
        // Exactly one usable token afterwards. Two would be two live lineages
        // from one token, which is the state reuse detection exists to prevent.
        expect(rows[0]!.live).toBe(1);
        expect(rows[0]!.sessions).toBe(1);
      } finally { await db.end(); }
      await app.close();
    });

  t('an idle-expired session is revoked rather than refreshed', async () => {
    const p = await provision();
    await pool.query(
      `insert into project_auth_config (project_id, autoconfirm, session_idle_seconds)
       values ($1, true, 3600)
       on conflict (project_id) do update set autoconfirm = true, session_idle_seconds = 3600`,
      [p.id]);
    const { app, refresh: r0 } = await session(p, 'idle@example.com');

    const db = await asAuthRole(p);
    try {
      // Never refreshed, so idle is measured from creation — a NULL treated as
      // "never idle" would make an unrefreshed session immortal.
      await db.query(
        `update auth.sessions set created_at = now() - interval '2 hours',
                                  last_refreshed_at = null`);
    } finally { await db.end(); }

    const res = await refresh(app, p, r0);
    expect(res.statusCode).toBe(401);
    const db2 = await asAuthRole(p);
    try {
      const { rows } = await db2.query<{ n: number }>(
        `select count(*)::int as n from auth.sessions where revoked_at is not null`);
      expect(rows[0]!.n).toBe(1);
    } finally { await db2.end(); }
    await app.close();
  });

  t('a banned user cannot refresh, and the session dies', async () => {
    const p = await provision();
    const { app, refresh: r0 } = await session(p, 'banned@example.com');
    const db = await asAuthRole(p);
    try {
      await db.query(`update auth.users set banned_until = now() + interval '1 day'`);
    } finally { await db.end(); }

    // Refresh is where a ban is enforced in V1 (D-113): there is no per-request
    // session check, so a banned user survives at most one access-token
    // lifetime and then cannot renew.
    const res = await refresh(app, p, r0);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_grant');
    const db2 = await asAuthRole(p);
    try {
      const { rows } = await db2.query<{ action: string }>(
        `select action from auth.audit_log_entries
          where action = 'refresh_failed_banned'`);
      expect(rows).toHaveLength(1);
    } finally { await db2.end(); }
    await app.close();
  });

  t('every refresh failure looks the same from outside', async () => {
    const p = await provision();
    const { app, refresh: r0 } = await session(p, 'uniform@example.com');
    await refresh(app, p, r0);          // spend it

    const answers = [];
    for (const token of [
      'cb_rt_' + 'a'.repeat(43),          // well-formed and unknown
      r0,                                  // spent (grace, but child is live → ok)
      'cb_rt_short',                       // wrong shape
      'not-a-token-at-all',
    ]) {
      const res = await refresh(app, p, token);
      answers.push({ code: res.statusCode, body: res.json().error?.code });
    }
    // Unknown, malformed and short are one answer. Distinguishing them tells an
    // attacker holding a stolen token which of those it is.
    expect(answers[0]).toEqual({ code: 401, body: 'invalid_grant' });
    expect(answers[2]).toEqual({ code: 401, body: 'invalid_grant' });
    expect(answers[3]).toEqual({ code: 401, body: 'invalid_grant' });
    await app.close();
  });
});

describe('P4e — logout and sessions', () => {
  async function twoSessions(p: Fixture) {
    await autoconfirm(p.id);
    const app = api();
    const creds = { email: 'multi@example.com', password: 'correct horse battery' };
    const first = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: creds });
    const second = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey, 'user-agent': 'Second Device/1.0' },
      payload: creds });
    expect(second.statusCode).toBe(200);
    return { app, a: first.json(), b: second.json() };
  }

  t('EXIT CRITERION: logout kills refresh immediately, and says so honestly', async () => {
    const p = await provision();
    const { app, a } = await twoSessions(p);
    const out = await app.inject({
      method: 'POST', url: '/auth/v1/logout',
      headers: { apikey: p.anonKey, authorization: `Bearer ${a.access_token}` } });
    expect(out.statusCode).toBe(204);
    expect(out.body).toBe('');

    // Refresh is dead from this instant.
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey }, payload: { refresh_token: a.refresh_token } });
    expect(res.statusCode).toBe(401);

    // And the access token it just discarded is refused *on the auth
    // endpoints*, because those do check the session — which is the whole
    // reason `/logout` means anything. On the data API it stays valid until
    // `exp` (D-113), and that is a documented, deliberate limit.
    const after = await app.inject({
      method: 'GET', url: '/auth/v1/sessions',
      headers: { apikey: p.anonKey, authorization: `Bearer ${a.access_token}` } });
    expect(after.statusCode).toBe(401);
    await app.close();
  });

  t('logout is idempotent', async () => {
    const p = await provision();
    const { app, a } = await twoSessions(p);
    const headers = { apikey: p.anonKey, authorization: `Bearer ${a.access_token}` };
    expect((await app.inject({ method: 'POST', url: '/auth/v1/logout', headers })).statusCode)
      .toBe(204);
    // Still 204: logout is the one operation a client must be able to complete
    // unconditionally, and there is nothing to protect — revoking an already
    // revoked session changes nothing.
    expect((await app.inject({ method: 'POST', url: '/auth/v1/logout', headers })).statusCode)
      .toBe(204);
    await app.close();
  });

  t('scope=local leaves the other device signed in; global does not', async () => {
    const p = await provision();
    const { app, a, b } = await twoSessions(p);
    await app.inject({
      method: 'POST', url: '/auth/v1/logout',
      headers: { apikey: p.anonKey, authorization: `Bearer ${a.access_token}` } });

    const bRefresh = () => app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey }, payload: { refresh_token: b.refresh_token } });
    const stillIn = await bRefresh();
    expect(stillIn.statusCode).toBe(200);

    // Asserted, and it was not: the first version of this test ignored the
    // status here, so a 500 from `?scope=global` (an unused `$2` in the UPDATE —
    // a bind error) passed as a working global logout. An unchecked status on a
    // mutation is a mutation that never has to happen.
    const global = await app.inject({
      method: 'POST', url: '/auth/v1/logout?scope=global',
      headers: { apikey: p.anonKey,
                 authorization: `Bearer ${stillIn.json().access_token}` } });
    expect(global.statusCode).toBe(204);
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: stillIn.json().refresh_token } })).statusCode).toBe(401);
    await app.close();
  });

  t('scope=others signs out every device except this one', async () => {
    const p = await provision();
    const { app, a, b } = await twoSessions(p);
    const out = await app.inject({
      method: 'POST', url: '/auth/v1/logout?scope=others',
      headers: { apikey: p.anonKey, authorization: `Bearer ${b.access_token}` } });
    expect(out.statusCode).toBe(204);

    // The other device is gone…
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: a.refresh_token } })).statusCode).toBe(401);
    // …and this one is not, which is the entire point of the scope.
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: b.refresh_token } })).statusCode).toBe(200);
    await app.close();
  });

  t('the sessions list flags the current one and shows what a user would recognise',
    async () => {
      const p = await provision();
      const { app, a, b } = await twoSessions(p);
      const res = await app.inject({
        method: 'GET', url: '/auth/v1/sessions',
        headers: { apikey: p.anonKey, authorization: `Bearer ${b.access_token}` } });
      expect(res.statusCode).toBe(200);
      const list = res.json().sessions as Array<Record<string, unknown>>;
      expect(list).toHaveLength(2);
      // "Which of these is me" is otherwise unanswerable, and revoking the wrong
      // one is a self-inflicted logout.
      expect(list.filter((s) => s.current)).toHaveLength(1);
      const current = list.find((s) => s.current)!;
      expect(current.user_agent).toBe('Second Device/1.0');
      expect(typeof current.created_at).toBe('string');
      // No tokens and no hashes in a list a user is shown.
      expect(JSON.stringify(list)).not.toContain('cb_rt_');
      expect(Object.keys(current).sort()).toEqual([
        'created_at', 'current', 'id', 'ip', 'last_refreshed_at', 'user_agent',
      ]);
      void a;
      await app.close();
    });

  t('a user can revoke one session by id, and cannot touch anyone else\'s', async () => {
    const p = await provision();
    const { app, a, b } = await twoSessions(p);
    const list = (await app.inject({
      method: 'GET', url: '/auth/v1/sessions',
      headers: { apikey: p.anonKey, authorization: `Bearer ${b.access_token}` } }))
      .json().sessions as Array<{ id: string; current: boolean }>;
    const other = list.find((s) => !s.current)!;

    const del = await app.inject({
      method: 'DELETE', url: `/auth/v1/sessions/${other.id}`,
      headers: { apikey: p.anonKey, authorization: `Bearer ${b.access_token}` } });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: a.refresh_token } })).statusCode).toBe(401);

    // Somebody else's session id: 404 rather than 403, because the two are
    // distinguishable only to someone probing for which ids exist.
    const stranger = await app.inject({
      method: 'DELETE', url: '/auth/v1/sessions/00000000-0000-4000-8000-000000000000',
      headers: { apikey: p.anonKey, authorization: `Bearer ${b.access_token}` } });
    expect(stranger.statusCode).toBe(404);
    await app.close();
  });

  t('the bearer endpoints refuse an anon key, a user token from another project, and no token',
    async () => {
      const a = await provision();
      const bProj = await provision();
      const { app, a: sess } = await twoSessions(a);

      for (const headers of [
        { apikey: a.anonKey },                                       // no bearer
        { apikey: a.anonKey, authorization: `Bearer ${a.anonKey}` },  // an API key as a user
        { apikey: a.anonKey, authorization: 'Bearer garbage' },
      ]) {
        expect((await app.inject({ method: 'GET', url: '/auth/v1/sessions', headers }))
          .statusCode).toBe(401);
      }

      // A real access token for project A, presented to project B. Same claim
      // shape, different signing key — and the issuer names A.
      expect((await app.inject({
        method: 'GET', url: '/auth/v1/sessions',
        headers: { apikey: bProj.anonKey, authorization: `Bearer ${sess.access_token}` } }))
        .statusCode).toBe(401);
      await app.close();
    });
});

/**
 * P4f — `/user`: what a logged-in person can change about themselves.
 *
 * The load-bearing tests here are the two refusals. A stolen access token must
 * not be convertible into permanent account ownership, which is what
 * `current_password` is for; and an email change must not complete on one
 * address's word, which is what Flow 9's double confirmation is for. Both are
 * failures that leave no trace when they are wrong.
 */
describe('P4f — /user', () => {
  const password = 'correct horse battery';

  async function loggedIn(p: Fixture, email = 'me@example.com') {
    await autoconfirm(p.id);
    const app = api();
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email, password } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { access_token: string; refresh_token: string };
    return { app, email, access_token: body.access_token,
             refresh_token: body.refresh_token };
  }

  const auth = (p: Fixture, token: string) =>
    ({ apikey: p.anonKey, authorization: `Bearer ${token}` });

  t('GET /user reads the database, not the token\'s claims', async () => {
    const p = await provision();
    const { app, access_token } = await loggedIn(p);
    const db = await asAuthRole(p);
    try {
      await db.query(`update auth.users set raw_user_meta_data = '{"locale":"fr"}'::jsonb`);
    } finally { await db.end(); }

    const res = await app.inject({
      method: 'GET', url: '/auth/v1/user', headers: auth(p, access_token) });
    expect(res.statusCode).toBe(200);
    // The token was minted before that update. This endpoint exists precisely so
    // a client can find out what changed, so reconstructing from claims would
    // make it useless.
    expect(res.json().user_metadata).toEqual({ locale: 'fr' });
    expect(res.json().email).toBe('me@example.com');
    // Never the hash, on any path.
    expect(JSON.stringify(res.json())).not.toContain('scrypt$');
    await app.close();
  });

  t('EXIT CRITERION: changing a password needs the current one', async () => {
    const p = await provision();
    const { app, access_token } = await loggedIn(p);

    const noCurrent = await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token),
      payload: { password: 'a whole new password' } });
    expect(noCurrent.statusCode).toBe(400);
    expect(noCurrent.json().error.code).toBe('validation_failed');

    const wrongCurrent = await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token),
      payload: { password: 'a whole new password', current_password: 'not it' } });
    expect(wrongCurrent.statusCode).toBe(400);
    expect(wrongCurrent.json().error.code).toBe('invalid_credentials');

    // The point of the rule: a token lifted from localStorage buys an hour. A
    // token that can set the password buys the account forever.
    const login = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'me@example.com', password } });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  t('a correct current password changes it, and kills every other session', async () => {
    const p = await provision();
    const { app, access_token, email } = await loggedIn(p);
    // A second device, which must not survive.
    const other = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email, password } });
    expect(other.statusCode).toBe(200);

    const res = await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token),
      payload: { password: 'a whole new password', current_password: password } });
    expect(res.statusCode).toBe(200);

    // The old password is gone and the new one works.
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email, password } })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email, password: 'a whole new password' } })).statusCode).toBe(200);

    // Every other session is presumed hostile — a password change usually means
    // suspicion — but the one that made the change survives, or the user is
    // logged out by their own security action.
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: other.json().refresh_token } })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET', url: '/auth/v1/sessions', headers: auth(p, access_token) })).statusCode)
      .toBe(200);

    // And the tripwire mail went out on the ordinary-change path too, not just
    // on a reset: it is what tells the real owner somebody else did this.
    expect(app.mailer.jobs.map((j) => j.email)).toContain('password_changed_notice');
    await app.close();
  });

  t('EXIT CRITERION: a recovery link completes a password reset without the old password',
    async () => {
      const p = await provision();
      await setSite(p.id, 'https://app.example.com');
      const { app, email } = await loggedIn(p, 'forgot@example.com');
      app.mailer.jobs.length = 0;

      await app.inject({
        method: 'POST', url: '/auth/v1/recover', headers: { apikey: p.anonKey },
        payload: { email } });
      const verified = await app.inject({
        method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
        payload: { token: tokenFromJob(app.mailer.jobs[0]!), type: 'recovery' } });
      expect(verified.statusCode).toBe(200);

      // The whole point of P4f: before it, this flow logged you in and could not
      // change your credential.
      const reset = await app.inject({
        method: 'PUT', url: '/auth/v1/user',
        headers: auth(p, verified.json().access_token),
        payload: { password: 'chosen after the reset' } });
      expect(reset.statusCode).toBe(200);
      expect((await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: p.anonKey },
        payload: { email, password: 'chosen after the reset' } })).statusCode).toBe(200);

      const db = await asAuthRole(p);
      try {
        const { rows } = await db.query<{ action: string }>(
          `select action from auth.audit_log_entries where action = 'password_reset'`);
        expect(rows).toHaveLength(1);
      } finally { await db.end(); }
      await app.close();
    });

  t('the recovery capability does not survive a refresh', async () => {
    const p = await provision();
    await setSite(p.id, 'https://app.example.com');
    const { app, email } = await loggedIn(p, 'expiry@example.com');
    app.mailer.jobs.length = 0;
    await app.inject({
      method: 'POST', url: '/auth/v1/recover', headers: { apikey: p.anonKey },
      payload: { email } });
    const verified = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: tokenFromJob(app.mailer.jobs[0]!), type: 'recovery' } });

    // Deliberately narrower than the session: the capability to set a password
    // with no proof of the old one lives on the token the link minted, not on the
    // session's thirty days. A recovery link is spent in seconds.
    const refreshed = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: verified.json().refresh_token } });
    expect(refreshed.statusCode).toBe(200);

    const res = await app.inject({
      method: 'PUT', url: '/auth/v1/user',
      headers: auth(p, refreshed.json().access_token),
      payload: { password: 'should not work' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_failed');
    await app.close();
  });

  t('a new password below the project floor is refused, specifically', async () => {
    const p = await provision();
    const { app, access_token } = await loggedIn(p);
    const res = await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token),
      payload: { password: 'short', current_password: password } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('weak_password');
    await app.close();
  });

  t('metadata merges rather than replaces, and cannot reach app_metadata', async () => {
    const p = await provision();
    const { app, access_token } = await loggedIn(p);
    await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token),
      payload: { data: { locale: 'fr', avatar: 'a.png' } } });
    const res = await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token),
      payload: { data: { locale: 'de' } } });
    // A client that sends one field must not wipe the others — the loss would be
    // silent and every client would do it eventually.
    expect(res.json().user_metadata).toEqual({ locale: 'de', avatar: 'a.png' });

    // `raw_app_meta_data` is the service_role-writable half, and the entire
    // reason the two columns exist separately is that this endpoint is
    // user-writable. A user who could write it could grant themselves whatever a
    // policy reads from it.
    const db = await asAuthRole(p);
    try {
      await db.query(`update auth.users set raw_app_meta_data = '{"plan":"free"}'::jsonb`);
    } finally { await db.end(); }
    await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token),
      payload: { data: { plan: 'enterprise' } } });
    const db2 = await asAuthRole(p);
    try {
      const { rows } = await db2.query<{ app: Record<string, unknown> }>(
        `select raw_app_meta_data as app from auth.users`);
      expect(rows[0]!.app).toEqual({ plan: 'free' });
    } finally { await db2.end(); }
    await app.close();
  });

  t('an unknown field is refused rather than silently ignored', async () => {
    const p = await provision();
    const { app, access_token } = await loggedIn(p);
    // `.strict()`: a client sending `{email_confirm: true}` or `{role: 'admin'}`
    // should be told it did nothing, not left believing it worked.
    const res = await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token),
      payload: { role: 'service_role' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  t('an empty body is refused rather than answering 200 for nothing', async () => {
    const p = await provision();
    const { app, access_token } = await loggedIn(p);
    const res = await app.inject({
      method: 'PUT', url: '/auth/v1/user', headers: auth(p, access_token), payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Nothing to change/);
    await app.close();
  });
});

describe('P4f — email change', () => {
  const password = 'correct horse battery';

  async function proposing(p: Fixture, from = 'old@example.com', to = 'new@example.com') {
    await autoconfirm(p.id);
    await setSite(p.id, 'https://app.example.com');
    const app = api();
    const signup = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: from, password } });
    app.mailer.jobs.length = 0;
    const res = await app.inject({
      method: 'PUT', url: '/auth/v1/user',
      headers: { apikey: p.anonKey, authorization: `Bearer ${signup.json().access_token}` },
      payload: { email: to } });
    return { app, res, from, to, session: signup.json() as Record<string, string> };
  }

  t('EXIT CRITERION: both addresses must confirm before the change applies', async () => {
    const p = await provision();
    const { app, res, from, to } = await proposing(p);
    // 202: proposed, not applied. Applying it on request would be the bug the
    // double confirmation exists to prevent.
    expect(res.statusCode).toBe(202);
    expect(res.json().email).toBe(from);
    expect(res.json().new_email).toBe(to);

    const jobs = app.mailer.jobs;
    expect(jobs.map((j) => j.email).sort())
      .toEqual(['email_change_current', 'email_change_new']);
    const toOld = jobs.find((j) => j.to === from)!;
    const toNew = jobs.find((j) => j.to === to)!;

    // One side confirms: still not applied.
    const first = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: tokenFromJob(toNew), type: 'email_change' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().email_change).toBe('pending');

    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ email: string }>(`select email from auth.users`);
      expect(rows[0]!.email).toBe(from);
    } finally { await db.end(); }

    // The other side confirms: now it applies.
    const second = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: tokenFromJob(toOld), type: 'email_change' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().email_change).toBe('complete');

    const db2 = await asAuthRole(p);
    try {
      const { rows } = await db2.query<{ email: string; confirmed: Date | null }>(
        `select email, email_confirmed_at as confirmed from auth.users`);
      expect(rows[0]!.email).toBe(to);
      // The new address just proved itself; keeping the old timestamp would
      // assert that an address we have never mailed is confirmed.
      expect(rows[0]!.confirmed).toBeTruthy();
      const { rows: left } = await db2.query<{ n: number }>(
        `select count(*)::int as n from auth.one_time_tokens`);
      expect(left[0]!.n).toBe(0);
    } finally { await db2.end(); }

    // Login works on the new address and not the old one.
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email: to, password } })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email: from, password } })).statusCode)
      .toBe(400);
    await app.close();
  });

  t('the old address alone cannot complete the change', async () => {
    const p = await provision();
    const { app, from, to } = await proposing(p, 'solo@example.com', 'target@example.com');
    const toOld = app.mailer.jobs.find((j) => j.to === from)!;
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: tokenFromJob(toOld), type: 'email_change' } });
    // Confirming only the old address would let a user lock themselves onto a
    // typo'd, unreachable new address — unrecoverable without support.
    expect(res.json().email_change).toBe('pending');
    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ email: string }>(`select email from auth.users`);
      expect(rows[0]!.email).toBe(from);
    } finally { await db.end(); }
    void to;
    await app.close();
  });

  t('a session revoked at the change cannot be refreshed afterwards', async () => {
    const p = await provision();
    const { app, from, to, session } = await proposing(p, 'sess@example.com', 'moved@example.com');
    for (const addr of [from, to]) {
      const job = app.mailer.jobs.find((j) => j.to === addr)!;
      await app.inject({
        method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
        payload: { token: tokenFromJob(job), type: 'email_change' } });
    }
    // Every session dies, including the one that requested it: if the change was
    // made from a hijacked session, the owner's own sessions going with it is the
    // correct outcome, and there is no way to tell the two cases apart.
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: session['refresh_token'] } })).statusCode).toBe(401);
    await app.close();
  });

  t('new_only skips the old address entirely', async () => {
    const p = await provision();
    await pool.query(
      `insert into project_auth_config (project_id, autoconfirm, site_url, email_change_confirm)
       values ($1, true, 'https://app.example.com', 'new_only')
       on conflict (project_id) do update
          set autoconfirm = true, site_url = 'https://app.example.com',
              email_change_confirm = 'new_only'`, [p.id]);
    const app = api();
    const signup = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'relaxed@example.com', password } });
    app.mailer.jobs.length = 0;
    await app.inject({
      method: 'PUT', url: '/auth/v1/user',
      headers: { apikey: p.anonKey, authorization: `Bearer ${signup.json().access_token}` },
      payload: { email: 'quick@example.com' } });

    // One mail, and no unspendable old-address token: issuing one and ignoring it
    // would make the sibling check permanently false and the change could never
    // complete.
    expect(app.mailer.jobs.map((j) => j.email)).toEqual(['email_change_new']);
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
      payload: { token: tokenFromJob(app.mailer.jobs[0]!), type: 'email_change' } });
    expect(res.json().email_change).toBe('complete');
    await app.close();
  });

  t('a taken address is not disclosed on request, and is caught on confirmation',
    async () => {
      const p = await provision();
      await autoconfirm(p.id);
      await setSite(p.id, 'https://app.example.com');
      const app = api();
      await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: 'taken@example.com', password } });
      const mine = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: 'mover@example.com', password } });
      app.mailer.jobs.length = 0;

      const req = await app.inject({
        method: 'PUT', url: '/auth/v1/user',
        headers: { apikey: p.anonKey, authorization: `Bearer ${mine.json().access_token}` },
        payload: { email: 'taken@example.com' } });
      // Not 409 here: answering "that address is taken" to a logged-in user turns
      // this endpoint into the enumeration oracle signup and /recover were
      // carefully built to avoid, with one account and no effort.
      expect(req.statusCode).toBe(202);

      for (const addr of ['mover@example.com', 'taken@example.com']) {
        const job = app.mailer.jobs.find((j) => j.to === addr);
        if (job) {
          const res = await app.inject({
            method: 'POST', url: '/auth/v1/verify', headers: { apikey: p.anonKey },
            payload: { token: tokenFromJob(job), type: 'email_change' } });
          // The last one lands on the conflict, which is where the unique index
          // decides it rather than a 500.
          if (res.statusCode === 409) {
            expect(res.json().error.message).toMatch(/already in use/);
          }
        }
      }
      const db = await asAuthRole(p);
      try {
        const { rows } = await db.query<{ n: number }>(
          `select count(*)::int as n from auth.users where lower(email) = 'taken@example.com'`);
        expect(rows[0]!.n).toBe(1);
      } finally { await db.end(); }
      await app.close();
    });

  t('changing to your own address is refused', async () => {
    const p = await provision();
    await autoconfirm(p.id);
    const app = api();
    const signup = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'same@example.com', password } });
    const res = await app.inject({
      method: 'PUT', url: '/auth/v1/user',
      headers: { apikey: p.anonKey, authorization: `Bearer ${signup.json().access_token}` },
      payload: { email: 'Same@Example.com' } });
    // Case-insensitively: otherwise this issues two mails and revokes every
    // session to change nothing.
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  t('the GET form redirects with the outcome and no tokens', async () => {
    const p = await provision();
    const { app, from } = await proposing(p, 'getform@example.com', 'getnew@example.com');
    const job = app.mailer.jobs.find((j) => j.to === from)!;
    const res = await app.inject({
      method: 'GET',
      url: `/auth/v1/verify?token=${tokenFromJob(job)}&type=email_change`
         + `&redirect_to=${encodeURIComponent('https://app.example.com')}`,
      headers: { apikey: p.anonKey } });
    expect(res.statusCode).toBe(302);
    const frag = new URLSearchParams((res.headers['location'] as string).split('#')[1]);
    expect(frag.get('email_change')).toBe('pending');
    // This path issues no session, so there is nothing to hand over — a mail
    // client on a device that was never logged in must not be given one.
    expect(frag.get('access_token')).toBeNull();
    expect(frag.get('refresh_token')).toBeNull();
    await app.close();
  });
});

/**
 * P4g — `/admin/users`, the last of the thirteen endpoints.
 *
 * This surface breaks the rule every other one follows, deliberately: it is
 * authorised by the **service_role** key, which is the customer's own
 * server-side credential, so a caller who holds it can already read every row in
 * the schema. Enumeration resistance would protect nothing and make the API
 * unusable, which is why `404 No such user` is right here and would be a leak
 * anywhere else in the module. The corollary is that the key check is the only
 * thing between an anon key and every account, so it is what gets tested hardest.
 */
describe('P4g — /admin/users', () => {
  const password = 'correct horse battery';

  async function withUsers(p: Fixture, n = 3) {
    await autoconfirm(p.id);
    const app = api();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: `u${i}@example.com`, password } });
      expect(res.statusCode).toBe(200);
      ids.push(res.json().user.id as string);
    }
    return { app, ids };
  }

  const svc = (p: Fixture) => ({ apikey: p.serviceKey });

  t('EXIT CRITERION: every admin route refuses the anon key with 403', async () => {
    const p = await provision();
    const { app, ids } = await withUsers(p, 1);
    // The published key. This check is the only thing standing between it and
    // every user's account, so all five routes are checked rather than one.
    for (const [method, url] of [
      ['GET', '/auth/v1/admin/users'],
      ['GET', `/auth/v1/admin/users/${ids[0]}`],
      ['POST', '/auth/v1/admin/users'],
      ['PUT', `/auth/v1/admin/users/${ids[0]}`],
      ['DELETE', `/auth/v1/admin/users/${ids[0]}`],
    ] as const) {
      const res = await app.inject({
        method, url, headers: { apikey: p.anonKey },
        payload: { email: 'x@example.com' } });
      // 403, not 401: the credential is valid, it is simply not this one. A 401
      // sends a developer to check whether their key expired.
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toMatch(/service_role/);
    }
    // And nothing was changed by any of them.
    const db = await asAuthRole(p);
    try {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from auth.users where deleted_at is null`);
      expect(rows[0]!.n).toBe(1);
    } finally { await db.end(); }
    await app.close();
  });

  t('lists users newest-first with a working cursor', async () => {
    const p = await provision();
    const { app } = await withUsers(p, 5);
    const first = await app.inject({
      method: 'GET', url: '/auth/v1/admin/users?limit=2', headers: svc(p) });
    expect(first.statusCode).toBe(200);
    const a = first.json();
    expect(a.users).toHaveLength(2);
    expect(a.pagination.has_more).toBe(true);

    const second = await app.inject({
      method: 'GET',
      url: `/auth/v1/admin/users?limit=2&cursor=${encodeURIComponent(a.pagination.next_cursor)}`,
      headers: svc(p) });
    const b = second.json();
    expect(b.users).toHaveLength(2);
    // Keyset, so no overlap and no gap — the failure a limit/offset page would
    // have when a row is inserted between the two requests.
    const seen = new Set([...a.users, ...b.users].map((u: { id: string }) => u.id));
    expect(seen.size).toBe(4);

    const rest = await app.inject({
      method: 'GET',
      url: `/auth/v1/admin/users?limit=50&cursor=${encodeURIComponent(b.pagination.next_cursor)}`,
      headers: svc(p) });
    expect(rest.json().users).toHaveLength(1);
    expect(rest.json().pagination.has_more).toBe(false);
    expect(rest.json().pagination.next_cursor).toBeNull();
    await app.close();
  });

  t('the admin view shows the ban and app_metadata, and never the hash', async () => {
    const p = await provision();
    const { app, ids } = await withUsers(p, 1);
    await app.inject({
      method: 'PUT', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p),
      payload: { app_metadata: { plan: 'pro' } } });

    const res = await app.inject({
      method: 'GET', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p) });
    expect(res.statusCode).toBe(200);
    // Two fields the user-facing object omits: a developer managing their own
    // users needs to see a ban and the metadata half they control.
    expect(res.json().app_metadata).toEqual({ plan: 'pro' });
    expect(res.json()).toHaveProperty('banned_until', null);
    // The allowlist still holds on this surface. service_role has no table grant
    // on auth.users (D-315), and this route reaching it through corebase_auth
    // must not become the way the hash escapes.
    expect(JSON.stringify(res.json())).not.toContain('scrypt$');
    expect(JSON.stringify(res.json())).not.toContain('encrypted_password');
    await app.close();
  });

  t('creates a user, confirmed and with app_metadata, and rejects a duplicate', async () => {
    const p = await provision();
    await autoconfirm(p.id);
    const app = api();
    const res = await app.inject({
      method: 'POST', url: '/auth/v1/admin/users', headers: svc(p),
      payload: {
        email: 'imported@example.com', password, email_confirm: true,
        user_metadata: { locale: 'fr' }, app_metadata: { plan: 'team' },
      } });
    expect(res.statusCode).toBe(201);
    expect(res.json().email_confirmed_at).toBeTruthy();
    expect(res.json().app_metadata).toEqual({ plan: 'team' });
    expect(res.json().user_metadata).toEqual({ locale: 'fr' });

    // Confirmed without an email round trip, so the account is usable at once —
    // the thing signup cannot do and a migration script needs.
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'imported@example.com', password } })).statusCode).toBe(200);

    // 422 on a duplicate, unlike signup's same-shape 200: the decoy protects an
    // anonymous caller's privacy, and here the caller is the address's own
    // custodian, so hiding the collision would make imports fail silently.
    const dupe = await app.inject({
      method: 'POST', url: '/auth/v1/admin/users', headers: svc(p),
      payload: { email: 'imported@example.com', password } });
    expect(dupe.statusCode).toBe(422);
    expect(dupe.json().error.message).toMatch(/already exists/);
    await app.close();
  });

  t('a user created with no password cannot log in, and is not distinguishable',
    async () => {
      const p = await provision();
      await autoconfirm(p.id);
      const app = api();
      const res = await app.inject({
        method: 'POST', url: '/auth/v1/admin/users', headers: svc(p),
        payload: { email: 'nopass@example.com', email_confirm: true } });
      expect(res.statusCode).toBe(201);

      const db = await asAuthRole(p);
      try {
        const { rows } = await db.query<{ hash: string | null }>(
          `select encrypted_password as hash from auth.users where email = 'nopass@example.com'`);
        // NULL, not '': an empty string is a value that means "absent", which the
        // login path's own NULL check would miss.
        expect(rows[0]!.hash).toBeNull();
      } finally { await db.end(); }

      const login = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: p.anonKey },
        payload: { email: 'nopass@example.com', password: 'anything at all' } });
      // The same generic answer as a wrong password — the decoy verify runs, so
      // "this account has no password" is not observable.
      expect(login.statusCode).toBe(400);
      expect(login.json().error.code).toBe('invalid_credentials');
      await app.close();
    });

  t('EXIT CRITERION: a ban stops refresh and revokes every session', async () => {
    const p = await provision();
    const { app, ids } = await withUsers(p, 1);
    const login = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email: 'u0@example.com', password } });
    expect(login.statusCode).toBe(200);

    const ban = await app.inject({
      method: 'PUT', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p),
      payload: { ban_until: new Date(Date.now() + 86_400_000).toISOString() } });
    expect(ban.statusCode).toBe(200);
    expect(ban.json().banned_until).toBeTruthy();

    // A ban that leaves sessions refreshing is not a ban. Login is refused and
    // refresh is dead — the residual window is one already-issued access token,
    // which is the tightest a stateless token allows (D-113).
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'u0@example.com', password } })).statusCode).toBe(400);
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: login.json().refresh_token } })).statusCode).toBe(401);

    // …and lifting it works, which is the half a ban-only test would miss.
    const unban = await app.inject({
      method: 'PUT', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p),
      payload: { ban_until: null } });
    expect(unban.json().banned_until).toBeNull();
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'u0@example.com', password } })).statusCode).toBe(200);
    await app.close();
  });

  t('sign_out revokes sessions without changing the account', async () => {
    const p = await provision();
    const { app, ids } = await withUsers(p, 1);
    const login = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email: 'u0@example.com', password } });

    const res = await app.inject({
      method: 'PUT', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p),
      payload: { sign_out: true } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: login.json().refresh_token } })).statusCode).toBe(401);
    // Not banned, so signing back in works — the difference between "get off my
    // service" and "log out of that stolen laptop".
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'u0@example.com', password } })).statusCode).toBe(200);
    await app.close();
  });

  t('an admin password reset ends every session', async () => {
    const p = await provision();
    const { app, ids } = await withUsers(p, 1);
    const login = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email: 'u0@example.com', password } });

    await app.inject({
      method: 'PUT', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p),
      payload: { password: 'set by the developer' } });
    // A password set by an admin carries the same suspicion as one set by the
    // user (flows §8), so the same rule applies.
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
      headers: { apikey: p.anonKey },
      payload: { refresh_token: login.json().refresh_token } })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey },
      payload: { email: 'u0@example.com', password: 'set by the developer' } })).statusCode)
      .toBe(200);
    await app.close();
  });

  t('app_metadata merges and is reachable only from here', async () => {
    const p = await provision();
    const { app, ids } = await withUsers(p, 1);
    await app.inject({
      method: 'PUT', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p),
      payload: { app_metadata: { plan: 'pro', seats: 3 } } });
    const res = await app.inject({
      method: 'PUT', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p),
      payload: { app_metadata: { plan: 'team' } } });
    expect(res.json().app_metadata).toEqual({ plan: 'team', seats: 3 });

    // The user's own PUT /user cannot touch it — which is the whole reason the
    // two metadata columns exist separately, since a policy may read this one.
    const login = await app.inject({
      method: 'POST', url: '/auth/v1/token?grant_type=password',
      headers: { apikey: p.anonKey }, payload: { email: 'u0@example.com', password } });
    await app.inject({
      method: 'PUT', url: '/auth/v1/user',
      headers: { apikey: p.anonKey, authorization: `Bearer ${login.json().access_token}` },
      payload: { data: { plan: 'enterprise' } } });
    const after = await app.inject({
      method: 'GET', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p) });
    expect(after.json().app_metadata).toEqual({ plan: 'team', seats: 3 });
    await app.close();
  });

  t('EXIT CRITERION: deletion tombstones the row, frees the address, and kills the session',
    async () => {
      const p = await provision();
      const { app, ids } = await withUsers(p, 1);
      const login = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: p.anonKey }, payload: { email: 'u0@example.com', password } });

      const res = await app.inject({
        method: 'DELETE', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});

      const db = await asAuthRole(p);
      try {
        const { rows } = await db.query<{
          email: string; hash: string | null; um: unknown; am: unknown;
          confirmed: Date | null; deleted: Date | null;
        }>(`select email, encrypted_password as hash, raw_user_meta_data as um,
                   raw_app_meta_data as am, email_confirmed_at as confirmed, deleted_at as deleted
              from auth.users where id = $1`, [ids[0]]);
        const row = rows[0]!;
        // The id survives — the developer's own tables reference it and Corebase
        // does not cascade into app schemas (Flow 10 step 3). Everything else is
        // gone: "deleted" that leaves a password hash and a full profile behind
        // is not deletion in any sense a user would recognise.
        expect(row.deleted).toBeTruthy();
        expect(row.email).toBe(`deleted+${ids[0]}@invalid`);
        expect(row.hash).toBeNull();
        expect(row.um).toEqual({});
        expect(row.am).toEqual({});
        expect(row.confirmed).toBeNull();

        // No live sessions, no live tokens, no outstanding links. A deleted user
        // whose recovery token still works is one who can be signed back in from
        // an inbox.
        const { rows: left } = await db.query<{ s: number; r: number; o: number }>(
          `select (select count(*)::int from auth.sessions
                    where user_id = $1 and revoked_at is null) as s,
                  (select count(*)::int from auth.refresh_tokens
                    where user_id = $1 and revoked = false) as r,
                  (select count(*)::int from auth.one_time_tokens where user_id = $1) as o`,
          [ids[0]]);
        expect(left[0]!).toEqual({ s: 0, r: 0, o: 0 });

        // The audit row keeps the address the tombstone destroyed, because the
        // user row can no longer answer "which account was this".
        const { rows: audit } = await db.query<{ payload: { email: string } }>(
          `select payload from auth.audit_log_entries where action = 'user_deleted'`);
        expect(audit[0]!.payload.email).toBe('u0@example.com');
      } finally { await db.end(); }

      expect((await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
        headers: { apikey: p.anonKey },
        payload: { refresh_token: login.json().refresh_token } })).statusCode).toBe(401);

      // The partial unique index frees the address, so the person can sign up
      // again — and gets a *new* id, which is what a developer's foreign keys
      // require.
      const again = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: 'u0@example.com', password } });
      expect(again.statusCode).toBe(200);
      expect(again.json().user.id).not.toBe(ids[0]);

      // And the tombstone is gone from the admin list.
      const list = await app.inject({
        method: 'GET', url: '/auth/v1/admin/users', headers: svc(p) });
      expect((list.json().users as Array<{ id: string }>).map((u) => u.id))
        .not.toContain(ids[0]);
      await app.close();
    });

  t('deleting twice is a 404 the second time, and a bad id is a 400', async () => {
    const p = await provision();
    const { app, ids } = await withUsers(p, 1);
    expect((await app.inject({
      method: 'DELETE', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p) }))
      .statusCode).toBe(200);
    // 404 rather than a second silent success: an import script retrying must be
    // able to tell "already gone" from "done".
    expect((await app.inject({
      method: 'DELETE', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p) }))
      .statusCode).toBe(404);
    // A malformed id is ours to reject: passed through, Postgres answers
    // `invalid input syntax for type uuid`, which renders as a 500 and sends a
    // developer looking for a server fault instead of at their own request.
    const bad = await app.inject({
      method: 'DELETE', url: '/auth/v1/admin/users/not-a-uuid', headers: svc(p) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/not a user id/);
    await app.close();
  });

  t('one project\'s service_role key cannot touch another\'s users', async () => {
    const a = await provision();
    const b = await provision();
    const { app, ids } = await withUsers(a, 1);
    // Signed by B's key and naming B, so it resolves B — and B has no such user.
    // The isolation is structural rather than checked: the key selects the
    // database, and the databases are physically separate (D-009).
    const res = await app.inject({
      method: 'GET', url: `/auth/v1/admin/users/${ids[0]}`,
      headers: { apikey: b.serviceKey } });
    expect(res.statusCode).toBe(404);

    const list = await app.inject({
      method: 'GET', url: '/auth/v1/admin/users', headers: { apikey: b.serviceKey } });
    expect(list.json().users).toHaveLength(0);
    await app.close();
  });

  t('an unknown field is refused rather than silently ignored', async () => {
    const p = await provision();
    const { app, ids } = await withUsers(p, 1);
    // `{role: 'service_role'}` or `{deleted_at: null}` must be told they did
    // nothing, not left believing they worked.
    for (const payload of [{ role: 'service_role' }, { deleted_at: null }, {}]) {
      const res = await app.inject({
        method: 'PUT', url: `/auth/v1/admin/users/${ids[0]}`, headers: svc(p), payload });
      expect(res.statusCode).toBe(400);
    }
    await app.close();
  });
});

/**
 * P4h — the signing-key rotation runbook, executed end to end.
 *
 * Phase 4's second exit criterion is "JWKS rotation runbook executed once in
 * staging, sessions survive per design". *Sessions survive* is the load-bearing
 * half and the reason the runbook has waits in it: cutting over to a key that
 * cached verifiers do not hold yet, or dropping the old key while a customer's
 * deployed frontend still carries an anon key signed by it, are both ways to turn
 * routine credential hygiene into an outage.
 *
 * So each step is asserted for what it must *not* break, not only for what it
 * changes.
 */
describe('P4h — signing-key rotation', () => {
  const password = 'correct horse battery';

  async function rotationDeps(p: Fixture) {
    const { beginRotation, cutOver, retire, publishedKeys, privateKeyName } =
      await import('./key-rotation.ts');
    const deps = { pool, secrets, log: () => {} };
    return { deps, beginRotation, cutOver, retire, publishedKeys, privateKeyName, p };
  }

  t('EXIT CRITERION: the runbook runs, and a session created before it survives',
    async () => {
      const p = await provision();
      await autoconfirm(p.id);
      const app = api();
      const { deps, beginRotation, cutOver } = await rotationDeps(p);

      // A signed-in user, and a project key, both minted under the *old* kid.
      const signup = await app.inject({
        method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
        payload: { email: 'survivor@example.com', password } });
      expect(signup.statusCode).toBe(200);
      const oldSession = signup.json() as { access_token: string; refresh_token: string };
      const oldKid = (await secrets.get(p.id, SECRET_NAMES.jwtKid))!;

      // ── step 1–2: publish, without signing anything ──────────────────────
      const begun = await beginRotation(deps, p.id);
      expect(begun.created).toBe(true);
      expect(begun.kid).not.toBe(oldKid);

      // JWKS now carries both, which is the entire mechanism: a verifier that
      // caches this document must already hold the new key before a token signed
      // with it can arrive.
      const jwks1 = await app.inject({
        method: 'GET', url: `/auth/v1/.well-known/jwks.json?ref=${p.ref}` });
      const kids1 = (jwks1.json().keys as Array<{ kid: string }>).map((k) => k.kid);
      expect(kids1).toEqual([oldKid, begun.kid]);

      // …and nothing has changed about signing yet. A token minted now must
      // still carry the old kid, or the wait between the steps bought nothing.
      const midLogin = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: p.anonKey },
        payload: { email: 'survivor@example.com', password } });
      expect(midLogin.statusCode).toBe(200);
      const kidOf = (tok: string) => JSON.parse(
        Buffer.from(tok.split('.')[0]!, 'base64url').toString()).kid;
      expect(kidOf(midLogin.json().access_token)).toBe(oldKid);

      // ── step 4: cut over ─────────────────────────────────────────────────
      // `force`, because the real wait is ten minutes and a test that took ten
      // minutes would be a test nobody runs. The wait itself is asserted
      // separately below, on the guard that enforces it.
      const cut = await cutOver(deps, p.id, { force: true });
      expect(cut.from).toBe(oldKid);
      expect(cut.to).toBe(begun.kid);

      // New tokens carry the new kid…
      const newLogin = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=password',
        headers: { apikey: p.anonKey },
        payload: { email: 'survivor@example.com', password } });
      expect(newLogin.statusCode).toBe(200);
      expect(kidOf(newLogin.json().access_token)).toBe(begun.kid);

      // …and JWKS still carries the old one, now retiring. Dropping it here
      // would kill every token issued in the last hour.
      const jwks2 = await app.inject({
        method: 'GET', url: `/auth/v1/.well-known/jwks.json?ref=${p.ref}` });
      const kids2 = (jwks2.json().keys as Array<{ kid: string }>).map((k) => k.kid);
      expect(kids2).toContain(oldKid);
      expect(kids2).toContain(begun.kid);

      // **The criterion.** The session from before the rotation still works: its
      // access token verifies against the retiring key, and its refresh token is
      // opaque so the rotation never touched it.
      const stillIn = await app.inject({
        method: 'GET', url: '/auth/v1/sessions',
        headers: { apikey: p.anonKey, authorization: `Bearer ${oldSession.access_token}` } });
      expect(stillIn.statusCode).toBe(200);
      const refreshed = await app.inject({
        method: 'POST', url: '/auth/v1/token?grant_type=refresh_token',
        headers: { apikey: p.anonKey },
        payload: { refresh_token: oldSession.refresh_token } });
      expect(refreshed.statusCode).toBe(200);
      // And the renewed token is signed by the new key — the session moved across
      // the rotation rather than being pinned to a dying one.
      expect(kidOf(refreshed.json().access_token)).toBe(begun.kid);

      // The *old anon key* also still works, which is the swap window's reason
      // for existing: it is deployed in a customer's frontend and only they can
      // ship a replacement.
      const oldKeyStillWorks = await app.inject({
        method: 'GET', url: '/auth/v1/user',
        headers: { apikey: p.anonKey, authorization: `Bearer ${refreshed.json().access_token}` } });
      expect(oldKeyStillWorks.statusCode).toBe(200);
      await app.close();
    }, 300_000);

  t('the cut-over refuses to run before the JWKS cache could have expired', async () => {
    const p = await provision();
    const { deps, beginRotation, cutOver } = await rotationDeps(p);
    await beginRotation(deps, p.id);
    // The wait is the runbook's most important instruction. Skipping it silently
    // would leave it as a comment, so it is a refusal with both numbers in it —
    // the operator's next question is "how much longer".
    await expect(cutOver(deps, p.id)).rejects.toThrow(/only been published for/);
    await expect(cutOver(deps, p.id)).rejects.toThrow(/force/);
    // And with an explicit force it proceeds, which is the emergency path for a
    // confirmed leak where every outstanding token dying at once is the intent.
    await expect(cutOver(deps, p.id, { force: true })).resolves.toMatchObject({});
  }, 300_000);

  t('the new API keys are minted under the new kid, and the old ones still verify',
    async () => {
      const p = await provision();
      const app = api();
      const { deps, beginRotation, cutOver } = await rotationDeps(p);
      const oldAnon = p.anonKey;
      const oldService = p.serviceKey;

      await beginRotation(deps, p.id);
      await cutOver(deps, p.id, { force: true });

      const newAnon = (await secrets.get(p.id, SECRET_NAMES.anonKey))!;
      const newService = (await secrets.get(p.id, SECRET_NAMES.serviceRoleKey))!;
      // Re-minted, because D-029's keys *are* JWTs under this keypair — a signing
      // rotation is an API-key rotation whether or not anyone planned for it.
      expect(newAnon).not.toBe(oldAnon);
      expect(newService).not.toBe(oldService);

      // Both generations work during the window. That is what makes it a window.
      for (const key of [oldAnon, newAnon]) {
        expect(await keyResolves(app, key)).toBe(true);
      }
      for (const key of [oldService, newService]) {
        const res = await app.inject({
          method: 'GET', url: '/auth/v1/admin/users', headers: { apikey: key } });
        expect(res.statusCode).toBe(200);
      }
      await app.close();
    }, 300_000);

  t('EXIT CRITERION: retiring the old key kills exactly what it signed', async () => {
    const p = await provision();
    await autoconfirm(p.id);
    const app = api();
    const { deps, beginRotation, cutOver, retire } = await rotationDeps(p);
    const oldAnon = p.anonKey;
    const oldKid = (await secrets.get(p.id, SECRET_NAMES.jwtKid))!;

    const signup = await app.inject({
      method: 'POST', url: '/auth/v1/signup', headers: { apikey: p.anonKey },
      payload: { email: 'doomed@example.com', password } });
    const oldAccess = signup.json().access_token as string;

    await beginRotation(deps, p.id);
    await cutOver(deps, p.id, { force: true });
    const newAnon = (await secrets.get(p.id, SECRET_NAMES.anonKey))!;

    // The window is open, so retiring is refused with the days remaining and the
    // consequence spelled out — this is the command that breaks a customer's
    // deployed frontend, not just their sessions.
    const tooEarly = await retire(deps, p.id, oldKid);
    expect(tooEarly.retired).toBe(false);
    expect(tooEarly.reason).toMatch(/swap window has \d+ day\(s\) left/);
    expect(tooEarly.reason).toMatch(/deployed frontend/);

    expect((await retire(deps, p.id, oldKid, { force: true })).retired).toBe(true);

    // Now the old key's tokens and API keys are dead — all of them, at once.
    expect(await keyResolves(app, oldAnon)).toBe(false);
    expect((await app.inject({
      method: 'GET', url: '/auth/v1/user',
      headers: { apikey: newAnon, authorization: `Bearer ${oldAccess}` } })).statusCode)
      .toBe(401);

    // And the new generation is untouched.
    expect(await keyResolves(app, newAnon)).toBe(true);
    const jwks = await app.inject({
      method: 'GET', url: `/auth/v1/.well-known/jwks.json?ref=${p.ref}` });
    expect((jwks.json().keys as Array<{ kid: string }>).map((k) => k.kid))
      .not.toContain(oldKid);
    await app.close();
  }, 300_000);

  t('both JWKS endpoints publish the same key set', async () => {
    const p = await provision();
    const { deps, beginRotation } = await rotationDeps(p);
    await beginRotation(deps, p.id);
    const app = api();

    // A verifier that fetched from one endpoint and met a token minted against
    // the other would reject a valid token, so the two documents agreeing is not
    // a nicety.
    const dataPlane = await app.inject({
      method: 'GET', url: `/auth/v1/.well-known/jwks.json?ref=${p.ref}` });
    const controlPlane = await controlPlaneJwks(p);
    expect((dataPlane.json().keys as Array<{ kid: string }>).map((k) => k.kid).sort())
      .toEqual(controlPlane.map((k) => k.kid).sort());
    expect(controlPlane).toHaveLength(2);
    await app.close();
  }, 300_000);

  t('beginRotation twice returns the key already waiting', async () => {
    const p = await provision();
    const { deps, beginRotation } = await rotationDeps(p);
    const first = await beginRotation(deps, p.id);
    const second = await beginRotation(deps, p.id);
    // A second keypair would orphan the first — published to verifiers now
    // caching a key nothing will ever sign with — and an operator who ran the
    // command twice because the output scrolled away should not have done that.
    expect(second.created).toBe(false);
    expect(second.kid).toBe(first.kid);
  }, 300_000);

  t('the retirement sweep only closes windows that have actually closed', async () => {
    const p = await provision();
    const { deps, beginRotation, cutOver } = await rotationDeps(p);
    const { dueForRetirement } = await import('./key-rotation.ts');
    await beginRotation(deps, p.id);
    await cutOver(deps, p.id, { force: true });

    // Nothing due: the window is 30 days old at most a second ago.
    expect((await dueForRetirement(deps)).filter((d) => d.projectId === p.id)).toHaveLength(0);

    await pool.query(
      `update project_signing_keys set retire_after = now() - interval '1 day'
        where project_id = $1 and status = 'retiring'`, [p.id]);
    const due = (await dueForRetirement(deps)).filter((d) => d.projectId === p.id);
    expect(due).toHaveLength(1);
  }, 300_000);
});

/**
 * Does this project key resolve?
 *
 * `POST /auth/v1/recover` for an address that does not exist: the project is
 * resolved on the handler's first line, and the flow is enumeration-safe, so a
 * key that verifies gets a same-shape 200 and one that does not gets 401.
 *
 * Two earlier versions of this probe were wrong in the same way, and both were
 * *green*:
 *
 *   - `/auth/v1/health` resolves no project at all — an operator asking whether
 *     auth is up is not asking whether one tenant's key is valid — so it ignores
 *     the `apikey` header and answers 200 to anything.
 *   - `POST /auth/v1/token` with no `grant_type` checks the grant *before*
 *     resolving the project, so it 400s without ever looking at the key.
 *
 * Both made "the old key still works during the window" pass without testing
 * anything. Only the retirement assertion — which needs the key to *stop*
 * working — could tell the difference, which is the useful property of writing
 * the negative case.
 */
async function keyResolves(
  app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number }> },
  apikey: string,
): Promise<boolean> {
  const res = await app.inject({
    method: 'POST', url: '/auth/v1/recover', headers: { apikey },
    payload: { email: 'nobody-probe@example.test' } });
  if (res.statusCode === 200) return true;
  if (res.statusCode === 401) return false;
  throw new Error(`unexpected ${res.statusCode} probing an apikey — neither 200 nor 401`);
}

/** The control plane's own JWKS for a project, which must agree with the data plane's. */
async function controlPlaneJwks(p: Fixture): Promise<Array<{ kid: string }>> {
  const app = buildApp({
    store: createPgStore({ pool, organizationId: orgId, secrets }),
    signingKeys: {
      published: async (projectId: string) => {
        const { rows } = await pool.query<{ kid: string; public_key_pem: string }>(
          `SELECT kid, public_key_pem FROM project_signing_keys
            WHERE project_id = $1 AND status IN ('next','retiring') ORDER BY published_at`,
          [projectId]);
        return rows.map((r) => ({ kid: r.kid, publicKeyPem: r.public_key_pem }));
      },
    },
    projectSecrets: { secrets },
    staticToken: 'unused-but-long-enough-for-the-boot-check',
  });
  try {
    const res = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/.well-known/jwks.json` });
    if (res.statusCode !== 200) {
      throw new Error(`control-plane JWKS returned ${res.statusCode}: ${res.body}`);
    }
    return res.json().keys as Array<{ kid: string }>;
  } finally { await app.close(); }
}
