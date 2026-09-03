import { describe, it, expect } from 'vitest';
import { checkAndConsume, type CounterStore } from './gate.ts';
import { capsFor, CAPS } from './caps.ts';

/**
 * P4d — the enqueue gate (D-116).
 *
 * What these caps defend is not our bill: `/signup` and `/recover` let any
 * anonymous visitor make Corebase email an arbitrary address, and V1 sends every
 * project's mail from one domain — so one free project can mail-bomb a victim or
 * act as a bulk mailer, and the reputation damage lands on every project.
 */

/** A Redis stand-in. Exact rather than probabilistic, which is fine: what is
 *  under test is the ordering and the arithmetic, not HyperLogLog's error bound. */
function fakeRedis(): CounterStore & { keys: Map<string, number>; sets: Map<string, Set<string>>; ttls: Map<string, number> } {
  const keys = new Map<string, number>();
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();
  return {
    keys, sets, ttls,
    async incr(k) { const n = (keys.get(k) ?? 0) + 1; keys.set(k, n); return n; },
    async decr(k) { const n = (keys.get(k) ?? 0) - 1; keys.set(k, n); return n; },
    async expire(k, s) { ttls.set(k, s); return 1; },
    async pfadd(k, v) {
      const set = sets.get(k) ?? new Set(); const had = set.has(v);
      set.add(v); sets.set(k, set); return had ? 0 : 1;
    },
    async pfcount(k) { return sets.get(k)?.size ?? 0; },
  };
}

const args = (over: Partial<Parameters<typeof checkAndConsume>[1]> = {}) => ({
  projectId: 'p1', recipient: 'user@example.com',
  caps: CAPS['free']!, suppression: { global: false, project: false },
  ...over,
});

describe('P4d — suppression is checked before caps', () => {
  it('refuses a globally suppressed address and spends nothing', async () => {
    const redis = fakeRedis();
    const v = await checkAndConsume(redis, args({ suppression: { global: true, project: false } }));
    expect(v).toEqual({ allowed: false, reason: 'suppressed', scope: 'global' });
    // The ordering matters: if caps were checked first, a mail-bomb against a
    // suppressed address would consume the project's whole hourly budget without
    // one message being sent — the attack succeeds at denying the project its
    // real mail even while being blocked.
    expect(redis.keys.size).toBe(0);
  });

  it('distinguishes a project suppression from a global one', async () => {
    const v = await checkAndConsume(fakeRedis(),
      args({ suppression: { global: false, project: true } }));
    expect(v).toEqual({ allowed: false, reason: 'suppressed', scope: 'project' });
  });

  it('reports the global list when an address is on both', async () => {
    // Global first, because it is the stronger statement: the address is a trap
    // or dead, and no project's wish to retry it outranks the shared domain.
    const v = await checkAndConsume(fakeRedis(),
      args({ suppression: { global: true, project: true } }));
    expect(v).toMatchObject({ scope: 'global' });
  });
});

