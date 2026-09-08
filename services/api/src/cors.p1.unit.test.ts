import { describe, it, expect } from 'vitest';
import { buildApp } from './app.ts';
import { parseOrigins } from './kernel/cors.ts';

const DASH = 'http://localhost:3000';
const app = (origins: string[] = [DASH]) => buildApp({ corsOrigins: origins, staticToken: 't' });

describe('P1g — CORS', () => {
  it('echoes an allowlisted origin and permits credentials', async () => {
    const res = await app().inject({ method: 'GET', url: '/health', headers: { origin: DASH } });
    expect(res.headers['access-control-allow-origin']).toBe(DASH);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('never answers with a wildcard', async () => {
    // The check is on the *value*, not on the config: a wildcard with credentials
    // is the mistake this whole module exists to make impossible.
    for (const origin of [DASH, 'https://evil.example']) {
      const res = await app().inject({ method: 'GET', url: '/health', headers: { origin } });
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  it('sends no permission headers for an origin that is not on the list', async () => {
    const res = await app().inject({
      method: 'GET', url: '/health', headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    // The request still succeeds — the browser is what refuses to show it. A
    // server-side 403 would leak that the origin was considered.
    expect(res.statusCode).toBe(200);
  });

  it('varies on Origin whether or not the origin is allowed', async () => {
    // Without this a shared cache can serve one origin's Allow-Origin to
    // another, which turns a correct allowlist into an incorrect one at the edge.
    for (const headers of [{ origin: DASH }, { origin: 'https://evil.example' }, {}]) {
      const res = await app().inject({ method: 'GET', url: '/health', headers });
      expect(String(res.headers['vary'])).toContain('Origin');
    }
  });

  it('exposes x-request-id so an error surface can show it', async () => {
    const res = await app().inject({ method: 'GET', url: '/health', headers: { origin: DASH } });
    expect(res.headers['access-control-expose-headers']).toContain('x-request-id');
  });

  it('answers a preflight with the methods and headers the dashboard needs', async () => {
    const res = await app().inject({
      method: 'OPTIONS', url: '/v1/projects',
      headers: { origin: DASH, 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    const allowHeaders = String(res.headers['access-control-allow-headers']);
    // x-csrf-token is the one that matters: requiring a custom header is what
    // forces the preflight in the first place.
    for (const h of ['content-type', 'x-csrf-token', 'idempotency-key', 'authorization']) {
      expect(allowHeaders).toContain(h);
    }
    expect(String(res.headers['access-control-allow-methods'])).toContain('DELETE');
  });

  it('answers a preflight with what a *data-plane* client needs (P4i)', async () => {
    // This suite only ever asserted the dashboard's needs, and the dashboard
    // talks to the control plane. So `apikey` — required on every `/auth/v1/*`
    // endpoint (D-029) — was absent from the allowlist for the whole of Phase 4,
    // which made the entire data plane unreachable from a browser: a custom
    // header forces a preflight, the preflight lists only the allowed ones, and
    // every signup and login from a customer's frontend failed before it left
    // the browser. Found by writing the phase's demo page, the auth API's first
    // browser client.
    const res = await app().inject({
      method: 'OPTIONS', url: '/auth/v1/signup',
      headers: { origin: DASH, 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['access-control-allow-headers'])).toContain('apikey');
    // `PUT /auth/v1/user` is how a user changes their password, their email or
    // their metadata, and PATCH is not a substitute for it.
    expect(String(res.headers['access-control-allow-methods'])).toContain('PUT');
  });

  it('refuses a preflight from an unknown origin without saying why', async () => {
    const res = await app().inject({
      method: 'OPTIONS', url: '/v1/projects',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is off when no origins are configured', async () => {
    // An unset SH_DASHBOARD_ORIGINS must not fall back to localhost: the service
    // starts fine either way, so a permissive default would ship to production
    // the first time someone forgot the variable.
    const res = await app([]).inject({ method: 'GET', url: '/health', headers: { origin: DASH } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('leaves a request with no Origin completely alone', async () => {
    const res = await app().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  describe('parseOrigins', () => {
    it('splits, trims and drops a trailing slash', () => {
      expect(parseOrigins(' http://localhost:3000/ , https://app.steadhold.dev '))
        .toEqual(['http://localhost:3000', 'https://app.steadhold.dev']);
    });
    it('treats unset and empty as no access', () => {
      expect(parseOrigins(undefined)).toEqual([]);
      expect(parseOrigins('')).toEqual([]);
      expect(parseOrigins(' , ')).toEqual([]);
    });
    it('does not accept a wildcard as an origin', () => {
      // Parsing keeps it verbatim; the point is that it can then never match a
      // real Origin header, so a wildcard in config fails closed rather than open.
      expect(new Set(parseOrigins('*')).has('http://localhost:3000')).toBe(false);
    });
  });
});
