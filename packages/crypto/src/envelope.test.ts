import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createEnvelope, generateSecret, secretsEqual, KekError, EnvelopeError } from './envelope.ts';

let dir: string;
const ID = { projectId: 'a1b2c3d4-0000-0000-0000-000000000001', name: 'DEVELOPER_PASSWORD', version: 1 };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cb-kek-'));
  writeFileSync(join(dir, 'kek_2026_08.key'), randomBytes(32));
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('envelope encryption (D-035, D-075)', () => {
  it('round-trips a secret', () => {
    const env = createEnvelope({ kekDir: dir });
    const sealed = env.encrypt('hunter2', ID);
    expect(env.decrypt(sealed, ID)).toBe('hunter2');
  });

  it('never stores the plaintext in either column', () => {
    const env = createEnvelope({ kekDir: dir });
    const sealed = env.encrypt('SUPER-SECRET-VALUE', ID);
    expect(sealed.ciphertext.toString('latin1')).not.toContain('SUPER-SECRET-VALUE');
    expect(sealed.dekWrapped.toString('latin1')).not.toContain('SUPER-SECRET-VALUE');
  });

  it('produces a different ciphertext every time for the same input', () => {
    const env = createEnvelope({ kekDir: dir });
    const a = env.encrypt('same', ID);
    const b = env.encrypt('same', ID);
    // Per-secret DEKs plus random nonces: equal secrets must not be linkable by
    // comparing rows.
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.dekWrapped.equals(b.dekWrapped)).toBe(false);
  });

  it('records which KEK wrapped the DEK', () => {
    const env = createEnvelope({ kekDir: dir });
    expect(env.encrypt('x', ID).kekId).toBe('kek_2026_08');
  });

  it('refuses a ciphertext moved to another project', () => {
    const env = createEnvelope({ kekDir: dir });
    const sealed = env.encrypt('project-a-password', ID);
    // The whole point of binding the AAD: stealing a row into another project's
    // id must not yield a working credential.
    expect(() => env.decrypt(sealed, { ...ID, projectId: 'ffffffff-0000-0000-0000-000000000002' }))
      .toThrow(EnvelopeError);
  });

  it('refuses a ciphertext moved to another secret name or version', () => {
    const env = createEnvelope({ kekDir: dir });
    const sealed = env.encrypt('developer-password', ID);
    expect(() => env.decrypt(sealed, { ...ID, name: 'POSTGRES_PASSWORD' })).toThrow(EnvelopeError);
    expect(() => env.decrypt(sealed, { ...ID, version: 2 })).toThrow(EnvelopeError);
  });

  it('refuses a tampered ciphertext', () => {
    const env = createEnvelope({ kekDir: dir });
    const sealed = env.encrypt('value', ID);
    sealed.ciphertext.writeUInt8(sealed.ciphertext.at(-1)! ^ 0x01, sealed.ciphertext.length - 1);
    expect(() => env.decrypt(sealed, ID)).toThrow(EnvelopeError);
  });

  it('refuses a DEK swapped in from a different secret', () => {
    const env = createEnvelope({ kekDir: dir });
    const a = env.encrypt('a-value', ID);
    const b = env.encrypt('b-value', ID);
    expect(() => env.decrypt({ ...a, dekWrapped: b.dekWrapped }, ID)).toThrow(EnvelopeError);
  });

  it('cannot decrypt with a different KEK', () => {
    const other = mkdtempSync(join(tmpdir(), 'cb-kek-other-'));
    writeFileSync(join(other, 'kek_2026_08.key'), randomBytes(32));  // same id, different bytes
    try {
      const sealed = createEnvelope({ kekDir: dir }).encrypt('secret', ID);
      expect(() => createEnvelope({ kekDir: other }).decrypt(sealed, ID)).toThrow(EnvelopeError);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('says so plainly when the wrapping KEK is not loaded', () => {
    const env = createEnvelope({ kekDir: dir });
    const sealed = { ...env.encrypt('secret', ID), kekId: 'kek_2025_01' };
    expect(() => env.decrypt(sealed, ID)).toThrow(KekError);
    expect(() => env.decrypt(sealed, ID)).toThrow(/kek_2025_01/);
  });
});

describe('KEK rotation (the kek_id indirection of D-075)', () => {
  it('wraps new secrets under the newest key while old rows still decrypt', () => {
    const two = mkdtempSync(join(tmpdir(), 'cb-kek-two-'));
    try {
      const oldKey = randomBytes(32);
      writeFileSync(join(two, 'kek_2026_08.key'), oldKey);
      const before = createEnvelope({ kekDir: two });
      const old = before.encrypt('long-lived-secret', ID);
      expect(old.kekId).toBe('kek_2026_08');

      writeFileSync(join(two, 'kek_2026_12.key'), randomBytes(32));
      const after = createEnvelope({ kekDir: two });
      expect(after.kekId).toBe('kek_2026_12');
      expect(after.encrypt('new-secret', ID).kekId).toBe('kek_2026_12');
      // The old row is still readable — rotation is a background job, not a
      // flag day.
      expect(after.decrypt(old, ID)).toBe('long-lived-secret');

      const rewrapped = after.rewrap(old, ID);
      expect(rewrapped.kekId).toBe('kek_2026_12');
      expect(rewrapped.ciphertext.equals(old.ciphertext)).toBe(true);  // untouched
      expect(after.decrypt(rewrapped, ID)).toBe('long-lived-secret');
    } finally {
      rmSync(two, { recursive: true, force: true });
    }
  });

  it('honours an explicitly pinned KEK', () => {
    const two = mkdtempSync(join(tmpdir(), 'cb-kek-pin-'));
    try {
      writeFileSync(join(two, 'kek_2026_08.key'), randomBytes(32));
      writeFileSync(join(two, 'kek_2026_12.key'), randomBytes(32));
      expect(createEnvelope({ kekDir: two, kekId: 'kek_2026_08' }).kekId).toBe('kek_2026_08');
      expect(() => createEnvelope({ kekDir: two, kekId: 'nope' })).toThrow(KekError);
    } finally {
      rmSync(two, { recursive: true, force: true });
    }
  });
});

describe('startup refusals', () => {
  it('refuses to start with no KEK directory', () => {
    expect(() => createEnvelope({ kekDir: '/nonexistent/kek.d' })).toThrow(KekError);
  });

  it('refuses to start with an empty KEK directory', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cb-kek-empty-'));
    try {
      expect(() => createEnvelope({ kekDir: empty })).toThrow(/no \*\.key files/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('refuses a KEK of the wrong length', () => {
    const short = mkdtempSync(join(tmpdir(), 'cb-kek-short-'));
    try {
      writeFileSync(join(short, 'kek_2026_08.key'), randomBytes(16));
      expect(() => createEnvelope({ kekDir: short })).toThrow(/16 bytes, expected 32/);
    } finally {
      rmSync(short, { recursive: true, force: true });
    }
  });
});

describe('generateSecret', () => {
  it('is 256 bits of base64url, url-safe', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateSecret()));
    expect(seen.size).toBe(200);
  });
  it('compares without leaking length-independent timing', () => {
    const s = generateSecret();
    expect(secretsEqual(s, s)).toBe(true);
    expect(secretsEqual(s, generateSecret())).toBe(false);
    expect(secretsEqual(s, s + 'x')).toBe(false);
  });
});
