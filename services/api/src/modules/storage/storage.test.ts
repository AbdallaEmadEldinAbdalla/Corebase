import { describe, it, expect } from 'vitest';
import { normalizePath, normalizeBucket, objectKey, PathError } from './keys.ts';
import { sniff, mimeAllowed, servingHeaders } from './mime.ts';

/**
 * P6c — the two modules where a mistake is a cross-tenant read or a stored XSS.
 *
 * Unit-tested rather than only exercised through HTTP, because what matters here
 * is the *set* of inputs refused, and enumerating that set over the network would
 * cost a container per case while proving nothing extra: neither module touches a
 * database or the object store.
 */

describe('P6c — object keys are built from the authenticated ref', () => {
  it('puts the project prefix first, so a bucket name cannot reach outside it', () => {
    expect(objectKey('abc123', 'avatars', 'u/1.png'))
      .toBe('projects/abc123/avatars/u/1.png');
  });

  it('refuses every path that could climb out of the prefix', () => {
    const bad = [
      '../etc/passwd',           // the obvious one
      'a/../../b',               // traversal in the middle
      '/absolute',               // leading slash: assembles a `//` key
      'a//b',                    // empty segment: same divergence, different route
      'a/./b',                   // single-dot segment
      '..',
      '.',
      'trailing/',               // ambiguous: file or folder?
      'a%2f..%2fb',              // encoded separator — the decode-pass gamble
      'a%2e%2e/b',               // encoded dots
      'A%2F',                    // and case-insensitively
      '',
    ];
    for (const p of bad) {
      expect(() => normalizePath(p), p).toThrow(PathError);
    }
    expect(() => normalizePath('x'.repeat(1025))).toThrow(PathError);
  });

  it('allows the ordinary filenames a stricter check would break', () => {
    // This is the half that stops the check above from being a bug wearing
    // security's clothes: dots, spaces and Unicode are all legal in a filename.
    for (const p of [
      'v1.2/photo..png', 'my file.txt', 'Ünïcödé/naïve.png',
      'a/b/c/d/e.txt', 'no-extension', '.hidden', 'ends.with.dots..',
    ]) {
      expect(normalizePath(p), p).toBe(p);
    }
  });

  it('returns paths unchanged rather than rewriting them', () => {
    // A normaliser that *fixed* paths would make the name sent and the name
    // stored differ, and then every later comparison — upsert, signed URL, the
    // sweep's anti-join — would have to know which form it held.
    expect(normalizePath('a/b.png')).toBe('a/b.png');
  });

  it('validates a bucket name arriving from the URL', () => {
    for (const b of ['UPPER', 'has space', '-leading', 'x', 'a/b', '..']) {
      expect(() => normalizeBucket(b), b).toThrow(PathError);
    }
    expect(normalizeBucket('a0.b_c-d')).toBe('a0.b_c-d');
  });
});

const head = (bytes: number[]) => Buffer.from(bytes);
const text = (s: string) => Buffer.from(s, 'latin1');

describe('P6c — the dangerous-set sniff', () => {
  it('refuses executables whatever they claim to be', () => {
    const cases: Array<[string, Buffer]> = [
      ['MZ', head([0x4d, 0x5a, 0x90, 0x00])],
      ['ELF', head([0x7f, 0x45, 0x4c, 0x46, 0x02])],
      ['Mach-O', head([0xcf, 0xfa, 0xed, 0xfe, 0x0c])],
      ['Java/fat', head([0xca, 0xfe, 0xba, 0xbe, 0x00])],
    ];
    for (const [label, bytes] of cases) {
      // Including under the catch-all type, which would otherwise be the opt-out.
      for (const declared of ['image/png', 'application/octet-stream', 'text/plain']) {
        const v = sniff(bytes, declared);
        expect(v.ok, `${label} as ${declared}`).toBe(false);
        expect(v.reason).toBeTruthy();
      }
    }
  });

  it('refuses a declaration the bytes contradict', () => {
    const notAPng = Buffer.concat([text('GIF89a'), Buffer.alloc(16)]);
    const v = sniff(notAPng, 'image/png');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not a PNG/);
  });

  it('accepts a declaration the bytes agree with', () => {
    const png = Buffer.concat([
      head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    expect(sniff(png, 'image/png').ok).toBe(true);
    const jpeg = Buffer.concat([head([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
    expect(sniff(jpeg, 'image/jpeg').ok).toBe(true);
  });

  it('refuses markup wearing an image type — the stored-XSS shape', () => {
    for (const body of ['<script>alert(1)</script>', '<?php system($_GET[0]);',
                        '<!DOCTYPE html><html>']) {
      const v = sniff(Buffer.concat([text(body), Buffer.alloc(16)]), 'image/svg+xml');
      expect(v.ok, body).toBe(false);
    }
  });

  it('lets unknown types through, because "no signature" is not "contradicted"', () => {
    // The restraint that keeps this from refusing most real files: a CSV, a
    // tarball and a font have no signature this module knows, and that is fine.
    for (const declared of ['text/csv', 'application/gzip', 'font/woff2', 'text/plain']) {
      expect(sniff(text('id,name\n1,a\n'), declared).ok, declared).toBe(true);
    }
  });

  it('does not crash on a body shorter than a signature', () => {
    // A one-byte upload is legal, and a check that indexed past the end of it
    // would turn the smallest possible file into a 500.
    expect(sniff(Buffer.from([0x89]), 'image/png').ok).toBe(true);
    expect(sniff(Buffer.alloc(0), 'image/png').ok).toBe(true);
  });
});

describe('P6c — the bucket allowlist', () => {
  it('allows anything when unset', () => {
    expect(mimeAllowed('application/x-thing', null)).toBe(true);
    expect(mimeAllowed('application/x-thing', [])).toBe(true);
  });

  it('matches exactly, and honours a type wildcard', () => {
    expect(mimeAllowed('image/png', ['image/png'])).toBe(true);
    expect(mimeAllowed('image/gif', ['image/png'])).toBe(false);
    expect(mimeAllowed('image/gif', ['image/*'])).toBe(true);
    expect(mimeAllowed('video/mp4', ['image/*'])).toBe(false);
  });

  it('ignores parameters and case on both sides', () => {
    // `Content-Type: image/PNG; charset=binary` is the same type as `image/png`,
    // and a comparison that missed that would refuse a legitimate upload for a
    // reason no error message could explain.
    expect(mimeAllowed('image/PNG; charset=binary', ['image/png'])).toBe(true);
    expect(mimeAllowed('image/png', ['IMAGE/PNG; q=1'])).toBe(true);
  });
});

describe('P6c — serving hygiene, the load-bearing half of D-123', () => {
  it('always sends nosniff', () => {
    for (const type of ['image/png', 'text/plain', 'application/octet-stream']) {
      expect(servingHeaders(type)['x-content-type-options'], type).toBe('nosniff');
    }
  });

  it('forces a download and sandboxes the two types that execute', () => {
    for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml']) {
      const h = servingHeaders(type);
      expect(h['content-disposition'], type).toBe('attachment');
      expect(h['content-security-policy'], type).toMatch(/sandbox/);
    }
  });

  it('leaves ordinary media inline, because forcing every download is a broken product', () => {
    const h = servingHeaders('image/png');
    expect(h['content-disposition']).toBeUndefined();
  });
});
