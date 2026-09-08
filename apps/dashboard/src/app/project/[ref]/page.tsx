'use client';

import Link from 'next/link';
import { use } from 'react';
import { ErrorSurface } from '../../../components/ErrorSurface.tsx';
import { ProjectStateBadge, SETTLING } from '../../../components/ProjectState.tsx';
import { useProject } from '../../../lib/queries.ts';

/**
 * Project overview.
 *
 * The job of this page is to answer "is it up, and how do I use it" in one screen
 * without scrolling, then get out of the way. What it shows is only what the
 * control plane actually knows (D-222): state, region, plan, Postgres version,
 * host, the recovery deadline when soft-deleted, and one connection string with a
 * copy button — because the single most common reason to open a project is to get
 * that string.
 *
 * The IA's health row and 24-hour sparklines are absent, and the page says so in a
 * sentence rather than leaving a gap that looks broken. Health needs PostgREST,
 * Auth and Storage to exist; the sparklines need a metrics path that OQ-149 has
 * not chosen.
 */
export default function OverviewPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const q = useProject(ref);
  const p = q.data?.project;
  const db = q.data?.database;
  const settling = Boolean(p && SETTLING.has(p.status));
  // Deliberately not the connection strings: this page polls, and revealing
  // credentials is audited (see the project detail route). Connect reveals.

  return (
    <div className="wrap">
      <div className="head">
        <div>
          <h1 className="head__title">{p?.name ?? ref}</h1>
          <p className="head__sub">
            <span className="mono">{ref}</span>
            {p ? <> · {p.region} · {p.plan} plan</> : null}
          </p>
        </div>
        <div className="head__actions">
          {p ? <ProjectStateBadge status={p.status} /> : null}
        </div>
      </div>

      {q.error ? <ErrorSurface error={q.error} onRetry={() => void q.refetch()} /> : null}

      {/* In progress renders as progress, never as an error (§6). */}
      {settling ? (
        <div className="sh-banner sh-banner--info" role="status" style={{ marginBottom: 'var(--sh-space-20)' }}>
          <span className="sh-banner__icon" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M6 2v4l3 2" /></svg>
          </span>
          <div className="sh-banner__body">
            <div className="sh-banner__title">
              {p?.status === 'resuming' ? 'Resuming this project'
                : p?.status === 'deleting' ? 'Deleting this project'
                : p?.status === 'restoring' ? 'Restoring to a point in time'
                : 'Setting up your database'}
            </div>
            <div className="sh-banner__text">
              {p?.status === 'restoring'
                // A restore is not a create, and the create copy is actively
                // alarming here: someone recovering data does not want to read
                // "setting up your database" over the top of it.
                ? 'Replaying write-ahead log to your target time. This can take '
                  + 'longer than a create — the page updates itself.'
                : 'Usually a few seconds. This page updates itself — there is no need to reload.'}
            </div>
            {/* Indeterminate, because nothing here knows a percentage. The bar was
                a fixed 55% fill, which is a number on screen that is not real
                (§8 Q19) and reads as stuck rather than as working. */}
            <div className="sh-progress sh-progress--indeterminate"
                 style={{ marginTop: 'var(--sh-space-12)' }}>
              <div className="sh-progress__fill" />
            </div>
          </div>
        </div>
      ) : null}

      {p?.status === 'failed' ? (
        <div className="sh-banner sh-banner--error" role="alert" style={{ marginBottom: 'var(--sh-space-20)' }}>
          <span className="sh-banner__icon" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M2 2 10 10M10 2 2 10" /></svg>
          </span>
          <div className="sh-banner__body">
            <div className="sh-banner__title">Provisioning failed</div>
            <div className="sh-banner__text">
              Nothing was charged. The control plane retries on its own; if it stays failed,
              quote <code className="mono">{ref}</code> to support.
            </div>
          </div>
        </div>
      ) : null}

      {/* A restored copy has to say what it is. The badge says "RESTORED COPY" and
          that is not enough on its own: the risk of this state is someone reading
          it as "restored, so we're fine" and pointing an application at it while
          the original is still serving — two live databases and nothing that can
          reconcile them afterwards. */}
      {p?.status === 'restored' ? (
        <div className="sh-banner sh-banner--warning" role="status" style={{ marginBottom: 'var(--sh-space-20)' }}>
          <span className="sh-banner__icon" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M6 2v5M6 9v1" /></svg>
          </span>
          <div className="sh-banner__body">
            <div className="sh-banner__title">This is a restored copy, not your live project</div>
            <div className="sh-banner__text">
              It holds your data as of{' '}
              {q.data?.restore?.target_time
                ? new Date(q.data.restore.target_time).toLocaleString()
                : 'the latest point available'}
              , and it is serving no application traffic. Your original project{' '}
              <code className="mono">{q.data?.restore?.source_ref ?? ''}</code> is
              untouched and still live. Connect to this copy to check the data is what
              you expected — switching your application over is a separate, explicit
              step, and it is not built yet.
            </div>
            {/* The deadline, stated. A copy holds a second dataset and a second
                booking while serving nothing, so it does not live forever — and a
                deadline the customer cannot read is a deadline they cannot act on,
                which is the same rule the soft-delete banner follows. The second
                window is said out loud too: expiry is not destruction. */}
            {q.data?.restore?.expires_at ? (
              <div className="sh-banner__text" style={{ marginTop: 'var(--sh-space-8)' }}>
                <strong>This copy is removed on{' '}
                  {new Date(q.data.restore.expires_at).toLocaleString()}</strong>{' '}
                — its data then stays recoverable for the usual window, so an expiry
                you did not want is not a loss you cannot undo.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {p?.deleted_at || p?.status === 'soft_deleted' ? (
        <div className="sh-banner sh-banner--warning" role="status" style={{ marginBottom: 'var(--sh-space-20)' }}>
          <span className="sh-banner__icon" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M6 2v5M6 9v1" /></svg>
          </span>
          <div className="sh-banner__body">
            <div className="sh-banner__title">This project is deleted</div>
            <div className="sh-banner__text">
              Its data is kept until{' '}
              {p?.restorable_until ? new Date(p.restorable_until).toLocaleString() : 'the window closes'},
              then destroyed permanently. Restoring is not built yet.
            </div>
          </div>
        </div>
      ) : null}

      {/* Connect first: it is what people came for. */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Connect</h2>
          <Link className="section__note" href={`/project/${ref}/connect`}>All connection options →</Link>
        </div>
        <div className="card">
          <div className="card__body">
            {db ? (
              <div className="facts">
                <div className="facts__k">Host</div>
                <div className="facts__v"><code>{db.host}:{db.port}</code></div>
                <div className="facts__k">Pooled port</div>
                <div className="facts__v"><code>{db.pooler_port}</code></div>
                <div className="facts__k">Credentials</div>
                <div className="facts__v">
                  <Link href={`/project/${ref}/connect`}>Show connection strings →</Link>
                </div>
              </div>
            ) : q.isLoading ? (
              <div className="sh-skeleton" style={{ height: 20, width: '80%' }} />
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {settling
                  ? 'The connection string appears as soon as the database is up.'
                  : 'No connection string. The API returns one only when it can decrypt the stored credential.'}
              </p>
            )}
          </div>
          {db ? (
            <div className="card__foot">
              Connection strings live on Connect, not here — taking them is recorded
              against your account, so this page shows only where the database is.
            </div>
          ) : null}
        </div>
      </section>

      <section className="section">
        <div className="section__head"><h2 className="section__title">Details</h2></div>
        <div className="card"><div className="card__body">
          {q.isLoading ? <FactsSkeleton /> : (
            <div className="facts">
              <div className="facts__k">Status</div>
              <div className="facts__v">{p ? <ProjectStateBadge status={p.status} /> : '—'}</div>
              <div className="facts__k">Postgres</div>
              <div className="facts__v">{db ? <code>{db.pg_version}</code> : <span className="muted">—</span>}</div>
              <div className="facts__k">Host</div>
              <div className="facts__v">
                {db ? <code>{db.host}:{db.port}</code> : <span className="muted">—</span>}
              </div>
              <div className="facts__k">Region</div>
              <div className="facts__v">{p?.region ?? '—'}</div>
              <div className="facts__k">Plan</div>
              <div className="facts__v">{p?.plan ?? '—'}</div>
              <div className="facts__k">Created</div>
              <div className="facts__v">
                {p ? new Date(p.created_at).toLocaleString() : '—'}
              </div>
            </div>
          )}
        </div></div>
      </section>

      <section className="section">
        <div className="section__head"><h2 className="section__title">Health and usage</h2></div>
        <div className="card"><div className="card__body">
          <p className="muted" style={{ margin: 0 }}>
            Not built. Per-service health needs the data API, Auth and Storage — later
            phases — and the metrics path is still an open question, so there is nothing
            honest to draw here yet. A plausible-looking number would be worse than this
            sentence.
          </p>
        </div></div>
      </section>
    </div>
  );
}

function FactsSkeleton() {
  return (
    <div className="facts" aria-busy="true">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} style={{ display: 'contents' }}>
          <div className="sh-skeleton" style={{ height: 12, width: 80 }} />
          <div className="sh-skeleton" style={{ height: 14, width: `${45 + (i % 3) * 15}%` }} />
        </div>
      ))}
    </div>
  );
}
