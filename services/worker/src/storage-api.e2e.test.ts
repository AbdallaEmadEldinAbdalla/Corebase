import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { sign as signJwt } from '@corebase/jwt';
import { buildApp } from '@corebase/api';
import { createMemoryRateLimiter } from '@corebase/api/kernel/rate-limit.ts';
import { createDocker, type Docker } from './docker.ts';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { IMAGE, POOLER_IMAGE, POSTGREST_IMAGE, LABEL_MANAGED } from './container-spec.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * P6b — bucket CRUD over HTTP, against a genuinely provisioned project.
 *
 * The point of testing this end to end rather than in unit tests is the part
 * that cannot be faked: every route here runs its statement **as the caller**,
 * inside a transaction, with `SET LOCAL ROLE` and the caller's claims — so what
 * is under test is whether the customer's policies actually decide, and a mocked
 * database would answer that question with whatever the mock was told to say.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'p6b-bootstrap-secret-0123456789';
const DOMAIN = 'corebase.test';
const ALICE = '11111111-1111-4111-8111-111111111111';

let pool: Pool; let docker: Docker; let kekDir: string;
let secrets: ReturnType<typeof createSecretStore>;
let app: FastifyInstance;
let ref = ''; let projectId = '';
let anonKey = ''; let serviceKey = '';
let up = false; let reason = '';

beforeAll(async () => {
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-p6b-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  try {
    pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 2000 });
    await pool.query('select 1');
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 120_000 });
    await docker.ping();
    for (const image of [IMAGE, POOLER_IMAGE, POSTGREST_IMAGE]) {
      if (!(await docker.imageExists(image))) {
        throw new Error(`${image} is not on the data node — ./scripts/staging.sh seed-images`);
      }
    }
    secrets = createSecretStore(pool, createEnvelope({ kekDir }));
    await wipeNode();
    await pool.query(
      'truncate provisioning_jobs, project_databases, project_repos, projects, nodes cascade');
    const { rows: org } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('P6b','p6b-test')
       on conflict (slug) do update set updated_at = now() returning id`);
    await registerNode(pool, {
      hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });

    ref = 'p6b' + String(Date.now() % 1000000) + 'xxxxxxxxxxx';
    const { rows } = await pool.query<{ id: string }>(
      `insert into projects (organization_id, ref, name, plan, status)
       values ($1, $2, 'storage-api', 'free', 'creating') returning id`, [org[0]!.id, ref]);
    projectId = rows[0]!.id;

    // The real saga, every step: the storage tables' ownership transfer happens
    // inside `create_base_roles`, so a fixture assembled by hand would test a
    // schema no project actually gets.
    const sagas = buildSagas({
      pool, docker, secrets, bootstrapSecret: SECRET,
      healthTimeoutMs: 180_000, projectDomain: DOMAIN,
    });
    const job = { id: 'p6b', project_id: projectId } as unknown as JobRecord;
    for (const step of sagas['provision_project'] as SagaStep<SagaContext>[]) {
      await step.run({ job, log: () => {} });
    }
    anonKey = (await secrets.get(projectId, SECRET_NAMES.anonKey))!;
    serviceKey = (await secrets.get(projectId, SECRET_NAMES.serviceRoleKey))!;

    app = buildApp({
      storage: {
        pool, secrets, projectDomain: DOMAIN,
        limiter: createMemoryRateLimiter({ limit: 10_000, windowSeconds: 60 }),
      },
    });
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P6b setup FAILED:', reason);
    up = false;
  }
}, 300_000);

async function wipeNode() {
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id, true, false).catch(() => {});
  }
  for (const n of await docker.listNetworks(`${LABEL_MANAGED}=true`)) {
    await docker.removeNetwork(n.Name).catch(() => {});
  }
  for (const v of await docker.listVolumes(`${LABEL_MANAGED}=true`)) {
    await docker.removeVolume(v.Name).catch(() => {});
  }
}

afterAll(async () => {
  await app?.close();
  if (docker) await wipeNode().catch(() => {});
  await pool?.end().catch(() => {});
  docker?.close?.();
  rmSync(kekDir, { recursive: true, force: true });
}, 120_000);

const t = (n: string, fn: () => Promise<void>, ms = 90_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P6b preconditions not met (${reason}) — `
      + './scripts/staging.sh up && seed-images. '
      + 'This is the P6b done-signal and must not skip silently.');
    await fn();
  }, ms);

