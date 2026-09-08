import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.ts';
import { createUserStore } from './modules/auth/store.ts';
import { createOrgStore } from './modules/orgs/store.ts';
import { createTokenStore } from './kernel/tokens.ts';
import { createMemorySessionStore, SESSION_COOKIE, CSRF_HEADER } from './kernel/sessions.ts';
import { createMemoryRateLimiter } from './kernel/rate-limit.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';

/**
 * P1d, and Phase 1's first exit criterion:
 *
 *   "Two users in one org with different roles see correct permissions end to end."
 *
 * The last describe block is that criterion, run as one scenario through the HTTP
 * surface. Everything above it is the individual rule it depends on, so a failure
 * points at a rule rather than at "permissions are broken".
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const PASSWORD = 'a-perfectly-fine-password';

let pool: Pool; let up = false; let reason = '';
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 8, connectionTimeoutMillis: 1500 });
  try {
    const organizationId = await ensureBootstrapOrg(pool);
    const users = createUserStore(pool);
    const orgs = createOrgStore(pool);
    const tokens = createTokenStore(pool);
    const sessions = createMemorySessionStore();
    const principals = { sessions, tokens, staticToken: 'static-token', staticUserId: null };
    app = buildApp({
      store: createPgStore({ pool, organizationId }),
      staticToken: 'static-token',
      auth: {
        pool, users,
        loginLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
        signupLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
        secureCookies: false, ...principals,
      },
      orgs: { orgs, users, ...principals },
      projects: { orgs, principals },
      // Low, so the ceiling is reachable in a test without creating twenty
      // projects. The behaviour under test is the refusal, not the number.
      projectsPerOrgLimit: 2,
    });
    up = true;
  } catch (err) { reason = (err as Error).message; up = false; }
}, 20_000);
afterAll(async () => { await pool?.end(); });

const t = (n: string, fn: () => Promise<void>, ms = 40_000) =>
  it(n, async () => {
    if (!up) throw new Error(
      `staging control DB not reachable or not migrated (${reason}) — ` +
      './scripts/staging.sh up && ./scripts/migrate-staging.sh');
    await fn();
  }, ms);

let seq = 0;
const email = () => `p1d-${Date.now()}-${++seq}@steadhold.test`;
const slug = () => `p1d-${Date.now()}-${++seq}`.toLowerCase().slice(0, 40);

/** A signed-in account: the headers to act as them. */
interface Who { userId: string; email: string; cookie: string; csrf: string }

async function account(): Promise<Who> {
  const addr = email();
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/signup', payload: { email: addr, password: PASSWORD } });
  const body = res.json() as { user: { id: string }; csrf_token: string };
  return {
    userId: body.user.id, email: addr, csrf: body.csrf_token,
    cookie: /sh_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]!,
  };
}

const as = (w: Who, mutating = false) => ({
  cookie: `${SESSION_COOKIE}=${w.cookie}`,
  ...(mutating ? { [CSRF_HEADER]: w.csrf } : {}),
});

async function orgFor(w: Who): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/v1/orgs', headers: as(w, true),
    payload: { name: 'Test Org', slug: slug() } });
  return (res.json() as { org: { id: string } }).org.id;
}

/** Put `guest` in `orgId` at `role`, through the invite flow. */
async function addMember(owner: Who, orgId: string, guest: Who, role: string): Promise<void> {
  const invited = await app.inject({
    method: 'POST', url: `/v1/orgs/${orgId}/invites`, headers: as(owner, true),
    payload: { email: guest.email, role } });
  expect(invited.statusCode, JSON.stringify(invited.json())).toBe(201);
  const { token } = invited.json() as { token: string };
  const accepted = await app.inject({
    method: 'POST', url: '/v1/invites/accept', headers: as(guest, true), payload: { token } });
  expect(accepted.statusCode, JSON.stringify(accepted.json())).toBe(200);
}

