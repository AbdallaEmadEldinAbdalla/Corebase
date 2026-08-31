import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@corebase/queue';

/**
 * Dashboard sessions (D-062): an opaque id in an httpOnly cookie, the state in
 * Redis.
 *
 * Opaque rather than a JWT on purpose. A session's defining feature is that it
 * can be *ended* — logout, a password change, an admin disabling an account —
 * and a self-contained token cannot be, only denylisted, which is a session store
 * with extra steps and worse failure modes. Redis losing sessions logs everyone
 * out, which is an annoyance; a JWT that cannot be revoked is a security problem.
 *
 * Two clocks, per the platform API: **7 days idle** and **30 days absolute**. The
 * idle window is Redis's TTL, refreshed on use. The absolute one is a timestamp
 * inside the record, because a TTL that gets refreshed forever is not an absolute
 * limit — which is the bug this comment exists to prevent.
 */

export const SESSION_COOKIE = 'cb_session';
export const CSRF_HEADER = 'x-csrf-token';

export const IDLE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60;

const KEY_PREFIX = 'cb:session:';
const ID_BYTES = 32;

export interface SessionRecord {
  user_id: string;
  /** Double-submit CSRF token: also in a readable cookie, echoed in a header. */
  csrf: string;
  created_at: number;
  last_seen_at: number;
}

export interface Session extends SessionRecord {
  id: string;
}

const key = (id: string) => `${KEY_PREFIX}${createHash('sha256').update(id).digest('hex')}`;

export function createSessionStore(redis: Redis) {
  return {
    async create(userId: string): Promise<Session> {
      const id = randomBytes(ID_BYTES).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const record: SessionRecord = {
        user_id: userId,
        csrf: randomBytes(24).toString('base64url'),
        created_at: now,
        last_seen_at: now,
      };
      // Keyed by a hash of the id, not the id: a Redis dump — a `KEYS *`, a
      // debug log, an exposed metrics endpoint — then contains no usable
      // session cookie.
      await redis.set(key(id), JSON.stringify(record), 'EX', IDLE_TTL_SECONDS);
      return { id, ...record };
    },

    /** Resolve and slide the idle window. Returns undefined for anything expired. */
    async touch(id: string): Promise<Session | undefined> {
      if (!id || id.length > 128) return undefined;
      const raw = await redis.get(key(id));
      if (!raw) return undefined;
      let record: SessionRecord;
      try { record = JSON.parse(raw) as SessionRecord; } catch { return undefined; }

      const now = Math.floor(Date.now() / 1000);
      if (now - record.created_at > ABSOLUTE_TTL_SECONDS) {
        // The absolute limit, enforced from the record rather than from a TTL
        // that use keeps refreshing.
        await redis.del(key(id));
        return undefined;
      }
      record.last_seen_at = now;
      await redis.set(key(id), JSON.stringify(record), 'EX', IDLE_TTL_SECONDS);
      return { id, ...record };
    },

    async destroy(id: string): Promise<void> {
      if (id) await redis.del(key(id));
    },

    /** Every session for a user — for "log out everywhere" and password changes. */
    async destroyAllFor(userId: string): Promise<number> {
      // SCAN, never KEYS: KEYS blocks Redis for the whole keyspace, and the
      // queue shares this instance.
      let cursor = '0';
      let removed = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 200);
        cursor = next;
        for (const k of keys) {
          const raw = await redis.get(k);
          if (!raw) continue;
          try {
            if ((JSON.parse(raw) as SessionRecord).user_id === userId) {
              await redis.del(k);
              removed++;
            }
          } catch { /* not a session record */ }
        }
      } while (cursor !== '0');
      return removed;
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/**
 * Double-submit CSRF check.
 *
 * The cookie is `SameSite=Lax`, which already blocks cross-site POSTs from a
 * plain form — but not a same-site subdomain, and not every browser we will meet.
 * Comparing a header against the session's own token costs nothing and closes
 * both.
 */
export function csrfOk(session: Session, header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(session.csrf, 'utf8');
  const b = Buffer.from(header, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Cookie attributes. `secure` is off only for plain-HTTP local development. */
export function sessionCookie(id: string, opts: { secure: boolean }): string {
  return [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${IDLE_TTL_SECONDS}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Parse one cookie out of a header without pulling in a cookie library. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * In-memory sessions, for unit tests and for `pnpm dev` without Redis.
 *
 * Same contract, same two clocks — so a test exercising the absolute limit
 * exercises the real rule. Not a production path: a restart logs everyone out and
 * a second instance shares nothing, which is exactly why production uses Redis.
 */
export function createMemorySessionStore(): SessionStore {
  const data = new Map<string, SessionRecord>();
  const store: SessionStore = {
    async create(userId) {
      const id = randomBytes(ID_BYTES).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const record: SessionRecord = {
        user_id: userId, csrf: randomBytes(24).toString('base64url'),
        created_at: now, last_seen_at: now,
      };
      data.set(key(id), record);
      return { id, ...record };
    },
    async touch(id) {
      if (!id || id.length > 128) return undefined;
      const record = data.get(key(id));
      if (!record) return undefined;
      const now = Math.floor(Date.now() / 1000);
      if (now - record.created_at > ABSOLUTE_TTL_SECONDS) { data.delete(key(id)); return undefined; }
      record.last_seen_at = now;
      return { id, ...record };
    },
    async destroy(id) { data.delete(key(id)); },
    async destroyAllFor(userId) {
      let n = 0;
      for (const [k, v] of data) if (v.user_id === userId) { data.delete(k); n++; }
      return n;
    },
  };
  return store;
}
