'use client';

import { useState } from 'react';
import { CopyButton } from './Copy.tsx';
import type { StatementResult } from '../lib/api.ts';

/**
 * What one run produced, per statement.
 *
 * A run can be several statements, and the doc is explicit that "results render
 * per statement" — collapsing them into one grid would lose which statement
 * produced what, which is the whole point of running three at once.
 *
 * ## The four states, and the fifth that is really the first
 *
 * §6's four states assume data was requested. An editor's *initial* state is
 * "nothing has been run yet", which is none of them — and it is not a fifth
 * state either: it is the empty state doing its documented job of saying "what
 * would be here, why it is not, and the action that fixes it". So it says press
 * the shortcut, and names the shortcut.
 */

/** A value in a results cell, with `null` distinguishable from an empty string. */
function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="grid__null">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="sh-mono">{value ? 'true' : 'false'}</span>;
  }
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return <span className="sh-mono" title={text}>{text}</span>;
  }
  const text = String(value);
  if (text === '') return <span className="grid__empty">empty string</span>;
  return <span>{text}</span>;
}

/**
 * The result set as CSV, per the doc's "export CSV of the fetched result set
 * (client-side)".
 *
 * RFC 4180 quoting, which matters more than it looks: a value containing a
 * comma, a quote or a newline breaks every naive implementation, and a broken
 * CSV is worse than none because the failure surfaces in whatever the user
 * opened it with rather than here. `null` becomes an empty field — the
 * convention every database's own COPY uses — and that is genuinely lossy, so
 * the button says so.
 */
