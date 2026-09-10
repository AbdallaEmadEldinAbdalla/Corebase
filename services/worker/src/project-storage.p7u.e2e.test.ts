import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@steadhold/crypto';
import { createSecretStore, SECRET_NAMES } from '@steadhold/secrets';
import { buildApp } from '@steadhold/api';
import { createS3, s3FromEnv, type S3 } from '@steadhold/s3';
import { objectKey } from '@steadhold/api/modules/storage/keys.ts';
import { createMemoryRateLimiter } from '@steadhold/api/kernel/rate-limit.ts';
import { createMemorySessionStore, SESSION_COOKIE, CSRF_HEADER } from '@steadhold/api/kernel/sessions.ts';
import { createNullMailer } from '@steadhold/api/modules/project-auth/mail.ts';
import type { Role } from '@steadhold/types';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { IMAGE, LABEL_MANAGED } from './container-spec.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P7u — the dashboard's file browser, against a real project database.
 *
 * ## Why it lives here and not in `services/api`
 *
 * `auth.users` only exists on a genuinely provisioned project, and the whole
 * point of this endpoint is *which role reads it*. A suite with a mocked
 * database would pass with the privilege boundary removed — which is the one
 * thing worth proving, because the reason this module exists at all is that
 * `steadhold_admin` cannot read that table and `steadhold_auth` can.
 *
 * ## What is load-bearing here
 *
 * - **Folders are derived correctly at every depth.** They are not stored:
 *   `storage.objects.name` is a whole path, so a folder is a `substring` and a
 *   `split_part`. The first version returned *nothing* against data that was
 *   plainly there, because an uncast integer parameter made
 *   `substring(x from $n)` take its **regex** overload rather than its offset
 *   one. Typed as a literal the predicate was correct, which is precisely why
 *   the bug survived being checked by hand — so it is checked here with
 *   parameters, at three depths.
 * - **A signed URL is redeemable with no credential**, and only for an object
 *   that exists. That is the point of it and also its risk.
 * - **A delete removes the bytes as well as the row.** The row alone leaves an
 *   orphan the sweep can find; the bytes alone leave a listing that promises a
 *   file which 404s, and nothing repairs that automatically.
 * - **A stranger cannot tell a real ref from an invented one** (D-474).
 */
const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const CERT_DIR = process.env.SH_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.SH_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SH_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

let pool: Pool; let docker: Docker; let orgId: string; let kekDir: string;
let secrets: ReturnType<typeof createSecretStore>;
let s3: S3;
let up = false; let reason = '';

beforeAll(async () => {
  delete process.env['SH_PROJECT_DOMAIN'];
  delete process.env['SH_JWT_ISSUER'];
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'sh-kek-p7u-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    await pool.query('select 1');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 60_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    // The real object store, because the assertion that matters is that the
    // bytes go away — which a fake would satisfy by construction.
    const cfg = s3FromEnv();
    if (!cfg) {
      throw new Error('no object store configured — ./scripts/staging.sh backup-store');
    }
    s3 = createS3(cfg);
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('P7u','p7u-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P7u integration setup FAILED:', reason);
    up = false;
  }
}, 60_000);

const created = { volumes: new Set<string>() };

async function wipeNode() {
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id, true, false).catch(() => {});
  }
  for (const n of await docker.listNetworks(`${LABEL_MANAGED}=true`)) {
    await docker.removeNetwork(n.Name).catch(() => {});
  }
  for (const v of created.volumes) await docker.removeVolume(v).catch(() => {});
  created.volumes.clear();
}

afterAll(async () => {
  if (up) await wipeNode();
  await pool?.end();
  docker?.close?.();
}, 60_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query(
    'truncate provisioning_jobs, project_databases, project_repos, projects, nodes cascade');
  await wipeNode();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 240_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P7u preconditions not met (${reason}) — `
      + './scripts/staging.sh up && seed-images. '
      + 'This is the P7u done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'p' + String(Date.now() % 100000) + String(++seq).padStart(14, 'r');

interface Fixture { id: string; ref: string; anonKey: string; serviceKey: string }

async function provision(): Promise<Fixture> {
  await registerNode(pool, {
    hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,'free','ready') returning id, ref::text as ref`,
    [orgId, ref, 'p7u-' + seq]);
  const p = rows[0]!;
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 120_000 });
  const steps = sagas['provision_project']!;
  const job = { id: 'j', project_id: p.id } as unknown as JobRecord;
  for (const name of ['allocate_node', 'create_volume', 'create_network', 'start_container',
    'wait_healthy', 'create_base_roles', 'store_credentials', 'generate_api_keys',
    'write_connection']) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`the provision saga has no step named ${name}`);
    await step.run({ job, log: () => {} });
  }
  const { rows: place } = await pool.query<{ volume_name: string }>(
    `select volume_name from project_databases where project_id=$1`, [p.id]);
  created.volumes.add(place[0]!.volume_name);
  return {
    ...p,
    anonKey: (await secrets.get(p.id, SECRET_NAMES.anonKey))!,
    serviceKey: (await secrets.get(p.id, SECRET_NAMES.serviceRoleKey))!,
  };
}


