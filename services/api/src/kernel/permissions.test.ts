import { describe, it, expect } from 'vitest';
import {
  can, canAssignRole, canActOn, require_, ROLE_CAPABILITIES, CAPABILITIES,
  type Role, type Capability,
} from './permissions.ts';

const ROLES: Role[] = ['owner', 'admin', 'member'];

describe('the role matrix matches the documented model', () => {
  it('owner can do everything', () => {
    for (const c of CAPABILITIES) expect(can('owner', c), c).toBe(true);
  });

  it('admin can do everything except delete the org, billing, and granting owner', () => {
    const denied: Capability[] = ['org.delete', 'org.billing', 'member.role.grant_owner'];
    for (const c of CAPABILITIES) {
      expect(can('admin', c), c).toBe(!denied.includes(c));
    }
  });

  it('member reads everything and mutates only projects', () => {
    expect([...ROLE_CAPABILITIES.member].sort()).toEqual(
      ['member.read', 'org.read', 'project.create', 'project.lifecycle', 'project.read']);
  });

  it('a member cannot delete a project', () => {
    // The doc spells a member's mutations out as create/pause/resume; delete is
    // the one project action that destroys data.
    expect(can('member', 'project.delete')).toBe(false);
    expect(can('admin', 'project.delete')).toBe(true);
  });

  it('a member manages no keys and no secrets', () => {
    expect(can('member', 'key.manage')).toBe(false);
    expect(can('member', 'secret.manage')).toBe(false);
  });

  it('roles are cumulative, so a higher role never loses a capability', () => {
    // A matrix built by hand can silently drop something on the way up.
    for (const c of CAPABILITIES) {
      if (can('member', c)) expect(can('admin', c), c).toBe(true);
      if (can('admin', c)) expect(can('owner', c), c).toBe(true);
    }
  });
});

describe('role assignment', () => {
  it('only an owner can grant owner', () => {
    // The classic escalation-by-omission: "may change roles" is true for an
    // admin, and without a second check they can promote themselves.
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'admin')).toBe(true);
    expect(canAssignRole('admin', 'member')).toBe(true);
  });

  it('a member cannot assign any role', () => {
    for (const target of ROLES) expect(canAssignRole('member', target)).toBe(false);
  });
});

describe('acting on other members', () => {
  it('nobody may act on someone above them', () => {
    // Without this an admin can strip every owner and take the org, and no single
    // capability check notices — "may change roles" was true throughout.
    expect(canActOn('admin', 'owner')).toBe(false);
    expect(canActOn('member', 'admin')).toBe(false);
    expect(canActOn('owner', 'owner')).toBe(true);
    expect(canActOn('admin', 'admin')).toBe(true);
  });
});

describe('require_', () => {
  it('names the role and the capability, so the reader knows who to ask', () => {
    expect(() => require_('member', 'project.delete'))
      .toThrow(/A member cannot do this \(project\.delete\)/);
  });

  it('answers 404 for a non-member rather than 403', () => {
    // "You lack permission on org X" confirms org X exists and that the caller
    // is being told about it. Absence of membership is absence of the resource.
    expect(() => require_(undefined, 'org.read')).toThrow(/No such organization/);
    try { require_(undefined, 'org.read'); } catch (e) {
      expect((e as { statusCode: number }).statusCode).toBe(404);
    }
  });

  it('passes silently when allowed', () => {
    expect(() => require_('owner', 'org.delete')).not.toThrow();
  });
});
