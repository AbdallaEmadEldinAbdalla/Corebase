import { randomBytes, createHash } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * Personal access tokens (D-062): `Authorization: Bearer cbp_<40 chars>` for the
 * CLI and CI.
 *
 * Hash-only, per D-060 — the same rule as project API keys. The token is returned
 * exactly once, at creation; after that the control plane holds a SHA-256 and a
 * display prefix, so a database read compromise yields nothing usable.
 *
 * SHA-256 and not scrypt, deliberately, and the difference from a password
 * matters: a PAT is 30 bytes of CSPRNG, so there is no dictionary to attack and
 * no offline advantage to slow down. A KDF here would only mean a 100 ms
 * memory-hard hash on *every authenticated request*, which is a self-inflicted
 * rate limit.
 */

export const TOKEN_PREFIX = 'cbp_';
const TOKEN_BYTES = 30;                       // → 40 base64url characters
/** `cbp_` + 8 characters: enough to identify, useless to authenticate with. */
const DISPLAY_CHARS = 8;

export interface IssuedToken {
  /** The only time this value exists outside the client. */
  token: string;
  id: string;
  prefix: string;
}

export interface TokenRecord {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export const hashToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export function createTokenStore(pool: Pool) {
  return {
    async issue(args: {
      userId: string; name: string; scopes?: string[]; expiresAt?: Date | null;
    }): Promise<IssuedToken> {
      const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
      const prefix = token.slice(0, TOKEN_PREFIX.length + DISPLAY_CHARS);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO user_access_tokens (user_id, name, token_hash, token_prefix, scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6)
         RETURNING id`,
        [args.userId, args.name, hashToken(token), prefix,
         args.scopes ?? [], args.expiresAt ?? null]);
      return { token, id: rows[0]!.id, prefix };
    },

    /**
     * Resolve a token to its user, or undefined.
     *
     * `last_used_at` is updated in the same statement as the lookup, so a live
     * token cannot be read without leaving a trace — which is what makes "which
     * of my tokens is still in use" answerable, and a stolen token visible.
     */
    async resolve(token: string): Promise<{ userId: string; tokenId: string; scopes: string[] } | undefined> {
      if (!token.startsWith(TOKEN_PREFIX)) return undefined;
      const { rows } = await pool.query<{ id: string; user_id: string; scopes: string[] }>(
        `UPDATE user_access_tokens t
            SET last_used_at = now()
          WHERE t.token_hash = $1
            AND t.revoked_at IS NULL
            AND (t.expires_at IS NULL OR t.expires_at > now())
            AND NOT EXISTS (
                  SELECT 1 FROM users u WHERE u.id = t.user_id AND u.disabled_at IS NOT NULL)
        RETURNING t.id, t.user_id, t.scopes`,
        [hashToken(token)]);
      const row = rows[0];
      return row ? { userId: row.user_id, tokenId: row.id, scopes: row.scopes } : undefined;
    },

    async list(userId: string): Promise<TokenRecord[]> {
      const { rows } = await pool.query<TokenRecord>(
        `SELECT id, user_id, name, token_prefix, scopes,
                to_char(expires_at,   'YYYY-MM-DD"T"HH24:MI:SS.MSZ') AS expires_at,
                to_char(last_used_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') AS last_used_at,
                to_char(created_at,   'YYYY-MM-DD"T"HH24:MI:SS.MSZ') AS created_at
           FROM user_access_tokens
          WHERE user_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC`, [userId]);
      return rows;
    },

    /**
     * Revoke, scoped to the owner. Revoking rather than deleting keeps the row
     * for the audit trail — "this token existed and was used until Tuesday" is
     * the fact an incident review needs, and a deleted row cannot say it.
     */
    async revoke(userId: string, tokenId: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `UPDATE user_access_tokens SET revoked_at = now()
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [tokenId, userId]);
      return (rowCount ?? 0) > 0;
    },
  };
}

export type TokenStore = ReturnType<typeof createTokenStore>;
