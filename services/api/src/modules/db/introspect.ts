import type { Client } from 'pg';

/**
 * A project's schema, in one payload.
 *
 * The SQL editor's completion source and the table editor's whole left-hand side
 * come from here, and the doc is specific that it is **one** payload rather than
 * a call per object: the dashboard caches it in TanStack Query and invalidates it
 * on any successful DDL, so the shape that matters is "everything the editor
 * needs to render and complete", not "a REST resource per catalog table".
 *
 * ## Why `pg_catalog` and not `information_schema`
 *
 * `information_schema` is the portable one and it is the wrong choice here for a
 * reason that shows up on the first column: it reports `data_type` as
 * `character varying`, dropping the length. An editor that completes
 * `varchar` where the column is `varchar(40)` is worse than one that completes
 * nothing, because the user will believe it. `format_type(atttypid, atttypmod)`
 * is what `\\d` prints and what the customer wrote.
 *
 * The trade is that `pg_catalog` does **not** filter itself by privilege, so
 * every query here carries an explicit `has_*_privilege` check.
 *
 * And they **do** narrow, which a first version of this comment claimed they did
 * not. Running as the owner is not the same as running as a superuser: `developer`
 * has `USAGE` on the `auth` schema — it needs it to write policies that call
 * `auth.uid()` (D-189) — and **no table privileges in it at all**, because
 * `steadhold_auth` alone holds those and that grant is what keeps end-user
 * password hashes out of reach (D-315). So `auth` appears in `schemas` and none
 * of its tables appear in `tables`, which is exactly right and is only true
 * because of `has_table_privilege`. Seen by looking at the rendered list and
 * noticing the schema had no tables under it.
 *
 * `has_column_privilege` is the one that is genuinely unexercised today, since
 * the owner holds every column of its own tables. It stays for the same reason
 * the others earn their keep: the role is the thing rail 1 exists to change, and
 * a query whose correctness depends on the role never changing is a query waiting
 * to leak.
 *
 * ## What it runs as
 *
 * The same `SET LOCAL ROLE developer` the console uses (D-462), inside a
 * read-only transaction. Two consequences worth stating: the payload is the
 * customer's own view of their own database, and introspection cannot change it
 * even if one of these queries were wrong.
 */

/** Schemas that are never a customer's business to browse. */
const HIDDEN_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

/**
 * Caps, and each one reports whether it bit.
 *
 * A payload is not allowed to be silently short — §8 question 12 asks that a
 * truncated screen say by how much, and an autocomplete list that quietly stops
 * at a thousand columns is the version of that failure nobody notices. These are
 * generous enough that no ordinary project meets them and small enough that one
 * pathological schema cannot hand the browser 40MB.
 */
export const LIMITS = {
  tables: 2_000, columns: 20_000, functions: 2_000, policies: 2_000,
  /**
   * Indexes and constraints are capped lower than columns and for a different
   * reason: a table has as many columns as its author wrote, and an *index* count
   * is a property of how the schema has been tuned. Two thousand of either is
   * already a schema in trouble, and the cap exists so one pathological database
   * cannot hand the browser a payload it will not render.
   */
  indexes: 2_000, constraints: 2_000,
};

export interface IntrospectionTable {
  schema: string;
  name: string;
  /** `table`, `view`, `materialized_view` or `partitioned_table`. */
  kind: string;
  owner: string;
  rls_enabled: boolean;
  /** `reltuples`, which is an estimate — see the note on why it is not a count. */
  rows_estimate: number;
  comment: string | null;
  /**
   * Whether `anon` can read this table — and `null` when there is no `anon` role.
   *
   * A tri-state rather than a boolean, because the third state is real and
   * meaningful: `steadhold export` (D-004) restores into vanilla Postgres, which
   * has no `anon`, and a database opened there should not be told that anonymous
   * access is *off* as though it were a setting someone could turn on.
   *
   * This is here rather than in a list of its own because it is the fact the
   * anonymous-access control needs, and it is a property of a table. D-108 makes
   * `anon` opt-in per table — it holds no default grant — so a `CREATE POLICY …
   * TO anon` does nothing until this is true, which is the single most
   * misleading thing about a new table and was previously invisible to the
   * dashboard.
   */
  anon_can_select: boolean | null;
  /**
   * Whether `anon` can also write. Separate from reading because they are very
   * different things to have granted by accident, and a surface that collapses
   * them cannot warn about the worse one.
   */
  anon_can_write: boolean | null;
}

export interface IntrospectionColumn {
  schema: string;
  table: string;
  name: string;
  /** `format_type` output: `character varying(40)`, not `character varying`. */
  type: string;
  nullable: boolean;
  default: string | null;
  position: number;
  is_primary_key: boolean;
  is_identity: boolean;
  comment: string | null;
}

