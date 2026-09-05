import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  setUp, tearDown, gateway, hostOf, mint, type Harness,
} from './harness.ts';

/**
 * API-path isolation — the threat model's boundary (b).
 *
 * The matrix asserts **exact** status codes, not merely "denied". A 500 where 401
 * is specified is a failure: it means the boundary held for a different reason
 * than the one designed, and a reason nobody chose is a reason nobody maintains.
 *
 * Every one of these attacks is run with tokens minted by the *real* project
 * keys, including tokens no attacker could produce. Refusing a forgery that is
 * correctly signed is the only way to show the refusal rests on the design rather
 * than on the attacker's inability to sign.
 */
let h: Harness | undefined;
let app: FastifyInstance;

beforeAll(async () => { h = await setUp(); app = await gateway(h); });
afterAll(async () => { await app?.close(); await tearDown(h); });

const A = () => h!.a;
const B = () => h!.b;

/** A data-plane request, exactly as a client makes one. */
const get = (host: string, headers: Record<string, string>, path = '/rest/v1/canary?select=*') =>
  app.inject({ method: 'GET', url: path, headers: { host, ...headers } });

/** No test passes by returning nothing: every refusal must also return no rows. */
function expectNoRowsFrom(body: string, ...refs: string[]) {
  for (const ref of refs) expect(body).not.toContain(ref);
}

describe('API-1 — A\'s anon key against B', () => {
  it('is refused 401 and never returns a B row', async () => {
    const res = await get(hostOf(B()), { apikey: A().anonKey });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
    expectNoRowsFrom(res.body, B().ref);
  });
});

describe('API-2 — A\'s service_role key against B', () => {
  it('is refused 401: B\'s JWKS never verifies a token A signed', async () => {
    const res = await get(hostOf(B()), { apikey: A().serviceKey });
    expect(res.statusCode).toBe(401);
    // The strongest row in the matrix. service_role bypasses RLS entirely, so if
    // per-project keypairs did not hold, this single request would read all of B.
    expectNoRowsFrom(res.body, B().ref);
  });
});

describe('API-3 — A\'s authenticated JWT against B', () => {
  it('is refused whether it arrives as the apikey or as the bearer token', async () => {
    const aUser = mint(A(), { role: 'authenticated', sub: A().ownerUid });

    // As the apikey: refused at the gateway. A user credential must never select
    // a project — a different trust decision from a project key doing so.
    const asKey = await get(hostOf(B()), { apikey: aUser });
    expect(asKey.statusCode).toBe(401);

    // The subtler shape: B's own anon key (genuinely public, D-029) to get past
    // the gateway, with A's user token as the bearer. PostgREST verifies it
    // against B's JWKS and refuses.
    const asBearer = await get(hostOf(B()), {
      apikey: B().anonKey, authorization: `Bearer ${aUser}` });
    expect(asBearer.statusCode).toBe(401);
    expectNoRowsFrom(asBearer.body, B().ref);
  });
});

describe('API-4 — A\'s JWT with the ref claim rewritten to B, re-signed by A', () => {
  it('is still refused at B: the claim is not the credential', async () => {
    const forged = mint(A(), { role: 'anon', ref: B().ref });
    const res = await get(hostOf(B()), { apikey: forged });
    expect(res.statusCode).toBe(401);
    expectNoRowsFrom(res.body, B().ref);
  });
});

describe('API-5 — a token claiming B, presented at A', () => {
  it('is refused 403: identity comes from the route, and a mismatched claim is not trusted', async () => {
    // Signed by A, so it verifies against A's JWKS — this is the one case where
    // the signature is genuine and only the claim lies. It is also a case only
    // the platform can produce, which is why it earns its own status code: a 403
    // here means *we* minted something inconsistent, not that someone guessed.
    const res = await get(hostOf(A()), { apikey: mint(A(), { role: 'anon', ref: B().ref }) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('project_mismatch');
    expectNoRowsFrom(res.body, A().ref, B().ref);
  });
});

describe('API-6 — alg=none', () => {
  it('is refused 401: the verifier pins ES256 and an unsigned token is not a token', async () => {
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${part({ alg: 'none', typ: 'JWT', kid: A().signing.kid })}.`
      + `${part({ iss: `https://${A().ref}.corebase.test`, ref: A().ref, role: 'service_role',
                  iat: now, exp: now + 3600 })}.`;
    const res = await get(hostOf(A()), { apikey: unsigned });
    expect(res.statusCode).toBe(401);
    expectNoRowsFrom(res.body, A().ref);
  });
});

describe('API-7 — HS256 downgrade, signing with A\'s public key as the HMAC secret', () => {
  it('is refused 401: the public key is never treated as a shared secret', async () => {
    // The classic asymmetric-to-symmetric confusion. A's public key is published
    // in its JWKS, so an attacker genuinely has this material; the attack works
    // against any verifier that picks its algorithm from the token's header.
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = part({ alg: 'HS256', typ: 'JWT', kid: A().signing.kid });
    const body = part({ iss: `https://${A().ref}.corebase.test`, ref: A().ref,
                        role: 'service_role', iat: now, exp: now + 3600 });
    const sig = createHmac('sha256', pubPem).update(`${head}.${body}`).digest('base64url');
    const res = await get(hostOf(A()), { apikey: `${head}.${body}.${sig}` });
    expect(res.statusCode).toBe(401);
    expectNoRowsFrom(res.body, A().ref);
  });
});

describe('API-8 — an expired token', () => {
  it('is refused 401 even though everything else about it is genuine', async () => {
    const res = await get(hostOf(A()), {
      apikey: mint(A(), { role: 'service_role', expSeconds: -60 }) });
    expect(res.statusCode).toBe(401);
    expectNoRowsFrom(res.body, A().ref);
  });
});

describe('API-9 — a kid that resolves in no JWKS', () => {
  it('is refused 401', async () => {
    const res = await get(hostOf(A()), {
      apikey: mint(A(), { role: 'anon', kid: 'kid-that-does-not-exist' }) });
    expect(res.statusCode).toBe(401);
  });
});

describe('API-10 — client headers cannot override routing', () => {
  it('resolves the project from the Host, and a contradicting header changes nothing', async () => {
    // B's Host with headers screaming "A" in every spelling an attacker might try.
    const res = await get(hostOf(B()), {
      apikey: B().anonKey,
      'x-project-ref': A().ref,
      'x-forwarded-host': hostOf(A()),
      'x-project-id': A().id,
    });
    // Admitted as B — and returns B's published rows, never A's.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`${B().ref}-public`);
    expectNoRowsFrom(res.body, A().ref);

    // The mirror: A's key at B's Host is still refused even with the header set,
    // so the header cannot be used to *gain* a project either.
    const swap = await get(hostOf(B()), { apikey: A().anonKey, 'x-project-ref': A().ref });
    expect(swap.statusCode).toBe(401);
  });
});
