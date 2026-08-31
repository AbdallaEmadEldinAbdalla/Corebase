'use client';

import Link from 'next/link';
import { use } from 'react';
import { ErrorSurface } from '../../../components/ErrorSurface.tsx';
import { ProjectStateBadge, SETTLING } from '../../../components/ProjectState.tsx';
import { CopyButton } from '../../../components/Copy.tsx';
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
  const direct = db?.connection_strings?.direct;

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
        <div className="cb-banner cb-banner--info" role="status" style={{ marginBottom: 'var(--cb-space-5)' }}>
          <span className="cb-banner__icon" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M6 2v4l3 2" /></svg>
          </span>
          <div className="cb-banner__body">
            <div className="cb-banner__title">
              {p?.status === 'resuming' ? 'Resuming this project'
                : p?.status === 'deleting' ? 'Deleting this project'
                : 'Setting up your database'}
            </div>
            <div className="cb-banner__text">
              Usually a few seconds. This page updates itself — there is no need to reload.
            </div>
            <div className="cb-progress" style={{ marginTop: 'var(--cb-space-3)' }}>
              <div className="cb-progress__fill" style={{ width: '55%' }} />
            </div>
          </div>
        </div>
      ) : null}

      {p?.status === 'failed' ? (
        <div className="cb-banner cb-banner--error" role="alert" style={{ marginBottom: 'var(--cb-space-5)' }}>
          <span className="cb-banner__icon" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M2 2 10 10M10 2 2 10" /></svg>
          </span>
          <div className="cb-banner__body">
            <div className="cb-banner__title">Provisioning failed</div>
            <div className="cb-banner__text">
              Nothing was charged. The control plane retries on its own; if it stays failed,
              quote <code className="mono">{ref}</code> to support.
            </div>
          </div>
        </div>
      ) : null}

      {p?.deleted_at || p?.status === 'soft_deleted' ? (
        <div className="cb-banner cb-banner--warning" role="status" style={{ marginBottom: 'var(--cb-space-5)' }}>
          <span className="cb-banner__icon" aria-hidden="true">
            <svg viewBox="0 0 12 12"><path d="M6 2v5M6 9v1" /></svg>
          </span>
          <div className="cb-banner__body">
            <div className="cb-banner__title">This project is deleted</div>
            <div className="cb-banner__text">
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
            {direct ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--cb-space-3)' }}>
                <code style={{ flex: 1, minWidth: 0, font: 'var(--cb-code)', overflowWrap: 'anywhere' }}>
                  {direct}
                </code>
                <CopyButton value={direct} what="Connection string" />
              </div>
            ) : q.isLoading ? (
              <div className="cb-skeleton" style={{ height: 20, width: '80%' }} />
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {settling
                  ? 'The connection string appears as soon as the database is up.'
                  : 'No connection string. The API returns one only when it can decrypt the stored credential.'}
              </p>
            )}
          </div>
          {direct ? (
            <div className="card__foot">
              This string contains the database password. Treat it like one.
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
          <div className="cb-skeleton" style={{ height: 12, width: 80 }} />
          <div className="cb-skeleton" style={{ height: 14, width: `${45 + (i % 3) * 15}%` }} />
        </div>
      ))}
    </div>
  );
}
