import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createPublicKey, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnvelope } from '@steadhold/crypto';
import { createSecretStore, SECRET_NAMES } from '@steadhold/secrets';
import { generateKeypair, sign, verify, projectKeyClaims } from '@steadhold/jwt';
import { buildApp } from './app.ts';
import { createUserStore } from './modules/auth/store.ts';
import { createOrgStore } from './modules/orgs/store.ts';
import { createTokenStore } from './kernel/tokens.ts';
import { createMemorySessionStore, SESSION_COOKIE, CSRF_HEADER } from './kernel/sessions.ts';
import { createMemoryRateLimiter } from './kernel/rate-limit.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';

/**
 * P1e: the two project keys and the JWKS that verifies them.
 *
 * The pair of tests that matter: `anon` is returned to anyone who can read the
 * project (it is publishable by design), and `service_role` needs `key.manage`
 * plus an audit row — because it bypasses RLS, and a key that bypasses RLS being
 * readable by every member is the whole security model undone.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const PASSWORD = 'a-perfectly-fine-password';

let pool: Pool; let up = false; let reason = ''; let kekDir: string;
let app: ReturnType<typeof buildApp>;
let secrets: ReturnType<typeof createSecretStore>;
let orgStore: ReturnType<typeof createOrgStore>;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 8, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'sh-kek-p1e-'));
  writeFileSync(join(kekDir, 'kek_2026_08.key'), randomBytes(32));
  try {
    const organizationId = await ensureBootstrapOrg(pool);
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const users = createUserStore(pool);
    orgStore = createOrgStore(pool);
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
  const addr = `p1e-${Date.now()}-${++seq}@steadhold.test`;
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/signup', payload: { email: addr, password: PASSWORD } });
  const body = res.json() as { user: { id: string }; csrf_token: string };
  return { userId: body.user.id, email: addr, csrf: body.csrf_token,
    cookie: /sh_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]! };
}
const as = (w: Who, m = false) => ({
  cookie: `${SESSION_COOKIE}=${w.cookie}`, ...(m ? { [CSRF_HEADER]: w.csrf } : {}) });

/**
 * A project with keys, minted the way the worker does — the saga is the worker's
 * to test, and what P1e's API needs is a project whose keys exist.
 */
async function projectWithKeys(owner: Who): Promise<{ ref: string; projectId: string; orgId: string; kid: string }> {
  const org = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner, true),
    payload: { name: 'Keys', slug: `p1e-${Date.now()}-${++seq}`.slice(0, 40) } });
  const orgId = (org.json() as { org: { id: string } }).org.id;
  const created = await app.inject({
    method: 'POST', url: '/v1/projects',
    headers: { ...as(owner, true), 'idempotency-key': `p1e-${Date.now()}-${++seq}` },
    payload: { name: `p1e-app-${++seq}`, org_id: orgId } });
  const { ref, id } = (created.json() as { project: { ref: string; id: string } }).project;
  const projectId = id.replace('prj_', '');

  const pair = generateKeypair();
  await secrets.put(projectId, SECRET_NAMES.jwtPrivateKey, pair.privateKeyPem);
  await secrets.put(projectId, SECRET_NAMES.jwtPublicKey, pair.publicKeyPem);
  await secrets.put(projectId, SECRET_NAMES.jwtKid, pair.kid);
  for (const role of ['anon', 'service_role'] as const) {
    const token = sign(projectKeyClaims({ ref, role, issuer: `https://${ref}.test` }), pair);
    await secrets.put(projectId, role === 'anon' ? SECRET_NAMES.anonKey : SECRET_NAMES.serviceRoleKey, token);
    await pool.query(
      `insert into project_api_keys (project_id, kind, key_hash, key_prefix)
       values ($1, $2, $3, $4) on conflict do nothing`,
      [projectId, role, randomBytes(32).toString('hex'),
       `cbk_${role === 'anon' ? 'anon' : 'srv'}_${ref.slice(0, 4)}`]);
  }
  return { ref, projectId, orgId, kid: pair.kid };
}