/**
 * The API with the data plane and the dashboard's storage surface wired.
 *
 * `orgs.roleOf` is a stub returning `role`, which is the right level of fake:
 * what is under test is the SQL and the byte ordering, not the membership store.
 */
function api(role: Role = 'member') {
  const sessions = createMemorySessionStore();
  const app = buildApp({
    projectAuth: {
      pool, secrets, mailer: createNullMailer(),
      signupLimiter: createMemoryRateLimiter({ limit: 50, windowSeconds: 3600 }),
      loginEmailLimiter: createMemoryRateLimiter({ limit: 50, windowSeconds: 300 }),
      loginIpLimiter: createMemoryRateLimiter({ limit: 200, windowSeconds: 300 }),
      recoverEmailLimiter: createMemoryRateLimiter({ limit: 4, windowSeconds: 3600 }),
      recoverIpLimiter: createMemoryRateLimiter({ limit: 10, windowSeconds: 3600 }),
      verifyIpLimiter: createMemoryRateLimiter({ limit: 30, windowSeconds: 3600 }),
      refreshIpLimiter: createMemoryRateLimiter({ limit: 60, windowSeconds: 300 }),
    },
    storage: {
      pool, secrets,
      limiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 10 }),
      objects: { s3 },
    },
    projectStorage: {
      pool, secrets, s3,
      orgs: { roleOf: async () => role },
      principals: { sessions },
    },
  });
  return { app, sessions };
}

async function signedIn(sessions: ReturnType<typeof createMemorySessionStore>) {
  const s = await sessions.create('00000000-0000-0000-0000-0000000000aa');
  return { cookie: `${SESSION_COOKIE}=${s.id}`, csrf: s.csrf };
}

/** A bucket with files at three depths, uploaded through the real data plane. */
async function seed(app: ReturnType<typeof api>['app'], key: string) {
  const made = await app.inject({
    method: 'POST', url: '/storage/v1/bucket', headers: { apikey: key },
    payload: { name: 'files', public: false } });
  expect(made.statusCode).toBe(201);
  for (const name of ['top.txt', 'a/one.txt', 'a/two.txt', 'a/deep/three.txt', 'b/four.txt']) {
    const up = await app.inject({
      method: 'POST', url: `/storage/v1/object/files/${name}`,
      headers: { apikey: key, 'content-type': 'application/octet-stream' },
      payload: Buffer.from(`bytes of ${name}`) });
    // 201, not 200: an upload creates. Asserted rather than assumed, because a
    // seed helper that tolerates any 2xx hides a broken upload as an empty list.
    expect(up.statusCode, `uploading ${name}`).toBe(201);
  }
}

