import { describe, it, expect } from 'vitest';
import {
  hashPassword, verifyPassword, validatePassword, burnVerify, decoyHash,
  SCRYPT_PARAMS, MIN_PASSWORD_LENGTH, PasswordFormatError,
} from './password.ts';

const GOOD = 'correct horse battery staple';

describe('hashing', () => {
  it('round-trips', async () => {
    const stored = await hashPassword(GOOD);
    expect((await verifyPassword(GOOD, stored)).ok).toBe(true);
    expect((await verifyPassword(GOOD + 'x', stored)).ok).toBe(false);
  });

  it('never stores the password', async () => {
    const stored = await hashPassword(GOOD);
    expect(stored).not.toContain(GOOD);
    expect(stored).not.toContain('horse');
  });

  it('salts, so identical passwords do not collide', async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    // Both still verify — the point of a salt, not an accident of it.
    expect((await verifyPassword(GOOD, a)).ok).toBe(true);
    expect((await verifyPassword(GOOD, b)).ok).toBe(true);
  }, 20_000);

  it('carries its parameters, so cost can be raised without a flag day', async () => {
    const stored = await hashPassword(GOOD);
    const [alg, N, r, p] = stored.split('$');
    expect(alg).toBe('scrypt');
    expect(Number(N)).toBe(SCRYPT_PARAMS.N);
    expect(Number(r)).toBe(SCRYPT_PARAMS.r);
    expect(Number(p)).toBe(SCRYPT_PARAMS.p);
  });

  it('flags a real weaker hash for rehash on success', async () => {
    const { scrypt } = await import('node:crypto');
    const { promisify } = await import('node:util');
    const kdf = promisify(scrypt) as (pw: string, salt: Buffer, len: number, o: object) => Promise<Buffer>;
    const salt = Buffer.from('0123456789abcdef');
    const key = await kdf(GOOD.normalize('NFKC'), salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 << 20 });
    const weak = `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
    const res = await verifyPassword(GOOD, weak);
    expect(res.ok).toBe(true);
    expect(res.needsRehash).toBe(true);
  });

  it('normalises unicode, so a password verifies from another keyboard', async () => {
    // Composed vs decomposed accents are different bytes and the same password;
    // without NFKC the failure is indistinguishable from a typo.
    const composed = 'contraseña-muy-larga';        // ñ
    const decomposed = 'contraseña-muy-larga';     // n + combining tilde
    const stored = await hashPassword(composed);
    expect((await verifyPassword(decomposed, stored)).ok).toBe(true);
  }, 20_000);

  it('rejects a malformed stored hash rather than returning false', async () => {
    // A parse failure is a bug or a corrupted row, not a wrong password, and
    // conflating them hides the difference during an incident.
    for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'argon2$1$2$3$4$5', 'scrypt$4$8$1$aa$bb']) {
      await expect(verifyPassword(GOOD, bad)).rejects.toThrow(PasswordFormatError);
    }
  });
});

describe('policy', () => {
  it('requires a minimum length and nothing else', async () => {
    // Composition rules push people toward Passw0rd!; length does not.
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(() => validatePassword('short')).toThrow(/at least 12/);
    expect(() => validatePassword('a'.repeat(12))).not.toThrow();
    expect(() => validatePassword('all lower case no digits')).not.toThrow();
  });

  it('caps the length, because a 10 MB password is a denial of service', () => {
    expect(() => validatePassword('a'.repeat(2000))).toThrow(/at most/);
  });

  it('refuses to hash a password that fails the policy', async () => {
    await expect(hashPassword('short')).rejects.toThrow(PasswordFormatError);
  });
});

describe('enumeration resistance', () => {
  it('provides a decoy so an unknown email costs the same as a wrong password', async () => {
    // Without this, "no such user" returns in a millisecond and "wrong password"
    // takes ~100ms — a free user-enumeration oracle.
    const stored = await decoyHash();
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect((await verifyPassword('anything at all', stored)).ok).toBe(false);
  }, 20_000);

  it('burnVerify never throws, whatever it is given', async () => {
    // It runs on the failure path; throwing there would turn a timing defence
    // into a 500 that distinguishes the two cases even more clearly.
    await expect(burnVerify('x')).resolves.toBeUndefined();
    await expect(burnVerify('')).resolves.toBeUndefined();
  }, 20_000);

  it('spends comparable time on a real miss and an unknown user', async () => {
    const stored = await hashPassword(GOOD);
    const t0 = performance.now();
    await verifyPassword('wrong password entirely', stored);
    const real = performance.now() - t0;

    const t1 = performance.now();
    await burnVerify('wrong password entirely');
    const decoyTime = performance.now() - t1;

    // Loose bound on purpose: this asserts the same order of magnitude, which is
    // what closes the oracle. A tight bound would be a flaky test.
    expect(decoyTime).toBeGreaterThan(real / 5);
    expect(decoyTime).toBeLessThan(real * 5);
  }, 30_000);
});
