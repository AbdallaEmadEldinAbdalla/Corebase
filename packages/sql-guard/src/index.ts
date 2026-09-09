/**
 * The server-side half of the SQL editor's safety rails (D-134).
 *
 * It lives in a package rather than in the API because two other consumers are
 * specified to share it: the dashboard mirrors it for instant feedback, and the
 * CLI needs guard parity for its `db reset`-class commands. The important word
 * in D-134 is **authoritative** — the client's copy exists to be fast, and this
 * one exists to be right. A guard that only runs in JS in a browser is not a
 * guard; it is a suggestion to anyone holding a session cookie and `curl`.
 *
 * Two rails are decided here, and only these two, because they are the two that
 * are questions about the *text*:
 *
 *   - **Rail 2, the destructive-statement guard.** Which statements need a
 *     confirmation, and which need the object name typed back.
 *   - **Rail 4, the row-limit auto-append.** Whether a statement is a bare
 *     top-level SELECT that can safely take a `LIMIT`.
 *
 * The other four rails are properties of *how the statement is run* — the role,
 * the timeout, the transaction, read-only — and belong with the connection, not
 * here.
 */
import { split, type Statement, type Token } from './lex.ts';

export { lex, split } from './lex.ts';
export type { Token, TokenKind, Statement } from './lex.ts';

/**
 * How dangerous a statement is, and therefore what it costs to run.
 *
 * Three levels rather than a boolean, because D-134 asks for a *ladder*: a
 * `DELETE` with no `WHERE` needs a confirmation, and `DROP TABLE` needs the
 * object's name typed back. Collapsing those loses the distinction that makes
 * the confirmation mean anything — if everything demands typing, people learn
 * to type.
 */
export type Danger =
  /** Runs with no ceremony. */
  | 'safe'
  /** A confirmation flag on the request is enough. */
  | 'confirm'
  /** The object's name must be typed back, and the flag alone will not do. */
  | 'type_name';

export interface Classified {
  /** Verbatim, never reformatted. */
  sql: string;
  /** The leading keyword, upper-cased: `SELECT`, `DROP`, `WITH`, … */
  command: string;
  danger: Danger;
  /**
   * Why it is dangerous, in a sentence fit to put in a dialog. Empty for `safe`.
   * Written here rather than in the UI so the API's refusal and the dialog say
   * the same thing — a refusal that words it differently reads as a second,
   * unexplained rule.
   */
  reason: string;
  /**
   * The statement's subject, where one can be read off cheaply: the table an
   * `ALTER` alters, the first table a `DROP` drops. Null when it cannot be
   * determined. Used for the reason sentence, not for confirmation — see
   * `names`.
   */
  object: string | null;
  /**
   * Every name that must be typed back for this statement, for `type_name`.
   *
   * A list rather than one name, and the reason is a hole this used to have:
   * `DROP TABLE a, b` read its object as `a`, so typing `a` confirmed dropping
   * `b` as well. `namesToType`'s own comment claimed the opposite — "confirming
   * one of them is not confirming the other" — which was true across statements
   * and false inside one, because a comma list is one statement. The same
   * applies to `ALTER TABLE t DROP COLUMN a, DROP COLUMN b`.
   *
   * Empty for every rung below `type_name`.
   */
  names: string[];
  /** True when the statement is a bare top-level SELECT with no LIMIT. */
  limitable: boolean;
  /** True for BEGIN / COMMIT / ROLLBACK — rail 5's passthrough trigger. */
  transactionControl: boolean;
}

const WORDS = (s: Statement): Token[] => s.tokens;

/** First real token's value, or '' for an empty statement. */
function lead(s: Statement): string {
  const t = s.tokens[0];
  return t && t.kind === 'word' ? t.value : '';
}

/**
 * Does this statement carry a top-level `WHERE`?
 *
 * Top-level matters: `DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x)` has
 * one, and `DELETE FROM t` where the subquery in a `USING` clause happens to
 * contain `WHERE` does not. Depth tracking is what separates them, and getting
 * it wrong in the permissive direction would let an unqualified DELETE past the
 * guard — so this counts parenthesis depth and looks only at zero.
 */
