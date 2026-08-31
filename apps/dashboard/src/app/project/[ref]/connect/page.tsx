'use client';

import { use, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ErrorSurface } from '../../../../components/ErrorSurface.tsx';
import { CopyButton } from '../../../../components/Copy.tsx';
import { useProject } from '../../../../lib/queries.ts';
import type { DatabaseInfo } from '../../../../lib/api.ts';

/**
 * Connect: the same credentials in the form the caller actually needs.
 *
 * A raw `postgres://` URI is only directly usable by about half the people who come
 * here; everyone else is reaching for a `psql` invocation, a `.env` file, or a
 * client-library snippet, and each of those is a small transcription job that is
 * easy to get wrong. Rendering them is nearly free and removes a whole class of
 * "why can't I connect".
 *
 * The selected tab lives in the URL (`?as=env`), because gate question 3 asks
 * whether this view can be sent to a colleague — and "open Connect, then click the
 * third tab" is the instruction that question exists to eliminate.
 */
const TABS = [
  { id: 'uri', label: 'URI' },
  { id: 'psql', label: 'psql' },
  { id: 'env', label: '.env' },
  { id: 'node', label: 'Node.js' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function ConnectPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  return (
    <Suspense fallback={<div className="wrap"><div className="cb-skeleton" style={{ height: 300 }} /></div>}>
      <Connect projectRef={ref} />
    </Suspense>
  );
}

function Connect({ projectRef }: { projectRef: string }) {
  const q = useProject(projectRef);
  const router = useRouter();
  const search = useSearchParams();

  const raw = search.get('as');
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : 'uri';
  const setTab = (id: TabId) =>
    // replace, not push: flipping between tabs is not four steps of history to
    // walk back through.
    router.replace(`/project/${projectRef}/connect?as=${id}`, { scroll: false });

  const p = q.data?.project;
  const db = q.data?.database;

  return (
    <div className="wrap">
      <div className="head">
        <div>
          <h1 className="head__title">Connect</h1>
          <p className="head__sub">
            Credentials for <span className="mono">{p?.name ?? projectRef}</span>. Anyone
            holding these has full access to the database.
          </p>
        </div>
      </div>

      {q.error ? <ErrorSurface error={q.error} onRetry={() => void q.refetch()} /> : null}

      {q.isLoading ? (
        <div className="card"><div className="card__body">
          <div className="cb-skeleton" style={{ height: 36, width: 280 }} />
          <div className="cb-skeleton" style={{ height: 120, marginTop: 16 }} />
        </div></div>
      ) : !db?.connection_strings ? (
        <div className="emptywrap"><div className="cb-empty">
          <div className="cb-empty__title">No credentials yet</div>
          <div className="cb-empty__text">
            {p && ['creating', 'provisioning', 'configuring'].includes(p.status)
              ? 'The database is still being set up. This page fills in when it is ready.'
              : 'The API returns connection strings only when it can decrypt the stored credential.'}
          </div>
        </div></div>
      ) : (
        <>
          <div className="cb-tabs" role="tablist" aria-label="Connection format">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" className="cb-tab"
                      aria-selected={tab === t.id}
                      onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          <div style={{ marginTop: 'var(--cb-space-4)' }}>
            <Snippet tab={tab} db={db} name={p?.name ?? projectRef} />
          </div>

          <section className="section" style={{ marginTop: 'var(--cb-space-8)' }}>
            <div className="section__head">
              <h2 className="section__title">Connection pooler</h2>
              <p className="section__note">
                Allocated and recorded — PgBouncer itself is a later phase, so this
                string will not connect yet.
              </p>
            </div>
            <div className="card"><div className="card__body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--cb-space-3)' }}>
                <code style={{ flex: 1, minWidth: 0, font: 'var(--cb-code)', overflowWrap: 'anywhere',
                               color: 'var(--cb-text-muted)' }}>
                  {db.connection_strings.pooled}
                </code>
                <CopyButton value={db.connection_strings.pooled} what="Pooled connection string"
                            variant="ghost" />
              </div>
            </div></div>
          </section>
        </>
      )}
    </div>
  );
}

/** Mono, on a dark surface, with a copy affordance — design system §5 rule 7. */
function Snippet({ tab, db, name }: { tab: TabId; db: DatabaseInfo; name: string }) {
  const uri = db.connection_strings!.direct;
  const url = new URL(uri);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const host = url.hostname;
  const port = url.port || String(db.port);
  const database = url.pathname.replace(/^\//, '') || 'postgres';

  const body: Record<TabId, { lang: string; text: string }> = {
    uri: { lang: 'Connection URI', text: uri },
    psql: { lang: 'shell', text: `psql "${uri}"` },
    env: {
      lang: '.env',
      text: [
        `DATABASE_URL="${uri}"`,
        '',
        `PGHOST=${host}`,
        `PGPORT=${port}`,
        `PGDATABASE=${database}`,
        `PGUSER=${user}`,
        `PGPASSWORD=${password}`,
      ].join('\n'),
    },
    node: {
      lang: 'javascript',
      text: [
        "import { Pool } from 'pg';",
        '',
        'const pool = new Pool({',
        '  connectionString: process.env.DATABASE_URL,',
        '});',
        '',
        `// ${name}`,
        "const { rows } = await pool.query('select now()');",
      ].join('\n'),
    },
  };

  const { lang, text } = body[tab];
  return (
    <div className="cb-code codeblock">
      <div className="cb-code__header">
        <span className="cb-code__lang">{lang}</span>
        <button type="button" className="cb-code__copy"
                onClick={() => { void navigator.clipboard?.writeText(text); }}
                aria-hidden="true" tabIndex={-1} style={{ visibility: 'hidden' }}>copy</button>
        {/* The real control, so the copy goes through the toast layer. */}
        <CopyButton value={text} what={`${lang} snippet`} variant="ghost" />
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}
