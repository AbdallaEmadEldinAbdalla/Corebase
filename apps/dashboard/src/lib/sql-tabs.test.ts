import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { describeTab, loadTabs, newTab, saveTabs, type SqlTab } from './sql-tabs.ts';

/**
 * There is no DOM in this test environment, so `window.localStorage` is stubbed.
 * That is not a workaround — it is the only way to exercise the branches that
 * matter, which are all about the store misbehaving: it throws outright in a
 * private window with site data blocked, returns null when cleared, and can hold
 * whatever a previous version of this code wrote or a user's devtools typed.
 */
let store: Map<string, string>;
let mode: 'ok' | 'throw-get' | 'throw-set' = 'ok';

beforeEach(() => {
  store = new Map();
  mode = 'ok';
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => {
        if (mode === 'throw-get') throw new Error('SecurityError');
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (mode === 'throw-set') throw new Error('QuotaExceededError');
        store.set(k, v);
      },
    },
  };
});
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

const tab = (over: Partial<SqlTab> = {}): SqlTab =>
  ({ id: 't1', name: 'Query 1', sql: '', readOnly: false, ...over });

describe('the tab store', () => {
  it('round-trips', () => {
    saveTabs('ref1', { tabs: [tab({ sql: 'select 1' })], activeId: 't1' });
    const back = loadTabs('ref1');
    expect(back.tabs[0]!.sql).toBe('select 1');
    expect(back.activeId).toBe('t1');
  });

  it('is keyed per project, so tabs do not cross databases', () => {
    // A tab full of `posts` queries is meaningless against another database.
    saveTabs('ref1', { tabs: [tab({ sql: 'select 1' })], activeId: 't1' });
    expect(loadTabs('ref2').tabs[0]!.sql).toBe('');
  });

  it('starts with one empty tab when there is nothing saved', () => {
    const s = loadTabs('fresh');
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0]!.id);
  });

  describe('BYPASS: every failure still returns a usable state', () => {
    /**
     * An editor that renders nothing because its tab store is malformed is an
     * editor that cannot be used to fix the problem. So anything unreadable is
     * replaced rather than reported.
     */
    it('when the store throws on read', () => {
      mode = 'throw-get';
      expect(loadTabs('x').tabs).toHaveLength(1);
    });

    it('when the value is not JSON', () => {
      store.set('steadhold:sql:x', 'not json{');
      expect(loadTabs('x').tabs).toHaveLength(1);
    });

    it('when the value is JSON but the wrong shape', () => {
      for (const bad of ['null', '42', '"a string"', '{}', '{"tabs":[]}', '{"tabs":"no"}']) {
        store.set('steadhold:sql:x', bad);
        expect(loadTabs('x').tabs, bad).toHaveLength(1);
      }
    });

    it('when one entry of many is malformed', () => {
      // The dangerous one: an older shape would render a tab whose buffer is
      // `undefined`, which CodeMirror rejects outright.
      store.set('steadhold:sql:x', JSON.stringify({
        tabs: [{ id: 'a', name: 'A', sql: 'select 1' }, { id: 'b' }, null],
        activeId: 'a',
      }));
      const s = loadTabs('x');
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0]!.id).toBe('a');
    });

    it('when activeId names a tab that is gone', () => {
      store.set('steadhold:sql:x', JSON.stringify({
        tabs: [{ id: 'a', name: 'A', sql: '' }], activeId: 'vanished',
      }));
      expect(loadTabs('x').activeId).toBe('a');
    });

    it('and a write that fails does not throw at the caller', () => {
      // A QuotaExceededError must not interrupt typing: the tab is still in
      // memory and still runnable, and reporting it would be a toast per
      // keystroke.
      mode = 'throw-set';
      expect(() => saveTabs('x', { tabs: [tab()], activeId: 't1' })).not.toThrow();
    });
  });

  it('defaults readOnly to false rather than leaving it undefined', () => {
    // Rail 6 is sticky per tab, and `undefined` would send `read_only: undefined`
    // on the wire — which `exactOptionalPropertyTypes` treats as a present key.
    store.set('steadhold:sql:x', JSON.stringify({
      tabs: [{ id: 'a', name: 'A', sql: '' }], activeId: 'a' }));
    expect(loadTabs('x').tabs[0]!.readOnly).toBe(false);
  });

  it('gives each new tab a distinct id', () => {
    const ids = new Set(Array.from({ length: 50 }, (_, i) => newTab(i).id));
    expect(ids.size).toBe(50);
  });
});

describe('what a tab calls itself', () => {
  it('describes itself from its SQL while it has a generated name', () => {
    // A list of "Query 1 … Query 7" is a list you have to click through.
    expect(describeTab(tab({ sql: 'select * from posts where id = 1' })))
      .toBe('select posts');
    expect(describeTab(tab({ sql: 'update "public"."posts" set a = 1' })))
      .toBe('update public.posts');
  });

  it('keeps a name someone chose', () => {
    expect(describeTab(tab({ name: 'nightly check', sql: 'select 1' })))
      .toBe('nightly check');
  });

  it('keeps the generated name for an empty buffer', () => {
    expect(describeTab(tab({ name: 'Query 3' }))).toBe('Query 3');
  });

  it('truncates rather than letting one tab own the strip', () => {
    const long = describeTab(tab({
      sql: 'select * from a_very_long_table_name_that_goes_on_and_on_forever' }));
    expect(long.length).toBeLessThanOrEqual(28);
    expect(long.endsWith('…')).toBe(true);
  });

  it('falls back to the leading keyword when there is no object', () => {
    expect(describeTab(tab({ sql: 'begin' }))).toBe('begin');
  });
});