function hasTopLevelWhere(s: Statement): boolean {
  let depth = 0;
  for (const t of WORDS(s)) {
    if (t.kind === 'punct' && t.value === '(') depth++;
    else if (t.kind === 'punct' && t.value === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && t.kind === 'word' && t.value === 'WHERE') return true;
  }
  return false;
}

/** Words that may sit between a command and its object name. */
const SKIP = new Set([
  'TABLE', 'SCHEMA', 'VIEW', 'MATERIALIZED', 'INDEX', 'SEQUENCE', 'FUNCTION',
  'PROCEDURE', 'TRIGGER', 'TYPE', 'DOMAIN', 'EXTENSION', 'DATABASE', 'ROLE',
  'USER', 'POLICY', 'PUBLICATION', 'SUBSCRIPTION', 'CONCURRENTLY',
  'IF', 'EXISTS', 'NOT', 'ONLY', 'FROM',
]);

/** A token's text exactly as the user wrote it, case included. */
function text(s: Statement, t: Token): string {
  // `word` tokens are upper-cased by the lexer, so the original has to come back
  // out of the source. `ident` tokens keep their quotes, which is deliberate: a
  // confirmation should ask for what is on the user's screen.
  return t.kind === 'ident' ? t.value : s.sql.slice(t.start - s.start, t.end - s.start);
}

/**
 * Read a dotted identifier path starting at token `i` — `public.posts`, `posts`.
 *
 * As *written* is the point: if the user typed `public.posts` then that is what
 * the dialog asks them to type back, not `posts`. Asking for a normalised form
 * of something they can see on their own screen is how a confirmation becomes a
 * puzzle.
 */
function dottedName(s: Statement, i: number): { name: string; next: number } | null {
  const toks = WORDS(s);
  const head = toks[i];
  if (!head || (head.kind !== 'word' && head.kind !== 'ident')) return null;
  const parts = [text(s, head)];
  let j = i + 1;
  while (
    j + 1 < toks.length &&
    toks[j]!.kind === 'punct' && toks[j]!.value === '.' &&
    (toks[j + 1]!.kind === 'word' || toks[j + 1]!.kind === 'ident')
  ) {
    parts.push(text(s, toks[j + 1]!));
    j += 2;
  }
  return { name: parts.join('.'), next: j };
}

/** Where the statement's own name list starts, past `TABLE`, `IF EXISTS`, `ONLY`. */
function nameListStart(s: Statement): number {
  const toks = WORDS(s);
  let i = 1;
  while (i < toks.length && toks[i]!.kind === 'word' && SKIP.has(toks[i]!.value)) i++;
  return i;
}

/**
 * Every name a statement names at the top of its own clause.
 *
 * Plural because `DROP TABLE a, b` is one statement dropping two tables. Reading
 * only the first is how typing `a` came to confirm dropping `b` too. Stops at
 * the first thing that is not a name after a comma, so `CASCADE` and `RESTRICT`
 * are never mistaken for objects.
 */
function objectNames(s: Statement): string[] {
  const toks = WORDS(s);
  const names: string[] = [];
  let i = nameListStart(s);
  for (;;) {
    const got = dottedName(s, i);
    if (!got) break;
    names.push(got.name);
    i = got.next;
    if (toks[i]?.kind !== 'punct' || toks[i]!.value !== ',') break;
    i++;
  }
  return names;
}

function objectName(s: Statement): string | null {
  return objectNames(s)[0] ?? null;
}

/**
 * The token index each action of an `ALTER TABLE` action list begins at.
 *
 * An action list, because `ALTER TABLE t DROP COLUMN a, ALTER COLUMN b DROP
 * DEFAULT` is one statement holding two actions of very different weight, and
 * the whole point of walking them separately is that the second one contains the
 * word `DROP` while destroying nothing. A guard that searched the statement for
 * `DROP` would flag dropping a *default* as dropping a column — which would then
 * demand a typed name for a reversible one-line change, and that is how people
 * learn to type through confirmations.
 *
 * Commas inside parentheses belong to a column list (`ADD CONSTRAINT … UNIQUE (a,
 * b)`), so only depth-zero commas separate actions.
 */