export interface IntrospectionFunction {
  schema: string;
  name: string;
  /** `pg_get_function_identity_arguments`, so the completion can show a signature. */
  arguments: string;
  returns: string;
  kind: string;
}

export interface IntrospectionPolicy {
  schema: string;
  table: string;
  name: string;
  /* `roles` is `text[]` and the cast in the query is load-bearing — see below. */
  /** `SELECT`, `INSERT`, `UPDATE`, `DELETE` or `ALL`. */
  command: string;
  permissive: boolean;
  /**
   * A real array, because the query casts to `text[]`.
   *
   * Without the cast this field **is a lie**: `pg_get_userbyid` returns `name`,
   * so `array_agg` gives `name[]` (OID 1003), and node-pg has no parser for that
   * OID — it hands back the Postgres literal `'{authenticated}'` as a plain
   * string. The type said `string[]`, the runtime had a string, nothing complained
   * until the browser called `.join()` on it and the uncaught TypeError took the
   * page down. `::text[]` is `text[]` (OID 1009), which node-pg does parse.
   */
  roles: string[];
  using: string | null;
  check: string | null;
}

/**
 * An index, with both its parsed key columns and its verbatim definition.
 *
 * Both, because neither is sufficient. `definition` is `pg_get_indexdef`, which
 * is the truth and is what a person reads — but it is a string, so nothing can
 * ask it "is `author_id` the leading column", which is exactly the question the
 * foreign-key fan-in warning has to answer. `columns` answers that and cannot
 * express an expression index, which is why the definition stays.
 */
export interface IntrospectionIndex {
  schema: string;
  table: string;
  name: string;
  /**
   * The **key** columns, in index order, with `null` for anything that is not a
   * plain column.
   *
   * Two subtleties, both of which make the difference between a correct fan-in
   * check and a falsely reassuring one:
   *
   * - An expression index (`create index on t (lower(name))`) has attnum 0 in
   *   `indkey`, and there is no `pg_attribute` row for it. A `JOIN` would drop
   *   that entry and *shift the rest up*, so an index on `(lower(a), b)` would
   *   report `b` as its leading column — the unsafe direction, since it claims
   *   an index that cannot serve the lookup. A `LEFT JOIN` keeps the position and
   *   puts `null` there.
   * - `INCLUDE`d columns are in `indkey` and are **not** key columns; they
   *   cannot serve a lookup at all. Only the first `indnkeyatts` entries are
   *   here.
   */
  columns: (string | null)[];
  is_unique: boolean;
  is_primary: boolean;
  /**
   * `indisvalid`. False means a `CREATE INDEX CONCURRENTLY` failed part-way and
   * left an index Postgres will not use and will not drop for you — worth
   * surfacing rather than showing it beside working ones.
   */
  is_valid: boolean;
  /** `pg_get_indexdef`, verbatim, so an expression index reads correctly. */
  definition: string;
}

/**
 * A constraint. `definition` is `pg_get_constraintdef`, which is what `\d`
 * prints and the only representation that is right for every kind.
 */
export interface IntrospectionConstraint {
  schema: string;
  table: string;
  name: string;
  /** `primary_key`, `foreign_key`, `unique`, `check` or `exclusion`. */
  kind: string;
  columns: (string | null)[];
  /** For a foreign key, what it points at. Null for every other kind. */
  references_schema: string | null;
  references_table: string | null;
  definition: string;
}

export interface Introspection {
  schemas: string[];
  tables: IntrospectionTable[];
  columns: IntrospectionColumn[];
  functions: IntrospectionFunction[];
  policies: IntrospectionPolicy[];
  indexes: IntrospectionIndex[];
  constraints: IntrospectionConstraint[];
  /** Names only, for the policy editor's role picker and the role switcher. */
  roles: string[];
  /** Which lists hit their cap, so the UI can say so rather than look complete. */
  truncated: Record<string, boolean>;
}

/**
 * Read the whole schema.
 *
 * Eight queries rather than one join, deliberately. A single query would need
 * `left join`s from tables to columns to policies and would return the table row
 * once per column — megabytes of repetition for the client to group. Six flat
 * lists is what the editor actually indexes, and they run inside one transaction
 * so they cannot disagree with each other.
 */
