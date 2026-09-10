import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LIMITS } from './introspect.ts';

/**
 * Guards on the introspection SQL that do not need a database.
 *
 * The queries themselves are verified live — a catalog query is only meaningful
 * against a catalog. What is worth pinning here is the handful of details that
 * are *invisible when wrong*, which is exactly the category a live check passes
 * over because the payload still looks plausible.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const source = () => readFile(join(HERE, 'introspect.ts'), 'utf8');

/**
 * The source with its prose removed.
 *
 * Needed because the file *explains* why it does not use `count(*)`, and an
 * assertion that the string is absent matched the explanation. The same trap the
 * D-178 colour guard hit: a rule written against the file rather than against the
 * code will find the comment that describes the rule.
 */
async function code(): Promise<string> {
  return (await source())
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    // SQL comments inside the template literals, too.
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
}

describe('the introspection queries', () => {
  it('casts policy roles to text[], or the type is a lie', async () => {
    /**
     * The bug this exists for, because it cost a crashed page.
     *
     * `pg_get_userbyid` returns `name`, so `array_agg` of it is `name[]` — OID
     * 1003 — and node-pg has **no parser for that OID**. It hands back the
     * Postgres literal `'{authenticated}'` as a plain string while the
     * TypeScript type says `string[]`. Nothing complains: the API serialises a
     * string, the client's type says array, and the failure is an uncaught
     * `roles.join is not a function` in the browser that unmounts the page.
     *
     * `::text[]` is `text[]` (OID 1009), which node-pg does parse. Removing
     * either cast puts the lie back, so both are asserted.
     */
    const sql = await source();
    expect(sql, 'the per-role cast').toContain('pg_get_userbyid(r)::text');
    expect(sql, 'the array cast').toContain("ARRAY['PUBLIC'])::text[] AS roles");
  });

  it('reads column types with format_type, not information_schema', async () => {
    // `information_schema.columns.data_type` reports `character varying` and
    // drops the length. An editor completing `varchar` for a `varchar(40)`
    // column is worse than one completing nothing, because it is believed.
    const sql = await source();
    expect(sql).toContain('format_type(a.atttypid, a.atttypmod)');
    expect(sql).not.toContain('information_schema.columns');
  });

  it('never counts rows, only estimates them', async () => {
    // `count(*)` here would scan every table in a customer's production database
    // to draw a sidebar. `reltuples` is the planner's estimate and the payload
    // names it as one.
    const sql = await code();
    expect(sql).toContain('c.reltuples::bigint AS rows_estimate');
    expect(sql).not.toMatch(/count\(\*\)/);
  });

  it('filters every list by privilege', async () => {
    // They narrow for real. `developer` has USAGE on `auth` (D-189, so its
    // policies can call `auth.uid()`) and no table privileges in it (D-315, which
    // is what keeps end-user password hashes unreachable) — so `auth` appears in
    // `schemas` and none of its tables appear in `tables`. Verified live by
    // looking at the rendered list and noticing the schema had nothing under it.
    // `has_column_privilege` is the one still unexercised, since the owner holds
    // every column of its own tables.
    const sql = await source();
    for (const check of [
      'has_schema_privilege', 'has_table_privilege',
      'has_column_privilege', 'has_function_privilege',
    ]) expect(sql, check).toContain(check);
  });

  it('every list is capped, and every cap asks for one more than it keeps', async () => {
    // `LIMIT n + 1` is how truncation is *detected*: keeping n and seeing an
    // n+1th is the only way to know the list is short without a second count.
    const sql = await source();
    for (const name of ['tables', 'columns', 'functions', 'policies']) {
      expect(sql, name).toContain(`LIMITS.${name} + 1`);
    }
  });

  it('hides only the system schemas, and by name', async () => {
    const sql = await source();
    // `auth`, `storage` and `public` must never be in this list — the editors
    // need all three, and a project's own schemas are the point.
    expect(sql).toContain("['pg_catalog', 'information_schema', 'pg_toast']");
    expect(sql).not.toMatch(/HIDDEN_SCHEMAS = \[[^\]]*'(public|auth|storage)'/);
  });

  it('the caps are large enough not to bite an ordinary project', () => {
    expect(LIMITS.tables).toBeGreaterThanOrEqual(1_000);
    expect(LIMITS.columns).toBeGreaterThanOrEqual(10_000);
  });
});

