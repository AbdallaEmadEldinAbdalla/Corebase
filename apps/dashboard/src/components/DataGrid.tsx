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
  /** Re-read this page. */
  onRefresh?: () => void;
  /**
   * The RLS state as a toolbar control — the *affordance*, not the warning.
   *
   * An earlier version of this comment argued that a banner "says read this
   * before the rows, and the rows are what the user came for", and used that to
   * replace the banner entirely. Half right. For an enabled table the toolbar
   * chip is the correct weight: `RLS · 3 policies` is a status, and status
   * belongs beside the data it governs. For a **disabled** table it was wrong,
   * and the spec says so in its own words — "Red banner across the table view" —
   * because the fact that matters there is not the acronym but the consequence,
   * and `RLS off` in a 70px button states neither. The banner is the page's job
   * (`deckwarn`), since only the page knows the table is ours to fix.
   */
  rls?: { enabled: boolean; policyCount: number; active: boolean; onOpen: () => void };
  /**
   * The other disclosure buttons — structure, indexes and constraints.
   *
   * Generic rather than two more named props, because these are the same
   * control: a toggle that opens `panel` below the toolbar. The IA puts
   * structure on this page (`/[schema]/[table] → grid + structure + RLS panel`)
   * and a disclosure is how it fits beside a full-height grid.
   */
  tools?: { label: string; active: boolean; onToggle: () => void }[];
  /**
   * Whatever a disclosure button opened, rendered between the toolbar and the
   * rows.
   *
   * A prop rather than the page rendering it, because "between the toolbar and
   * the rows" is a position only this component can offer: it emits both, and a
   * sibling in the page can only land before or after the pair.
   */
  panel?: React.ReactNode;
}) {
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
    <>
      {/**
        * The toolbar: outside the scroll container, so it stays put while the
        * rows move.
        *
        * That is the difference between a control strip and a heading, and it is
        * why this replaced a `.section__head`: a heading may scroll away, and a
        * control you might need on row 400 may not. The reference — Supabase's
        * grid — puts sort, RLS, the role and Insert in one 40px row and never
        * moves it.
        */}
      <div className="deckbar">
        <button type="button" className={`tbtn${props.sort ? ' tbtn--on' : ''}`}
                onClick={() => { if (props.sort) props.onSort(props.sort.column); }}
                disabled={!props.sort}
                title={props.sort
                  ? `Sorted by ${props.sort.column} ${props.sort.direction} — click to reverse`
                  : 'Click a column header to sort'}>
          {props.sort ? `Sorted by ${props.sort.column}` : 'Sort'}
        </button>

        {props.rls ? (
          <button type="button" aria-expanded={props.rls.active}
                  className={`tbtn${props.rls.enabled ? '' : ' tbtn--danger'}`
                    + `${props.rls.active ? ' tbtn--on' : ''}`}
                  onClick={props.rls.onOpen}>
            {props.rls.enabled
              ? `RLS · ${props.rls.policyCount} ${props.rls.policyCount === 1 ? 'policy' : 'policies'}`
              : 'RLS off'}
          </button>
        ) : null}

        {(props.tools ?? []).map((t) => (
          <button key={t.label} type="button" aria-expanded={t.active}
                  className={`tbtn${t.active ? ' tbtn--on' : ''}`}
                  onClick={t.onToggle}>
            {t.label}
          </button>
        ))}

        <span className="deckbar__spacer" />

        {selectable && selected.size > 0 ? (
          <>
            <span className="dtable__muted">{selected.size} selected</span>
            <button type="button" className="tbtn"
                    onClick={() => setSelected(new Set())}>
              Clear
            </button>
            <button type="button" className="tbtn tbtn--danger"
                    onClick={() => props.onDeleteRows!(
                      [...selected].sort((a, b) => a - b)
                        .map((i) => rows![i]!).filter(Boolean))}>
              Delete {selected.size}
            </button>
          </>
        ) : null}

        {props.onRefresh ? (
          <button type="button" className="tbtn" onClick={props.onRefresh}
                  title="Re-read this page of rows">
            Refresh
          </button>
        ) : null}
        {props.onInsertRow ? (
          <button type="button" className="tbtn tbtn--accent" onClick={props.onInsertRow}>
            + Insert
          </button>
        ) : null}
      </div>

      {props.panel}

      <div className="deckgrid">
      {props.primaryKey.length === 0 ? (
        <div className="sh-banner sh-banner--warning" role="status"
             style={{ margin: 'var(--sh-space-12)' }}>
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
        <>
          {/* The grid is the one place in this app that may scroll sideways: a
              table with forty columns is wider than any window, and squeezing it
              is what makes a cell unreadable. Scoped to this container so the
              *page* never scrolls (D-460). */}
          <div className="dwrap">
          <table className="dtable dtable--grid grid">
            <thead>
              <tr>
                {selectable ? (
                  <th scope="col" className="dtable__sel">
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
                    <th scope="col" key={c.name} title={`${c.name} · ${c.type}`}>
                      <button type="button" className="dtable__sort"
                              onClick={() => props.onSort(c.name)}
                              aria-label={`Sort by ${c.name}`}>
                        <span className="dtable__colname">{c.name}</span>
                        {/* The type stays in the header because it is what a
                            developer needs while reading the values — but on one
                            line now. Nullability and the key moved to the
                            Structure section, which has room for them: three
                            annotations in a 120px header is what wrapped it. */}
                        <span className="dtable__coltype">{c.type}</span>
                        <span className="dtable__arrow" aria-hidden="true">
                          {active ? (props.sort!.direction === 'asc' ? '↑' : '↓') : ''}
                        </span>
                      </button>
                    </th>
                  );
                })}
                {editable ? (
                  <th scope="col" className="dtable__act">
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
                      <td className="dtable__sel">
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
                      <td className="dtable__act">
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
        </>
      )}
      </div>

      {/**
        * Pinned below the rows: paging left, counts right.
        *
        * The counts say *which* number they are, because `~250` and `250` mean
        * different things and showing one as the other invents precision (Q19).
        * "Count" runs `count(*)` and says so on hover — an estimate you cannot
        * escape is worse than one you can, and a scan that happens without
        * warning is worse than both.
        */}
      <div className="deckfoot">
        <button type="button" className="pgbtn" aria-label="Previous page"
                disabled={page === 0} onClick={() => props.onPage(page - 1)}>
          <span aria-hidden="true">&lsaquo;</span>
        </button>
        <span>Page {page + 1}</span>
        <button type="button" className="pgbtn" aria-label="Next page"
                disabled={!maybeMore} onClick={() => props.onPage(page + 1)}>
          <span aria-hidden="true">&rsaquo;</span>
        </button>
        <span className="dtable__muted">{pageSize} rows</span>
        <span className="deckfoot__spacer" />
        <span>
          {rows !== null && rows.length > 0
            ? `${from.toLocaleString()}–${to.toLocaleString()} of ` : ''}
          {rowCount(props.rowsEstimate, props.exactCount)}
        </span>
        {props.exactCount === null ? (
          <button type="button" className="tbtn" onClick={props.onCountExactly}
                  title="Runs count(*), which scans the table">
            Count exactly
          </button>
        ) : null}
      </div>

    </>
  );
}
