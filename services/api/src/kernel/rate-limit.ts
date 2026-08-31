import type { Redis } from '@corebase/queue';

/**
 * A fixed-window counter, for the login path (D-033: "rate-limited per
 * identifier").
 *
 * Fixed window and not sliding, deliberately: a sliding window costs a sorted set
 * per key and the precision buys nothing here. The attack this stops is credential
 * stuffing at thousands of attempts per minute, and a limit that a determined
 * attacker can double by straddling a window boundary is still a limit that turns
 * "thousands per minute" into "twenty".
 *
 * Keyed per identifier *and* per IP, both, because either alone has an obvious
 * hole: per-IP only lets a botnet spread one password across many addresses, and
 * per-identifier only lets one address walk a list of emails.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  prefix?: string;
}

export function createRateLimiter(redis: Redis, opts: RateLimitOptions): RateLimiter {
  const prefix = opts.prefix ?? 'cb:rl:';
  return {
    async hit(key) {
      const k = `${prefix}${key}`;
      // INCR then EXPIRE only on first hit: the window starts at the first
      // attempt and does not slide forward with each one, which is what makes
      // the ceiling real.
      const count = await redis.incr(k);
      if (count === 1) await redis.expire(k, opts.windowSeconds);
      const ttl = count === 1 ? opts.windowSeconds : Math.max(await redis.ttl(k), 0);
      return {
        allowed: count <= opts.limit,
        remaining: Math.max(0, opts.limit - count),
        retryAfterSeconds: ttl,
      };
    },
    async reset(key) { await redis.del(`${prefix}${key}`); },
  };
}

/** In-memory limiter, for unit tests and Redis-less development. */
export function createMemoryRateLimiter(opts: RateLimitOptions): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    async hit(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + opts.windowSeconds * 1000 });
        return { allowed: true, remaining: opts.limit - 1, retryAfterSeconds: opts.windowSeconds };
      }
      entry.count++;
      return {
        allowed: entry.count <= opts.limit,
        remaining: Math.max(0, opts.limit - entry.count),
        retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
      };
    },
    async reset(key) { hits.delete(key); },
  };
}

/** Never let an identifier into a Redis key raw. */
export const rateLimitKey = (...parts: string[]) =>
  parts.map((p) => p.toLowerCase().replace(/[^a-z0-9@._-]/g, '_').slice(0, 100)).join(':');