/** A user access token, signed by the project's own key — a real session's shape. */
async function userToken(sub: string): Promise<string> {
  const [priv, kid] = await Promise.all([
    secrets.get(projectId, SECRET_NAMES.jwtPrivateKey),
    secrets.get(projectId, SECRET_NAMES.jwtKid),
  ]);
  const now = Math.floor(Date.now() / 1000);
  // `session_id` is part of an access token's shape, not decoration: the bearer
  // verifier requires it, because a project API key is otherwise a valid JWT
  // under the same keypair with the same issuer family — the role and the
  // session id together are what separate "a user" from "a project key". A
  // fixture minting one without it is not minting an access token.
  return signJwt({
    iss: `https://${ref}.${DOMAIN}/auth/v1`, ref, role: 'authenticated', sub,
    aud: 'authenticated', session_id: '99999999-9999-4999-8999-999999999999',
    iat: now, exp: now + 3600,
  } as Parameters<typeof signJwt>[0], { privateKeyPem: priv!, kid: kid! });
}

const call = (
  method: string, url: string,
  opts: { key?: string; bearer?: string; body?: unknown } = {},
) => app.inject({
  method: method as 'GET', url,
  headers: {
    ...(opts.key ? { apikey: opts.key } : {}),
    ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
  },
  ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
});

/** SQL as the project's owner — the customer's voice, for writing policies. */
async function asOwner(sql: string): Promise<void> {
  const { rows } = await pool.query<{ port: number }>(
    `select port from project_databases where project_id = $1`, [projectId]);
  const pw = (await secrets.get(projectId, SECRET_NAMES.developer))!;
  const { Client } = await import('pg');
  const client = new Client({
    host: '127.0.0.1', port: rows[0]!.port, database: 'postgres',
    user: 'developer', password: pw, connectionTimeoutMillis: 8000 });
  await client.connect();
  try { await client.query(sql); } finally { await client.end(); }
}

describe('P6b — the front door', () => {
  t('refuses a request with no apikey, and one with somebody else\'s', async () => {
    const none = await call('GET', '/storage/v1/bucket');
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('unauthorized');

    // A syntactically valid token signed by a key that is not this project's.
    const foreign = signJwt(
      { iss: `https://${ref}.${DOMAIN}`, ref, role: 'anon',
        iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 },
      { privateKeyPem: (await import('@corebase/jwt')).generateKeypair().privateKeyPem,
        kid: 'not-ours' });
    expect((await call('GET', '/storage/v1/bucket', { key: foreign })).statusCode).toBe(401);
  });

  t('a broken user token is refused rather than downgraded to anonymous', async () => {
    // The tempting alternative is to ignore an unparseable Authorization header
    // and serve the request as `anon`. That turns "your session expired" into
    // "you have no files", which is the more alarming of the two messages and
    // the wrong one.
    const res = await call('GET', '/storage/v1/bucket',
      { key: anonKey, bearer: 'not.a.jwt' });
    expect(res.statusCode).toBe(401);
  });
});

