import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ERROR_CODES, encodeId, decodeId, InvalidIdError } from '@steadhold/types';
import { ApiError } from '../../kernel/errors.ts';
import { resolvePrincipal, actorOf, type PrincipalDeps } from '../../kernel/principal.ts';
import { require_, canAssignRole, canActOn, type Role } from '../../kernel/permissions.ts';
import {
  LastOwnerError, OrgNotEmptyError, SlugTakenError, AlreadyMemberError, type OrgStore,
} from './store.ts';
import type { UserStore } from '../auth/store.ts';

/**
 * Organizations, membership and invites (platform API §"Organizations & members").
 *
 * Every handler resolves the caller, then their role in the org, then the
 * capability — in that order and through the same three helpers, so a new endpoint
 * cannot accidentally check two of the three. The order matters for what a
 * stranger learns: a non-member gets 404, not 403, because "you lack permission
 * on org X" confirms org X exists.
 */

const CreateOrgRequest = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/,
    'slug must be 3-40 lowercase letters, digits or hyphens, not starting or ending with a hyphen'),
});
const RenameOrgRequest = z.object({ name: z.string().min(1).max(120) });
const RoleSchema = z.enum(['owner', 'admin', 'member']);
const InviteRequest = z.object({ email: z.string().email().max(320), role: RoleSchema.default('member') });
const SetRoleRequest = z.object({ role: RoleSchema });
const AcceptRequest = z.object({ token: z.string().min(8).max(200) });

export interface OrgDeps extends PrincipalDeps {
  orgs: OrgStore;
  users: UserStore;
}

