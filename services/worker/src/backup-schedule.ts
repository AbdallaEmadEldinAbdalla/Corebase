import { createHash } from 'node:crypto';
import { scheduleFor } from './backup.ts';

/**
 * When a project is due a base backup (P3c, backups §2).
 *
 * Pure, because this is where the plan matrix lives and a matrix is worth testing
 * without a database, a clock, or a node. Everything stateful — finding the
 * candidates, enqueueing the job, recording the outcome — is in `backup-scan.ts`.
 *
 * Scheduling is a **control-plane** decision per project (D-018), not per-node
 * cron. Only the control plane can jitter across the whole fleet, knows a
 * project's plan, and knows which projects are paused — and a paused project must
 * not be backed up, because it has no running Postgres to back up and its final
 * backup is already pinned (D-077).
 */

/** The nightly maintenance window, local to the region (backups §2: 03:00–06:00). */
export interface Window { startHour: number; endHour: number }
export const WINDOW: Window = { startHour: 3, endHour: 6 };

export type BackupType = 'full' | 'incr';

export interface DueInput {
  projectId: string;
  plan: string;
  now: Date;
  /** Last *successful* full, or undefined if there has never been one. */
  lastFullAt?: Date | undefined;
  /** Last successful backup of any type. */
  lastAnyAt?: Date | undefined;
  /**
   * Window override. Tests set `{ startHour: 0, endHour: 24 }` to take the clock
   * out of the question; production never sets it.
   */
  window?: Window;
}

export interface DueResult {
  type: BackupType | undefined;
  /** Why, in words, so a skipped project is explicable from one log line. */
  reason: string;
}

/**
 * A stable per-project offset inside the window, in minutes.
 *
 * Derived from the project id rather than random, so a project keeps the same slot
 * across worker restarts. Random would re-roll every sweep and give a project many
 * chances per night to be "in its slot", which turns a jitter into a lottery that
 * eventually fires every night at a different time — the opposite of a schedule.
 *
 * The point of the offset is that a fleet does not start every backup at 03:00:
 * a node with 150 projects would try to read 150 databases at once, and the
 * bandwidth to the repo is shared.
 */
export function slotMinuteFor(projectId: string, windowMinutes: number): number {
  const h = createHash('sha256').update(projectId).digest();
  return ((h[0]! << 8) | h[1]!) % Math.max(1, windowMinutes);
}

/** Is `now` inside the project's own slot within the maintenance window? */
export function inSlot(
  projectId: string, now: Date, window: Window = WINDOW, slotWidthMinutes = 30,
): boolean {
  const hour = now.getHours();
  if (window.startHour === 0 && window.endHour === 24) return true;
  if (hour < window.startHour || hour >= window.endHour) return false;
  const windowMinutes = (window.endHour - window.startHour) * 60;
  const minuteOfWindow = (hour - window.startHour) * 60 + now.getMinutes();
  const slot = slotMinuteFor(projectId, windowMinutes);
  // A slot is a span, not an instant: the sweep runs every few minutes, so an
  // instant would be missed on most nights and hit on none reliably.
  return minuteOfWindow >= slot && minuteOfWindow < slot + slotWidthMinutes;
}

const days = (ms: number) => ms / 86_400_000;

/**
 * What backup this project needs right now, if any.
 *
 * A never-backed-up project is due immediately and outside the window, and that
 * exception is the important one: a project created at 09:00 would otherwise have
 * no base backup at all until the following night, and "we lost a beta user's
 * data" is a sentence about the first eighteen hours far more often than about the
 * eighteenth day.
 */
export function decideBackup(a: DueInput): DueResult {
  const sched = scheduleFor(a.plan);
  const window = a.window ?? WINDOW;

  if (!a.lastFullAt) {
    return { type: 'full', reason: 'no full backup has ever succeeded for this project' };
  }

  const fullAgeDays = days(a.now.getTime() - a.lastFullAt.getTime());
  const anyAgeDays = a.lastAnyAt
    ? days(a.now.getTime() - a.lastAnyAt.getTime())
    : fullAgeDays;

  // Past due by a wide margin ⇒ ignore the window. The window exists to spread
  // load at night, not to delay a backup that is already late: a project whose
  // full is two days overdue on a nightly plan has lost a day of its PITR window
  // and waiting for 03:00 loses more.
  const fullOverdue = fullAgeDays >= sched.fullEveryDays * 2;
  if (fullOverdue) {
    return { type: 'full',
      reason: `last full is ${fullAgeDays.toFixed(1)}d old, over twice the ` +
        `${sched.fullEveryDays}d interval — taking it outside the window` };
  }

  if (!inSlot(a.projectId, a.now, window)) {
    return { type: undefined, reason: 'outside this project\'s slot in the maintenance window' };
  }

  if (fullAgeDays >= sched.fullEveryDays) {
    return { type: 'full', reason: `last full is ${fullAgeDays.toFixed(1)}d old` };
  }

  // Incrementals only where the plan has them. On Free there is nothing between
  // nightly fulls by design: at a ≤500 MB cap a full is trivial and a one-link
  // chain has no middle link to be broken.
  if (sched.incrEveryDays > 0 && anyAgeDays >= sched.incrEveryDays) {
    return { type: 'incr', reason: `last backup is ${anyAgeDays.toFixed(1)}d old` };
  }

  return { type: undefined, reason: 'up to date' };
}
