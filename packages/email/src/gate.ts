import { createHash } from 'node:crypto';
import type { EmailCaps } from './caps.ts';

/**
 * The check every owed email passes before it becomes a queued job (D-116,
 * §bounces step 4: global suppression → project suppression → caps → send).
 *
 * ## The order is the specification
 *
 * Suppression before caps, and both before the queue. Checking caps first would
 * let a mail-bomb against a suppressed address consume the project's whole hourly
 * budget without a single message being sent — the attacker gets to deny the
 * project its real mail for free. And checking at *enqueue* rather than at send
 * means a burst is refused while it is still one Redis round trip, instead of
 * filling a queue whose drain rate is the thing being protected.
 */

/** The Redis surface this needs. Narrow on purpose — it is trivially fakeable. */
export interface CounterStore {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  pfadd(key: string, value: string): Promise<number>;
  pfcount(key: string): Promise<number>;
  decr(key: string): Promise<number>;
}

export type GateVerdict =
  | { allowed: true }
  /**
   * `suppressed` and `rate_limited` are separate because they mean opposite
   * things to a developer: the first is "this address is bad, fix your data" and
   * the second is "you are sending too much, slow down or upgrade". Collapsing
   * them into "not sent" is what makes the dashboard useless.
   */
  | { allowed: false; reason: 'suppressed'; scope: 'global' | 'project' }
  | { allowed: false; reason: 'rate_limited'; cap: keyof EmailCaps };

/**
 * A recipient's address, hashed, for use in a counter key.
 *
 * Two reasons, and the second is the real one. Keys are bounded in length
 * regardless of the address — but more importantly, Redis keys turn up in
 * `MONITOR` output, in slowlogs, in memory dumps and in any operator's
 * `--scan`, and a per-recipient counter keyed on the plaintext puts every
 * end-user's email address of every project on the platform into all of them.
 */
const rcpt = (email: string) =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('base64url').slice(0, 22);

/** UTC hour and day buckets. Fixed windows, for the reason in kernel/rate-limit.ts. */
function windows(now = new Date()) {
  const iso = now.toISOString();
  return { hour: iso.slice(0, 13), day: iso.slice(0, 10) };
}

const HOUR = 3600;
const DAY = 86_400;
// Two days, not one. A key created at 23:59 with a one-day TTL expires 24 hours
// later while its bucket name is already stale, which is harmless — but a
// HyperLogLog for the distinct-recipient count must outlive the day it names or
// the count resets mid-day when the key is touched again after expiry.
const DAY_TTL = 2 * DAY;

export interface GateArgs {
  projectId: string;
  recipient: string;
  caps: EmailCaps;
  /** Both lists, resolved by the caller in one query. */
  suppression: { global: boolean; project: boolean };
  now?: Date | undefined;
}

/**
 * Consume a send from the project's budget, or say why not.
 *
 * ## Why the counters are incremented and then rolled back
 *
 * Every check is `INCR` first and compare after, which is what makes the whole
 * thing atomic against concurrent enqueues — a `GET`-then-`INCR` lets two callers
 * both read 29 against a cap of 30 and both proceed. When a later cap in the
 * sequence refuses, the earlier increments are decremented back.
 *
 * That rollback is not perfectly atomic, and it does not need to be: an
 * interrupted rollback leaves a project's counter a few sends high for the rest of
 * the window, which under-sends slightly. The opposite arrangement — check
 * without reserving — over-sends under exactly the load that means an attack.
 */
export async function checkAndConsume(
  redis: CounterStore, a: GateArgs,
): Promise<GateVerdict> {
  if (a.suppression.global) return { allowed: false, reason: 'suppressed', scope: 'global' };
  if (a.suppression.project) return { allowed: false, reason: 'suppressed', scope: 'project' };

  const { hour, day } = windows(a.now);
  const r = rcpt(a.recipient);
  const p = `sh:mail:${a.projectId}`;
  const spent: string[] = [];

  const bump = async (key: string, ttl: number, limit: number, cap: keyof EmailCaps) => {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttl);
    spent.push(key);
    return n > limit ? cap : undefined;
  };

  // Tightest first. A mail-bomb at one address should be refused by the
  // per-recipient cap without touching the project's hourly budget — otherwise
  // the attack succeeds at denying the project its legitimate mail even while
  // being blocked from sending.
  const over =
    await bump(`${p}:r:${r}:h:${hour}`, HOUR, a.caps.perRecipientPerHour, 'perRecipientPerHour')
    ?? await bump(`${p}:r:${r}:d:${day}`, DAY_TTL, a.caps.perRecipientPerDay, 'perRecipientPerDay')
    ?? await bump(`${p}:h:${hour}`, HOUR, a.caps.perHour, 'perHour')
    ?? await bump(`${p}:d:${day}`, DAY_TTL, a.caps.perDay, 'perDay');

  if (over) {
    for (const key of spent) await redis.decr(key).catch(() => undefined);
    return { allowed: false, reason: 'rate_limited', cap: over };
  }

  // Distinct recipients, as a HyperLogLog: the exact set for a Team project is
  // 5,000 addresses per day per project held in Redis, and the question being
  // asked ("is this project mailing an implausible number of different people")
  // does not need an exact answer. `PFADD` returns 1 only when the estimate
  // changed, so a repeat recipient is free.
  const hll = `${p}:rcpts:${day}`;
  const added = await redis.pfadd(hll, r);
  if (added === 1) {
    await redis.expire(hll, DAY_TTL);
    const distinct = await redis.pfcount(hll);
    if (distinct > a.caps.distinctRecipientsPerDay) {
      for (const key of spent) await redis.decr(key).catch(() => undefined);
      // The recipient stays in the set. Removing them is impossible in a
      // HyperLogLog anyway, and it is the correct behaviour: the project *did*
      // try to reach a new address, and the count is of attempts to broaden.
      return { allowed: false, reason: 'rate_limited', cap: 'distinctRecipientsPerDay' };
    }
  }
  return { allowed: true };
}
