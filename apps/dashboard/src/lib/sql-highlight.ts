/**
 * Syntax highlighting for the SQL the editor shows.
 *
 * The table-editor spec asks for a "docked, read-only, **syntax-highlighted**
 * pane", and `shell.css` has carried `.tok-key`, `.tok-str` and `.tok-com` since
 * the code block was built — three rules that matched nothing in the entire
 * dashboard. Dead CSS is a claim the product makes and does not keep, and it is
 * invisible precisely because nothing errors.
 *
 * ## Why not a library
 *
 * Highlight.js and Prism are 20–40 kB to colour three token classes, and both
 * want to parse HTML strings, which means either `dangerouslySetInnerHTML` or a
 * sanitiser. This returns *data* — an array of spans the caller renders as React
 * nodes — so no HTML is ever constructed and there is nothing to sanitise. The
 * SQL being highlighted is the user's own, but it is also going to be *executed*,
 * and an XSS in a preview pane would be a strange way to lose to a string that
 * was about to run as SQL anyway.
 *
 * ## Why not reuse `packages/sql-guard/src/lex.ts`
 *
 * It is the right lexer and the wrong output. It drops comments and whitespace —
 * correctly, since a classifier must not be able to see a keyword inside a
 * comment — and highlighting needs every byte back in order, comments included,
 * so that the rendered text is character-for-character the SQL that runs. A
 * preview that silently omits a comment is a preview you cannot trust to be
 * verbatim. The two agree on what they must: string literals, dollar quotes and
 * nested block comments are skipped the same way, and the guard remains the only
 * thing that decides anything.
 */

export type TokenClass = 'key' | 'str' | 'com' | 'num' | 'plain';

export interface Span {
  text: string;
  cls: TokenClass;
}

/**
 * The words worth colouring, which is not "every SQL keyword".
 *
 * The purpose here is to make the *shape* of a statement readable at a glance —
 * where it starts, what it acts on, where the clauses are. Colouring 200 reserved
 * words gives a wall of colour with no shape, which is worse than none: the eye
 * uses colour to find the exception, so the exception has to be rare.
 *
 * Type names are deliberately absent. `text` and `timestamptz` read as values in
 * a `CREATE TABLE`, and colouring them as keywords makes a column list look like
 * a clause list.
 */
const KEYWORDS = new Set([
  'ALTER', 'CREATE', 'DROP', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
  'TABLE', 'COLUMN', 'INDEX', 'VIEW', 'SCHEMA', 'CONSTRAINT', 'POLICY', 'TRIGGER',
  'FUNCTION', 'SEQUENCE', 'TYPE', 'DATABASE', 'ROLE', 'EXTENSION',
  'FROM', 'WHERE', 'INTO', 'VALUES', 'SET', 'ADD', 'RENAME', 'TO', 'USING',
  'ON', 'AND', 'OR', 'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'FOREIGN', 'KEY',
  'REFERENCES', 'UNIQUE', 'CHECK', 'CASCADE', 'RESTRICT', 'IF', 'EXISTS',
  'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'AS', 'DISTINCT',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'GRANT', 'REVOKE', 'ENABLE', 'DISABLE',
  'FORCE', 'ROW', 'LEVEL', 'SECURITY', 'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE',
  'END', 'IS', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'COUNT', 'ALL', 'ONLY',
  'IDENTITY', 'GENERATED', 'ALWAYS', 'STORED', 'COLLATE', 'CONCURRENTLY',
  'RETURNING', 'CONFLICT', 'DO', 'NOTHING', 'PUBLIC', 'CURRENT_USER',
]);

const isWordStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127;
const isWordChar = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;

/**
 * Split SQL into spans, preserving every character.
 *
 * The invariant that makes this safe to render as a preview is asserted in the
 * tests: joining the spans back together returns the input exactly. A highlighter
 * that can lose a character is a highlighter that can show the user a statement
 * other than the one that will run, and this pane's whole job is that they are
 * the same.
 *
 * Unterminated constructs run to the end of input rather than throwing, matching
 * the guard's lexer: the user is mid-typing most of the time, and a highlighter
 * that throws on an open quote turns "you have not finished" into a blank pane.
 */
export function highlight(sql: string): Span[] {
  const out: Span[] = [];
  const push = (text: string, cls: TokenClass) => {
    if (!text) return;
    // Merge runs of the same class so the caller renders one node per colour
    // change rather than one per character.
    const last = out[out.length - 1];
    if (last && last.cls === cls) last.text += text;
    else out.push({ text, cls });
  };

  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;

    // Line comment, to the end of the line but not including its newline —
    // the newline is plain, so a run of comments does not merge across lines.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      push(sql.slice(i, end), 'com');
      i = end;
      continue;
    }

    // Block comment. Postgres **nests** these, unlike C, so depth is counted:
    // `/* a /* b */ still a comment */`. Getting this wrong ends the comment
    // early and colours real SQL as prose.
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      push(sql.slice(i, j), 'com');
      i = j;
      continue;
    }

    // Dollar-quoted body, tagged or bare — how every function body arrives, and
    // it may contain any character at all, semicolons and `--` included.
    if (c === '$') {
      const tag = /^\$[A-Za-z_-￿][A-Za-z0-9_-￿]*\$|^\$\$/
        .exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close === -1 ? n : close + tag[0].length;
        push(sql.slice(i, end), 'str');
        i = end;
        continue;
      }
    }

    // String literal. A doubled quote is the escape, and `E'...'` additionally
    // allows a backslash escape — so the two need different scanners and
    // conflating them ends an `E'\''` literal one character early.
    if (c === "'" || ((c === 'E' || c === 'e') && sql[i + 1] === "'")) {
      const escaped = c !== "'";
      let j = i + (escaped ? 2 : 1);
      while (j < n) {
        if (escaped && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      push(sql.slice(i, j), 'str');
      i = j;
      continue;
    }

    /**
     * Quoted identifier — `"odd name"` — which is **plain, not a string**.
     *
     * It names a column; it is not a value. Colouring it as a string would say
     * the opposite of what it means, and this editor quotes every identifier it
     * generates, so nearly every table and column on screen would be the colour
     * reserved for literals.
     */
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      push(sql.slice(i, j), 'plain');
      i = j;
      continue;
    }

    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j]!)) j++;
      const word = sql.slice(i, j);
      push(word, KEYWORDS.has(word.toUpperCase()) ? 'key' : 'plain');
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(sql[j]!)) {
        // `1e-5` is one number; `1-5` is a subtraction. A sign only continues
        // the literal directly after an exponent.
        if (/[+-]/.test(sql[j]!) && !/[eE]/.test(sql[j - 1]!)) break;
        j++;
      }
      push(sql.slice(i, j), 'num');
      i = j;
      continue;
    }

    push(c, 'plain');
    i++;
  }

  return out;
}
