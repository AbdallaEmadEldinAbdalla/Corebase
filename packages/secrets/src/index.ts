import type { Pool, PoolClient } from 'pg';
import { generateSecret, type Envelope, type SealedSecret } from '@corebase/crypto';

/**
 * Persistence for project credentials (D-035). The control plane stores
 * ciphertext; the KEK lives in a file outside the database, so a dump of this
 * table is inert.
 *
 * The ordering rule this module exists to enforce: a credential is written to
 * the control plane BEFORE it is applied to the project database. A crash
 * between the two leaves a stored password that is not yet in effect, which the
 * next attempt fixes by applying it again. The reverse order loses the password
 * outright — the database has a credential nobody can name.
 */

/** Names are UPPER_SNAKE per the project_secrets CHECK constraint. */
export const SECRET_NAMES = {
  postgres: 'POSTGRES_PASSWORD',
  developer: 'DEVELOPER_PASSWORD',
  authenticator: 'AUTHENTICATOR_PASSWORD',
  /**
   * The pooler's own login credential (D-074). The *only* secret material the
   * pooler container holds, and it resolves nothing by itself — the lookup
   * function it is allowed to call returns `developer` and nothing else.
   */
  poolerAuth: 'PGBOUNCER_AUTH_PASSWORD',
  /** The project's ES256 signing key (D-014). Never leaves the control plane. */
  jwtPrivateKey: 'JWT_PRIVATE_KEY',
  /** Public half. Stored beside its pair so JWKS is one lookup, not two. */
  jwtPublicKey: 'JWT_PUBLIC_KEY',
  /** The kid, so a rotation is legible without parsing a PEM. */
  jwtKid: 'JWT_KID',
  /**
   * The minted keys themselves, envelope-encrypted (D-214).
   *
   * D-107 asked for these to be re-derived deterministically on demand so a
   * reveal is byte-identical. Deterministic ECDSA means RFC 6979, which Node does
   * not expose and which is the last thing to hand-roll — a bad nonce leaks the
   * private key. Storing the minted JWT under the same envelope encryption the
   * DB password already uses (D-035: "the plaintext exists in the control plane
   * solely to render connection strings") gets the same property with a mechanism
   * the corpus already trusts.
   */
  anonKey: 'ANON_KEY',
  serviceRoleKey: 'SERVICE_ROLE_KEY',
} as const;

export type SecretName = (typeof SECRET_NAMES)[keyof typeof SECRET_NAMES];

export interface SecretStore {
  /** Existing active secret, or undefined. */
  get(projectId: string, name: string): Promise<string | undefined>;
  /**
   * Store a value we generated ourselves rather than a random secret — a keypair,
   * a minted JWT. Idempotent: a retry keeps the first value, because the second
   * would be a different key with the same name.
   */
  put(projectId: string, name: string, value: string): Promise<void>;
  /**
   * The active secret for `name`, generating and persisting one if absent.
   * Concurrent callers converge on a single value — the partial unique index on
   * (project_id, name) WHERE state='active' is the arbiter, not application luck.
   */
  ensure(projectId: string, name: string): Promise<{ value: string; created: boolean }>;
}

interface SecretRow { version: number; ciphertext: Buffer; dek_wrapped: Buffer; kek_id: string }

export function createSecretStore(pool: Pool, envelope: Envelope): SecretStore {
  const read = async (
    q: Pool | PoolClient, projectId: string, name: string,
  ): Promise<{ version: number; sealed: SealedSecret } | undefined> => {
    const { rows } = await q.query<SecretRow>(
      `SELECT version, ciphertext, dek_wrapped, kek_id
         FROM project_secrets
        WHERE project_id = $1 AND name = $2 AND state = 'active'`,
      [projectId, name]);
    const r = rows[0];
    if (!r) return undefined;
    return {
      version: r.version,
      sealed: { ciphertext: r.ciphertext, dekWrapped: r.dek_wrapped, kekId: r.kek_id },
    };
  };

  return {
    async get(projectId, name) {
      const row = await read(pool, projectId, name);
      if (!row) return undefined;
      return envelope.decrypt(row.sealed, { projectId, name, version: row.version });
    },

    async put(projectId, name, value) {
      const version = 1;
      const sealed = envelope.encrypt(value, { projectId, name, version });
      await pool.query(
        `INSERT INTO project_secrets (project_id, name, version, ciphertext, dek_wrapped, kek_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id, name, version) DO NOTHING`,
        [projectId, name, version, sealed.ciphertext, sealed.dekWrapped, sealed.kekId]);
    },

    async ensure(projectId, name) {
      const existing = await read(pool, projectId, name);
      if (existing) {
        return {
          value: envelope.decrypt(existing.sealed, { projectId, name, version: existing.version }),
          created: false,
        };
      }

      const value = generateSecret();
      const version = 1;
      const sealed = envelope.encrypt(value, { projectId, name, version });
      const { rowCount } = await pool.query(
        `INSERT INTO project_secrets (project_id, name, version, ciphertext, dek_wrapped, kek_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [projectId, name, version, sealed.ciphertext, sealed.dekWrapped, sealed.kekId]);

      if (rowCount === 0) {
        // Another worker inserted between our read and our write. Its value is
        // the one that exists, so ours is discarded — never overwritten, or the
        // password in the database and the password in the table diverge.
        const winner = await read(pool, projectId, name);
        if (!winner) throw new Error(`secret ${name} vanished during a concurrent insert`);
        return {
          value: envelope.decrypt(winner.sealed, { projectId, name, version: winner.version }),
          created: false,
        };
      }
      return { value, created: true };
    },
  };
}
