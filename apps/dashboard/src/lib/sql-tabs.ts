/**
 * The editor's scratch tabs, in `localStorage`.
 *
 * D-134: "Tabs are localStorage-only … per-project, survive reload,
 * device-local, never sent to the server until executed. Cheap, private, zero
 * API surface." The privacy half is the point worth restating: an unrun buffer
 * may hold a half-typed statement with a customer's email in a `WHERE` clause,
 * and the server is a worse place for that than the machine it was typed on.
 *
 * Keyed per project (`steadhold:sql:<ref>`), because a tab full of `posts`
 * queries is meaningless against a different database and switching projects
 * should not carry it over.
 */

export interface SqlTab {
  id: string;
  name: string;
  sql: string;
  /** Rail 6, sticky per tab — a spelunking tab stays read-only across runs. */
  readOnly: boolean;
}

export interface TabState {
  tabs: SqlTab[];
  activeId: string;
}

const key = (ref: string) => `steadhold:sql:${ref}`;

/** A fresh, empty tab. Numbered rather than named, until it is saved. */
export function newTab(n: number): SqlTab {
  return {
    // `crypto.randomUUID` is not available in every context this runs in
    // (an insecure origin, an old Safari), and a collision here would make two
    // tabs share edits. Time plus a random suffix is enough for a list that is
    // never longer than a dozen.
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: `Query ${n}`,
    sql: '',
    readOnly: false,
  };
}

/**
 * Read the saved state, or start a fresh one.
 *
 * **Every failure returns a usable state**, deliberately. `localStorage` throws
 * outright in a private window with site data blocked, returns null when it has
 * been cleared, and can hold whatever a previous version of this code wrote or a
 * user's own devtools typed. An editor that renders nothing because its tab
 * store is malformed is an editor that cannot be used to fix the problem — so
 * anything unreadable is replaced rather than reported.
 */
export function loadTabs(ref: string): TabState {
  const fresh = (): TabState => {
    const t = newTab(1);
    return { tabs: [t], activeId: t.id };
  };
  try {
    const raw = window.localStorage.getItem(key(ref));
    if (!raw) return fresh();
    const parsed = JSON.parse(raw) as unknown;
    const state = parsed as Partial<TabState>;
    if (!Array.isArray(state.tabs) || state.tabs.length === 0) return fresh();
    // Each tab is checked, not just the array: one malformed entry from an older
    // shape would otherwise render a tab with `undefined` as its buffer, which
    // CodeMirror rejects.
    const tabs = state.tabs.filter((t): t is SqlTab =>
      Boolean(t) && typeof t.id === 'string' && typeof t.name === 'string'
      && typeof t.sql === 'string');
    if (tabs.length === 0) return fresh();
    const activeId = typeof state.activeId === 'string'
      && tabs.some((t) => t.id === state.activeId) ? state.activeId : tabs[0]!.id;
    return {
      tabs: tabs.map((t) => ({ ...t, readOnly: t.readOnly === true })),
      activeId,
    };
  } catch {
    return fresh();
  }
}

/**
 * Persist. Failures are swallowed on purpose.
 *
 * A `QuotaExceededError` or a blocked store must not interrupt typing: the tab
 * is still in memory and still runnable, and the only thing lost is surviving a
 * reload. Reporting it would be a toast on every keystroke.
 */
export function saveTabs(ref: string, state: TabState): void {
  try {
    window.localStorage.setItem(key(ref), JSON.stringify(state));
  } catch { /* see above */ }
}

/**
 * The name a tab takes from its own content.
 *
 * A list of "Query 1 … Query 7" is a list you have to click through, so a tab
 * that has never been renamed describes itself instead: the leading keyword and
 * the first object it names. `select … from posts` becomes `select posts`, which
 * is what someone scanning for the right tab is actually looking for.
 *
 * Only for display, and only when the tab still has its generated name — a tab
 * someone named stays named.
 */
export function describeTab(tab: SqlTab): string {
  if (!/^Query \d+$/.test(tab.name)) return tab.name;
  const text = tab.sql.trim();
  if (!text) return tab.name;
  // Deliberately crude: this is a label, not a parse. The lexer exists for
  // decisions, and mislabelling a tab costs nothing.
  const words = text.replace(/\s+/g, ' ').split(' ');
  const lead = (words[0] ?? '').toLowerCase();
  const objectAfter = /\b(?:from|into|table|update)\s+([\w".]+)/i.exec(text);
  const object = objectAfter?.[1]?.replace(/"/g, '');
  const label = object ? `${lead} ${object}` : lead;
  return label.length > 28 ? `${label.slice(0, 27)}…` : label;
}
