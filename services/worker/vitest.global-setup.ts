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
  try {
    await redis.ping();
  } catch {
    return; // not our problem — the suites say so with better detail
  }

  try {
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
