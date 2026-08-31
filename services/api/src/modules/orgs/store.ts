import { randomBytes, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { writeAudit, type Actor } from '@corebase/audit';
import type { Role } from '../../kernel/permissions.ts';

/**
 * Organizations and membership.
 *
 * Two invariants live here rather than in the routes, because both are about
 * *counting* and a check performed before a write is a window in which the count
 * changes:
 *
 *   1. An org always has at least one owner. "The last owner cannot leave or be
 *      demoted" (409 LAST_OWNER) is enforced inside the transaction that would
 *      break it, with the row locked.
 *   2. An org with projects cannot be deleted. Same reasoning — a project created
 *      between the check and the delete would be orphaned by a foreign key that
 *      restricts rather than cascades.
 */

export class LastOwnerError extends Error {}
export class OrgNotEmptyError extends Error {}
export class SlugTakenError extends Error {}
export class AlreadyMemberError extends Error {}

export interface OrgRecord {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface OrgWithRole extends OrgRecord {
  role: Role;
  member_count: number;
  project_count: number;
}

export interface MemberRecord {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Role;
  created_at: string;
}

export interface InviteRecord {
  id: string;
  email: string;
  role: Role;
  invited_by: string;
  expires_at: string;
  created_at: string;
}

const TS = (c: string) => `to_char(${c}, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')`;
const INVITE_TTL_DAYS = 7;

const hashInviteToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export function createOrgStore(pool: Pool) {
  return {
    /**
     * Create an org and make the creator its owner, in one transaction. An org
     * with no owner is unmanageable and unreachable, and a two-step create can
     * produce one.
     */
    async create(args: { name: string; slug: string; userId: string; actor: Actor }): Promise<OrgRecord> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        let org: OrgRecord;
        try {
          const { rows } = await client.query<OrgRecord>(
            `INSERT INTO organizations (name, slug) VALUES ($1, $2)
             RETURNING id, name, slug::text AS slug, ${TS('created_at')} AS created_at`,
            [args.name, args.slug]);
          org = rows[0]!;
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw new SlugTakenError(args.slug);
          throw err;
        }
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role)
           VALUES ($1, $2, 'owner')`, [org.id, args.userId]);
        await writeAudit(client, args.actor, {
          action: 'org.created', resourceType: 'organization', resourceId: org.id,
          organizationId: org.id,
          metadata: { name: org.name, slug: org.slug },
        });
        await client.query('COMMIT');
        return org;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally { client.release(); }
    },

    /** Orgs the user belongs to, with the counts a list view needs. */
    async listForUser(userId: string): Promise<OrgWithRole[]> {
      const { rows } = await pool.query<OrgWithRole>(
        `SELECT o.id, o.name, o.slug::text AS slug, ${TS('o.created_at')} AS created_at,
                m.role::text AS role,
                (SELECT count(*)::int FROM organization_members x WHERE x.organization_id = o.id) AS member_count,
                (SELECT count(*)::int FROM projects p
                  WHERE p.organization_id = o.id AND p.status <> 'deleted') AS project_count
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1
          ORDER BY o.name`, [userId]);
      return rows;
    },

    /** The caller's role in an org, or undefined if they are not a member. */
    async roleOf(userId: string, orgId: string): Promise<Role | undefined> {
      const { rows } = await pool.query<{ role: Role }>(
        `SELECT role::text AS role FROM organization_members
          WHERE user_id = $1 AND organization_id = $2`, [userId, orgId]);
      return rows[0]?.role;
    },

    async get(orgId: string): Promise<OrgRecord | undefined> {
      const { rows } = await pool.query<OrgRecord>(
        `SELECT id, name, slug::text AS slug, ${TS('created_at')} AS created_at
           FROM organizations WHERE id = $1`, [orgId]);
      return rows[0];
    },

    async rename(args: { orgId: string; name: string; actor: Actor }): Promise<OrgRecord | undefined> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<OrgRecord & { old_name: string }>(
          `UPDATE organizations SET name = $2 WHERE id = $1
        RETURNING id, name, slug::text AS slug, ${TS('created_at')} AS created_at`,
          [args.orgId, args.name]);
        if (!rows[0]) { await client.query('ROLLBACK'); return undefined; }
        await writeAudit(client, args.actor, {
          action: 'org.updated', resourceType: 'organization', resourceId: args.orgId,
          organizationId: args.orgId, metadata: { name: args.name },
        });
        await client.query('COMMIT');
        return rows[0];
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    },

    /**
     * Delete an org, refusing while it still has projects.
     *
     * The count and the delete are in one transaction with the org row locked,
     * because a project created between a check and a delete would hit the
     * `ON DELETE RESTRICT` on `projects.organization_id` and fail confusingly —
     * or worse, in a future where that FK cascades, disappear.
     */
    async remove(args: { orgId: string; actor: Actor }): Promise<void> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [args.orgId]);
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM projects
            WHERE organization_id = $1 AND status <> 'deleted'`, [args.orgId]);
        if ((rows[0]?.n ?? 0) > 0) throw new OrgNotEmptyError(String(rows[0]!.n));
        // Audit first: after the delete the org id has no row, and the audit
        // table has no FK precisely so this row survives.
        await writeAudit(client, args.actor, {
          action: 'org.deleted', resourceType: 'organization', resourceId: args.orgId,
          organizationId: args.orgId,
        });
        await client.query(`DELETE FROM organizations WHERE id = $1`, [args.orgId]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    },

    async members(orgId: string): Promise<MemberRecord[]> {
      const { rows } = await pool.query<MemberRecord>(
        `SELECT m.user_id, u.email::text AS email, u.display_name,
                m.role::text AS role, ${TS('m.created_at')} AS created_at
           FROM organization_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1
          ORDER BY m.role, u.email`, [orgId]);
      return rows;
    },

    /**
     * Change a member's role, refusing to remove the last owner.
     *
     * The owner count is taken with the membership rows locked, so two
     * simultaneous demotions cannot each see the other's owner and both proceed.
     */
    async setRole(args: {
      orgId: string; userId: string; role: Role; actor: Actor;
    }): Promise<Role | undefined> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: current } = await client.query<{ role: Role }>(
          `SELECT role::text AS role FROM organization_members
            WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`, [args.orgId, args.userId]);
        if (!current[0]) { await client.query('ROLLBACK'); return undefined; }
        const previous = current[0].role;

        if (previous === 'owner' && args.role !== 'owner') {
          await assertNotLastOwner(client, args.orgId);
        }
        await client.query(
          `UPDATE organization_members SET role = $3::org_role
            WHERE organization_id = $1 AND user_id = $2`, [args.orgId, args.userId, args.role]);
        await writeAudit(client, args.actor, {
          action: 'member.role_changed', resourceType: 'organization_member',
          resourceId: args.userId, organizationId: args.orgId,
          metadata: { from: previous, to: args.role },
        });
        await client.query('COMMIT');
        return previous;
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    },

    async removeMember(args: {
      orgId: string; userId: string; actor: Actor;
    }): Promise<Role | undefined> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: current } = await client.query<{ role: Role }>(
          `SELECT role::text AS role FROM organization_members
            WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`, [args.orgId, args.userId]);
        if (!current[0]) { await client.query('ROLLBACK'); return undefined; }
        if (current[0].role === 'owner') await assertNotLastOwner(client, args.orgId);

        await client.query(
          `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
          [args.orgId, args.userId]);
        await writeAudit(client, args.actor, {
          action: 'member.removed', resourceType: 'organization_member',
          resourceId: args.userId, organizationId: args.orgId,
          metadata: { role: current[0].role },
        });
        await client.query('COMMIT');
        return current[0].role;
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    },

    // ── invites ─────────────────────────────────────────────────────────────
    /**
     * Create an invite and return its token exactly once.
     *
     * The email sender is Phase 4, so the token comes back in the response for
     * the inviter to pass on — which is also what makes the two-user exit
     * criterion reachable through the API alone. Stored as a hash, same rule as
     * PATs and project keys (D-060).
     */
    async invite(args: {
      orgId: string; email: string; role: Role; invitedBy: string; actor: Actor;
    }): Promise<{ invite: InviteRecord; token: string }> {
      const token = 'cbi_' + randomBytes(24).toString('base64url');
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: existing } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM organization_members m
             JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = $1 AND u.email = $2`, [args.orgId, args.email]);
        if ((existing[0]?.n ?? 0) > 0) throw new AlreadyMemberError(args.email);

        // One live invite per (org, email): re-inviting replaces the token rather
        // than leaving two valid ones, so revoking is unambiguous.
        const { rows } = await client.query<InviteRecord>(
          `INSERT INTO organization_invites
             (organization_id, email, role, invited_by, token_hash, expires_at)
           VALUES ($1, $2, $3::org_role, $4, $5, now() + ($6 || ' days')::interval)
           ON CONFLICT (organization_id, email) DO UPDATE
             SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by,
                 token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at,
                 accepted_at = NULL, created_at = now()
           RETURNING id, email::text AS email, role::text AS role, invited_by,
                     ${TS('expires_at')} AS expires_at, ${TS('created_at')} AS created_at`,
          [args.orgId, args.email, args.role, args.invitedBy, hashInviteToken(token),
           String(INVITE_TTL_DAYS)]);
        await writeAudit(client, args.actor, {
          action: 'member.invited', resourceType: 'organization_invite',
          resourceId: rows[0]!.id, organizationId: args.orgId,
          metadata: { email: args.email, role: args.role },
        });
        await client.query('COMMIT');
        return { invite: rows[0]!, token };
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    },

    async listInvites(orgId: string): Promise<InviteRecord[]> {
      const { rows } = await pool.query<InviteRecord>(
        `SELECT id, email::text AS email, role::text AS role, invited_by,
                ${TS('expires_at')} AS expires_at, ${TS('created_at')} AS created_at
           FROM organization_invites
          WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC`, [orgId]);
      return rows;
    },

    async revokeInvite(args: { orgId: string; inviteId: string; actor: Actor }): Promise<boolean> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rowCount } = await client.query(
          `DELETE FROM organization_invites WHERE id = $1 AND organization_id = $2`,
          [args.inviteId, args.orgId]);
        if (!rowCount) { await client.query('ROLLBACK'); return false; }
        await writeAudit(client, args.actor, {
          action: 'member.invite_revoked', resourceType: 'organization_invite',
          resourceId: args.inviteId, organizationId: args.orgId,
        });
        await client.query('COMMIT');
        return true;
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    },

    /**
     * Accept an invite.
     *
     * The email on the invite must match the accepting account's, or an invite
     * link becomes a bearer token for joining someone else's org — which is
     * exactly what a forwarded email is.
     */
    async acceptInvite(args: {
      token: string; userId: string; userEmail: string; actor: Actor;
    }): Promise<{ orgId: string; role: Role } | undefined> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query<{
          id: string; organization_id: string; role: Role; email: string;
        }>(`SELECT id, organization_id, role::text AS role, email::text AS email
              FROM organization_invites
             WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
             FOR UPDATE`, [hashInviteToken(args.token)]);
        const invite = rows[0];
        if (!invite || invite.email.toLowerCase() !== args.userEmail.toLowerCase()) {
          await client.query('ROLLBACK');
          return undefined;
        }
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role)
           VALUES ($1, $2, $3::org_role)
           ON CONFLICT (organization_id, user_id) DO NOTHING`,
          [invite.organization_id, args.userId, invite.role]);
        await client.query(
          `UPDATE organization_invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
        await writeAudit(client, args.actor, {
          action: 'member.joined', resourceType: 'organization_member',
          resourceId: args.userId, organizationId: invite.organization_id,
          metadata: { role: invite.role, via: 'invite' },
        });
        await client.query('COMMIT');
        return { orgId: invite.organization_id, role: invite.role };
      } catch (err) {
        await client.query('ROLLBACK'); throw err;
      } finally { client.release(); }
    },
  };
}

/**
 * Counted with the rows locked, so two simultaneous demotions cannot each see the
 * other's owner and both proceed.
 *
 * Two statements, not one: Postgres refuses `FOR UPDATE` alongside an aggregate
 * ("FOR UPDATE is not allowed with aggregate functions"), and the first version of
 * this turned every LAST_OWNER case into a 500. Lock the rows, then count what was
 * locked.
 */
async function assertNotLastOwner(client: PoolClient, orgId: string): Promise<void> {
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM organization_members
      WHERE organization_id = $1 AND role = 'owner'
      FOR UPDATE`, [orgId]);
  if (rows.length <= 1) throw new LastOwnerError(orgId);
}

export type OrgStore = ReturnType<typeof createOrgStore>;
