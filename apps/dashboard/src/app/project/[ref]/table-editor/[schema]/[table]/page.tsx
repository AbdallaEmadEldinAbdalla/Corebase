'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useIntrospection, useRunSql } from '../../../../../../lib/queries.ts';
import { pageSql, countSql } from '../../../../../../lib/grid-sql.ts';
import { ErrorSurface } from '../../../../../../components/ErrorSurface.tsx';
import { RlsPanel } from '../../../../../../components/RlsPanel.tsx';
import { DataGrid } from '../../../../../../components/DataGrid.tsx';

const PAGE_SIZE = 100;

/**
 * One table: its rows, its columns, and its row-level security.
 *
 * Three things on one page rather than three tabs, because the IA says so
 * (`/[schema]/[table] → grid + structure + RLS panel`) and because the question a
 * developer actually arrives with is usually a join of them — "why does my API
 * return nothing from this table" is answered by the policy list beside the rows,
 * not by a tab away from them.
 *
 * Everything here is **read-only**. Nothing on this page changes the database:
 * the DDL loop with its SQL preview and warning ladder is the next step, and the
 * controls that would need it say so rather than being drawn and disabled without
 * explanation.
 */
export default function TablePage(
  { params }: { params: Promise<{ ref: string; schema: string; table: string }> },
) {
  const { ref, schema: rawSchema, table: rawTable } = use(params);
  const schema = decodeURIComponent(rawSchema);
  const table = decodeURIComponent(rawTable);

  const intro = useIntrospection(ref);
  const run = useRunSql(ref);

  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | undefined>();
  const [exact, setExact] = useState<number | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [ranSql, setRanSql] = useState<string | null>(null);

  const meta = intro.data?.tables.find((t) => t.schema === schema && t.name === table);
  const columns = useMemo(
    () => (intro.data?.columns ?? [])
      .filter((c) => c.schema === schema && c.table === table)
      .sort((a, b) => a.position - b.position),
    [intro.data, schema, table]);
  const policies = useMemo(
    () => (intro.data?.policies ?? []).filter((p) => p.schema === schema && p.table === table),
    [intro.data, schema, table]);

  const primaryKey = columns.filter((c) => c.is_primary_key).map((c) => c.name);

  /**
   * The allowlist that makes the generated SQL safe.
   *
   * `grid-sql.ts` quotes every identifier, which stops injection — but a quoted
   * identifier that does not exist is still a query nobody asked for, and both
   * the sort column and the URL's table name arrive from outside. Nothing is
   * interpolated unless the *schema* reported it, which is why this page waits
   * for introspection before it reads a single row.
   */
  const known = useMemo(() => new Set(columns.map((c) => c.name)), [columns]);
  const safeSort = sort && known.has(sort.column) ? sort : undefined;

  /** The statement for the page currently being asked for. */
  const query = useMemo(() => pageSql({
    schema, table,
    columns: columns.map((c) => c.name),
    page, pageSize: PAGE_SIZE,
    sort: safeSort,
    primaryKey,
  }), [schema, table, columns, page, safeSort, primaryKey]);

  /**
   * Fetch when the statement changes — in an effect, not during render.
   *
   * The first version called `run.mutate` in the render body, guarded by a
   * "have I fetched this key" flag. That is a side effect in the render path:
   * React may render twice, the guard's own `setState` re-renders, and the
   * mutation's `onSuccess` renders again. It is the same class of mistake as a
   * `localStorage.setItem` inside a state updater, and React finds it.
   *
   * The ref, not state, holds the last key: it must not itself cause a render,
   * and comparing it is the whole job. `run` is deliberately absent from the
   * dependency list — a mutation object is a fresh identity each render, so
   * including it would fire this on every render forever.
   */
  const lastKey = useRef<string | null>(null);
  const key = query.sql;
  useEffect(() => {
    if (!intro.data || !meta) return;
    if (lastKey.current === key) return;
    lastKey.current = key;
    run.mutate({ sql: key, read_only: true }, {
      onSuccess: (data) => {
        const first = data.results[0];
        setRows(first?.rows ?? []);
        setRanSql(first?.executed_sql ?? key);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intro.data, meta]);

  if (intro.isPending) {
    return (
      <div aria-busy="true">
        <div className="sh-skeleton" style={{ width: 200, height: 26 }} />
        <div className="sh-skeleton"
             style={{ width: '100%', height: 220, marginTop: 'var(--sh-space-24)' }} />
      </div>
    );
  }

  if (intro.error) {
    return <ErrorSurface error={intro.error} onRetry={() => void intro.refetch()}
                         title="Could not read the schema" />;
  }

  if (!meta) {
    return (
      <div className="emptywrap"><div className="sh-empty">
        <div className="sh-empty__title">No such table</div>
        <div className="sh-empty__text">
          <code style={{ font: 'var(--sh-code)' }}>{schema}.{table}</code> is not in
          this project&rsquo;s schema. It may have been renamed or dropped since the
          link was made.
        </div>
      </div></div>
    );
  }

  return (
    <>
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <h1 className="head__title" style={{ font: 'var(--sh-heading-2)' }}>
            <span style={{ color: 'var(--sh-text-muted)' }}>{schema}.</span>{table}
          </h1>
          <p className="head__sub">
            {meta.kind === 'table' ? 'Table' : meta.kind.replace('_', ' ')}
            {' · owned by '}{meta.owner}
            {meta.comment ? ` · ${meta.comment}` : ''}
          </p>
        </div>
      </div>

      <RlsPanel table={meta} policies={policies} />

      <DataGrid
        columns={columns}
        rows={rows}
        pending={run.isPending && rows === null}
        error={run.error}
        onRetry={() => { lastKey.current = null; setRows(null); }}
        page={page}
        pageSize={PAGE_SIZE}
        onPage={(p) => { setPage(p); setRows(null); }}
        sort={safeSort}
        onSort={(column) => {
          setSort((s) => s?.column === column
            ? { column, direction: s.direction === 'asc' ? 'desc' : 'asc' }
            : { column, direction: 'asc' });
          setPage(0);
          setRows(null);
        }}
        rowsEstimate={meta.rows_estimate}
        exactCount={exact}
        onCountExactly={() => {
          run.mutate({ sql: countSql(schema, table), read_only: true }, {
            onSuccess: (data) => {
              const n = data.results[0]?.rows[0]?.['exact'];
              setExact(typeof n === 'string' ? Number(n) : Number(n ?? 0));
            },
          });
        }}
        primaryKey={primaryKey}
        executedSql={ranSql}
      />
    </>
  );
}
