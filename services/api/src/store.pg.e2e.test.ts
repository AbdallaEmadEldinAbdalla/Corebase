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
const URL_ = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';

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

/**
 * P3d/P3e — what `requestRestore` writes, and what comes back.
 *
 * The store's half of the restore: a *new* project, its lineage, its deadline and
 * its job, all in one transaction. A partial version is worse than a failure — a
 * project row with no restore row is a `restoring` project the saga cannot explain,
 * and a restore row with no job is a project that stays `restoring` forever.
 */
describe('requestRestore', () => {
  const mkReady = async () => {
    const ref = generateProjectRef();
    const created = await store.createProject({
      ref, name: 'src-' + ref.slice(0, 6), region: 'eu-central', plan: 'free',
      idempotencyKey: 'restore-src-' + ref,
    });
    await store.markStatus(ref, 'ready');
    return created.project;
  };

  t('creates a different project, and returns that one', async () => {
    // Production is never overwritten, so the ref in the response is not the ref
    // that was asked about. A method returning the source would describe the wrong
    // object, and a caller polling it would watch the original forever.
    const source = await mkReady();
    const target = new Date(Date.now() - 60_000);
    const result = await store.requestRestore!({
      ref: source.ref, targetTime: target, newRef: generateProjectRef(), ttlHours: 48,
    });
    expect(result).toBeDefined();
    expect('project' in result!).toBe(true);
    const r = result as { project: { ref: string; status: string }; job: { kind: string };
      source: { ref: string }; expiresAt: Date };
    expect(r.project.ref).not.toBe(source.ref);
    expect(r.project.status).toBe('restoring');
    expect(r.source.ref).toBe(source.ref);
    expect(r.job.kind).toBe('restore_project');

    // The deadline exists from the moment the copy does. A nullable column filled
    // in later is a copy that lives forever if the later step is ever skipped.
    const { rows } = await pool.query<{
      source_ref: string; target_time: Date; expires_at: Date; status: string;
    }>(`select source_ref, target_time, expires_at, status from project_restores
         where source_ref = $1`, [source.ref]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('running');
    expect(rows[0]!.expires_at).not.toBeNull();
    const hours = (rows[0]!.expires_at.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThan(49);
  });

  t('writes an audit row naming the source, with the copy in its metadata', async () => {
    // Earning the entry in audit.p1.e2e's allowlist rather than just satisfying
    // it: that guard checks a list of route names, so without this the list could
    // say a route is audited while the route audited nothing.
    //
    // The resource is the *source*, because "who asked to restore this project" is
    // the question anyone reviewing the log brings. The copy's ref is in the
    // metadata, which is how the trail runs forward.
    const source = await mkReady();
    const r = await store.requestRestore!({
      ref: source.ref, newRef: generateProjectRef(), targetTime: new Date(Date.now() - 60_000),
    }) as { project: { ref: string } };

    const { rows } = await pool.query<{ action: string; resource_id: string; metadata: string }>(
      `select action, resource_id, metadata::text as metadata from audit_logs
        where action = 'project.restore_requested' order by created_at desc limit 1`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resource_id).toBe(source.ref);
    expect(rows[0]!.metadata).toContain(r.project.ref);
    expect(rows[0]!.metadata).toContain('target_time');
  });

  t('leaves the source untouched and still ready', async () => {
    const source = await mkReady();
    await store.requestRestore!({ ref: source.ref, newRef: generateProjectRef() });
    const after = await store.getProject(source.ref);
    expect(after!.status).toBe('ready');
  });

  t('honours a shorter window, and never exceeds a week', async () => {
    const source = await mkReady();
    const r = await store.requestRestore!({
      ref: source.ref, newRef: generateProjectRef(), ttlHours: 1,
    }) as { expiresAt: Date };
    const hours = (r.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(0.9);
    expect(hours).toBeLessThan(1.2);
  });

  t('refuses a project that has no backup to restore', async () => {
    // `creating` never finished provisioning, so there is nothing in its repo. A
    // conflict names the state; a 404 would send the caller hunting a bug that is
    // not there.
    const ref = generateProjectRef();
    await store.createProject({
      ref, name: 'half-' + ref.slice(0, 6), region: 'eu-central', plan: 'free',
      idempotencyKey: 'restore-half-' + ref,
    });
    const result = await store.requestRestore!({ ref, newRef: generateProjectRef() });
    expect(result).toMatchObject({ conflict: 'creating' });
  });

  t('refuses when the organization is at its project ceiling', async () => {
    // A restore consumes a real node slot, so it counts. Uncomfortable during an
    // incident, which is exactly when one is wanted — OQ-079 owns the per-plan
    // concurrent-restore policy, and until it exists refusing with the remedy
    // named beats quietly overrunning a limit the rest of the system enforces.
    const source = await mkReady();
    const result = await store.requestRestore!({
      ref: source.ref, newRef: generateProjectRef(), projectsPerOrgLimit: 1,
    });
    expect(result).toHaveProperty('refused');
    expect((result as { refused: string }).refused).toMatch(/already has 1 of its 1/);
    expect((result as { refused: string }).refused).toMatch(/make room/);
  });

  t('reports the lineage and the deadline on the restored project detail', async () => {
    // The customer who needs the deadline is the one coming back two days later,
    // not the one who just pressed the button — so it is on the detail response,
    // not only on the reply to the create.
    const source = await mkReady();
    const r = await store.requestRestore!({
      ref: source.ref, newRef: generateProjectRef(), ttlHours: 48,
    }) as { project: { ref: string } };
    const detail = await store.getProjectDetail(r.project.ref);
    expect(detail!.restore).toBeDefined();
    expect(detail!.restore!.source_ref).toBe(source.ref);
    expect(detail!.restore!.expires_at).toBeTruthy();
  });

  t('says nothing about restores for a project that is not one', async () => {
    const source = await mkReady();
    const detail = await store.getProjectDetail(source.ref);
    expect(detail!.restore).toBeUndefined();
  });
});
