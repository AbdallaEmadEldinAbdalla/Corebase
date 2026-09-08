import { describe, it, expect, vi } from 'vitest';
import { generateKeypair, toJwk, sign } from '@steadhold/jwt';
import { buildApp } from '../../app.ts';
import { createMemoryRateLimiter } from '../../kernel/rate-limit.ts';
import { createRoutingTable, refFromHost, type RouteEntry, type RoutingTable } from './routing.ts';

/**
 * P5c — the gateway's admission pipeline (hops 3–6).
 *
 * Unit-level on purpose: what is under test is the *order* of the checks and what
 * each one refuses, and both are decisions rather than integrations. The proxy
 * hop is exercised against a real PostgREST in the e2e suite; putting these
 * assertions there too would make a set of one-line decisions cost a container.
 *
 * The order is the part worth pinning. Resolution before key validation, because
 * a key cannot be checked against a project not yet identified. Key validation
 * before rate limiting, so an unauthenticated flood cannot spend a valid key's
 * budget. Rate limiting before the paused check, so a burst at a paused project
 * cannot enqueue one resume per request. Each of those is a denial of service on
 * somebody else if it moves.
 */
const DOMAIN = 'steadhold.test';
const REF = 'abck3xw7qqqqqqqq';

function fixture(over: Partial<RouteEntry> = {}, deps: Record<string, unknown> = {}) {
  const pair = generateKeypair();
  const now = Math.floor(Date.now() / 1000);
  const key = (role: 'anon' | 'service_role', ref = REF) => sign({
    iss: `https://${ref}.${DOMAIN}`, ref, role, iat: now, exp: now + 3600,
  }, { privateKeyPem: pair.privateKeyPem, kid: pair.kid });

  const entry: RouteEntry = {
    projectId: 'p1', ref: REF, status: 'ready', plan: 'free',
    nodeAddress: '10.0.0.1', postgrestPort: 7433,
    jwks: [toJwk(pair.publicKeyPem, pair.kid)],
    revoked: new Set<string>(), loadedAt: Date.now(), ...over,
  };
  const routes: RoutingTable = {
    lookup: (ref) => (ref === entry.ref ? entry : undefined),
    refresh: async () => 1, start: () => {}, stop: () => {}, size: () => 1,
  };
  const seen: string[] = [];
  const resumed: string[] = [];
  const upstream = vi.fn(async () => new Response('[]', {
    status: 200, headers: { 'content-type': 'application/json' } }));
  const app = buildApp({
    gateway: {
      routes, projectDomain: DOMAIN,
      ipLimiter: createMemoryRateLimiter({ limit: 100, windowSeconds: 60 }),
      keyLimiter: createMemoryRateLimiter({ limit: 100, windowSeconds: 60 }),
      projectLimiter: createMemoryRateLimiter({ limit: 100, windowSeconds: 60 }),
      traffic: { seen: (id) => seen.push(id) },
      resume: async (ref) => { resumed.push(ref); },
      upstreamFor: () => 'http://upstream.invalid',
      ...deps,
    },
  });
  return { app, key, entry, seen, resumed, upstream, pair };
}

const get = (app: ReturnType<typeof buildApp>, headers: Record<string, string>) =>
  app.inject({ method: 'GET', url: '/rest/v1/notes', headers });

describe('P5c — refFromHost', () => {
  it('takes the ref from the subdomain and validates its shape', () => {
    expect(refFromHost(`${REF}.${DOMAIN}`, DOMAIN)).toBe(REF);
    expect(refFromHost(`${REF}.${DOMAIN}:8443`, DOMAIN)).toBe(REF);
    // Case-insensitive, because a Host header is: a client sending the ref
    // capitalised must not get a 404 for a project that exists.
    expect(refFromHost(`${REF.toUpperCase()}.${DOMAIN.toUpperCase()}`, DOMAIN)).toBe(REF);
  });

  it('refuses anything that is not a ref under this domain', () => {
    // Suffix matching, not substring: `evil-steadhold.test` must not resolve, and
    // that is the classic way a host allowlist is written wrong.
    expect(refFromHost(`${REF}.evil-${DOMAIN}`, DOMAIN)).toBeUndefined();
    expect(refFromHost(`${REF}.${DOMAIN}.attacker.net`, DOMAIN)).toBeUndefined();
    expect(refFromHost(DOMAIN, DOMAIN)).toBeUndefined();
    expect(refFromHost(`sub.${REF}.${DOMAIN}`, DOMAIN)).toBeUndefined();
    expect(refFromHost('short.steadhold.test', DOMAIN)).toBeUndefined();
    expect(refFromHost(undefined, DOMAIN)).toBeUndefined();
  });
});

