/**
 * Every table-editor operation, compiled to the SQL that will run.
 *
 * D-133's rule is that a UI operation *is* SQL: "every UI operation compiles to
 * visible SQL, and the SQL is what runs. The editor is a SQL generator with a
 * preview, never a black box." So this module is the product's centre of gravity
 * for the write half, and two properties follow from that rule rather than from
 * taste:
 *
 * - **Its output is read by the user.** It builds the statement a person would
 *   write — lower-case keywords, one clause per line where a line is long,
 *   `public.posts` qualified — not the shortest string that parses. A preview
 *   nobody can read is a black box with extra steps.
 * - **Nothing here executes.** A `Plan` is a value. The caller shows it, the user
 *   confirms it, and the caller sends it. That is what makes this file testable
 *   without a database, and it is why every warning it carries is a *string* and
 *   not a callback.
 *
 * ## Identifiers are quoted; values are parameterised or refused
 *
 * Identifiers cannot be bound in any database, so quoting plus an allowlist at
 * the call site is the only defence — the same split `grid-sql.ts` documents, and
 * `quote()` is imported from there rather than rewritten.
 *
 * DDL is the harder half, because a `DEFAULT` and a `CHECK` are *expressions*,
 * not values, and an expression cannot be a bound parameter either. Those arrive
 * as SQL the user typed and are inserted verbatim. That is not a hole: the user
 * is authoring SQL that they can see in full before it runs, as the owner of the
 * database, with the same power their connection string already gives them
 * (D-463). Hiding an expression they typed would make the preview a lie, which
 * is the one thing this module must not be.
 *
 * ## Cost is a notice, never a rung
 *
 * The doc's ladder mixes two different things: destruction (`DROP TABLE` needs
 * the name typed) and *cost* ("table rewrite; ACCESS EXCLUSIVE lock for the
 * duration"). Only the first is enforceable, and it is enforced by the server
 * (D-468) — this module cannot be the guard, because a browser is not a guard.
 *
 * So cost is prose. A `Notice` is a fact about what running the statement will
 * do, shown in the preview with no checkbox and no extra button, and the confirm
 * control is identical whether or not one is present. The moment a cost notice
 * gets its own gate there are two ladders on one screen and the user reads them
 * as one, which devalues the one the server actually enforces.
 */
import { quote, qualified } from './grid-sql.ts';

/**
 * A fact about what running a statement costs, for the preview.
 *
 * `kind` exists so the UI can pick an icon and a tone; the `text` is the whole
 * of the meaning and is written here so the preview and any future surface say
 * the same sentence.
 */
export interface Notice {
  kind: 'lock' | 'scan' | 'api' | 'rls' | 'data';
  text: string;
}

/** What the compiler produces: a script, a name for it, and its costs. */
export interface Plan {
  /**
   * The statements, as one script separated by `;`. One script because the
   * server runs a script as one transaction, so a create-table that enables RLS
   * can never half-apply (D-464).
   */
  sql: string;
  /** For the toast: "Column added", "Table renamed". Past tense, no full stop. */
  done: string;
  /** Cost, in the order it matters. */
  notices: Notice[];
  /**
   * A `.sql` filename per D-028, for the download the loop offers.
   *
   * Not "save as migration" — that needs a server-side `schema_migrations` row
   * and a written file (D-076), and there is no endpoint. The file this names is
   * genuinely the right shape and is genuinely not recorded, and the UI says so.
   */
  filename: string;
}

/**
 * Why an operation cannot be built at all, with the fix.
 *
 * Distinct from a `Notice` because there is nothing to preview: `SET NOT NULL`
 * on a column with nulls in it will fail in the database, and finding that out
 * from a Postgres error after a confirmation dialog is a worse experience than
 * being told before. The doc asks for exactly this on one operation ("NOT NULL
 * without default on a non-empty table is blocked with the reason").
 */
export class Impossible extends Error {}

/**
 * The form is not filled in yet — which is not the same as impossible.
 *
 * Both stop the statement being built, so both are thrown; but they are
 * different messages to a person. "This table holds 250 rows and a NOT NULL
 * column with no default has no value to put in them" is a *refusal* the user
 * has to act on, and it belongs in a warning. "The table needs a name" is the
 * state every create dialog is in the moment it opens, and rendering that as a
 * warning means every dialog in the editor greets the user with something that
 * looks like a problem — the form equivalent of §6's "never show an error state
 * for something still in progress".
 *
 * A subclass rather than a flag, so `catch (e) { if (e instanceof Impossible) }`
 * at the call site keeps working and only the code that wants the distinction
 * has to know about it.
 */
export class Incomplete extends Impossible {}