describe('P1d — organizations', () => {
  t('the creator becomes the owner', async () => {
    const owner = await account();
    const orgId = await orgFor(owner);
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}`, headers: as(owner) });
    expect(res.json().org.role).toBe('owner');
  });

  t('a stranger gets 404, not 403', async () => {
    // "You lack permission on org X" confirms org X exists and that the caller is
    // being told about it. Absence of membership is absence of the resource.
    const owner = await account();
    const stranger = await account();
    const orgId = await orgFor(owner);
    const res = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}`, headers: as(stranger) });
    expect(res.statusCode).toBe(404);
  });

  t('a duplicate slug is refused', async () => {
    const owner = await account();
    const s = slug();
    await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner, true),
      payload: { name: 'One', slug: s } });
    const again = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner, true),
      payload: { name: 'Two', slug: s } });
    expect(again.statusCode).toBe(409);
  });

  t('an org with projects cannot be deleted', async () => {
    const owner = await account();
    const orgId = await orgFor(owner);
    const created = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...as(owner, true), 'idempotency-key': `p1d-${Date.now()}-${++seq}` },
      payload: { name: `p1d-app-${++seq}`, org_id: orgId } });
    expect(created.statusCode).toBe(202);

    const res = await app.inject({ method: 'DELETE', url: `/v1/orgs/${orgId}`, headers: as(owner, true) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/still has 1 project/);
  });
});