describe('P1e — the keys endpoint', () => {
  t('returns anon in the clear and withholds service_role', async () => {
    const owner = await account();
    const { ref } = await projectWithKeys(owner);
    const res = await app.inject({ method: 'GET', url: `/v1/projects/${ref}/keys`, headers: as(owner) });
    const keys = (res.json() as { api_keys: Array<{ kind: string; key?: string; prefix: string }> }).api_keys;

    const anon = keys.find((k) => k.kind === 'anon')!;
    const service = keys.find((k) => k.kind === 'service_role')!;
    // anon is meant for client-side code; hiding it teaches the wrong lesson
    // about which of the two is dangerous.
    expect(anon.key).toBeTruthy();
    expect(service.key).toBeUndefined();
  });

  t('the prefix identifies the key, rather than being a slice of a JWT', async () => {
    // Found live: a literal prefix of a JWT is the base64 of its header, which is
    // byte-identical for every key of every project — both keys displayed as
    // "eyJhbGciOiJF" and identified nothing.
    const owner = await account();
    const { ref } = await projectWithKeys(owner);
    const res = await app.inject({ method: 'GET', url: `/v1/projects/${ref}/keys`, headers: as(owner) });
    const prefixes = (res.json() as { api_keys: Array<{ prefix: string }> }).api_keys.map((k) => k.prefix);
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes).toContain(`cbk_anon_${ref.slice(0, 4)}`);
    expect(prefixes).toContain(`cbk_srv_${ref.slice(0, 4)}`);
  });

  t('reveals service_role to an owner and audits who looked', async () => {
    const owner = await account();
    const { ref, projectId } = await projectWithKeys(owner);
    const res = await app.inject({
      method: 'GET', url: `/v1/projects/${ref}/keys?reveal=true`, headers: as(owner) });
    const service = (res.json() as { api_keys: Array<{ kind: string; key?: string }> })
      .api_keys.find((k) => k.kind === 'service_role')!;
    expect(service.key).toMatch(/^ey/);

    const { rows } = await pool.query<{ actor: string; kind: string }>(
      `select actor_user_id::text as actor, metadata->>'kind' as kind
         from audit_logs where action = 'key.revealed' and project_id = $1`, [projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('service_role');
    expect(rows[0]!.actor).toBe(owner.userId.replace('usr_', ''));
  });

  t('refuses the reveal to a member', async () => {
    // service_role bypasses RLS. A key that bypasses RLS readable by every member
    // is the security model undone.
    const owner = await account();
    const member = await account();
    const { ref, orgId } = await projectWithKeys(owner);
    const invited = await app.inject({
      method: 'POST', url: `/v1/orgs/${orgId}/invites`, headers: as(owner, true),
      payload: { email: member.email, role: 'member' } });
    await app.inject({
      method: 'POST', url: '/v1/invites/accept', headers: as(member, true),
      payload: { token: (invited.json() as { token: string }).token } });

    const res = await app.inject({
      method: 'GET', url: `/v1/projects/${ref}/keys?reveal=true`, headers: as(member) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/A member cannot do this \(key\.manage\)/);
  });

  t('a non-member sees nothing at all', async () => {
    const owner = await account();
    const stranger = await account();
    const { ref } = await projectWithKeys(owner);
    const res = await app.inject({ method: 'GET', url: `/v1/projects/${ref}/keys`, headers: as(stranger) });
    expect(res.statusCode).toBe(404);
  });

  t('a key read twice is byte-identical (D-214)', async () => {
    // An anon key that changes on each view cannot be used as configuration,
    // which is what D-107 was protecting; envelope-encrypted storage gets the
    // same property without deterministic ECDSA.
    const owner = await account();
    const { ref } = await projectWithKeys(owner);
    const read = async () => (await app.inject({
      method: 'GET', url: `/v1/projects/${ref}/keys?reveal=true`, headers: as(owner) }))
      .json() as { api_keys: Array<{ kind: string; key?: string }> };
    const a = await read();
    const b = await read();
    expect(a.api_keys.map((k) => k.key)).toEqual(b.api_keys.map((k) => k.key));
  });
});

describe('P1e — JWKS', () => {
  t('serves the public key, unauthenticated and cacheable', async () => {
    const owner = await account();
    const { ref, kid } = await projectWithKeys(owner);
    // No credentials: a public key is public, and a JWKS behind auth breaks every
    // verifier the moment a credential rotates.
    const res = await app.inject({ method: 'GET', url: `/v1/projects/${ref}/.well-known/jwks.json` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=300/);
    const jwk = (res.json() as { keys: Array<Record<string, unknown>> }).keys[0]!;
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid });
    // The private half must never appear here.
    expect(JSON.stringify(jwk)).not.toContain('"d"');
  });

  t('the published key verifies the published keys', async () => {
    // The property the whole design exists for: the data plane verifies a token
    // with no shared secret.
    const owner = await account();
    const { ref } = await projectWithKeys(owner);
    const jwks = (await app.inject({
      method: 'GET', url: `/v1/projects/${ref}/.well-known/jwks.json` }))
      .json() as { keys: Array<Record<string, unknown>> };
    const pem = createPublicKey({ key: jwks.keys[0] as never, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' }).toString();

    const keys = (await app.inject({
      method: 'GET', url: `/v1/projects/${ref}/keys?reveal=true`, headers: as(owner) }))
      .json() as { api_keys: Array<{ kind: string; key: string }> };

    for (const k of keys.api_keys) {
      const claims = verify(k.key, { publicKeyPem: pem, kid: String(jwks.keys[0]!['kid']) });
      expect(claims.role).toBe(k.kind);
      // The ref claim is what the gateway cross-checks against the resolved Host,
      // so a key lifted from one project cannot be replayed against another.
      expect(claims.ref).toBe(ref);
      expect(claims.exp - claims.iat).toBe(10 * 365 * 24 * 60 * 60);
    }
  });
});
