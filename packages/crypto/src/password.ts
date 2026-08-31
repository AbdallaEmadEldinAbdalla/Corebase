import { scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing for platform accounts.
 *
 * **scrypt, not argon2id (D-211).** The platform-security doc specifies argon2id,
 * which is the better algorithm and needs a native module — a compiled dependency
 * in every image that touches a login, plus its build and supply chain. scrypt is
 * memory-hard, has been in Node's standard library for years, and is on OWASP's
 * list of acceptable choices. The gap between the two is small; the gap between
 * "in the standard library" and "native build in every image" is not. Trigger to
 * revisit is in the decision.
 *
 * What matters more than the choice: **the parameters live in the hash**. Raising
 * the cost later must not invalidate every existing password, and a format that
 * hard-codes its own cost forces exactly that.
 */

/** Format: `scrypt$N$r$p$salt$key`, all base64url. Self-describing on purpose. */
const ALGORITHM = 'scrypt';
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/**
 * N=2^16, r=8, p=2 → 64 MiB and roughly double the CPU of p=1.
 *
 * OWASP's floor for scrypt is N=2^17, r=8, p=1, which is 128 MiB *per concurrent
 * hash*. On a control plane that also holds a Postgres connection pool, a handful
 * of simultaneous logins at that setting is a memory spike with a real chance of
 * becoming an outage — and an outage is a worse security outcome than a slightly
 * cheaper KDF. Halving memory and doubling p keeps the work comparable at half
 * the peak. `maxmem` has to be set explicitly because Node's default 32 MiB
 * refuses these parameters outright.
 */
export const SCRYPT_PARAMS = { N: 65_536, r: 8, p: 2 } as const;
const MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;   // headroom over the exact need

export class PasswordFormatError extends Error {}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

/** Minimum length only. Composition rules push users toward `Passw0rd!`. */
export const MIN_PASSWORD_LENGTH = 12;
/** scrypt hashes its input, so long passwords are cheap — but not unbounded. */
export const MAX_PASSWORD_LENGTH = 1024;

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordFormatError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    // A 10 MB "password" is a denial-of-service dressed as a credential.
    throw new PasswordFormatError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(normalize(password), salt, KEY_BYTES, { ...SCRYPT_PARAMS, maxmem: MAXMEM });
  const { N, r, p } = SCRYPT_PARAMS;
  return `${ALGORITHM}$${N}$${r}$${p}$${b64(salt)}$${b64(key)}`;
}

/**
 * NFKC, so a password typed on one keyboard verifies on another. Without it a
 * user who set their password with a composed accent cannot log in from a system
 * that decomposes it, and the failure is indistinguishable from a typo.
 */
const normalize = (password: string) => password.normalize('NFKC');

interface ParsedHash { N: number; r: number; p: number; salt: Buffer; key: Buffer }

function parse(stored: string): ParsedHash {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    throw new PasswordFormatError('stored password is not a scrypt hash in the expected format');
  }
  const [, N, r, p, salt, key] = parts;
  const parsed = { N: Number(N), r: Number(r), p: Number(p), salt: unb64(salt!), key: unb64(key!) };
  if (!Number.isInteger(parsed.N) || !Number.isInteger(parsed.r) || !Number.isInteger(parsed.p)
      || parsed.N < 1024 || parsed.r < 1 || parsed.p < 1) {
    throw new PasswordFormatError('stored password has implausible scrypt parameters');
  }
  return parsed;
}

export interface VerifyResult {
  ok: boolean;
  /**
   * True when the hash was made with weaker parameters than the current ones, so
   * the caller can re-hash on a successful login. Passwords silently stay at the
   * cost they were created with otherwise, and raising the default achieves
   * nothing for existing users.
   */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const { N, r, p, salt, key } = parse(stored);
  const derived = await scrypt(normalize(password), salt, key.length, {
    N, r, p, maxmem: Math.max(MAXMEM, 128 * N * r * 2),
  });
  // Constant-time: a comparison that returns early leaks how much of the hash
  // matched, which is enough to reconstruct it a byte at a time.
  const ok = derived.length === key.length && timingSafeEqual(derived, key);
  const weaker = N < SCRYPT_PARAMS.N || r < SCRYPT_PARAMS.r || p < SCRYPT_PARAMS.p;
  return { ok, needsRehash: ok && weaker };
}

/**
 * A hash of nothing, for the login path to verify against when the email is
 * unknown.
 *
 * Without it, "no such user" returns in a millisecond and "wrong password" takes
 * 100ms, and the difference is a free user-enumeration oracle — the same reason
 * both cases must return the same error. Computed once at startup rather than per
 * request, because the cost being paid is the *verify*, not the hash.
 */
let decoy: string | undefined;

export async function decoyHash(): Promise<string> {
  decoy ??= await hashPassword(randomBytes(32).toString('base64url'));
  return decoy;
}

/** Verify against the decoy, to spend the same time as a real failure. */
export async function burnVerify(password: string): Promise<void> {
  await verifyPassword(password, await decoyHash()).catch(() => undefined);
}