describe('P6b — bucket CRUD, decided by the customer\'s policies', () => {
  t('service_role creates and lists buckets; anon sees nothing until a policy says so',
    async () => {
      const created = await call('POST', '/storage/v1/bucket',
        { key: serviceKey, body: { name: 'assets', public: true } });
      expect(created.statusCode).toBe(201);
      expect(created.json().bucket).toMatchObject({ name: 'assets', public: true });

      // service_role bypasses RLS by attribute, so it sees the bucket it made.
      const mine = await call('GET', '/storage/v1/bucket', { key: serviceKey });
      expect(mine.json().buckets.map((b: { name: string }) => b.name)).toEqual(['assets']);

      // anon holds the table grant (D-391) and no policy, so the list is empty
      // rather than an error — RLS deciding, not privileges refusing.
      const theirs = await call('GET', '/storage/v1/bucket', { key: anonKey });
      expect(theirs.statusCode).toBe(200);
      expect(theirs.json().buckets).toEqual([]);

      // And a direct fetch is a 404, not a 403: "cannot see it" and "not there"
      // are the same answer, or this endpoint becomes a probe for which buckets
      // exist.
      expect((await call('GET', '/storage/v1/bucket/assets', { key: anonKey })).statusCode)
        .toBe(404);
    });

  t('a policy the customer writes is what opens the list', async () => {
    await asOwner(`
      CREATE POLICY "anyone may see buckets" ON storage.buckets
        FOR SELECT TO anon, authenticated USING (true);`);
    const res = await call('GET', '/storage/v1/bucket', { key: anonKey });
    expect(res.json().buckets.map((b: { name: string }) => b.name)).toEqual(['assets']);

    // Writes are still refused: the policy granted SELECT only, and a 403 here
    // is the honest answer because the caller can see the thing they may not
    // change.
    const denied = await call('POST', '/storage/v1/bucket',
      { key: anonKey, body: { name: 'sneaky' } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden');
  });

  t('an authenticated user is authenticated, not anon', async () => {
    // The role a request runs as comes from the apikey *and* the bearer token
    // together: an anon key plus a user token is `authenticated`, which is what
    // makes `auth.uid()` mean anything inside a storage policy.
    await asOwner(`
      CREATE POLICY "signed-in users manage buckets" ON storage.buckets
        FOR ALL TO authenticated USING (true) WITH CHECK (true);`);
    const token = await userToken(ALICE);
    const created = await call('POST', '/storage/v1/bucket',
      { key: anonKey, bearer: token, body: { name: 'user-made' } });
    expect(created.statusCode).toBe(201);
    // Same key, no token: still anon, still refused. The difference is the token
    // and nothing else.
    expect((await call('POST', '/storage/v1/bucket',
      { key: anonKey, body: { name: 'anon-made' } })).statusCode).toBe(403);
  });

  t('PATCH changes only what was sent', async () => {
    const before = (await call('GET', '/storage/v1/bucket/assets', { key: serviceKey }))
      .json().bucket;
    expect(before.public).toBe(true);

    const patched = await call('PATCH', '/storage/v1/bucket/assets',
      { key: serviceKey, body: { file_size_limit: 1024 } });
    expect(patched.statusCode).toBe(200);
    // `public` was not in the body and must not have moved. A PATCH that reset
    // it to the column default would be a security change made by an absent key.
    expect(patched.json().bucket).toMatchObject({ public: true, file_size_limit: 1024 });

    const empty = await call('PATCH', '/storage/v1/bucket/assets',
      { key: serviceKey, body: {} });
    expect(empty.statusCode).toBe(400);
  });

  t('DELETE refuses a bucket that still holds objects', async () => {
    await call('POST', '/storage/v1/bucket', { key: serviceKey, body: { name: 'occupied' } });
    await asOwner(`
      insert into storage.objects (bucket_id, name, size, etag)
      values (storage.bucket_id('occupied'), 'a.txt', 3, 'e1');`);

    const refused = await call('DELETE', '/storage/v1/bucket/occupied', { key: serviceKey });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('bucket_not_empty');

    await asOwner(`delete from storage.objects where name = 'a.txt';`);
    expect((await call('DELETE', '/storage/v1/bucket/occupied', { key: serviceKey })).statusCode)
      .toBe(204);
    expect((await call('GET', '/storage/v1/bucket/occupied', { key: serviceKey })).statusCode)
      .toBe(404);
  });

  t('validates the bucket name before Postgres has to', async () => {
    for (const bad of ['A', 'has space', '-leading', 'x', '']) {
      const res = await call('POST', '/storage/v1/bucket', { key: serviceKey, body: { name: bad } });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.code, bad).toBe('validation_failed');
    }
    // The control: a legal name with every allowed character class.
    const ok = await call('POST', '/storage/v1/bucket',
      { key: serviceKey, body: { name: 'a0.b_c-d' } });
    expect(ok.statusCode).toBe(201);
  });

  t('a duplicate bucket name is a 409, not a 500', async () => {
    const again = await call('POST', '/storage/v1/bucket',
      { key: serviceKey, body: { name: 'assets' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('conflict');
  });
});
