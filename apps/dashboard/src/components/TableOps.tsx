'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { DdlDialog } from './DdlDialog.tsx';
import { Checkbox } from './Checkbox.tsx';
import { useToast } from './Toasts.tsx';
import { keys, useRunSql } from '../lib/queries.ts';
import type { IntrospectionColumn } from '../lib/api.ts';
import { deleteRows, insertRow, updateRow, type CellValue } from '../lib/dml.ts';
import {
  addCheck, addColumn, addForeignKey, addPrimaryKey, addUnique, changeType,
  createIndex, createTable, dropColumn, dropConstraint, dropDefault, dropIndex,
  dropNotNull, dropTable, enableRls, grantAnonRead, renameColumn, renameTable,
  revokeAnonAccess, setDefault, setNotNull,
  type NewColumn, type Plan, type TableFacts,
} from '../lib/ddl.ts';
import type { RowPlan } from '../lib/dml.ts';

/**
 * Every table-editor operation's form, and the one place that runs them.
 *
 * One component rather than one per operation, because what they share is the
 * expensive part: the loop, the ladder, the toast, the invalidation, and the
 * decision about where the user ends up afterwards. What differs is three or four
 * fields. Splitting by operation would mean twelve components each re-deciding
 * how to report a failure.
 *
 * The forms are deliberately plain. A type is a **text field**, not a select, and
 * that is a decision rather than laziness: Postgres has hundreds of types plus
 * every one the customer has created, `numeric(10,2)` and `varchar(40)` carry
 * parameters no dropdown can express, and D-133's whole position is that this
 * editor is a SQL generator for people who are learning to read SQL. A select
 * offering fifteen types would be a smaller product wearing a friendlier
 * costume. The common types are offered as a datalist, which suggests without
 * restricting.
 */

export type Op =
  | { kind: 'create_table' }
  | { kind: 'add_column' }
  | { kind: 'rename_table' }
  | { kind: 'drop_table' }
  | { kind: 'enable_rls' }
  | { kind: 'add_primary_key'; candidates: IntrospectionColumn[] }
  | { kind: 'grant_anon' }
  | { kind: 'revoke_anon' }
  | { kind: 'create_index'; candidates: IntrospectionColumn[] }
  | { kind: 'add_unique'; candidates: IntrospectionColumn[] }
  | { kind: 'add_check' }
  | { kind: 'drop_index'; name: string; invalid: boolean }
  | { kind: 'drop_constraint'; name: string; constraintKind: string }
  /**
   * The three row operations. They carry their rows rather than looking them up,
   * because the grid holds the page the user is actually looking at — and a
   * refetch between opening the dialog and confirming must not silently change
   * which rows the statement names.
   */
  | { kind: 'update_row'; row: Record<string, unknown>;
      changes: { column: string; value: CellValue }[]; primaryKey: readonly string[] }
  | { kind: 'insert_row'; editable: IntrospectionColumn[] }
  | { kind: 'delete_rows'; rows: Record<string, unknown>[];
      primaryKey: readonly string[] }
  /**
   * The foreign key needs the *other* table, so it carries the whole schema —
   * which introspection does provide. Only the fan-in warning's condition is
   * missing, because indexes are not in the payload.
   */
  | { kind: 'add_foreign_key';
      candidates: IntrospectionColumn[];
      targets: IntrospectionColumn[];
      /**
       * Column names that lead an index on this table, so the fan-in warning can
       * state its condition as fact instead of admitting it cannot check.
       *
       * Leading only. An index on `(a, b)` serves a lookup on `a` and not on
       * `b`, and an expression index serves neither — which is why the payload
       * reports `null` in that slot and the page filters on `columns[0]`.
       */
      indexedColumns: string[] }
  | { kind: 'rename_column'; column: IntrospectionColumn }
  | { kind: 'change_type'; column: IntrospectionColumn }
  | { kind: 'set_not_null'; column: IntrospectionColumn }
  | { kind: 'drop_not_null'; column: IntrospectionColumn }
  | { kind: 'set_default'; column: IntrospectionColumn }
  | { kind: 'drop_default'; column: IntrospectionColumn }
  | { kind: 'drop_column'; column: IntrospectionColumn };

/**
 * The types offered as suggestions.
 *
 * A `datalist`, so it is a shortcut and not a constraint — the field still takes
 * `numeric(10,2)`, `citext`, or a domain the customer defined. Ordered by how
 * often they are the right answer rather than alphabetically, because the first
 * three are most of what anyone types.
 */
