'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useIntrospection, useRunSql } from '../../../../../../lib/queries.ts';
import { pageSql, countSql } from '../../../../../../lib/grid-sql.ts';
import { ErrorSurface } from '../../../../../../components/ErrorSurface.tsx';
import { RlsPanel } from '../../../../../../components/RlsPanel.tsx';
import { DataGrid } from '../../../../../../components/DataGrid.tsx';
import { Structure, type ColumnVerb } from '../../../../../../components/Structure.tsx';
import { Constraints } from '../../../../../../components/Constraints.tsx';
import { TableOps, type Op } from '../../../../../../components/TableOps.tsx';
import { Menu, MenuItem } from '../../../../../../components/Menu.tsx';
import type { IntrospectionColumn } from '../../../../../../lib/api.ts';

const PAGE_SIZE = 100;

/**
 * One table: its rows, its columns, its row-level security, and the operations
 * that change them.
 *
 * Three things on one page rather than three tabs, because the IA says so
 * (`/[schema]/[table] → grid + structure + RLS panel`) and because the question a
 * developer actually arrives with is usually a join of them — "why does my API
 * return nothing from this table" is answered by the policy list beside the rows,
 * not by a tab away from them.
 *
 * ## Where the verbs live, and why not on the grid
 *
 * The read path put each column's type and nullability in the *grid header*,
 * beside the values, which was right and left the write half with nowhere to
 * hang its operations: that header is already a `<button>` for sorting, and a
 * menu inside a button is invalid HTML. So the column verbs live in the
 * Structure section's one action column, and the table-level verbs live in a menu
 * on the page head. Nothing is on the grid.
 *
 * ## The one accent
 *
 * §5 rule 1 allows one primary action per view, and this page has two candidates.
 * When RLS is off, the accent belongs to the banner that fixes it — that is a
 * table the anon key can read and write in full, and it is the most important
 * thing on the screen. Otherwise it belongs to "Add column". The decision is made
 * here rather than in either component, because "per view" is a property of the
 * page.
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
  const [op, setOp] = useState<Op | null>(null);

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

  const indexes = useMemo(
    () => (intro.data?.indexes ?? []).filter((i) => i.schema === schema && i.table === table),
    [intro.data, schema, table]);
  const constraints = useMemo(
    () => (intro.data?.constraints ?? [])
      .filter((c) => c.schema === schema && c.table === table),
    [intro.data, schema, table]);

  /**
   * Columns that **lead** an index, which is the only form that serves a lookup.
   *
   * `columns[0]` and not `columns.includes` — an index on `(a, b)` answers a
   * query filtering on `a` and cannot answer one filtering only on `b`, so a
   * foreign key on `b` would still seq-scan. And it is correct for an expression
   * index precisely because the payload puts `null` in that slot rather than
   * shifting the next column up (P7o), which an inner join in the catalog query
   * would have done — it reported `["status"]` for an index on
   * `(lower(title), status)` before that was fixed.
   */
  const indexedColumns = useMemo(
    () => [...new Set(indexes.map((i) => i.columns[0]).filter(
      (c): c is string => typeof c === 'string'))],
    [indexes]);

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

  /**
   * Re-read the rows after a schema change.
   *
   * `useRunSql` invalidates the introspection query when a DDL command runs, so
   * the column list redraws on its own — but the *rows* came from a mutation,
   * which no cache invalidates. Without this, dropping a column leaves its
   * values in the grid until the next sort or page, which reads as the drop
   * having failed. Clearing the key is what makes the effect above re-fire.
   */
  const columnSignature = columns.map((c) => `${c.name}:${c.type}`).join(',');
  useEffect(() => {
    lastKey.current = null;
    setRows(null);
  }, [columnSignature]);

  /**
   * The palette's route into this page (D-226).
   *
   * Every capability a menu exposes must also be in the palette, and a palette
   * command cannot open a dialog that lives here — so it dispatches an event and
   * this listens, the same mechanism the sidebar toggle already uses
   * (`CommandPalette.tsx`'s `sh:sidebar`). The alternative would be lifting
   * twelve dialogs into the shell so the palette can reach them, which is a
   * worse trade: the dialogs belong to the table.
   *
   * Column-scoped verbs are parameterised rather than enumerated. A palette
   * offering "Drop column x" for every column of a forty-column table would be
   * 200 commands for one page, which is how a palette decays into a list nobody
   * reads — so the command opens the picker and the user names the column there.
   */
  useEffect(() => {
    const onOp = (e: Event) => {
      const kind = (e as CustomEvent<{ kind: Op['kind'] }>).detail?.kind;
      if (!kind) return;
      // Only the table-scoped operations arrive this way; the column ones need a
      // column, which the Structure menu is how you choose.
      if (kind === 'add_column' || kind === 'rename_table'
        || kind === 'drop_table' || kind === 'enable_rls'
        || kind === 'grant_anon' || kind === 'revoke_anon') {
        setOp({ kind });
      } else if (kind === 'create_index') {
        // Needs the column list, which only this page has.
        setOp({ kind: 'create_index', candidates: columns });
      }
    };
    window.addEventListener('sh:table-op', onOp);
    return () => window.removeEventListener('sh:table-op', onOp);
    // `columns` is a dependency now that one command carries it: a listener
    // closed over the first render's empty list would open an index dialog with
    // no columns to choose from.
  }, [columns]);

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

  const facts = { schema, table, rowsEstimate: meta.rows_estimate };
  /**
   * A view's columns cannot be altered, and a table someone else owns cannot be
   * altered *by us* — the console runs as `developer` (D-462), so an operation on
   * `pg_stat_statements` would come back as a permission error naming a role the
   * user has never heard of. Better to say why the verbs are absent.
   */
  const isTable = meta.kind === 'table' || meta.kind === 'partitioned_table';
  const isOurs = meta.owner === 'developer';
  const editable = isTable && isOurs;
  const readOnlyReason = editable ? undefined
    : !isTable ? `a ${meta.kind.replace('_', ' ')} has no columns of its own to change`
      : `owned by ${meta.owner}, so this editor cannot change it`;

  /** §5 rule 1: the accent goes to the security hole when there is one. */
  const rlsIsOff = isTable && !meta.rls_enabled;

  const openColumnOp = (verb: ColumnVerb, column: IntrospectionColumn) => {
    const MAP: Record<ColumnVerb, Op['kind']> = {
      rename: 'rename_column', type: 'change_type', not_null: 'set_not_null',
      nullable: 'drop_not_null', default: 'set_default',
      drop_default: 'drop_default', drop: 'drop_column',
    };
    setOp({ kind: MAP[verb], column } as Op);
  };

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
        {editable ? (
          <Menu label={`Change the table ${table}`} align="right"
                trigger={({ toggle, ref: r, open }) => (
                  <button ref={r} type="button" className="sh-btn sh-btn--secondary"
                          aria-expanded={open} aria-haspopup="menu" onClick={toggle}>
                    Change table
                  </button>
                )}>
            {(close) => (
              <>
                <MenuItem onSelect={() => { close(); setOp({ kind: 'add_column' }); }}>
                  Add column…
                </MenuItem>
                <MenuItem onSelect={() => { close(); setOp(
                  { kind: 'create_index', candidates: columns }); }}>
                  New index…
                </MenuItem>
                <MenuItem onSelect={() => { close(); setOp(
                  { kind: 'add_foreign_key', candidates: columns,
                    // Every readable column in the database, so the picker can
                    // offer any table — introspection already carries them.
                    targets: intro.data?.columns ?? [],
                    indexedColumns }); }}>
                  New foreign key…
                </MenuItem>
                <MenuItem onSelect={() => { close(); setOp(
                  { kind: 'add_unique', candidates: columns }); }}>
                  Require unique values…
                </MenuItem>
                <MenuItem onSelect={() => { close(); setOp({ kind: 'add_check' }); }}>
                  New check constraint…
                </MenuItem>
                <div className="sh-menu__sep" />
                <MenuItem onSelect={() => { close(); setOp({ kind: 'rename_table' }); }}>
                  Rename table…
                </MenuItem>
                {!meta.rls_enabled ? (
                  <MenuItem onSelect={() => { close(); setOp({ kind: 'enable_rls' }); }}>
                    Enable Row Level Security
                  </MenuItem>
                ) : null}
                <div className="sh-menu__sep" />
                {/**
                  * Both directions, offered unconditionally, because the page
                  * cannot tell which is current: introspection reports policies
                  * and not *grants*, and `anon`'s table grant is the thing that
                  * decides whether an anon policy does anything at all (D-108).
                  *
                  * A toggle would have to claim a state it does not know. Two
                  * verbs claim nothing, and the preview shows exactly what each
                  * one runs — which is the whole point of this editor. The
                  * toggle D-108 describes needs grants in the introspection
                  * payload; recorded as a gap rather than faked.
                  */}
                <MenuItem onSelect={() => { close(); setOp({ kind: 'grant_anon' }); }}>
                  Allow anonymous read…
                </MenuItem>
                <MenuItem onSelect={() => { close(); setOp({ kind: 'revoke_anon' }); }}>
                  Remove anonymous access…
                </MenuItem>
                <div className="sh-menu__sep" />
                <MenuItem tone="danger"
                          onSelect={() => { close(); setOp({ kind: 'drop_table' }); }}>
                  Drop table…
                </MenuItem>
              </>
            )}
          </Menu>
        ) : null}
      </div>

      {/* Spread conditionally, not `: undefined` — `exactOptionalPropertyTypes`
          makes an explicit undefined a different thing from an absent key. */}
      <RlsPanel table={meta} policies={policies}
                {...(rlsIsOff && editable
                  ? { onEnable: () => setOp({ kind: 'enable_rls' }) } : {})}
                {...(editable ? {
                  onGrantAnon: () => setOp({ kind: 'grant_anon' }),
                  onRevokeAnon: () => setOp({ kind: 'revoke_anon' }),
                } : {})} />

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
        {...(editable
          ? { onAddPrimaryKey: () => setOp({ kind: 'add_primary_key', candidates: columns }) }
          : {})}
      />

      <Structure
        columns={columns}
        truncated={Boolean(intro.data?.truncated['columns'])}
        {...(editable ? { onVerb: openColumnOp } : {})}
        {...(editable && !rlsIsOff ? { onAddColumn: () => setOp({ kind: 'add_column' }) } : {})}
        {...(readOnlyReason ? { readOnlyReason } : {})}
      />

      <Constraints
        indexes={indexes}
        constraints={constraints}
        truncated={Boolean(intro.data?.truncated['indexes'])
          || Boolean(intro.data?.truncated['constraints'])}
        {...(editable ? {
          onDrop: (row) => setOp(row.kind === 'index'
            ? { kind: 'drop_index', name: row.name, invalid: row.invalid }
            : { kind: 'drop_constraint', name: row.name, constraintKind: row.kind }),
          onNewIndex: () => setOp({ kind: 'create_index', candidates: columns }),
        } : {})}
        {...(readOnlyReason ? { readOnlyReason } : {})}
      />

      {op ? (
        // Keyed by the operation, so the form's state resets between operations
        // rather than carrying the last rename's text into the next one.
        <TableOps key={`${op.kind}:${'column' in op ? op.column.name : ''}`}
                  projectRef={ref} op={op} facts={facts} schema={schema}
                  onClose={() => setOp(null)} />
      ) : null}
    </>
  );
}
