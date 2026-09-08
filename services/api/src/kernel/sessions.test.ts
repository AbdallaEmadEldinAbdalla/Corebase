import { describe, it, expect } from 'vitest';
import {
  createSessionStore, csrfOk, sessionCookie, clearedSessionCookie, readCookie,
  SESSION_COOKIE, IDLE_TTL_SECONDS, ABSOLUTE_TTL_SECONDS, type Session,
} from './sessions.ts';
import type { Redis } from '@steadhold/queue';

/** In-memory Redis double, enough for the session store's surface. */
function fakeRedis() {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  const redis = {
    async set(k: string, v: string, _ex: string, seconds: number) {
      data.set(k, v); ttl.set(k, seconds); return 'OK';
    },
    async get(k: string) { return data.get(k) ?? null; },
    async del(k: string) { const had = data.delete(k); ttl.delete(k); return had ? 1 : 0; },
    async scan(_cursor: string, _m: string, pattern: string, _c: string, _n: number) {
      const re = new RegExp('^' + pattern.replace('*', '.*') + '$');
      return ['0', [...data.keys()].filter((k) => re.test(k))] as [string, string[]];
    },
  } as unknown as Redis;
  return { redis, data, ttl };
}

describe('sessions', () => {
  it('issues an opaque id and stores the record under a hash of it', async () => {
    const { redis, data } = fakeRedis();
    const store = createSessionStore(redis);
    const s = await store.create('user-1');

    expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // A Redis dump, a KEYS listing or a debug log then contains no usable cookie.
    expect([...data.keys()][0]).not.toContain(s.id);
    expect([...data.keys()][0]).toMatch(/^sh:session:[0-9a-f]{64}$/);
  });

  it('resolves and slides the idle window', async () => {
    const { redis, ttl } = fakeRedis();
    const store = createSessionStore(redis);
    const s = await store.create('user-1');
    const found = await store.touch(s.id);
    expect(found?.user_id).toBe('user-1');
    expect([...ttl.values()][0]).toBe(IDLE_TTL_SECONDS);
  });

  it('enforces the absolute limit from the record, not from the TTL', async () => {
    // The bug this guards: a TTL refreshed on every use is not an absolute
    // limit, so a session in daily use would live forever.
    const { redis, data } = fakeRedis();
    const store = createSessionStore(redis);
    const s = await store.create('user-1');
    const k = [...data.keys()][0]!;
    const record = JSON.parse(data.get(k)!) as { created_at: number };
    record.created_at -= ABSOLUTE_TTL_SECONDS + 1;
    data.set(k, JSON.stringify(record));

    expect(await store.touch(s.id)).toBeUndefined();
    expect(data.has(k)).toBe(false);            // and it is cleaned up
  });

  it('returns undefined for an unknown, empty or absurd id', async () => {
    const { redis } = fakeRedis();
    const store = createSessionStore(redis);
    expect(await store.touch('nope')).toBeUndefined();
    expect(await store.touch('')).toBeUndefined();
    expect(await store.touch('x'.repeat(500))).toBeUndefined();
  });

  it('survives a corrupted record instead of throwing', async () => {
    const { redis, data } = fakeRedis();
    const store = createSessionStore(redis);
    const s = await store.create('user-1');
    data.set([...data.keys()][0]!, 'not json');
    expect(await store.touch(s.id)).toBeUndefined();
  });

  it('destroys one session, and all of a user\'s', async () => {
    const { redis } = fakeRedis();
    const store = createSessionStore(redis);
    const a = await store.create('user-1');
    await store.create('user-1');
    const other = await store.create('user-2');

    await store.destroy(a.id);
    expect(await store.touch(a.id)).toBeUndefined();

    // "Log out everywhere", and what a password change must do.
    expect(await store.destroyAllFor('user-1')).toBe(1);
    expect(await store.touch(other.id)).toBeDefined();     // untouched
  });
});

describe('CSRF', () => {
  const session = { id: 'x', user_id: 'u', csrf: 'tok-abc', created_at: 0, last_seen_at: 0 } as Session;

  it('requires the header to match the session token', () => {
    expect(csrfOk(session, 'tok-abc')).toBe(true);
    expect(csrfOk(session, 'tok-abd')).toBe(false);
    expect(csrfOk(session, undefined)).toBe(false);
    expect(csrfOk(session, '')).toBe(false);
  });

  it('does not leak length through an early return', () => {
    expect(csrfOk(session, 'short')).toBe(false);
    expect(csrfOk(session, 'much much longer than the token')).toBe(false);
  });
});

describe('cookies', () => {
  it('is httpOnly, Lax and Secure outside local development', () => {
    const c = sessionCookie('abc', { secure: true });
    expect(c).toContain(`${SESSION_COOKIE}=abc`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
    expect(sessionCookie('abc', { secure: false })).not.toContain('Secure');
  });

  it('clears with Max-Age=0', () => {
    expect(clearedSessionCookie()).toContain('Max-Age=0');
  });

  it('reads one cookie out of a header', () => {
    expect(readCookie('a=1; sh_session=xyz; b=2', SESSION_COOKIE)).toBe('xyz');
    expect(readCookie('sh_session=xyz', SESSION_COOKIE)).toBe('xyz');
    expect(readCookie('other=1', SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    // A cookie whose name merely ends with ours must not match.
    expect(readCookie('not_cb_session=xyz', SESSION_COOKIE)).toBeUndefined();
  });
});
