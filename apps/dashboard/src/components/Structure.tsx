'use client';

import { Menu, MenuItem } from './Menu.tsx';
import type { IntrospectionColumn } from '../lib/api.ts';

/**
 * A table's columns, as a table, with one action column.
 *
 * §4's threshold decides this and there is nothing arguable about it: six
 * attributes worth comparing across every row (name, type, nullability, default,
 * key, comment) is a table, so there is no view toggle and nothing to remember.
 *
 * The verbs live in a **menu**, one per row, and that is the part worth
 * explaining. Five buttons in a 52px row is precisely the squeeze that took the
 * members table apart, and the alternative that suggests itself — put the verbs
 * in the grid's column headers, where the type already is — cannot work: the
 * header is already a `<button>` for sorting, and a menu inside a button is
 * invalid HTML with no focus behaviour worth having.
 *
 * `Menu` is used rather than hand-rolled markup because it carries the keyboard
 * contract (Escape closes and returns focus to the trigger, arrows move, Home
 * and End jump) and forgetting one of those once per menu is how a dashboard
 * ends up pointer-only.
 */

export type ColumnVerb =
  | 'rename' | 'type' | 'not_null' | 'nullable' | 'default' | 'drop_default' | 'drop';

export function Structure(props: {
  columns: IntrospectionColumn[];
  /** True when introspection's column cap cut this table's list short. */
  truncated: boolean;
  /** Absent for a view, whose columns cannot be altered. */
  onVerb?: (verb: ColumnVerb, column: IntrospectionColumn) => void;
  onAddColumn?: () => void;
  /** Why the verbs are absent, when they are. Rendered instead of the menu. */
  readOnlyReason?: string;
}) {
  const { columns, onVerb } = props;

  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Structure</h2>
        <p className="section__note">
          {columns.length} {columns.length === 1 ? 'column' : 'columns'}
          {props.readOnlyReason ? ` · ${props.readOnlyReason}` : ''}
        </p>
        {props.onAddColumn ? (
          /* The main pane's one accent action — unless RLS is off, in which case
             the page hands the accent to that banner instead and this becomes
             secondary. The page decides, because §5 rule 1 is about the *view*. */
          <button type="button" className="sh-btn sh-btn--sm" onClick={props.onAddColumn}>
            Add column
          </button>
        ) : null}
      </div>

      {props.truncated ? (
        /**
         * §4: never truncate silently.
         *
         * This was already true on the read path and already unsaid: the server
         * caps the column list at 20,000 across the whole database and reports
         * `truncated.columns`, and the grid filtered that list without ever
         * checking the flag — so a table past the cap rendered with columns
         * missing and no sign of it. A grid quietly missing a column is worse
         * than an error, because the user concludes the column was dropped.
         */
        <div className="sh-banner sh-banner--warning" role="status"
             style={{ marginBottom: 'var(--sh-space-12)' }}>
          <div className="sh-banner__body">
            <div className="sh-banner__title">Some columns are not listed</div>
            <div className="sh-banner__text">
              This database has more columns than the schema payload carries, so
              this list — and the grid above it — may be missing some of this
              table&rsquo;s. The SQL editor can read the full catalog.
            </div>
          </div>
        </div>
      ) : null}

      <div className="dwrap">
        {/* One line per cell, and the widths say which column gives way. Every
            cell carries its full value on `title`, because ellipsising without
            a way to read the whole thing is hiding it. */}
        <table className="dtable">
          <colgroup>
            <col style={{ width: '30%', minWidth: 150 }} />
            <col style={{ width: '22%', minWidth: 130 }} />
            <col style={{ width: 90 }} />
            <col />
            {onVerb ? <col style={{ width: 48 }} /> : null}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Nullable</th>
              <th scope="col">Default</th>
              {onVerb ? (
                <th scope="col" className="dtable__act">
                  <span className="sh-sr">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {columns.map((c) => (
              <tr key={c.name}>
                <td className="dtable__mono" title={c.comment ?? c.name}>
                  {c.name}
                  {c.is_primary_key ? <span className="dtable__tag">pk</span> : null}
                  {c.is_identity ? <span className="dtable__tag">identity</span> : null}
                </td>
                <td className="dtable__mono dtable__muted" title={c.type}>{c.type}</td>
                {/* The word, not a tick. State is never colour or shape alone
                    (§5 rule 2), and "no" beside a nullable column reads wrong
                    either way round — so the cell says which it is. */}
                <td className="dtable__muted">{c.nullable ? 'yes' : 'no'}</td>
                <td className="dtable__mono dtable__muted" title={c.default ?? 'none'}>
                  {c.default === null
                    ? <span className="grid__null">none</span>
                    : c.default}
                </td>
                {onVerb ? (
                  <td className="dtable__act">
                    <Menu label={`Change column ${c.name}`} align="right"
                          trigger={({ toggle, ref, open }) => (
                            <button ref={ref} type="button" className="rowbtn"
                                    aria-expanded={open} aria-haspopup="menu"
                                    onClick={toggle}>
                              <span aria-hidden="true">&#8943;</span>
                              <span className="sh-sr">Change column {c.name}</span>
                            </button>
                          )}>
                      {(close) => (
                        <>
                          <MenuItem onSelect={() => { close(); onVerb('rename', c); }}>
                            Rename column…
                          </MenuItem>
                          <MenuItem onSelect={() => { close(); onVerb('type', c); }}>
                            Change type…
                          </MenuItem>
                          {/* Only the direction that is available. Offering
                              "Set NOT NULL" on a column that already is one is a
                              menu item whose only outcome is a Postgres notice. */}
                          {c.nullable ? (
                            <MenuItem onSelect={() => { close(); onVerb('not_null', c); }}>
                              Set NOT NULL
                            </MenuItem>
                          ) : (
                            <MenuItem onSelect={() => { close(); onVerb('nullable', c); }}>
                              Allow null
                            </MenuItem>
                          )}
                          <MenuItem onSelect={() => { close(); onVerb('default', c); }}>
                            {c.default === null ? 'Set a default…' : 'Change the default…'}
                          </MenuItem>
                          {c.default !== null ? (
                            <MenuItem onSelect={() => { close(); onVerb('drop_default', c); }}>
                              Remove the default
                            </MenuItem>
                          ) : null}
                          <div className="sh-menu__sep" />
                          <MenuItem tone="danger"
                                    onSelect={() => { close(); onVerb('drop', c); }}>
                            Drop column…
                          </MenuItem>
                        </>
                      )}
                    </Menu>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