function alterActions(s: Statement): number[] {
  const toks = WORDS(s);
  const named = dottedName(s, nameListStart(s));
  if (!named) return [];
  const starts = [named.next];
  let depth = 0;
  for (let j = named.next; j < toks.length; j++) {
    const t = toks[j]!;
    if (t.kind === 'punct' && t.value === '(') depth++;
    else if (t.kind === 'punct' && t.value === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && t.kind === 'punct' && t.value === ',') starts.push(j + 1);
  }
  return starts;
}

/**
 * Words that make an `ALTER … DROP <word>` something other than a column drop.
 *
 * `COLUMN` is optional in Postgres (`DROP legacy_flag` is legal), so a bare word
 * after `DROP` is assumed to be a column name — which means the exceptions have
 * to be listed rather than inferred. Every one of these is reversible or
 * metadata-only, and none of them deletes a value.
 *
 * A column genuinely named `default` or `constraint` must be quoted to exist at
 * all, so it lexes as an `ident` and never matches this set.
 */
const DROP_NOT_COLUMN = new Set([
  'DEFAULT', 'NOT', 'IDENTITY', 'EXPRESSION', 'GENERATED',
  'CLUSTER', 'OIDS', 'STATISTICS',
]);

type AlterDrop =
  | { kind: 'column'; name: string | null }
  | { kind: 'constraint'; name: string | null }
  | { kind: 'other' };

/** Read one `DROP …` action of an `ALTER TABLE`, starting at its `DROP`. */
function alterDrop(s: Statement, at: number): AlterDrop {
  const toks = WORDS(s);
  let m = at + 1;
  let kind: 'column' | 'constraint' = 'column';
  const first = toks[m];
  if (first?.kind === 'word') {
    if (first.value === 'COLUMN') m++;
    else if (first.value === 'CONSTRAINT') { kind = 'constraint'; m++; }
    else if (DROP_NOT_COLUMN.has(first.value)) return { kind: 'other' };
  }
  if (toks[m]?.kind === 'word' && toks[m]!.value === 'IF') m++;
  if (toks[m]?.kind === 'word' && toks[m]!.value === 'EXISTS') m++;
  const got = dottedName(s, m);
  return { kind, name: got?.name ?? null };
}

/**
 * Is this a bare top-level SELECT that a `LIMIT` can be appended to?
 *
 * D-134 is explicit about where this must *not* apply, and each exclusion is a
 * case where appending would change the meaning or break the statement:
 *
 *   - an explicit `LIMIT` already present — appending a second is a syntax error
 *   - a non-SELECT — `LIMIT` on an `UPDATE` is a syntax error, and silently
 *     limiting a write would be far worse than either
 *   - `FETCH` / `OFFSET` forms, which are the same thing spelled differently
 *   - a CTE-wrapped or set-operation query (`WITH`, `UNION`, `INTERSECT`,
 *     `EXCEPT`), where the trailing position is not necessarily the outer
 *     query's, so the limit could land on the wrong branch
 *   - anything ending in a way that suggests it is not finished
 *
 * The bias is deliberate: a false negative shows the user 5000 rows, and a false
 * positive corrupts their query. Only the plainest shape qualifies.
 */
function isLimitable(s: Statement): boolean {
  if (lead(s) !== 'SELECT') return false;
  let depth = 0;
  for (const t of WORDS(s)) {
    if (t.kind === 'punct' && t.value === '(') depth++;
    else if (t.kind === 'punct' && t.value === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && t.kind === 'word') {
      if (t.value === 'LIMIT' || t.value === 'FETCH' || t.value === 'OFFSET') return false;
      if (t.value === 'UNION' || t.value === 'INTERSECT' || t.value === 'EXCEPT') return false;
      // `SELECT … INTO t` is a write wearing a SELECT's clothes.
      if (t.value === 'INTO') return false;
    }
  }
  return true;
}

/**
 * Join names for a sentence: `a`, `a and b`, `a, b and c`.
 *
 * Null for an empty list so the caller has to handle "no name could be read"
 * rather than printing an empty gap into a warning.
 */
function list(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length === 1) return quoted[0]!;
  return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