/**
 * Which of the two failures this is, decided once.
 *
 * A function rather than two `instanceof` checks at the call site, because
 * `Incomplete extends Impossible` and the checks are therefore **order
 * dependent**: written the natural way round — the general case first — every
 * unfinished form renders as a refusal and the distinction silently does
 * nothing. That is a bug no type checker sees and no rendering test would catch
 * unless it happened to open a dialog with an empty field.
 *
 * Extracted here so the ordering is asserted in this file's tests rather than
 * living in a component the dashboard has no way to render in a test.
 */
export function describeFailure(err: unknown): { todo: string } | { refusal: string } {
  if (err instanceof Incomplete) return { todo: err.message };
  if (err instanceof Impossible) return { refusal: err.message };
  throw err;
}

export interface NewColumn {
  name: string;
  /** A type as written — `text`, `numeric(10,2)`, `timestamptz`. */
  type: string;
  nullable: boolean;
  /** A default *expression*, as typed. Empty means none. */
  default?: string;
}

/** What the compiler needs to know about the table it is changing. */
export interface TableFacts {
  schema: string;
  table: string;
  /** `reltuples`. `-1` means never analysed — *unknown*, not zero (D-466). */
  rowsEstimate: number;
}

/**
 * How many rows a statement will touch, said honestly.
 *
 * `reltuples` is `-1` on a table that has never been analysed, and a lock
 * warning that says "this rewrites 0 rows" on a table holding a million is worse
 * than one that admits it does not know: the number would be believed, and it is
 * the number that decides whether someone runs this now or at 3am. The lock is
 * certain and the count is not, so the sentence keeps the lock and drops the
 * count.
 */
export function rowsPhrase(rowsEstimate: number): string {
  if (rowsEstimate < 0) return 'an unknown number of rows — this table has never been analysed';
  if (rowsEstimate === 0) return 'no rows, as far as the planner knows';
  return `about ${Math.round(rowsEstimate).toLocaleString()} rows`;
}

const lock = (what: string, rows: number): Notice => ({
  kind: 'lock',
  text: `${what} takes an ACCESS EXCLUSIVE lock on the table for the duration, so `
    + `every read and write waits. It rewrites ${rowsPhrase(rows)}.`,
});

const scan = (what: string, rows: number): Notice => ({
  kind: 'scan',
  text: `${what} checks every existing row before it is accepted, which reads `
    + `${rowsPhrase(rows)}. If any row fails, nothing is applied and Postgres names `
    + 'the first row that failed.',
});

/**
 * The one notice that is about someone else's code breaking.
 *
 * A rename is cheap in the database and expensive everywhere else: the REST path
 * is derived from the table name, so `/rest/v1/posts` stops existing the moment
 * `posts` becomes `articles` and every deployed client 404s. Nothing in the
 * database will warn about it, which is exactly why the preview has to.
 */
const apiBreak = (from: string, to: string, what: 'table' | 'column'): Notice => ({
  kind: 'api',
  text: what === 'table'
    ? `Your REST endpoint /rest/v1/${from} becomes /rest/v1/${to}. Clients still `
      + 'asking for the old path get a 404 — nothing redirects.'
    : `The field named "${from}" in every API response and filter becomes "${to}". `
      + 'Clients reading the old name get nothing back for it.',
});

/** `ALTER TABLE <qualified> ` — the prefix nine operations share. */
const alter = (f: TableFacts) => `alter table ${qualified(f.schema, f.table)}`;

/**
 * The table's name for a *sentence*, unquoted.
 *
 * `qualified()` is for SQL, where the quotes are the safety property. In prose
 * they are noise a person did not type and cannot see anywhere but the preview:
 * a warning reading `"public"."articles" holds about 120 rows` makes the reader
 * parse punctuation before they reach the fact. The same correction the
 * classifier needed for the name it asks the user to type.
 */
const named = (f: TableFacts) => `${f.schema}.${f.table}`;

/**
 * A timestamped, correctly-named migration filename per D-028.
 *
 * The timestamp is the local wall clock rendered as `YYYYMMDDHHMMSS`, matching
 * the format the CLI writes, so a downloaded file drops into `migrations/`
 * beside hand-written ones and sorts correctly among them.
 */
