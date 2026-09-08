import type { Redis } from '@steadhold/queue';

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
      // One round-trip, three commands.
      //
      // The previous version issued INCR and then TTL as separate awaits, so
      // every check cost two round-trips — and the gateway makes three checks per
      // request (D-033's layers), which is **six sequential round-trips on the
      // hot path**. P5f measured them at 2.06 ms of a 6.5 ms gateway overhead
      // against a budget of ~1.5 ms; the request-pipeline doc says these are
      // pipelined, and it was right to.
      //
      // `EXPIRE ... NX` is what makes one round-trip possible while keeping the
      // semantics: the window starts at the first attempt and does not slide
      // forward with each one, which is what makes the ceiling real. Setting it
      // unconditionally would restart the window on every hit and the limit would
      // never be reached. Redis 7.0+.
      const res = await redis.multi()
        .incr(k)
        .expire(k, opts.windowSeconds, 'NX')
        .ttl(k)
        .exec();
      // `exec` returns [err, value] pairs, or null if the transaction was
      // discarded. Treating a failure as "allowed" is deliberate: a limiter that
      // fails closed turns a Redis blip into an outage for every project at once,
      // which is a far worse failure than briefly not limiting.
      const count = Number(res?.[0]?.[1] ?? 0);
      const ttlRaw = Number(res?.[2]?.[1] ?? opts.windowSeconds);
      if (!count) {
        return { allowed: true, remaining: opts.limit, retryAfterSeconds: opts.windowSeconds };
      }
      return {
        allowed: count <= opts.limit,
        remaining: Math.max(0, opts.limit - count),
        // A key with no expiry reads as -1; a missing key as -2. Neither is a
        // sensible Retry-After, so the window is the floor.
        retryAfterSeconds: ttlRaw > 0 ? ttlRaw : opts.windowSeconds,
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
