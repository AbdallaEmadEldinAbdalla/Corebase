import { describe, it, expect } from 'vitest';
import { mergeRows } from './table-objects.ts';
import type { IntrospectionConstraint, IntrospectionIndex } from './api.ts';

/**
 * The merge is what decided this section's shape, so it is the part worth
 * pinning.
 *
 * Two separate tables — one for indexes, one for constraints — list the same
 * object twice, because every primary-key and unique constraint has a backing
 * index of the same name. Measured on a real project: `articles_pkey`,
 * `articles_notes_key`, `fk_target_pkey` and `no_key_pkey` were all in both
 * payload lists. This function is the reconciliation, and if it regresses the
 * section silently starts double-counting.
 */
const index = (over: Partial<IntrospectionIndex>): IntrospectionIndex => ({
  schema: 'public', table: 'posts', name: 'i', columns: ['a'],
  is_unique: false, is_primary: false, is_valid: true,
  definition: 'CREATE INDEX i ON public.posts USING btree (a)', ...over,
});

const constraint = (over: Partial<IntrospectionConstraint>): IntrospectionConstraint => ({
  schema: 'public', table: 'posts', name: 'c', kind: 'check', columns: ['a'],
  references_schema: null, references_table: null,
  definition: 'CHECK (a > 0)', ...over,
});

describe('merging indexes and constraints', () => {
  it('BYPASS: an index backing a constraint is one row, not two', () => {
    // The whole reason this function exists. `posts_pkey` is in both payload
    // lists; a reader seeing it twice reasonably wonders whether there are two.
    const rows = mergeRows(
      [index({ name: 'posts_pkey', is_primary: true, is_unique: true })],
      [constraint({ name: 'posts_pkey', kind: 'primary_key' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('primary_key');
    // And the row says the index exists, rather than the index being absent.
    expect(rows[0]!.backedBy).toBe('posts_pkey');
  });

  it('matches by name, not by column set', () => {
    /**
     * Postgres guarantees a constraint and its index share a name, so name is
     * the reliable key. Matching on columns instead would merge a hand-made
     * index that happens to cover the same columns — which is a real thing to
     * have (a partial index, a different operator class) and a real thing to
     * want to see listed separately.
     */
    const rows = mergeRows(
      [index({ name: 'idx_posts_a_manual', columns: ['a'] })],
      [constraint({ name: 'posts_a_key', kind: 'unique', columns: ['a'] })]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind)).toEqual(['unique', 'index']);
  });

  it('keeps an index that backs nothing', () => {
    const rows = mergeRows([index({ name: 'idx_posts_status' })], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('index');
    expect(rows[0]!.backedBy).toBeNull();
  });

  it('keeps a constraint with no index of its own', () => {
    // A CHECK has none, and must not be dropped from the list for lack of one.
    const rows = mergeRows([], [constraint({ name: 'posts_check' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('check');
    expect(rows[0]!.backedBy).toBeNull();
  });

  it('puts constraints before indexes, then sorts by name', () => {
    // Constraints are rules; an index is a performance decision. Sorting inside
    // each group keeps the order stable as things are added, so a row does not
    // move under the cursor after a change.
    const rows = mergeRows(
      [index({ name: 'idx_b' }), index({ name: 'idx_a' })],
      [constraint({ name: 'zz_check' }), constraint({ name: 'aa_check' })]);
    expect(rows.map((r) => r.name)).toEqual(['aa_check', 'zz_check', 'idx_a', 'idx_b']);
  });

  it('carries a foreign key\'s target through', () => {
    const rows = mergeRows([], [constraint({
      name: 'posts_author_fkey', kind: 'foreign_key',
      references_schema: 'public', references_table: 'users' })]);
    expect(rows[0]!.references).toBe('public.users');
  });

  it('BYPASS: reports an invalid index as invalid, even when it backs a constraint', () => {
    /**
     * A unique constraint's index can be invalid — a failed `ALTER TABLE … ADD
     * CONSTRAINT … USING INDEX` or a concurrent build that died leaves one. The
     * row is the *constraint*, so the invalid flag has to be read off the index
     * it was merged with, or the one case where this matters is the one case it
     * misses.
     */
    const rows = mergeRows(
      [index({ name: 'posts_a_key', is_valid: false, is_unique: true })],
      [constraint({ name: 'posts_a_key', kind: 'unique' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invalid).toBe(true);
  });

  it('an index with no matching constraint reports its own validity', () => {
    expect(mergeRows([index({ is_valid: false })], [])[0]!.invalid).toBe(true);
    expect(mergeRows([index({ is_valid: true })], [])[0]!.invalid).toBe(false);
  });

  it('is empty for a table with neither', () => {
    expect(mergeRows([], [])).toEqual([]);
  });
});