describe('P5c — admission', () => {
  it('404s an unknown host without revealing whether the project ever existed', async () => {
    const { app } = fixture();
    const res = await get(app, { host: `zzzzzzzzqqqqqqqq.${DOMAIN}`, apikey: 'x' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('project_not_found');
    await app.close();
  });

  it('401s a missing key before looking at anything else', async () => {
    const { app } = fixture();
    const res = await app.inject({
      method: 'GET', url: '/rest/v1/notes', headers: { host: `${REF}.${DOMAIN}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('missing_api_key');
    await app.close();
  });

  it('separates a key signed elsewhere (401) from one naming elsewhere (403)', async () => {
    const { app, key } = fixture();
    const other = generateKeypair();
    const now = Math.floor(Date.now() / 1000);
    // Right ref, wrong signer.
    const forged = sign({ iss: `https://${REF}.${DOMAIN}`, ref: REF, role: 'anon',
      iat: now, exp: now + 3600 }, { privateKeyPem: other.privateKeyPem, kid: other.kid });
    expect((await get(app, { host: `${REF}.${DOMAIN}`, apikey: forged })).statusCode).toBe(401);
    // Right signer, wrong ref — the check that makes a Host header an identity
    // rather than an assertion. 403 rather than 401, and the difference is not
    // cosmetic: reaching it requires a token *this project's key* signed, so it
    // is invisible to anyone who has not already got past the signature, and it
    // means the platform minted something inconsistent rather than that someone
    // presented a bad key (the isolation matrix's API-5).
    const wrongRef = key('anon', 'ffffffffffffffff');
    const res = await get(app, { host: `${REF}.${DOMAIN}`, apikey: wrongRef });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('project_mismatch');
    await app.close();
  });

  it('refuses a user access token in the apikey slot', async () => {
    const { app, pair } = fixture();
    const now = Math.floor(Date.now() / 1000);
    // Signed by the project's own key and naming the project — a naive
    // implementation accepts it. Letting a user's credential select the project
    // is a different trust decision from a project key doing so (D-320).
    const userToken = sign({
      iss: `https://${REF}.${DOMAIN}`, ref: REF, role: 'authenticated',
      sub: 'u1', iat: now, exp: now + 3600,
    }, { privateKeyPem: pair.privateKeyPem, kid: pair.kid });
    const res = await get(app, { host: `${REF}.${DOMAIN}`, apikey: userToken });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a revoked key without a database query', async () => {
    const { app, key } = fixture();
    const anon = key('anon');
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(anon).digest('hex');
    const revoked = fixture({ revoked: new Set([hash]) });
    const res = await get(revoked.app, { host: `${REF}.${DOMAIN}`, apikey: anon });
    // Revocation has to bite on the hot path or it is advisory — which is why the
    // hashes ride in the routing entry rather than being looked up.
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
    await revoked.app.close();
    await app.close();
  });

  it('records traffic for a paused project, then answers 503 and wakes it', async () => {
    const { app, key, seen, resumed } = fixture({ status: 'paused' });
    const res = await get(app, { host: `${REF}.${DOMAIN}`, apikey: key('anon') });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('project_resuming');
    // Retry-After 5 puts an SDK's retries at ~5/10/15s, riding the p50 <5s /
    // p95 <15s resume targets so the first retry lands at the median.
    expect(res.headers['retry-after']).toBe('5');
    expect(resumed).toEqual([REF]);
    // And the signal fired *before* the status check: traffic to a paused
    // project is still traffic, and it is the evidence pausing it was wrong.
    expect(seen).toEqual(['p1']);
    await app.close();
  });

  it('410s a deleted project rather than 404', async () => {
    const { app, key } = fixture({ status: 'soft_deleted' });
    const res = await get(app, { host: `${REF}.${DOMAIN}`, apikey: key('anon') });
    // The project existed and is gone, which a client logs differently from a
    // typo in a hostname.
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('project_deleted');
    await app.close();
  });

  it('rate-limits before it can be made to enqueue a resume per request', async () => {
    const { app, key, resumed } = fixture({ status: 'paused' }, {
      ipLimiter: createMemoryRateLimiter({ limit: 2, windowSeconds: 60 }),
    });
    const anon = key('anon');
    for (let i = 0; i < 2; i++) {
      expect((await get(app, { host: `${REF}.${DOMAIN}`, apikey: anon })).statusCode).toBe(503);
    }
    const limited = await get(app, { host: `${REF}.${DOMAIN}`, apikey: anon });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    // Two resumes for two admitted requests, and none for the refused one — the
    // reason the limits sit ahead of the paused check.
    expect(resumed).toHaveLength(2);
    await app.close();
  });

  it('503s a project with no data API rather than proxying to nowhere', async () => {
    const { app, key } = fixture({ postgrestPort: null }, { upstreamFor: () => undefined });
    const res = await get(app, { host: `${REF}.${DOMAIN}`, apikey: key('anon') });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('service_unavailable');
    await app.close();
  });
});

/**
 * The routing table's own failure modes. Its SQL is exercised live against the
 * staging schema rather than here (a fake pool proves nothing about column
 * names), so what these cover is the part live traffic would only reveal as a
 * mystery 401: what happens when one project's key cannot be loaded.
 */
describe('P5c — routing table resilience', () => {
  const row = (id: string, ref: string) => ({
    id, ref, status: 'ready', plan: 'free', node_address: '10.0.0.1',
    postgrest_port: 7433, extra_keys: [], revoked: [],
  });
  const poolOf = (rows: unknown[]) =>
    ({ query: async () => ({ rows }) }) as unknown as Parameters<typeof createRoutingTable>[0]['pool'];

  it('reports a key that cannot be loaded instead of silently serving none', async () => {
    const errors: string[] = [];
    const table = createRoutingTable({
      pool: poolOf([row('p1', 'aaaaaaaa')]),
      activeKey: async () => { throw new Error('KEK unavailable'); },
      onError: (e) => errors.push(e.message),
    });
    await table.refresh();
    // The project is still routable — the alternative is a refresh that fails
    // the fleet over one project — but the reason it has no key is now on the
    // record rather than inferable only from a 401.
    expect(table.lookup('aaaaaaaa')?.jwks).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('aaaaaaaa');
    expect(errors[0]).toContain('KEK unavailable');
  });

  it('one project\'s failure does not cost the fleet its refresh', async () => {
    const table = createRoutingTable({
      pool: poolOf([row('p1', 'aaaaaaaa'), row('p2', 'bbbbbbbb')]),
      activeKey: async (id) => {
        if (id === 'p1') throw new Error('nope');
        return { pem: generateKeypair().publicKeyPem, kid: 'k2' };
      },
      onError: () => {},
    });
    expect(await table.refresh()).toBe(2);
    expect(table.lookup('bbbbbbbb')?.jwks).toHaveLength(1);
  });
});
