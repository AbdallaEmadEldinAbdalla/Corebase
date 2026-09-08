/**
 * Where an auth link is allowed to send someone (P4c, auth architecture
 * checklist item 6).
 *
 * ## Why this is a security module and not a URL helper
 *
 * A verification or recovery redirect carries a **live session** — the tokens ride
 * in the URL fragment. So a `redirect_to` that can be pointed at an arbitrary host
 * is not an open-redirect annoyance, it is a credential-exfiltration primitive
 * with our sending domain's reputation attached: mail arrives from a reputable
 * source, the link genuinely goes to `<ref>.steadhold.app`, and the tokens end up
 * somewhere else.
 *
 * Two rules follow, and both are the unforgiving direction:
 *
 * 1. An unlisted target is **replaced** by `site_url`, never rejected and never
 *    honoured. Rejecting would turn a mistyped config into a dead verification
 *    link; honouring is the hole.
 * 2. A project with no `site_url` allows **no redirect at all**. "Configured
 *    nothing" must not read as "allowed everything".
 */

export interface RedirectPolicy {
  siteUrl: string | null;
  additionalRedirects: readonly string[];
}

/**
 * Is `candidate` allowed, by exact origin match plus path prefix?
 *
 * Exact origin, not suffix: `endsWith('example.com')` also accepts
 * `evil-example.com` and `example.com.attacker.net`, which is the single most
 * common way an allowlist like this is written wrong. The comparison is on the
 * parsed origin, so it cannot be talked out of that.
 */
function allowed(candidate: URL, entry: string): boolean {
  let base: URL;
  try { base = new URL(entry); } catch { return false; }
  if (candidate.origin !== base.origin) return false;
  // A path prefix, but only at a segment boundary: `/auth` must not authorise
  // `/authorize-elsewhere`. An entry with no meaningful path (`/`) allows the
  // whole origin, which is what listing a bare origin is understood to mean.
  const basePath = base.pathname.replace(/\/+$/, '');
  if (basePath === '') return true;
  const path = candidate.pathname.replace(/\/+$/, '');
  return path === basePath || path.startsWith(basePath + '/');
}

/**
 * The URL to actually redirect to, and whether the request got what it asked
 * for.
 *
 * The `substituted` flag exists so the caller can audit the substitution. A
 * silent replacement is correct behaviour for the *user* and a missing signal for
 * the *developer*, who otherwise sees "my redirect is ignored" with nothing to go
 * on — and the same log line is what shows an attack in progress.
 */
export function resolveRedirect(
  policy: RedirectPolicy, requested: string | undefined,
): { url: string | null; substituted: boolean } {
  const site = policy.siteUrl;
  if (!requested) return { url: site, substituted: false };

  let candidate: URL;
  try { candidate = new URL(requested); } catch {
    return { url: site, substituted: true };
  }
  // Only http(s). `javascript:`, `data:` and app-scheme URLs are refused before
  // any allowlist comparison, because a scheme check that runs *after* an origin
  // match is a check that can be skipped by a URL whose origin parses as 'null'.
  if (candidate.protocol !== 'https:' && candidate.protocol !== 'http:') {
    return { url: site, substituted: true };
  }
  if (!site) return { url: null, substituted: true };

  const entries = [site, ...policy.additionalRedirects];
  for (const entry of entries) {
    if (allowed(candidate, entry)) return { url: requested, substituted: false };
  }
  return { url: site, substituted: true };
}

/**
 * Attach tokens to a redirect as a **fragment**, not a query string.
 *
 * The fragment is never sent to a server, so the tokens do not appear in the
 * destination's access logs, in any proxy between here and there, or in a
 * `Referer` header. Same tokens, same URL, entirely different disclosure — and
 * this is the difference between a session handed to the user's browser and a
 * session written into somebody's log retention.
 */
export function withTokenFragment(
  url: string, tokens: Record<string, string | number>,
): string {
  const frag = new URLSearchParams();
  for (const [k, v] of Object.entries(tokens)) frag.set(k, String(v));
  const base = url.split('#')[0]!;
  return `${base}#${frag.toString()}`;
}
