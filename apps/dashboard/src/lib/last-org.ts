/**
 * The org the user was last looking at, so `/` lands somewhere useful rather
 * than always on the first org alphabetically. Per-browser UI ephemera, which
 * the IA puts in localStorage rather than in any server state.
 */
const KEY = 'sh.lastOrg';

export function rememberOrg(slug: string): void {
  try { localStorage.setItem(KEY, slug); } catch { /* private mode */ }
}

export function lastOrg(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
