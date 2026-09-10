/**
 * Row edits: `UPDATE`, `INSERT`, `DELETE`, compiled to bound statements.
 *
 * A separate module from `ddl.ts` because the rules are different in three ways,
 * and each difference is a decision rather than a detail:
 *
 * 1. **Values are bound, never written into the statement.** A DDL `DEFAULT` is
 *    an *expression* the user authored and has to be inserted verbatim to be
 *    honest; a row's value is *data*, and data in a statement is how injection
 *    happens. So every value here travels as `$n` and the preview shows the
 *    placeholder — which is also what the doc asks for.
 * 2. **One statement per run.** The server refuses bound parameters against a
 *    multi-statement script, because `client.query` takes one `values` array and
 *    would hand the same array to every statement — misbinding silently rather
 *    than failing. That is not a limitation to work around: it is why editing is
 *    per row.
 * 3. **Nothing here is offered as a migration.** "Row edits are DML, not schema:
 *    they are never offered as migrations." A `RowPlan` therefore has no
 *    filename, which is what stops the dialog offering one — the absence is the
 *    mechanism, not a flag the caller has to remember.
 *
 * ## PK-guarded, always
 *
 * D-133: "PK-guarded parameterized DML is the only UPDATE/DELETE shape that
 * cannot silently hit more rows than the user sees." Every function here refuses
 * without a primary key rather than falling back to matching on the values it
 * happens to know, which would hit every duplicate row.
 */
import { quote, qualified } from './grid-sql.ts';
import { Incomplete, type Notice, type Previewable } from './ddl.ts';

/**
 * A cell's intended value.
 *
 * `null` is a separate case rather than an empty string, because they are
 * different values that render identically in a text field — the same
 * distinction the grid draws when reading them. A form that could not express
 * "set this to null" would make a nullable column one-way.
 */
export type CellValue =
  | { kind: 'value'; text: string }
  | { kind: 'null' }
  /** Leave it to the column's `DEFAULT`. Only meaningful on insert. */
  | { kind: 'default' };

/** What the compiler produces. Deliberately without a migration filename. */
export interface RowPlan extends Previewable {
  params: unknown[];
  /** What each placeholder holds, so the preview can show it beside the SQL. */
  bindings: { placeholder: string; column: string; value: string }[];
}

/**
 * A cell that will actually be bound — everything except `default`.
 *
 * A separate type, so `bind` and `shown` **cannot** be handed a defaulted cell.
 * They were written taking `CellValue` and narrowing on `'null'`, which the
 * compiler rejected: `default` has no `text` either. The tests all passed,
 * because every caller filters `default` out before binding — so the convention
 * was right and only the types did not know it, which is the version of this
 * mistake that survives until someone adds a call site that forgets.
 */
type BoundValue = Exclude<CellValue, { kind: 'default' }>;

/** Does this previewable carry bound parameters — i.e. is it a row edit? */
export function isRowPlan(p: Previewable): p is RowPlan {
  return 'bindings' in p && 'params' in p;
}

const bind = (v: BoundValue): unknown => (v.kind === 'null' ? null : v.text);

/** How a bound value reads in the preview's binding list. */
const shown = (v: BoundValue): string =>
  v.kind === 'null' ? 'null' : v.text === '' ? '(empty string)' : v.text;

/**
 * The `WHERE` that targets exactly one row, and the params it needs.
 *
 * A composite key uses a row-value comparison — `("tenant", "id") = ($1, $2)` —
 * rather than `a = $1 AND b = $2`. Both work; the row-value form is one
 * expression, which means the statement reads as *one* condition and cannot be
 * mistaken for two that someone might edit apart.
 */
function pkWhere(
  primaryKey: readonly string[], row: Record<string, unknown>, from: number,
): { sql: string; params: unknown[] } {
  if (primaryKey.length === 0) {
    throw new Incomplete(
      'This table has no primary key, so there is no way to name one row. '
      + 'Editing rows needs one — the grid says so above.');
  }
  const params = primaryKey.map((c) => row[c] ?? null);
  if (params.some((v) => v === null)) {
    // Not possible through the UI — a primary key column cannot be null — but a
    // null here would produce `= NULL`, which matches nothing and would report
    // "0 rows updated" as though the row had vanished.
    throw new Incomplete('This row has no key value, so it cannot be targeted.');
  }
  const cols = primaryKey.map(quote);
  const holes = primaryKey.map((_, i) => `$${from + i}`);
  return {
    sql: primaryKey.length === 1
      ? `${cols[0]} = ${holes[0]}`
      : `(${cols.join(', ')}) = (${holes.join(', ')})`,
    params,
  };
}

/**
 * `UPDATE … SET … WHERE <pk>` — one row, every changed column at once.
 *
 * One statement for the whole row rather than one per cell, which is what makes
 * editing bearable: a row where three cells changed is one confirmation and one
 * transaction, not three. It is also the only shape that stays a *single*
 * statement, which the bound-parameter rule requires.
 */
