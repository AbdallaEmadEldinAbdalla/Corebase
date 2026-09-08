import type { Pool } from 'pg';

/**
 * The data-plane traffic signal (P5a, D-236's first half).
 *
 * ## The gap this closes, which is not the one the tripwire was watching
 *
 * The idle scan pauses a project after seven days with no activity, and it decides
 * that from **database connections alone**. That was sufficient while there was no
 * data plane — a client connection was the only way to use a project — and D-236
 * put a tripwire on the per-project container count so that adding PostgREST would
 * fail loudly and force this to be built first.
 *
 * The auth module walked straight past it. It is a *shared multi-tenant process*,
 * not a per-project container, so nothing tripped when P4b started serving
 * `/auth/v1/*` per project — and its database connections open as `steadhold_auth`,
 * which the scan deliberately excludes along with every other internal role. So
 * since P4b, **a project whose users only sign up and log in has looked idle**, and
 * would be paused under them after a week. Worse, resume-on-request is Phase 5
 * work: nothing would have woken it, so those users would simply have stopped
 * being able to log in.
 *
 * The tripwire was right about the danger and watched the wrong door. It watched
 * for a new *container*; the data plane arrived as a new *process*.
 *
 * ## Why this writes the column the design already has
 *
 * `project_databases.last_active_at` already means "last known active" and the
 * scan already filters candidates on it. So the signal needs no new storage, no
 * new key space, and — this is the part worth noticing — **no change to the scan
 * at all**: a project touched by traffic simply stops being a candidate.
 *
 * It is Postgres rather than Redis on purpose, despite the hot path. Redis is a
 * delivery mechanism and never the truth (D-018), and the failure this would have
 * on a flush is the dangerous one: a lost timestamp reads as "idle", and a project
 * gets paused under its users. A throttled write to the row of record cannot fail
 * that way.
 */

/**
 * How often one project's row may be written, at most.
 *
 * The idle window is measured in **days**, so a minute of staleness is
 * arithmetically irrelevant to the decision and turns a per-request write into
 * roughly one write per project per minute of active use. Getting this wrong in
 * the cheap direction — writing every request — would put a control-plane UPDATE
 * on the hot path that D-051 exists to keep free of them.
 */
export const TRAFFIC_WRITE_INTERVAL_MS = Number(
  process.env['SH_TRAFFIC_WRITE_MS'] ?? 60_000);

/**
 * Bounds the in-process memo. One entry per project seen since this process
 * started; a busy fleet is thousands, not millions, and an unbounded map fed by an
 * unauthenticated endpoint is a leak with a public trigger.
 */
const MAX_TRACKED = 10_000;

export interface TrafficMeter {
  /** Never throws and never awaits the write — see `markActive`. */
  seen(projectId: string): void;
  /** Test seam: how many projects this process is currently remembering. */
  size(): number;
}

export function createTrafficMeter(pool: Pool, opts: {
  intervalMs?: number | undefined;
  onError?: ((err: Error) => void) | undefined;
} = {}): TrafficMeter {
  const interval = opts.intervalMs ?? TRAFFIC_WRITE_INTERVAL_MS;
  const lastWritten = new Map<string, number>();

  return {
    seen(projectId: string): void {
      const now = Date.now();
      const previous = lastWritten.get(projectId);
      if (previous !== undefined && now - previous < interval) return;

      // Recorded *before* the write, not after. Two concurrent requests would
      // otherwise both see a stale entry and both write — and the whole point of
      // the memo is that a burst of traffic costs one UPDATE, not one per
      // request.
      lastWritten.set(projectId, now);
      if (lastWritten.size > MAX_TRACKED) {
        // Oldest first. `Map` preserves insertion order, and re-inserting on
        // every write keeps that order meaningful.
        for (const key of lastWritten.keys()) {
          lastWritten.delete(key);
          if (lastWritten.size <= MAX_TRACKED) break;
        }
      }

      // Deliberately not awaited. This is a *hint* on the request path: a request
      // must not get slower, and must certainly not fail, because a bookkeeping
      // UPDATE was slow. Losing one write costs at most `interval` of accuracy
      // against a window measured in days.
      void pool.query(
        `UPDATE project_databases SET last_active_at = now() WHERE project_id = $1`,
        [projectId],
      ).catch((err: Error) => {
        // Let the memo go, so the next request retries rather than waiting out
        // the interval on a write that never happened.
        lastWritten.delete(projectId);
        opts.onError?.(err);
      });
    },
    size: () => lastWritten.size,
  };
}
