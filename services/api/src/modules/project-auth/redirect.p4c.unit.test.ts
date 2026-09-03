import { describe, it, expect } from 'vitest';
import { resolveRedirect, withTokenFragment } from './redirect.ts';

/**
 * P4c — the redirect allowlist.
 *
 * Pure and therefore fast, which is why every nasty case lives here rather than
 * in the integration suite: this is the control that stops a verification link
 * from carrying a live session to somebody else's host, and the ways an allowlist
 * gets written wrong are all string-comparison mistakes.
 */
const policy = (siteUrl: string | null, ...extra: string[]) =>
  ({ siteUrl, additionalRedirects: extra });

describe('P4c — resolveRedirect', () => {
  it('honours the site_url itself and anything under it', () => {
    const p = policy('https://app.example.com');
    expect(resolveRedirect(p, 'https://app.example.com')).toEqual(
      { url: 'https://app.example.com', substituted: false });
    expect(resolveRedirect(p, 'https://app.example.com/welcome?x=1').substituted).toBe(false);
  });

  it('falls back to site_url rather than rejecting or honouring an unlisted target', () => {
    const p = policy('https://app.example.com');
    // Not a 400: a mistyped redirect in a client must not turn a valid
    // verification link into a dead one. Not honoured either — that is the hole.
    expect(resolveRedirect(p, 'https://evil.test/steal')).toEqual(
      { url: 'https://app.example.com', substituted: true });
  });

  it('matches the origin exactly, not by suffix', () => {
    const p = policy('https://example.com');
    // The classic bug. `endsWith('example.com')` accepts both of these.
    for (const bad of ['https://evil-example.com/x', 'https://example.com.attacker.net/x',
                       'https://notexample.com/x']) {
      expect(resolveRedirect(p, bad).substituted).toBe(true);
    }
  });

  it('treats scheme, host and port as part of the origin', () => {
    const p = policy('https://app.example.com');
    // http:// is a different origin, and a downgrade would put a session's
    // tokens on the wire in clear.
    expect(resolveRedirect(p, 'http://app.example.com/').substituted).toBe(true);
    expect(resolveRedirect(p, 'https://app.example.com:8443/').substituted).toBe(true);
    expect(resolveRedirect(p, 'https://other.example.com/').substituted).toBe(true);
  });

  it('matches a path prefix only at a segment boundary', () => {
    const p = policy('https://app.example.com/auth');
    expect(resolveRedirect(p, 'https://app.example.com/auth').substituted).toBe(false);
    expect(resolveRedirect(p, 'https://app.example.com/auth/callback').substituted).toBe(false);
    // `/auth` must not authorise `/authorize-elsewhere` — a plain startsWith does.
    expect(resolveRedirect(p, 'https://app.example.com/authorize-elsewhere').substituted)
      .toBe(true);
    expect(resolveRedirect(p, 'https://app.example.com/other').substituted).toBe(true);
  });

  it('refuses non-http schemes before it compares anything', () => {
    const p = policy('https://app.example.com');
    // `javascript:` and `data:` parse as URLs with origin 'null', so a scheme
    // check that ran *after* an origin comparison could be skipped entirely.
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>',
                       'file:///etc/passwd', 'myapp://callback']) {
      expect(resolveRedirect(p, bad)).toEqual(
        { url: 'https://app.example.com', substituted: true });
    }
  });

  it('permits nothing at all when the project configured no site_url', () => {
    // "Configured nothing" must not read as "allowed everything" — the whole
    // fail-closed direction of this module.
    expect(resolveRedirect(policy(null), 'https://anywhere.test/')).toEqual(
      { url: null, substituted: true });
    expect(resolveRedirect(policy(null), undefined)).toEqual(
      { url: null, substituted: false });
  });

  it('consults the additional list as well as site_url', () => {
    const p = policy('https://app.example.com', 'https://staging.example.com/auth',
                     'http://localhost:3000');
    expect(resolveRedirect(p, 'https://staging.example.com/auth/cb').substituted).toBe(false);
    expect(resolveRedirect(p, 'https://staging.example.com/elsewhere').substituted).toBe(true);
    // localhost over http is allowed *because a project listed it* — the policy
    // is the project's to set; what is not negotiable is that it be listed.
    expect(resolveRedirect(p, 'http://localhost:3000/cb').substituted).toBe(false);
  });

  it('ignores a garbage entry instead of throwing on it', () => {
    // A bad allowlist row must not 500 every verification for that project.
    const p = policy('https://app.example.com', 'not a url', '');
    expect(resolveRedirect(p, 'https://app.example.com/x').substituted).toBe(false);
    expect(resolveRedirect(p, 'https://evil.test/x').substituted).toBe(true);
  });

  it('substitutes for an unparseable requested value', () => {
    expect(resolveRedirect(policy('https://app.example.com'), '://///').substituted).toBe(true);
  });
});

describe('P4c — withTokenFragment', () => {
  it('puts tokens after the # so they never reach a server', () => {
    const url = withTokenFragment('https://app.example.com/cb?a=1',
      { access_token: 'aa.bb.cc', refresh_token: 'cb_rt_x', expires_in: 3600 });
    expect(url.startsWith('https://app.example.com/cb?a=1#')).toBe(true);
    const frag = new URLSearchParams(url.split('#')[1]);
    expect(frag.get('access_token')).toBe('aa.bb.cc');
    expect(frag.get('expires_in')).toBe('3600');
    // The query string is untouched, and no token leaked into it.
    expect(url.split('#')[0]).toBe('https://app.example.com/cb?a=1');
  });

  it('replaces an existing fragment rather than appending to it', () => {
    // Appending would produce two '#' and a fragment the browser reads as one
    // opaque string, so the client would find no tokens at all.
    const url = withTokenFragment('https://app.example.com/cb#stale', { a: '1' });
    expect(url).toBe('https://app.example.com/cb#a=1');
  });
});
