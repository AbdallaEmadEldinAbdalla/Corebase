'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { classify } from '@steadhold/sql-guard';
import { useIntrospection, useRunSql } from '../../../../lib/queries.ts';
import { ApiError, type StatementResult } from '../../../../lib/api.ts';
import { completionSchema, rlsHint } from '../../../../lib/sql-completions.ts';
import {
  describeTab, loadTabs, newTab, saveTabs, type SqlTab, type TabState,
} from '../../../../lib/sql-tabs.ts';
import { SqlEditor } from '../../../../components/SqlEditor.tsx';
import { SqlResults } from '../../../../components/SqlResults.tsx';
import { DdlDialog } from '../../../../components/DdlDialog.tsx';
import { Checkbox } from '../../../../components/Checkbox.tsx';
import { Menu, MenuItem } from '../../../../components/Menu.tsx';
import { ErrorSurface } from '../../../../components/ErrorSurface.tsx';
import { useMetaLabel } from '../../../../lib/hotkeys.ts';

type ConsoleRole = 'admin' | 'anon' | 'authenticated';

/**
 * The SQL editor (D-134).
 *
 * The power surface, and the six safety rails are what make it one rather than
 * an outage generator. Five of them are the server's and are enforced whatever
 * this page sends — the role, the timeout, the transaction, read-only, and the
 * destructive guard. This page's job is to make them *visible*: which role is
 * about to run, what will actually be executed, and what the guard will demand
 * before it does.
 *
 * ## What is not here, and why
 *
 * **Saved queries** and **history** are server-side tiers (D-134) and there is
 * no endpoint for either — `GET/POST /v1/projects/:ref/queries` does not exist,
 * and history additionally waits on OQ-134, which asks whether verbatim SQL
 * containing a customer's literals should be stored at all. Neither is drawn
 * disabled: a greyed-out "History" tab is a promise, and Q20 exists because a
 * promise in the nav is worse than an absence.
 *
 * **Per-project `statement_timeout`** has no column. The 60-second default and
 * the ten-minute cap *are* enforced server-side, so the rail works; what is
 * missing is a project setting to change it, and the timeout error says so.
 */
