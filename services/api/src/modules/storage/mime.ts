/**
 * Content inspection at upload time (P6c, D-123).
 *
 * ## The decision this implements, and the two it rejects
 *
 * Trusting the declared `Content-Type` is free, and it lets `evil.exe` be
 * uploaded as `image/png` and served back as one. Full sniffing of every format
 * is a rabbit hole of ambiguous magic numbers that ends in refusing legitimate
 * files. So neither: **verify the bytes against a known-dangerous set, and
 * otherwise store the declared type.**
 *
 * That is a deliberately narrow claim. This module does not know what a file
 * *is*; it knows a short list of things a file must not be, and it knows when a
 * declaration contradicts the bytes badly enough to be a lie. Everything else
 * passes through with the type the client said — which is then served with
 * `nosniff`, and the serving hygiene at the bottom of this file does at least as
 * much work as the sniffing at the top.
 */

/** The first bytes are enough: every signature below lives in the first twelve. */
export const SNIFF_BYTES = 512;

const startsWith = (b: Buffer, bytes: number[]): boolean =>
  b.length >= bytes.length && bytes.every((v, i) => b[i] === v);

/**
 * Executables and active content, refused whatever the declared type says.
 *
 * Unconditional rather than only-when-contradicted, because there is no declared
 * type that makes hosting a Windows binary on a customer's CDN-cached origin a
 * good idea — and `application/octet-stream` would otherwise be a way to opt out
 * of the check entirely. A customer who genuinely needs to distribute
 * executables is asking for a different product surface, and a clear refusal is
 * a better answer than a silent one.
 */
const DANGEROUS: Array<{ label: string; test: (b: Buffer) => boolean }> = [
  { label: 'a Windows executable (MZ)', test: (b) => startsWith(b, [0x4d, 0x5a]) },
  { label: 'an ELF binary', test: (b) => startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) },
  // Mach-O in all four 32/64-bit and endianness combinations, plus the fat
  // header. Listed individually rather than masked, because a mask wide enough
  // to catch all five also catches unrelated formats.
  {
    label: 'a Mach-O binary or Java class',
    test: (b) => [
      [0xfe, 0xed, 0xfa, 0xce], [0xce, 0xfa, 0xed, 0xfe],
      [0xfe, 0xed, 0xfa, 0xcf], [0xcf, 0xfa, 0xed, 0xfe],
      // 0xcafebabe is both a Mach-O fat binary and a Java class file. One entry
      // for both, since the label only has to be true.
      [0xca, 0xfe, 0xba, 0xbe],
    ].some((sig) => startsWith(b, sig)),
  },
];

/** Magic numbers for the media types worth cross-checking a declaration against. */
const MEDIA: Array<{ mime: RegExp; label: string; test: (b: Buffer) => boolean }> = [
  {
    mime: /^image\/png$/i, label: 'a PNG',
    test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: /^image\/jpe?g$/i, label: 'a JPEG', test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: /^image\/gif$/i, label: 'a GIF', test: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    mime: /^image\/webp$/i, label: 'a WebP',
    test: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46])
                 && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    mime: /^application\/pdf$/i, label: 'a PDF',
    test: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]),
  },
];

/** `<script`, `<?php` and friends — active content wearing an image's name. */
const ACTIVE = /<script[\s>]|<\?php|<%[\s@=]|<!doctype\s+html|<html[\s>]/i;

export interface SniffVerdict {
  ok: boolean;
  /** Present when refused: what was seen, in words the caller can act on. */
  reason?: string;
}

/**
 * Inspect the leading bytes against the declared type.
 *
 * Order matters: the unconditional refusals run first, so a binary declared as
 * `application/octet-stream` is still refused.
 */
export function sniff(head: Buffer, declaredType: string): SniffVerdict {
  for (const sig of DANGEROUS) {
    if (sig.test(head)) return { ok: false, reason: `the content looks like ${sig.label}` };
  }

  // A declaration naming a media type the bytes contradict. Only for the types
  // above: the absence of a signature for `text/csv` means nothing, and treating
  // "no signature known" as "contradicted" would refuse most files.
  for (const m of MEDIA) {
    if (m.mime.test(declaredType) && head.length >= 12 && !m.test(head)) {
      return {
        ok: false,
        reason: `the declared type is ${declaredType} but the content is not ${m.label}`,
      };
    }
  }

  // Active content masquerading as media — the narrow case of the above, and the
  // shape that turns an image upload into stored XSS on whatever origin serves
  // it back.
  if (/^(image|video|audio)\//i.test(declaredType)) {
    if (ACTIVE.test(head.subarray(0, SNIFF_BYTES).toString('latin1'))) {
      return {
        ok: false,
        reason: `the declared type is ${declaredType} but the content contains markup or script`,
      };
    }
  }

  return { ok: true };
}

/**
 * Is this declared type allowed by the bucket's allowlist?
 *
 * `null` or empty means any. Entries may be exact (`image/png`) or a type
 * wildcard (`image/*`), which is the shape customers expect from every other
 * storage product and cheap to honour.
 */
export function mimeAllowed(declaredType: string, allowed: string[] | null): boolean {
  if (!allowed || allowed.length === 0) return true;
  const type = declaredType.split(';')[0]!.trim().toLowerCase();
  return allowed.some((entry) => {
    const pattern = entry.split(';')[0]!.trim().toLowerCase();
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1));
    return pattern === type;
  });
}

/**
 * Headers that make serving a stored object safe, whatever it turned out to be.
 *
 * **This is the load-bearing half of D-123, not defence in depth**, and the doc
 * says so: the dedicated storage host is unavailable in V1, so public objects
 * serve from the project's own origin. Without these headers a stored `.html`
 * executes with that origin's privileges — stored XSS against the customer's own
 * API surface rather than against a sandboxed file host.
 */
export function servingHeaders(mimeType: string): Record<string, string> {
  const type = mimeType.split(';')[0]!.trim().toLowerCase();
  const headers: Record<string, string> = {
    // Unconditional: a browser that sniffs is a browser that can be talked into
    // executing an object whose declared type was harmless.
    'x-content-type-options': 'nosniff',
  };
  // HTML and SVG are the two that execute. Forcing a download rather than
  // refusing the upload keeps them storable — customers legitimately store
  // both — while stopping the browser running them in the origin's context.
  if (type === 'text/html' || type === 'image/svg+xml'
      || type === 'application/xhtml+xml' || type === 'text/xml') {
    headers['content-disposition'] = 'attachment';
    headers['content-security-policy'] = "default-src 'none'; sandbox";
  }
  return headers;
}