export function updateRow(
  target: { schema: string; table: string },
  args: {
    row: Record<string, unknown>;
    primaryKey: readonly string[];
    /** Only the columns that changed. */
    changes: { column: string; value: CellValue }[];
  },
): RowPlan {
  const changes = args.changes.filter(
    (c): c is { column: string; value: BoundValue } => c.value.kind !== 'default');
  if (changes.length === 0) throw new Incomplete('Nothing has changed in this row.');

  const sets = changes.map((c, i) => `${quote(c.column)} = $${i + 1}`);
  const where = pkWhere(args.primaryKey, args.row, changes.length + 1);

  return {
    sql: `update ${qualified(target.schema, target.table)}\n`
      + `   set ${sets.join(',\n       ')}\n`
      + ` where ${where.sql};`,
    params: [...changes.map((c) => bind(c.value)), ...where.params],
    done: changes.length === 1
      ? `${changes[0]!.column} updated`
      : `${changes.length} columns updated`,
    notices: [{
      kind: 'data',
      // The reassurance that matters, and it is a fact about the shape of the
      // statement rather than a promise: the key is unique, so this cannot
      // affect a second row however wrong the values are.
      text: 'This targets one row by its primary key, so it cannot touch another '
        + 'one. There is no undo — the previous values are not kept anywhere.',
    }],
    bindings: [
      ...changes.map((c, i) => ({
        placeholder: `$${i + 1}`, column: c.column, value: shown(c.value),
      })),
      ...args.primaryKey.map((c, i) => ({
        placeholder: `$${changes.length + 1 + i}`,
        column: c,
        value: String(args.row[c]),
      })),
    ],
  };
}

/**
 * `INSERT INTO … (cols) VALUES ($1…)`.
 *
 * Columns left as `default` are **omitted from the statement entirely** rather
 * than sent as null, which is the difference between "let the column's default
 * apply" and "store null here". Sending null for a `created_at timestamptz not
 * null default now()` would fail; omitting it gets the default. The generated
 * `id` and `created_at` every Steadhold table has are exactly this case, so it
 * is the common path rather than an edge.
 *
 * `returning *` because the grid has to show the row it just made, and a
 * defaulted `id` is only knowable from the database.
 */
export function insertRow(
  target: { schema: string; table: string },
  values: { column: string; value: CellValue }[],
): RowPlan {
  const given = values.filter(
    (v): v is { column: string; value: BoundValue } => v.value.kind !== 'default');
  if (given.length === 0) {
    // Legal SQL (`insert … default values`) and almost certainly a mistake, so
    // it asks rather than silently inserting an all-defaults row.
    throw new Incomplete('Fill in at least one column.');
  }

  const cols = given.map((v) => quote(v.column));
  const holes = given.map((_, i) => `$${i + 1}`);
  return {
    sql: `insert into ${qualified(target.schema, target.table)}\n`
      + `       (${cols.join(', ')})\n`
      + `values (${holes.join(', ')})\n`
      + 'returning *;',
    params: given.map((v) => bind(v.value)),
    done: 'Row inserted',
    notices: [
      {
        kind: 'data',
        text: values.length > given.length
          ? `${values.length - given.length} column(s) are left out of the `
            + 'statement, so their defaults apply. That is different from setting '
            + 'them to null.'
          : 'Every column is given a value.',
      },
      {
        kind: 'rls',
        // The failure that would otherwise be baffling: an INSERT policy's WITH
        // CHECK applies to the *owner* only when RLS is forced, which it is not
        // — so this is about what the API can do, not about this insert.
        text: 'You are inserting as the table’s owner, so its policies do not '
          + 'apply to this statement. A client using your API is checked against '
          + 'the INSERT policies instead.',
      },
    ],
    bindings: given.map((v, i) => ({
      placeholder: `$${i + 1}`, column: v.column, value: shown(v.value),
    })),
  };
}

/**
 * `DELETE FROM … WHERE <pk> IN (…)` — the selected rows, and no others.
 *
 * The doc puts this at ladder (ii) with "row count in the confirm". The server's
 * classifier rates a `DELETE` *with* a predicate as `safe`, and correctly so —
 * gating every ordinary qualified delete would fire the guard on the normal case
 * and teach people to click through it (D-468's reasoning, in reverse).
 *
 * So the confirmation here is the dialog every operation already goes through,
 * with its count stated and its button red. That is not a second ladder: nothing
 * extra is *required* to proceed, and what is required stays the server's
 * (D-469). The colour is information, not a gate.
 */
export function deleteRows(
  target: { schema: string; table: string },
  args: {
    rows: Record<string, unknown>[];
    primaryKey: readonly string[];
  },
): RowPlan {
  if (args.rows.length === 0) throw new Incomplete('Select at least one row.');
  if (args.primaryKey.length === 0) {
    throw new Incomplete(
      'This table has no primary key, so there is no way to name the rows to '
      + 'delete without risking others.');
  }

  const cols = args.primaryKey.map(quote);
  const params: unknown[] = [];
  const tuples = args.rows.map((row) => {
    const holes = args.primaryKey.map((c) => {
      params.push(row[c] ?? null);
      return `$${params.length}`;
    });
    return args.primaryKey.length === 1 ? holes[0]! : `(${holes.join(', ')})`;
  });

  const lhs = args.primaryKey.length === 1 ? cols[0]! : `(${cols.join(', ')})`;
  return {
    sql: `delete from ${qualified(target.schema, target.table)}\n`
      + ` where ${lhs} in (${tuples.join(', ')});`,
    params,
    done: args.rows.length === 1 ? 'Row deleted' : `${args.rows.length} rows deleted`,
    notices: [{
      kind: 'data',
      text: `This deletes ${args.rows.length === 1 ? 'the row' : `${args.rows.length} rows`}`
        + ' you selected and no others — each one is named by its primary key. '
        + 'There is no undo, and a backup restore is the only way back.',
    }],
    bindings: args.rows.flatMap((row, r) => args.primaryKey.map((c, i) => ({
      placeholder: `$${r * args.primaryKey.length + i + 1}`,
      column: c,
      value: String(row[c]),
    }))),
  };
}