export function toCsv(fields: { name: string }[], rows: unknown[]): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = fields.map((f) => cell(f.name)).join(',');
  const body = (rows as Record<string, unknown>[]).map(
    (r) => fields.map((f) => cell(r[f.name])).join(','));
  // CRLF, which is what RFC 4180 says and what Excel needs to not mangle the
  // last column of every row.
  return [head, ...body].join('\r\n');
}

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function OneResult(
  { result, index, total, onShowMore }:
  { result: StatementResult; index: number; total: number; onShowMore?: () => void },
) {
  const [viewing, setViewing] = useState<{ column: string; value: unknown } | null>(null);
  const rows = result.rows as Record<string, unknown>[];
  const fields = result.fields;

  return (
    <section className="sqlres">
      <div className="sqlres__head">
        <span className="sqlres__what">
          {total > 1 ? <span className="sqlres__n">{index + 1}</span> : null}
          <code style={{ font: 'var(--sh-code)' }}>{result.command}</code>
          {/**
            * The count means different things per command and saying the wrong
            * one is worse than saying nothing: `row_count` is rows *returned*
            * for a SELECT and rows *affected* for an UPDATE, and calling an
            * UPDATE's 12 "rows returned" would suggest it handed something back.
            */}
          {' · '}
          {fields.length > 0
            ? `${result.row_count.toLocaleString()} ${result.row_count === 1 ? 'row' : 'rows'}`
            : `${result.row_count.toLocaleString()} affected`}
          {' · '}
          {result.duration_ms.toLocaleString()} ms
        </span>
        <span className="sh-row sh-row--tight">
          {rows.length > 0 ? (
            <>
              <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                      onClick={() => download(
                        `result-${index + 1}.csv`, toCsv(fields, rows), 'text/csv')}>
                CSV
              </button>
              <CopyButton value={JSON.stringify(rows, null, 2)} what="Rows as JSON" />
            </>
          ) : null}
        </span>
      </div>

      {/**
        * The SQL that actually ran, whenever it differs from what was sent.
        *
        * This is the one thing that makes rail 4 acceptable: an invisible
        * rewrite is a lie, and a visible one is a service. It appears only when
        * the server rewrote something, so a run that was left alone does not
        * carry a line saying so.
        */}
      {result.truncated ? (
        <div className="sh-banner sh-banner--info" role="status">
          <div className="sh-banner__body">
            <div className="sh-banner__title">Showing the first 500 rows</div>
            <div className="sh-banner__text">
              A 501st row exists, so there are more. What ran was{' '}
              <code style={{ font: 'var(--sh-code)' }}>{result.executed_sql}</code> — the
              limit is appended to a bare <code style={{ font: 'var(--sh-code)' }}>select</code>{' '}
              so a careless query cannot pull a million rows into a browser.
            </div>
            {onShowMore ? (
              <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                      style={{ marginTop: 'var(--sh-space-8)' }} onClick={onShowMore}>
                Add an explicit limit instead
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {fields.length === 0 ? (
        /* A write, or a statement with no result set. Saying "no rows" here
           would read as a failed read rather than a successful write. */
        <p className="sqlres__none">
          {result.command} completed. Nothing to show — this statement returns no
          rows.
        </p>
      ) : rows.length === 0 ? (
        <p className="sqlres__none">
          No rows matched.
        </p>
      ) : (
        <div className="dwrap">
          {/* The same table the grid uses, at the same density: two tables of
              rows from the same database looked like two products. */}
          <table className="dtable dtable--dense">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th scope="col" key={f.name}>
                    <span className="grid__col">{f.name}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {fields.map((f) => {
                    const v = row[f.name];
                    const isJson = v !== null && typeof v === 'object';
                    return (
                      <td key={f.name}>
                        {isJson ? (
                          /* The JSON cell viewer's entry point. A one-line
                             `{"a":1,…}` is unreadable and is the most common
                             thing in a jsonb column, so the cell offers to open
                             it rather than expecting the user to widen a
                             column. */
                          <button type="button" className="sh-linkbtn"
                                  onClick={() => setViewing({ column: f.name, value: v })}>
                            <Value value={v} />
                          </button>
                        ) : (
                          <Value value={v} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {viewing ? (
        <div className="sh-modal">
          <button type="button" className="sh-scrim" aria-label="Close"
                  onClick={() => setViewing(null)} />
          <div className="sh-dialog ddl" role="dialog" aria-modal="true"
               aria-label={`${viewing.column} as JSON`}>
            <div className="sh-dialog__title">{viewing.column}</div>
            <div className="sh-code codeblock" style={{ maxWidth: '100%' }}>
              <pre tabIndex={0} style={{ maxHeight: '50vh', overflow: 'auto' }}>
                {JSON.stringify(viewing.value, null, 2)}
              </pre>
            </div>
            <div className="sh-dialog__footer">
              <CopyButton value={JSON.stringify(viewing.value, null, 2)} what="JSON" />
              <span style={{ flex: 1 }} />
              <button type="button" className="sh-btn sh-btn--secondary"
                      onClick={() => setViewing(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SqlResults(props: {
  results: StatementResult[] | null;
  running: boolean;
  /** The RLS nudge, when a non-admin run came back empty or denied. */
  hint: string | null;
  onShowMore?: () => void;
  runShortcut: string;
}) {
  if (props.running) {
    return (
      <div className="sqlres" aria-busy="true">
        {/* A skeleton in the shape of a results table, not a spinner — §6, and
            the shape is what stops the panel jumping when rows arrive. */}
        <div className="sh-skeleton" style={{ width: 180, height: 14 }} />
        <div className="sh-skeleton"
             style={{ width: '100%', height: 120, marginTop: 'var(--sh-space-12)' }} />
      </div>
    );
  }

  if (props.results === null) {
    return (
      <div className="emptywrap"><div className="sh-empty">
        <div className="sh-empty__title">Nothing has run yet</div>
        <div className="sh-empty__text">
          Results appear here. Press <span className="kbd">{props.runShortcut}</span> to
          run the buffer, or select part of it to run only that.
          {/**
            * The three rails that are not visible as controls, named here
            * rather than in a paragraph above the editor.
            *
            * That paragraph was the page's `.head__sub` and it went when the
            * page became a workspace. Deleting the sentences with it would have
            * lost real information — a developer needs to know a run is one
            * transaction before they write two statements that depend on it —
            * so they moved to the one place that is on screen exactly while
            * nothing has run: this state. The role and read-only rails need no
            * sentence, because their controls are in the toolbar saying what
            * they are.
            */}
          <br /><br />
          Everything in a run goes in <strong>one transaction</strong>, so a
          failure rolls the whole run back. A bare <code style={{ font: 'var(--sh-code)' }}>select</code>{' '}
          gets a 500-row limit appended, and every statement has a
          60&nbsp;second timeout. Nothing reaches the server until you run it.
        </div>
      </div></div>
    );
  }

  return (
    <>
      {props.hint ? (
        /**
         * The RLS nudge. Informational rather than a warning: running as `anon`
         * and seeing nothing is the system working, and the nudge exists because
         * that is indistinguishable from a broken query without being told.
         */
        <div className="sh-banner sh-banner--info" role="status"
             style={{ marginBottom: 'var(--sh-space-12)' }}>
          <div className="sh-banner__body">
            <div className="sh-banner__title">This may be row-level security</div>
            <div className="sh-banner__text">{props.hint}</div>
          </div>
        </div>
      ) : null}
      {props.results.map((r, i) => (
        <OneResult key={i} result={r} index={i} total={props.results!.length}
                   {...(props.onShowMore ? { onShowMore: props.onShowMore } : {})} />
      ))}
    </>
  );
}
