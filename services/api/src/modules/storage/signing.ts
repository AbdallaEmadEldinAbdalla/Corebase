import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SecretStore } from '@steadhold/secrets';
import { SECRET_NAMES } from '@steadhold/secrets';

/**
 * Signed URLs (P6d, storage API §3).
 *
 * ## Ours, not the object store's
 *
 * These are Steadhold-HMAC tokens verified by this service, **not** presigned
 * store URLs. Three reasons, and each one is load-bearing:
 *
 * 1. They work through `<ref>.steadhold.app`, so a customer's links do not point
 *    at a third party's hostname.
 * 2. They survive rotation of the store credential — a presigned URL is signed
 *    *with* that credential and dies the moment it rotates, which would make
 *    credential hygiene a customer-visible outage.
 * 3. They never expose the physical key layout, so `projects/<ref>/…` stays an
 *    implementation detail rather than something in every shared link.
 *
 * Presigned *upload* URLs (P6e) are the one place raw store presigning appears,
 * because there the client really must talk to the store directly.
 *
 * ## The key, and why it is derived rather than reused
 *
 * The project's JWT keypair is asymmetric (ES256) and these tokens want a cheap
 * symmetric verifier held only by this service. So the key is derived from a
 * per-project master secret:
 *
 *     storage_signing_key = HKDF-SHA256(ikm = master, info = "steadhold/storage/v1", salt = kid)
 *
 * Deriving rather than storing a second key means rotation is a new `kid` — a
 * one-word change — and the blast radius stays per project, which is the same
 * argument that made the JWT keypair per project.
 *
 * ## Revocability, stated honestly
 *
 * A signed URL is a bearer capability and **is not revocable before `exp`**
 * short of rotating the project's storage `kid`, which invalidates every
 * outstanding URL for that project at once. There is no per-URL kill switch: a
 * denylist check would add a database or Redis hop to the hottest read path.
 * Hence the default of one hour and the hard ceiling of seven days — and the
 * documented advice that revocable access means a private bucket and an
 * RLS-checked endpoint, not a shorter signature.
 */

/** The doc's default and hard maximum. Seven days is the ceiling, not a target. */
export const DEFAULT_EXPIRY_SECONDS = 3600;
export const MAX_EXPIRY_SECONDS = 604_800;

/** The current derivation label. Bumping it invalidates every token at once. */
const HKDF_INFO = 'steadhold/storage/v1';

/**
 * The `kid` new tokens are signed under.
 *
 * A constant today and deliberately not hard-coded at the call sites: rotation
 * is meant to be a change to this value plus an entry in the accepted set, not a
 * hunt through the module.
 */
export const CURRENT_KID = 'v1';

/**
 * Which `kid`s a presented token may claim.
 *
 * During a rotation this holds two: the new one, and the outgoing one for as long
 * as a token signed under it could still be unexpired (≤ 7 days). A token naming
 * anything else is refused without deriving a key for it — otherwise an attacker
 * chooses the salt, and a chosen salt is a chosen key.
 */
export const ACCEPTED_KIDS: readonly string[] = [CURRENT_KID];

export interface SignedPayload {
  /** Which project. Present so a token cannot travel between projects. */
  ref: string;
  bucket: string;
  /** The object path, exactly as stored. */
  path: string;
  /** Unix seconds. */
  exp: number;
  kid: string;
  /** For signed *uploads* (P6e): the shape the URL is good for, and nothing else. */
  ct?: string;
  max?: number;
}

const b64url = (b: Buffer): string => b.toString('base64url');

/**
 * The per-project master secret, created on first use.
 *
 * Created lazily rather than only at provisioning, because projects provisioned
 * before this existed must not be permanently unable to sign URLs. That is safe
 * under concurrency for a specific reason: `put` is `ON CONFLICT DO NOTHING`, so
 * two requests racing to create it do not produce two secrets — the first writer
 * wins and the loser reads the winner's value back. Using `replace` here would
 * be the bug: it would overwrite, and every URL signed a moment earlier would
 * stop verifying.
 */
