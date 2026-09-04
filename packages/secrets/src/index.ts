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
  /**
   * The pgBackRest repo cipher-pass (P3a, backups §6).
   *
   * Its own secret rather than a derived value, and the reason is what happens on
   * rotation: rotating this one means **re-creating the repo**, because every
   * object already written is encrypted under the old pass and pgBackRest cannot
   * re-key in place. A derived secret would silently change whenever whatever it
   * was derived from changed, and the symptom would be a repo full of history
   * nobody can decrypt — discovered at restore time, which is the worst possible
   * moment to discover anything about a backup.
   *
   * Compromise of the object store alone therefore yields ciphertext, which is the
   * property this exists for.
   */
  backupCipherPass: 'BACKUP_CIPHER_PASS',
  /**
   * The auth module's password for this project's database (P4a, D-110).
   *
   * Its own credential rather than reusing `authenticator`'s, because the two
   * have opposite privileges and opposite blast radii: `authenticator` may only
   * `SET ROLE` to anon/authenticated/service_role and can read no `auth` table,
   * while this one owns every row in the `auth` schema including the password
   * hashes. Sharing one password would mean a leak of the API's connection string
   * is a leak of every user's credentials.
   */
  authRole: 'AUTH_ROLE_PASSWORD',
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
  /**
   * **Create-if-absent, not a setter.** An existing name is left untouched and
   * the call succeeds silently.
   *
   * That is the right shape for provisioning — a keypair generated once, stored
   * once, and a retried saga step that must not mint a second one — and it is a
   * trap for anything else. P4h's key rotation called it expecting a swap, got a
   * no-op, and produced a rotation in which nothing rotated: JWKS published both
   * keys, the cut-over reported success, and every token still carried the old
   * kid. Use `replace` to change a value that already exists.
   */
  put(projectId: string, name: string, value: string): Promise<void>;
  /**
   * Store a **caller-supplied** value as the new active version, demoting the
   * previous one to `retiring`.
   *
   * `rotate` for a value we did not generate: same transaction, same locking,
   * same version arithmetic — the difference is only where the bytes come from.
   * A keypair, an API key or any other secret we mint ourselves needs this and
   * cannot use `rotate`, which generates a random string.
   */
  replace(projectId: string, name: string, value: string): Promise<{
    previous: string | undefined; version: number;
  }>;
  /**
   * The active secret for `name`, generating and persisting one if absent.
   * Concurrent callers converge on a single value — the partial unique index on
   * (project_id, name) WHERE state='active' is the arbiter, not application luck.
   */
  ensure(projectId: string, name: string): Promise<{ value: string; created: boolean }>;
  /**
   * Begin a rotation: write a new version as `active`, demote the current one to
   * `retiring`, and return both values.
   *
   * Half of store-then-apply (D-035). This does the *store*; the caller applies the
   * new value to whatever holds it — `ALTER ROLE` for a database password — and the
   * order is not negotiable. Applying first and crashing before the store would
   * leave a database whose password exists nowhere, which is unrecoverable without
   * the superuser; storing first and crashing leaves a password that is not yet in
   * effect, which the retry fixes.
   *
   * The previous value comes back because that is what makes the failure legible:
   * an operator answering "which credential is my app on" needs both, and a
   * rotation that half-applied needs the old one to get back in.
   */
  rotate(projectId: string, name: string): Promise<{
    value: string; previous: string | undefined; version: number;
  }>;
  /** Drop `retiring` versions older than the retention window (§4a step 7). */
  purgeRetired(projectId: string, olderThanHours?: number): Promise<number>;
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

    async replace(projectId, name, value) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The same lock, arithmetic and ordering as `rotate` below, for the same
        // reasons: two racing replacements must not both demote one active row
        // and both claim version n+1, and the version is bound into the AAD so
        // reusing a number would make two ciphertexts claim to be the same
        // secret.
        const current = await client.query<SecretRow>(
          `SELECT version, ciphertext, dek_wrapped, kek_id
             FROM project_secrets
            WHERE project_id = $1 AND name = $2 AND state = 'active'
              FOR UPDATE`, [projectId, name]);
        const cur = current.rows[0];
        const previous = cur
          ? envelope.decrypt(
              { ciphertext: cur.ciphertext, dekWrapped: cur.dek_wrapped, kekId: cur.kek_id },
              { projectId, name, version: cur.version })
          : undefined;

        const { rows: top } = await client.query<{ v: number }>(
          `SELECT COALESCE(max(version), 0) AS v FROM project_secrets
            WHERE project_id = $1 AND name = $2`, [projectId, name]);
        const version = (top[0]?.v ?? 0) + 1;

        if (cur) {
          await client.query(
            `UPDATE project_secrets SET state = 'retiring', rotated_at = now()
              WHERE project_id = $1 AND name = $2 AND state = 'active'`,
            [projectId, name]);
        }

        const sealed = envelope.encrypt(value, { projectId, name, version });
        await client.query(
          `INSERT INTO project_secrets
             (project_id, name, version, ciphertext, dek_wrapped, kek_id, state)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
          [projectId, name, version, sealed.ciphertext, sealed.dekWrapped, sealed.kekId]);

        await client.query('COMMIT');
        return { previous, version };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async rotate(projectId, name) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock the name's rows for the duration: two rotations racing must not
        // both demote the same active row and both insert version n+1, which the
        // unique index would turn into one arbitrary winner and one 500.
        const current = await client.query<SecretRow>(
          `SELECT version, ciphertext, dek_wrapped, kek_id
             FROM project_secrets
            WHERE project_id = $1 AND name = $2 AND state = 'active'
              FOR UPDATE`, [projectId, name]);
        const cur = current.rows[0];

        const previous = cur
          ? envelope.decrypt(
              { ciphertext: cur.ciphertext, dekWrapped: cur.dek_wrapped, kekId: cur.kek_id },
              { projectId, name, version: cur.version })
          : undefined;

        // Highest version ever used, not the active one: a previous rotation may
        // have left retiring rows above it, and reusing a version number would
        // collide on (project_id, name, version) — and worse, the AAD binds the
        // version, so a reused number makes two different ciphertexts claim to be
        // the same secret.
        const { rows: top } = await client.query<{ v: number }>(
          `SELECT COALESCE(max(version), 0) AS v FROM project_secrets
            WHERE project_id = $1 AND name = $2`, [projectId, name]);
        const version = (top[0]?.v ?? 0) + 1;

        if (cur) {
          await client.query(
            `UPDATE project_secrets SET state = 'retiring', rotated_at = now()
              WHERE project_id = $1 AND name = $2 AND state = 'active'`,
            [projectId, name]);
        }

        const value = generateSecret();
        const sealed = envelope.encrypt(value, { projectId, name, version });
        await client.query(
          `INSERT INTO project_secrets
             (project_id, name, version, ciphertext, dek_wrapped, kek_id, state)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
          [projectId, name, version, sealed.ciphertext, sealed.dekWrapped, sealed.kekId]);

        await client.query('COMMIT');
        return { value, previous, version };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async purgeRetired(projectId, olderThanHours = 24) {
      // 24 hours by default (§4a step 7): long enough to answer "which credential
      // is my app on" during an incident, short enough that a leaked old password
      // is not indefinitely useful for reading the control plane's history.
      const { rowCount } = await pool.query(
        `DELETE FROM project_secrets
          WHERE project_id = $1 AND state = 'retiring'
            AND rotated_at < now() - ($2 || ' hours')::interval`,
        [projectId, String(olderThanHours)]);
      return rowCount ?? 0;
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