/** `DELETE`/`UPDATE`/`TRUNCATE`/`DROP`/`ALTER` and friends, with their reasons. */
function danger(s: Statement): Pick<Classified, 'danger' | 'reason' | 'object' | 'names'> {
  const cmd = lead(s);
  const obj = objectName(s);
  const named = obj ?? 'the object';

  switch (cmd) {
    case 'DROP': {
      const what = s.tokens[1]?.kind === 'word' ? s.tokens[1]!.value : '';
      // Only TABLE and SCHEMA reach the top of the ladder. D-134 names exactly
      // those two, and the reason is blast radius: dropping an index or a policy
      // is recoverable from the schema, and dropping a table or a schema is
      // recoverable only from a backup.
      if (what === 'TABLE' || what === 'SCHEMA') {
        // Every name in the list, not just the first: `DROP TABLE a, b` is one
        // statement and typing `a` must not confirm `b`.
        const all = objectNames(s);
        return {
          // A name that could not be read cannot be typed back, so the ladder
          // steps down rather than asking for something impossible.
          danger: all.length === 0 ? 'confirm' : 'type_name',
          reason: `Dropping ${list(all) ?? named} deletes `
            + `${all.length > 1 ? 'them' : 'it'} and everything in `
            + `${all.length > 1 ? 'them' : 'it'}. Only a backup restore brings `
            + `${all.length > 1 ? 'them' : 'it'} back.`,
          object: obj,
          names: all,
        };
      }
      return {
        danger: 'confirm',
        reason: `Dropping ${named} cannot be undone from here.`,
        object: obj,
        names: [],
      };
    }
    /**
     * `ALTER TABLE`, which the first version of this file classified as `safe`
     * without qualification — so `ALTER TABLE users DROP COLUMN email` ran from
     * the SQL console with no confirmation at all. It was found by running the
     * classifier over the table editor's operation catalog rather than by
     * reading it, which is the only reason it was found: `ALTER` reaching
     * `default:` is invisible in the code and obvious in the output.
     *
     * Only the actions that destroy something are rungs. Adding a column,
     * renaming, setting a default, enabling RLS are all `safe` and must stay
     * that way — a guard that stops everything is a guard nobody reads.
     */
    case 'ALTER': {
      const columns: string[] = [];
      const constraints: string[] = [];
      let unnamed = false;
      for (const at of alterActions(s)) {
        if (s.tokens[at]?.kind !== 'word' || s.tokens[at]!.value !== 'DROP') continue;
        const action = alterDrop(s, at);
        if (action.kind === 'other') continue;
        if (action.name === null) { unnamed = true; continue; }
        (action.kind === 'column' ? columns : constraints).push(action.name);
      }

      /**
       * The constraint sentence, said whenever constraints are dropped —
       * including alongside a column drop.
       *
       * The first version returned early on `columns.length > 0`, so `ALTER
       * TABLE t DROP CONSTRAINT ck, DROP COLUMN a` warned about the column and
       * never mentioned the constraint. The rung was right and the sentence was
       * a half-truth, which is worse than a missing warning: the user reads it,
       * believes it is the whole statement, and confirms.
       */
      const cons = list(constraints);
      const consSentence = cons === null ? '' :
        ` Dropping ${constraints.length > 1 ? 'the constraints' : 'the constraint'} `
        + `${cons} stops ${named} enforcing `
        + `${constraints.length > 1 ? 'them' : 'it'}, so rows that would have been `
        + 'rejected can be written from now on.';

      if (columns.length > 0) {
        const many = columns.length > 1;
        return {
          danger: 'type_name',
          reason: `Dropping ${many ? 'the columns' : 'the column'} ${list(columns)!} `
            + `from ${named} deletes the data in ${many ? 'them' : 'it'}. Only a `
            + `backup restore brings ${many ? 'them' : 'it'} back.${consSentence}`,
          object: obj,
          // The *columns*, not the table. Typing the table name would confirm a
          // statement the user might have misread, since the table is the one
          // thing they already know they are looking at.
          names: columns,
        };
      }
      if (constraints.length > 0) {
        return { danger: 'confirm', reason: consSentence.trim(), object: obj, names: [] };
      }
      if (unnamed) {
        // A `DROP` action whose target could not be read. Refusing to classify it
        // as safe is the whole of failing safe: an action this file does not
        // understand is not an action it can vouch for.
        return {
          danger: 'confirm',
          reason: `This statement drops part of ${named}, and what it drops could `
            + 'not be read from the text. Check it before running it.',
          object: obj,
          names: [],
        };
      }
      return { danger: 'safe', reason: '', object: obj, names: [] };
    }
    case 'TRUNCATE':
      return {
        danger: 'confirm',
        reason: `Truncating ${named} deletes every row. It is not logged row by `
          + 'row, so there is nothing to roll back to afterwards.',
        object: obj,
        names: [],
      };
    case 'DELETE':
      if (hasTopLevelWhere(s)) return { danger: 'safe', reason: '', object: obj, names: [] };
      return {
        danger: 'confirm',
        reason: `This DELETE has no WHERE clause, so it removes every row in ${named}.`,
        object: obj,
        names: [],
      };
    case 'UPDATE':
      if (hasTopLevelWhere(s)) return { danger: 'safe', reason: '', object: obj, names: [] };
      return {
        danger: 'confirm',
        reason: `This UPDATE has no WHERE clause, so it rewrites every row in ${named}.`,
        object: obj,
        names: [],
      };
    default:
      return { danger: 'safe', reason: '', object: obj, names: [] };
  }
}

