import {
  createPublicKey, createPrivateKey, generateKeyPairSync, randomBytes,
  sign as cryptoSign, verify as cryptoVerify, type KeyObject,
} from 'node:crypto';

/**
 * ES256 JWTs for project keys and, later, auth tokens (D-014).
 *
 * Hand-written, and the reason is the same one that makes JWT libraries a
 * recurring CVE source: **this implementation supports exactly one algorithm and
 * negotiates nothing.** Algorithm confusion — a token arriving with `alg: none`
 * or `alg: HS256` and a verifier obliging — is the classic JWT break, and it is
 * only possible in code that reads `alg` from the token to decide how to check
 * it. Here the caller says ES256 and a header claiming anything else is rejected
 * before a signature is computed.
 *
 * The one genuinely fiddly part is the signature encoding. Node's ECDSA emits
 * ASN.1 DER (a SEQUENCE of two INTEGERs, variable length); JOSE requires raw
 * R‖S, fixed at 64 bytes for P-256. `dsaEncoding: 'ieee-p1363'` asks Node for the
 * JOSE form directly, which is both correct and less code than converting.
 */

export const ALG = 'ES256';
const CURVE = 'P-256';

export class JwtError extends Error {}

const b64u = (b: Buffer | string) =>
  (Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8')).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

export interface Keypair {
  /** PKCS#8 PEM, envelope-encrypted before it touches a database (D-035). */
  privateKeyPem: string;
  /** SPKI PEM. Safe to publish; the JWKS endpoint serves its JWK form. */
  publicKeyPem: string;
  /** `shk_YYYY_MM_<4hex>` per the credentials doc. */
  kid: string;
}

/** A key id that says when it was minted, so rotation is legible in a log. */
export function newKid(now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `shk_${yyyy}_${mm}_${randomBytes(2).toString('hex')}`;
}

export function generateKeypair(kid = newKid()): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    kid,
  };
}

export interface Claims {
  iss: string;
  /** Binds the key to its project; the gateway cross-checks it against the Host. */
  ref: string;
  role: 'anon' | 'service_role' | 'authenticated';
  iat: number;
  exp: number;
  [claim: string]: unknown;
}

export function sign(claims: Claims, key: { privateKeyPem: string; kid: string }): string {
  const header = b64u(JSON.stringify({ alg: ALG, typ: 'JWT', kid: key.kid }));
  const payload = b64u(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: createPrivateKey(key.privateKeyPem),
    // JOSE wants raw R‖S; Node's default is ASN.1 DER, which every verifier
    // rejects as a malformed signature.
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64u(signature)}`;
}

export interface VerifyOptions {
  publicKeyPem: string;
  /** Rejects a token minted by a different keypair generation. */
  kid?: string;
  issuer?: string;
  /** Seconds of tolerance for clock skew. */
  clockToleranceSeconds?: number;
  now?: () => number;
}

export interface Decoded {
  header: { alg: string; typ?: string; kid?: string };
  claims: Claims;
}

/**
 * Decode without verifying — for reading a `kid` before choosing a key, and for
 * nothing else.
 *
 * Named to be hard to misuse in a review: `decodeUnverified` in a code path that
 * then trusts the claims is a bug a reader can see.
 */
export function decodeUnverified(token: string): Decoded {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('a JWT has three dot-separated parts');
  try {
    return {
      header: JSON.parse(unb64u(parts[0]!).toString('utf8')) as Decoded['header'],
      claims: JSON.parse(unb64u(parts[1]!).toString('utf8')) as Claims,
    };
  } catch {
    throw new JwtError('JWT header or payload is not valid JSON');
  }
}

export function verify(token: string, opts: VerifyOptions): Claims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('a JWT has three dot-separated parts');
  const [header64, payload64, signature64] = parts as [string, string, string];
  const { header, claims } = decodeUnverified(token);

  // Before any crypto: the algorithm is ours or the token is not ours. A verifier
  // that lets the token choose is a verifier that accepts `alg: none`.
  if (header.alg !== ALG) {
    throw new JwtError(`unsupported alg "${header.alg}" — this verifier only accepts ${ALG}`);
  }
  if (opts.kid && header.kid !== opts.kid) {
    throw new JwtError(`token was signed with kid "${header.kid}", expected "${opts.kid}"`);
  }

  const signature = unb64u(signature64);
  if (signature.length !== 64) {
    // P-256 R‖S is exactly 64 bytes. A DER signature would land here, and so
    // would a truncation attack.
    throw new JwtError('signature is not a 64-byte P-256 R‖S pair');
  }
  const ok = cryptoVerify('sha256', Buffer.from(`${header64}.${payload64}`, 'utf8'), {
    key: publicKeyOf(opts.publicKeyPem),
    dsaEncoding: 'ieee-p1363',
  }, signature);
  if (!ok) throw new JwtError('signature does not verify');

  const now = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const skew = opts.clockToleranceSeconds ?? 60;
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) {
    throw new JwtError('token has expired');
  }
  if (typeof claims.iat === 'number' && claims.iat - skew > now) {
    throw new JwtError('token is not valid yet');
  }
  if (opts.issuer && claims.iss !== opts.issuer) {
    throw new JwtError(`token issuer "${claims.iss}" is not "${opts.issuer}"`);
  }
  return claims;
}

function publicKeyOf(pem: string): KeyObject {
  try { return createPublicKey(pem); }
  catch { throw new JwtError('public key is not a readable PEM'); }
}

/**
 * The JWK form of a public key, for a per-project JWKS endpoint (D-014).
 *
 * `use` and `key_ops` are set explicitly: a JWKS entry with no stated purpose is
 * one a verifier may use for anything.
 */
export function toJwk(publicKeyPem: string, kid: string): Record<string, string | string[]> {
  const jwk = createPublicKey(publicKeyPem).export({ format: 'jwk' }) as
    { kty: string; crv: string; x: string; y: string };
  return {
    kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y,
    alg: ALG, use: 'sig', key_ops: ['verify'], kid,
  };
}

/** Ten years, per the credentials doc: these keys are configuration, not sessions. */
export const PROJECT_KEY_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export function projectKeyClaims(args: {
  ref: string; role: 'anon' | 'service_role'; issuer: string; iat?: number;
}): Claims {
  const iat = args.iat ?? Math.floor(Date.now() / 1000);
  return {
    iss: args.issuer,
    ref: args.ref,
    role: args.role,
    iat,
    exp: iat + PROJECT_KEY_TTL_SECONDS,
  };
}

/**
 * The display label for a project API key (D-218).
 *
 * A *label*, not a literal prefix: the key is a JWT, and a JWT's leading
 * characters are the base64 of its header — byte-identical for every key of every
 * project, which is why the first live run showed both of a project's keys as
 * `eyJhbGciOiJF`.
 *
 * Here because it was written out twice, in the provisioning saga and in key
 * rotation, from the same template — so a rotated key could have been labelled
 * differently from the one it replaced.
 */
export function keyLabel(role: 'anon' | 'service_role', ref: string): string {
  return `shk_${role === 'anon' ? 'anon' : 'srv'}_${ref.slice(0, 4)}`;
}
