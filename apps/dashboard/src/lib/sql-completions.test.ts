import { describe, it, expect } from 'vitest';
import { completionSchema, defaultSchemaOf, rlsHint } from './sql-completions.ts';
import type { Introspection } from './api.ts';

const intro = (over: Partial<Introspection> = {}): Introspection => ({
  schemas: ['public', 'auth'],
  tables: [
    { schema: 'public', name: 'posts', kind: 'table', owner: 'developer',
      rls_enabled: true, rows_estimate: 10, comment: null,
      anon_can_select: false, anon_can_write: false },
    { schema: 'auth', name: 'users', kind: 'table', owner: 'steadhold_auth',
      rls_enabled: true, rows_estimate: 3, comment: null,
      anon_can_select: false, anon_can_write: false },
  ],
  columns: [
    { schema: 'public', table: 'posts', name: 'title', type: 'text', nullable: false,
      default: null, position: 3, is_primary_key: false, is_identity: false, comment: null },
    { schema: 'public', table: 'posts', name: 'id', type: 'uuid', nullable: false,
      default: null, position: 1, is_primary_key: true, is_identity: false, comment: null },
    { schema: 'auth', table: 'users', name: 'email', type: 'text', nullable: false,
      default: null, position: 2, is_primary_key: false, is_identity: false, comment: null },
  ],
  functions: [
    { schema: 'auth', name: 'uid', arguments: '', returns: 'uuid', kind: 'function' },
    { schema: 'public', name: 'slugify', arguments: 'txt text', returns: 'text', kind: 'function' },
  ],
  policies: [], indexes: [], constraints: [],
  roles: ['anon', 'authenticated'],
  truncated: {},
  ...over,
});

describe('the completion tree', () => {
  it('nests tables under their schema', () => {
    const { schema } = completionSchema(intro());
    expect((schema['public'] as Record<string, unknown>)['posts']).toEqual(['id', 'title']);
    expect((schema['auth'] as Record<string, unknown>)['users']).toEqual(['email']);
  });

  it('BYPASS: also offers default-schema tables unqualified', () => {
    // A developer writes both `posts` and `public.posts` — the first because
    // `search_path` makes it work. Offering only the qualified form means
    // completion stops the moment someone types the name they actually use.
    const { schema } = completionSchema(intro());
    expect(schema['posts']).toEqual(['id', 'title']);
    // And *not* for other schemas, which is how the database resolves them too.
    expect(schema['users']).toBeUndefined();
  });

  it('BYPASS: orders columns by table position, not alphabetically', () => {
    /**
     * The order a developer wrote their columns in carries meaning — the key
     * first, then what matters. Alphabetising puts `archived_at` above `id`.
     * `title` is position 3 and `id` is position 1, and they are deliberately
     * given to the builder in the wrong order.
     */
    const { schema } = completionSchema(intro());
    expect((schema['public'] as Record<string, unknown>)['posts']).toEqual(['id', 'title']);
  });

  it('BYPASS: knows a schema whose tables it cannot see', () => {
    /**
     * The `auth` schema on every project: `developer` holds USAGE there so its
     * policies can call `auth.uid()` (D-189) and no table privileges at all
     * (D-315), so it appears in `schemas` and none of its tables appear in
     * `tables`. Seeding buckets from the *tables* alone left `auth` out
     * entirely — a namespace the editor had never heard of. Found by a test
     * written for a different rule.
     */
    const { schema } = completionSchema(intro({
      schemas: ['public', 'auth', 'empty'], tables: [], columns: [] }));
    expect(Object.keys(schema).sort()).toEqual(['auth', 'empty', 'public']);
  });

  it('BYPASS: does not let a table shadow a schema of the same name', () => {
    /**
     * A table called `storage` in `public` would take the top-level `storage`
     * key and the real `storage` schema's tables would stop completing
     * entirely. The qualified form still works, which is the right thing to
     * lose in a collision this rare.
     */
    const { schema } = completionSchema(intro({
      schemas: ['public', 'storage'],
      tables: [{ schema: 'public', name: 'storage', kind: 'table', owner: 'developer',
        rls_enabled: true, rows_estimate: 0, comment: null,
        anon_can_select: false, anon_can_write: false }],
      columns: [],
    }));
    // The schema keeps the key, holding its own (empty) table set.
    expect(schema['storage']).toEqual({});
    expect((schema['public'] as Record<string, unknown>)['storage']).toEqual([]);
  });

  it('offers functions with their signature, qualified outside the default schema', () => {
    const { extra } = completionSchema(intro());
    const uid = extra.find((e) => e.label.startsWith('auth.uid'));
    // `auth.uid()` and not `uid()`: the unqualified form fails with a
    // function-does-not-exist error that reads as the helper being missing, and
    // it is the one the RLS cookbook is written around.
    expect(uid).toBeDefined();
    expect(uid!.detail).toBe(') → uuid');
    // A function in the default schema needs no prefix.
    expect(extra.some((e) => e.label === 'slugify(')).toBe(true);
  });

  it('offers the role names a policy needs after TO', () => {
    const { extra } = completionSchema(intro());
    expect(extra.filter((e) => e.detail === 'role').map((e) => e.label))
      .toEqual(['anon', 'authenticated']);
  });

  it('falls back to a schema that exists when public was dropped', () => {
    // Guessing `public` when it is absent costs *every* unqualified completion.
    expect(defaultSchemaOf({ schemas: ['app', 'auth'] })).toBe('app');
    expect(defaultSchemaOf({ schemas: [] })).toBe('public');
  });
});

describe('the RLS nudge', () => {
  it('says nothing as admin, which sees everything', () => {
    expect(rlsHint('admin', { rowCount: 0, sqlstate: null })).toBeNull();
  });

  it('BYPASS: distinguishes a missing grant from a non-matching policy', () => {
    /**
     * The two failures look the same and have different fixes. `42501` is
     * `insufficient_privilege`, which under a non-admin role means the *grant*
     * is missing — D-108 makes `anon` opt-in per table, so a correct policy plus
     * no grant is the common case and gets its own sentence. Zero rows with no
     * error is the policy not matching.
     */
    expect(rlsHint('anon', { rowCount: null, sqlstate: '42501' }))
      .toContain('holds no grant');
    expect(rlsHint('anon', { rowCount: 0, sqlstate: null }))
      .toContain('no policy matches');
  });

  it('says nothing when rows came back', () => {
    expect(rlsHint('anon', { rowCount: 5, sqlstate: null })).toBeNull();
  });

  it('says nothing about an unrelated error', () => {
    // A syntax error under `anon` is a syntax error, and nudging about policies
    // there would send someone to debug the wrong thing.
    expect(rlsHint('anon', { rowCount: null, sqlstate: '42601' })).toBeNull();
  });
});