const TX = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'START', 'END', 'SAVEPOINT']);

export function classifyOne(s: Statement): Classified {
  const cmd = lead(s);
  return {
    sql: s.sql,
    command: cmd,
    ...danger(s),
    limitable: isLimitable(s),
    transactionControl: TX.has(cmd),
  };
}

export interface Script {
  statements: Classified[];
  /** The highest rung any statement reaches — what the request must satisfy. */
  danger: Danger;
  /** Every statement that is not `safe`, for a dialog that lists them. */
  dangerous: Classified[];
  /**
   * Names that must be typed back, across every statement.
   *
   * Plural because confirming one object is not confirming another — which is
   * true both across statements and *inside* one, and the second half is what
   * this used to get wrong: `DROP TABLE a, b` offered only `a`.
   */
  namesToType: string[];
  /**
   * True when the script manages its own transaction, so the runner must not
   * add a wrapper (rail 5's explicit-BEGIN passthrough).
   */
  ownsTransaction: boolean;
  /**
   * The single statement a `LIMIT` may be appended to, or null. Null for a
   * multi-statement script even if the last one looks limitable: D-134 excludes
   * multi-statement scripts, because "the results" of such a run are not one
   * table and appending to one of several statements is a silent rewrite.
   */
  limitable: Classified | null;
}

const RANK: Record<Danger, number> = { safe: 0, confirm: 1, type_name: 2 };

/**
 * Classify a whole script.
 *
 * The script, not the statement, is the unit the API refuses or allows — a run
 * is one request and one transaction, so a script containing one `DROP TABLE`
 * is a `DROP TABLE` for the purposes of the guard, wherever in it that sits.
 */
export function classify(sql: string): Script {
  const statements = split(sql).map(classifyOne);
  const dangerous = statements.filter((s) => s.danger !== 'safe');
  const worst = statements.reduce<Danger>(
    (acc, s) => (RANK[s.danger] > RANK[acc] ? s.danger : acc), 'safe');
  return {
    statements,
    danger: worst,
    dangerous,
    // Flattened from each statement's own list, so a script that drops two
    // tables in one statement and a column in another asks for all three.
    namesToType: [...new Set(statements.flatMap((s) => s.names))],
    ownsTransaction: statements.some((s) => s.transactionControl),
    limitable: statements.length === 1 && statements[0]!.limitable ? statements[0]! : null,
  };
}

/**
 * Append `LIMIT n`, returning the SQL that will actually run.
 *
 * The caller shows this to the user — D-134's "executed SQL" line — which is the
 * only thing that makes an invisible rewrite acceptable. A trailing semicolon is
 * stripped first, because `SELECT 1; LIMIT 501` is not a query.
 */
export function withLimit(sql: string, limit: number): string {
  return `${sql.replace(/;\s*$/, '')} LIMIT ${limit}`;
}
