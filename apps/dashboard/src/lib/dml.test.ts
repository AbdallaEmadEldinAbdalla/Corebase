import { describe, it, expect } from 'vitest';
import { classify } from '@steadhold/sql-guard';
import { Incomplete } from './ddl.ts';
import { deleteRows, insertRow, updateRow, type CellValue } from './dml.ts';

/**
 * These statements run against a customer's live rows, so the properties worth
 * pinning are not about formatting. They are:
 *
 * - **no value is ever in the statement text** — every one is a bound parameter;
 * - **every UPDATE and DELETE is guarded by a primary key**, so it cannot reach
 *   a row the user did not see (D-133);
 * - **`null`, an empty string and "use the default" stay three different
 *   things**, because they are three different outcomes and a form that
 *   collapses them silently writes the wrong one.
 */
const target = { schema: 'public', table: 'posts' };
const val = (text: string): CellValue => ({ kind: 'value', text });
const NULL: CellValue = { kind: 'null' };
const DEFAULT: CellValue = { kind: 'default' };

describe('updating one row', () => {
  const row = { id: 'abc', title: 'old', n: 1 };

  it('sets every changed column in one statement, guarded by the key', () => {
    const p = updateRow(target, {
      row, primaryKey: ['id'],
      changes: [{ column: 'title', value: val('new') }, { column: 'n', value: val('2') }],
    });
    expect(p.sql).toContain('update "public"."posts"');
    expect(p.sql).toContain('"title" = $1');
    expect(p.sql).toContain('"n" = $2');
    expect(p.sql).toContain('where "id" = $3');
    expect(p.params).toEqual(['new', '2', 'abc']);
  });

  it('BYPASS: puts no value in the statement text, only placeholders', () => {
    // The whole difference between DML and DDL here. A DDL default is an
    // expression the user authored and has to appear verbatim; a row's value is
    // data, and data in a statement is how injection happens.
    const nasty = "'; drop table users; --";
    const p = updateRow(target, {
      row, primaryKey: ['id'], changes: [{ column: 'title', value: val(nasty) }] });
    expect(p.sql).not.toContain('drop table');
    expect(p.params).toContain(nasty);
    // And the real classifier sees one harmless UPDATE with a predicate.
    const s = classify(p.sql);
    expect(s.statements).toHaveLength(1);
    expect(s.statements[0]!.command).toBe('UPDATE');
    expect(s.danger).toBe('safe');
  });

  it('BYPASS: refuses without a primary key rather than matching on values', () => {
    /**
     * The fallback that must not exist. Matching on the values it happens to
     * know — `where title = 'old'` — hits *every* duplicate row, and the user
     * would see one row highlighted and several rewritten. D-133 calls
     * PK-guarded DML "the only UPDATE/DELETE shape that cannot silently hit more
     * rows than the user sees", and this is what makes that true rather than
     * aspirational.
     */
    expect(() => updateRow(target, {
      row, primaryKey: [], changes: [{ column: 'title', value: val('new') }] }))
      .toThrow(/no primary key/);
  });

  it('uses a row-value comparison for a composite key', () => {
    // One expression rather than two conditions, so it cannot be mistaken for
    // something whose halves can be edited apart.
    const p = updateRow(target, {
      row: { tenant: 't1', id: 'abc' }, primaryKey: ['tenant', 'id'],
      changes: [{ column: 'title', value: val('new') }] });
    expect(p.sql).toContain('where ("tenant", "id") = ($2, $3)');
    expect(p.params).toEqual(['new', 't1', 'abc']);
  });

  it('refuses a row whose key value is missing', () => {
    // `= NULL` matches nothing, so this would report zero rows changed and read
    // as though the row had vanished.
    expect(() => updateRow(target, {
      row: { id: null }, primaryKey: ['id'],
      changes: [{ column: 'title', value: val('x') }] })).toThrow(Incomplete);
  });

  it('binds null as null, and an empty string as an empty string', () => {
    // Three values that a text field renders identically and the database does
    // not. Collapsing them is how a nullable column silently stops being one.
    expect(updateRow(target, {
      row, primaryKey: ['id'], changes: [{ column: 'title', value: NULL }] }).params[0])
      .toBeNull();
    expect(updateRow(target, {
      row, primaryKey: ['id'], changes: [{ column: 'title', value: val('') }] }).params[0])
      .toBe('');
  });

  it('refuses when nothing changed', () => {
    expect(() => updateRow(target, { row, primaryKey: ['id'], changes: [] }))
      .toThrow(Incomplete);
  });

  it('lists what each placeholder holds, including the key', () => {
    // The preview shows placeholders, so without this the user cannot see what
    // they are about to write.
    const p = updateRow(target, {
      row, primaryKey: ['id'], changes: [{ column: 'title', value: NULL }] });
    expect(p.bindings).toEqual([
      { placeholder: '$1', column: 'title', value: 'null' },
      { placeholder: '$2', column: 'id', value: 'abc' },
    ]);
  });

  it('names an empty string in the bindings rather than showing a gap', () => {
    const p = updateRow(target, {
      row, primaryKey: ['id'], changes: [{ column: 'title', value: val('') }] });
    expect(p.bindings[0]!.value).toBe('(empty string)');
  });

  it('says the update cannot reach another row, and that there is no undo', () => {
    const text = updateRow(target, {
      row, primaryKey: ['id'], changes: [{ column: 'title', value: val('x') }] })
      .notices.map((n) => n.text).join(' ');
    expect(text).toContain('cannot touch another');
    expect(text).toContain('no undo');
  });

  it('is never offered as a migration', () => {
    // "Row edits are DML, not schema: they are never offered as migrations."
    // The absence of a filename is the mechanism — the dialog offers the
    // download when a plan has one, so there is nothing for a caller to forget.
    const p = updateRow(target, {
      row, primaryKey: ['id'], changes: [{ column: 'title', value: val('x') }] });
    expect(p).not.toHaveProperty('filename');
  });
});

