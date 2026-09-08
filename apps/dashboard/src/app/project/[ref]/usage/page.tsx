'use client';

import { use } from 'react';
import { useProject, useProjectUsage } from '../../../../lib/queries.ts';
import { formatBytes, fraction, formatAgo } from '../../../../lib/format-usage.ts';
import { ErrorSurface } from '../../../../components/ErrorSurface.tsx';
import { ApiError } from '../../../../lib/api.ts';

/**
 * What this project is using.
 *
 * Every figure comes from a column the control plane already maintains, and the
 * page is built around the fact that they are **samples, not readings**: a sweep
 * measures disk every few minutes, so each number carries when it was taken. A
 * usage page without that line invites the reader to treat a ten-minute-old
 * figure as live, and then to distrust the whole page when it lags.
 *
 * Three things are deliberately absent, and the page says so rather than leaving
 * a gap that looks broken:
 *
 *  - **CPU, memory consumption, connections and request rate.** Nothing collects
 *    them. The IA's `/metrics` is a separate, unbuilt surface, and inventing a
 *    figure here would be the exact failure gate question 19 exists for.
 *  - **Object-storage bytes.** `storage.usage` lives inside the project's own
 *    database, so reading it needs a live connection and a credential this path
 *    does not carry — and it would be null exactly when a project is paused,
 *    which is when usage is most worth looking at.
 *  - **When a free project will pause.** The idle window is deployment
 *    configuration the API does not publish, so the page shows the last activity
 *    it has and does not compute a date from a number it guessed.
 *
 * `memory` is labelled "Reserved" throughout. The platform books RAM per project
 * for placement; it does not measure a container's resident set. Naming that
 * "memory used" would be a false number, so it is named for what it is.
 */