export default function SqlPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const intro = useIntrospection(ref);
  const run = useRunSql(ref);

  /**
   * Tabs, hydrated in an effect rather than in the initial state.
   *
   * `loadTabs` touches `localStorage`, which does not exist on the server — and
   * Next renders this component there first. Reading it in `useState`'s
   * initialiser throws during SSR; reading it in an effect means the first paint
   * is a single empty tab and the real ones arrive a frame later, which is the
   * correct trade for a store that is device-local by design.
   */
  const [state, setState] = useState<TabState>(() => {
    const t = newTab(1);
    return { tabs: [t], activeId: t.id };
  });
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setState(loadTabs(ref)); setHydrated(true); }, [ref]);
  useEffect(() => { if (hydrated) saveTabs(ref, state); }, [ref, state, hydrated]);

  const [role, setRole] = useState<ConsoleRole>('admin');
  const [claims, setClaims] = useState('');
  const [results, setResults] = useState<StatementResult[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  /** The statement a confirmation is pending for, when the guard demands one. */
  const [pending, setPending] = useState<{ sql: string; explain: boolean } | null>(null);

  const active = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0]!;
  const completions = useMemo(
    () => completionSchema(intro.data ?? {
      schemas: [], tables: [], columns: [], functions: [], policies: [],
      indexes: [], constraints: [], roles: [], truncated: {},
    }), [intro.data]);

  const patch = (id: string, change: Partial<SqlTab>) => setState((s) => ({
    ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...change } : t)),
  }));

  /**
   * Send a statement, having decided nothing about whether it is allowed.
   *
   * The guard is the server's, and this asks it: `confirm_destructive` is sent
   * only when the *user* has confirmed through the dialog. A page that set it
   * unconditionally would be a page that disabled rail 2 for everyone, which is
   * exactly the failure D-134's "a guard only in JS is not a guard" warns about
   * — in reverse.
   */
  const send = useCallback(async (
    sql: string, opts: { confirmed?: boolean; names?: string[] } = {},
  ) => {
    setError(null);
    try {
      const data = await run.mutateAsync({
        sql,
        role,
        ...(role === 'authenticated' && claims.trim()
          ? { claims: JSON.parse(claims) as Record<string, unknown> } : {}),
        read_only: active.readOnly,
        ...(opts.confirmed ? { confirm_destructive: true } : {}),
        ...(opts.names && opts.names.length > 0 ? { confirm_names: opts.names } : {}),
      });
      setResults(data.results);
    } catch (err) {
      setResults(null);
      setError(err);
    }
  }, [run, role, claims, active.readOnly]);

  /**
   * Run, or ask first.
   *
   * `Cmd+Enter` on a buffer holding a `DROP TABLE` opens the confirmation rather
   * than running — and that is the shortcut doing what it says, not refusing.
   * The confirmation is *part of* running a destructive statement, exactly as it
   * is when the button is clicked; a shortcut that instead said "use the button"
   * would be asking the user to perform the same action by a different route for
   * no reason.
   */
  const doRun = useCallback((selection: string | null, explain = false) => {
    const raw = (selection ?? active.sql).trim();
    if (!raw) return;
    const sql = explain
      ? `explain (analyze, buffers, format text) ${raw.replace(/;\s*$/, '')}`
      : raw;
    const script = classify(sql);
    if (script.danger !== 'safe' || explain) {
      setPending({ sql, explain });
      return;
    }
    void send(sql);
  }, [active.sql, send]);

  const doExplain = useCallback((selection: string | null) => {
    const raw = (selection ?? active.sql).trim();
    if (!raw) return;
    // Plain EXPLAIN does not execute, so it needs no confirmation of its own —
    // only the destructive guard, if the statement itself is one.
    const sql = `explain (format text) ${raw.replace(/;\s*$/, '')}`;
    const script = classify(sql);
    if (script.danger !== 'safe') { setPending({ sql, explain: false }); return; }
    void send(sql);
  }, [active.sql, send]);

  const pg = error instanceof ApiError ? error.pg : null;
  const hint = useMemo(() => rlsHint(role, {
    rowCount: results?.[0]?.row_count ?? null,
    sqlstate: pg?.sqlstate ?? null,
  }), [role, results, pg]);

  const mod = useMetaLabel();

  if (intro.error) {
    return (
      <div className="deck__main">
        <div className="deckhead"><span className="deckhead__name">SQL</span></div>
        <div className="deckgrid" style={{ padding: 'var(--sh-space-24)' }}>
          <ErrorSurface error={intro.error} onRetry={() => void intro.refetch()}
                        title="Could not read the schema" />
          <p className="sh-help">
            Completions need the schema, and running SQL does not — but both go
            through the same connection, so this is likely to fail too.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="deck__main">
      {/**
        * The tabs *are* the header.
        *
        * A `.head__title` reading "SQL" above a tab strip named the section
        * twice — the sidebar already says it, and the breadcrumb says it again.
        * What belonged in that space is which buffer is open, so the tabs get
        * it. The paragraph that used to sit here explained three of the six
        * rails; it now lives in the results pane's own empty state, where it is
        * read at the moment it matters rather than skipped once on arrival.
        */}
      <div className="deckhead deckhead--tabs">
        <div className="sqltabs" role="tablist" aria-label="Query tabs">
        {state.tabs.map((t) => (
          <div key={t.id} className={`sqltab${t.id === state.activeId ? ' is-active' : ''}`}>
            <button type="button" role="tab" aria-selected={t.id === state.activeId}
                    className="sqltab__pick"
                    onClick={() => setState((s) => ({ ...s, activeId: t.id }))}>
              {describeTab(t)}
              {t.readOnly ? <span className="tablelist__tag">read-only</span> : null}
            </button>
            {state.tabs.length > 1 ? (
              <button type="button" className="sqltab__close"
                      aria-label={`Close ${describeTab(t)}`}
                      onClick={() => setState((s) => {
                        const tabs = s.tabs.filter((x) => x.id !== t.id);
                        return {
                          tabs,
                          activeId: s.activeId === t.id ? tabs[0]!.id : s.activeId,
                        };
                      })}>
                <span aria-hidden="true">×</span>
              </button>
            ) : null}
          </div>
        ))}
        <button type="button" className="sqltab__new" aria-label="New query tab"
                onClick={() => setState((s) => {
                  const t = newTab(s.tabs.length + 1);
                  return { tabs: [...s.tabs, t], activeId: t.id };
                })}>
          <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>

      {/* ── toolbar ────────────────────────────────────────────────────────── */}
      <div className="deckbar sqlbar">
        {/**
          * The role chip, loud **only when it is not admin**.
          *
          * Rail 1 asks for a "coloured toolbar chip", and §5 rule 1 says the
          * accent must stay rare — the accent belongs to Run. The resolution is
          * that admin is the *normal* state and gets no colour at all: a chip
          * that shouts on every run is the guard-that-fires-on-the-normal-case
          * problem, and people stop reading it. A non-admin role is a mode, not
          * an error, so it takes the info tone rather than warning or danger.
          */}
        <Menu label="Run as which role" align="left"
              trigger={({ toggle, ref: r, open }) => (
                <button ref={r} type="button" aria-expanded={open} aria-haspopup="menu"
                        className={`sqlrole${role !== 'admin' ? ' sqlrole--other' : ''}`}
                        onClick={toggle}>
                  <span className="sqlrole__label">as</span>
                  <span className="sqlrole__name">
                    {role === 'admin' ? 'developer (owner)' : role}
                  </span>
                </button>
              )}>
          {(close) => (
            <>
              <MenuItem active={role === 'admin'}
                        onSelect={() => { close(); setRole('admin'); }}>
                developer (owner) — sees every row
              </MenuItem>
              <MenuItem active={role === 'anon'}
                        onSelect={() => { close(); setRole('anon'); }}>
                anon — what an unauthenticated caller sees
              </MenuItem>
              <MenuItem active={role === 'authenticated'}
                        onSelect={() => { close(); setRole('authenticated'); }}>
                authenticated — with the claims below
              </MenuItem>
            </>
          )}
        </Menu>

        {role === 'authenticated' ? (
          <input className="sh-input sqlbar__claims" value={claims}
                 aria-label="JWT claims as JSON"
                 placeholder={'{"sub": "…"}'}
                 autoComplete="off" spellCheck={false}
                 onChange={(e) => setClaims(e.target.value)} />
        ) : null}

        {/* The word is *inside* the label, so clicking it toggles and the
            accessible name is the visible text rather than an `aria-label` that
            has to be kept in step with it. It was outside, which made an 18px
            box the whole hit area — design system §5 rule 5 asks for 40. */}
        <label className="sh-checkbox sqlbar__ro">
          <input type="checkbox" checked={active.readOnly}
                 onChange={(e) => patch(active.id, { readOnly: e.target.checked })} />
          <span className="sh-checkbox__box" aria-hidden="true" />
          <span className="sqlbar__rolabel">read-only</span>
        </label>

        <span className="sqlbar__spacer" />

        {/* 28px toolbar controls, not 40px buttons: a `.sh-btn` is exactly the
            height of the bar it sits in and left no room around itself. Run
            keeps the single accent the view is allowed — the same weight the
            grid's `+ Insert` carries — and Explain is quiet beside it. */}
        <button type="button" className="tbtn"
                disabled={run.isPending || !active.sql.trim()}
                onClick={() => doExplain(null)}>
          Explain
        </button>
        <button type="button" className="tbtn tbtn--accent"
                disabled={run.isPending || !active.sql.trim()}
                onClick={() => doRun(null)}>
          {run.isPending ? 'Running…' : `Run  ${mod}↵`}
        </button>
      </div>

      {/* The editor's own pane: a fixed share of the deck, so the results get
          the rest and the whole thing scrolls in one place rather than two. */}
      <div className="sqled">
      <SqlEditor
        value={active.sql}
        onChange={(sql) => patch(active.id, { sql })}
        completions={completions}
        onRun={(sel) => doRun(sel)}
        onExplain={(sel) => doExplain(sel)}
        errorAt={pg?.position != null
          ? { position: pg.position, message: (error as Error).message } : null}
      />
      </div>

      {/* Everything below the editor is one scrolling pane: an error, the
          per-statement results, or the state that says nothing has run. Two
          scroll containers would mean a results table that scrolls inside a
          page that also scrolls, which is the thing the redesign removed from
          the grid. */}
      <div className="deckgrid sqlout">

      {error && !pg ? (
        /* A platform failure rather than a SQL one — unreachable project, rate
           limit, a refusal from the guard. It has a code and a request id, and
           `ErrorSurface` is the one component that shows both. */
        <div style={{ marginTop: 'var(--sh-space-16)' }}>
          <ErrorSurface error={error} title="Could not run this" />
        </div>
      ) : null}

      {error && pg ? (
        <div className="sh-banner sh-banner--error" role="alert"
             style={{ marginTop: 'var(--sh-space-16)' }}>
          <div className="sh-banner__body">
            <div className="sh-banner__title">The database refused this statement</div>
            <div className="sh-banner__text">
              {(error as Error).message}
              {pg.detail ? <> {pg.detail}</> : null}
              {/* Postgres's own hint, verbatim. They are good, and paraphrasing
                  one is how a useful sentence becomes a vague one. */}
              {pg.hint ? <><br /><strong>Hint from Postgres:</strong> {pg.hint}</> : null}
            </div>
            <div className="ddl__errmeta">
              <span>
                SQLSTATE <code style={{ font: 'var(--sh-code)' }}>{pg.sqlstate}</code>
                {pg.position !== null ? ` · at character ${pg.position}, underlined above` : ''}
              </span>
              {error instanceof ApiError && error.requestId ? (
                <span>
                  Request <code style={{ font: 'var(--sh-code)' }}>{error.requestId}</code>
                </span>
              ) : null}
            </div>
            {pg.sqlstate === '57014' ? (
              <div className="sh-banner__text" style={{ marginTop: 'var(--sh-space-8)' }}>
                {/* The timeout, with the honest state of the setting: the rail
                    works and the per-project override does not exist yet. */}
                That is the 60&nbsp;second statement timeout. It is enforced on
                every run and is not yet configurable per project — narrow the
                query, or add an index from the table editor.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

        <SqlResults results={results} running={run.isPending} hint={hint}
                    runShortcut={`${mod}↵`} />
      </div>

      {pending ? (
        /**
         * The confirmation, and it is the **same dialog** the table editor uses.
         *
         * `EXPLAIN ANALYZE` needs a confirmation because it actually executes
         * the statement, and a destructive statement needs the ladder. Those are
         * two independent facts about one run, and they are two *pieces of
         * information in one dialog* rather than two dialogs — the notice says
         * what analyze does and the typed-name field appears if the server will
         * demand it. A second confirmation mechanism is how Q7 decays, and this
         * app already has exactly one.
         */
        <DdlDialog
          open
          title={pending.explain ? 'Explain analyze runs the statement' : 'Confirm this run'}
          confirmLabel={pending.explain ? 'Run and explain' : 'Run'}
          form={null}
          plan={() => ({
            sql: pending.sql,
            done: pending.explain ? 'Explained' : 'Run finished',
            notices: pending.explain ? [{
              kind: 'data' as const,
              text: 'EXPLAIN ANALYZE executes the statement to measure it. On a '
                + 'SELECT that costs time; on an INSERT, UPDATE or DELETE it '
                + 'changes your data, and the plan is not worth that unless you '
                + 'meant it.',
            }] : [],
          })}
          onCancel={() => setPending(null)}
          onRun={async ({ sql, confirmDestructive, confirmNames }) => {
            await send(sql, { confirmed: confirmDestructive, names: confirmNames });
            setPending(null);
          }}
        />
      ) : null}
    </div>
  );
}