describe('inserting a row', () => {
  it('names its columns and binds its values', () => {
    const p = insertRow(target, [
      { column: 'title', value: val('hello') },
      { column: 'n', value: val('3') },
    ]);
    expect(p.sql).toContain('("title", "n")');
    expect(p.sql).toContain('values ($1, $2)');
    expect(p.params).toEqual(['hello', '3']);
  });

  it('BYPASS: omits a defaulted column entirely rather than sending null', () => {
    /**
     * The difference between "let the default apply" and "store null", which is
     * the difference between a working insert and a not-null violation. Every
     * Steadhold table has `id uuid default gen_random_uuid()` and `created_at
     * timestamptz not null default now()`, so this is the common path: sending
     * null for `created_at` fails outright, and omitting it gets `now()`.
     */
    const p = insertRow(target, [
      { column: 'id', value: DEFAULT },
      { column: 'created_at', value: DEFAULT },
      { column: 'title', value: val('hello') },
    ]);
    expect(p.sql).toContain('("title")');
    expect(p.sql).not.toContain('"id"');
    expect(p.sql).not.toContain('"created_at"');
    expect(p.params).toEqual(['hello']);
  });

  it('still distinguishes an explicit null from a default', () => {
    const p = insertRow(target, [
      { column: 'title', value: val('t') },
      { column: 'notes', value: NULL },
    ]);
    expect(p.sql).toContain('("title", "notes")');
    expect(p.params).toEqual(['t', null]);
  });

  it('returns the inserted row, because a defaulted id is only knowable after', () => {
    expect(insertRow(target, [{ column: 'title', value: val('t') }]).sql)
      .toContain('returning *');
  });

  it('says how many columns are being left to their defaults', () => {
    const text = insertRow(target, [
      { column: 'id', value: DEFAULT },
      { column: 'title', value: val('t') },
    ]).notices.map((n) => n.text).join(' ');
    expect(text).toContain('1 column(s) are left out');
    expect(text).toContain('different from setting');
  });

  it('refuses an all-defaults insert rather than silently making a blank row', () => {
    // Legal SQL and almost certainly a mistake.
    expect(() => insertRow(target, [{ column: 'id', value: DEFAULT }]))
      .toThrow(Incomplete);
  });

  it('says the policies do not apply to the owner, which is why this works', () => {
    // The insert that would otherwise be baffling: it succeeds here and a
    // client using the API is checked against the INSERT policies.
    const text = insertRow(target, [{ column: 'title', value: val('t') }])
      .notices.map((n) => n.text).join(' ');
    expect(text).toContain('inserting as the table');
    expect(text).toContain('checked against');
  });
});