export async function masterSecret(
  secrets: SecretStore, projectId: string,
): Promise<Buffer> {
  const existing = await secrets.get(projectId, SECRET_NAMES.storageSigningSecret);
  if (existing) return Buffer.from(existing, 'base64');
  const fresh = randomBytes(32).toString('base64');
  await secrets.put(projectId, SECRET_NAMES.storageSigningSecret, fresh);
  // Read back rather than returning `fresh`: under a race the value that was
  // actually stored is the other request's, and signing with a secret nobody
  // kept would produce URLs that verify nowhere.
  const stored = await secrets.get(projectId, SECRET_NAMES.storageSigningSecret);
  if (!stored) throw new Error('the storage signing secret could not be stored');
  return Buffer.from(stored, 'base64');
}

/** HKDF-SHA256, salted by the kid. */
export function deriveKey(master: Buffer, kid: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(kid, 'utf8'), HKDF_INFO, 32));
}

/**
 * `base64url(payload).base64url(HMAC)`, the compact JWS-style encoding.
 *
 * Deliberately not a JWT: there is no `alg` header to confuse, no negotiation,
 * and therefore none of the algorithm substitution that makes JWT verification
 * subtle. The one algorithm is HMAC-SHA256 and it is not stated in the token,
 * so it cannot be talked down.
 */
export function signToken(master: Buffer, payload: SignedPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const key = deriveKey(master, payload.kid);
  const mac = createHmac('sha256', key).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

export type VerifyFailure =
  | 'malformed'
  | 'unknown_kid'
  | 'bad_signature'
  | 'expired'
  | 'wrong_target';

export interface VerifyResult {
  ok: boolean;
  payload?: SignedPayload;
  failure?: VerifyFailure;
}

/**
 * Verify a token against the target it is being presented for.
 *
 * The target check is the point, and it is why `verify` takes the ref, bucket and
 * path rather than returning the payload for a caller to compare. A signature
 * proves the token is ours; only comparing it against *this* request proves it is
 * for this object. ST-2 in the isolation matrix is exactly the attack of taking a
 * valid signature and swapping the path.
 *
 * The order matters too: kid, then signature, then expiry, then target. Checking
 * the target before the signature would answer questions about *unsigned* input,
 * and checking expiry before the signature would let an attacker learn whether a
 * forged `exp` was in the past.
 */
export function verifyToken(
  master: Buffer, token: string,
  target: { ref: string; bucket: string; path: string },
  now = Math.floor(Date.now() / 1000),
): VerifyResult {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, failure: 'malformed' };
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  let payload: SignedPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
  } catch {
    return { ok: false, failure: 'malformed' };
  }
  if (typeof payload?.kid !== 'string' || !ACCEPTED_KIDS.includes(payload.kid)) {
    // Refused before deriving anything. The kid is the HKDF salt, so honouring
    // an arbitrary one lets the attacker choose the key.
    return { ok: false, failure: 'unknown_kid' };
  }

  const expected = createHmac('sha256', deriveKey(master, payload.kid))
    .update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return { ok: false, failure: 'malformed' };
  }
  // Constant-time, and length-checked first because `timingSafeEqual` throws on
  // a length mismatch rather than returning false.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, failure: 'bad_signature' };
  }

  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return { ok: false, failure: 'expired' };
  }
  if (payload.ref !== target.ref || payload.bucket !== target.bucket
      || payload.path !== target.path) {
    return { ok: false, failure: 'wrong_target' };
  }
  return { ok: true, payload };
}

/** Clamp a requested lifetime to the documented window. */
export function clampExpiry(requested: unknown): number {
  const n = Number(requested ?? DEFAULT_EXPIRY_SECONDS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EXPIRY_SECONDS;
  return Math.min(Math.floor(n), MAX_EXPIRY_SECONDS);
}
