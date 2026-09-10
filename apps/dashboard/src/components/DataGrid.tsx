'use client';

import { useState } from 'react';
import { ErrorSurface } from './ErrorSurface.tsx';
import { Checkbox } from './Checkbox.tsx';
import type { IntrospectionColumn } from '../lib/api.ts';
import type { CellValue } from '../lib/dml.ts';

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
  /**
   * Row editing, absent entirely when the table cannot be edited — no primary
   * key, a view, or someone else's table. Absent rather than disabled: a grid
   * full of greyed-out controls on a view is a dead end that looks like a fault,
   * and the banner above already says why.
   */
  onUpdateRow?: (row: Record<string, unknown>,
                 changes: { column: string; value: CellValue }[]) => void;
  onInsertRow?: () => void;
  onDeleteRows?: (rows: Record<string, unknown>[]) => void;
  /** The key of a row just inserted, so it can be found after the refetch. */
  newRowKey?: string | null;
}) {
  const [showSql, setShowSql] = useState(false);
  const { columns, rows, page, pageSize } = props;

  /**
   * Selection, and which row is being edited, keyed by the row's **index on
   * this page**.
   *
   * By index rather than by primary key, deliberately: the grid also has to work
   * on a table with no key, where every affordance that needs one is absent but
   * the rows still render. Keying selection by something that may not exist
   * would mean two code paths for one list. Both sets are cleared whenever the
   * page changes, which the caller does by re-rendering with new rows.
   */
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, CellValue>>({});

  const editable = props.onUpdateRow !== undefined;
  const selectable = props.onDeleteRows !== undefined;

  /**
   * Which columns a person may type into.
   *
   * A generated identity column and a primary key are excluded, for different
   * reasons. An identity column's value is the database's to choose. A primary
   * key *can* be updated in SQL and doing it from a grid is a trap: the
   * statement's own `WHERE` targets the old value, so the row it just renamed is
   * no longer the row it was told to change, and a second save would edit
   * nothing. The DDL flow is where a key gets restructured.
   */
  const canType = (c: IntrospectionColumn) => !c.is_identity && !c.is_primary_key;

  const startEdit = (i: number) => {
    setEditing(i);
    setDraft({});
  };
  const cancelEdit = () => { setEditing(null); setDraft({}); };

  /**
   * A cell's value as the *row* has it, rendered the way a text field shows it.
   *
   * Deliberately ignores the draft: it is the baseline the draft is compared
   * against. An earlier version returned the draft when there was one, which
   * made `changesFor` compare every draft to itself and report nothing as
   * changed — the save button would have been permanently disabled.
   */
  const cellOf = (row: Record<string, unknown>, name: string): CellValue => {
    const v = row[name];
    if (v === null || v === undefined) return { kind: 'null' };
    return { kind: 'value', text: typeof v === 'object' ? JSON.stringify(v) : String(v) };
  };

  /** What the field should show: the draft if there is one, else the row's value. */
  const shownOf = (row: Record<string, unknown>, name: string): CellValue =>
    draft[name] ?? cellOf(row, name);

  /**
   * Only the columns that actually changed.
   *
   * Compared against the rendered original rather than against the row object,
   * so a `jsonb` value the user did not touch is not re-sent as its
   * re-serialised string — which would rewrite the column with different
   * whitespace and count as a change nobody made.
   */
  const changesFor = (row: Record<string, unknown>) => {
    const out: { column: string; value: CellValue }[] = [];
    for (const c of columns) {
      const draftValue = draft[c.name];
      if (!draftValue) continue;
      const original = cellOf(row, c.name);
      const same = draftValue.kind === original.kind
        && (draftValue.kind !== 'value' || draftValue.text === (original as { text: string }).text);
      if (!same) out.push({ column: c.name, value: draftValue });
    }
    return out;
  };

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
        {props.onInsertRow ? (
          /* Secondary, not accent: this page's one accent belongs to "Enable
             RLS" when RLS is off and "Add column" otherwise, and §5 rule 1
             allows one per view. */
          <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                  onClick={props.onInsertRow}>
            Insert row
          </button>
        ) : null}
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
              ? 'This table has no rows yet.'
              : 'The rows ran out before this page. Go back a page.'}
          </div>
          {/* §6: an empty state carries the action that fixes it. */}
          {page === 0 && props.onInsertRow ? (
            <button type="button" className="sh-btn sh-btn--sm"
                    style={{ marginTop: 'var(--sh-space-16)' }}
                    onClick={props.onInsertRow}>
              Insert a row
            </button>
          ) : null}
        </div></div>
      ) : (
        // The grid is the one place in this app that may scroll sideways: a table
        // with forty columns is wider than any window, and squeezing it is what
        // makes a cell unreadable. Scoped to this container so the *page* never
        // scrolls (D-460).
        <div>
          {/**
            * The selection bar, in the flow above the grid rather than floating
            * over it. A floating bar covers rows, and the rows it covers are the
            * ones next to the selection — exactly what someone is checking
            * before they delete.
            */}
          {selectable && selected.size > 0 ? (
            <div className="gridbar" role="status">
              <span>
                {selected.size} {selected.size === 1 ? 'row' : 'rows'} selected
              </span>
              <span className="gridbar__spacer" />
              <button type="button" className="sh-linkbtn"
                      onClick={() => setSelected(new Set())}>
                Clear
              </button>
              <button type="button" className="sh-btn sh-btn--sm sh-btn--danger"
                      onClick={() => props.onDeleteRows!(
                        [...selected].sort((a, b) => a - b)
                          .map((i) => rows![i]!).filter(Boolean))}>
                Delete {selected.size === 1 ? 'row' : `${selected.size} rows`}…
              </button>
            </div>
          ) : null}

          {/* The grid is the one place in this app that may scroll sideways: a
              table with forty columns is wider than any window, and squeezing it
              is what makes a cell unreadable. Scoped to this container so the
              *page* never scrolls (D-460). */}
          <div className="gridwrap">
          <table className="sh-table grid">
            <thead>
              <tr>
                {selectable ? (
                  <th scope="col" className="grid__select">
                    {/* Select-all across *this page*, which is what it can
                        honestly do — it has no other rows to select. The
                        indeterminate state is the third one the design system's
                        inventory asks for and nothing could draw until now. */}
                    <Checkbox
                      label={`Select all ${rows?.length ?? 0} rows on this page`}
                      checked={selected.size > 0 && selected.size === rows?.length}
                      indeterminate={selected.size > 0 && selected.size !== rows?.length}
                      onChange={(on) => setSelected(
                        on ? new Set((rows ?? []).map((_, i) => i)) : new Set())} />
                  </th>
                ) : null}
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
                {editable ? (
                  <th scope="col" className="td-actions">
                    <span className="sh-sr">Edit</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows?.map((row, i) => {
                const isEditing = editing === i;
                const isSelected = selected.has(i);
                const isNew = props.newRowKey !== undefined && props.newRowKey !== null
                  && props.primaryKey.length > 0
                  && String(row[props.primaryKey[0]!]) === props.newRowKey;
                const changes = isEditing ? changesFor(row) : [];
                return (
                  <tr key={i}
                      className={`${isSelected ? 'is-selected ' : ''}${
                        isEditing ? 'is-editing ' : ''}${isNew ? 'is-new' : ''}`.trim()
                        || undefined}>
                    {selectable ? (
                      <td className="grid__select">
                        <Checkbox
                          label={`Select row ${page * pageSize + i + 1}`}
                          checked={isSelected}
                          onChange={(on) => setSelected((prev) => {
                            const next = new Set(prev);
                            if (on) next.add(i); else next.delete(i);
                            return next;
                          })} />
                      </td>
                    ) : null}
                    {columns.map((c, ci) => (
                      <td key={c.name}>
                        {isEditing ? (
                          canType(c) ? (
                            <>
                              <input className="grid__cellinput"
                                     aria-label={`${c.name} of row ${page * pageSize + i + 1}`}
                                     autoComplete="off" spellCheck={false}
                                     autoFocus={ci === columns.findIndex(canType)}
                                     disabled={shownOf(row, c.name).kind === 'null'}
                                     value={(() => {
                                       const v = shownOf(row, c.name);
                                       return v.kind === 'value' ? v.text : '';
                                     })()}
                                     onChange={(e) => setDraft((d) => ({
                                       ...d, [c.name]: { kind: 'value', text: e.target.value },
                                     }))} />
                              {/* The null control, only where null is legal.
                                  Offering it on a NOT NULL column would be
                                  offering a statement the database will refuse. */}
                              {c.nullable ? (
                                <label className="grid__cellnull">
                                  <Checkbox
                                    label={`Set ${c.name} to null`}
                                    checked={shownOf(row, c.name).kind === 'null'}
                                    onChange={(on) => setDraft((d) => ({
                                      ...d,
                                      [c.name]: on
                                        ? { kind: 'null' }
                                        : { kind: 'value', text: '' },
                                    }))} />
                                  <span>null</span>
                                </label>
                              ) : null}
                            </>
                          ) : (
                            /* A key or an identity column: shown, not typed. The
                               key is what the statement targets, so editing it
                               here would make the row it renamed no longer the
                               row it was told to change. */
                            <span className="grid__cellfixed">
                              <Cell value={row[c.name]} />
                            </span>
                          )
                        ) : (
                          <Cell value={row[c.name]} />
                        )}
                      </td>
                    ))}
                    {editable ? (
                      <td className="td-actions">
                        {isEditing ? (
                          <span className="grid__rowactions">
                            <button type="button"
                                    className="sh-btn sh-btn--sm sh-btn--secondary"
                                    onClick={cancelEdit}>
                              Cancel
                            </button>
                            <button type="button" className="sh-btn sh-btn--sm"
                                    disabled={changes.length === 0}
                                    onClick={() => props.onUpdateRow!(row, changes)}>
                              {changes.length === 0
                                ? 'No changes'
                                : `Save ${changes.length}`}
                            </button>
                          </span>
                        ) : (
                          <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                                  onClick={() => startEdit(i)}>
                            Edit
                          </button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
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
