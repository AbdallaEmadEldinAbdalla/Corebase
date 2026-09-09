'use client';

import { useState } from 'react';
import { ErrorSurface } from './ErrorSurface.tsx';
import type { IntrospectionColumn } from '../lib/api.ts';

/**
 * A page of a table's rows.
 *
 * A **table**, and this is the one list on the surface where §4's threshold is
 * not a judgement call: the rows are the same shape, the columns are the
 * comparison, and cards for database rows would be the failure §4 was written
 * about. The table list beside it is a selector and is not this.
 */

/**
 * How many rows there are, said honestly.
 *
 * `rows_estimate` is `reltuples`, which is what the planner believes: it is right
 * after `ANALYZE`, stale after a bulk load, and **-1 when the table has never
 * been analysed at all**. Rendering -1 as `0` would be the worst outcome — a
 * developer who just inserted a thousand rows reading "0 rows" concludes their
 * insert failed.
 *
 * So: a tilde when it is an estimate, a plain number when the user has asked for
 * an exact count, and a sentence when there is no number to give. The doc's own
 * "~12,400 rows" is the shape; the tilde is doing real work and is not decoration.
 */
function rowCount(estimate: number, exact: number | null): string {
  if (exact !== null) return `${exact.toLocaleString()} rows`;
  if (estimate < 0) return 'not counted yet';
  if (estimate === 0) return 'no rows, or none counted yet';
  return `~${Math.round(estimate).toLocaleString()} rows`;
}

/**
 * A cell's value, with `null` distinguishable from an empty string.
 *
 * They are different values that render identically as text, and in a grid over
 * a customer's data the difference is the difference between "no answer" and "an
 * answer that is blank" — which is exactly the sort of thing someone is looking
 * at the grid to find out.
 */
function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="grid__null">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="sh-mono">{value ? 'true' : 'false'}</span>;
  }
  if (typeof value === 'object') {
    // jsonb and arrays arrive parsed. One line, monospaced, and the full value is
    // in the title until the JSON cell viewer exists.
    const text = JSON.stringify(value);
    return <span className="sh-mono" title={text}>{text}</span>;
  }
  const text = String(value);
  if (text === '') return <span className="grid__empty">empty string</span>;
  return <span>{text}</span>;
}

