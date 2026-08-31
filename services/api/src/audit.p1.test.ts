import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';
import { readProjectAudit } from '@corebase/audit';

/**
 * P1b: "every mutating endpoint writes an audit row" is a Phase-1 exit criterion,
 * so it needs a test that keeps being true rather than one that was true once.
 *
 * The guard at the bottom is that test: it enumerates the app's mutating routes
 * and fails when one appears that is not on the audited list. A new endpoint then
 * cannot merge without either an audit row or a deliberate, visible exemption.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const TOKEN = 'audit-token';
const auth = { authorization: `Bearer ${TOKEN}` };

let pool: Pool; let store: ReturnType<typeof createPgStore>;
let actorUserId: string | null = null;
let up = false; let reason = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 1500 });
  try {
    const organizationId = await ensureBootstrapOrg(pool);
    const { rows } = await pool.query<{ id: string }>(
      `select id from users where email = 'dev@corebase.local'`);
    actorUserId = rows[0]?.id ?? null;
    store = createPgStore({ pool, organizationId });
    up = true;
  } catch (err) { reason = (err as Error).message; up = false; }
}, 20_000);
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  if (!up) return;
  // audit_logs is append-only, so it cannot be truncated as the app role — and
  // this suite runs as the owner, whose trigger also refuses. Scope assertions to
  // the project under test instead of clearing the table.
  await pool.query('truncate provisioning_jobs, project_databases, projects cascade');
});

const t = (n: string, fn: () => Promise<void>) =>
  it(n, async () => {
    if (!up) throw new Error(
      `staging control DB not reachable or not migrated (${reason}) — ` +
      './scripts/staging.sh up && ./scripts/migrate-staging.sh');
    await fn();
  }, 20_000);

const app = () => buildApp({
  store, staticToken: TOKEN, ...(actorUserId ? { actorUserId } : {}),
});

let seq = 0;
const key = () => `audit-key-${Date.now()}-${++seq}`;

async function createProject(a = app()) {
  const res = await a.inject({
    method: 'POST', url: '/v1/projects',
    headers: { ...auth, 'idempotency-key': key() },
    payload: { name: `audit-app-${++seq}` },
  });
  return res.json() as { id: string; ref: string };
}

describe('P1b — mutations write their audit row', () => {
  t('project.created, attributed to the actor and the request', async () => {
    const a = app();
    const res = await a.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': key(), 'x-request-id': 'req_audit_probe' },
      payload: { name: `audit-app-${++seq}` },
    });
    const project = res.json() as { id: string; ref: string };

    const rows = await readProjectAudit(pool, project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('project.created');
    expect(rows[0]!.resource_type).toBe('project');
    expect(rows[0]!.resource_id).toBe(project.ref);
    expect(rows[0]!.actor_type).toBe(actorUserId ? 'user' : 'system');
    expect(rows[0]!.actor_user_id).toBe(actorUserId);
    // D-032: the audit row and the request's log lines join on this.
    expect(rows[0]!.request_id).toBe('req_audit_probe');
  });

  t('project.delete_requested, carrying the status it came from', async () => {
    const a = app();
    const project = await createProject(a);
    await a.inject({ method: 'DELETE', url: `/v1/projects/${project.ref}`, headers: auth });

    const rows = await readProjectAudit(pool, project.id);
    expect(rows.map((r) => r.action)).toEqual(['project.delete_requested', 'project.created']);
    // The one fact someone asking "why is my project gone" needs.
    expect(rows[0]!.metadata['previous_status']).toBe('creating');
  });

  t('the audit row is written in the mutation\'s transaction', async () => {
    // The property the whole module exists for: if the mutation rolls back, so
    // does its audit row. Forced here by a duplicate name, which fails after the
    // project insert would have happened.
    const a = app();
    const name = `audit-tx-${Date.now()}`;
    await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': key() }, payload: { name } });
    const before = await pool.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where metadata->>'name' = $1`, [name]);

    const dup = await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': key() }, payload: { name } });
    expect(dup.statusCode).toBe(409);

    const after = await pool.query<{ n: number }>(
      `select count(*)::int as n from audit_logs where metadata->>'name' = $1`, [name]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);   // the rejected create audited nothing
  });

  t('a replayed create does not audit twice', async () => {
    const a = app();
    const k = key();
    const first = await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': k }, payload: { name: `audit-replay-${++seq}` } });
    const project = first.json() as { id: string };
    await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': k }, payload: { name: `audit-replay-${seq}` } });

    // One project, one audit row. A retry is not an event.
    expect(await readProjectAudit(pool, project.id)).toHaveLength(1);
  });

  t('a repeated delete does not audit twice', async () => {
    const a = app();
    const project = await createProject(a);
    await a.inject({ method: 'DELETE', url: `/v1/projects/${project.ref}`, headers: auth });
    await a.inject({ method: 'DELETE', url: `/v1/projects/${project.ref}`, headers: auth });
    const rows = await readProjectAudit(pool, project.id);
    expect(rows.filter((r) => r.action === 'project.delete_requested')).toHaveLength(1);
  });

  t('metadata never contains a credential', async () => {
    // audit_logs is append-only: a secret written here can never be removed.
    const a = app();
    const project = await createProject(a);
    const rows = await readProjectAudit(pool, project.id);
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/-----BEGIN/);
    expect(blob).not.toMatch(/postgres:\/\/[^:]+:[^@]+@/);
    expect(blob).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});

describe('P1b — the guard that keeps the exit criterion true', () => {
  /**
   * Routes known to write an audit row. Adding a mutating endpoint without
   * adding it here fails the test below — which is the point: the exit criterion
   * says *every* mutating endpoint, and a list nobody is forced to update stops
   * being true on the second one.
   */
  const AUDITED = new Set([
    'POST /v1/projects',
    'DELETE /v1/projects/:ref',
  ]);

  it('every mutating route is audited', () => {
    const routes: string[] = [];
    buildApp({ staticToken: TOKEN, onRoute: (r) => routes.push(`${r.method} ${r.url}`) });
    const mutating = routes.filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r));

    expect(mutating.length).toBeGreaterThan(0);
    const unaudited = mutating.filter((r) => !AUDITED.has(r));
    expect(unaudited, `these mutating routes write no audit row: ${unaudited.join(', ')}`)
      .toEqual([]);
  });
});
