import { describe, it, expect } from 'vitest';
import { highlight, type Span } from './sql-highlight.ts';

/**
 * The one property that matters more than any colour: **nothing is lost.**
 *
 * This pane exists so the user can read the statement that will run. A
 * highlighter that can drop or reorder a character can show them a different
 * statement, which is worse than no highlighting at all — so the round-trip is
 * asserted on every input in this file rather than in one test.
 */
const text = (spans: Span[]) => spans.map((s) => s.text).join('');
const classOf = (spans: Span[], needle: string) =>
  spans.find((s) => s.text.includes(needle))?.cls;

/** Every SQL this file mentions, round-tripped. */
const CORPUS = [
  'select 1',
  'alter table "public"."posts" drop column "legacy_flag";',
  "insert into t values ('it''s', E'a\\'b', 1.5e-3);",
  '-- a comment\nselect 1',
  '/* nested /* deeper */ still */ select 1',
  '$$ any ; text -- here $$',
  '$tag$ body $tag$',
  "select * from t where c = 'unterminated",
  'select "un-terminated',
  '/* unterminated',
  '',
  '   ',
  'SELECT\n  a,\n  b\nFROM t\nWHERE a > 1;',
];

describe('the round trip', () => {
  it('BYPASS: joining the spans returns the input, exactly', () => {
    for (const sql of CORPUS) {
      expect(text(highlight(sql)), JSON.stringify(sql)).toBe(sql);
    }
  });

  it('holds for a statement with every construct at once', () => {
    const sql = `-- create it
create table "public"."odd ""name" (
  id uuid primary key default gen_random_uuid(),  /* nested /* c */ */
  body text not null default E'a\\'b',
  n numeric(10,2) default 1.5e-3
);
alter table "public"."odd ""name" enable row level security;`;
    expect(text(highlight(sql))).toBe(sql);
  });
});

describe('what gets a colour', () => {
  it('colours the keywords that give a statement its shape', () => {
    const spans = highlight('alter table "public"."posts" drop column "x"');
    expect(classOf(spans, 'alter')).toBe('key');
    expect(classOf(spans, 'table')).toBe('key');
    expect(classOf(spans, 'drop')).toBe('key');
  });

  it('is case-insensitive about keywords, because both cases are written', () => {
    expect(classOf(highlight('SELECT 1'), 'SELECT')).toBe('key');
    expect(classOf(highlight('select 1'), 'select')).toBe('key');
  });

  it('leaves a quoted identifier PLAIN, not string-coloured', () => {
    /**
     * The decision worth pinning. A quoted identifier names a column; it is not
     * a value, and colouring it as a literal says the opposite of what it means.
     * The generator quotes *every* identifier it emits, so getting this wrong
     * would paint nearly every table and column name on screen in the colour
     * reserved for literals.
     */
    expect(classOf(highlight('select "col" from "t"'), '"col"')).toBe('plain');
  });

  it('does not colour type names as keywords', () => {
    // `text` and `timestamptz` read as values in a CREATE TABLE; colouring them
    // makes a column list look like a clause list.
    const spans = highlight('create table t (a text, b timestamptz)');
    expect(classOf(spans, 'text')).toBe('plain');
    expect(classOf(spans, 'timestamptz')).toBe('plain');
  });

  it('does not colour a keyword that is part of a longer identifier', () => {
    // `selection` is not `select`, and `updated_at` is not `update`.
    expect(classOf(highlight('select selection from t'), 'selection')).toBe('plain');
    expect(classOf(highlight('select updated_at from t'), 'updated_at')).toBe('plain');
  });
});

describe('the constructs that hide SQL inside them', () => {
  it('a keyword inside a string is not a keyword', () => {
    const spans = highlight("select 'drop table users'");
    expect(classOf(spans, 'drop table users')).toBe('str');
    // And there is no separate `drop` span at all.
    expect(spans.filter((s) => s.cls === 'key').map((s) => s.text)).toEqual(['select']);
  });

  it("a doubled quote does not end the literal", () => {
    const spans = highlight("select 'it''s' , 1");
    expect(classOf(spans, "it''s")).toBe('str');
    // The comma after it is outside the literal, which is how we know the scan
    // ended in the right place.
    expect(text(spans)).toContain("' , 1");
  });

  it("E'...' treats a backslash as an escape, so E'\\'' is one literal", () => {
    // Conflating the two quote forms ends this literal one character early and
    // paints the rest of the statement as a string.
    const spans = highlight("select E'a\\'b' , 1");
    expect(classOf(spans, "a\\'b")).toBe('str');
    expect(spans.filter((s) => s.cls === 'str')).toHaveLength(1);
  });

  it('a dollar-quoted body is one span, semicolons and comments included', () => {
    const spans = highlight("$$ select 1; -- not a comment $$");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.cls).toBe('str');
  });

  it('a tagged dollar quote only ends on its own tag', () => {
    const sql = '$fn$ begin return $$inner$$; end $fn$';
    const spans = highlight(sql);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe(sql);
  });

  it('BYPASS: block comments NEST, which C-style scanning gets wrong', () => {
    // `/* a /* b */ still a comment */` — a scanner looking for the first `*/`
    // ends the comment at the inner one and colours `still` as SQL. Postgres
    // nests, so the whole thing is one comment.
    const spans = highlight('/* a /* b */ still */ select 1');
    expect(spans[0]!.cls).toBe('com');
    expect(spans[0]!.text).toBe('/* a /* b */ still */');
    expect(classOf(spans, 'select')).toBe('key');
  });

  it('a line comment stops at the newline, and the next line is live SQL', () => {
    const spans = highlight('-- drop table users\nselect 1');
    expect(spans[0]!.cls).toBe('com');
    expect(spans[0]!.text).toBe('-- drop table users');
    expect(classOf(spans, 'select')).toBe('key');
  });
});

describe('numbers', () => {
  it('reads an exponent as part of the literal', () => {
    expect(classOf(highlight('select 1.5e-3'), '1.5e-3')).toBe('num');
  });

  it('BYPASS: does not swallow a subtraction into the number', () => {
    // `1-5` is two numbers and an operator. Treating `-` as always continuing a
    // literal makes `a > 1-5` one token and loses the operator's colour.
    const spans = highlight('select 1-5');
    expect(spans.filter((s) => s.cls === 'num').map((s) => s.text)).toEqual(['1', '5']);
  });
});

describe('mid-typing input, which is most of the time', () => {
  it('never throws on an unterminated construct', () => {
    for (const sql of ["select 'a", 'select "a', '/* a', '$$ a', "select E'a"]) {
      expect(() => highlight(sql), sql).not.toThrow();
      expect(text(highlight(sql))).toBe(sql);
    }
  });

  it('returns nothing for empty input rather than an empty span', () => {
    // An empty span would render an empty element, which shows up as a stray
    // line height in the pane.
    expect(highlight('')).toEqual([]);
  });
});

describe('the output shape', () => {
  it('merges runs of one class, so the caller renders one node per colour', () => {
    const spans = highlight('select a, b, c from t');
    // No two adjacent spans share a class — the merge is what keeps a 40-line
    // statement from becoming 400 React nodes.
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.cls, spans[i]!.text).not.toBe(spans[i - 1]!.cls);
    }
  });

  it('emits no empty spans', () => {
    for (const sql of CORPUS) {
      for (const s of highlight(sql)) expect(s.text.length).toBeGreaterThan(0);
    }
  });
});
