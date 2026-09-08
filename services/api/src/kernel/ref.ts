import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC 4648 base32, lowercased
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Project ref: 20 chars of base32 (~100 bits), first char alphabetic so the ref
 * is always a legal DNS label for <ref>.steadhold.app (D-056). Never reused.
 */
export function generateProjectRef(): string {
  const bytes = randomBytes(20);
  let out = LETTERS[bytes[0]! % LETTERS.length]!;
  for (let i = 1; i < 20; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]!;
  return out;
}