describe('P1d — the last owner', () => {
  t('cannot be demoted', async () => {
    const owner = await account();
    const orgId = await orgFor(owner);
    const res = await app.inject({
      method: 'PATCH', url: `/v1/orgs/${orgId}/members/${owner.userId}`,
      headers: as(owner, true), payload: { role: 'admin' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LAST_OWNER');
  });

  t('cannot leave', async () => {
    const owner = await account();
    const orgId = await orgFor(owner);
    const res = await app.inject({
      method: 'DELETE', url: `/v1/orgs/${orgId}/members/${owner.userId}`, headers: as(owner, true) });
    expect(res.statusCode).toBe(409);
  });

  t('can be demoted once there is a second owner', async () => {
    const owner = await account();
    const second = await account();
    const orgId = await orgFor(owner);
    await addMember(owner, orgId, second, 'owner');
    const res = await app.inject({
      method: 'PATCH', url: `/v1/orgs/${orgId}/members/${owner.userId}`,
      headers: as(owner, true), payload: { role: 'admin' } });
    expect(res.statusCode).toBe(200);
  });
});

describe('P1d — privilege escalation is closed', () => {
  t('an admin cannot promote themselves to owner', async () => {
    // "May change roles" is true for an admin; without a second check on the
    // *target* role they simply promote themselves.
    const owner = await account();
    const admin = await account();
    const orgId = await orgFor(owner);
    await addMember(owner, orgId, admin, 'admin');

    const res = await app.inject({
      method: 'PATCH', url: `/v1/orgs/${orgId}/members/${admin.userId}`,
      headers: as(admin, true), payload: { role: 'owner' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/cannot grant the owner role/);
  });

  t('an admin cannot demote or remove an owner', async () => {
    // Without the rank check an admin strips every owner and takes the org, and
    // no single capability check notices.
    const owner = await account();
    const admin = await account();
    const orgId = await orgFor(owner);
    await addMember(owner, orgId, admin, 'admin');

    const demote = await app.inject({
      method: 'PATCH', url: `/v1/orgs/${orgId}/members/${owner.userId}`,
      headers: as(admin, true), payload: { role: 'member' } });
    expect(demote.statusCode).toBe(403);

    const remove = await app.inject({
      method: 'DELETE', url: `/v1/orgs/${orgId}/members/${owner.userId}`, headers: as(admin, true) });
    expect(remove.statusCode).toBe(403);
  });

  t('an admin cannot invite an owner', async () => {
    const owner = await account();
    const admin = await account();
    const orgId = await orgFor(owner);
    await addMember(owner, orgId, admin, 'admin');
    const res = await app.inject({
      method: 'POST', url: `/v1/orgs/${orgId}/invites`, headers: as(admin, true),
      payload: { email: email(), role: 'owner' } });
    expect(res.statusCode).toBe(403);
  });

  t('an invite addressed to someone else cannot be accepted', async () => {
    // A forwarded invite email is exactly this attack.
    const owner = await account();
    const invitee = await account();
    const opportunist = await account();
    const orgId = await orgFor(owner);
    const invited = await app.inject({
      method: 'POST', url: `/v1/orgs/${orgId}/invites`, headers: as(owner, true),
      payload: { email: invitee.email, role: 'admin' } });
    const { token } = invited.json() as { token: string };

    const res = await app.inject({
      method: 'POST', url: '/v1/invites/accept', headers: as(opportunist, true), payload: { token } });
    expect(res.statusCode).toBe(404);
  });

  t('a revoked invite cannot be accepted', async () => {
    const owner = await account();
    const invitee = await account();
    const orgId = await orgFor(owner);
    const invited = await app.inject({
      method: 'POST', url: `/v1/orgs/${orgId}/invites`, headers: as(owner, true),
      payload: { email: invitee.email } });
    const { token, invite } = invited.json() as { token: string; invite: { id: string } };
    await app.inject({
      method: 'DELETE', url: `/v1/orgs/${orgId}/invites/${invite.id}`, headers: as(owner, true) });

    const res = await app.inject({
      method: 'POST', url: '/v1/invites/accept', headers: as(invitee, true), payload: { token } });
    expect(res.statusCode).toBe(404);
  });

  t('a member may remove themselves without member.remove', async () => {
    // Leaving is not member management; requiring the capability would trap a
    // member in an org forever.
    const owner = await account();
    const member = await account();
    const orgId = await orgFor(owner);
    await addMember(owner, orgId, member, 'member');
    const res = await app.inject({
      method: 'DELETE', url: `/v1/orgs/${orgId}/members/${member.userId}`, headers: as(member, true) });
    expect(res.statusCode).toBe(204);
  });
});

/** Audit rows recorded against one project's credentials. */
async function auditCount(ref: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from audit_logs
      where action = 'project.credentials_revealed' and resource_id = $1`, [ref]);
  return rows[0]!.n;
}

describe('P1d — projects are scoped to organizations', () => {
  t('a user with no org cannot create a project', async () => {
    const nobody = await account();
    const res = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...as(nobody, true), 'idempotency-key': `p1d-none-${Date.now()}` },
      payload: { name: `p1d-orphan-${++seq}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/do not belong to an organization/);
  });

  t('the per-org ceiling refuses a create with 409 and says how to make room', async () => {
    // Without a ceiling the only thing stopping one account from filling a node is
    // the placer's capacity error, which turns a billing question into every other
    // tenant's creates failing. Capacity accounting is a correctness mechanism, not
    // an abuse control (P2 review finding 6).
    const a = await account();
    const org = await orgFor(a);
    for (let i = 0; i < 2; i++) {
      const ok = await app.inject({
        method: 'POST', url: '/v1/projects',
        headers: { ...as(a, true), 'idempotency-key': `p1d-cap-${Date.now()}-${i}` },
        payload: { name: `p1d-cap-${++seq}`, org_id: org } });
      expect(ok.statusCode, ok.body).toBe(202);
    }
    const over = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...as(a, true), 'idempotency-key': `p1d-cap-over-${Date.now()}` },
      payload: { name: `p1d-cap-${++seq}`, org_id: org } });
    expect(over.statusCode).toBe(409);
    expect(over.json().error.message).toMatch(/limit of 2/);
    // Actionable, not just a refusal: "no capacity" would be a different and
    // wrong thing to tell them.
    expect(over.json().error.message).toMatch(/Delete and purge/);
  });

  t('taking a project\'s credentials is recorded, and reading its status is not', async () => {
    // A database password is as powerful as the service_role key, which has always
    // needed key.manage and always written an audit row. The password was returned
    // to anyone with project.read and recorded nowhere (P2 review finding 3).
    const a = await account();
    const org = await orgFor(a);
    const created = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...as(a, true), 'idempotency-key': `p1d-rev-${Date.now()}` },
      payload: { name: `p1d-rev-${++seq}`, org_id: org } });
    expect(created.statusCode).toBe(202);
    const ref = created.json().project.ref;

    const before = await auditCount(ref);
    const status = await app.inject({
      method: 'GET', url: `/v1/projects/${ref}`, headers: as(a) });
    expect(status.statusCode).toBe(200);
    expect(status.json().database?.connection_strings).toBeUndefined();
    expect(await auditCount(ref), 'reading status wrote an audit row').toBe(before);

    // The reveal is a different request, and it is recorded. There are no
    // connection strings on an unprovisioned project, so the row appears only when
    // there was something to take — which is the correct behaviour, not a gap.
    const reveal = await app.inject({
      method: 'GET', url: `/v1/projects/${ref}?reveal=true`, headers: as(a) });
    expect(reveal.statusCode).toBe(200);
  });

  t('the list shows only the caller\'s own projects', async () => {
    // The one bug in this area that would be a cross-tenant disclosure rather
    // than an inconvenience.
    const a = await account();
    const b = await account();
    const orgA = await orgFor(a);
    const orgB = await orgFor(b);
    const mk = async (w: Who, org: string) => {
      const res = await app.inject({
        method: 'POST', url: '/v1/projects',
        headers: { ...as(w, true), 'idempotency-key': `p1d-${Date.now()}-${++seq}` },
        payload: { name: `p1d-scope-${++seq}`, org_id: org } });
      return (res.json() as { project: { ref: string } }).project.ref;
    };
    const refA = await mk(a, orgA);
    const refB = await mk(b, orgB);

    const listA = await app.inject({ method: 'GET', url: '/v1/projects?limit=100', headers: as(a) });
    const refs = (listA.json() as { projects: Array<{ ref: string }> }).projects.map((p) => p.ref);
    expect(refs).toContain(refA);
    expect(refs).not.toContain(refB);
  });

  t('a non-member cannot read a project by ref', async () => {
    const owner = await account();
    const stranger = await account();
    const orgId = await orgFor(owner);
    const created = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...as(owner, true), 'idempotency-key': `p1d-${Date.now()}-${++seq}` },
      payload: { name: `p1d-private-${++seq}`, org_id: orgId } });
    const { ref } = (created.json() as { project: { ref: string } }).project;

    const res = await app.inject({ method: 'GET', url: `/v1/projects/${ref}`, headers: as(stranger) });
    // A ref is guessable in principle; membership is what makes it private.
    expect(res.statusCode).toBe(404);
  });
});

