'use client';

import { use, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ErrorSurface } from '../../../../components/ErrorSurface.tsx';
import { CopyButton } from '../../../../components/Copy.tsx';
import { useProjectCredentials } from '../../../../lib/queries.ts';
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
  { id: 'env', label: '.env' },
  { id: 'uri', label: 'URI' },
  { id: 'psql', label: 'psql' },
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
  // This page is the credentials page, so it reveals — which the API records once
  // per hour per person. The overview deliberately does not.
  const q = useProjectCredentials(projectRef);
  const router = useRouter();
  const search = useSearchParams();

  const raw = search.get('as');
  // `.env` first: the question people arrive with is "what do I put in my app",
  // and the answer is two variables, not one URI.
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : 'env';
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
              <h2 className="section__title">Which one do I use?</h2>
            </div>
            <div className="card"><div className="card__body">
              <div className="facts">
                <div className="facts__k">DATABASE_URL</div>
                <div className="facts__v">
                  <strong>Your application.</strong> Goes through the connection pooler, so
                  hundreds of clients — serverless functions especially — share a handful of
                  database connections. This is the default and the one to reach for.
                </div>
                <div className="facts__k">DIRECT_DATABASE_URL</div>
                <div className="facts__v">
                  <strong>Migrations and tools.</strong> A direct connection, needed for the
                  handful of things pooling cannot carry: <code>LISTEN</code>, session
                  advisory locks, <code>WITH HOLD</code> cursors, temp tables, and SQL-level
                  <code> PREPARE</code>.
                  <br />
                  Most of these do not fail on the pooled URL — they <em>appear</em> to work
                  and then quietly misbehave, because the next statement may run on a
                  different server connection. <code>LISTEN</code> returns success and then
                  never delivers. That is the reason to know which URL you are holding.
                  <br />
                  There are only a couple of direct slots per project, so pointing an
                  application fleet at this one will exhaust them — visibly, which is the
                  correct failure.
                </div>
              </div>
              <p className="panel__note">
                Inside a transaction, <code>SET LOCAL</code> works on both. Plain{' '}
                <code>SET</code> does not survive the pooler and must not be used to carry
                identity — that is what makes pooling safe for a multi-user API rather than
                merely tolerable.
              </p>
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
  const pooled = db.connection_strings!.pooled;
  const url = new URL(uri);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const host = url.hostname;
  const port = url.port || String(db.port);
  const database = url.pathname.replace(/^\//, '') || 'postgres';

  const body: Record<TabId, { lang: string; text: string }> = {
    // Both variables, in the order an application needs them. The pooled URL is
    // DATABASE_URL because that is the one an app should use; the direct URL is
    // named for what it is rather than hidden, because migrations need it and a
    // developer who cannot find it will point their app at it instead.
    env: {
      lang: '.env',
      text: [
        '# Your application. Pooled — safe for serverless and connection-happy ORMs.',
        `DATABASE_URL="${pooled}"`,
        '',
        '# Migrations, LISTEN, advisory locks, psql. Only a couple of slots exist.',
        `DIRECT_DATABASE_URL="${uri}"`,
      ].join('\n'),
    },
    uri: { lang: 'Pooled connection URI', text: pooled },
    // psql on the direct port: an interactive session is exactly the case
    // transaction pooling does not serve well, and it is one connection.
    psql: { lang: 'shell', text: `psql "${uri}"` },
    node: {
      lang: 'javascript',
      text: [
        "import { Pool } from 'pg';",
        '',
        '// DATABASE_URL is the pooled one; the driver pools on top of it, which is',
        '// fine — PgBouncer is what keeps the *database* from seeing every client.',
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
