import { describe, expect, it } from 'vitest';
import { safeNext } from './next-path.ts';

/** Built from code points so no control character is typed into this file. */
const withChar = (code: number) => `/org/${String.fromCharCode(code)}evil`;

describe('safeNext', () => {
  it('keeps the in-app paths the invitation flow actually uses', () => {
    for (const p of ['/', '/org/acme', '/accept-invite/shi_abc-123', '/org/a/members',
                     '/login?next=%2Forg%2Fa', '/org/acme#keys']) {
      expect(safeNext(p)).toBe(p);
    }
  });

  it('refuses anything that is not a path', () => {
    for (const p of ['https://evil.com', 'http://evil.com', 'evil.com',
                     'javascript:alert(1)', 'data:text/html,x', '']) {
      expect(safeNext(p)).toBeNull();
    }
  });

  /**
   * The case the previous `startsWith('/')` guard let through: every one of
   * these starts with a slash and leaves the origin.
   */
  it('refuses protocol-relative targets, which start with a slash', () => {
    for (const p of ['//evil.com', '//evil.com/steadhold', '///evil.com',
                     '/\\evil.com', '/\\/evil.com']) {
      expect(safeNext(p)).toBeNull();
    }
  });

  it('refuses a backslash anywhere, not only after the first slash', () => {
    expect(safeNext('/org/a\\..\\evil')).toBeNull();
  });

  it('refuses control characters, which exist only to be normalised away', () => {
    for (const code of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
      expect(safeNext(withChar(code))).toBeNull();
    }
  });

  /** A hyphen is not a control character — the first version of this rejected it. */
  it('keeps the characters real routes contain', () => {
    for (const p of ['/accept-invite/x', '/org/my-org', '/a_b', '/a.b', '/a~b', '/a%20b']) {
      expect(safeNext(p)).toBe(p);
    }
  });

  it('is null for a missing parameter', () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
  });
});