describe('indexes and constraints (P7o)', () => {
  it('BYPASS: reads index key columns with a LEFT join, not an inner one', async () => {
    /**
     * The subtlety that decides whether the foreign-key fan-in warning is
     * correct or falsely reassuring.
     *
     * An expression index has attnum 0 in `indkey` and there is no
     * `pg_attribute` row for it. An inner join drops that entry and **shifts the
     * rest up**, so `create index on t (lower(a), b)` would report `b` as its
     * leading column — claiming an index that cannot serve a lookup on `b`,
     * which is the unsafe direction. The LEFT join keeps the position and puts
     * `null` there.
     *
     * Verified live: `idx_expr` on `(lower(title), status)` comes back as
     * `[null, "status"]`, and with an inner join it came back as `["status"]`.
     */
    const sql = await source();
    expect(sql).toContain('LEFT JOIN pg_catalog.pg_attribute a\n                       ON a.attrelid = c.oid AND a.attnum = k.attnum');
    expect(sql).toContain('unnest(i.indkey::int2[]) WITH ORDINALITY');
  });

  it('BYPASS: counts only key columns, so an INCLUDEd column is not one', async () => {
    // `INCLUDE`d columns are in `indkey` and cannot serve a lookup at all, so
    // counting them would be the same false reassurance by a different route.
    // Verified live: `idx_incl` on `(status) include (title)` reports `["status"]`.
    const sql = await source();
    expect(sql).toContain('k.ord <= i.indnkeyatts');
  });

  it('casts both column lists to text[], because name[] is not a JS array', async () => {
    // The D-465 lesson, applied where it would bite next: `attname` is `name`,
    // so `array_agg` of it is `name[]` (OID 1003) and node-pg hands back the
    // Postgres literal as a string while the type says an array.
    const sql = await source();
    expect((sql.match(/ARRAY\[\]::text\[\]\)::text\[\] AS columns/g) ?? []).length).toBe(2);
    expect(sql).toContain('a.attname::text ORDER BY k.ord');
  });

  it('reports an index definition as well as its parsed columns', async () => {
    // Neither is sufficient: the definition is the truth a person reads and
    // cannot be queried; the column list answers "is this the leading column"
    // and cannot express an expression.
    const sql = await source();
    expect(sql).toContain('pg_get_indexdef(i.indexrelid) AS definition');
    expect(sql).toContain('pg_get_constraintdef(con.oid) AS definition');
  });

  it('surfaces indisvalid, because a failed CONCURRENTLY build leaves one behind', async () => {
    const sql = await source();
    expect(sql).toContain('i.indisvalid AS is_valid');
  });

  it('BYPASS: excludes NOT NULL from the constraint list (contype n)', async () => {
    /**
     * Postgres 17 catalogues NOT NULL as a constraint. Listing those would put a
     * row here for every non-nullable column in the database — noise measured in
     * thousands, on a list whose cap is 2,000, so it would also make the
     * truncation notice fire on an ordinary schema. The structure table already
     * shows nullability.
     */
    const sql = await source();
    expect(sql).toContain(`con.contype = ANY(ARRAY['p','f','u','c','x']::"char"[])`);
    expect(sql).not.toMatch(/contype = ANY\(ARRAY\['[^']*'[^)]*'n'/);
  });

  it('tests privilege on the table, because an index has none of its own', async () => {
    // What decides whether you may know an index exists is whether you may see
    // the table it is on.
    const sql = await source();
    const idx = sql.slice(sql.indexOf('pg_get_indexdef'));
    expect(idx).toContain('has_table_privilege(\n              c.oid');
  });

  it('caps both lists and asks for one more than it keeps', async () => {
    const sql = await source();
    for (const name of ['indexes', 'constraints']) {
      expect(sql, name).toContain(`LIMITS.${name} + 1`);
    }
    expect(LIMITS.indexes).toBeGreaterThanOrEqual(1_000);
    expect(LIMITS.constraints).toBeGreaterThanOrEqual(1_000);
  });
});

describe("anon's table privilege, which D-108 makes the whole question", () => {
  it('BYPASS: guards on the role existing, because the function raises otherwise', async () => {
    /**
     * `has_table_privilege('anon', …)` does not return false for a role that
     * does not exist — it raises. And a database restored from `steadhold
     * export` (D-004) into vanilla Postgres has no `anon`, so the unguarded
     * version would make introspection fail outright on exactly the portability
     * case the product is built to promise.
     *
     * The `CASE` yields NULL there, which is a third state the client renders as
     * "there is no anon role here" rather than as "anonymous access is off".
     */
    const sql = await source();
    expect(sql).toContain("EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')");
    // Both of them, not just the read.
    expect((sql.match(/rolname = 'anon'/g) ?? []).length).toBe(2);
  });

  it('separates reading from writing, which are different accidents', async () => {
    const sql = await source();
    expect(sql).toContain("has_table_privilege('anon', c.oid, 'SELECT')");
    expect(sql).toContain("has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE')");
  });
});
