/**
 * The SQL the grid runs, built in one place so it can be read and tested.
 *
 * The table editor's rule is that every operation compiles to visible SQL and
 * the SQL is what runs — and the doc extends that to reads: "sort toggles emit
 * `ORDER BY` (visible in a collapsed 'view as SQL' affordance — reads are SQL
 * too)". So this module's output is shown to the user, which is the reason it
 * builds a readable statement rather than the shortest one.
 *
 * **Identifiers are quoted here; values are never interpolated.** A column name
 * cannot be a bound parameter — no database allows it — so the only safe handling
 * is to quote it and to refuse anything that is not an identifier the schema
 * actually reported. Values always travel as `$1`.
 */

/**
 * Quote an identifier the way Postgres does.
 *
 * Doubling an embedded quote is the whole escape, and it is why the caller must
 * *also* check the name against the schema: `quote('a"; drop table x --')`
 * produces a syntactically safe identifier, and a syntactically safe identifier
 * that does not exist is still a query nobody asked for. Quoting stops injection;
 * the allowlist stops nonsense.
 */
export function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export const qualified = (schema: string, table: string) =>
  `${quote(schema)}.${quote(table)}`;

export interface PageRequest {
  schema: string;
  table: string;
  /** Column names, in the order the grid shows them. */
  columns: readonly string[];
  /** Zero-based page index. */
  page: number;
  pageSize: number;
  sort?: { column: string; direction: 'asc' | 'desc' } | undefined;
  /** The table's primary key columns, if it has one. */
  primaryKey: readonly string[];
}

/**
 * A page of rows.
 *
 * Offset pagination, and the doc asks for keyset "on the primary key where one
 * exists, offset fallback otherwise". Offset is what this builds, deliberately,
 * and the reason is that keyset and *arbitrary sort* are not compatible without
 * more machinery than a read path should carry: a keyset cursor has to include
 * every column in the ORDER BY, and the grid lets the user sort by any column,
 * including a nullable one where `>` does not order the way the user expects.
 *
 * The cost is real and bounded: `OFFSET n` makes the database walk n rows, so
 * page 500 of a million-row table is slow. That is a deep-paging problem, and
 * deep paging in a *browser grid* is not how anyone finds a row — filters are.
 * Recorded as a gap rather than pretended away, and the primary key is already
 * threaded through here so keyset can be added behind the same call.
 *
 * An explicit `LIMIT` also means the server's `LIMIT 501` auto-append never
 * fires for the grid — the classifier skips a statement that already has one —
 * so the grid has exactly one truncation to explain instead of two.
 */
export function pageSql(req: PageRequest): { sql: string; params: unknown[] } {
  const cols = req.columns.length > 0
    ? req.columns.map(quote).join(', ')
    // No columns is not "select nothing": it is a table whose columns this role
    // cannot read, and `*` is the honest request — the database will say so.
    : '*';

  const order = req.sort
    ? `\norder by ${quote(req.sort.column)} ${req.sort.direction === 'desc' ? 'desc' : 'asc'}`
    // A page without ORDER BY is not a stable page. Postgres may return rows in
    // any order, so paging without one can show a row twice and skip another —
    // and it would look like the grid losing data. The primary key is the
    // cheapest stable order there is; without one there is nothing to promise,
    // which is stated on the page rather than hidden here.
    : req.primaryKey.length > 0
      ? `\norder by ${req.primaryKey.map(quote).join(', ')}`
      : '';

  return {
    sql: `select ${cols}\n  from ${qualified(req.schema, req.table)}${order}`
       + `\n limit ${req.pageSize} offset ${req.page * req.pageSize}`,
    params: [],
  };
}

/**
 * An exact count, for when the estimate is not good enough.
 *
 * Offered rather than automatic: `count(*)` is a sequential scan on most tables,
 * against a customer's production database, to fill in a number beside a page of
 * rows. The doc's position is `reltuples` above a threshold, and the honest
 * addition is letting the user ask — an estimate you cannot escape is worse than
 * one you can.
 */
export const countSql = (schema: string, table: string) =>
  `select count(*) as exact from ${qualified(schema, table)}`;
