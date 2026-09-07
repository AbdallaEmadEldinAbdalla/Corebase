import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  signToken, verifyToken, deriveKey, clampExpiry,
  CURRENT_KID, DEFAULT_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS,
} from './signing.ts';

/**
 * P6d — the signed-URL token, which is a bearer credential.
 *
 * Unit-tested exhaustively because every one of these cases is an attack that
 * costs nothing to attempt: the token travels in a URL, so it is logged,
 * bookmarked, pasted into chat and retried after expiry. The e2e suite proves the
 * endpoints; this proves the algorithm.
 */
const master = randomBytes(32);
const target = { ref: 'abc12345', bucket: 'files', path: 'a/b.png' };
const future = Math.floor(Date.now() / 1000) + 600;

const mint = (over: Partial<Parameters<typeof signToken>[1]> = {}) =>
  signToken(master, {
    ref: target.ref, bucket: target.bucket, path: target.path,
    exp: future, kid: CURRENT_KID, ...over,
  });

describe('P6d — a token verifies only for what it was signed for', () => {
  it('accepts its own target', () => {
    const res = verifyToken(master, mint(), target);
    expect(res.ok).toBe(true);
    expect(res.payload?.path).toBe('a/b.png');
  });

  it('refuses a swapped object path — the ST-2 attack', () => {
    // A valid signature for one object, presented for another. This is the whole
    // reason `verifyToken` takes the target instead of handing the payload back
    // for a caller to compare: a signature proves the token is ours, and only
    // this comparison proves it is for this object.
    const res = verifyToken(master, mint(), { ...target, path: 'a/secret.png' });
    expect(res.ok).toBe(false);
    expect(res.failure).toBe('wrong_target');
  });

  it('refuses a swapped bucket, and a swapped project', () => {
    expect(verifyToken(master, mint(), { ...target, bucket: 'other' }).failure)
      .toBe('wrong_target');
    // The cross-tenant case. Even holding a genuine token, the ref is signed, so
    // it cannot be replayed at a neighbour — and their master secret differs
    // anyway, which is the second, independent reason.
    expect(verifyToken(master, mint(), { ...target, ref: 'zzz99999' }).failure)
      .toBe('wrong_target');
  });

  it('refuses a token another project signed', () => {
    const neighbour = randomBytes(32);
    const theirs = signToken(neighbour, {
      ref: target.ref, bucket: target.bucket, path: target.path,
      exp: future, kid: CURRENT_KID,
    });
    // Note it fails on the *signature*, not the target: the payload names our
    // project because the attacker wrote it that way, and the key is what
    // catches it. Per-project derivation is doing the work here.
    expect(verifyToken(master, theirs, target).failure).toBe('bad_signature');
  });
});

describe('P6d — tampering', () => {
  it('refuses an edited payload', () => {
    const token = mint();
    const [body, mac] = token.split('.');
    const edited = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as
      Record<string, unknown>;
    edited['path'] = 'a/secret.png';
    const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${mac}`;
    expect(verifyToken(master, forged, { ...target, path: 'a/secret.png' }).failure)
      .toBe('bad_signature');
  });

  it('refuses an edited expiry', () => {
    const token = mint({ exp: Math.floor(Date.now() / 1000) - 10 });
    const [body, mac] = token.split('.');
    const edited = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as
      Record<string, unknown>;
    edited['exp'] = future;
    const forged = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${mac}`;
    expect(verifyToken(master, forged, target).failure).toBe('bad_signature');
  });

  it('refuses a token whose kid we do not accept, without deriving a key for it', () => {
    // The kid is the HKDF salt. Honouring an arbitrary one lets the attacker
    // choose the key, which is the whole game — so an unknown kid is refused
    // before any derivation happens.
    const forged = signToken(master, {
      ref: target.ref, bucket: target.bucket, path: target.path,
      exp: future, kid: 'attacker-chosen',
    });
    expect(verifyToken(master, forged, target).failure).toBe('unknown_kid');
  });

  it('refuses garbage without throwing', () => {
    // These arrive from URLs, so they will be truncated, re-encoded and mangled
    // by every intermediary. A verifier that threw on malformed input would turn
    // a bad link into a 500.
    for (const bad of ['', '.', 'a.', '.b', 'notbase64!!.x', 'a.b.c',
                       Buffer.from('{}').toString('base64url') + '.zz']) {
      const res = verifyToken(master, bad, target);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      expect(res.failure).toBeTruthy();
    }
  });

  it('refuses a signature of the wrong length rather than throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, so the length is checked
    // first. Without that, a one-byte signature is a 500 instead of a 403.
    const [body] = mint().split('.');
    const short = `${body}.${Buffer.from([1, 2, 3]).toString('base64url')}`;
    expect(verifyToken(master, short, target).failure).toBe('bad_signature');
  });
});

describe('P6d — expiry', () => {
  it('refuses a token past its exp', () => {
    const token = signToken(master, {
      ref: target.ref, bucket: target.bucket, path: target.path,
      exp: Math.floor(Date.now() / 1000) - 1, kid: CURRENT_KID,
    });
    expect(verifyToken(master, token, target).failure).toBe('expired');
  });

  it('treats exp as exclusive, so a token does not outlive its own second', () => {
    const now = 1_700_000_000;
    const token = signToken(master, {
      ref: target.ref, bucket: target.bucket, path: target.path, exp: now, kid: CURRENT_KID,
    });
    expect(verifyToken(master, token, target, now).failure).toBe('expired');
    expect(verifyToken(master, token, target, now - 1).ok).toBe(true);
  });

  it('clamps a requested lifetime to the documented window', () => {
    expect(clampExpiry(undefined)).toBe(DEFAULT_EXPIRY_SECONDS);
    expect(clampExpiry(60)).toBe(60);
    expect(clampExpiry(MAX_EXPIRY_SECONDS * 10)).toBe(MAX_EXPIRY_SECONDS);
    // Nonsense falls back to the default rather than erroring: a client sending
    // `expires_in: "soon"` gets a working one-hour URL, not a 400 they have to
    // read the docs to understand.
    for (const junk of [0, -5, 'soon', null, NaN, Infinity]) {
      expect(clampExpiry(junk), String(junk)).toBe(DEFAULT_EXPIRY_SECONDS);
    }
  });
});

describe('P6d — key derivation', () => {
  it('gives a different key per kid and per project', () => {
    const other = randomBytes(32);
    expect(deriveKey(master, 'v1').equals(deriveKey(master, 'v2'))).toBe(false);
    expect(deriveKey(master, 'v1').equals(deriveKey(other, 'v1'))).toBe(false);
    // Deterministic, or a restarted service would stop honouring live URLs.
    expect(deriveKey(master, 'v1').equals(deriveKey(master, 'v1'))).toBe(true);
  });

  it('never uses the master secret directly', () => {
    // The derived key must not be the master. Trivially true of HKDF, asserted
    // because the whole rotation story depends on the two being separable.
    expect(deriveKey(master, CURRENT_KID).equals(master)).toBe(false);
  });
});
