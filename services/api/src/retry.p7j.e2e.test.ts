import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@steadhold/crypto';
import { createSecretStore } from '@steadhold/secrets';
import { buildApp } from './app.ts';
import { createUserStore } from './modules/auth/store.ts';
import { createOrgStore } from './modules/orgs/store.ts';
import { createTokenStore } from './kernel/tokens.ts';
import { createMemorySessionStore, SESSION_COOKIE, CSRF_HEADER } from './kernel/sessions.ts';
import { createMemoryRateLimiter } from './kernel/rate-limit.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';

/**
 * P7j: `POST /v1/projects/:ref/retry`.
 *
 * What needs testing is not that an UPDATE runs. It is the four ways a retry can
 * be wrong:
 *
 *  - retrying something that has not failed, which must refuse and *name* the
 *    state rather than quietly enqueueing work;
 *  - a project marked failed with no dead-lettered build behind it, which is a
 *    different refusal and must not invent a job to run;
 *  - the **checkpoint**, which has to survive — the saga is check-then-act, and a
 *    retry that wiped it would redo minutes of container work;
 *  - and the delivery id, which must differ on each retry. `enqueueRecovery`
 *    falls back to `key#recover-N`, so an N that does not increase makes the
 *    second retry a silent no-op. The count comes from the audit trail, which is
 *    the part worth asserting.
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const PASSWORD = 'a-perfectly-fine-password';

let pool: Pool; let up = false; let reason = ''; let kekDir: string;
let app: ReturnType<typeof buildApp>;
/** Every recovery delivery the route asked for, in order. */
let deliveries: Array<{ key: string; attempt: number }> = [];

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 8, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'sh-kek-p7j-'));
  writeFileSync(join(kekDir, 'kek_2026_08.key'), randomBytes(32));
  try {
    const organizationId = await ensureBootstrapOrg(pool);
    const secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    const users = createUserStore(pool);
    const orgStore = createOrgStore(pool);
    const tokens = createTokenStore(pool);
    const sessions = createMemorySessionStore();
    const principals = { sessions, tokens, staticToken: 'static-token' };
    app = buildApp({
      store: createPgStore({ pool, organizationId, secrets }),
      staticToken: 'static-token',
      // Recorded rather than performed: Redis is the worker suite's business, and
      // what this suite must prove is *what the route asks for*.
      enqueueRecovery: async (job, attempt) => {
        deliveries.push({ key: job.idempotency_key, attempt });
      },
      auth: {
        pool, users,
        loginLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
        signupLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
        secureCookies: false, ...principals,
      },
      orgs: { orgs: orgStore, users, ...principals },
      projects: { orgs: orgStore, principals },
      projectSecrets: { secrets },
    });
    up = true;
  } catch (err) { reason = (err as Error).message; up = false; }
}, 20_000);

afterAll(async () => {
  await pool?.end();
  rmSync(kekDir, { recursive: true, force: true });
});

const t = (n: string, fn: () => Promise<void>, ms = 40_000) =>
  it(n, async () => {
    if (!up) throw new Error(`staging control DB not ready (${reason})`);
    deliveries = [];
    await fn();
  }, ms);

let seq = 0;
interface Who { userId: string; email: string; cookie: string; csrf: string }

async function account(): Promise<Who> {
  const addr = `p7j-${Date.now()}-${++seq}@steadhold.test`;
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/signup', payload: { email: addr, password: PASSWORD } });
  const body = res.json() as { user: { id: string }; csrf_token: string };
  return { userId: body.user.id, email: addr, csrf: body.csrf_token,
    cookie: /sh_session=([^;]+)/.exec(String(res.headers['set-cookie']))![1]! };
}
const as = (w: Who, m = false) => ({
  cookie: `${SESSION_COOKIE}=${w.cookie}`, ...(m ? { [CSRF_HEADER]: w.csrf } : {}) });

async function project(owner: Who): Promise<{ ref: string; projectId: string; orgId: string }> {
  const org = await app.inject({ method: 'POST', url: '/v1/orgs', headers: as(owner, true),
    payload: { name: 'Retry', slug: `p7j-${Date.now()}-${++seq}`.slice(0, 40) } });
  const orgId = (org.json() as { org: { id: string } }).org.id;
  const created = await app.inject({
    method: 'POST', url: '/v1/projects',
    headers: { ...as(owner, true), 'idempotency-key': `p7j-${Date.now()}-${++seq}` },
    payload: { name: `p7j-app-${++seq}`, org_id: orgId } });
  const { ref, id } = (created.json() as { project: { ref: string; id: string } }).project;
  return { ref, projectId: id.replace('prj_', ''), orgId };
}

/** Put a project where a dead-lettered provision leaves it (D-452). */
async function deadLettered(projectId: string, checkpoint: string[] = ['create_volume']) {
  await pool.query(
    `UPDATE provisioning_jobs
        SET state = 'dead_letter', attempts = 5, last_error = 'wedged',
            checkpoint = $2::jsonb
      WHERE project_id = $1 AND job_type = 'provision_project'`,
    [projectId, JSON.stringify({ completed: checkpoint })]);
  await pool.query(`UPDATE projects SET status = 'failed' WHERE id = $1`, [projectId]);
}

