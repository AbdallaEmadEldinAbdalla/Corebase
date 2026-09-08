import type { Pool, PoolClient } from 'pg';
import { hashPassword, verifyPassword } from '@steadhold/crypto';
import { writeAudit, type Actor } from '@steadhold/audit';

/**
 * Platform accounts: the users who log into the dashboard, not the users of a
 * customer's app (those are Phase 4 and live in the project's own database).
 */

export interface UserRecord {
  id: string;
  email: string;
  display_name: string | null;
  email_verified: boolean;
  is_staff: boolean;
  disabled_at: string | null;
  created_at: string;
}

export interface Membership {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  role: 'owner' | 'admin' | 'member';
}

const USER_COLUMNS = `
  id, email::text AS email, display_name, email_verified, is_staff,
  to_char(disabled_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') AS disabled_at,
  to_char(created_at,  'YYYY-MM-DD"T"HH24:MI:SS.MSZ') AS created_at`;

export class EmailTakenError extends Error {}

export function createUserStore(pool: Pool) {
  return {
    /**
     * Create an account and audit it in one transaction.
     *
     * The email uniqueness check is the database's, not a prior SELECT: two
     * simultaneous signups for the same address would both pass a check-then-act
     * and one would fail confusingly on insert.
     */
    async signup(args: {
      email: string; password: string; displayName?: string; actor: Actor;
    }): Promise<UserRecord> {
      const passwordHash = await hashPassword(args.password);
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        let user: UserRecord;
        try {
          const { rows } = await client.query<UserRecord>(
            `INSERT INTO users (email, password_hash, display_name)
             VALUES ($1, $2, $3)
             RETURNING ${USER_COLUMNS}`,
            [args.email, passwordHash, args.displayName ?? null]);
          user = rows[0]!;
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw new EmailTakenError(args.email);
          throw err;
        }
        await writeAudit(client, { ...args.actor, userId: user.id }, {
          action: 'user.created',
          resourceType: 'user',
          resourceId: user.id,
          // The email is the identifier the account is *for*; recording it is the
          // point. The password never reaches this object.
          metadata: { email: user.email, display_name: user.display_name },
        });
        await client.query('COMMIT');
        return user;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async findByEmail(email: string): Promise<(UserRecord & { password_hash: string | null }) | undefined> {
      const { rows } = await pool.query<UserRecord & { password_hash: string | null }>(
        `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = $1`, [email]);
      return rows[0];
    },

    async findById(id: string): Promise<UserRecord | undefined> {
      const { rows } = await pool.query<UserRecord>(
        `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
      return rows[0];
    },

    async memberships(userId: string): Promise<Membership[]> {
      const { rows } = await pool.query<Membership>(
        `SELECT m.organization_id, o.name AS organization_name,
                o.slug::text AS organization_slug, m.role::text AS role
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1
          ORDER BY o.name`, [userId]);
      return rows;
    },

    /** Re-hash on login when the stored parameters are weaker than current. */
    async upgradeHash(userId: string, password: string): Promise<void> {
      await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1`,
        [userId, await hashPassword(password)]);
    },

    verify: verifyPassword,
  };
}

export type UserStore = ReturnType<typeof createUserStore>;
