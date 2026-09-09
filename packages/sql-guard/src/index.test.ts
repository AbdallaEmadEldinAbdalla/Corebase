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

/**
 * The `ALTER TABLE` ladder (D-468).
 *
 * These exist because the first version of `danger()` switched on the leading
 * keyword and let every `ALTER` fall through to `default: → safe`. `ALTER TABLE
 * users DROP COLUMN email` therefore ran from the SQL console with no
 * confirmation of any kind — as destructive as `DROP TABLE`, and silent.
 *
 * It was found by running the classifier over the table editor's operation
 * catalog and reading the output, not by reading the code. That is the lesson
 * worth keeping: `ALTER` reaching `default:` is invisible in the source and
 * obvious in a table of results.
 */
describe('ALTER TABLE, whose DROP actions are not all equal', () => {
  it('BYPASS: dropping a column asks for the column name, not the table', () => {
    const s = classify('alter table public.posts drop column legacy_flag');
    expect(s.danger).toBe('type_name');
    // The column. Typing the table name would confirm a statement the user may
    // have misread — the table is the one thing they already know they are on.
    expect(s.namesToType).toEqual(['legacy_flag']);
    expect(s.dangerous[0]!.reason).toContain('deletes the data in it');
  });

  it('`COLUMN` is optional in Postgres, so a bare name is still a column', () => {
    expect(classify('alter table t drop legacy_flag').namesToType).toEqual(['legacy_flag']);
  });

  it('skips IF EXISTS to find the name', () => {
    expect(classify('alter table t drop column if exists c').namesToType).toEqual(['c']);
  });

  it('every dropped column is asked for, not just the first', () => {
    // One statement, two columns. Asking for one and dropping two is the hole
    // the comma list opens, and it is the same hole `DROP TABLE a, b` had.
    expect(classify('alter table t drop column a, drop column b').namesToType)
      .toEqual(['a', 'b']);
  });

  it('dropping a constraint is a confirmation, not a typed name', () => {
    const s = classify('alter table public.posts drop constraint posts_author_fkey');
    expect(s.danger).toBe('confirm');
    expect(s.namesToType).toEqual([]);
    // The consequence, which is not "it is gone" — it is that writes which used
    // to be rejected now succeed.
    expect(s.dangerous[0]!.reason).toContain('can be written from now on');
  });

  it('names the constraint too when one statement drops both', () => {
    // The first version returned early on the column and never mentioned the
    // constraint: a warning the user reads, believes complete, and confirms.
    const reason = classify('alter table t drop constraint ck, drop column a')
      .dangerous[0]!.reason;
    expect(reason).toContain('"a"');
    expect(reason).toContain('"ck"');
  });

  describe('the actions that contain the word DROP and destroy nothing', () => {
    // A guard that searched the statement text for `DROP` would demand a typed
    // name for each of these — reversible one-line changes — and that is exactly
    // how people learn to type through confirmations.
    for (const sql of [
      'alter table t alter column c drop default',
      'alter table t alter column c drop not null',
      'alter table t alter column c drop identity',
      'alter table t alter column c drop expression',
    ]) {
      it(`stays safe: ${sql}`, () => {
        expect(classify(sql).danger).toBe('safe');
      });
    }
  });

  describe('the ordinary operations, which must not gain a rung', () => {
    for (const sql of [
      "alter table public.posts add column status text not null default 'draft'",
      'alter table public.posts alter column price type numeric(10,2) using price::numeric(10,2)',
      'alter table public.posts rename to articles',
      'alter table public.posts rename column status to state',
      'alter table public.posts enable row level security',
      'alter table t add constraint u unique (a, b)',
      'alter table t add constraint ck check (n > 0)',
    ]) {
      it(`stays safe: ${sql.slice(0, 52)}…`, () => {
        expect(classify(sql).danger).toBe('safe');
      });
    }
  });

  it('a comma inside a column list does not start a new action', () => {
    // `UNIQUE (a, b)` is one action. Splitting on that comma would read `b)` as
    // a second action and could mis-lead it.
    expect(classify('alter table t add constraint u unique (a, b)').danger).toBe('safe');
  });

  it('an unreadable DROP action fails to `confirm`, never to `safe`', () => {
    // An action this file cannot parse is an action it cannot vouch for.
    const s = classify('alter table t drop column (');
    expect(s.danger).toBe('confirm');
  });
});

describe('a comma list of objects', () => {
  it('BYPASS: DROP TABLE a, b asks for both', () => {
    // It asked for `a` alone, so typing one table name confirmed dropping two —
    // while `namesToType`'s own comment claimed "confirming one of them is not
    // confirming the other". The comment was true across statements and false
    // inside one, and a comma list is one statement.
    expect(classify('drop table a, b').namesToType).toEqual(['a', 'b']);
    expect(classify('drop table public.posts, public.comments').namesToType)
      .toEqual(['public.posts', 'public.comments']);
  });

  it('CASCADE is not an object name', () => {
    expect(classify('drop table public.posts cascade').namesToType).toEqual(['public.posts']);
    expect(classify('drop table a, b restrict').namesToType).toEqual(['a', 'b']);
  });

  it('a quoted name keeps its quotes, because that is what is on the screen', () => {
    expect(classify('alter table t drop column "odd name"').namesToType)
      .toEqual(['"odd name"']);
  });

  it('de-duplicates across statements so one name is asked for once', () => {
    expect(classify('drop table a; drop table a').namesToType).toEqual(['a']);
  });
});