const retry = (ref: string, w: Who) =>
  app.inject({ method: 'POST', url: `/v1/projects/${ref}/retry`, headers: as(w, true) });

describe('P7j — retrying a failed project', () => {
  t('resets the dead-lettered job and puts the project back to creating', async () => {
    const owner = await account();
    const p = await project(owner);
    await deadLettered(p.projectId);

    const res = await retry(p.ref, owner);
    expect(res.statusCode).toBe(202);
    const body = res.json() as { project: { status: string }; retry: number };
    expect(body.project.status).toBe('creating');
    expect(body.retry).toBe(1);

    const { rows } = await pool.query<{ state: string; attempts: number; last_error: string | null }>(
      `SELECT state::text AS state, attempts, last_error FROM provisioning_jobs
        WHERE project_id = $1 AND job_type = 'provision_project'`, [p.projectId]);
    expect(rows[0]).toMatchObject({ state: 'pending', attempts: 0, last_error: null });
  });

  t('EXIT CRITERION: the checkpoint survives, so completed steps are not redone', async () => {
    const owner = await account();
    const p = await project(owner);
    await deadLettered(p.projectId,
      ['create_volume', 'start_container', 'wait_healthy', 'configure_backups']);

    expect((await retry(p.ref, owner)).statusCode).toBe(202);

    const { rows } = await pool.query<{ checkpoint: { completed?: string[] } | null }>(
      `SELECT checkpoint FROM provisioning_jobs
        WHERE project_id = $1 AND job_type = 'provision_project'`, [p.projectId]);
    /**
     * The **expensive** steps survive; the substrate steps are dropped so they
     * re-verify.
     *
     * This expectation changed, and the reason is a defect the original version
     * hid. Keeping the whole checkpoint is what makes a retry resume rather than
     * rebuild — right for `configure_backups`, which is minutes of work. It is
     * wrong for `start_container`: a checkpoint records what was *done*, not that
     * it still holds, and a skipped step checks nothing. A container removed since
     * (by hand, or by Docker rolling back a start when a port bind failed) left
     * the step marked complete and the next one failing with `could not write
     * pgbackrest.conf (exit null)` — writing into a container that is not there.
     *
     * Re-running the four substrate steps costs seconds because every one of them
     * inspects before it acts.
     */
    expect(rows[0]?.checkpoint?.completed).toEqual(['configure_backups']);
  });

  t('asks for a delivery whose attempt number rises on every retry', async () => {
    const owner = await account();
    const p = await project(owner);
    await deadLettered(p.projectId);

    expect((await retry(p.ref, owner)).statusCode).toBe(202);
    const first = deliveries.at(-1)!;

    // Fail it again, exactly as a second wedge would.
    await deadLettered(p.projectId);
    const second = await retry(p.ref, owner);
    expect(second.statusCode).toBe(202);
    expect((second.json() as { retry: number }).retry).toBe(2);

    // Same key, higher attempt. `enqueueRecovery` derives `key#recover-N` from
    // it, and a repeated N is dropped as a duplicate — which would make the
    // second retry silently do nothing.
    expect(deliveries.at(-1)!.key).toBe(first.key);
    expect(deliveries.at(-1)!.attempt).toBeGreaterThan(first.attempt);
  });

  t('refuses a project that has not failed, and names the state it is in', async () => {
    const owner = await account();
    const p = await project(owner);   // still creating

    const res = await retry(p.ref, owner);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { message: string } }).error.message)
      .toMatch(/is creating, so there is nothing to retry/);
    expect(deliveries).toHaveLength(0);
  });

  t('refuses a failed project with no dead-lettered build behind it', async () => {
    const owner = await account();
    const p = await project(owner);
    // Marked failed by something else — no job gave up.
    await pool.query(`UPDATE projects SET status = 'failed' WHERE id = $1`, [p.projectId]);

    const res = await retry(p.ref, owner);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { message: string } }).error.message)
      .toMatch(/no failed build to retry/i);
    // The point of the refusal: do not invent work.
    expect(deliveries).toHaveLength(0);
  });

  t('is a 404 for an unknown ref, and 401 without a session', async () => {
    const owner = await account();
    expect((await retry('nosuchprojectref0000', owner)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/projects/anything/retry' })).statusCode)
      .toBe(401);
  });

  t('EXIT CRITERION: a member may retry; an outsider gets 404', async () => {
    const owner = await account();
    const p = await project(owner);
    await deadLettered(p.projectId);

    // `project.lifecycle` is a member capability, the same as pause and resume.
    const member = await account();
    await pool.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [p.orgId.replace('org_', ''), member.userId.replace('usr_', '')]);
    expect((await retry(p.ref, member)).statusCode).toBe(202);

    const outsider = await account();
    await deadLettered(p.projectId);
    expect((await retry(p.ref, outsider)).statusCode).toBe(404);
  });

  t('writes an audit row naming the retry', async () => {
    const owner = await account();
    const p = await project(owner);
    await deadLettered(p.projectId);
    await retry(p.ref, owner);

    const { rows } = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_logs
        WHERE project_id = $1 AND action = 'project.retry_requested'`, [p.projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ job_type: 'provision_project', retry: 1 });
  });
});