export default function ProjectUsagePage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const project = useProject(ref);
  const usage = useProjectUsage(ref);

  const u = usage.data?.usage;

  if (project.isPending || usage.isPending) {
    return (
      <div className="wrap wrap--narrow">
        <Head />
        {/* Four sections, in the order they arrive, because a two-section
            skeleton resolving into four makes the page jump — and the first
            card carries the headline figure and its bar while the rest are
            fact rows, so they are drawn differently (Q16). */}
        {[
          { label: 'Database disk', rows: 2, headline: true },
          { label: 'Backups', rows: 3, headline: false },
          { label: 'WAL archiving', rows: 5, headline: false },
          { label: 'Activity', rows: 1, headline: false },
        ].map(({ label, rows, headline }) => (
          <section className="section" key={label}>
            <div className="section__head"><h2 className="section__title">{label}</h2></div>
            <div className="card"><div className="card__body" aria-busy="true">
              {headline ? (
                <>
                  <div className="sh-skeleton" style={{ width: 190, height: 32 }} />
                  <div className="sh-skeleton" style={{ width: 280, height: 6, marginTop: 14 }} />
                </>
              ) : null}
              <div className="facts" style={{ marginTop: headline ? 'var(--sh-space-20)' : 0 }}>
                {Array.from({ length: rows * 2 }, (_, i) => (
                  <div className="sh-skeleton" key={i}
                    style={{ height: 16, width: i % 2 ? '60%' : 110 }} />
                ))}
              </div>
            </div></div>
          </section>
        ))}
      </div>
    );
  }

  /**
   * The 409 is not an error state, it is the answer: a project still being
   * created has no database, so there is nothing to measure. Saying that is
   * better than an empty page or a row of zeroes, and it is why the hook does
   * not retry it.
   */
  if (usage.error instanceof ApiError && usage.error.status === 409) {
    return (
      <div className="wrap wrap--narrow">
        <Head />
        <div className="emptywrap"><div className="sh-empty">
          <div className="sh-empty__title">Nothing to measure yet</div>
          <div className="sh-empty__text">{usage.error.message}</div>
        </div></div>
      </div>
    );
  }

  if (usage.error || !u) {
    return (
      <div className="wrap wrap--narrow">
        <Head />
        <ErrorSurface error={usage.error} title="Usage could not be loaded" />
      </div>
    );
  }

  const diskFraction = fraction(u.disk.used_bytes, u.disk.limit_bytes);

  return (
    <div className="wrap wrap--narrow">
      <Head />

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Database disk</h2>
          <p className="section__note">
            Measured by a sweep, not on request — {formatAgo(u.disk.checked_at)}.
          </p>
        </div>
        <div className="card">
          <div className="card__body">
            <div style={{ font: '600 24px/32px var(--sh-font-ui)', letterSpacing: '-0.4px' }}>
              {formatBytes(u.disk.used_bytes)}
              <span style={{ font: 'var(--sh-body-m)', color: 'var(--sh-text-secondary)' }}>
                {' '}of {formatBytes(u.disk.limit_bytes)}
              </span>
            </div>
            {/* No bar when there is no measurement: a bar at zero and a bar for
                an unmeasured project look identical and mean opposite things. */}
            {diskFraction !== null ? (
              <div className="sh-progress" style={{ marginTop: 'var(--sh-space-12)' }}
                role="meter" aria-label="Database disk used"
                aria-valuemin={0} aria-valuemax={u.disk.limit_bytes}
                aria-valuenow={u.disk.used_bytes ?? 0}
                aria-valuetext={`${formatBytes(u.disk.used_bytes)} of ${formatBytes(u.disk.limit_bytes)}`}>
                <div className="sh-progress__fill" style={{ width: `${diskFraction * 100}%` }} />
              </div>
            ) : null}
            <dl className="facts" style={{ marginTop: 'var(--sh-space-20)' }}>
              <dt className="facts__k">State</dt>
              <dd className="facts__v">
                {/* `disk_state` is NOT NULL DEFAULT 'ok', so a project nobody has
                    swept yet reports "ok" — a schema default wearing the clothes
                    of an assessment. `disk_checked_at` is what distinguishes them,
                    and it is null here, so the page says so instead. */}
                {u.disk.checked_at === null
                  ? <State value="unknown" label="Not measured yet" />
                  : <State value={u.disk.state} />}
              </dd>
              <dt className="facts__k">Reserved memory</dt>
              <dd className="facts__v">
                {formatBytes(u.memory.booked_bytes)} booked of a{' '}
                {formatBytes(u.memory.limit_bytes)} cap
              </dd>
            </dl>
          </div>
          <div className="card__foot">
            <span>
              Reserved memory is what the platform books for placement. It is not a
              measurement of what the database is using — nothing collects that yet.
            </span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Backups</h2>
          <p className="section__note">Last verified {formatAgo(u.backups.checked_at)}.</p>
        </div>
        <div className="card">
          <div className="card__body">
            <dl className="facts">
              <dt className="facts__k">Last successful</dt>
              <dd className="facts__v">
                {u.backups.last_success_at
                  ? <>{formatBytes(u.backups.last_success_bytes)}, {formatAgo(u.backups.last_success_at)}</>
                  : 'None yet'}
              </dd>
              <dt className="facts__k">Successful runs</dt>
              <dd className="facts__v">{u.backups.successful_runs}</dd>
              <dt className="facts__k">Verification</dt>
              <dd className="facts__v">
                {u.backups.check_ok === null
                  ? 'Not checked yet'
                  : <State value={u.backups.check_ok ? 'ok' : 'critical'}
                           label={u.backups.check_ok ? 'Passing' : 'Failing'} />}
              </dd>
            </dl>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">WAL archiving</h2>
          <p className="section__note">
            Every write ships to the backup repository; a lag here is a gap in
            point-in-time recovery.
          </p>
        </div>
        <div className="card">
          <div className="card__body">
            <dl className="facts">
              <dt className="facts__k">State</dt>
              <dd className="facts__v"><State value={u.archiving.state} /></dd>
              <dt className="facts__k">Lag</dt>
              <dd className="facts__v">
                {u.archiving.lag_seconds === null
                  ? '—'
                  : `${u.archiving.lag_seconds} s`}
              </dd>
              <dt className="facts__k">Pending segments</dt>
              <dd className="facts__v">{u.archiving.pending_segments ?? '—'}</dd>
              <dt className="facts__k">Last archived</dt>
              <dd className="facts__v">{formatAgo(u.archiving.last_archived_at)}</dd>
              <dt className="facts__k">Failures, all time</dt>
              <dd className="facts__v">{u.archiving.failed_count}</dd>
            </dl>
          </div>
          {u.archiving.failed_count > 0 ? (
            <div className="card__foot">
              <span>
                A non-zero lifetime failure count is normal — a segment that failed
                once and was retried counts here forever. The state above is what
                describes archiving <strong>now</strong>.
              </span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Activity</h2>
        </div>
        <div className="card">
          <div className="card__body">
            <dl className="facts">
              <dt className="facts__k">Last active</dt>
              <dd className="facts__v">{formatAgo(u.activity.last_active_at)}</dd>
            </dl>
          </div>
          {project.data?.project.plan === 'free' ? (
            <div className="card__foot">
              <span>
                Free projects pause after a period of inactivity. How long is set by
                this deployment and is not published, so this page shows the last
                activity rather than a countdown it would have to guess.
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Head() {
  return (
    <div className="head">
      <div>
        <h1 className="head__title">Usage</h1>
        <p className="head__sub">
          What this project is using, and when each figure was measured.
        </p>
      </div>
    </div>
  );
}

/**
 * The ladders (`disk_state`, `archive_state`) rendered as a status rather than a
 * bare word, because "warn" as plain text is a value and not a signal.
 */
function State({ value, label }: { value: string; label?: string }) {
  const tone = value === 'ok' ? 'success'
    : value === 'unknown' ? 'muted'
    : 'error';
  return (
    <span className="sh-status">
      <span className={`sh-status__dot sh-status__dot--${tone}`} />
      {label ?? value.replace(/_/g, ' ')}
    </span>
  );
}
