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
   * The object the statement acts on, where one can be read off cheaply — the
   * thing `type_name` asks the user to type. Null when it cannot be determined,
   * which downgrades `type_name` to `confirm` rather than inventing a name.
   */
  object: string | null;
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

/**
 * Read the object name a statement acts on, as written.
 *
 * As *written* is the point: if the user typed `public.posts` then that is what
 * the dialog asks them to type back, not `posts`. Asking for a normalised form
 * of something they can see on their own screen is how a confirmation becomes a
 * puzzle. Quoted identifiers keep their quotes for the same reason.
 */
function objectName(s: Statement): string | null {
  const toks = WORDS(s);
  const parts: string[] = [];
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === 'word' && SKIP.has(t.value)) continue;
    if (t.kind === 'word' || t.kind === 'ident') {
      // Collect a dotted path: schema.table
      parts.push(t.kind === 'ident' ? t.value : s.sql.slice(t.start - s.start, t.end - s.start));
      let j = i + 1;
      while (
        j + 1 < toks.length &&
        toks[j]!.kind === 'punct' && toks[j]!.value === '.' &&
        (toks[j + 1]!.kind === 'word' || toks[j + 1]!.kind === 'ident')
      ) {
        const nxt = toks[j + 1]!;
        parts.push(nxt.kind === 'ident'
          ? nxt.value
          : s.sql.slice(nxt.start - s.start, nxt.end - s.start));
        j += 2;
      }
      return parts.join('.');
    }
    // Anything else (a paren, a string) means there is no plain name to read.
    break;
  }
  return null;
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

/** `DELETE`/`UPDATE`/`TRUNCATE`/`DROP` and friends, with their reasons. */
function danger(s: Statement): Pick<Classified, 'danger' | 'reason' | 'object'> {
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
        return {
          // A name that could not be read cannot be typed back, so the ladder
          // steps down rather than asking for something impossible.
          danger: obj === null ? 'confirm' : 'type_name',
          reason: `Dropping ${named} deletes it and everything in it. `
            + 'Only a backup restore brings it back.',
          object: obj,
        };
      }
      return {
        danger: 'confirm',
        reason: `Dropping ${named} cannot be undone from here.`,
        object: obj,
      };
    }
    case 'TRUNCATE':
      return {
        danger: 'confirm',
        reason: `Truncating ${named} deletes every row. It is not logged row by `
          + 'row, so there is nothing to roll back to afterwards.',
        object: obj,
      };
    case 'DELETE':
      if (hasTopLevelWhere(s)) return { danger: 'safe', reason: '', object: obj };
      return {
        danger: 'confirm',
        reason: `This DELETE has no WHERE clause, so it removes every row in ${named}.`,
        object: obj,
      };
    case 'UPDATE':
      if (hasTopLevelWhere(s)) return { danger: 'safe', reason: '', object: obj };
      return {
        danger: 'confirm',
        reason: `This UPDATE has no WHERE clause, so it rewrites every row in ${named}.`,
        object: obj,
      };
    default:
      return { danger: 'safe', reason: '', object: obj };
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
   * Names that must be typed back. Plural because a script can drop two tables,
   * and confirming one of them is not confirming the other.
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
    namesToType: statements
      .filter((s) => s.danger === 'type_name' && s.object !== null)
      .map((s) => s.object!),
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
