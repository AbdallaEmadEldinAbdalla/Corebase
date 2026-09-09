import { describe, it, expect } from 'vitest';
import { quote, qualified, pageSql, countSql } from './grid-sql.ts';

/**
 * The grid's SQL is shown to the user and run against their production database,
 * so both halves of that matter: it has to be *safe* and it has to be *readable*.
 *
 * The safety half is quoting. Values never reach a statement as text — they are
 * bound — but identifiers cannot be bound in any database, so the only defence is
 * quoting plus an allowlist at the call site. These tests pin the quoting; the
 * allowlist is the page's job and is asserted where it lives.
 */

describe('quoting identifiers', () => {
  it('quotes plainly', () => {
    expect(quote('posts')).toBe('"posts"');
    expect(qualified('public', 'posts')).toBe('"public"."posts"');
  });

  it('doubles an embedded quote, which is the whole escape', () => {
    expect(quote('od"d')).toBe('"od""d"');
  });

  it('BYPASS: a name carrying SQL comes out as one identifier, not as SQL', () => {
    // The attack this stops: an unquoted `${name}` here would end the statement
    // and start another. Quoted, the entire string is one (absurd) column name,
    // and the database rejects it as not existing.
    const nasty = 'x"; drop table users; --';
    expect(quote(nasty)).toBe('"x""; drop table users; --"');
    // No unescaped quote survives, so the identifier cannot be closed early.
    expect(quote(nasty).slice(1, -1)).not.toMatch(/(^|[^"])"([^"]|$)/);
  });

  it('a name that is entirely quotes is still balanced', () => {
    expect(quote('""')).toBe('""""""');
  });
});

const base = {
  schema: 'public', table: 'posts',
  columns: ['id', 'title'] as const,
  page: 0, pageSize: 100, primaryKey: ['id'] as const,
};

describe('a page of rows', () => {
  it('names its columns and its table', () => {
    const { sql } = pageSql({ ...base });
    expect(sql).toContain('select "id", "title"');
    expect(sql).toContain('from "public"."posts"');
  });

  it('always carries an explicit LIMIT and OFFSET', () => {
    // Which is also why the server's `LIMIT 501` never fires here: the
    // classifier skips a statement that already has one, so the grid has one
    // truncation to explain rather than two.
    expect(pageSql({ ...base, page: 3 }).sql).toContain('limit 100 offset 300');
  });

  it('orders by the primary key when the user has not chosen a sort', () => {
    // Not cosmetic. Without ORDER BY, Postgres may return rows in any order, so
    // paging can show one row twice and skip another — and it would look like
    // the grid losing data.
    expect(pageSql({ ...base }).sql).toContain('order by "id"');
  });

  it('orders by every primary-key column, for a composite key', () => {
    expect(pageSql({ ...base, primaryKey: ['tenant', 'id'] }).sql)
      .toContain('order by "tenant", "id"');
  });

  it('omits ORDER BY when there is no key and no sort, rather than inventing one', () => {
    // There is nothing stable to promise, and the page says so instead of this
    // module guessing a column.
    expect(pageSql({ ...base, primaryKey: [] }).sql).not.toContain('order by');
  });

  it("the user's sort wins over the key, and its column is quoted", () => {
    const { sql } = pageSql({ ...base, sort: { column: 'title', direction: 'desc' } });
    expect(sql).toContain('order by "title" desc');
    expect(sql).not.toContain('order by "id"');
  });

  it('a direction that is not desc is asc — never interpolated', () => {
    const { sql } = pageSql({
      ...base, sort: { column: 'title', direction: 'DESC; drop table x' as never } });
    expect(sql).toContain('order by "title" asc');
    expect(sql).not.toMatch(/drop table/i);
  });

  it('binds no values, because a page has none', () => {
    expect(pageSql({ ...base }).params).toEqual([]);
  });

  it('falls back to * when the role can read no columns, rather than selecting nothing', () => {
    expect(pageSql({ ...base, columns: [] }).sql).toContain('select *');
  });
});

describe('the exact count', () => {
  it('is a plain count on the qualified table', () => {
    expect(countSql('public', 'posts')).toBe(
      'select count(*) as exact from "public"."posts"');
  });
});
