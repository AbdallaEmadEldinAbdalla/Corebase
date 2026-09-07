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