export async function introspect(client: Client): Promise<Introspection> {
  const schemas = await client.query<{ name: string }>(
    `SELECT n.nspname AS name
       FROM pg_catalog.pg_namespace n
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg_temp%'
        AND n.nspname NOT LIKE 'pg_toast_temp%'
        -- USAGE is the right test: a schema the role cannot enter is a schema
        -- whose contents it cannot name, so listing it would offer completions
        -- that always fail.
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
      ORDER BY n.nspname`,
    [HIDDEN_SCHEMAS]);

  const tables = await client.query<IntrospectionTable>(
    `SELECT n.nspname AS schema,
            c.relname AS name,
            CASE c.relkind WHEN 'r' THEN 'table'
                           WHEN 'v' THEN 'view'
                           WHEN 'm' THEN 'materialized_view'
                           WHEN 'p' THEN 'partitioned_table'
                           WHEN 'f' THEN 'foreign_table' END AS kind,
            pg_catalog.pg_get_userbyid(c.relowner) AS owner,
            c.relrowsecurity AS rls_enabled,
            -- An estimate, and named one. \`count(*)\` here would scan every
            -- table in the database to draw a sidebar, on a customer's
            -- production data — the exact reason D-310 uses reltuples too. A
            -- never-analysed table reports -1, which the client shows as unknown
            -- rather than as zero.
            c.reltuples::bigint AS rows_estimate,
            pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
            -- Guarded by the role's existence rather than assumed: a database
            -- restored from \`steadhold export\` (D-004) into vanilla Postgres has
            -- no \`anon\`, and \`has_table_privilege\` on a role that does not exist
            -- raises rather than returning false. NULL there is the honest
            -- answer and the client renders it as "there is no anon role here".
            CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
                 THEN pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
            END AS anon_can_select,
            CASE WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
                 THEN pg_catalog.has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE')
            END AS anon_can_write
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = ANY(ARRAY['r','v','m','p','f']::"char"[])
        AND n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg_temp%'
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
        AND pg_catalog.has_table_privilege(
              c.oid, 'SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER')
      ORDER BY n.nspname, c.relname
      LIMIT $2`,
    [HIDDEN_SCHEMAS, LIMITS.tables + 1]);

  const columns = await client.query<IntrospectionColumn>(
    `SELECT n.nspname AS schema,
            c.relname AS table,
            a.attname AS name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default,
            a.attnum AS position,
            COALESCE(pk.is_pk, false) AS is_primary_key,
            a.attidentity <> '' AS is_identity,
            pg_catalog.col_description(c.oid, a.attnum) AS comment
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attrdef d
              ON d.adrelid = c.oid AND d.adnum = a.attnum
       LEFT JOIN LATERAL (
              SELECT true AS is_pk
                FROM pg_catalog.pg_index i
               WHERE i.indrelid = c.oid AND i.indisprimary
                 AND a.attnum = ANY(i.indkey)
               LIMIT 1) pk ON true
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND c.relkind = ANY(ARRAY['r','v','m','p','f']::"char"[])
        AND n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg_temp%'
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
        -- Per **column**, not per table. A role may hold SELECT on two columns
        -- of a table and nothing else, and listing the rest would put names in
        -- the completion menu that every query using them rejects.
        AND pg_catalog.has_column_privilege(c.oid, a.attnum,
              'SELECT,INSERT,UPDATE,REFERENCES')
      ORDER BY n.nspname, c.relname, a.attnum
      LIMIT $2`,
    [HIDDEN_SCHEMAS, LIMITS.columns + 1]);

  const functions = await client.query<IntrospectionFunction>(
    `SELECT n.nspname AS schema,
            p.proname AS name,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
            pg_catalog.pg_get_function_result(p.oid) AS returns,
            CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure'
                           WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' END AS kind
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg_temp%'
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
        -- EXECUTE, so \`auth.uid()\` appears exactly when it can be called. It is
        -- the completion the RLS cookbook is written around, and offering it to a
        -- role that cannot execute it would send someone debugging a policy into
        -- a permission error that looks like a platform fault (P5d).
        AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
      ORDER BY n.nspname, p.proname
      LIMIT $2`,
    [HIDDEN_SCHEMAS, LIMITS.functions + 1]);

  const policies = await client.query<IntrospectionPolicy>(
    `SELECT n.nspname AS schema,
            c.relname AS table,
            pol.polname AS name,
            CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                            WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                            ELSE 'ALL' END AS command,
            pol.polpermissive AS permissive,
            COALESCE(
              (SELECT array_agg(pg_catalog.pg_get_userbyid(r)::text ORDER BY r)
                 FROM unnest(pol.polroles) AS r
                WHERE r <> 0),
              -- polroles = {0} means PUBLIC, which is not a role id and would
              -- otherwise come back as an empty list reading as "no roles".
              ARRAY['PUBLIC'])::text[] AS roles,
            pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using,
            pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check
       FROM pg_catalog.pg_policy pol
       JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> ALL($1::text[])
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
        AND pg_catalog.has_table_privilege(
              c.oid, 'SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER')
      ORDER BY n.nspname, c.relname, pol.polname
      LIMIT $2`,
    [HIDDEN_SCHEMAS, LIMITS.policies + 1]);

  const indexes = await client.query<IntrospectionIndex>(
    `SELECT n.nspname AS schema,
            c.relname AS table,
            ic.relname AS name,
            i.indisunique AS is_unique,
            i.indisprimary AS is_primary,
            i.indisvalid AS is_valid,
            pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
            COALESCE((
              SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                -- LEFT, not inner: an expression has attnum 0 and no
                -- pg_attribute row, and dropping the entry would shift the rest
                -- up so \`(lower(a), b)\` reported \`b\` as its leading column —
                -- claiming an index that cannot serve the lookup, which is the
                -- unsafe direction for the fan-in check to be wrong in.
                LEFT JOIN pg_catalog.pg_attribute a
                       ON a.attrelid = c.oid AND a.attnum = k.attnum
                       AND NOT a.attisdropped
               -- Key columns only. INCLUDEd columns are in indkey and cannot
               -- serve a lookup, so counting them would be the same false
               -- reassurance by a different route.
               WHERE k.ord <= i.indnkeyatts),
              ARRAY[]::text[])::text[] AS columns
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg_temp%'
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
        -- The privilege test is on the **table**, not the index: an index has no
        -- privileges of its own, and what decides whether you may know about one
        -- is whether you may see the table it is on.
        AND pg_catalog.has_table_privilege(
              c.oid, 'SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER')
      ORDER BY n.nspname, c.relname, ic.relname
      LIMIT $2`,
    [HIDDEN_SCHEMAS, LIMITS.indexes + 1]);

  const constraints = await client.query<IntrospectionConstraint>(
    `SELECT n.nspname AS schema,
            c.relname AS table,
            con.conname AS name,
            CASE con.contype WHEN 'p' THEN 'primary_key'
                             WHEN 'f' THEN 'foreign_key'
                             WHEN 'u' THEN 'unique'
                             WHEN 'c' THEN 'check'
                             WHEN 'x' THEN 'exclusion' END AS kind,
            pg_catalog.pg_get_constraintdef(con.oid) AS definition,
            COALESCE((
              SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                LEFT JOIN pg_catalog.pg_attribute a
                       ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                       AND NOT a.attisdropped),
              -- A table-level CHECK over no single column has a null conkey, and
              -- an empty list is the truthful answer rather than a missing row.
              ARRAY[]::text[])::text[] AS columns,
            fn.nspname AS references_schema,
            fc.relname AS references_table
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
       LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
      -- The five kinds a person can act on. Postgres 17 also catalogues NOT NULL
      -- as a constraint (contype 'n'), and listing those would put a row here for
      -- every non-nullable column in the database — the structure table already
      -- shows nullability, so they would be noise measured in thousands.
      WHERE con.contype = ANY(ARRAY['p','f','u','c','x']::"char"[])
        AND n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg_temp%'
        AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
        AND pg_catalog.has_table_privilege(
              c.oid, 'SELECT,INSERT,UPDATE,DELETE,REFERENCES,TRIGGER')
      ORDER BY n.nspname, c.relname, con.conname
      LIMIT $2`,
    [HIDDEN_SCHEMAS, LIMITS.constraints + 1]);

  const roles = await client.query<{ name: string }>(
    // Names only. The policy editor needs to offer `anon` and `authenticated`,
    // and a `CREATE POLICY ... TO <role>` needs the name to be real — nothing
    // here needs a role's attributes, and `pg_roles` would hand over
    // `rolpassword` shape and login rights that no picker should carry.
    `SELECT rolname AS name FROM pg_catalog.pg_roles
      WHERE rolname NOT LIKE 'pg\\_%'
      ORDER BY rolname`);

  const cut = <T>(rows: T[], limit: number): [T[], boolean] =>
    rows.length > limit ? [rows.slice(0, limit), true] : [rows, false];

  const [tableRows, tablesCut] = cut(tables.rows, LIMITS.tables);
  const [columnRows, columnsCut] = cut(columns.rows, LIMITS.columns);
  const [functionRows, functionsCut] = cut(functions.rows, LIMITS.functions);
  const [policyRows, policiesCut] = cut(policies.rows, LIMITS.policies);
  const [indexRows, indexesCut] = cut(indexes.rows, LIMITS.indexes);
  const [constraintRows, constraintsCut] = cut(constraints.rows, LIMITS.constraints);

  return {
    schemas: schemas.rows.map((r) => r.name),
    tables: tableRows,
    columns: columnRows,
    functions: functionRows,
    policies: policyRows,
    indexes: indexRows,
    constraints: constraintRows,
    roles: roles.rows.map((r) => r.name),
    truncated: {
      tables: tablesCut, columns: columnsCut,
      functions: functionsCut, policies: policiesCut,
      indexes: indexesCut, constraints: constraintsCut,
    },
  };
}
