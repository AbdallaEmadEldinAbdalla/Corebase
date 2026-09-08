import { createRedis, createQueue, createAuthEmailQueue } from '@steadhold/queue';

/**
 * Refuse to run the suite while anything else is consuming the queues.
 *
 * A worker connected to the same Redis eats the jobs these tests assert on, and
 * the failure surfaces as a queue bug in whichever file happened to run while it
 * was up — `expect(await queue.getWaitingCount()).toBe(20)` receiving 0, with
 * nothing in the diff to explain it.
 *
 * This check already existed, in `delivery.e2e.test.ts`, under a comment saying it
 * had cost debugging time twice. It then cost it twice more in
 * `email-loop.e2e.test.ts`, which never had it — because a guard was written where
 * the problem was noticed rather than everywhere the problem can occur. Eight
 * suites in this package touch a queue. So the check moves to `globalSetup`, which
 * runs once before any file and covers the ones nobody has written yet.
 *
 * It throws rather than warning: per D-223 a suite that needs infrastructure fails
 * instead of skipping, and this is the same principle one step earlier — an
 * environment that will produce meaningless results should stop the run, not
 * colour it.
 *
 * Unreachable Redis is *not* this check's business. Every suite already reports
 * that for itself with the connection error, and failing here would replace those
 * specific messages with one generic one.
 */
export default async function setup(): Promise<void> {
  const url = process.env.SH_REDIS_URL ?? 'redis://127.0.0.1:56379';
  const redis = createRedis(url);
  // ioredis emits `error` on every failed connection attempt, and an unhandled
  // one prints a stack per retry. A dead port is a *configured* state in the unit
  // lane, so it is expected here rather than exceptional.
  redis.on('error', () => {});

  // One try/finally around everything, because the disconnect has to happen on
  // every path. The first version returned early when the ping failed and left the
  // client connected: ioredis kept retrying on its own timers, the Node process
  // never ran out of handles, and **vitest never exited**. CI's unit lane points
  // SH_REDIS_URL at a dead port on purpose, so that lane hung until its
  // ten-minute timeout killed it — three runs in a row, reported as "cancelled",
  // with `node (vitest)` showing up in the runner's orphan-process cleanup.
  try {
    // **Bounded**, because `ping()` on a dead port does not reject — ioredis
    // queues commands while it is disconnected and retries on its own timers, so
    // the await simply never settles. Catching the rejection was the second
    // attempt at this and the catch never ran.
    if (!(await reachable(redis))) {
      // Unreachable Redis is not this check's business. Every suite reports it
      // itself, with the connection error and better detail than this could give.
      return;
    }

    const queues = [createQueue(redis), createAuthEmailQueue(redis)];
    const found: string[] = [];
    for (const q of queues) {
      const workers = await q.getWorkers();
      if (workers.length > 0) found.push(`${q.name} (${workers.length})`);
      await q.close();
    }
    if (found.length > 0) {
      throw new Error(
        'Something is already consuming these queues: ' + found.join(', ') + '.\n' +
        'Stop scripts/dev.sh (or a bench harness) first — a live worker eats the jobs\n' +
        'these tests assert on, and the failures will point at the queue rather than\n' +
        'at the second consumer.');
    }
  } finally {
    redis.disconnect();
  }
}

/**
 * Is Redis answering, within a second and a half?
 *
 * The timer is `unref`'d so it cannot be the thing keeping the process alive —
 * which is the whole class of bug this function exists to avoid.
 */
async function reachable(redis: ReturnType<typeof createRedis>): Promise<boolean> {
  return Promise.race([
    redis.ping().then(() => true, () => false),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 1500);
      t.unref();
    }),
  ]);
}