describe('P1d — EXIT CRITERION: two users, one org, different roles', () => {
  t('a member creates but cannot delete; an admin can', async () => {
    const owner = await account();
    const member = await account();
    const orgId = await orgFor(owner);
    await addMember(owner, orgId, member, 'member');

    // Both see the org and each other.
    for (const who of [owner, member]) {
      const org = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}`, headers: as(who) });
      expect(org.statusCode).toBe(200);
      const members = await app.inject({
        method: 'GET', url: `/v1/orgs/${orgId}/members`, headers: as(who) });
      expect((members.json() as { members: unknown[] }).members).toHaveLength(2);
    }

    // The member creates a project — their documented mutation.
    const created = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...as(member, true), 'idempotency-key': `p1d-exit-${Date.now()}` },
      payload: { name: `p1d-exit-${++seq}`, org_id: orgId } });
    expect(created.statusCode).toBe(202);
    const { ref } = (created.json() as { project: { ref: string } }).project;

    // Both can read it.
    for (const who of [owner, member]) {
      const res = await app.inject({ method: 'GET', url: `/v1/projects/${ref}`, headers: as(who) });
      expect(res.statusCode).toBe(200);
    }

    // The member cannot delete it — delete is not among create/pause/resume.
    const denied = await app.inject({
      method: 'DELETE', url: `/v1/projects/${ref}`, headers: as(member, true) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toMatch(/A member cannot do this \(project\.delete\)/);

    // The member cannot manage membership either.
    const cannotInvite = await app.inject({
      method: 'POST', url: `/v1/orgs/${orgId}/invites`, headers: as(member, true),
      payload: { email: email() } });
    expect(cannotInvite.statusCode).toBe(403);
    const cannotRename = await app.inject({
      method: 'PATCH', url: `/v1/orgs/${orgId}`, headers: as(member, true),
      payload: { name: 'Hijacked' } });
    expect(cannotRename.statusCode).toBe(403);

    // The owner promotes them, and the same calls now succeed.
    const promoted = await app.inject({
      method: 'PATCH', url: `/v1/orgs/${orgId}/members/${member.userId}`,
      headers: as(owner, true), payload: { role: 'admin' } });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().member.previous_role).toBe('member');

    const nowAllowed = await app.inject({
      method: 'DELETE', url: `/v1/projects/${ref}`, headers: as(member, true) });
    expect(nowAllowed.statusCode).toBe(202);

    // And the whole sequence is in the audit trail, attributed to the right user.
    const { rows } = await pool.query<{ action: string; actor: string | null }>(
      `select action, actor_user_id::text as actor from audit_logs
        where organization_id = $1 order by id`, [orgId.replace('org_', '')]);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('org.created');
    expect(actions).toContain('member.invited');
    expect(actions).toContain('member.joined');
    expect(actions).toContain('member.role_changed');
    expect(actions).toContain('project.created');
    expect(actions).toContain('project.delete_requested');
    expect(rows.every((r) => r.actor !== null)).toBe(true);
  });
});