export function DataGrid(props: {
  columns: IntrospectionColumn[];
  rows: Record<string, unknown>[] | null;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  sort: { column: string; direction: 'asc' | 'desc' } | undefined;
  onSort: (column: string) => void;
  rowsEstimate: number;
  exactCount: number | null;
  onCountExactly: () => void;
  primaryKey: readonly string[];
  executedSql: string | null;
  /** Opens the add-primary-key flow. Absent when the table is not ours. */
  onAddPrimaryKey?: () => void;
}) {
  const [showSql, setShowSql] = useState(false);
  const { columns, rows, page, pageSize } = props;

  const from = page * pageSize + 1;
  const to = page * pageSize + (rows?.length ?? 0);
  /**
   * A full page means there *may* be another, not that there is one.
   *
   * The grid asks for exactly `pageSize` rows, so a full page is the only signal
   * available without asking for one more — and "Next" that lands on an empty
   * page is a smaller lie than a missing "Next" that hides real rows.
   */
  const maybeMore = (rows?.length ?? 0) === pageSize;

  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Rows</h2>
        <p className="section__note">
          {rowCount(props.rowsEstimate, props.exactCount)}
          {props.exactCount === null ? (
            <>
              {' · '}
              <button type="button" className="sh-linkbtn" onClick={props.onCountExactly}>
                count exactly
              </button>
              {/* The cost, named. An estimate you cannot escape is worse than one
                  you can, and a count that scans a production table without
                  saying so is worse than both. */}
              <span className="sh-help"> (scans the table)</span>
            </>
          ) : null}
        </p>
      </div>

      {props.primaryKey.length === 0 ? (
        <div className="sh-banner sh-banner--warning" role="status"
             style={{ marginBottom: 'var(--sh-space-12)' }}>
          <div className="sh-banner__body">
            <div className="sh-banner__title">No primary key</div>
            <div className="sh-banner__text">
              Rows here cannot be edited, and paging through them is not stable —
              without a key there is no order to page by, so a row can appear
              twice or not at all. Editing by <code style={{ font: 'var(--sh-code)' }}>ctid</code> is
              a corruption trap under concurrency, so the grid refuses rather than
              offering it.
            </div>
            {/* The fix, one click away, which the table-editor doc asks for by
                name. It was described here as "not built yet" for exactly as long
                as that was true. */}
            {props.onAddPrimaryKey ? (
              <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                      style={{ marginTop: 'var(--sh-space-8)' }}
                      onClick={props.onAddPrimaryKey}>
                Add a primary key…
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {props.error ? (
        <ErrorSurface error={props.error} onRetry={props.onRetry}
                      title="Could not read these rows" />
      ) : props.pending ? (
        <div className="tablewrap" aria-busy="true">
          <table className="sh-table">
            <tbody>
              {[0, 1, 2, 3, 4].map((r) => (
                <tr key={r}>
                  {columns.slice(0, 6).map((c) => (
                    <td key={c.name}><div className="sh-skeleton" style={{ width: '70%' }} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : rows !== null && rows.length === 0 ? (
        <div className="emptywrap"><div className="sh-empty">
          <div className="sh-empty__title">
            {page === 0 ? 'No rows' : 'Nothing on this page'}
          </div>
          <div className="sh-empty__text">
            {page === 0
              ? 'This table has no rows yet. Inserting one needs the row editor, '
                + 'which is not built yet.'
              : 'The rows ran out before this page. Go back a page.'}
          </div>
        </div></div>
      ) : (
        // The grid is the one place in this app that may scroll sideways: a table
        // with forty columns is wider than any window, and squeezing it is what
        // makes a cell unreadable. Scoped to this container so the *page* never
        // scrolls (D-460).
        <div className="gridwrap">
          <table className="sh-table grid">
            <thead>
              <tr>
                {columns.map((c) => {
                  const active = props.sort?.column === c.name;
                  return (
                    <th scope="col" key={c.name}>
                      <button type="button" className="grid__sort"
                              onClick={() => props.onSort(c.name)}
                              aria-label={`Sort by ${c.name}`}>
                        <span className="grid__col">{c.name}</span>
                        {/* The type and nullability live in the header because
                            they are what a developer needs while reading the
                            values, not in a structure tab away from them. */}
                        <span className="grid__type">
                          {c.type}{c.nullable ? '' : ' · not null'}
                          {c.is_primary_key ? ' · pk' : ''}
                        </span>
                        <span className="grid__arrow" aria-hidden="true">
                          {active ? (props.sort!.direction === 'asc' ? '↑' : '↓') : ''}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows?.map((row, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.name}><Cell value={row[c.name]} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="tablecount">
        <span>
          {rows === null || rows.length === 0
            ? ' '
            /* §4: "1–20 of 143 is a sentence; twenty rows and no count is a lie
               of omission." The total is an estimate, so the sentence says so
               rather than pretending to a precision it does not have. */
            : `${from.toLocaleString()}–${to.toLocaleString()} of `
              + rowCount(props.rowsEstimate, props.exactCount)}
        </span>
        <span className="sh-row sh-row--tight">
          <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                  disabled={page === 0} onClick={() => props.onPage(page - 1)}>
            Previous
          </button>
          <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                  disabled={!maybeMore} onClick={() => props.onPage(page + 1)}>
            Next
          </button>
        </span>
      </div>

      {/**
        * "View as SQL", because reads are SQL too.
        *
        * The table editor's rule is that every operation compiles to visible SQL
        * and the SQL is what runs, and the doc extends it to the grid's own
        * sorting. Collapsed by default — it is reference, not the subject — and
        * it shows what the *server* reported executing rather than what the
        * client built, so any rewrite the server made is visible here.
        */}
      {props.executedSql ? (
        <details className="sqlpeek" open={showSql}
                 onToggle={(e) => setShowSql((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>View as SQL</summary>
          <div className="sh-code"><pre>{props.executedSql}</pre></div>
        </details>
      ) : null}
    </section>
  );
}
