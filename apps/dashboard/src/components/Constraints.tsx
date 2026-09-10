'use client';

import { Menu, MenuItem } from './Menu.tsx';
import { mergeRows } from '../lib/table-objects.ts';
import type { IntrospectionConstraint, IntrospectionIndex } from '../lib/api.ts';

/**
 * A table's indexes and constraints, in **one** section.
 *
 * One, not two, and the payload is what decided it. Every primary key and unique
 * constraint has a backing index of the same name, so two tables list the same
 * object twice — measured on a real project, `articles_pkey`,
 * `articles_notes_key`, `fk_target_pkey` and `no_key_pkey` were all in both
 * lists. A reader seeing `articles_pkey` under "Indexes" and again under
 * "Constraints" reasonably wonders whether there are two of them.
 *
 * Folding constraints into the Structure table instead — a column's constraints
 * beside it — fails for a different reason: a table-level `CHECK` belongs to no
 * column and a composite `UNIQUE` belongs to several, so either they are lost or
 * they are duplicated across rows.
 *
 * So: one list, reconciled. A constraint is a row; an index that exists only to
 * back a constraint is *not* a second row, it is named on the constraint's row.
 * That is what `\\d` does, and it is the only arrangement where the count at the
 * top of the section is the number of things that exist.
 */

const LABEL: Record<string, string> = {
  primary_key: 'primary key',
  foreign_key: 'foreign key',
  unique: 'unique',
  check: 'check',
  exclusion: 'exclusion',
  index: 'index',
};

/** `['a', null, 'b']` reads as `a, (expression), b`. */
function columnList(columns: (string | null)[]): string {
  if (columns.length === 0) return '—';
  return columns.map((c) => c ?? '(expression)').join(', ');
}

export function Constraints(props: {
  indexes: IntrospectionIndex[];
  constraints: IntrospectionConstraint[];
  truncated: boolean;
  onDrop?: (row: { name: string; kind: string; invalid: boolean }) => void;
  onNewIndex?: () => void;
  readOnlyReason?: string;
}) {
  const rows = mergeRows(props.indexes, props.constraints);
  const invalid = rows.filter((r) => r.invalid);

  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">Indexes and constraints</h2>
        <p className="section__note">
          {rows.length === 0
            ? 'none'
            : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`}
          {props.readOnlyReason ? ` · ${props.readOnlyReason}` : ''}
        </p>
        {props.onNewIndex ? (
          <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                  onClick={props.onNewIndex}>
            New index
          </button>
        ) : null}
      </div>

      {props.truncated ? (
        <div className="sh-banner sh-banner--warning" role="status"
             style={{ marginBottom: 'var(--sh-space-12)' }}>
          <div className="sh-banner__body">
            <div className="sh-banner__title">Some entries are not listed</div>
            <div className="sh-banner__text">
              This database has more indexes or constraints than the schema
              payload carries, so this list may be missing some of this
              table&rsquo;s.
            </div>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="emptywrap"><div className="sh-empty">
          <div className="sh-empty__title">No indexes or constraints</div>
          <div className="sh-empty__text">
            {/* Which is worth saying rather than leaving blank: a table with no
                primary key is the state the grid above refuses to edit, and this
                is the second place that becomes visible. */}
            Nothing constrains what can be written here, and every query reads the
            whole table. A primary key is usually the first thing to add.
          </div>
        </div></div>
      ) : (
        <>
          {invalid.length > 0 ? (
            /**
             * An invalid index is not an error and is not fine.
             *
             * A failed `CREATE INDEX CONCURRENTLY` leaves one behind that
             * Postgres will not use for any query and will not clean up: it
             * costs write time and disk on every insert and serves nothing.
             * Nothing in this product can create one — the console emits the
             * plain form, because CONCURRENTLY cannot run in a transaction — so
             * it arrives from the customer's own psql session, where nothing told
             * them.
             *
             * A badge alone is too quiet for something silently costing writes;
             * a red banner is too loud for something that is not a security
             * hole. A status banner naming them, with the drop verb on each row,
             * is the shape — §6's "an empty state carries the action that fixes
             * it" applied to a broken one.
             */
            <div className="sh-banner sh-banner--warning" role="status"
                 style={{ marginBottom: 'var(--sh-space-12)' }}>
              <div className="sh-banner__body">
                <div className="sh-banner__title">
                  {invalid.length === 1
                    ? 'One index is invalid'
                    : `${invalid.length} indexes are invalid`}
                </div>
                <div className="sh-banner__text">
                  Postgres will not use{' '}
                  {invalid.map((r) => r.name).join(', ')} for any query, and still
                  pays for {invalid.length === 1 ? 'it' : 'them'} on every write.
                  That is what a <code style={{ font: 'var(--sh-code)' }}>CREATE
                  INDEX CONCURRENTLY</code> that failed part-way leaves behind.
                  Dropping {invalid.length === 1 ? 'it' : 'them'} is the only way
                  to be rid of {invalid.length === 1 ? 'it' : 'them'}.
                </div>
              </div>
            </div>
          ) : null}

          <div className="tablewrap">
            <table className="sh-table structure">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Columns</th>
                  <th scope="col">Definition</th>
                  {props.onDrop ? (
                    <th scope="col" className="td-actions">
                      <span className="sh-sr">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.kind}:${r.name}`}>
                    <td>
                      <span className="structure__name">{r.name}</span>
                      <span className="structure__flags">
                        {r.invalid ? (
                          <span className="tablelist__tag tablelist__tag--warn">
                            invalid
                          </span>
                        ) : null}
                        {r.kind === 'index' && r.unique ? (
                          <span className="tablelist__tag">unique</span>
                        ) : null}
                      </span>
                    </td>
                    <td>
                      {LABEL[r.kind] ?? r.kind}
                      {/* Said once, on the constraint's row, instead of listing
                          the index again as though it were a separate object. */}
                      {r.backedBy ? (
                        <div className="sh-help" style={{ margin: 0 }}>
                          with its own index
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span className="structure__type">{columnList(r.columns)}</span>
                      {r.references ? (
                        <div className="sh-help" style={{ margin: 0 }}>
                          → {r.references}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {/* The verbatim definition, which is the only
                          representation that is right for every kind — an
                          expression index and a CHECK have no column list that
                          says what they do. */}
                      <code className="structure__default" title={r.definition}>
                        {r.definition}
                      </code>
                    </td>
                    {props.onDrop ? (
                      <td className="td-actions">
                        <Menu label={`Actions for ${r.name}`} align="right"
                              trigger={({ toggle, ref, open }) => (
                                <button ref={ref} type="button" className="rowbtn"
                                        aria-expanded={open} aria-haspopup="menu"
                                        onClick={toggle}>
                                  <span aria-hidden="true">⋯</span>
                                  <span className="sh-sr">Actions for {r.name}</span>
                                </button>
                              )}>
                          {(close) => (
                            <MenuItem tone="danger"
                                      onSelect={() => {
                                        close();
                                        props.onDrop!({
                                          name: r.name, kind: r.kind,
                                          invalid: r.invalid,
                                        });
                                      }}>
                              {r.kind === 'index' ? 'Drop index…' : 'Drop constraint…'}
                            </MenuItem>
                          )}
                        </Menu>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
