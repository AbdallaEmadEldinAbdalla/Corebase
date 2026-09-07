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
import { createS3, s3FromEnv, type S3 } from '@corebase/s3';
import { createDocker, type Docker } from './docker.ts';
import { loadBackupEnv } from './staging-env.ts';
import { createStorageSweep } from './storage-sweep.ts';
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
const BOB = '22222222-2222-4222-8222-222222222222';

let pool: Pool; let docker: Docker; let kekDir: string;
let secrets: ReturnType<typeof createSecretStore>;
let app: FastifyInstance;
let ref = ''; let projectId = '';
let anonKey = ''; let serviceKey = '';
let s3: S3;
let up = false; let reason = '';

beforeAll(async () => {
  loadBackupEnv();
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

    // The real object store, from the same environment the backup path uses.
    // Refusing to run without it rather than skipping the object tests: an
    // upload suite that quietly covers only metadata is worse than one that
    // fails, because it reports green over the untested half.
    const s3cfg = s3FromEnv();
    if (!s3cfg) {
      throw new Error('no object store configured — ./scripts/staging.sh backup-store');
    }
    s3 = createS3(s3cfg);

    app = buildApp({
      storage: {
        pool, secrets, projectDomain: DOMAIN,
        limiter: createMemoryRateLimiter({ limit: 10_000, windowSeconds: 60 }),
        objects: { s3 },
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

/** One scalar, read as the owner. For assertions about platform bookkeeping. */
async function asOwnerQuery(sql: string): Promise<unknown> {
  const { rows } = await pool.query<{ port: number }>(
    `select port from project_databases where project_id = $1`, [projectId]);
  const pw = (await secrets.get(projectId, SECRET_NAMES.postgres))!;
  const { Client } = await import('pg');
  const client = new Client({
    host: '127.0.0.1', port: rows[0]!.port, database: 'postgres',
    user: 'postgres', password: pw, connectionTimeoutMillis: 8000 });
  await client.connect();
  try { return (await client.query(sql)).rows[0]; } finally { await client.end(); }
}

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

/** An upload, exactly as a client makes one: bytes in the body, type in a header. */
const put = (
  bucket: string, path: string, body: Buffer,
  opts: { key?: string; bearer?: string; type?: string; upsert?: boolean; method?: string } = {},
) => app.inject({
  method: (opts.method ?? 'POST') as 'POST',
  url: `/storage/v1/object/${bucket}/${path}`,
  headers: {
    ...(opts.key ? { apikey: opts.key } : {}),
    ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    'content-type': opts.type ?? 'application/octet-stream',
    ...(opts.upsert ? { 'x-upsert': 'true' } : {}),
  },
  payload: body,
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

describe('P6c — the proxied upload path', () => {
  t('stores the bytes, then the row — and the bytes are really in the store', async () => {
    await call('POST', '/storage/v1/bucket', { key: serviceKey, body: { name: 'files' } });

    const res = await put('files', 'a/hello.png', PNG, { key: serviceKey, type: 'image/png' });
    expect(res.statusCode).toBe(201);
    expect(res.json().object).toMatchObject({ name: 'a/hello.png', size: PNG.length });

    // The etag the row carries is the store's, not a locally computed hash —
    // which is the only version of it that lets a later sweep tell "these are
    // the bytes the row describes" from "something overwrote them".
    const head = await s3.headObject(`projects/${ref}/files/a/hello.png`);
    expect(head.exists).toBe(true);
    expect(head.size).toBe(PNG.length);
    expect(res.json().object.etag).toBe(head.etag);
  });

  t('downloads what was uploaded, byte for byte', async () => {
    const res = await app.inject({
      method: 'GET', url: '/storage/v1/object/files/a/hello.png',
      headers: { apikey: serviceKey },
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, PNG)).toBe(0);
    expect(res.headers['content-type']).toBe('image/png');
    // Unconditional, per D-123: a browser that sniffs can be talked into
    // executing an object whose declared type was harmless.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['etag']).toMatch(/^".+"$/);
  });

  t('honours If-None-Match from the row, without fetching the bytes', async () => {
    const first = await app.inject({
      method: 'GET', url: '/storage/v1/object/files/a/hello.png',
      headers: { apikey: serviceKey },
    });
    const etag = String(first.headers['etag']);
    const again = await app.inject({
      method: 'GET', url: '/storage/v1/object/files/a/hello.png',
      headers: { apikey: serviceKey, 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });

  t('honours Range, and says 206 rather than pretending it sent everything', async () => {
    const res = await app.inject({
      method: 'GET', url: '/storage/v1/object/files/a/hello.png',
      headers: { apikey: serviceKey, range: 'bytes=0-7' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(8);
    // The PNG signature, which is what the first eight bytes are.
    expect(Buffer.compare(res.rawPayload, PNG.subarray(0, 8))).toBe(0);
    expect(res.headers['content-range']).toMatch(/^bytes 0-7\//);
  });

  t('POST refuses to overwrite; PUT and x-upsert replace', async () => {
    const bigger = Buffer.concat([PNG, Buffer.alloc(32, 9)]);
    const clash = await put('files', 'a/hello.png', bigger,
      { key: serviceKey, type: 'image/png' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('conflict');

    const upsert = await put('files', 'a/hello.png', bigger,
      { key: serviceKey, type: 'image/png', upsert: true });
    expect(upsert.statusCode).toBe(200);
    expect(upsert.json().object.size).toBe(bigger.length);

    const viaPut = await put('files', 'a/hello.png', PNG,
      { key: serviceKey, type: 'image/png', method: 'PUT' });
    expect(viaPut.statusCode).toBe(200);

    // And the store holds the *replacement*, not both.
    const head = await s3.headObject(`projects/${ref}/files/a/hello.png`);
    expect(head.size).toBe(PNG.length);
  });

  t('an upload the policy refuses leaves no bytes behind', async () => {
    // The F2 case from D-124: the object is written before the row, so a row
    // rejected by RLS leaves an orphan — which the service deletes immediately
    // on a best-effort basis, with the sweep as the backstop. Asserting the
    // immediate cleanup is what keeps "best effort" from meaning "never".
    await call('POST', '/storage/v1/bucket', { key: serviceKey, body: { name: 'closed' } });
    const res = await put('closed', 'nope.bin', Buffer.alloc(16),
      { key: anonKey });
    expect(res.statusCode).toBe(403);
    const head = await s3.headObject(`projects/${ref}/closed/nope.bin`);
    expect(head.exists).toBe(false);
  });

  t('a delete removes the row and then the bytes', async () => {
    await put('files', 'gone.bin', Buffer.alloc(8), { key: serviceKey });
    expect((await s3.headObject(`projects/${ref}/files/gone.bin`)).exists).toBe(true);

    const res = await app.inject({
      method: 'DELETE', url: '/storage/v1/object/files/gone.bin',
      headers: { apikey: serviceKey },
    });
    expect(res.statusCode).toBe(204);
    expect((await s3.headObject(`projects/${ref}/files/gone.bin`)).exists).toBe(false);

    // A second delete is a 404, not a 500 — and not a 204 either, because
    // reporting success for something that was not there hides a client bug.
    expect((await app.inject({
      method: 'DELETE', url: '/storage/v1/object/files/gone.bin',
      headers: { apikey: serviceKey },
    })).statusCode).toBe(404);
  });
});

describe('P6c — enforcement at the storage service (D-123)', () => {
  t('refuses an executable whatever it claims to be', async () => {
    const mz = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]);
    for (const type of ['image/png', 'application/octet-stream']) {
      const res = await put('files', 'evil.bin', mz, { key: serviceKey, type });
      expect(res.statusCode, type).toBe(415);
      expect(res.json().error.code).toBe('mime_type_not_allowed');
      // And the reason is returned rather than swallowed: a caller told only
      // "rejected" retries the same file.
      expect(res.json().error.message).toMatch(/Windows executable/);
    }
    expect((await s3.headObject(`projects/${ref}/files/evil.bin`)).exists).toBe(false);
  });

  t('refuses markup declared as an image — the stored-XSS shape', async () => {
    const res = await put('files', 'x.svg',
      Buffer.from('<script>alert(1)</script>' + ' '.repeat(64)),
      { key: serviceKey, type: 'image/svg+xml' });
    expect(res.statusCode).toBe(415);
  });

  t('serves the two types that execute as attachments', async () => {
    // Storable, not refused — customers legitimately store HTML — but the
    // browser is told not to run it in the origin's context. That serving
    // hygiene is load-bearing in V1, because public objects share the project's
    // own origin.
    await put('files', 'page.html', Buffer.from('<h1>hi</h1>'),
      { key: serviceKey, type: 'text/html' });
    const res = await app.inject({
      method: 'GET', url: '/storage/v1/object/files/page.html',
      headers: { apikey: serviceKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(String(res.headers['content-security-policy'])).toMatch(/sandbox/);
  });

  t('honours the bucket\'s size limit and MIME allowlist', async () => {
    await call('POST', '/storage/v1/bucket', {
      key: serviceKey,
      body: { name: 'tight', file_size_limit: 32, allowed_mime_types: ['image/png'] },
    });
    const tooBig = await put('tight', 'big.png', Buffer.concat([PNG, Buffer.alloc(64)]),
      { key: serviceKey, type: 'image/png' });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe('file_size_limit_exceeded');

    const wrongType = await put('tight', 'a.txt', Buffer.from('hi'),
      { key: serviceKey, type: 'text/plain' });
    expect(wrongType.statusCode).toBe(415);

    // The control: a small PNG is accepted, so the two refusals above are the
    // limits and not a broken bucket.
    const ok = await put('tight', 'small.png', PNG.subarray(0, 24),
      { key: serviceKey, type: 'image/png' });
    expect([201, 200]).toContain(ok.statusCode);
  });

  t('refuses a path that could climb out of the project prefix', async () => {
    for (const bad of ['..%2fescape.bin', 'a%2f..%2fb.bin']) {
      const res = await put('files', bad, Buffer.alloc(8), { key: serviceKey });
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.code).toBe('validation_failed');
    }
  });
});

describe('P6c — listing, filtered by the caller\'s policies', () => {
  t('lists by prefix, pages by keyset, and hides what the policy hides', async () => {
    await call('POST', '/storage/v1/bucket', { key: serviceKey, body: { name: 'listing' } });
    for (const n of ['x/1.txt', 'x/2.txt', 'x/3.txt', 'y/1.txt']) {
      await put('listing', n, Buffer.from(n), { key: serviceKey });
    }
    const all = await call('POST', '/storage/v1/object/list/listing',
      { key: serviceKey, body: { prefix: 'x/' } });
    expect(all.json().objects.map((o: { name: string }) => o.name))
      .toEqual(['x/1.txt', 'x/2.txt', 'x/3.txt']);

    // Keyset paging rather than OFFSET: a bucket someone is uploading into
    // would make offset pagination skip and repeat rows, which for a file
    // listing means a client that misses files without knowing it.
    const page1 = await call('POST', '/storage/v1/object/list/listing',
      { key: serviceKey, body: { prefix: 'x/', limit: 2 } });
    expect(page1.json().objects.length).toBe(2);
    expect(page1.json().next_cursor).toBe('x/2.txt');
    const page2 = await call('POST', '/storage/v1/object/list/listing',
      { key: serviceKey, body: { prefix: 'x/', limit: 2, cursor: 'x/2.txt' } });
    expect(page2.json().objects.map((o: { name: string }) => o.name)).toEqual(['x/3.txt']);
    expect(page2.json().next_cursor).toBeNull();

    // anon has no object policy, so the listing is empty rather than refused —
    // there is no filtering step in the handler at all.
    const asAnon = await call('POST', '/storage/v1/object/list/listing',
      { key: anonKey, body: {} });
    expect(asAnon.statusCode).toBe(200);
    expect(asAnon.json().objects).toEqual([]);
  });

  t('batch delete removes only what the policy permitted', async () => {
    const res = await call('POST', '/storage/v1/object/delete/listing',
      { key: serviceKey, body: { paths: ['x/1.txt', 'x/2.txt'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted.sort()).toEqual(['x/1.txt', 'x/2.txt']);
    for (const n of ['x/1.txt', 'x/2.txt']) {
      expect((await s3.headObject(`projects/${ref}/listing/${n}`)).exists, n).toBe(false);
    }
    // Untouched, because it was not asked for.
    expect((await s3.headObject(`projects/${ref}/listing/x/3.txt`)).exists).toBe(true);

    const tooMany = await call('POST', '/storage/v1/object/delete/listing',
      { key: serviceKey, body: { paths: [] } });
    expect(tooMany.statusCode).toBe(400);
  });

  t('info returns metadata and no bytes', async () => {
    const res = await call('GET', '/storage/v1/object/info/listing/y/1.txt',
      { key: serviceKey });
    expect(res.statusCode).toBe(200);
    expect(res.json().object).toMatchObject({ name: 'y/1.txt', size: 7 });
    expect(res.json().object.etag).toBeTruthy();
  });
});

describe('P6d — signed URLs', () => {
  let signed = '';

  t('minting one requires the object to be visible to the requester', async () => {
    await put('files', 'shared/report.pdf',
      Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.alloc(32)]),
      { key: serviceKey, type: 'application/pdf' });

    // anon has no object policy, so it cannot see the object and must not be
    // able to mint a URL for it. Otherwise this endpoint launders access:
    // "I cannot read it, but here is a link that can."
    const denied = await call('POST', '/storage/v1/object/sign/files/shared/report.pdf',
      { key: anonKey, body: {} });
    expect(denied.statusCode).toBe(404);

    const res = await call('POST', '/storage/v1/object/sign/files/shared/report.pdf',
      { key: serviceKey, body: { expires_in: 600 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().expires_in).toBe(600);
    // Said out loud in the response, because the property is surprising: there is
    // no per-URL kill switch before `exp`.
    expect(res.json().revocable).toBe(false);
    signed = res.json().signed_url;
    expect(signed).toContain('token=');
  });

  t('redeeming needs no apikey at all — the token is the credential', async () => {
    const res = await app.inject({ method: 'GET', url: signed });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    // Never cacheable by an intermediary: the URL is per-recipient, and a shared
    // cache holding it would serve one person's capability to the next.
    expect(String(res.headers['cache-control'])).toMatch(/private/);
    expect(res.rawPayload.length).toBe(36);
  });

  t('EXIT CRITERION: swapping the object in a valid signed URL is refused (ST-2)',
    async () => {
      await put('files', 'shared/secret.pdf',
        Buffer.concat([Buffer.from([0x25, 0x50, 0x44, 0x46]), Buffer.alloc(8)]),
        { key: serviceKey, type: 'application/pdf' });
      // The signature covers the path, so the same token presented for a
      // different object is not a valid signature for that object.
      const swapped = signed.replace('shared/report.pdf', 'shared/secret.pdf');
      const res = await app.inject({ method: 'GET', url: swapped });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
      // And the body says nothing about *why*, so a holder of a bad token cannot
      // use this as an oracle for which objects exist.
      expect(res.json().error.message).not.toMatch(/expired|signature|bucket/i);
    });

  t('an expired URL is refused, and refused identically', async () => {
    const res = await call('POST', '/storage/v1/object/sign/files/shared/report.pdf',
      { key: serviceKey, body: { expires_in: 1 } });
    const url = res.json().signed_url;
    // Works now.
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 1300));
    const after = await app.inject({ method: 'GET', url });
    expect(after.statusCode).toBe(403);
    expect(after.json().error.message).toBe('That signed URL is not valid.');
  });

  t('a tampered token is refused', async () => {
    // Flip a character in the signature half.
    const [base, token] = signed.split('token=');
    const broken = token!.slice(0, -2) + (token!.endsWith('AA') ? 'BB' : 'AA');
    expect((await app.inject({ method: 'GET', url: base + 'token=' + broken })).statusCode)
      .toBe(403);
    // And a missing token is a 401 rather than a 403: nothing was presented, so
    // there is nothing to have been refused.
    expect((await app.inject({
      method: 'GET', url: '/storage/v1/object/sign/files/shared/report.pdf',
    })).statusCode).toBe(401);
  });

  t('clamps a request for a longer life than the documented maximum', async () => {
    const res = await call('POST', '/storage/v1/object/sign/files/shared/report.pdf',
      { key: serviceKey, body: { expires_in: 60 * 60 * 24 * 365 } });
    // Seven days is a ceiling, not a suggestion — a signed URL cannot be revoked,
    // so its lifetime is the only bound on a leak.
    expect(res.json().expires_in).toBe(604_800);
  });
});

describe('P6d — public buckets', () => {
  t('serves without authentication, and lets the CDN cache it', async () => {
    await call('POST', '/storage/v1/bucket', {
      key: serviceKey, body: { name: 'assets-pub', public: true } });
    await put('assets-pub', 'logo.png', PNG, { key: serviceKey, type: 'image/png' });

    const res = await app.inject({
      method: 'GET', url: '/storage/v1/object/public/assets-pub/logo.png',
      headers: { host: `${ref}.${DOMAIN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, PNG)).toBe(0);
    // The free-tier bandwidth story: cache hits never reach our nodes. The
    // honest contract that comes with it is documented staleness up to max-age.
    expect(String(res.headers['cache-control'])).toMatch(/public, max-age=3600/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  t('per-object RLS is skipped, because the bucket is the ACL', async () => {
    // There is no policy on `storage.objects` granting anon anything, and the
    // public read works anyway — deliberately. "Public bucket" means the bucket
    // already answered the permission question for everything in it.
    const asAnon = await call('GET', '/storage/v1/object/assets-pub/logo.png',
      { key: anonKey });
    expect(asAnon.statusCode).toBe(404);      // the authenticated path still denies
    const viaPublic = await app.inject({
      method: 'GET', url: '/storage/v1/object/public/assets-pub/logo.png',
      headers: { host: `${ref}.${DOMAIN}` },
    });
    expect(viaPublic.statusCode).toBe(200);   // the public path does not
  });

  t('a private bucket is a 404 on the public path, not a 403', async () => {
    // A private bucket must not confirm its own existence to an unauthenticated
    // caller probing the public path.
    const res = await app.inject({
      method: 'GET', url: '/storage/v1/object/public/files/shared/report.pdf',
      headers: { host: `${ref}.${DOMAIN}` },
    });
    expect(res.statusCode).toBe(404);
  });

  t('the project comes from the Host, never from the client', async () => {
    // No Host that resolves to a project, no project. A `?ref=` parameter here
    // would make this endpoint a way to read any project's public buckets from
    // any hostname.
    const wrong = await app.inject({
      method: 'GET', url: '/storage/v1/object/public/assets-pub/logo.png',
      headers: { host: `nosuchproject.${DOMAIN}` },
    });
    expect(wrong.statusCode).toBe(404);
    // And a Host outside the project domain resolves to nothing, so a
    // lookalike domain cannot borrow the routing.
    const evil = await app.inject({
      method: 'GET', url: '/storage/v1/object/public/assets-pub/logo.png',
      headers: { host: `${ref}.evil-corebase.test` },
    });
    expect(evil.statusCode).toBe(404);
  });

  t('flipping public off closes the path, once the config cache expires', async () => {
    // The 30-second in-process cache is deliberate (D-051 keeps the control
    // plane off this path), and the doc's own contract is that a `public` flip
    // takes up to 30 s to propagate. Asserted through the *bucket config*, which
    // is read per request, rather than by waiting out the project cache.
    await call('PATCH', '/storage/v1/bucket/assets-pub',
      { key: serviceKey, body: { public: false } });
    const res = await app.inject({
      method: 'GET', url: '/storage/v1/object/public/assets-pub/logo.png',
      headers: { host: `${ref}.${DOMAIN}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('P6e — presigned direct upload', () => {
  /** PUT straight at the object store, exactly as a client would. */
  async function directPut(
    url: string, body: Buffer, headers: Record<string, string>,
  ): Promise<number> {
    const { request } = await import('node:https');
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const r = request({
        host: u.hostname, port: Number(u.port || 443),
        path: u.pathname + u.search, method: 'PUT',
        headers: { ...headers, 'content-length': String(body.length) },
        // The staging store's certificate is self-signed, as everywhere else
        // this repo talks to it.
        rejectUnauthorized: false,
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
  }

  const BIG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 3)]);

  t('EXIT-ADJACENT: sign, upload straight to the store, then complete', async () => {
    const signed = await call('POST', '/storage/v1/object/upload/sign/files/big/photo.png',
      { key: serviceKey, body: { size: BIG.length, content_type: 'image/png' } });
    expect(signed.statusCode).toBe(200);
    const { upload_url: url, upload_id: id, required_headers: required } = signed.json();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);

    // The intent exists and no object row does yet — the gap the intent covers.
    const before = await call('GET', '/storage/v1/object/info/files/big/photo.png',
      { key: serviceKey });
    expect(before.statusCode).toBe(404);

    // The bytes never touch the API. This is the whole point of the path.
    expect(await directPut(url, BIG, required)).toBe(200);

    const done = await call('POST', `/storage/v1/object/upload/complete/${id}`,
      { key: serviceKey, body: {} });
    expect(done.statusCode).toBe(201);
    expect(done.json().object).toMatchObject({ name: 'big/photo.png', size: BIG.length });

    // And the row now describes what the store actually holds — size and etag
    // read back from it rather than believed from the client.
    const head = await s3.headObject(`projects/${ref}/files/big/photo.png`);
    expect(done.json().object.etag).toBe(head.etag);
    expect(head.size).toBe(BIG.length);
    // Downloadable through the ordinary path, which is the proof the two halves
    // produced one coherent object.
    const got = await app.inject({
      method: 'GET', url: '/storage/v1/object/files/big/photo.png',
      headers: { apikey: serviceKey } });
    expect(Buffer.compare(got.rawPayload, BIG)).toBe(0);
  });

  t('the URL is good for exactly the length and type it was signed for', async () => {
    const signed = await call('POST', '/storage/v1/object/upload/sign/files/big/exact.png',
      { key: serviceKey, body: { size: BIG.length, content_type: 'image/png' } });
    const { upload_url: url, required_headers: required } = signed.json();

    // A different length fails the *signature*, not a size check — which is a
    // stronger guarantee than a range would be: the store refuses it before a
    // byte of ours is involved.
    expect(await directPut(url, Buffer.alloc(10), required)).toBeGreaterThanOrEqual(400);
    // And a different content type likewise, so a leaked upload URL cannot be
    // repurposed for another file shape.
    expect(await directPut(url, BIG, { ...required, 'content-type': 'text/html' }))
      .toBeGreaterThanOrEqual(400);
  });

  t('completing before uploading anything is a 409, not a phantom row', async () => {
    const signed = await call('POST', '/storage/v1/object/upload/sign/files/big/never.png',
      { key: serviceKey, body: { size: 64, content_type: 'image/png' } });
    const res = await call('POST',
      `/storage/v1/object/upload/complete/${signed.json().upload_id}`,
      { key: serviceKey, body: {} });
    expect(res.statusCode).toBe(409);
    // No row, because a row referencing bytes that do not exist is exactly what
    // D-124's invariant forbids.
    expect((await call('GET', '/storage/v1/object/info/files/big/never.png',
      { key: serviceKey })).statusCode).toBe(404);
  });

  t('content is sniffed at completion, and a refusal deletes the bytes', async () => {
    // The check the proxied path does inline, deferred here because there was no
    // earlier moment at which the bytes existed. A client can declare `image/png`
    // at signing time and upload a Windows binary — this is where that is caught.
    const mz = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(512, 1)]);
    const signed = await call('POST', '/storage/v1/object/upload/sign/files/big/evil.png',
      { key: serviceKey, body: { size: mz.length, content_type: 'image/png' } });
    const { upload_url: url, upload_id: id, required_headers: required } = signed.json();
    expect(await directPut(url, mz, required)).toBe(200);

    const res = await call('POST', `/storage/v1/object/upload/complete/${id}`,
      { key: serviceKey, body: {} });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.message).toMatch(/Windows executable/);
    // Deleted, not left as an orphan for the sweep to find later: the service
    // knows right now that these bytes are unwanted.
    expect((await s3.headObject(`projects/${ref}/files/big/evil.png`)).exists).toBe(false);
    expect((await call('GET', '/storage/v1/object/info/files/big/evil.png',
      { key: serviceKey })).statusCode).toBe(404);
  });

  t('signing is refused when the caller\'s policy would refuse the row', async () => {
    // The trial insert doing its job. `anon` has no INSERT policy on
    // `storage.objects`, so there is nothing to sign — and the refusal happens
    // *before* a URL exists rather than after gigabytes have moved.
    const res = await call('POST', '/storage/v1/object/upload/sign/files/big/nope.png',
      { key: anonKey, body: { size: 64, content_type: 'image/png' } });
    expect(res.statusCode).toBe(403);
  });

  t('the trial insert leaves nothing behind', async () => {
    // The probe is rolled back, so a signed-but-never-uploaded object must not
    // appear anywhere — not as a row, and not in the project's usage.
    const usageBefore = await asOwnerQuery('select total_bytes::text as b from storage.usage');
    await call('POST', '/storage/v1/object/upload/sign/files/big/probe.png',
      { key: serviceKey, body: { size: 999_999, content_type: 'image/png' } });
    expect((await call('GET', '/storage/v1/object/info/files/big/probe.png',
      { key: serviceKey })).statusCode).toBe(404);
    const usageAfter = await asOwnerQuery('select total_bytes::text as b from storage.usage');
    expect(usageAfter).toEqual(usageBefore);
  });

  t('honours the bucket limit and the project quota before signing anything', async () => {
    const tooBig = await call('POST', '/storage/v1/object/upload/sign/tight/big.png',
      { key: serviceKey, body: { size: 10_000, content_type: 'image/png' } });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe('file_size_limit_exceeded');

    // A size beyond the whole plan's ceiling is refused as a quota problem, which
    // is a different message and a different remedy from the per-file one.
    const beyondPlan = await call('POST', '/storage/v1/object/upload/sign/files/huge.bin',
      { key: serviceKey, body: { size: 2 * 1024 ** 3, content_type: 'application/octet-stream' } });
    expect(beyondPlan.statusCode).toBe(413);
    expect(beyondPlan.json().error.code).toBe('storage_quota_exceeded');
  });

  t('an unknown or malformed upload id is refused cleanly', async () => {
    expect((await call('POST', '/storage/v1/object/upload/complete/not-a-uuid',
      { key: serviceKey, body: {} })).statusCode).toBe(400);
    expect((await call('POST',
      '/storage/v1/object/upload/complete/11111111-1111-4111-8111-111111111111',
      { key: serviceKey, body: {} })).statusCode).toBe(404);
  });
});

describe('P6f — the reconciliation sweep', () => {
  /**
   * The sweep, with the grace window shortened so a test can prove it rather
   * than wait a day. Everything else is the real thing: the real object store,
   * the real project database, the real anti-join.
   */
  const sweep = (graceMs = 0) => createStorageSweep({
    pool, secrets, s3, graceMs, log: () => {},
  });

  t('EXIT CRITERION: an orphan — bytes with no row — is collected', async () => {
    // The F1/F2 crash injected directly: bytes put in the store with no metadata
    // row, which is exactly the state a process death between the two writes
    // leaves behind. Written through the raw client rather than the API, because
    // the API would not leave this state — that is the point of the orderings.
    const key = `projects/${ref}/files/orphan.bin`;
    await s3.putObject(key, Buffer.alloc(2048, 4), { contentType: 'application/octet-stream' });
    expect((await s3.headObject(key)).exists).toBe(true);

    const report = await sweep().sweepOnce();
    expect(report.orphansDeleted).toBeGreaterThanOrEqual(1);
    expect(report.bytesReclaimed).toBeGreaterThanOrEqual(2048);
    expect((await s3.headObject(key)).exists).toBe(false);
    expect(report.failures).toEqual([]);
  });

  t('the grace window protects an upload that is still in flight', async () => {
    // The other half of orphan collection, and the more dangerous half: an
    // object younger than the window may be a request that is going fine, with
    // its row a few milliseconds away. Deleting it would break a working upload,
    // which is worse than paying for a stray object for a day.
    const key = `projects/${ref}/files/inflight.bin`;
    await s3.putObject(key, Buffer.alloc(64), { contentType: 'application/octet-stream' });
    const report = await sweep(60_000).sweepOnce();
    expect((await s3.headObject(key)).exists).toBe(true);
    expect(report.orphansDeleted).toBe(0);
    // And with the window closed it goes, so the protection is the window and
    // not an inability to see the object.
    await sweep(0).sweepOnce();
    expect((await s3.headObject(key)).exists).toBe(false);
  });

  t('a live upload intent protects its key even past the grace window', async () => {
    // The race the window alone does not cover: a presigned upload whose bytes
    // arrived quickly but whose completion callback has not run. The intent is
    // what says "someone is allowed to be mid-flight here".
    const signed = await call('POST', '/storage/v1/object/upload/sign/files/pending.bin',
      { key: serviceKey, body: { size: 128, content_type: 'application/octet-stream' } });
    const key = `projects/${ref}/files/pending.bin`;
    await s3.putObject(key, Buffer.alloc(128), { contentType: 'application/octet-stream' });

    const report = await sweep(0).sweepOnce();
    expect((await s3.headObject(key)).exists).toBe(true);
    expect(report.orphansDeleted).toBe(0);

    // Completing it turns the intent into a row, and the object stays protected
    // for the ordinary reason from then on.
    const done = await call('POST',
      `/storage/v1/object/upload/complete/${signed.json().upload_id}`,
      { key: serviceKey, body: {} });
    expect(done.statusCode).toBe(201);
    await sweep(0).sweepOnce();
    expect((await s3.headObject(key)).exists).toBe(true);
  });

  t('an abandoned intent is expired, and its bytes go with it (F4)', async () => {
    const signed = await call('POST', '/storage/v1/object/upload/sign/files/abandoned.bin',
      { key: serviceKey, body: { size: 256, content_type: 'application/octet-stream' } });
    const id = signed.json().upload_id;
    const key = `projects/${ref}/files/abandoned.bin`;
    await s3.putObject(key, Buffer.alloc(256), { contentType: 'application/octet-stream' });

    // Age the intent past its expiry — the crash being injected is "the client
    // never called complete".
    await asOwnerQuery(
      `update storage.upload_intents set expires_at = now() - interval '1 hour'
        where id = '${id}'`);

    const report = await sweep(0).sweepOnce();
    expect(report.intentsExpired).toBeGreaterThanOrEqual(1);
    expect((await s3.headObject(key)).exists).toBe(false);
    // And completing it afterwards is refused, rather than resurrecting a row
    // whose authorisation has lapsed.
    expect((await call('POST', `/storage/v1/object/upload/complete/${id}`,
      { key: serviceKey, body: {} })).statusCode).toBe(404);
  });

  t('EXIT CRITERION: the other direction — a row with no bytes is quarantined, not deleted',
    async () => {
      // The failure the orderings are supposed to make impossible, injected by
      // deleting the object behind a good row. D-124 calls this a bug rather
      // than a state, so the sweep must *not* tidy it away: auto-deleting the
      // row would erase both the evidence and a file the customer believes they
      // have.
      await put('files', 'vanished.bin', Buffer.alloc(512, 5), { key: serviceKey });
      const key = `projects/${ref}/files/vanished.bin`;
      await s3.deleteObject(key);

      const report = await sweep(0).sweepOnce();
      expect(report.missingObjects).toBeGreaterThanOrEqual(1);

      // The row survives.
      expect((await call('GET', '/storage/v1/object/info/files/vanished.bin',
        { key: serviceKey })).statusCode).toBe(200);

      // And it is on an operator's queue, in the control plane where an operator
      // looking for platform faults will actually find it.
      const { rows } = await pool.query<{ name: string; seen_count: number; size: string }>(
        `select name, seen_count, expected_size::text as size
           from storage_missing_objects
          where project_id = $1 and resolved_at is null`, [projectId]);
      expect(rows.map((r) => r.name)).toContain('vanished.bin');
      expect(rows[0]!.size).toBe('512');

      // A second sweep counts it again rather than duplicating it — a rising
      // count is an ongoing fault, which is a different problem from a one-off.
      await sweep(0).sweepOnce();
      const { rows: again } = await pool.query<{ seen_count: number }>(
        `select seen_count from storage_missing_objects
          where project_id = $1 and name = 'vanished.bin'`, [projectId]);
      expect(again[0]!.seen_count).toBeGreaterThanOrEqual(2);

      // Cleanup, so later assertions about usage are not thrown off by a row
      // with no bytes behind it.
      await call('POST', '/storage/v1/object/delete/files',
        { key: serviceKey, body: { paths: ['vanished.bin'] } });
    });

  t('converges: a second sweep over a healthy project changes nothing', async () => {
    // Convergence in the plain sense — the sweep is idempotent, so running it
    // twice does not keep finding work. A sweep that always reports deletions is
    // a sweep nobody can use to tell whether the system is healthy.
    const first = await sweep(0).sweepOnce();
    expect(first.failures).toEqual([]);
    const second = await sweep(0).sweepOnce();
    expect(second.orphansDeleted).toBe(0);
    expect(second.intentsExpired).toBe(0);
    expect(second.missingObjects).toBe(0);
  });

  t('one unreachable project does not stop the fleet', async () => {
    // A second project whose node address is wrong. The sweep must record it and
    // carry on: aborting the run means one bad node stops garbage collection
    // everywhere, and the fleet is where the cost accumulates.
    const { rows } = await pool.query<{ id: string }>(
      `insert into projects (organization_id, ref, name, plan, status)
       select organization_id, 'p6funreachablexxxxx1', 'unreachable', 'free', 'ready'
         from projects where id = $1 returning id`, [projectId]);
    const bad = rows[0]!.id;
    // The whole row copied through a temp table, then repointed — rather than an
    // explicit column list, which I tried twice and which needed a new column
    // each time (`pooler_port`, then `ram_limit_mb`). This table has grown across
    // three phases and will grow again; a literal insert in a test is a
    // maintenance tax with no benefit, since the only thing this fixture cares
    // about is that the *port* points nowhere.
    await pool.query(
      `create temp table p6f_copy as select * from project_databases where project_id = $1`,
      [projectId]);
    await pool.query(
      // Every uniquely-indexed port moved, `postgrest_admin_port` included —
      // there are four such indexes on this table and two of them are partial,
      // so they do not show up in `pg_constraint`. Found the hard way, one
      // violation at a time.
      `update p6f_copy set id = gen_random_uuid(), project_id = $1, port = 59999,
              pooler_port = 59998, postgrest_port = 59997, postgrest_admin_port = 59996,
              volume_name = 'p6f-nope'`, [bad]);
    await pool.query(`insert into project_databases select * from p6f_copy`);
    await pool.query(`drop table p6f_copy`);
    try {
      const report = await sweep(0).sweepOnce();
      expect(report.failures.map((f) => f.ref)).toContain('p6funreachablexxxxx1');
      // The healthy project was still swept — `projects` counts what was
      // attempted, and the failure list is what did not finish.
      expect(report.projects).toBeGreaterThanOrEqual(2);
    } finally {
      await pool.query(`delete from project_databases where project_id = $1`, [bad]);
      await pool.query(`delete from projects where id = $1`, [bad]);
    }
  });
});

describe('P6f — the quota true-up, and enforcement at the cap', () => {
  t('the true-up corrects a drifted counter from the store\'s own totals', async () => {
    // Drift injected directly: the trigger-maintained counter is set to a lie.
    // The store is the authority, and billing reads the true-up rather than the
    // counter precisely because the counter can drift.
    await asOwnerQuery(`update storage.usage set total_bytes = 999999999`);
    const report = await createStorageSweep({
      pool, secrets, s3, graceMs: 0, log: () => {} }).sweepOnce();
    expect(report.quotaCorrected).toBeGreaterThanOrEqual(1);

    const after = await asOwnerQuery(
      'select total_bytes::text as b, object_count::text as c from storage.usage') as
      { b: string; c: string };
    expect(Number(after.b)).toBeLessThan(999999999);
    // And it matches what the store actually holds for this project.
    const stored = await s3.listDetailed(`projects/${ref}/`);
    expect(Number(after.b)).toBe(stored.reduce((n, o) => n + o.size, 0));
    expect(Number(after.c)).toBe(stored.length);
  });

  t('leaves a counter alone when the drift is within tolerance', async () => {
    // The thresholds exist so the true-up does not fight the trigger over a few
    // bytes: a write between the listing and the read is normal, and rewriting
    // the row every night for that would make the correction meaningless as a
    // signal.
    const before = await asOwnerQuery(
      'select total_bytes::text as b from storage.usage') as { b: string };
    await asOwnerQuery(`update storage.usage set total_bytes = ${Number(before.b) + 10}`);
    const report = await createStorageSweep({
      pool, secrets, s3, graceMs: 0, log: () => {} }).sweepOnce();
    expect(report.quotaCorrected).toBe(0);
  });

  t('EXIT CRITERION: uploads are blocked at the cap, and reads keep working',
    async () => {
      // The pricing doc's contract, in one test: over quota means *uploads
      // rejected, existing files keep serving*. A customer at their limit has a
      // read-only bucket, not a broken product.
      const free = 1 * 1024 ** 3;
      await asOwnerQuery(`update storage.usage set total_bytes = ${free - 16}`);

      const refused = await put('files', 'over-cap.bin', Buffer.alloc(1024),
        { key: serviceKey });
      expect(refused.statusCode).toBe(413);
      expect(refused.json().error.code).toBe('storage_quota_exceeded');
      // Nothing was stored: the check runs before the bytes, so an over-quota
      // upload does not first cost the storage it was refused for.
      expect((await s3.headObject(`projects/${ref}/files/over-cap.bin`)).exists).toBe(false);

      // The presigned path refuses at signing time, before a URL exists.
      const signRefused = await call('POST',
        '/storage/v1/object/upload/sign/files/over-cap-2.bin',
        { key: serviceKey, body: { size: 1024, content_type: 'application/octet-stream' } });
      expect(signRefused.statusCode).toBe(413);
      expect(signRefused.json().error.code).toBe('storage_quota_exceeded');

      // Reads still work — the half of the contract that is easy to break by
      // treating quota as a gate on the whole module.
      const read = await app.inject({
        method: 'GET', url: '/storage/v1/object/files/a/hello.png',
        headers: { apikey: serviceKey } });
      expect(read.statusCode).toBe(200);
      // And so does deleting, which is how a customer gets back under the cap.
      // A quota that blocked deletion would be a trap.
      const deleted = await app.inject({
        method: 'DELETE', url: '/storage/v1/object/files/gone-to-free-space.bin',
        headers: { apikey: serviceKey } });
      expect([204, 404]).toContain(deleted.statusCode);

      // An upsert that *shrinks* an object is allowed at the cap, because only
      // the delta counts — refusing it would leave a customer unable to reduce
      // their own usage through the API they uploaded with.
      const smaller = await put('files', 'a/hello.png', Buffer.alloc(8),
        { key: serviceKey, type: 'image/png', upsert: true });
      expect([200, 201]).toContain(smaller.statusCode);

      // The counter is put back. This test deliberately pins the project at its
      // ceiling, and leaving it there makes every later upload in the file fail
      // with a quota error that has nothing to do with what it was testing —
      // which is precisely what happened before this line existed. A test that
      // clobbers shared state restores it.
      await asOwnerQuery(`update storage.usage set total_bytes = 0`);
    });
});

describe('P6h — an upload by a real user, which every earlier test missed', () => {
  t('a signed-in user can upload into their own folder', async () => {
    // The gap that let a genuine bug ship through five green steps: every upload
    // test until now presented the **service_role** key, which can read
    // `storage.usage`. A real user cannot, so the quota check raised `permission
    // denied` (42501) and the module mapped it to 403 — reporting a policy
    // failure for a policy that was correct.
    //
    // Found by the Phase 6 demo, which was the first caller in the whole
    // codebase to upload as a user rather than as a backend.
    await asOwner(`
      insert into storage.buckets (name, public) values ('user-uploads', false)
        on conflict (name) do nothing;
      create policy "own folder" on storage.objects for all to authenticated
        using (bucket_id = storage.bucket_id('user-uploads')
               and storage.prefix_owner(name) = auth.uid()::text)
        with check (bucket_id = storage.bucket_id('user-uploads')
                    and storage.prefix_owner(name) = auth.uid()::text);
      create policy "read user uploads" on storage.objects for select to authenticated
        using (bucket_id = storage.bucket_id('user-uploads'));`);
    // The uid has to be a real auth user, because `storage.objects.owner`
    // references the table — and the insert runs as the **superuser**, not as the
    // customer. `developer` cannot write `auth.users`, which is exactly what the
    // isolation suite's DB-3 asserts; using `asOwner` here failed with
    // `permission denied for table users` and was the boundary working.
    await asOwnerQuery(`
      insert into auth.users (id, email, encrypted_password, email_confirmed_at)
      values ('${ALICE}', 'p6h-alice@example.com', 'x', now())
      on conflict (id) do nothing`);

    const token = await userToken(ALICE);
    const res = await put('user-uploads', `${ALICE}/photo.png`, PNG,
      { key: anonKey, bearer: token, type: 'image/png' });
    expect(res.statusCode).toBe(201);
    expect(res.json().object).toMatchObject({ size: PNG.length });
    // The row records the *user* as owner, which is what makes the own-folder
    // policy meaningful on every later read.
    const info = await call('GET', `/storage/v1/object/info/user-uploads/${ALICE}/photo.png`,
      { key: serviceKey });
    expect(info.statusCode).toBe(200);
  });

  t('and is refused in somebody else\'s folder, by WITH CHECK', async () => {
    const token = await userToken(ALICE);
    const res = await put('user-uploads', `${BOB}/photo.png`, PNG,
      { key: anonKey, bearer: token, type: 'image/png' });
    expect(res.statusCode).toBe(403);
    // The bytes were never stored: the policy is evaluated before the object
    // store is touched.
    expect((await s3.headObject(`projects/${ref}/user-uploads/${BOB}/photo.png`)).exists)
      .toBe(false);
  });

  t('a user\'s signed upload URL is minted and refused on the same rule', async () => {
    // The presigned path read the same table and had the same bug.
    const token = await userToken(ALICE);
    const own = await call('POST',
      `/storage/v1/object/upload/sign/user-uploads/${ALICE}/big.png`,
      { key: anonKey, bearer: token, body: { size: 1024, content_type: 'image/png' } });
    expect(own.statusCode).toBe(200);
    expect(own.json().upload_id).toBeTruthy();

    const theirs = await call('POST',
      `/storage/v1/object/upload/sign/user-uploads/${BOB}/big.png`,
      { key: anonKey, bearer: token, body: { size: 1024, content_type: 'image/png' } });
    expect(theirs.statusCode).toBe(403);
  });
});
