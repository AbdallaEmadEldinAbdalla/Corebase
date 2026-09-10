/**
 * The introspection payload, turned into what CodeMirror's SQL language wants.
 *
 * `@codemirror/lang-sql` does the hard half already: given a nested `schema`
 * namespace it completes tables after `FROM`, columns after a table name, and —
 * the part worth having — columns of the right table after an *alias*, by
 * parsing the statement's own `FROM` clause. Writing that ourselves would be a
 * second SQL parser in a product that already refuses to grow one
 * (`packages/sql-guard/src/lex.ts` says so in its first line).
 *
 * So this module is a translation, and the interesting decisions are all about
 * *what to offer*, not how.
 *
 * ## Why the shape is nested and duplicated
 *
 * A `SQLNamespace` is a tree, and a developer writes both `posts` and
 * `public.posts` — the first because `search_path` makes it work, the second
 * because it is unambiguous. Offering only the qualified form means completion
 * stops working the moment someone types the name they actually use, so tables
 * in the **default schema** appear twice: once under their schema and once at
 * the top level. Every other schema appears only qualified, which is also how
 * the database resolves them.
 */
import type { Introspection } from './api.ts';

/** What CodeMirror needs, without importing its types into a pure module. */
export interface CompletionSchema {
  schema: Record<string, unknown>;
  defaultSchema: string;
  /** Function and role names, offered as plain keyword-like completions. */
  extra: { label: string; detail: string; type: string }[];
}

/**
 * The schema a completion is resolved against.
 *
 * `public` unless the project does not have one — a customer can drop it — in
 * which case the first schema they own is the better guess than a name that does
 * not exist. Guessing wrong costs an unqualified completion; guessing `public`
 * when it is absent costs *every* unqualified completion.
 */
export function defaultSchemaOf(intro: Pick<Introspection, 'schemas'>): string {
  return intro.schemas.includes('public') ? 'public' : (intro.schemas[0] ?? 'public');
}

/**
 * Build the completion tree.
 *
 * Columns are ordered by their **position in the table**, not alphabetically.
 * The order a developer wrote their columns in carries meaning — the key first,
 * then the fields that matter, then the incidental ones — and alphabetising it
 * throws that away and puts `archived_at` above `id`.
 */
export function completionSchema(intro: Introspection): CompletionSchema {
  const defaultSchema = defaultSchemaOf(intro);

  /** `schema.table` → ordered column names. */
  const columns = new Map<string, string[]>();
  for (const c of [...intro.columns].sort((a, b) => a.position - b.position)) {
    const key = `${c.schema}.${c.table}`;
    const list = columns.get(key);
    if (list) list.push(c.name); else columns.set(key, [c.name]);
  }

  /**
   * Every schema gets a bucket, including the ones with no visible tables.
   *
   * Not an edge case — it is the `auth` schema on every project. `developer`
   * holds `USAGE` there so its policies can call `auth.uid()` (D-189) and **no
   * table privileges at all** (D-315, which is what keeps end-user password
   * hashes unreachable), so `auth` appears in `schemas` and none of its tables
   * appear in `tables`. Seeding from `schemas` rather than from the tables means
   * `auth.` is a namespace the editor knows about rather than a word it has
   * never heard of.
   *
   * It is also what makes the shadow check below meaningful: a key has to exist
   * before a table can fail to overwrite it.
   */
  const schema: Record<string, unknown> = {};
  for (const name of intro.schemas) schema[name] = {};

  for (const t of intro.tables) {
    const cols = columns.get(`${t.schema}.${t.name}`) ?? [];
    // Nested under the schema, always.
    // `??=` still, because a table can be in a schema the caller did not list —
    // the payload caps its lists independently, so a truncated `schemas` must
    // not drop a table that did arrive.
    const bucket = (schema[t.schema] ??= {}) as Record<string, unknown>;
    bucket[t.name] = cols;
    /**
     * And again at the top level for the default schema, so `posts` completes
     * as well as `public.posts`.
     *
     * Skipped when the name would collide with a schema's own name — a table
     * called `storage` in `public` would otherwise shadow the `storage` schema
     * and its tables would stop completing entirely. The qualified form still
     * works, which is the right thing to lose in a collision this rare.
     */
    if (t.schema === defaultSchema && !intro.schemas.includes(t.name)) {
      schema[t.name] = cols;
    }
  }

  /**
   * Functions and roles, as flat completions.
   *
   * They are not part of the namespace tree because they are not *reached
   * through* a table: `auth.uid()` is typed at the start of an expression, and a
   * role name appears after `TO` in a policy. The tree completes what follows a
   * dot; these complete what follows nothing.
   *
   * `auth.uid()` and `auth.role()` are the two the RLS cookbook is written
   * around, so they are offered with their schema attached — a developer writing
   * a policy needs `auth.uid()` and not `uid()`, and the unqualified form fails
   * with a function-does-not-exist error that reads as the helper being missing.
   */
  const extra: CompletionSchema['extra'] = [];
  for (const f of intro.functions) {
    const qualified = f.schema === defaultSchema ? f.name : `${f.schema}.${f.name}`;
    extra.push({
      label: `${qualified}(`,
      // The signature, which is the thing a completion list can give that
      // documentation cannot: `uid() → uuid` answers "what do I get back".
      detail: `${f.arguments ? f.arguments : ''}) → ${f.returns}`,
      type: 'function',
    });
  }
  for (const r of intro.roles) {
    extra.push({ label: r, detail: 'role', type: 'keyword' });
  }

  return { schema, defaultSchema, extra };
}

/**
 * Whether a failed or empty run is probably an RLS artefact rather than a bug.
 *
 * The nudge this drives is the difference between a five-minute confusion and a
 * five-hour one: a `SELECT` returning nothing under `anon` looks exactly like a
 * broken query, and the answer is almost always "no policy matches". `42501` is
 * `insufficient_privilege`, which under a non-admin role means the *grant* is
 * missing rather than the policy — D-108 makes `anon` opt-in per table, so that
 * is the common case and it deserves its own sentence.
 */
export function rlsHint(
  role: 'admin' | 'anon' | 'authenticated',
  outcome: { rowCount: number | null; sqlstate: string | null },
): string | null {
  if (role === 'admin') return null;
  if (outcome.sqlstate === '42501') {
    return `Running as ${role}: permission denied means the role holds no grant `
      + 'on that table, which is separate from its policies. A policy alone does '
      + 'not open a table up.';
  }
  if (outcome.sqlstate !== null) return null;
  if (outcome.rowCount === 0) {
    return `Running as ${role}: zero rows may mean no policy matches rather than `
      + 'no data. Run the same statement as admin to see what is there.';
  }
  return null;
}
