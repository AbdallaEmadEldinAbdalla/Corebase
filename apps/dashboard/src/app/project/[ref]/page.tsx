'use client';

import { use, useState } from 'react';
import { AppShell } from '../../../components/AppShell.tsx';
import { ErrorSurface } from '../../../components/ErrorSurface.tsx';
import { ProjectStateBadge, SETTLING } from '../../../components/ProjectState.tsx';
import { useProject, useProjectKeys, useOrgs } from '../../../lib/queries.ts';

/**
 * Project overview — the stub the shell needs, and honest about being one.
 *
 * The IA specifies three zones: a health row per service, three 24-hour
 * sparklines, and an onboarding checklist. Two of those cannot be built yet and
 * are absent rather than faked:
 *
 * - **Health per service** needs PostgREST, Auth and Storage to exist. They are
 *   Phase 2+. A card reading "Auth: green" today would be a lie about a service
 *   that is not deployed.
 * - **Sparklines** need a metrics path, and OQ-149 has not chosen between a
 *   control-plane rollup and a scoped Prometheus proxy. Inventing one here would
 *   pre-empt that decision in the hardest place to change it.
 *
 * What it does show is everything the control plane actually knows: state, region,
 * plan, the recovery deadline when soft-deleted, the connection strings the API
 * hands back, and the project's API keys. That is the useful half of the page and
 * all of it is real.
 */