export function migrationName(slug: string, now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  // The same shape the repo's own migrations use: lower snake case, no spaces.
  const safe = slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${stamp}_${safe || 'change'}.sql`;
}

/** A column's definition inside `CREATE TABLE` or after `ADD COLUMN`. */
function columnDefinition(c: NewColumn): string {
  if (!c.name.trim()) throw new Incomplete('Name the column.');
  if (!c.type.trim()) throw new Incomplete(`Give "${c.name}" a type.`);
  let out = `${quote(c.name)} ${c.type.trim()}`;
  if (!c.nullable) out += ' not null';
  if (c.default && c.default.trim()) out += ` default ${c.default.trim()}`;
  return out;
}

/**
 * `CREATE TABLE`, with RLS appended and visible.
 *
 * D-083 requires RLS enabled on every table Steadhold creates, and the doc is
 * explicit that the two `ALTER`s are "always appended, shown in the preview, not
 * hidden". Hiding them would be the exact failure D-133 exists to prevent: the
 * user's mental model of their own schema would be missing the most important
 * thing about it.
 *
 * **`FORCE` is deliberately not appended, against the doc's worked example.**
 * That example shows `enable` and `force` together, following the original
 * D-083 — and **D-191 superseded D-083's FORCE half**, which makes the decision
 * log the binding source here (CLAUDE.md: it wins when two documents disagree).
 *
 * The reason D-191 gives is decisive for this exact flow: `FORCE` applies the
 * policies to the table's *owner*, the owner is the customer's own `developer`
 * role, and a forced table with no policies rejects the owner's own first
 * `INSERT` with *new row violates row-level security policy*. So following the
 * doc would mean the table editor's create flow produced a table the customer
 * could not insert into — breaking every ORM, migration tool and seed script on
 * a brand-new project, which is precisely the failure D-191 was written about.
 * It buys no isolation either: that is the container boundary (D-009), and
 * `anon`/`authenticated` are non-owners already constrained by `ENABLE`.
 *
 * Following the doc here would also have made this page contradict itself.
 * `RlsPanel` tells every developer that "the rows below are the owner's view and
 * ignore these policies" — which is true because the platform baseline enables
 * without forcing, and would have been *false* for every table created through
 * this editor. Introspection reports `relrowsecurity` and not
 * `relforcerowsecurity`, so the panel could not even have told the difference.
 */
export function createTable(
  schema: string, name: string, columns: readonly NewColumn[],
): Plan {
  if (!name.trim()) throw new Incomplete('Name the table.');
  const target = qualified(schema, name);

  /**
   * The defaults every new table gets, per the IA's "every creation flow works
   * with zero fields changed: new table gets `id`/`created_at` and RLS enabled".
   *
   * `gen_random_uuid()` rather than `uuid_generate_v4()`: it is built into
   * Postgres 13+ and needs no extension, so a table created here restores into
   * vanilla Postgres — which is D-004, the whole product.
   */
  const lines = [
    `${quote('id')} uuid primary key default gen_random_uuid()`,
    `${quote('created_at')} timestamptz not null default now()`,
    ...columns.map(columnDefinition),
  ];

  const sql = [
    `create table ${target} (\n  ${lines.join(',\n  ')}\n);`,
    '',
    `alter table ${target} enable row level security;`,
  ].join('\n');

  return {
    sql,
    done: `Table ${name} created`,
    notices: [{
      kind: 'rls',
      /**
       * The two API roles fail *differently*, and saying "your API returns no
       * rows" flattens that into something misleading.
       *
       * Measured on a live project rather than reasoned: `authenticated` holds
       * the default table grant (D-108), so RLS filters and it gets `[]`.
       * `anon` holds **no grant at all**, so it gets `permission denied for
       * table …` — and a policy alone does not change that. Verified against a
       * table carrying `create policy … to anon using (true)`: still denied.
       *
       * A developer told "returns no rows" writes the policy, still gets an
       * error, and concludes the policy engine is broken. The grant is the
       * missing step and this is where to say so.
       */
      text: 'Row Level Security is on, which is the safe default — a new table is '
        + 'private rather than public by accident. Signed-in callers get an empty '
        + 'list until you add a policy; anonymous callers are refused outright, '
        + 'because a new table gives them no access at all. You still see and '
        + 'write every row here and through your connection string, because you '
        + 'own it.',
    }],
    filename: migrationName(`create_${name}`),
  };
}

export function renameTable(f: TableFacts, to: string): Plan {
  if (!to.trim()) throw new Incomplete('Type the new name.');
  // Also `Incomplete`, not a refusal: the field opens pre-filled with the
  // current name, so this is the state the dialog is in before anyone types.
  if (to === f.table) throw new Incomplete('Type a different name.');
  return {
    sql: `${alter(f)} rename to ${quote(to)};`,
    done: `Table renamed to ${to}`,
    // Instant in the database — a catalog update, no rewrite — and the reason
    // there is no lock notice. The cost is entirely outside the database.
    notices: [apiBreak(f.table, to, 'table')],
    filename: migrationName(`rename_${f.table}_to_${to}`),
  };
}

/**
 * `DROP TABLE`, `RESTRICT` implicit.
 *
 * The doc: "`RESTRICT` implicit; a dependents list is shown — CASCADE only via
 * an explicit checkbox that re-renders the preview with `CASCADE` and escalates
 * the warning". `RESTRICT` is Postgres's default and is written out anyway,
 * because the whole value of the preview is that it says what will happen: a
 * reader who does not know the default cannot tell a safe drop from a cascading
 * one, and that is the difference between losing one table and losing five.
 */
export function dropTable(f: TableFacts, cascade: boolean): Plan {
  return {
    sql: `drop table ${qualified(f.schema, f.table)}${cascade ? ' cascade' : ' restrict'};`,
    done: `Table ${f.table} dropped`,
    notices: cascade ? [{
      kind: 'data',
      text: 'CASCADE also drops everything that depends on this table — views '
        + 'built on it, foreign keys pointing at it, and the policies and '
        + 'triggers attached to those. Postgres lists what it dropped afterwards, '
        + 'which is the only record you will get.',
    }] : [{
      kind: 'data',
      text: 'RESTRICT means Postgres refuses if anything depends on this table, '
        + 'and names what does. That refusal is the useful outcome — it is how '
        + 'you find out what would have broken.',
    }],
    filename: migrationName(`drop_${f.table}`),
  };
}

/**
 * `ADD COLUMN`.
 *
 * The refusal the doc asks for is here rather than in the dialog, so the reason
 * travels with the rule. `NOT NULL` with no default on a table with rows cannot
 * succeed — there is no value to put in the existing rows — and Postgres's own
 * error for it names the constraint rather than the fix.
 *
 * The condition is `rowsEstimate !== 0`, not `> 0`: `-1` means *unknown*, and
 * refusing on unknown is right. A refusal costs the user one extra field; the
 * alternative is a confirmed statement that fails, which costs them the same
 * field plus a Postgres error and a reason to distrust the preview.
 */
export function addColumn(f: TableFacts, c: NewColumn): Plan {
  const hasDefault = Boolean(c.default && c.default.trim());
  if (!c.nullable && !hasDefault && f.rowsEstimate !== 0) {
    throw new Impossible(
      `${named(f)} holds ${rowsPhrase(f.rowsEstimate)}, and a `
      + 'NOT NULL column with no default has no value to put in them. Give it a '
      + 'default, or add it nullable and fill it in before setting NOT NULL.');
  }

  const notices: Notice[] = [];
  /**
   * Since Postgres 11 a `NOT NULL DEFAULT` add is metadata-only — no rewrite —
   * which is worth *not* warning about. A lock notice on a millisecond operation
   * is how a warning becomes wallpaper.
   *
   * A `volatile` default is the exception, because Postgres has to compute it per
   * row and does rewrite. Detecting volatility properly needs the catalog;
   * `gen_random_uuid()` and `random()` are the two that show up in practice and
   * are named rather than guessed at.
   */
  if (hasDefault && /\b(gen_random_uuid|random|uuid_generate_v4|clock_timestamp)\s*\(/i
      .test(c.default!)) {
    notices.push(lock('A default that computes a different value per row', f.rowsEstimate));
  }
  return {
    sql: `${alter(f)} add column ${columnDefinition(c)};`,
    done: `Column ${c.name} added`,
    notices,
    filename: migrationName(`add_${c.name}_to_${f.table}`),
  };
}

export function renameColumn(f: TableFacts, column: string, to: string): Plan {
  if (!to.trim()) throw new Incomplete('Type the new name.');
  if (to === column) throw new Incomplete('Type a different name.');
  return {
    sql: `${alter(f)} rename column ${quote(column)} to ${quote(to)};`,
    done: `Column renamed to ${to}`,
    notices: [apiBreak(column, to, 'column')],
    filename: migrationName(`rename_${column}_to_${to}`),
  };
}

/**
 * `ALTER COLUMN … TYPE`, always with an explicit `USING`.
 *
 * "The editor always emits an explicit `USING`, pre-filled with the straight cast
 * and editable for real conversions." Always, even where Postgres would infer
 * it, and that is the interesting decision: an inferred cast is a cast the user
 * cannot see, so a `text` → `integer` change on a column holding `"n/a"` looks
 * safe in the preview and fails in the database. Written out, the cast is the
 * thing being confirmed.
 */
export function changeType(
  f: TableFacts, column: string, type: string, using?: string,
): Plan {
  if (!type.trim()) throw new Incomplete('Give it a type.');
  const cast = (using && using.trim()) || `${quote(column)}::${type.trim()}`;
  return {
    sql: `${alter(f)} alter column ${quote(column)} type ${type.trim()}\n  using ${cast};`,
    done: `Column ${column} is now ${type.trim()}`,
    notices: [
      lock('Changing a column type', f.rowsEstimate),
      {
        kind: 'data',
        text: `Every value is passed through ${cast}. A row that cannot be `
          + 'converted stops the whole statement, and nothing is applied — so '
          + 'this either succeeds completely or changes nothing.',
      },
    ],
    filename: migrationName(`alter_${f.table}_${column}_type`),
  };
}

export function dropColumn(f: TableFacts, column: string): Plan {
  return {
    sql: `${alter(f)} drop column ${quote(column)};`,
    done: `Column ${column} dropped`,
    notices: [{
      kind: 'data',
      text: 'The values in this column are deleted. Postgres does not reclaim the '
        + 'space immediately, but the data is not readable afterwards and only a '
        + 'backup restore brings it back.',
    }],
    filename: migrationName(`drop_${column}_from_${f.table}`),
  };
}

export function setNotNull(f: TableFacts, column: string): Plan {
  return {
    sql: `${alter(f)} alter column ${quote(column)} set not null;`,
    done: `Column ${column} is now NOT NULL`,
    notices: [scan('Adding NOT NULL', f.rowsEstimate)],
    filename: migrationName(`${f.table}_${column}_not_null`),
  };
}

export function dropNotNull(f: TableFacts, column: string): Plan {
  return {
    sql: `${alter(f)} alter column ${quote(column)} drop not null;`,
    done: `Column ${column} now allows null`,
    // A catalog change with no scan and no rewrite. The cost worth naming is
    // downstream: a client that has never had to handle a null in this field
    // now can be given one.
    notices: [{
      kind: 'api',
      // No mention of `steadhold gen types` — that is the CLI, which is Phase 8
      // and does not exist. Naming an unbuilt command in a help string is the
      // same dishonesty as a nav item for an unbuilt page.
      text: 'Clients that assume this field is always present can now receive '
        + 'null in it, including anything generated from your schema types.',
    }],
    filename: migrationName(`${f.table}_${column}_nullable`),
  };
}

export function setDefault(f: TableFacts, column: string, expression: string): Plan {
  if (!expression.trim()) throw new Incomplete('Type the default expression.');
  return {
    sql: `${alter(f)} alter column ${quote(column)} set default ${expression.trim()};`,
    done: `Default set on ${column}`,
    notices: [{
      kind: 'data',
      // The thing people expect and do not get. A default is applied to *future*
      // inserts that omit the column; it does not touch a single existing row.
      text: 'This applies to rows inserted from now on. Existing rows are not '
        + 'changed — an UPDATE is what fills those in.',
    }],
    filename: migrationName(`${f.table}_${column}_default`),
  };
}

export function dropDefault(f: TableFacts, column: string): Plan {
  return {
    sql: `${alter(f)} alter column ${quote(column)} drop default;`,
    done: `Default removed from ${column}`,
    notices: [],
    filename: migrationName(`${f.table}_${column}_drop_default`),
  };
}

/**
 * Anonymous read access, which D-108 makes opt-in per table.
 *
 * The step nothing else in the product does for you, and the one most likely to
 * be missed. `anon` holds **no default table grant** — so `CREATE POLICY … TO
 * anon USING (true)` on its own leaves the table denied, and a developer who
 * writes the cookbook's "public read" policy and tests it with their anon key
 * gets `permission denied for table posts` from a policy that is perfectly
 * correct. Verified live against exactly that arrangement.
 *
 * D-108 calls this "the dashboard toggle". It is two explicit verbs here rather
 * than a toggle, and the reason is honesty: a toggle has to render its current
 * state, introspection does not report grants, and a switch that cannot tell
 * whether it is on is worse than a pair of buttons that make no claim. Recorded
 * as the gap it is.
 *
 * `SELECT` only. Anonymous *write* access is a thing a person should type out in
 * the SQL editor, not click on in a menu — and the preview is editable if they
 * disagree.
 */
export function grantAnonRead(f: TableFacts): Plan {
  return {
    sql: `grant select on ${qualified(f.schema, f.table)} to anon;`,
    done: 'Anonymous read enabled',
    notices: [{
      kind: 'rls',
      text: 'Anyone holding your project\u2019s anon key can now read this table '
        + '\u2014 filtered by its policies, and by nothing else. With RLS on and no '
        + 'policy for anon they still get nothing; with a permissive policy they '
        + 'get those rows, publicly. This is the grant that makes a policy for '
        + 'anon take effect at all.',
    }],
    filename: migrationName(`grant_anon_read_on_${f.table}`),
  };
}

/**
 * Take it away again — the coarse switch the RLS design calls
 * "this table is never API-visible" for anonymous callers.
 */
export function revokeAnonAccess(f: TableFacts): Plan {
  return {
    sql: `revoke all on ${qualified(f.schema, f.table)} from anon;`,
    done: 'Anonymous access removed',
    notices: [{
      kind: 'api',
      text: 'Anonymous callers go back to being refused outright, whatever the '
        + 'policies say \u2014 a grant sits above RLS, so removing it is the coarse '
        + 'switch. Signed-in callers are unaffected.',
    }],
    filename: migrationName(`revoke_anon_on_${f.table}`),
  };
}

/**
 * `ADD PRIMARY KEY`, the fix the grid's no-key banner offers.
 *
 * The table-editor doc asks for it by name — "a one-click 'add primary key' that
 * opens the DDL flow" — and it is what turns a read-only grid into an editable
 * one, since PK-guarded DML is the only `UPDATE` shape that cannot hit more rows
 * than the user can see (D-133).
 *
 * Two things happen that the statement does not say, so the notices do. Postgres
 * **sets NOT NULL** on the columns as a side effect, which is a change to the
 * table's contract that no client was told about; and it builds a unique index,
 * which is a full scan under an ACCESS EXCLUSIVE lock and fails outright if the
 * values are not unique. The failure is the useful case here — duplicate rows are
 * what the developer needs to know about — so the notice says the statement names
 * the duplicate rather than presenting it as a risk.
 */
export function addPrimaryKey(f: TableFacts, columns: readonly string[]): Plan {
  if (columns.length === 0) throw new Incomplete('Choose at least one column.');
  const cols = columns.map(quote).join(', ');
  return {
    sql: `${alter(f)} add primary key (${cols});`,
    done: `Primary key added on ${columns.join(', ')}`,
    notices: [
      {
        kind: 'data',
        text: `Postgres also makes ${columns.length > 1 ? 'these columns' : 'this column'} `
          + 'NOT NULL, which it does not say in the statement. Clients that send '
          + 'null here will start being rejected.',
      },
      scan('Building the key\u2019s unique index', f.rowsEstimate),
      {
        kind: 'lock',
        text: 'If any two rows share a value this fails and names one of them, '
          + 'which is the useful outcome — it is how you find the duplicates.',
      },
    ],
    filename: migrationName(`${f.table}_primary_key`),
  };
}

/**
 * The conventional index name, so a generated index looks hand-written.
 *
 * `idx_<table>_<columns>` is what the doc's own example uses
 * (`idx_posts_author_id`) and what most schemas already contain, which matters
 * for a product whose promise is that its output is indistinguishable from SQL
 * you wrote yourself (D-004).
 */
export function indexName(table: string, columns: readonly string[]): string {
  return `idx_${table}_${columns.join('_')}`
    .toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 63);
}

/**
 * `CREATE INDEX`, plain — and the "plain" is the interesting part.
 *
 * The doc leaves `CONCURRENTLY` to OQ-132, "leaning CONCURRENTLY above a
 * row-count threshold". That is still undecided, but it is no longer the
 * *blocker*: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block,
 * and the console runs every script in one (D-464, rail 5). A concurrent build
 * therefore needs a non-transactional lane in the execution path, which is a
 * server change rather than a preference — so V1 emits the plain form and says
 * what it costs, which is the honest version of an undecided question.
 *
 * `IF NOT EXISTS` is deliberately absent. It sounds free and it is not: it
 * matches on the *name*, so an index that already covers these columns under a
 * different name is invisible to it and a duplicate gets built anyway. Failing
 * with "relation already exists" is more useful than silently doubling a table's
 * write cost.
 */
export function createIndex(
  f: TableFacts, columns: readonly string[], opts: { unique: boolean; name?: string },
): Plan {
  if (columns.length === 0) throw new Incomplete('Choose at least one column.');
  const name = (opts.name && opts.name.trim()) || indexName(f.table, columns);
  return {
    sql: `create ${opts.unique ? 'unique ' : ''}index ${quote(name)}\n`
      + `  on ${qualified(f.schema, f.table)} (${columns.map(quote).join(', ')});`,
    done: `Index ${name} created`,
    notices: [
      {
        kind: 'lock',
        text: `Building the index blocks writes to ${named(f)} until it finishes — `
          + `reads keep working. It reads ${rowsPhrase(f.rowsEstimate)}. Building `
          + 'it without the write lock needs CREATE INDEX CONCURRENTLY, which '
          + 'cannot run inside a transaction and so cannot run from this console '
          + 'yet.',
      },
      ...(opts.unique ? [{
        kind: 'scan' as const,
        text: 'A unique index also fails if any two rows already share these '
          + 'values, and names one of them — which is the useful outcome.',
      }] : []),
      {
        kind: 'api',
        text: 'Every index makes writes to this table a little slower and takes '
          + 'disk. Worth having for a column you filter or join on; worth '
          + 'removing if you stop.',
      },
    ],
    filename: migrationName(`create_${name}`),
  };
}

/**
 * `ADD CONSTRAINT … FOREIGN KEY`.
 *
 * The doc asks for a **fan-in warning**: "if the referencing column has no
 * index, the preview carries an inline notice — deletes/updates on `users` will
 * seq-scan `posts` — with a one-click 'also create index'".
 *
 * The condition is now answerable — introspection reports indexes (P7o) — so
 * `indexed` is a **three-way**: `true` suppresses the notice, `false` states it
 * as fact, and *absent* keeps the earlier wording that admits it cannot tell.
 * The unknown branch stays rather than being deleted, because a caller that does
 * not have the index list should say so instead of implying the reassuring
 * answer, and "absent" is the only value that cannot be confused with "no".
 *
 * The check the caller makes is `columns[0] === column`, and it is right *because*
 * an expression index reports `null` in that slot: an index on `(lower(a), b)`
 * cannot serve a lookup on either, and it would have claimed `b` if the
 * introspection query had used an inner join.
 */
export function addForeignKey(
  f: TableFacts,
  fk: {
    column: string;
    targetSchema: string;
    targetTable: string;
    targetColumn: string;
    /** `CASCADE`, `SET NULL`, `RESTRICT`… as written. Empty means Postgres's default. */
    onDelete?: string;
    alsoIndex?: boolean;
    name?: string;
    /** Whether the referencing column already has an index leading with it. */
    indexed?: boolean;
  },
): Plan {
  if (!fk.column) throw new Incomplete('Choose the column that points at the other table.');
  if (!fk.targetTable) throw new Incomplete('Choose the table it points at.');
  if (!fk.targetColumn) throw new Incomplete('Choose the column it points at.');

  const name = (fk.name && fk.name.trim())
    || `${f.table}_${fk.column}_fkey`.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const statements = [
    `${alter(f)} add constraint ${quote(name)}\n`
    + `  foreign key (${quote(fk.column)})\n`
    + `  references ${qualified(fk.targetSchema, fk.targetTable)} (${quote(fk.targetColumn)})`
    + `${fk.onDelete && fk.onDelete.trim() ? `\n  on delete ${fk.onDelete.trim()}` : ''};`,
  ];
  if (fk.alsoIndex) {
    statements.push('', createIndex(f, [fk.column], { unique: false }).sql);
  }

  return {
    sql: statements.join('\n'),
    done: `Foreign key ${name} added`,
    notices: [
      scan('Adding a foreign key', f.rowsEstimate),
      {
        kind: 'data',
        text: `Any row whose ${fk.column} does not match a row in `
          + `${fk.targetSchema}.${fk.targetTable} stops the whole statement, and `
          + 'Postgres names it. Nothing is applied unless every row matches.',
      },
      ...(fk.alsoIndex || fk.indexed === true ? [] : [{
        kind: 'api' as const,
        // The doc's fan-in warning. Stated as fact when the index list says so,
        // and as an admitted unknown when the caller has no list.
        text: fk.indexed === false
          ? `${fk.column} has no index leading with it, so every delete or update `
            + `of a ${fk.targetTable} row will scan ${named(f)} to check this `
            + 'constraint. Tick the box below to add one in the same statement.'
          : `Unless ${fk.column} is indexed, every delete or update of a `
            + `${fk.targetTable} row has to scan ${named(f)} to check this `
            + 'constraint — and this caller has no index list, so it cannot tell '
            + 'you whether it is.',
      }]),
    ],
    filename: migrationName(`add_${name}`),
  };
}

/** `ADD CONSTRAINT … CHECK (…)`. */
export function addCheck(f: TableFacts, expression: string, name?: string): Plan {
  if (!expression.trim()) throw new Incomplete('Type the condition every row must satisfy.');
  const constraint = (name && name.trim())
    || `${f.table}_check`.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return {
    sql: `${alter(f)} add constraint ${quote(constraint)}\n`
      + `  check (${expression.trim()});`,
    done: `Check ${constraint} added`,
    notices: [
      scan('Adding a CHECK constraint', f.rowsEstimate),
      {
        kind: 'data',
        text: 'A row that already fails the condition stops the statement and '
          + 'Postgres names the constraint — which is how you find out the data '
          + 'does not match the rule you thought it followed.',
      },
    ],
    filename: migrationName(`add_${constraint}`),
  };
}

/** `ADD CONSTRAINT … UNIQUE (…)`. */
export function addUnique(
  f: TableFacts, columns: readonly string[], name?: string,
): Plan {
  if (columns.length === 0) throw new Incomplete('Choose at least one column.');
  const constraint = (name && name.trim())
    || `${f.table}_${columns.join('_')}_key`.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return {
    sql: `${alter(f)} add constraint ${quote(constraint)}\n`
      + `  unique (${columns.map(quote).join(', ')});`,
    done: `Unique constraint ${constraint} added`,
    notices: [
      {
        kind: 'lock',
        text: `This builds a unique index, which blocks writes to ${named(f)} `
          + `until it finishes and reads ${rowsPhrase(f.rowsEstimate)}.`,
      },
      {
        kind: 'data',
        text: columns.length > 1
          ? 'Uniqueness is across the combination, not each column — two rows may '
            + 'share one value as long as the whole set differs. If any two rows '
            + 'already match, the statement fails and names one of them.'
          : 'If any two rows already share a value the statement fails and names '
            + 'one of them, which is the useful outcome.',
      },
    ],
    filename: migrationName(`add_${constraint}`),
  };
}

/**
 * `DROP INDEX`.
 *
 * Schema-qualified, because an index lives in a schema and an unqualified name
 * resolves against `search_path` — the same reason every other statement here is
 * qualified.
 *
 * `invalid` changes the sentence rather than the statement. An index left behind
 * by a failed `CREATE INDEX CONCURRENTLY` is costing writes and serving nothing,
 * so dropping it has no downside worth warning about — and saying "queries that
 * relied on it will get slower" about an index Postgres refuses to use would be
 * a warning about something that cannot happen.
 */
export function dropIndex(
  schema: string, name: string, opts: { invalid?: boolean } = {},
): Plan {
  return {
    sql: `drop index ${qualified(schema, name)};`,
    done: `Index ${name} dropped`,
    notices: [opts.invalid ? {
      kind: 'data',
      text: 'This index is invalid — Postgres will not use it for any query, and '
        + 'it still costs write time and disk on every insert. Dropping it is the '
        + 'only way to be rid of it; rebuild it afterwards if you wanted it.',
    } : {
      kind: 'api',
      text: 'Queries relying on this index fall back to whatever else is '
        + 'available, usually a sequential scan. Nothing breaks and some things '
        + 'get slower — and rebuilding it later takes the write lock again.',
    }],
    filename: migrationName(`drop_${name}`),
  };
}

/**
 * `ALTER TABLE … DROP CONSTRAINT`.
 *
 * The `kind` argument exists for one case: dropping a **primary key** has a
 * consequence no Postgres message mentions and no SQL warning covers. It makes
 * the grid read-only, because PK-guarded DML is the only `UPDATE` shape that
 * cannot silently hit more rows than the user can see (D-133), and it makes
 * paging unstable because there is no longer a stable order to page by. That is a
 * *product* consequence, and the only place it can be said is here.
 *
 * Not blocked, though. It is the customer's database, the classifier already
 * puts it on the `confirm` rung (D-468), and a table with a natural key the
 * customer is about to replace is a perfectly ordinary reason to do this.
 */
export function dropConstraint(f: TableFacts, name: string, kind: string): Plan {
  const consequence: Notice[] = kind === 'primary_key' ? [{
    kind: 'data',
    text: 'This is the table\u2019s primary key. Without one the grid becomes '
      + 'read-only — row editing needs a key to target exactly one row — and '
      + 'paging stops being stable, so a row can appear twice or not at all. '
      + 'The index behind it goes too.',
  }] : kind === 'unique' ? [{
    kind: 'data',
    text: 'The index behind this constraint is dropped with it, so queries that '
      + 'were using it get slower as well.',
  }] : [];

  return {
    sql: `${alter(f)} drop constraint ${quote(name)};`,
    done: `Constraint ${name} dropped`,
    notices: [
      ...consequence,
      {
        kind: 'api',
        // The same reassurance in the same words for every kind, because it is
        // the same fact — a drop is a change to what is *allowed*, never to what
        // is stored. Two phrasings of one fact was caught by a test asserting it
        // across all four kinds, which is the reason to assert across all four.
        text: (kind === 'foreign_key'
          ? `Rows in ${named(f)} may then point at rows that do not exist, and `
            + 'nothing will stop new ones doing so. '
          : `Rows that would have been rejected can be written to ${named(f)} `
            + 'from now on. ')
          + 'What is already stored is not checked or changed.',
      },
    ],
    filename: migrationName(`drop_${name}`),
  };
}

/**
 * `ENABLE ROW LEVEL SECURITY`, the one-click fix behind the red banner.
 *
 * `FORCE` is deliberately **not** appended here, and this is the one place the
 * doc's own worked example is not followed. The doc pairs the two everywhere,
 * and for a table being created that is right. For a table that already has data
 * and a developer working against it, forcing RLS makes their *own* next query
 * return nothing, from the connection string as well as from this grid — so the
 * fix for "anyone with the anon key can read this table" would present as "my
 * database is empty". Enabling without forcing closes the hole the banner is
 * about (`anon` and `authenticated` are not the owner) and leaves the owner's
 * view intact, which matches what every other table in the project does
 * (`30-force-rls.sql`). Recorded as a deliberate divergence, not an omission.
 */
export function enableRls(f: TableFacts): Plan {
  return {
    sql: `${alter(f)} enable row level security;`,
    done: 'Row Level Security enabled',
    notices: [{
      kind: 'rls',
      text: 'With RLS on and no policies, signed-in callers get an empty list '
        + 'from your API — which is the safe state, not a broken one. You keep '
        + 'seeing every row here and through your connection string, because you '
        + 'own the table. A policy is what opens it up.',
    }],
    filename: migrationName(`enable_rls_on_${f.table}`),
  };
}