const COMMON_TYPES = [
  'text', 'uuid', 'timestamptz', 'boolean', 'integer', 'bigint',
  'numeric(10,2)', 'jsonb', 'date', 'double precision', 'text[]', 'inet',
];

/** One `<datalist>` for the whole dialog, so its id is not duplicated. */
const TYPE_LIST = 'ddl-type-suggestions';

/**
 * A type field, defined at module scope — which is load-bearing, not tidiness.
 *
 * The first version declared this inside `TableOps`, so every render created a
 * *new component type*. React compares element types to decide whether to update
 * or remount, and a new type is a different component: the input unmounted and
 * remounted on every keystroke, which loses focus and the cursor position. The
 * form is driven by `useState`, so every render is a keystroke — the field would
 * have accepted exactly one character at a time.
 *
 * The same trap applies to the per-operation form below, which is why it is
 * called as a function rather than rendered as `<Form />`.
 */
function TypeInput({ value, onChange, id }: {
  value: string; onChange: (v: string) => void; id: string;
}) {
  return (
    <input id={id} className="sh-input" list={TYPE_LIST} value={value}
           autoComplete="off" spellCheck={false} placeholder="text"
           onChange={(e) => onChange(e.target.value)} />
  );
}

export function TableOps(props: {
  projectRef: string;
  op: Op;
  /** Absent only for `create_table`, which has no table yet. */
  facts?: TableFacts;
  schema: string;
  onClose: () => void;
  /**
   * A row operation finished. Carries the inserted row when there is one, so
   * the caller can highlight it.
   */
  onRowsChanged?: (inserted?: Record<string, unknown>) => void;
}) {
  const { op, facts, schema, projectRef, onClose } = props;
  const run = useRunSql(projectRef);
  const toast = useToast();
  const router = useRouter();
  const qc = useQueryClient();

  /**
   * One state bag for every form, keyed by nothing.
   *
   * The component is mounted with a `key` that includes the operation, so this
   * resets between operations rather than carrying the last drop's typed name
   * into the next rename. That is the same reset `ConfirmDialog` does with an
   * effect; a key is cheaper and cannot be forgotten.
   */
  const target = 'column' in op ? op.column : undefined;
  const [name, setName] = useState(
    op.kind === 'rename_column' ? (target?.name ?? '')
      : op.kind === 'rename_table' ? (facts?.table ?? '') : '');
  const [type, setType] = useState(op.kind === 'change_type' ? (target?.type ?? '') : 'text');
  const [using, setUsing] = useState('');
  const [expression, setExpression] = useState(target?.default ?? '');
  const [nullable, setNullable] = useState(true);
  const [columnDefault, setColumnDefault] = useState('');
  const [cascade, setCascade] = useState(false);
  const [newColumns, setNewColumns] = useState<NewColumn[]>([
    { name: '', type: 'text', nullable: true },
  ]);
  /**
   * The key's columns, pre-selected with the best guess.
   *
   * A column called `id` is the primary key in the overwhelming majority of
   * schemas, so guessing it saves a click — but only when it exists, and the
   * guess is visible and changeable rather than applied. `uuid` and integer
   * columns are not filtered out of the list: a text natural key is a legitimate
   * choice and a picker that hid it would be a picker imposing a schema opinion.
   */
  const [keyColumns, setKeyColumns] = useState<string[]>(() => {
    if (op.kind !== 'add_primary_key') return [];
    const id = op.candidates.find((c) => c.name === 'id');
    return id ? [id.name] : [];
  });
  const [unique, setUnique] = useState(false);
  /** `schema.table` of the referenced table, as one value so the select is one control. */
  const [target2, setTarget2] = useState('');
  const [targetCol, setTargetCol] = useState('');
  const [onDelete, setOnDelete] = useState('');
  /**
   * Off by default, and that is the honest default rather than the convenient
   * one: an index already covering this column under a different name is
   * invisible from here, so defaulting it on would quietly double some tables'
   * write cost.
   */
  const [alsoIndex, setAlsoIndex] = useState(false);
  /**
   * The insert form's values, keyed by column, **absent meaning "use the
   * default"**.
   *
   * Absent rather than an explicit `{kind:'default'}` per column, because that
   * is what an untouched field means and the compiler treats a defaulted column
   * by omitting it from the statement entirely — which is the difference between
   * getting `now()` for a `created_at not null default now()` and failing on a
   * not-null violation.
   */
  const [newRow, setNewRow] = useState<Record<string, CellValue>>({});

  /** The plan, rebuilt on every keystroke so the preview is never stale. */
  const plan = (): Plan | RowPlan => {
    switch (op.kind) {
      case 'create_table':
        return createTable(schema, name, newColumns.filter((c) => c.name.trim()));
      case 'add_column':
        return addColumn(facts!, {
          name, type, nullable,
          ...(columnDefault.trim() ? { default: columnDefault } : {}),
        });
      case 'rename_table': return renameTable(facts!, name);
      case 'drop_table': return dropTable(facts!, cascade);
      case 'enable_rls': return enableRls(facts!);
      case 'add_primary_key': return addPrimaryKey(facts!, keyColumns);
      case 'grant_anon': return grantAnonRead(facts!);
      case 'revoke_anon': return revokeAnonAccess(facts!);
      case 'create_index': return createIndex(facts!, keyColumns, { unique });
      case 'add_unique': return addUnique(facts!, keyColumns);
      case 'add_check': return addCheck(facts!, expression);
      case 'drop_index':
        return dropIndex(schema, op.name, { invalid: op.invalid });
      case 'drop_constraint':
        return dropConstraint(facts!, op.name, op.constraintKind);
      case 'update_row':
        return updateRow({ schema, table: facts!.table }, {
          row: op.row, primaryKey: op.primaryKey, changes: op.changes });
      case 'insert_row':
        return insertRow({ schema, table: facts!.table },
          op.editable.map((c) => ({
            column: c.name,
            value: newRow[c.name] ?? { kind: 'default' },
          })));
      case 'delete_rows':
        return deleteRows({ schema, table: facts!.table }, {
          rows: op.rows, primaryKey: op.primaryKey });
      case 'add_foreign_key': {
        const [ts, tt] = target2.split('.');
        return addForeignKey(facts!, {
          column: name,
          targetSchema: ts ?? 'public',
          targetTable: tt ?? '',
          targetColumn: targetCol,
          ...(onDelete ? { onDelete } : {}),
          alsoIndex,
          // Only once a column is chosen. Before that, `indexed` stays absent so
          // the notice reads as the honest unknown rather than as a false "no".
          ...(name ? { indexed: op.indexedColumns.includes(name) } : {}),
        });
      }
      case 'rename_column': return renameColumn(facts!, target!.name, name);
      case 'change_type': return changeType(facts!, target!.name, type, using);
      case 'set_not_null': return setNotNull(facts!, target!.name);
      case 'drop_not_null': return dropNotNull(facts!, target!.name);
      case 'set_default': return setDefault(facts!, target!.name, expression);
      case 'drop_default': return dropDefault(facts!, target!.name);
      case 'drop_column': return dropColumn(facts!, target!.name);
    }
  };

  const TITLES: Record<Op['kind'], string> = {
    create_table: 'New table',
    add_column: 'Add a column',
    rename_table: `Rename ${facts?.table ?? 'the table'}`,
    drop_table: `Drop ${facts?.table ?? 'the table'}`,
    enable_rls: 'Enable Row Level Security',
    add_primary_key: 'Add a primary key',
    grant_anon: 'Allow anonymous read',
    revoke_anon: 'Remove anonymous access',
    create_index: 'New index',
    add_unique: 'Require unique values',
    add_check: 'New check constraint',
    add_foreign_key: 'New foreign key',
    drop_index: 'Drop index',
    drop_constraint: 'Drop constraint',
    rename_column: `Rename ${target?.name ?? 'the column'}`,
    change_type: `Change the type of ${target?.name ?? 'the column'}`,
    set_not_null: `Require a value in ${target?.name ?? 'the column'}`,
    drop_not_null: `Allow null in ${target?.name ?? 'the column'}`,
    set_default: `Default for ${target?.name ?? 'the column'}`,
    drop_default: `Remove the default from ${target?.name ?? 'the column'}`,
    drop_column: `Drop ${target?.name ?? 'the column'}`,
    update_row: 'Save this row',
    insert_row: 'Insert a row',
    delete_rows: op.kind === 'delete_rows'
      ? `Delete ${op.rows.length === 1 ? 'this row' : `${op.rows.length} rows`}`
      : 'Delete rows',
  };

  const LABELS: Record<Op['kind'], string> = {
    create_table: 'Create table',
    add_column: 'Add column',
    rename_table: 'Rename table',
    drop_table: 'Drop table',
    enable_rls: 'Enable RLS',
    add_primary_key: 'Add primary key',
    grant_anon: 'Allow anonymous read',
    revoke_anon: 'Remove access',
    create_index: 'Create index',
    add_unique: 'Add constraint',
    add_check: 'Add constraint',
    add_foreign_key: 'Add foreign key',
    drop_index: 'Drop index',
    drop_constraint: 'Drop constraint',
    update_row: 'Save',
    insert_row: 'Insert',
    delete_rows: 'Delete',
    rename_column: 'Rename column',
    change_type: 'Change type',
    set_not_null: 'Set NOT NULL',
    drop_not_null: 'Allow null',
    set_default: 'Set default',
    drop_default: 'Remove default',
    drop_column: 'Drop column',
  };

  return (
    <DdlDialog
      open
      title={TITLES[op.kind]}
      confirmLabel={LABELS[op.kind]}
      onCancel={onClose}
      plan={plan}
      // `renderForm()`, not `<RenderForm />`: a component declared inside this
      // one gets a fresh type identity every render, and React remounts on a
      // type change — so every field in every form would lose focus after one
      // character.
      form={<>
        <datalist id={TYPE_LIST}>
          {COMMON_TYPES.map((t) => <option key={t} value={t} />)}
        </datalist>
        {renderForm()}
      </>}
      onRun={async ({ sql, params, confirmDestructive, confirmNames, edited }) => {
        const result = await run.mutateAsync({
          sql,
          ...(params.length > 0 ? { params } : {}),
          // Explicitly false. The console defaults to read-only nowhere, but
          // saying it here means a reader of this call site knows this is the
          // write path without going to look.
          read_only: false,
          ...(confirmDestructive ? { confirm_destructive: true } : {}),
          ...(confirmNames.length > 0 ? { confirm_names: confirmNames } : {}),
        });

        /**
         * The toast names what happened, and offers no Undo.
         *
         * §5 asks for the inverse "where an inverse exists", and for DDL it
         * mostly does not: a dropped column cannot come back. Where one does
         * exist it is itself destructive — the inverse of "add column" is "drop
         * column", a typed-name confirmation — and an Undo button that opens a
         * red dialog is not an undo. Offering it on the two reversible
         * operations and not the ten others would teach that the button means
         * "safe", which is the wrong lesson to teach with one wrong instance.
         */
        // `plan().done` describes what the *form* asked for, which is only the
        // truth when the form is what ran. Once the user has hand-edited the SQL
        // the operation's own summary is a guess about someone else's statement,
        // so it says the neutral thing instead.
        toast.show({
          tone: 'success',
          title: edited ? 'SQL run' : plan().done,
        });

        /**
         * Wait for the schema before navigating anywhere.
         *
         * `useRunSql` invalidates the introspection query, which marks it stale
         * and refetches in the background — so pushing straight to the new
         * table's URL arrives at a page whose cached schema does not contain it
         * yet, and the page correctly renders "No such table". A create that
         * flashes "No such table" reads as a create that failed.
         *
         * `refetchQueries` rather than `invalidateQueries`, because only the
         * former returns a promise that resolves when the data is actually
         * there. Failures are swallowed deliberately: the DDL *succeeded*, and a
         * refetch that could not complete is a reason to navigate a moment early
         * rather than to report the operation as failed.
         */
        if (op.kind === 'create_table' || op.kind === 'rename_table') {
          await qc.refetchQueries({ queryKey: keys.introspection(projectRef) })
            .catch(() => {});
        }

        /**
         * Row operations re-read the rows, which no cache invalidates.
         *
         * `useRunSql` invalidates the *schema* query when a DDL command runs,
         * and a row edit changes no schema — so nothing would refetch and the
         * grid would keep showing the values the user just replaced, which reads
         * as the save having failed. `onRowsChanged` is the page clearing its
         * fetch key so the effect that reads a page of rows fires again.
         *
         * An insert additionally reports the row it made, from `returning *`, so
         * the grid can point at it. Reported rather than inferred: a defaulted
         * `id` is only knowable from the database.
         */
        if (op.kind === 'update_row' || op.kind === 'insert_row'
          || op.kind === 'delete_rows') {
          const returned = result.results[0]?.rows?.[0] as
            Record<string, unknown> | undefined;
          props.onRowsChanged?.(op.kind === 'insert_row' && returned
            ? returned : undefined);
        }

        /**
         * Where the user ends up.
         *
         * Three operations move the subject and the rest do not (§3's subject
         * test). A rename changes the URL this page *is*, so staying would leave
         * a route pointing at a name that no longer exists — a 404 on the next
         * refresh. A drop removes the subject entirely. Everything else leaves
         * the user looking at the same table, so the dialog closes and the
         * invalidated query redraws underneath.
         */
        if (op.kind === 'rename_table') {
          router.replace(`/project/${projectRef}/table-editor/`
            + `${encodeURIComponent(schema)}/${encodeURIComponent(name)}`);
        } else if (op.kind === 'drop_table') {
          router.replace(`/project/${projectRef}/table-editor`);
        } else if (op.kind === 'create_table') {
          router.push(`/project/${projectRef}/table-editor/`
            + `${encodeURIComponent(schema)}/${encodeURIComponent(name)}`);
        }
        onClose();
      }}
    />
  );

  function renderForm() {
    switch (op.kind) {
      case 'create_table':
        return (
          <>
            <div className="sh-field">
              <label className="sh-label" htmlFor="ddl-tname">Name</label>
              <input id="ddl-tname" className="sh-input" value={name} autoFocus
                     autoComplete="off" spellCheck={false} placeholder="posts"
                     onChange={(e) => setName(e.target.value)} />
              <p className="sh-help">
                In the <code style={{ font: 'var(--sh-code)' }}>{schema}</code> schema.
                It becomes your REST path:{' '}
                <code style={{ font: 'var(--sh-code)' }}>
                  /rest/v1/{name || 'posts'}
                </code>
              </p>
            </div>
            {newColumns.map((c, i) => (
              <div className="sh-row" key={i} style={{ gap: 'var(--sh-space-12)' }}>
                <div className="sh-field" style={{ flex: 1, minWidth: 140 }}>
                  <label className="sh-label" htmlFor={`ddl-cn-${i}`}>Column</label>
                  <input id={`ddl-cn-${i}`} className="sh-input" value={c.name}
                         autoComplete="off" spellCheck={false} placeholder="title"
                         onChange={(e) => setNewColumns((cs) => cs.map((x, j) =>
                           j === i ? { ...x, name: e.target.value } : x))} />
                </div>
                <div className="sh-field" style={{ flex: 1, minWidth: 140 }}>
                  <label className="sh-label" htmlFor={`ddl-ct-${i}`}>Type</label>
                  <TypeInput id={`ddl-ct-${i}`} value={c.type}
                             onChange={(v) => setNewColumns((cs) => cs.map((x, j) =>
                               j === i ? { ...x, type: v } : x))} />
                </div>
                <div className="sh-field" style={{ flex: 'none' }}>
                  <span className="sh-label">Required</span>
                  {/* `sh-switch`, not `sh-check`: the check only tints the box the
                      operating system draws, which lands system metrics in a warm
                      clay palette (D-429). The switch hides the real input and
                      draws its own track, so the semantics are the browser's and
                      the pixels are ours. */}
                  <label className="sh-switch">
                    <input type="checkbox" checked={!c.nullable}
                           onChange={(e) => setNewColumns((cs) => cs.map((x, j) =>
                             j === i ? { ...x, nullable: !e.target.checked } : x))} />
                    <span className="sh-switch__track" aria-hidden="true" />
                    <span>NOT NULL</span>
                  </label>
                </div>
              </div>
            ))}
            <div>
              <button type="button" className="sh-btn sh-btn--sm sh-btn--secondary"
                      onClick={() => setNewColumns((cs) =>
                        [...cs, { name: '', type: 'text', nullable: true }])}>
                Another column
              </button>
              <p className="sh-help">
                {/* The defaults are in the preview, but saying it here is what
                    stops someone adding their own `id` beside the one they are
                    about to be given. */}
                Every table gets an <code style={{ font: 'var(--sh-code)' }}>id</code> and
                a <code style={{ font: 'var(--sh-code)' }}>created_at</code> — they are in
                the SQL below.
              </p>
            </div>
          </>
        );

      case 'add_column':
        return (
          <>
            <div className="sh-row" style={{ gap: 'var(--sh-space-12)' }}>
              <div className="sh-field" style={{ flex: 1, minWidth: 160 }}>
                <label className="sh-label" htmlFor="ddl-name">Name</label>
                <input id="ddl-name" className="sh-input" value={name} autoFocus
                       autoComplete="off" spellCheck={false} placeholder="status"
                       onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="sh-field" style={{ flex: 1, minWidth: 160 }}>
                <label className="sh-label" htmlFor="ddl-type">Type</label>
                <TypeInput id="ddl-type" value={type} onChange={setType} />
              </div>
            </div>
            <div className="sh-field">
              <label className="sh-label" htmlFor="ddl-default">Default (optional)</label>
              <input id="ddl-default" className="sh-input" value={columnDefault}
                     autoComplete="off" spellCheck={false} placeholder="'draft'"
                     onChange={(e) => setColumnDefault(e.target.value)} />
              <p className="sh-help">
                {/* The single most common mistake in this field, and the error it
                    produces names the type rather than the quotes. */}
                An expression, so a text value needs quotes:{' '}
                <code style={{ font: 'var(--sh-code)' }}>&apos;draft&apos;</code>, not{' '}
                <code style={{ font: 'var(--sh-code)' }}>draft</code>.
              </p>
            </div>
            <label className="sh-switch">
              <input type="checkbox" checked={!nullable}
                     onChange={(e) => setNullable(!e.target.checked)} />
              <span className="sh-switch__track" aria-hidden="true" />
              <span>Required (NOT NULL)</span>
            </label>
          </>
        );

      case 'rename_table':
      case 'rename_column':
        return (
          <div className="sh-field">
            <label className="sh-label" htmlFor="ddl-name">New name</label>
            <input id="ddl-name" className="sh-input" value={name} autoFocus
                   autoComplete="off" spellCheck={false}
                   onChange={(e) => setName(e.target.value)} />
          </div>
        );

      case 'change_type':
        return (
          <>
            <div className="sh-field">
              <label className="sh-label" htmlFor="ddl-type">New type</label>
              <TypeInput id="ddl-type" value={type} onChange={setType} />
              <p className="sh-help">
                Currently <code style={{ font: 'var(--sh-code)' }}>{target?.type}</code>.
              </p>
            </div>
            <div className="sh-field">
              <label className="sh-label" htmlFor="ddl-using">Conversion (optional)</label>
              <input id="ddl-using" className="sh-input" value={using}
                     autoComplete="off" spellCheck={false}
                     placeholder={`${target?.name}::${type || 'text'}`}
                     onChange={(e) => setUsing(e.target.value)} />
              <p className="sh-help">
                How each existing value becomes the new type. Left empty it is a
                straight cast, which fails on any row that cannot be converted —
                so <code style={{ font: 'var(--sh-code)' }}>
                  nullif({target?.name}, &apos;&apos;)::{type || 'numeric'}
                </code> is the usual fix for empty strings.
              </p>
            </div>
          </>
        );

      case 'set_default':
        return (
          <div className="sh-field">
            <label className="sh-label" htmlFor="ddl-expr">Default expression</label>
            <input id="ddl-expr" className="sh-input" value={expression} autoFocus
                   autoComplete="off" spellCheck={false} placeholder="'draft'"
                   onChange={(e) => setExpression(e.target.value)} />
            <p className="sh-help">
              An expression, not a value — <code style={{ font: 'var(--sh-code)' }}>now()</code>{' '}
              and <code style={{ font: 'var(--sh-code)' }}>gen_random_uuid()</code> work,
              and text needs quotes.
            </p>
          </div>
        );

      case 'add_primary_key':
        return (
          <div className="sh-field">
            <span className="sh-label">Columns in the key</span>
            {op.candidates.map((c) => (
              <label className="sh-switch" key={c.name}>
                <input type="checkbox" checked={keyColumns.includes(c.name)}
                       onChange={(e) => setKeyColumns((ks) => e.target.checked
                         // Appended rather than sorted: the *order* of a
                         // composite key decides which queries its index can
                         // serve, so the order the user ticks them is the order
                         // they get, and the preview shows it.
                         ? [...ks, c.name]
                         : ks.filter((k) => k !== c.name))} />
                <span className="sh-switch__track" aria-hidden="true" />
                <span>
                  {c.name}{' '}
                  <span className="structure__type">{c.type}</span>
                  {c.nullable ? <span className="sh-help"> · currently nullable</span> : null}
                </span>
              </label>
            ))}
            <p className="sh-help">
              Tick them in the order you want them in the key — for a composite
              key that order decides which queries its index can answer.
            </p>
          </div>
        );

      case 'create_index':
      case 'add_unique':
        return (
          <>
            <div className="sh-field">
              <span className="sh-label">Columns</span>
              {op.candidates.map((c) => (
                <label className="sh-switch" key={c.name}>
                  <input type="checkbox" checked={keyColumns.includes(c.name)}
                         onChange={(e) => setKeyColumns((ks) => e.target.checked
                           ? [...ks, c.name] : ks.filter((k) => k !== c.name))} />
                  <span className="sh-switch__track" aria-hidden="true" />
                  <span>{c.name} <span className="structure__type">{c.type}</span></span>
                </label>
              ))}
              <p className="sh-help">
                {/* The single most consequential thing about a multi-column
                    index, and the reason ticking order is preserved. */}
                Order matters: an index on (a, b) helps a query filtering on
                <code style={{ font: 'var(--sh-code)' }}> a </code>
                or on both, and not one filtering only on
                <code style={{ font: 'var(--sh-code)' }}> b</code>.
              </p>
            </div>
            {op.kind === 'create_index' ? (
              <label className="sh-switch">
                <input type="checkbox" checked={unique}
                       onChange={(e) => setUnique(e.target.checked)} />
                <span className="sh-switch__track" aria-hidden="true" />
                <span>Values must be unique</span>
              </label>
            ) : null}
          </>
        );

      case 'insert_row':
        return (
          <>
            {op.editable.map((c, i) => {
              const v = newRow[c.name];
              const isNull = v?.kind === 'null';
              const isDefault = v === undefined || v.kind === 'default';
              return (
                <div className="sh-field" key={c.name}>
                  <label className="sh-label" htmlFor={`ins-${c.name}`}>
                    {c.name}{' '}
                    <span className="structure__type">{c.type}</span>
                    {c.nullable ? null : (
                      <span className="sh-help"> · required</span>
                    )}
                  </label>
                  <input id={`ins-${c.name}`} className="sh-input"
                         autoComplete="off" spellCheck={false}
                         autoFocus={i === 0}
                         disabled={isNull}
                         placeholder={c.default !== null
                           /* The default shown as the placeholder, so an
                              untouched field visibly means "the database
                              decides" rather than "empty string". */
                           ? `default: ${c.default}`
                           : c.nullable ? 'null' : ''}
                         value={v?.kind === 'value' ? v.text : ''}
                         onChange={(e) => setNewRow((r) => ({
                           ...r,
                           [c.name]: e.target.value === ''
                             // Cleared means "leave it to the default" again,
                             // not "store an empty string" — the null toggle is
                             // how you ask for null, and this field is how you
                             // ask for a value.
                             ? { kind: 'default' }
                             : { kind: 'value', text: e.target.value },
                         }))} />
                  {c.nullable ? (
                    <label className="grid__cellnull">
                      <Checkbox label={`Set ${c.name} to null`} checked={isNull}
                                onChange={(on) => setNewRow((r) => ({
                                  ...r,
                                  [c.name]: on ? { kind: 'null' } : { kind: 'default' },
                                }))} />
                      <span>
                        null
                        {isDefault && c.default !== null ? ' (rather than the default)' : ''}
                      </span>
                    </label>
                  ) : null}
                </div>
              );
            })}
          </>
        );

      case 'add_check':
        return (
          <div className="sh-field">
            <label className="sh-label" htmlFor="ddl-check">Condition</label>
            <input id="ddl-check" className="sh-input" value={expression} autoFocus
                   autoComplete="off" spellCheck={false} placeholder="price >= 0"
                   onChange={(e) => setExpression(e.target.value)} />
            <p className="sh-help">
              An expression over this row&rsquo;s own columns. Every existing row
              has to satisfy it, or the statement fails and names the constraint.
            </p>
          </div>
        );

      case 'add_foreign_key': {
        // The distinct tables in the payload, as `schema.table`. Built from
        // *columns* rather than tables because we need its columns anyway, and a
        // table whose columns we cannot read is not one we can point at.
        const tables = [...new Set(op.targets.map((c) => `${c.schema}.${c.table}`))].sort();
        const cols = op.targets.filter((c) => `${c.schema}.${c.table}` === target2);
        /**
         * Text fields with suggestions, **not** the branded `Select`.
         *
         * Two reasons, and the first is a bug rather than a preference.
         * `Select` opens a `.pop__menu`, which is `position: absolute` — and
         * `.ddl__body` is `overflow-y: auto`, so an absolutely-positioned
         * descendant inside it is clipped by the scroll container. The last
         * picker in a four-field form would have opened a list with its bottom
         * cut off. Read off the stylesheet rather than seen, since no browser
         * was available; the mechanism is not in doubt.
         *
         * The second is that it is the better control here anyway. A project can
         * have hundreds of tables, and this module already argues the case for
         * the type field: a list you scroll is worse than a field you filter,
         * and this editor's stance is that you are learning to read SQL rather
         * than being kept away from it.
         */
        return (
          <>
            <div className="sh-field">
              <label className="sh-label" htmlFor="ddl-fkcol">Column in this table</label>
              <input id="ddl-fkcol" className="sh-input" list="ddl-fk-cols" value={name}
                     autoComplete="off" spellCheck={false} autoFocus
                     placeholder={op.candidates[0]?.name ?? 'author_id'}
                     onChange={(e) => setName(e.target.value)} />
              <datalist id="ddl-fk-cols">
                {op.candidates.map((c) => <option key={c.name} value={c.name} />)}
              </datalist>
            </div>
            <div className="sh-field">
              <label className="sh-label" htmlFor="ddl-fktable">Points at</label>
              <input id="ddl-fktable" className="sh-input" list="ddl-fk-tables"
                     value={target2} autoComplete="off" spellCheck={false}
                     placeholder="public.users"
                     onChange={(e) => { setTarget2(e.target.value); setTargetCol(''); }} />
              <datalist id="ddl-fk-tables">
                {tables.map((t) => <option key={t} value={t} />)}
              </datalist>
              <p className="sh-help">
                Schema and table, so <code style={{ font: 'var(--sh-code)' }}>public.users</code>.
              </p>
            </div>
            {target2 ? (
              <div className="sh-field">
                <label className="sh-label" htmlFor="ddl-fktcol">…on which column</label>
                <input id="ddl-fktcol" className="sh-input" list="ddl-fk-tcols"
                       value={targetCol} autoComplete="off" spellCheck={false}
                       placeholder={cols.find((c) => c.is_primary_key)?.name ?? 'id'}
                       onChange={(e) => setTargetCol(e.target.value)} />
                <datalist id="ddl-fk-tcols">
                  {cols.map((c) => <option key={c.name} value={c.name} />)}
                </datalist>
                <p className="sh-help">
                  {/* Postgres requires this and its error names the constraint
                      rather than the requirement. */}
                  It has to be a primary key or have a unique constraint —
                  Postgres refuses otherwise.
                </p>
              </div>
            ) : null}
            <div className="sh-field">
              <label className="sh-label" htmlFor="ddl-ondelete">
                When the referenced row is deleted
              </label>
              <input id="ddl-ondelete" className="sh-input" list="ddl-ondelete-opts"
                     value={onDelete} autoComplete="off" spellCheck={false}
                     placeholder="leave empty to refuse the delete"
                     onChange={(e) => setOnDelete(e.target.value)} />
              <datalist id="ddl-ondelete-opts">
                <option value="cascade" />
                <option value="set null" />
                <option value="set default" />
                <option value="restrict" />
              </datalist>
              <p className="sh-help">
                {/* Named in the words Postgres uses, because the preview shows
                    them and the point is that the two match. */}
                Empty refuses the delete, which is Postgres&rsquo;s default.
                <code style={{ font: 'var(--sh-code)' }}> cascade </code> deletes
                the rows that point at it;
                <code style={{ font: 'var(--sh-code)' }}> set null </code> keeps
                them and clears the reference.
              </p>
            </div>
            <label className="sh-switch">
              <input type="checkbox" checked={alsoIndex}
                     onChange={(e) => setAlsoIndex(e.target.checked)} />
              <span className="sh-switch__track" aria-hidden="true" />
              <span>Also index this column</span>
            </label>
          </>
        );
      }

      case 'drop_table':
        return (
          <>
            <p className="sh-dialog__text" style={{ margin: 0 }}>
              This drops <code style={{ font: 'var(--sh-code)' }}>
                {schema}.{facts?.table}
              </code> and every row in it.
            </p>
            <label className="sh-switch">
              <input type="checkbox" checked={cascade}
                     onChange={(e) => setCascade(e.target.checked)} />
              <span className="sh-switch__track" aria-hidden="true" />
              <span>Also drop whatever depends on it (CASCADE)</span>
            </label>
          </>
        );

      /**
       * The operations with nothing to ask.
       *
       * They still go through the dialog, and that is the point of the loop
       * rather than an inconsistency: the preview *is* the question. "Allow null
       * in status" with the statement and its downstream notice underneath is a
       * decision the user can make; a button that silently runs it is the black
       * box D-133 exists to refuse.
       */
      case 'set_not_null':
      case 'drop_not_null':
      case 'drop_default':
      case 'drop_column':
      case 'enable_rls':
      case 'grant_anon':
      case 'revoke_anon':
      case 'drop_index':
      case 'drop_constraint':
      // The two whose whole question is the preview: the rows are already
      // chosen, and the statement plus its bindings is what there is to check.
      case 'update_row':
      case 'delete_rows':
        return null;
    }
  }
}
