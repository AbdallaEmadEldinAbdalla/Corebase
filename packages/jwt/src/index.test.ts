import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  generateKeypair, sign, verify, decodeUnverified, toJwk, newKid,
  projectKeyClaims, PROJECT_KEY_TTL_SECONDS, ALG, JwtError,
} from './index.ts';

const key = generateKeypair();
const claims = projectKeyClaims({ ref: 'kxqwrtplmzensfba2345', role: 'anon', issuer: 'https://steadhold.app' });

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

describe('signing and verifying', () => {
  it('round-trips', () => {
    const token = sign(claims, key);
    expect(verify(token, { publicKeyPem: key.publicKeyPem }).ref).toBe(claims.ref);
  });

  it('emits three parts and a 64-byte signature', () => {
    // P-256 R‖S is exactly 64 bytes. Node's default DER encoding is variable
    // length and every JOSE verifier rejects it.
    const [h, p, s] = sign(claims, key).split('.');
    expect(h && p && s).toBeTruthy();
    expect(Buffer.from(s!, 'base64url')).toHaveLength(64);
  });

  it('puts alg and kid in the header', () => {
    const { header } = decodeUnverified(sign(claims, key));
    expect(header.alg).toBe(ALG);
    expect(header.kid).toBe(key.kid);
    expect(header.typ).toBe('JWT');
  });

  it('refuses a token signed by a different keypair', () => {
    const other = generateKeypair();
    expect(() => verify(sign(claims, other), { publicKeyPem: key.publicKeyPem }))
      .toThrow(/signature does not verify/);
  });

  it('refuses a tampered payload', () => {
    const [h, , s] = sign(claims, key).split('.');
    const forged = `${h}.${b64u({ ...claims, role: 'service_role' })}.${s}`;
    expect(() => verify(forged, { publicKeyPem: key.publicKeyPem }))
      .toThrow(/signature does not verify/);
  });
});

describe('algorithm confusion is closed', () => {
  /**
   * The classic JWT break, and the reason this module supports one algorithm and
   * negotiates nothing: a verifier that reads `alg` from the token to decide how
   * to check it can be told not to check at all.
   */
  it('refuses alg: none', () => {
    const token = `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u(claims)}.`;
    expect(() => verify(token, { publicKeyPem: key.publicKeyPem }))
      .toThrow(/unsupported alg "none"/);
  });

  it('refuses HS256 signed with the public key as an HMAC secret', () => {
    // The textbook attack: the "public" key is known, so an attacker uses it as a
    // shared secret and hopes the verifier switches to symmetric mode.
    const header = b64u({ alg: 'HS256', typ: 'JWT', kid: key.kid });
    const payload = b64u(claims);
    const mac = createHmac('sha256', key.publicKeyPem).update(`${header}.${payload}`).digest('base64url');
    expect(() => verify(`${header}.${payload}.${mac}`, { publicKeyPem: key.publicKeyPem }))
      .toThrow(/unsupported alg "HS256"/);
  });

  it('refuses ES384 and RS256 too, not just the famous two', () => {
    for (const alg of ['ES384', 'ES512', 'RS256', 'PS256', 'EdDSA']) {
      const token = `${b64u({ alg, typ: 'JWT' })}.${b64u(claims)}.${'A'.repeat(86)}`;
      expect(() => verify(token, { publicKeyPem: key.publicKeyPem }), alg)
        .toThrow(/unsupported alg/);
    }
  });

  it('refuses a DER-encoded signature', () => {
    // A verifier that accepts both encodings accepts signatures it cannot pin
    // down; a fixed 64 bytes is also a cheap truncation check.
    const token = sign(claims, key);
    const [h, p] = token.split('.');
    const der = Buffer.from('3045022012340220abcd', 'hex').toString('base64url');
    expect(() => verify(`${h}.${p}.${der}`, { publicKeyPem: key.publicKeyPem }))
      .toThrow(/64-byte P-256/);
  });

  it('refuses a malformed token rather than treating it as unsigned', () => {
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', '....']) {
      expect(() => verify(bad, { publicKeyPem: key.publicKeyPem }), bad).toThrow(JwtError);
    }
  });
});

describe('claims', () => {
  it('rejects an expired token, with tolerance for skew', () => {
    const past = { ...claims, iat: 1000, exp: 2000 };
    expect(() => verify(sign(past, key), { publicKeyPem: key.publicKeyPem }))
      .toThrow(/expired/);
    // Inside the tolerance window it still verifies, because a verifier stricter
    // than the clock is a verifier that fails at midnight.
    const now = () => 2030 * 1000;
    expect(verify(sign(past, key), {
      publicKeyPem: key.publicKeyPem, now, clockToleranceSeconds: 60,
    }).exp).toBe(2000);
  });

  it('rejects a token from the future', () => {
    const ahead = { ...claims, iat: Math.floor(Date.now() / 1000) + 3600 };
    expect(() => verify(sign(ahead, key), { publicKeyPem: key.publicKeyPem }))
      .toThrow(/not valid yet/);
  });

  it('rejects the wrong issuer and the wrong kid', () => {
    const token = sign(claims, key);
    expect(() => verify(token, { publicKeyPem: key.publicKeyPem, issuer: 'https://evil.example' }))
      .toThrow(/issuer/);
    expect(() => verify(token, { publicKeyPem: key.publicKeyPem, kid: 'cbk_2020_01_dead' }))
      .toThrow(/expected "cbk_2020_01_dead"/);
  });

  it('binds a project key to its project and gives it ten years', () => {
    // The `ref` claim is what the gateway cross-checks against the resolved Host,
    // so a key lifted from one project cannot be replayed against another.
    const c = projectKeyClaims({ ref: 'abcdefghijklmnop2345', role: 'service_role', issuer: 'iss' });
    expect(c.ref).toBe('abcdefghijklmnop2345');
    expect(c.role).toBe('service_role');
    expect(c.exp - c.iat).toBe(PROJECT_KEY_TTL_SECONDS);
    // No jti: these keys are configuration, and revocation is by hash.
    expect('jti' in c).toBe(false);
  });
});

describe('key ids and JWKS', () => {
  it('a kid says when it was minted', () => {
    expect(newKid(new Date('2026-08-15T00:00:00Z'))).toMatch(/^cbk_2026_08_[0-9a-f]{4}$/);
  });

  it('exports a JWK with an explicit purpose', () => {
    const jwk = toJwk(key.publicKeyPem, key.kid);
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: ALG, use: 'sig', kid: key.kid });
    expect(jwk['key_ops']).toEqual(['verify']);
    // A JWKS entry must never carry the private half.
    expect(JSON.stringify(jwk)).not.toContain('"d"');
  });

  it('refuses an unreadable public key instead of failing open', () => {
    expect(() => verify(sign(claims, key), { publicKeyPem: 'not a pem' }))
      .toThrow(/readable PEM/);
  });
});
