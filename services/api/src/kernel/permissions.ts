import { ERROR_CODES } from '@corebase/types';
import { ApiError } from './errors.ts';

/**
 * The role model (platform API §"Roles"), as one table.
 *
 * It is a table and not a set of `if (role === 'owner')` checks for a reason that
 * shows up on the second reader: a matrix can be *read* to answer "what can an
 * admin do", and scattered conditionals can only be searched. The exit criterion
 * for Phase 1 is that two users with different roles see correct permissions end
 * to end, and the cheapest way to keep that true is for there to be exactly one
 * place where it is written down.
 *
 * From the doc:
 *   owner   everything, including org deletion, billing, member role changes
 *   admin   everything except org deletion, billing, and granting owner
 *   member  read everything, mutate projects (create/pause/resume), and no
 *           member/key/secret management
 */

export type Role = 'owner' | 'admin' | 'member';

export const CAPABILITIES = [
  'org.read',
  'org.update',
  'org.delete',
  'org.billing',
  'member.read',
  'member.invite',
  'member.role.change',
  /** Granting *owner* specifically — an admin may change roles but not create peers above them. */
  'member.role.grant_owner',
  'member.remove',
  'project.read',
  'project.create',
  /** Pause and resume: reversible, and the doc lists them as a member's business. */
  'project.lifecycle',
  /**
   * Deleting a project is deliberately NOT a member capability. The doc spells out
   * a member's mutations as "create/pause/resume", and delete is not among them —
   * it is the one project action that destroys data, so it sits with the roles
   * that can also be held responsible for it.
   */
  'project.delete',
  'key.manage',
  'secret.manage',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const MEMBER: Capability[] = [
  'org.read', 'member.read', 'project.read', 'project.create', 'project.lifecycle',
];

const ADMIN: Capability[] = [
  ...MEMBER,
  'org.update', 'member.invite', 'member.role.change', 'member.remove',
  'project.delete', 'key.manage', 'secret.manage',
];

const OWNER: Capability[] = [
  ...ADMIN,
  'org.delete', 'org.billing', 'member.role.grant_owner',
];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  member: new Set(MEMBER),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

/**
 * Throw 403 unless the role allows it.
 *
 * The message names the capability and the role, because "forbidden" sends the
 * reader to a support ticket while "a member cannot delete a project" sends them
 * to the right person in their own org.
 */
export function require_(role: Role | undefined, capability: Capability): void {
  if (!role) {
    throw new ApiError(404, ERROR_CODES.PROJECT_NOT_FOUND,
      'No such organization, or you are not a member of it.');
  }
  if (!can(role, capability)) {
    throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
      `A ${role} cannot do this (${capability}).`);
  }
}

/**
 * Whether `actor` may set someone's role to `target`.
 *
 * Separate from the capability check because "may change roles" and "may grant
 * *this* role" are different questions, and conflating them lets an admin promote
 * themselves to owner — the classic privilege-escalation-by-omission.
 */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (!can(actor, 'member.role.change')) return false;
  if (target === 'owner') return can(actor, 'member.role.grant_owner');
  return true;
}

/** Rank, for "you cannot act on someone at or above your level". */
const RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

/**
 * An admin must not be able to demote or remove an owner. Without this an admin
 * can strip every owner and take the org — a hole no single capability check
 * closes, because "may change roles" was true the whole time.
 */
export function canActOn(actor: Role, subject: Role): boolean {
  return RANK[actor] >= RANK[subject];
}
