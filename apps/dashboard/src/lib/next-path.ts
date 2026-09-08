/**
 * Validating a `?next=` redirect target.
 *
 * The invitation flow made `next` load-bearing: an invitee is bounced from
 * `/accept-invite/<token>` to `/login?next=…` and expects to land back on the
 * invitation. That makes the parameter attacker-supplied on a page a stranger
 * is, by design, likely to open from a link someone sent them — the exact
 * setting an open redirect is phished from.
 *
 * `raw.startsWith('/')` is **not** the check, though both call sites used it and
 * one of them carried a comment claiming it kept the redirect on-site.
 * `//evil.com` starts with a slash and is a *protocol-relative* URL, which a
 * browser resolves to `https://evil.com`; `/\evil.com` is the same attack via a
 * backslash, which several browsers normalise to `//`.
 *
 * So: one leading slash, nothing slash-like or backslash-like immediately after
 * it, and no backslash or control character anywhere. None of those appear in
 * any route this app owns, and each exists here only to be normalised into
 * something else by whatever parses it next.
 *
 * The scan is a loop over code points rather than a regex character class: the
 * class needs escaped control-character ranges, and an escape that silently
 * degrades to a literal is exactly how the first version of this guard shipped
 * rejecting every hyphen.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return null;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\' || code < 0x20 || code === 0x7f) return null;
  }
  return raw;
}
