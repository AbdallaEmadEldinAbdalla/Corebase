/**
 * Just enough SQL lexing to answer three questions honestly.
 *
 * This is **not** a parser and must never grow into one. It exists to answer:
 * where does one statement end and the next begin, which keyword leads a
 * statement, and does a statement carry a `WHERE`. Everything it does is
 * therefore about *skipping* the constructs that make naive string matching
 * wrong — and that list is the whole reason this file exists rather than a regex
 * at the call site:
 *
 *   - line comments and nested block comments (Postgres nests them; C does not)
 *   - string literals, with a doubled quote as the escape
 *   - quoted identifiers, same escape
 *   - dollar-quoted bodies, tagged or bare, which is how every function body
 *     arrives and which may contain any character at all — semicolons and the
 *     word DROP included
 *   - `E'...'` strings, where a backslash escapes the quote
 *
 * A classifier that misses any of these does not fail safe in one direction. It
 * fails in both. `SELECT '; DROP TABLE users; --'` is one harmless statement,
 * and splitting it on semicolons makes it three, one of which reads as a DROP.
 * The reverse is worse: a `DELETE` with no `WHERE` sitting inside a function
 * body would be classified as a destructive statement if the body were scanned
 * as code, and — much worse — a real `DELETE` could be hidden from the guard by
 * anything the lexer mis-skips.
 */

export type TokenKind = 'word' | 'punct' | 'string' | 'ident' | 'number';

export interface Token {
  kind: TokenKind;
  /** Upper-cased for `word`, verbatim otherwise. Comments are never emitted. */
  value: string;
  start: number;
  end: number;
}

/**
 * Identifiers may begin with a letter or underscore, or any non-ASCII character
 * — Postgres allows those in unquoted identifiers, and `SELECT * FROM café`
 * must lex as a word rather than as punctuation.
 */
const isWordStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) > 127;
const isWordChar = (c: string) =>
  /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;

/**
 * Tokenise, dropping comments and whitespace.
 *
 * An unterminated construct is not an error here. The server rejects the SQL
 * anyway, with a better message than this could produce, and a lexer that throws
 * turns "you have a typo" into "the guard crashed". Unterminated simply runs to
 * the end of input, which is also the safe reading: everything after the opening
 * quote is treated as data, so nothing inside it can be mistaken for a keyword.
 */
export function lex(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i]!;

    if (/\s/.test(c)) { i++; continue; }

    // line comment
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // block comment, nested
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 0;
      while (i < n) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--; i += 2;
          if (depth === 0) break;
          continue;
        }
        i++;
      }
      continue;
    }

    // dollar-quoted body: $$ ... $$ or $tag$ ... $tag$
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const open = tag[0];
        const start = i;
        const close = sql.indexOf(open, i + open.length);
        i = close === -1 ? n : close + open.length;
        out.push({ kind: 'string', value: sql.slice(start, i), start, end: i });
        continue;
      }
    }

    // E'...' escape string: a backslash escapes the next character
    if ((c === 'E' || c === 'e') && sql[i + 1] === "'") {
      const start = i;
      i += 2;
      while (i < n) {
        if (sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out.push({ kind: 'string', value: sql.slice(start, i), start, end: i });
      continue;
    }

    // ordinary string literal
    if (c === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out.push({ kind: 'string', value: sql.slice(start, i), start, end: i });
      continue;
    }

    // quoted identifier
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out.push({ kind: 'ident', value: sql.slice(start, i), start, end: i });
      continue;
    }

    // number, only so a bare digit never reads as a word
    if (/[0-9]/.test(c)) {
      const start = i;
      i++;
      while (i < n && /[0-9._]/.test(sql[i]!)) i++;
      out.push({ kind: 'number', value: sql.slice(start, i), start, end: i });
      continue;
    }

    if (isWordStart(c)) {
      const start = i;
      while (i < n && isWordChar(sql[i]!)) i++;
      out.push({ kind: 'word', value: sql.slice(start, i).toUpperCase(), start, end: i });
      continue;
    }

    out.push({ kind: 'punct', value: c, start: i, end: i + 1 });
    i++;
  }

  return out;
}

export interface Statement {
  /** Verbatim source, trimmed. Never normalised — D-132's "nothing reformatted". */
  sql: string;
  tokens: Token[];
  start: number;
  end: number;
}

/**
 * Split into statements on top-level semicolons.
 *
 * "Top-level" means not inside parentheses. A semicolon cannot legally appear
 * inside them, so the depth tracking is really about not being fooled by one
 * that does — the guard's job is to be right about malformed input too, because
 * malformed input is exactly what an attacker sends.
 *
 * Comments and quoted material are already gone by the time we look, which is
 * the whole reason for lexing first rather than splitting the raw string.
 */
export function split(sql: string): Statement[] {
  const tokens = lex(sql);
  const out: Statement[] = [];
  let depth = 0;
  let from = 0;

  const push = (toks: Token[], endChar: number) => {
    if (toks.length === 0) return;
    const s = toks[0]!.start;
    const text = sql.slice(s, endChar).trim();
    if (text.length === 0) return;
    out.push({ sql: text, tokens: toks, start: s, end: endChar });
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === 'punct' && t.value === '(') depth++;
    else if (t.kind === 'punct' && t.value === ')') depth = Math.max(0, depth - 1);
    else if (t.kind === 'punct' && t.value === ';' && depth === 0) {
      push(tokens.slice(from, k), t.start);
      from = k + 1;
    }
  }
  if (from < tokens.length) push(tokens.slice(from), sql.length);
  return out;
}