describe('P4d — caps', () => {
  it('allows up to the per-recipient hourly cap and then refuses', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 4; i++) {
      expect(await checkAndConsume(redis, args())).toEqual({ allowed: true });
    }
    expect(await checkAndConsume(redis, args()))
      .toEqual({ allowed: false, reason: 'rate_limited', cap: 'perRecipientPerHour' });
  });

  it('rolls back the counters it spent when a later cap refuses', async () => {
    const redis = fakeRedis();
    const caps = { ...CAPS['free']!, perRecipientPerHour: 1 };
    await checkAndConsume(redis, args({ caps }));
    const before = redis.keys.get('cb:mail:p1:h:' + new Date().toISOString().slice(0, 13));
    await checkAndConsume(redis, args({ caps }));
    // The refused attempt must not have consumed the project's hourly budget.
    // Increment-then-compare is what makes the check atomic against concurrent
    // enqueues; the rollback is what stops a refusal costing anything.
    expect(redis.keys.get('cb:mail:p1:h:' + new Date().toISOString().slice(0, 13)))
      .toBe(before);
  });

  it('refuses on the project hourly cap independently of the recipient', async () => {
    const redis = fakeRedis();
    const caps = { ...CAPS['free']!, perHour: 3, perRecipientPerHour: 99 };
    for (let i = 0; i < 3; i++) {
      expect(await checkAndConsume(redis, args({ caps, recipient: `u${i}@example.com` })))
        .toEqual({ allowed: true });
    }
    expect(await checkAndConsume(redis, args({ caps, recipient: 'u9@example.com' })))
      .toEqual({ allowed: false, reason: 'rate_limited', cap: 'perHour' });
  });

  it('counts distinct recipients, and a repeat recipient is free', async () => {
    const redis = fakeRedis();
    const caps = { ...CAPS['free']!, distinctRecipientsPerDay: 2, perRecipientPerHour: 99 };
    expect(await checkAndConsume(redis, args({ caps, recipient: 'a@x.test' }))).toEqual({ allowed: true });
    expect(await checkAndConsume(redis, args({ caps, recipient: 'b@x.test' }))).toEqual({ allowed: true });
    // Already counted, so it does not consume a new slot — the cap is on
    // breadth, which is the bulk-mailer signal, not on volume.
    expect(await checkAndConsume(redis, args({ caps, recipient: 'a@x.test' }))).toEqual({ allowed: true });
    expect(await checkAndConsume(redis, args({ caps, recipient: 'c@x.test' })))
      .toEqual({ allowed: false, reason: 'rate_limited', cap: 'distinctRecipientsPerDay' });
  });

  it('keys the per-recipient counter on a hash, not the address', async () => {
    const redis = fakeRedis();
    await checkAndConsume(redis, args({ recipient: 'private@example.com' }));
    // Redis keys turn up in MONITOR output, slowlogs, memory dumps and any
    // operator's --scan. A plaintext key would put every end-user's address of
    // every project on the platform into all of them.
    for (const key of redis.keys.keys()) expect(key).not.toContain('private@example.com');
    expect([...redis.keys.keys()].some((k) => k.includes(':r:'))).toBe(true);
  });

  it('treats addresses case- and whitespace-insensitively', async () => {
    const redis = fakeRedis();
    const caps = { ...CAPS['free']!, perRecipientPerHour: 1 };
    expect(await checkAndConsume(redis, args({ caps, recipient: 'User@Example.com' })))
      .toEqual({ allowed: true });
    // Otherwise the per-recipient cap is bypassed by varying the capitalisation,
    // which is a one-line attack.
    expect(await checkAndConsume(redis, args({ caps, recipient: ' user@example.com ' })))
      .toMatchObject({ reason: 'rate_limited' });
  });

  it('sets a TTL on every key it creates', async () => {
    const redis = fakeRedis();
    await checkAndConsume(redis, args());
    // A counter with no expiry is a memory leak keyed by project and hour, which
    // grows for as long as the platform runs.
    for (const key of redis.keys.keys()) expect(redis.ttls.get(key)).toBeGreaterThan(0);
    expect(redis.ttls.size).toBe(redis.keys.size + 1);   // + the HLL
  });
});

describe('P4d — capsFor', () => {
  it('halves volume caps for a Free project under a day old, but not the per-recipient floor',
    () => {
      const young = capsFor('free', 3600_000);
      expect(young.perHour).toBe(15);
      expect(young.perDay).toBe(100);
      // 4/hour to one address is already what a real person needs in their first
      // five minutes: sign up, mistype, resend, reset. Halving it to 2 makes a
      // legitimate signup hit the cap.
      expect(young.perRecipientPerHour).toBe(4);
    });

  it('does not throttle a Free project once it is a day old', () => {
    expect(capsFor('free', 25 * 3600_000)).toEqual(CAPS['free']);
    expect(capsFor('free')).toEqual(CAPS['free']);
  });

  it('does not apply the new-project throttle to paid plans', () => {
    expect(capsFor('pro', 60_000)).toEqual(CAPS['pro']);
  });

  it('falls back to Free\'s caps for an unknown plan, never to no caps', () => {
    // Fail-closed: an unmatched plan name is a bug, and the version of that bug
    // where a project sends without limit is the one that costs a sending domain.
    expect(capsFor('enterprise-custom')).toEqual(CAPS['free']);
  });
});