export default function ProjectOverviewPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const project = useProject(ref);
  const orgs = useOrgs();

  const p = project.data?.project;
  const db = project.data?.database;
  const settling = Boolean(p && SETTLING.has(p.status));
  // Keys do not exist until provisioning has minted them, so asking early just
  // renders an empty panel with a spinner in it.
  const keys = useProjectKeys(ref, p?.status === 'ready');
  const softDeleted = p?.status === 'soft_deleted' || Boolean(p?.deleted_at);

  const orgSlug = orgs.data?.orgs.find((o) => o.id === p?.org_id)?.slug;

  return (
    <AppShell {...(orgSlug ? { orgSlug } : {})}>
      <main className="page">
        <div className="page__inner">
          <div className="page__head">
            <div>
              <h1 className="page__title">{p?.name ?? ref}</h1>
              <p className="page__sub">
                <span className="mono">{ref}</span>
                {p ? <> · {p.region} · {p.plan}</> : null}
              </p>
            </div>
            <div className="page__actions">
              {p ? <ProjectStateBadge status={p.status} /> : null}
            </div>
          </div>

          {project.error ? (
            <ErrorSurface error={project.error} onRetry={() => void project.refetch()} />
          ) : null}

          {/* Provisioning progress. Nothing shows an error state while a project
              is still settling — the IA is explicit about that, and a panel that
              flashes red for two seconds on every create teaches distrust. */}
          {settling ? (
            <div className="cb-banner cb-banner--info" role="status">
              <span className="cb-banner__icon" aria-hidden="true">
                <svg viewBox="0 0 12 12"><path d="M6 2v4l3 2" /></svg>
              </span>
              <div className="cb-banner__body">
                <div className="cb-banner__title">
                  {p?.status === 'resuming' ? 'Resuming'
                    : p?.status === 'deleting' ? 'Deleting'
                      : 'Setting up your database'}
                </div>
                <div className="cb-banner__text">
                  Usually a few seconds. This page updates itself — no need to reload.
                </div>
                <div className="cb-progress" style={{ marginTop: 'var(--cb-space-3)' }}>
                  <div className="cb-progress__fill" style={{ width: '60%' }} />
                </div>
              </div>
            </div>
          ) : null}

          {p?.status === 'failed' ? (
            <div className="cb-banner cb-banner--error" role="alert">
              <span className="cb-banner__icon" aria-hidden="true">
                <svg viewBox="0 0 12 12"><path d="M2 2 10 10M10 2 2 10" /></svg>
              </span>
              <div className="cb-banner__body">
                <div className="cb-banner__title">Provisioning failed</div>
                <div className="cb-banner__text">
                  This project could not be created. Nothing was charged. The control
                  plane retries on its own; if it stays failed, quote the project ref
                  to support.
                </div>
              </div>
            </div>
          ) : null}

          {softDeleted ? (
            <div className="cb-banner cb-banner--warning" role="status">
              <span className="cb-banner__icon" aria-hidden="true">
                <svg viewBox="0 0 12 12"><path d="M6 2v5M6 9v1" /></svg>
              </span>
              <div className="cb-banner__body">
                <div className="cb-banner__title">This project is deleted</div>
                <div className="cb-banner__text">
                  Its data is kept until{' '}
                  {p?.restorable_until
                    ? new Date(p.restorable_until).toLocaleString()
                    : 'the recovery window closes'}
                  , then destroyed permanently.
                </div>
              </div>
            </div>
          ) : null}

          <section className="panel" style={{ marginTop: 'var(--cb-space-6)' }}>
            <h2 className="panel__title">Database</h2>
            {db ? (
              <div className="kv">
                <div className="kv__k">Version</div>
                <div className="kv__v mono">PostgreSQL {db.pg_version}</div>
                <div className="kv__k">Host</div>
                <div className="kv__v mono">{db.host}:{db.port}</div>
                {db.connection_strings ? (
                  <>
                    <div className="kv__k">Connection string</div>
                    <div className="kv__v"><Copyable value={db.connection_strings.direct} /></div>
                    <div className="kv__k">Pooled</div>
                    <div className="kv__v">
                      <Copyable value={db.connection_strings.pooled} />
                      <div className="panel__note">
                        The pooler port is allocated and recorded, but PgBouncer is a later
                        phase — this string will not connect yet.
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="kv__k">Connection string</div>
                    <div className="kv__v muted">
                      Not available. The API returns connection strings only when it can
                      decrypt the stored credential.
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {settling
                  ? 'Connection details appear as soon as the database is up.'
                  : 'No connection details recorded for this project.'}
              </p>
            )}
          </section>

          <section className="panel">
            <h2 className="panel__title">API keys</h2>
            {keys.data?.api_keys?.length ? (
              <div className="kv">
                {keys.data.api_keys.map((k) => (
                  <ApiKeyRow key={k.kind} kind={k.kind} prefix={k.prefix}
                    {...(k.key ? { value: k.key } : {})} />
                ))}
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {p?.status === 'ready'
                  ? 'No keys recorded for this project.'
                  : 'Keys are minted while the project is provisioned.'}
              </p>
            )}
          </section>

          <section className="panel">
            <h2 className="panel__title">Health and usage</h2>
            <p className="muted" style={{ margin: 0 }}>
              Per-service health and the 24-hour sparklines are not built. Health needs
              the data API, Auth and Storage, which are later phases; the metrics path is
              still an open question (OQ-149), and a made-up number on this page would be
              worse than an empty one.
            </p>
          </section>
        </div>
      </main>
    </AppShell>
  );
}

/** A value that exists to be copied, so it is mono with a copy button (§5 rule 7). */
function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied */ }
  };
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <code style={{ flex: 1, minWidth: 0 }}>{value}</code>
      <button type="button" className="cb-btn cb-btn--secondary cb-btn--sm" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * `anon` is publishable by design and shown; `service_role` bypasses RLS, so the
 * API only returns it under `?reveal=true` with `key.manage` and writes an audit
 * row naming who looked. This page does not offer the reveal yet — the audited
 * reveal flow belongs with the keys page, and a half-built one here would leave
 * the audit trail saying a key was revealed when nothing displayed it.
 */
function ApiKeyRow({ kind, prefix, value }: { kind: string; prefix: string; value?: string }) {
  return (
    <>
      <div className="kv__k">{kind}</div>
      <div className="kv__v">
        {value
          ? <Copyable value={value} />
          : <span className="muted">
            <code>{prefix}</code> · hidden. Revealing this key is audited and is not
            built into this page yet.
          </span>}
      </div>
    </>
  );
}