export function registerOrgs(app: FastifyInstance, deps: OrgDeps) {
  const requestIdOf = (reply: { getHeader(n: string): unknown }, fallback: string) =>
    String(reply.getHeader('x-request-id') ?? fallback);

  // Generic over the schema, not over its output: `z.ZodType<T>` infers T from
  // the *input* type, so a field with `.default()` came out optional and every
  // use needed a non-null assertion.
  const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> => {
    const r = schema.safeParse(body);
    if (!r.success) {
      throw ApiError.validation(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    return r.data;
  };

  /** Resolve the caller to an actual user; the static token is nobody. */
  async function requireUser(req: FastifyRequest): Promise<{ userId: string }> {
    const principal = await resolvePrincipal(req, deps);
    if (!principal.userId) {
      throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
        'This endpoint acts on a user\'s organizations and the static token is not a user.');
    }
    return { userId: principal.userId };
  }

  /** The caller's role in the org named by `:org_id`, or 404. */
  async function requireMembership(req: FastifyRequest): Promise<{ userId: string; orgId: string; role: Role }> {
    const { userId } = await requireUser(req);
    const raw = (req.params as { org_id: string }).org_id;
    let orgId: string;
    try { orgId = decodeId('organization', raw); }
    catch (err) {
      if (!(err instanceof InvalidIdError)) throw err;
      // A malformed id is not a 404: telling the caller their id is unreadable
      // reveals nothing and saves them a support ticket.
      throw ApiError.validation(err.message);
    }
    const role = await deps.orgs.roleOf(userId, orgId);
    if (!role) {
      throw new ApiError(404, ERROR_CODES.PROJECT_NOT_FOUND,
        'No such organization, or you are not a member of it.');
    }
    return { userId, orgId, role };
  }

  const serializeOrg = (o: { id: string; name: string; slug: string; created_at: string }) => ({
    id: encodeId('organization', o.id), name: o.name, slug: o.slug, created_at: o.created_at,
  });

  // ── orgs ──────────────────────────────────────────────────────────────────
  app.post('/v1/orgs', async (req, reply) => {
    const { userId } = await requireUser(req);
    const body = parse(CreateOrgRequest, req.body);
    const requestId = requestIdOf(reply, req.id);
    const principal = await resolvePrincipal(req, deps);

    try {
      const org = await deps.orgs.create({
        name: body.name, slug: body.slug, userId,
        actor: actorOf(principal, req, requestId),
      });
      // The creator is the owner, written in the same transaction: an org with no
      // owner is unmanageable and a two-step create can produce one.
      return reply.status(201).send({ org: { ...serializeOrg(org), role: 'owner' } });
    } catch (err) {
      if (err instanceof SlugTakenError) {
        throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
          `The slug "${body.slug}" is taken.`);
      }
      throw err;
    }
  });

  app.get('/v1/orgs', async (req) => {
    const { userId } = await requireUser(req);
    const orgs = await deps.orgs.listForUser(userId);
    return {
      orgs: orgs.map((o) => ({
        ...serializeOrg(o), role: o.role,
        member_count: o.member_count, project_count: o.project_count,
      })),
    };
  });

  app.get('/v1/orgs/:org_id', async (req) => {
    const { orgId, role } = await requireMembership(req);
    require_(role, 'org.read');
    const org = await deps.orgs.get(orgId);
    if (!org) throw ApiError.notFound('Organization');
    return { org: { ...serializeOrg(org), role } };
  });

  app.patch('/v1/orgs/:org_id', async (req, reply) => {
    const { orgId, role } = await requireMembership(req);
    require_(role, 'org.update');
    const body = parse(RenameOrgRequest, req.body);
    const principal = await resolvePrincipal(req, deps);
    const org = await deps.orgs.rename({
      orgId, name: body.name, actor: actorOf(principal, req, requestIdOf(reply, req.id)),
    });
    if (!org) throw ApiError.notFound('Organization');
    return { org: { ...serializeOrg(org), role } };
  });

  app.delete('/v1/orgs/:org_id', async (req, reply) => {
    const { orgId, role } = await requireMembership(req);
    require_(role, 'org.delete');
    const principal = await resolvePrincipal(req, deps);
    try {
      await deps.orgs.remove({ orgId, actor: actorOf(principal, req, requestIdOf(reply, req.id)) });
    } catch (err) {
      if (err instanceof OrgNotEmptyError) {
        throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
          `This organization still has ${err.message} project(s). Delete them first.`);
      }
      throw err;
    }
    return reply.status(204).send();
  });

  // ── members ───────────────────────────────────────────────────────────────
  app.get('/v1/orgs/:org_id/members', async (req) => {
    const { orgId, role } = await requireMembership(req);
    require_(role, 'member.read');
    const members = await deps.orgs.members(orgId);
    return {
      members: members.map((m) => ({
        user_id: encodeId('user', m.user_id), email: m.email,
        display_name: m.display_name, role: m.role, joined_at: m.created_at,
      })),
    };
  });

  app.patch('/v1/orgs/:org_id/members/:user_id', async (req, reply) => {
    const { orgId, role } = await requireMembership(req);
    require_(role, 'member.role.change');
    const body = parse(SetRoleRequest, req.body);
    const targetId = decodeUserId(req);

    // Two checks, not one. "May change roles" is true for an admin; without the
    // second an admin promotes themselves to owner, and without the third they
    // demote every owner and take the org.
    if (!canAssignRole(role, body.role)) {
      throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
        `A ${role} cannot grant the ${body.role} role.`);
    }
    const members = await deps.orgs.members(orgId);
    const target = members.find((m) => m.user_id === targetId);
    if (!target) throw ApiError.notFound('Member');
    if (!canActOn(role, target.role)) {
      throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
        `A ${role} cannot act on a ${target.role}.`);
    }

    const principal = await resolvePrincipal(req, deps);
    try {
      const previous = await deps.orgs.setRole({
        orgId, userId: targetId, role: body.role,
        actor: actorOf(principal, req, requestIdOf(reply, req.id)),
      });
      if (!previous) throw ApiError.notFound('Member');
      return { member: { user_id: encodeId('user', targetId), role: body.role, previous_role: previous } };
    } catch (err) {
      if (err instanceof LastOwnerError) throw lastOwner();
      throw err;
    }
  });

  app.delete('/v1/orgs/:org_id/members/:user_id', async (req, reply) => {
    const { userId, orgId, role } = await requireMembership(req);
    const targetId = decodeUserId(req);

    // Leaving is not member management: anyone may remove *themselves*, and
    // requiring member.remove for that would trap a member in an org forever.
    if (targetId !== userId) {
      require_(role, 'member.remove');
      const members = await deps.orgs.members(orgId);
      const target = members.find((m) => m.user_id === targetId);
      if (!target) throw ApiError.notFound('Member');
      if (!canActOn(role, target.role)) {
        throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
          `A ${role} cannot act on a ${target.role}.`);
      }
    }

    const principal = await resolvePrincipal(req, deps);
    try {
      const removed = await deps.orgs.removeMember({
        orgId, userId: targetId,
        actor: actorOf(principal, req, requestIdOf(reply, req.id)),
      });
      if (!removed) throw ApiError.notFound('Member');
    } catch (err) {
      if (err instanceof LastOwnerError) throw lastOwner();
      throw err;
    }
    return reply.status(204).send();
  });

  // ── invites ───────────────────────────────────────────────────────────────
  app.post('/v1/orgs/:org_id/invites', async (req, reply) => {
    const { userId, orgId, role } = await requireMembership(req);
    require_(role, 'member.invite');
    const body = parse(InviteRequest, req.body);
    if (!canAssignRole(role, body.role)) {
      throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
        `A ${role} cannot invite someone as ${body.role}.`);
    }
    const principal = await resolvePrincipal(req, deps);
    try {
      const { invite, token } = await deps.orgs.invite({
        orgId, email: body.email.trim().toLowerCase(), role: body.role, invitedBy: userId,
        actor: actorOf(principal, req, requestIdOf(reply, req.id)),
      });
      return reply.status(201).send({
        invite: {
          id: invite.id, email: invite.email, role: invite.role,
          expires_at: invite.expires_at,
        },
        // Returned once, because the email sender is Phase 4 — the inviter passes
        // it on by hand for now. Stored as a hash, so this is the only moment it
        // exists outside the invitee's possession.
        token,
        delivery: 'not_emailed_yet',
        warning: 'This token will not be shown again. Send it to the invitee yourself.',
      });
    } catch (err) {
      if (err instanceof AlreadyMemberError) {
        throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
          `${body.email} is already a member of this organization.`);
      }
      throw err;
    }
  });

  app.get('/v1/orgs/:org_id/invites', async (req) => {
    const { orgId, role } = await requireMembership(req);
    require_(role, 'member.read');
    const invites = await deps.orgs.listInvites(orgId);
    return {
      invites: invites.map((i) => ({
        id: i.id, email: i.email, role: i.role,
        invited_by: encodeId('user', i.invited_by),
        expires_at: i.expires_at, created_at: i.created_at,
      })),
    };
  });

  app.delete('/v1/orgs/:org_id/invites/:invite_id', async (req, reply) => {
    const { orgId, role } = await requireMembership(req);
    require_(role, 'member.invite');
    const { invite_id: inviteId } = req.params as { invite_id: string };
    const principal = await resolvePrincipal(req, deps);
    const revoked = await deps.orgs.revokeInvite({
      orgId, inviteId, actor: actorOf(principal, req, requestIdOf(reply, req.id)),
    });
    if (!revoked) throw ApiError.notFound('Invite');
    return reply.status(204).send();
  });

  /**
   * Accept an invite.
   *
   * Not in the documented endpoint table, which lists creating, listing and
   * revoking but no way to accept — a gap, since an invite that cannot be
   * accepted is not an invite (D-213).
   */
  app.post('/v1/invites/accept', async (req, reply) => {
    const { userId } = await requireUser(req);
    const body = parse(AcceptRequest, req.body);
    const user = await deps.users.findById(userId);
    if (!user) throw ApiError.unauthorized();
    const principal = await resolvePrincipal(req, deps);

    const accepted = await deps.orgs.acceptInvite({
      token: body.token, userId, userEmail: user.email,
      actor: actorOf(principal, req, requestIdOf(reply, req.id)),
    });
    if (!accepted) {
      // One answer for expired, revoked, already-used, and addressed-to-someone-
      // else. Distinguishing them turns an invite token into an oracle about an
      // org's membership.
      throw new ApiError(404, ERROR_CODES.PROJECT_NOT_FOUND,
        'That invite is not valid for this account.');
    }
    return reply.status(200).send({
      org_id: encodeId('organization', accepted.orgId), role: accepted.role,
    });
  });

  function decodeUserId(req: FastifyRequest): string {
    const raw = (req.params as { user_id: string }).user_id;
    try { return decodeId('user', raw); }
    catch (err) {
      if (!(err instanceof InvalidIdError)) throw err;
      throw ApiError.validation(err.message);
    }
  }

  const lastOwner = () => new ApiError(409, ERROR_CODES.LAST_OWNER,
    'An organization must keep at least one owner. Promote someone else first.');
}
