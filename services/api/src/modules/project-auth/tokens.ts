import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sign as signJwt, type Claims } from '@corebase/jwt';
import type { ProjectContext } from './context.ts';

/**
 * Access tokens and refresh tokens for a project's end users (P4b, D-014).
 *
 * The claim set is [sessions & tokens](../../../../../docs/05-auth/02-sessions-and-tokens.md)'s,
 * exactly. It is not a place to improvise: PostgREST enforces `aud` and `iss`,
 * `role` maps to a Postgres role of the same name (D-029), and `sub` is what
 * `auth.uid()` reads for every RLS policy a customer writes. A claim renamed here
 * is every policy in the fleet silently matching nothing.
 */

/** Default access-token life. Per-project configurable 300–86400 s. */
export const ACCESS_TTL_SECONDS_DEFAULT = 3600;
export const ACCESS_TTL_MIN = 300;
export const ACCESS_TTL_MAX = 86_400;

/**
 * `cb_rt_` prefix, and it is not decoration: prefixes make a leaked token
 * greppable by secret scanners, which is the difference between finding one in a
 * public repository and not.
 */
export const REFRESH_PREFIX = 'cb_rt_';
const REFRESH_BYTES = 32;   // 256 bits from a CSPRNG

export interface AccessTokenArgs {
  ctx: ProjectContext;
  userId: string;
  email: string | null;
  sessionId: string;
  ttlSeconds?: number;
  now?: number;
}

export function mintAccessToken(a: AccessTokenArgs): { token: string; expiresIn: number } {
  const iat = a.now ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(ACCESS_TTL_MAX, Math.max(ACCESS_TTL_MIN,
    a.ttlSeconds ?? ACCESS_TTL_SECONDS_DEFAULT));
  const claims: Claims = {
    iss: a.ctx.issuer,
    ref: a.ctx.ref,
    sub: a.userId,
    aud: 'authenticated',
    // Never `anon` or `service_role`: those belong to API keys. A user token
    // carrying `service_role` would be a user with RLS bypassed.
    role: 'authenticated',
    ...(a.email ? { email: a.email } : {}),
    // Constant across refreshes, which is what makes a session revocable at all:
    // it is the only thing tying a stateless JWT to a row somebody can revoke.
    session_id: a.sessionId,
    iat,
    exp: iat + ttl,
  };
  // `user_metadata` is deliberately absent. It is user-writable (PUT /user), so
  // putting it in a signed token invites policies to trust it — and the doc's
  // "JWT bloat" note makes it opt-in and size-capped for that reason.
  return {
    token: signJwt(claims, {
      privateKeyPem: a.ctx.signing.privateKeyPem, kid: a.ctx.signing.kid }),
    expiresIn: ttl,
  };
}

/** A fresh opaque refresh token and the hash that is all the database ever sees. */
export function newRefreshToken(): { token: string; hash: Buffer } {
  const token = REFRESH_PREFIX + randomBytes(REFRESH_BYTES).toString('base64url');
  return { token, hash: refreshHash(token) };
}

/**
 * sha256 of the token. The plaintext is never stored, so a dump of
 * `auth.refresh_tokens` is not a set of usable credentials — the difference
 * between a leaked database and a leaked session for every user of the app.
 */
export const refreshHash = (token: string): Buffer =>
  createHash('sha256').update(token, 'utf8').digest();

/** Constant-time compare, for the rare path that compares two hashes in process. */
export function hashEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Does this look like one of ours at all? Cheap reject before any database work. */
export const looksLikeRefreshToken = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith(REFRESH_PREFIX) && v.length > REFRESH_PREFIX.length + 20;

// ── one-time tokens (P4c) ───────────────────────────────────────────────────

/**
 * A one-time token as it appears in a link, and the hash the database stores.
 *
 * No prefix, unlike a refresh token: this value travels in a URL, and 32 bytes of
 * base64url is already 43 characters of query string. It is also short-lived and
 * single-use, so the secret-scanner argument that justifies `cb_rt_` buys much
 * less here.
 *
 * 32 bytes from a CSPRNG, which is the same strength as the refresh token,
 * because this *is* a credential — clicking the link produces a session with no
 * second factor. A shorter token would be the weakest link in the whole flow.
 */
export function newOneTimeToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: refreshHash(token) };
}

/**
 * Hash a token that arrived from a client.
 *
 * The same sha256 as `refreshHash`, and sharing it is deliberate rather than
 * lazy: one hash function for every opaque token means a token can never be
 * stored under one digest and looked up under another, which is a bug that
 * presents as "valid links don't work" and resists every obvious diagnosis.
 *
 * Not scrypt, and worth saying why: these tokens are 256 bits of CSPRNG output,
 * so there is no dictionary to attack and no work factor to buy. The reason to
 * hash at all is that a database dump must not be a bag of live links.
 */
export const oneTimeHash = refreshHash;