describe('P7u — the dashboard browses a project\'s files', () => {
  t('EXIT CRITERION: folders are derived correctly at every depth', async () => {
    const p = await provision();
    const { app, sessions } = api();
    const me = await signedIn(sessions);
    await seed(app, p.serviceKey);

    const list = async (prefix: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/projects/${p.ref}/storage/buckets/files/objects`
          + (prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''),
        headers: { cookie: me.cookie } });
      expect(res.statusCode, `listing ${prefix || '(root)'}`).toBe(200);
      return res.json() as {
        folders: { name: string; objects: number }[];
        objects: { name: string; path: string; size: number }[];
      };
    };

    // The root: one file, two folders, and the counts are of everything
    // beneath them rather than of their immediate children.
    const root = await list('');
    expect(root.folders.map((f) => [f.name, f.objects]))
      .toEqual([['a/', 3], ['b/', 1]]);
    expect(root.objects.map((o) => o.name)).toEqual(['top.txt']);

    // One level down: a nested folder *and* files beside it, which is the case
    // a naive "group by first segment" gets wrong.
    const a = await list('a/');
    expect(a.folders.map((f) => f.name)).toEqual(['deep/']);
    expect(a.objects.map((o) => o.name)).toEqual(['one.txt', 'two.txt']);
    // The leaf is shown and the whole path is carried, because the row needs
    // one and every action needs the other.
    expect(a.objects.map((o) => o.path)).toEqual(['a/one.txt', 'a/two.txt']);

    const deep = await list('a/deep/');
    expect(deep.folders).toEqual([]);
    expect(deep.objects.map((o) => o.name)).toEqual(['three.txt']);
    expect(deep.objects[0]!.size).toBeGreaterThan(0);
    await app.close();
  });

  t('the bucket list carries counts, and an empty bucket reads zero', async () => {
    const p = await provision();
    const { app, sessions } = api();
    const me = await signedIn(sessions);
    await seed(app, p.serviceKey);
    await app.inject({ method: 'POST', url: '/storage/v1/bucket',
      headers: { apikey: p.serviceKey }, payload: { name: 'empty', public: false } });

    const res = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/storage/buckets`,
      headers: { cookie: me.cookie } });
    const buckets = (res.json() as {
      buckets: { name: string; objects: number; bytes: number }[] }).buckets;
    const byName = Object.fromEntries(buckets.map((b) => [b.name, b]));
    expect(byName['files']!.objects).toBe(5);
    expect(byName['files']!.bytes).toBeGreaterThan(0);
    // `sum` over no rows is null; 0 is the honest rendering, and a bucket that
    // vanished from the list would be the alternative to the LEFT JOIN.
    expect(byName['empty']!.objects).toBe(0);
    expect(byName['empty']!.bytes).toBe(0);
    await app.close();
  });

  t('EXIT CRITERION: a signed URL is redeemable with no credential at all',
    async () => {
    const p = await provision();
    const { app, sessions } = api();
    const me = await signedIn(sessions);
    await seed(app, p.serviceKey);

    const signed = await app.inject({
      method: 'POST', url: `/v1/projects/${p.ref}/storage/sign`,
      headers: { cookie: me.cookie, [CSRF_HEADER]: me.csrf },
      payload: { bucket: 'files', path: 'a/deep/three.txt', expires_in: 300 } });
    expect(signed.statusCode).toBe(200);
    const { path } = signed.json() as { path: string };

    // No apikey, no cookie: the token is the credential. That is the whole
    // point of the feature and the reason minting one is audited.
    const got = await app.inject({ method: 'GET', url: path });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.toString()).toBe('bytes of a/deep/three.txt');
    await app.close();
  });

  t('signing refuses an object that does not exist', async () => {
    const p = await provision();
    const { app, sessions } = api();
    const me = await signedIn(sessions);
    await seed(app, p.serviceKey);
    const res = await app.inject({
      method: 'POST', url: `/v1/projects/${p.ref}/storage/sign`,
      headers: { cookie: me.cookie, [CSRF_HEADER]: me.csrf },
      payload: { bucket: 'files', path: 'not/here.txt' } });
    // A URL to a 404 looks like a working share until somebody clicks it.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
    await app.close();
  });

  t('EXIT CRITERION: a delete removes the bytes as well as the row', async () => {
    const p = await provision();
    const { app, sessions } = api();
    const me = await signedIn(sessions);
    await seed(app, p.serviceKey);

    const del = await app.inject({
      method: 'POST', url: `/v1/projects/${p.ref}/storage/delete`,
      headers: { cookie: me.cookie, [CSRF_HEADER]: me.csrf },
      payload: { bucket: 'files', paths: ['a/one.txt', 'b/four.txt'] } });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { deleted: number }).deleted).toBe(2);

    // Gone from the metadata...
    const after = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/storage/buckets/files/objects?prefix=a%2F`,
      headers: { cookie: me.cookie } });
    expect((after.json() as { objects: { name: string }[] }).objects.map((o) => o.name))
      .toEqual(['two.txt']);

    /**
     * ...and gone from the **store**, asked of the store directly.
     *
     * The first version of this assertion fetched the object through the data
     * plane and expected a 404 — which it got, from the *metadata* lookup, with
     * the bytes still sitting there. So it was a second copy of the assertion
     * above wearing a different name, and it passed with the byte deletion
     * commented out. Proven by doing exactly that.
     */
    const still = await s3.headObject(objectKey(p.ref, 'files', 'a/one.txt'));
    expect(still.exists, 'the row went and the bytes stayed — an orphan')
      .toBe(false);
    // And the control: an object nobody deleted is still there, so a passing
    // assertion above cannot be a store that answers 404 for everything.
    const kept = await s3.headObject(objectKey(p.ref, 'files', 'a/two.txt'));
    expect(kept.exists).toBe(true);
    expect(kept.size).toBeGreaterThan(0);
    await app.close();
  });

  t('a mutation without the CSRF header is refused', async () => {
    const p = await provision();
    const { app, sessions } = api();
    const me = await signedIn(sessions);
    const res = await app.inject({
      method: 'POST', url: `/v1/projects/${p.ref}/storage/delete`,
      headers: { cookie: me.cookie }, payload: { bucket: 'files', paths: ['x'] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_REQUIRED');
    await app.close();
  });

  t('no session cannot tell a real ref from an invented one', async () => {
    const p = await provision();
    const { app } = api();
    const real = await app.inject({
      method: 'GET', url: `/v1/projects/${p.ref}/storage/buckets` });
    const fake = await app.inject({
      method: 'GET', url: '/v1/projects/nosuchprojectref00/storage/buckets' });
    expect(real.statusCode).toBe(fake.statusCode);
    expect(real.json().error.code).toBe(fake.json().error.code);
    await app.close();
  });
});