describe('deleting rows', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('names every selected row by its key, and nothing else', () => {
    const p = deleteRows(target, { rows, primaryKey: ['id'] });
    expect(p.sql).toContain('delete from "public"."posts"');
    expect(p.sql).toContain('where "id" in ($1, $2, $3)');
    expect(p.params).toEqual(['a', 'b', 'c']);
  });

  it('uses row values for a composite key', () => {
    const p = deleteRows(target, {
      rows: [{ tenant: 't', id: 'a' }, { tenant: 't', id: 'b' }],
      primaryKey: ['tenant', 'id'] });
    expect(p.sql).toContain('where ("tenant", "id") in (($1, $2), ($3, $4))');
    expect(p.params).toEqual(['t', 'a', 't', 'b']);
  });

  it('BYPASS: refuses without a primary key', () => {
    expect(() => deleteRows(target, { rows, primaryKey: [] }))
      .toThrow(/no primary key/);
  });

  it('refuses an empty selection rather than deleting everything', () => {
    // The catastrophic version of this bug is a `DELETE` with no `WHERE`, which
    // an empty `IN ()` list would not even be — it would be a syntax error. The
    // refusal is what makes it neither.
    expect(() => deleteRows(target, { rows: [], primaryKey: ['id'] }))
      .toThrow(Incomplete);
  });

  it('states the count, and that a backup is the only way back', () => {
    const text = deleteRows(target, { rows, primaryKey: ['id'] })
      .notices.map((n) => n.text).join(' ');
    expect(text).toContain('3 rows');
    expect(text).toContain('backup restore');
  });

  it('reads as one safe qualified DELETE to the classifier', () => {
    // Which is right: the guard fires on a `DELETE` with **no** predicate, and
    // gating every qualified one would fire on the normal case and teach people
    // to click through it. The dialog is the confirmation here.
    const s = classify(deleteRows(target, { rows, primaryKey: ['id'] }).sql);
    expect(s.statements).toHaveLength(1);
    expect(s.danger).toBe('safe');
  });
});

describe('every row plan', () => {
  const all = [
    updateRow(target, {
      row: { id: 'a' }, primaryKey: ['id'],
      changes: [{ column: 'title', value: val('x') }] }),
    insertRow(target, [{ column: 'title', value: val('x') }]),
    deleteRows(target, { rows: [{ id: 'a' }], primaryKey: ['id'] }),
  ];

  it('is exactly one statement, because bound params require it', () => {
    // The server refuses params against a multi-statement script: `client.query`
    // takes one `values` array and would hand the same one to every statement,
    // misbinding silently rather than failing.
    for (const p of all) expect(classify(p.sql).statements, p.sql).toHaveLength(1);
  });

  it('has a placeholder for every param and a param for every placeholder', () => {
    for (const p of all) {
      const holes = new Set(p.sql.match(/\$\d+/g) ?? []);
      expect(holes.size, p.sql).toBe(p.params.length);
      // And they are $1..$n with no gaps, or Postgres rejects the statement.
      for (let i = 1; i <= p.params.length; i++) {
        expect(holes.has(`$${i}`), `${p.sql} missing $${i}`).toBe(true);
      }
    }
  });

  it('describes every placeholder in its bindings', () => {
    for (const p of all) {
      expect(p.bindings.map((b) => b.placeholder).sort())
        .toEqual([...new Set(p.sql.match(/\$\d+/g) ?? [])].sort());
    }
  });

  it('quotes every identifier it interpolates', () => {
    for (const p of all) {
      expect(p.sql.replace(/"[^"]*"/g, ''), p.sql).not.toMatch(/\bposts\b/);
    }
  });

  it('carries no migration filename', () => {
    for (const p of all) expect(p).not.toHaveProperty('filename');
  });
});
