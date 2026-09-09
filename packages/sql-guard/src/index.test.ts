import { describe, it, expect } from 'vitest';
import { classify, classifyOne, withLimit, split, lex } from './index.ts';

/**
 * The guard is the authoritative half of rails 2 and 4 (D-134), so what needs
 * testing is not that `DROP TABLE` is dangerous. It is the two directions this
 * can be wrong:
 *
 *   - **Missed danger** — a destructive statement the classifier calls safe.
 *     Every case here is a way to hide a keyword from a naive matcher: inside a
 *     comment's neighbour, past a dollar-quoted body, behind a `WHERE` that
 *     belongs to a subquery. That direction is a bypass, and a bypass is the
 *     only failure that matters.
 *   - **Invented danger** — a safe statement the classifier blocks, or a query
 *     it rewrites into something that no longer runs. That direction is what
 *     makes people work around a guard, which ends the same way.
 */

const one = (sql: string) => classifyOne(split(sql)[0]!);

describe('lexing the things that fool string matching', () => {
  it('a semicolon inside a string literal does not split a statement', () => {
    // Split naively, this reads as three statements, one of them a DROP.
    const s = split(`SELECT '; DROP TABLE users; --'`);
    expect(s).toHaveLength(1);
    expect(classify(`SELECT '; DROP TABLE users; --'`).danger).toBe('safe');
  });

  it('a doubled quote does not end a string early', () => {
    expect(split(`SELECT 'it''s; fine'`)).toHaveLength(1);
  });

  it('a dollar-quoted body is data, however much SQL it contains', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ DROP TABLE users; DELETE FROM t $$ LANGUAGE sql`;
    const s = split(sql);
    expect(s).toHaveLength(1);
    // The function body is not being executed now, so it is not this run's risk.
    expect(classify(sql).danger).toBe('safe');
  });

  it('a tagged dollar quote is matched by its tag, not by the next $$', () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $body$ SELECT $$inner$$ $body$ LANGUAGE sql`;
    expect(split(sql)).toHaveLength(1);
  });

  it('nested block comments close at the right depth', () => {
    // A C-style scanner stops at the first `*/` and treats `DROP TABLE t` as code.
    const sql = `SELECT 1 /* outer /* inner */ still comment */`;
    expect(classify(sql).danger).toBe('safe');
    expect(classify(`/* a /* b */ c */ DROP TABLE t`).danger).toBe('type_name');
  });

  it('a line comment hides the rest of its line and nothing more', () => {
    expect(classify(`SELECT 1 -- DROP TABLE t\n`).danger).toBe('safe');
    expect(classify(`SELECT 1; -- comment\nDROP TABLE t`).danger).toBe('type_name');
  });

  it("an E'' string's backslash-escaped quote does not end it", () => {
    expect(split(String.raw`SELECT E'a\'; DROP TABLE t; --'`)).toHaveLength(1);
  });

  it('a quoted identifier may contain a semicolon', () => {
    expect(split(`SELECT * FROM "odd;name"`)).toHaveLength(1);
  });

  it('an unterminated string runs to the end rather than throwing', () => {
    // The safe reading: everything after the quote is data, so no keyword in it
    // can be mistaken for code. The server will reject the SQL on its own.
    expect(() => classify(`SELECT 'unterminated`)).not.toThrow();
    expect(classify(`SELECT 'unterminated DROP TABLE t`).danger).toBe('safe');
  });
});

describe('rail 2 — the destructive ladder', () => {
  it('DROP TABLE and DROP SCHEMA ask for the name typed back', () => {
    expect(one('DROP TABLE public.posts').danger).toBe('type_name');
    expect(one('DROP SCHEMA analytics').danger).toBe('type_name');
  });

  it('the name is what the user wrote, not a normalised form', () => {
    // Asking someone to type a normalisation of what is on their own screen
    // turns a confirmation into a puzzle.
    expect(one('DROP TABLE public.posts').object).toBe('public.posts');
    expect(one('DROP TABLE posts').object).toBe('posts');
    expect(one('DROP TABLE IF EXISTS public.posts').object).toBe('public.posts');
    expect(one('DROP TABLE "Odd Name"').object).toBe('"Odd Name"');
  });

  it('other DROPs confirm but do not ask for typing', () => {
    // Blast radius is the distinction: an index or a policy is recoverable from
    // the schema, a table only from a backup.
    expect(one('DROP INDEX posts_title_idx').danger).toBe('confirm');
    expect(one('DROP POLICY p ON posts').danger).toBe('confirm');
  });

  it('TRUNCATE confirms', () => {
    const c = one('TRUNCATE posts');
    expect(c.danger).toBe('confirm');
    expect(c.reason).toMatch(/every row/);
  });

  it('DELETE and UPDATE are safe with a WHERE and dangerous without', () => {
    expect(one('DELETE FROM posts WHERE id = 1').danger).toBe('safe');
    expect(one('DELETE FROM posts').danger).toBe('confirm');
    expect(one('UPDATE posts SET title = 1 WHERE id = 1').danger).toBe('safe');
    expect(one('UPDATE posts SET title = 1').danger).toBe('confirm');
  });

  it('BYPASS: a WHERE belonging to a subquery does not protect the outer DELETE', () => {
    // This is the case that matters most. The statement deletes every row, and
    // it contains the word WHERE — so any depth-blind check calls it safe.
    const c = one('DELETE FROM posts USING (SELECT id FROM t WHERE x = 1) s');
    expect(c.danger).toBe('confirm');
    expect(c.reason).toMatch(/no WHERE clause/);
  });

  it('a real top-level WHERE is still recognised past a subquery', () => {
    expect(one('DELETE FROM posts WHERE id IN (SELECT id FROM t WHERE x = 1)').danger)
      .toBe('safe');
  });

  it('BYPASS: a WHERE inside a string does not protect anything', () => {
    expect(one(`DELETE FROM posts /* WHERE id = 1 */`).danger).toBe('confirm');
    expect(one(`UPDATE posts SET t = 'WHERE id = 1'`).danger).toBe('confirm');
  });

  it('a script is as dangerous as its worst statement, wherever it sits', () => {
    const s = classify('SELECT 1; DELETE FROM t; DROP TABLE public.posts; SELECT 2');
    expect(s.danger).toBe('type_name');
    expect(s.dangerous.map((d) => d.command)).toEqual(['DELETE', 'DROP']);
    expect(s.namesToType).toEqual(['public.posts']);
  });

  it('two drops need both names, because confirming one is not confirming the other', () => {
    expect(classify('DROP TABLE a; DROP TABLE b').namesToType).toEqual(['a', 'b']);
  });

  it('a DROP whose name cannot be read steps down instead of asking the impossible', () => {
    const c = one('DROP TABLE (weird');
    expect(c.object).toBeNull();
    expect(c.danger).toBe('confirm');
  });

  it('reads are safe, and so are ordinary writes with a predicate', () => {
    for (const sql of [
      'SELECT * FROM posts',
      'INSERT INTO posts (title) VALUES (1)',
      'CREATE TABLE t (id int)',
      'ALTER TABLE t ADD COLUMN c int',
      'CREATE INDEX ON posts (title)',
      'GRANT SELECT ON posts TO anon',
      'EXPLAIN SELECT * FROM posts',
    ]) expect(one(sql).danger, sql).toBe('safe');
  });
});

