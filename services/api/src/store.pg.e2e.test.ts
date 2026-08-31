import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from './app.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';
import { generateProjectRef } from './kernel/ref.ts';
import type { ControlPlaneStore } from './modules/control-plane/store.ts';

/**
 * Integration tests against the real staging control DB (T2's control node).
 * Skipped when it is not reachable, so `pnpm test` still works offline — but the
 * T4 done-signal requires these to run.
 */
const URL_ = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';

let pool: Pool;
let store: ControlPlaneStore;
let reachable = false;

beforeAll(async () => {
  pool = new Pool({ connectionString: URL_, max: 4, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1');
    reachable = true;
    const organizationId = await ensureBootstrapOrg(pool, 'test');
    store = createPgStore({ pool, organizationId });
  } catch {
    reachable = false;
  }
});
afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  if (!reachable) return;
  await pool.query('truncate provisioning_jobs, project_databases, projects cascade');
});

const t = (name: string, fn: () => Promise<void>) =>
  it(name, async () => { if (!reachable) { console.warn('staging DB unreachable — skipped'); return; } await fn(); });

describe('pg control-plane store', () => {
  t('creates a project in "creating" with the job row in the SAME transaction', async () => {
    const { project, job } = await store.createProject({
      ref: generateProjectRef(), name: 'tx-app', region: 'eu-central', plan: 'free',
      idempotencyKey: 'pg-key-0001',
    });
    expect(project.status).toBe('creating');
    expect(job.kind).toBe('provision_project');

    const { rows } = await pool.query(
      'select p.id as pid, j.id as jid from projects p join provisioning_jobs j on j.project_id = p.id');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pid).toBe(project.id);
  });

  t('rolls the project back when the job insert fails — no orphan project', async () => {
    await store.createProject({
      ref: generateProjectRef(), name: 'first', region: 'eu-central', plan: 'free',
      idempotencyKey: 'collide-key-01',
    });
    // Same idempotency key: the job insert violates its unique constraint, so
    // the whole transaction must roll back and leave no second project behind.
    await expect(store.createProject({
      ref: generateProjectRef(), name: 'second', region: 'eu-central', plan: 'free',
      idempotencyKey: 'collide-key-01',
    })).rejects.toThrow();

    const { rows } = await pool.query('select name from projects order by name');
    expect(rows.map((r) => r.name)).toEqual(['first']);   // "second" never existed
  });

  t('finds a project by idempotency key for replay', async () => {
    const created = await store.createProject({
      ref: generateProjectRef(), name: 'replay-app', region: 'eu-central', plan: 'free',
      idempotencyKey: 'pg-key-replay',
    });
    const found = await store.findByIdempotencyKey('pg-key-replay');
    expect(found?.ref).toBe(created.project.ref);
    expect(await store.findByIdempotencyKey('never-used')).toBeUndefined();
  });

  t('keeps a soft-deleted project visible and hides only a purged one', async () => {
    const { project } = await store.createProject({
      ref: generateProjectRef(), name: 'status-app', region: 'eu-central', plan: 'free',
      idempotencyKey: 'pg-key-status',
    });
    expect((await store.markStatus(project.ref, 'deleting'))?.status).toBe('deleting');
    expect((await store.getProject(project.ref))?.status).toBe('deleting');

    // Soft-deleted is the 7-day recovery window (D-038). Hiding the project here
    // makes the window unusable — the customer cannot see the thing they are
    // meant to be able to restore.
    await pool.query(
      `update projects set status='soft_deleted', deleted_at=now(), purge_after=now()+interval '7 days' where ref=$1`,
      [project.ref]);
    const soft = await store.getProject(project.ref);
    expect(soft?.status).toBe('soft_deleted');
    // The deadline has to be readable, or the recovery window is a promise the
    // customer cannot see the end of.
    expect(soft?.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(soft?.purge_after).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(soft!.purge_after!).getTime())
      .toBeGreaterThan(new Date(soft!.deleted_at!).getTime());
    expect(await store.listProjects()).toHaveLength(1);

    // Purged is gone, and only then does it disappear.
    await pool.query(`update projects set status='deleted' where ref=$1`, [project.ref]);
    expect(await store.getProject(project.ref)).toBeUndefined();
    expect(await store.listProjects()).toHaveLength(0);
  });

  t('serves the HTTP surface end to end against Postgres', async () => {
    const app = buildApp({ store, staticToken: 'tkn' });
    const auth = { authorization: 'Bearer tkn' };
    const created = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'http-key-0001' }, payload: { name: 'http-app' },
    });
    expect(created.statusCode).toBe(202);
    const { ref } = created.json().project;

    const replay = await app.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'http-key-0001' }, payload: { name: 'http-app' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().project.ref).toBe(ref);

    // { project, database } per the platform-API contract; the database block is
    // absent until provisioning writes connection details.
    const got = await app.inject({ method: 'GET', url: `/v1/projects/${ref}`, headers: auth });
    expect(got.json().project.status).toBe('creating');
    expect(got.json().database).toBeUndefined();
    // Absent, not null: a live project has no purge deadline, and an absent
    // field says "not applicable" where a null says "we lost it".
    expect('purge_after' in got.json().project).toBe(false);

    const del = await app.inject({ method: 'DELETE', url: `/v1/projects/${ref}`, headers: auth });
    expect(del.json().project.status).toBe('deleting');
    // Two jobs now: the provision from the create, and the teardown from the
    // delete. The point of the assertion is that the replayed create added none.
    const kinds = (await store.jobs()).map((j) => j.kind).sort();
    expect(kinds).toEqual(['delete_project', 'provision_project']);
  });
});
