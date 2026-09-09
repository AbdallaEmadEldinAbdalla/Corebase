/**
 * The role model, shared by the API and the dashboard.
 *
 * It lives in this package rather than in the API's kernel because both sides need
 * the *same* answer and only one of them may own it. The API enforces the matrix;
 * the dashboard uses it to decide which affordances to render, so that a member
 * does not see an "Invite" button that exists only to return 403. Re-implementing
 * the table on the client would create two authorities that can disagree — the
 * same mistake D-400 refuses for RLS, where the fix was to ask Postgres rather
 * than to re-derive its policy in TypeScript.
 *
 * `require_` stays in the API: it throws an HTTP error, which is a server concern.
 * Everything here is a pure question about roles, answerable in a browser.
 */

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
  /**
   * Running SQL through the console — the table editor and the SQL editor
   * (D-132). A **member** capability, and the argument is not that arbitrary DDL
   * is mild: it is that a member can already reveal the `developer` connection
   * string from `GET /v1/projects/:ref?reveal=true`, which is guarded by
   * `project.read`, and run the same statements from psql. Gating the console
   * above member would protect nothing and would make the product's main
   * developer surface unusable for the role it exists for. The console is the
   * *more* accountable path to what a member already holds — every statement is
   * audited with an actor, which psql is not (D-463).
   */
  'db.query',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const MEMBER: Capability[] = [
  'org.read', 'member.read', 'project.read', 'project.create', 'project.lifecycle',
  'db.query',
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