describe('rail 4 — the row-limit append', () => {
  it('a bare SELECT is limitable', () => {
    expect(classify('SELECT * FROM posts').limitable?.sql).toBe('SELECT * FROM posts');
  });

  it('refuses when a LIMIT, OFFSET or FETCH is already there', () => {
    // Appending a second LIMIT is a syntax error, so this is not a nicety.
    for (const sql of [
      'SELECT * FROM posts LIMIT 10',
      'SELECT * FROM posts OFFSET 5',
      'SELECT * FROM posts FETCH FIRST 5 ROWS ONLY',
    ]) expect(classify(sql).limitable, sql).toBeNull();
  });

  it('refuses set operations, where the trailing position is the wrong branch', () => {
    for (const sql of [
      'SELECT 1 UNION SELECT 2',
      'SELECT 1 INTERSECT SELECT 2',
      'SELECT 1 EXCEPT SELECT 2',
    ]) expect(classify(sql).limitable, sql).toBeNull();
  });

  it('refuses a CTE-wrapped query', () => {
    expect(classify('WITH x AS (SELECT 1) SELECT * FROM x').limitable).toBeNull();
  });

  it('refuses SELECT INTO, which is a write wearing a SELECT costume', () => {
    expect(classify('SELECT * INTO backup FROM posts').limitable).toBeNull();
  });

  it('refuses non-SELECTs — a LIMIT on an UPDATE is a syntax error', () => {
    for (const sql of ['UPDATE posts SET t = 1 WHERE id = 1', 'INSERT INTO t VALUES (1)'])
      expect(classify(sql).limitable, sql).toBeNull();
  });

  it('refuses a multi-statement script even when the last statement is bare', () => {
    // The results of such a run are not one table, and appending to one of
    // several statements is a rewrite the user cannot see the point of.
    expect(classify('SELECT 1; SELECT * FROM posts').limitable).toBeNull();
  });

  it('a LIMIT inside a subquery does not disqualify the outer query', () => {
    expect(classify('SELECT * FROM (SELECT 1 LIMIT 1) s').limitable).not.toBeNull();
  });

  it('withLimit drops a trailing semicolon, which would otherwise be a syntax error', () => {
    expect(withLimit('SELECT * FROM posts;', 501)).toBe('SELECT * FROM posts LIMIT 501');
    expect(withLimit('SELECT * FROM posts', 501)).toBe('SELECT * FROM posts LIMIT 501');
  });
});

describe('rail 5 — explicit transaction passthrough', () => {
  it('a script managing its own transaction is flagged so no wrapper is added', () => {
    expect(classify('BEGIN; SELECT 1; COMMIT;').ownsTransaction).toBe(true);
    expect(classify('SELECT 1').ownsTransaction).toBe(false);
  });

  it('BEGIN inside a string is not transaction control', () => {
    expect(classify(`SELECT 'BEGIN'`).ownsTransaction).toBe(false);
  });
});

describe('the shape of the answer', () => {
  it('sql is returned verbatim — D-132 reformats nothing', () => {
    const messy = 'SeLeCt   *\n  FROM   posts';
    expect(classify(messy).statements[0]!.sql).toBe(messy);
    expect(classify(messy).statements[0]!.command).toBe('SELECT');
  });

  it('an empty script has no statements and is safe', () => {
    for (const sql of ['', '   ', '-- just a comment', ';;;'])
      expect(classify(sql), JSON.stringify(sql)).toMatchObject({ statements: [], danger: 'safe' });
  });

  it('every dangerous statement carries a reason fit for a dialog', () => {
    for (const c of classify('DROP TABLE t; TRUNCATE u; DELETE FROM v').dangerous) {
      expect(c.reason.length, c.command).toBeGreaterThan(20);
      expect(c.reason, c.command).toMatch(/\.$/);
    }
  });

  it('lex drops comments entirely rather than emitting them as tokens', () => {
    expect(lex('SELECT 1 -- c').map((t) => t.value)).toEqual(['SELECT', '1']);
    expect(lex('/* c */ SELECT 1').map((t) => t.value)).toEqual(['SELECT', '1']);
  });
});
