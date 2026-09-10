import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request, setCsrfToken, csrfToken, clearCsrfToken, resetCsrfSeeding } from './api.ts';

/**
 * The CSRF token's lifecycle in the client (D-473).
 *
 * The bug these cover: `sessionStorage` is per *tab* and the session cookie is
 * per *origin*, so a tab that did not itself log in held the session and no
 * token — every `GET` worked, every mutation 403'd, and the table editor read
 * nothing at all because D-132 runs even a read as `POST /db/query`.
 *
 * Tested at `request()` rather than at `ensureCsrf()`, which is not exported on
 * purpose: what matters is that a mutation *sends* a token it did not start
 * with, and asserting on the recorded requests proves that where a unit test of
 * the helper would only prove it returned a string.
 */

interface Recorded { url: string; method: string; headers: Record<string, string> }

let sent: Recorded[] = [];
let replies: (() => { status: number; body: unknown })[] = [];
const realWindow = (globalThis as { window?: unknown }).window;
const realFetch = globalThis.fetch;

function stubWindow(): void {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    __STEADHOLD__: { apiBase: 'http://api.test' },
  };
}

function stubFetch(): void {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      method: (init.method ?? 'GET').toUpperCase(),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const next = replies.shift();
    const { status, body } = next
      ? next()
      : { status: 500, body: { error: { code: 'INTERNAL', message: 'no reply queued' } } };
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => 'req_test' },
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
}

const ok = (body: unknown) => () => ({ status: 200, body });
const csrfRefused = () => ({
  status: 403,
  body: { error: { code: 'CSRF_REQUIRED', message: 'needs x-csrf-token', request_id: 'r' } },
});

beforeEach(() => {
  sent = [];
  replies = [];
  stubWindow();
  stubFetch();
  clearCsrfToken();
  resetCsrfSeeding();
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
  globalThis.fetch = realFetch;
});

describe('the CSRF token a tab did not log in for', () => {
  it('is fetched from /me before a mutation, and sent with it', async () => {
    replies = [ok({ user: null, memberships: [], principal: 'session', csrf_token: 'tok-1' }),
               ok({ done: true })];

    await request('/v1/projects/p/db/query', { method: 'POST', body: { sql: 'select 1' } });

    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET http://api.test/v1/auth/me',
      'POST http://api.test/v1/projects/p/db/query',
    ]);
    expect(sent[1]!.headers['x-csrf-token']).toBe('tok-1');
    // Stored, so the next mutation in this tab costs no round trip.
    expect(csrfToken()).toBe('tok-1');
  });

  it('is not fetched again once the tab holds one', async () => {
    setCsrfToken('already-here');
    replies = [ok({ done: true })];

    await request('/v1/projects/p/db/query', { method: 'POST', body: {} });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['x-csrf-token']).toBe('already-here');
  });

  it('is asked for once when several mutations start together', async () => {
    // Single-flight. A page that fires three mutations on mount must ask once,
    // not three times — and the third must not race past an unfinished seed.
    replies = [ok({ user: null, memberships: [], principal: 'session', csrf_token: 'tok-2' }),
               ok({ n: 1 }), ok({ n: 2 }), ok({ n: 3 })];

    await Promise.all([
      request('/a', { method: 'POST', body: {} }),
      request('/b', { method: 'POST', body: {} }),
      request('/c', { method: 'POST', body: {} }),
    ]);

    expect(sent.filter((r) => r.url.endsWith('/v1/auth/me'))).toHaveLength(1);
    for (const r of sent.filter((r) => r.method === 'POST')) {
      expect(r.headers['x-csrf-token']).toBe('tok-2');
    }
  });

  it('is not sought for login, which is how a session begins', async () => {
    /**
     * The regression this exists to prevent, and it would only have shown up in
     * a browser that had never signed in: seeding on `POST /v1/auth/login` meant
     * a `GET /v1/auth/me` that 401s, whose central handling clears the token and
     * redirects to `/login` — from inside the login request, which then never
     * left. Signing in would have been impossible.
     */
    replies = [ok({ user: { id: 'u' }, csrf_token: 'from-login' })];

    await request('/v1/auth/login', { method: 'POST', body: { email: 'a@b.c' } });

    expect(sent.map((r) => r.url)).toEqual(['http://api.test/v1/auth/login']);
  });

  it('is not sought for signup either', async () => {
    replies = [ok({ user: { id: 'u' }, csrf_token: 'from-signup' })];
    await request('/v1/auth/signup', { method: 'POST', body: {} });
    expect(sent).toHaveLength(1);
  });

  it('does not turn a failed probe into the caller\'s error', async () => {
    // No session at all: the caller must see its own 401, for its own URL, not a
    // 401 about `/v1/auth/me`.
    replies = [() => ({ status: 401,
                        body: { error: { code: 'UNAUTHORIZED', message: 'no session' } } }),
               () => ({ status: 401,
                        body: { error: { code: 'UNAUTHORIZED', message: 'no session' } } })];

    await expect(request('/v1/orgs', { method: 'POST', body: {} }))
      .rejects.toMatchObject({ status: 401 });
    expect(sent.map((r) => r.url)).toEqual([
      'http://api.test/v1/auth/me',
      'http://api.test/v1/orgs',
    ]);
  });

  it('is never sent on a GET, which needs none', async () => {
    setCsrfToken('tok-3');
    replies = [ok({ rows: [] })];

    await request('/v1/projects/p/db/introspect');

    expect(sent[0]!.headers['x-csrf-token']).toBeUndefined();
  });
});

describe('a stale token', () => {
  it('is replaced and the mutation retried exactly once', async () => {
    // The other half of the bug: log out and back in elsewhere and this tab's
    // stored token belongs to a session that no longer exists. A reload does not
    // help, because `sessionStorage` survives one.
    setCsrfToken('stale');
    replies = [csrfRefused,
               ok({ user: null, memberships: [], principal: 'session', csrf_token: 'fresh' }),
               ok({ done: true })];

    const out = await request<{ done: boolean }>('/v1/projects/p/db/query',
                                                 { method: 'POST', body: {} });

    expect(out.done).toBe(true);
    expect(sent.map((r) => `${r.method} ${r.url.replace('http://api.test', '')}`)).toEqual([
      'POST /v1/projects/p/db/query',
      'GET /v1/auth/me',
      'POST /v1/projects/p/db/query',
    ]);
    expect(sent[0]!.headers['x-csrf-token']).toBe('stale');
    expect(sent[2]!.headers['x-csrf-token']).toBe('fresh');
  });

  it('gives up after one retry rather than looping', async () => {
    setCsrfToken('stale');
    replies = [csrfRefused,
               ok({ user: null, memberships: [], principal: 'session', csrf_token: 'also-bad' }),
               csrfRefused];

    await expect(request('/v1/projects/p/db/query', { method: 'POST', body: {} }))
      .rejects.toThrow(/x-csrf-token/);
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('does not retry a 403 that is not about CSRF', async () => {
    // "Your role is insufficient" is not recoverable by fetching a token, and
    // retrying it would double every permission failure.
    setCsrfToken('fine');
    replies = [() => ({ status: 403,
                        body: { error: { code: 'UNAUTHORIZED', message: 'as a person' } } })];

    await expect(request('/x', { method: 'POST', body: {} })).rejects.toThrow(/as a person/);
    expect(sent).toHaveLength(1);
  });
});
