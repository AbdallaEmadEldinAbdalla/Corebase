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
 * Those checks **do not narrow anything today**, and that is worth saying rather
 * than implying otherwise: the endpoint always runs as `developer`, the owner, so
 * every predicate passes. They are here because the alternative is a query whose
 * correctness depends on the role never changing — and the role is exactly the
 * thing rail 1 exists to change. If introspection is ever offered under `anon` to
 * show a developer what their API can see, these are what make it true instead of
 * a second implementation. Until then they are unexercised, and no test claims
 * they filter.
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
export const LIMITS = { tables: 2_000, columns: 20_000, functions: 2_000, policies: 2_000 };

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
  /** `SELECT`, `INSERT`, `UPDATE`, `DELETE` or `ALL`. */
  command: string;
  permissive: boolean;
  roles: string[];
  using: string | null;
  check: string | null;
}

export interface Introspection {
  schemas: string[];
  tables: IntrospectionTable[];
  columns: IntrospectionColumn[];
  functions: IntrospectionFunction[];
  policies: IntrospectionPolicy[];
  /** Names only, for the policy editor's role picker and the role switcher. */
  roles: string[];
  /** Which lists hit their cap, so the UI can say so rather than look complete. */
  truncated: Record<string, boolean>;
}

/**
 * Read the whole schema.
 *
 * Six queries rather than one join, deliberately. A single query would need
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
            pg_catalog.obj_description(c.oid, 'pg_class') AS comment
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
              (SELECT array_agg(pg_catalog.pg_get_userbyid(r) ORDER BY r)
                 FROM unnest(pol.polroles) AS r
                WHERE r <> 0),
              -- polroles = {0} means PUBLIC, which is not a role id and would
              -- otherwise come back as an empty list reading as "no roles".
              ARRAY['PUBLIC']) AS roles,
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

  return {
    schemas: schemas.rows.map((r) => r.name),
    tables: tableRows,
    columns: columnRows,
    functions: functionRows,
    policies: policyRows,
    roles: roles.rows.map((r) => r.name),
    truncated: {
      tables: tablesCut, columns: columnsCut,
      functions: functionsCut, policies: policiesCut,
    },
  };
}
