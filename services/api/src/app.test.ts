import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from './app.ts';
import { createMemoryStore } from './modules/control-plane/store.ts';

const TOKEN = 'test-token';
const auth = { authorization: `Bearer ${TOKEN}` };

function app() {
  return buildApp({ store: createMemoryStore(), staticToken: TOKEN });
}

describe('health', () => {
  it('reports ok', async () => {
    const res = await app().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'api' });
  });
});

describe('error envelope (D-032)', () => {
  it('returns code/message/request_id and echoes X-Request-ID on errors', async () => {
    const res = await app().inject({
      method: 'GET', url: '/v1/projects/nope', headers: { ...auth, 'x-request-id': 'req_abc123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('req_abc123');
    const body = res.json();
    expect(body.error.code).toBe('PROJECT_NOT_FOUND');
    expect(body.error.request_id).toBe('req_abc123');
  });

  it('never leaks internals on 401', async () => {
    const res = await app().inject({ method: 'GET', url: '/v1/projects' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /v1/projects', () => {
  let a: ReturnType<typeof app>;
  beforeEach(() => { a = app(); });

  it('requires an Idempotency-Key (D-063)', async () => {
    const res = await a.inject({ method: 'POST', url: '/v1/projects', headers: auth, payload: { name: 'my-app' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('creates a project in CREATING with a DNS-safe ref', async () => {
    const res = await a.inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-00000001' }, payload: { name: 'my-app' },
    });
    expect(res.statusCode).toBe(202);
    const p = res.json();
    expect(p.status).toBe('creating');
    expect(p.ref).toMatch(/^[a-z][a-z2-7]{19}$/);
    expect(p.region).toBe('eu-central');
  });

  it('replaying an idempotency key returns the same project, not a second one', async () => {
    const body = { method: 'POST' as const, url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-00000002' }, payload: { name: 'dup-app' } };
    const first = await a.inject(body);
    const second = await a.inject(body);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json().ref).toBe(first.json().ref);
    const list = await a.inject({ method: 'GET', url: '/v1/projects', headers: auth });
    expect(list.json().data).toHaveLength(1);
  });

  it('writes the job row in the same step as the project (two-phase enqueue, D-067)', async () => {
    const store = createMemoryStore();
    const b = buildApp({ store, staticToken: TOKEN });
    await b.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-00000003' }, payload: { name: 'jobbed' } });
    const jobs = await store.jobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe('provision_project');
    expect(jobs[0]!.state).toBe('queued');
  });

  it('rejects a duplicate name with 409', async () => {
    const mk = (k: string) => ({ method: 'POST' as const, url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': k }, payload: { name: 'taken' } });
    await a.inject(mk('key-aaaaaaa1'));
    const res = await a.inject(mk('key-aaaaaaa2'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROJECT_NAME_TAKEN');
  });

  it('rejects invalid names before touching the store', async () => {
    const res = await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-00000004' }, payload: { name: 'My_App' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('DELETE /v1/projects/:ref', () => {
  it('moves the project to DELETING', async () => {
    const a = app();
    const created = await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-00000005' }, payload: { name: 'bye-app' } });
    const { ref } = created.json();
    const res = await a.inject({ method: 'DELETE', url: `/v1/projects/${ref}`, headers: auth });
    expect(res.statusCode).toBe(202);
    expect(res.json().project.status).toBe('deleting');
    expect(res.json().job.kind).toBe('delete_project');
  });
});

describe('framework-level rejections keep their status', () => {
  it('an empty body under a JSON content-type is a 400, not a 500', async () => {
    // Some HTTP clients set content-type globally, so a bodyless DELETE arrives
    // claiming to carry JSON. Answering 500 tells the caller our server is
    // broken and puts their typo in our server-error alert.
    const res = await app().inject({
      method: 'DELETE', url: '/v1/projects/whatever',
      headers: { ...auth, 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
    expect(res.json().error.message).toMatch(/Body cannot be empty/);
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const res = await app().inject({
      method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-00000010', 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('still reports a genuine server fault as 500', async () => {
    const broken = buildApp({
      store: { ...createMemoryStore(), listProjects: async () => { throw new Error('boom'); } },
      staticToken: TOKEN,
    });
    const res = await broken.inject({ method: 'GET', url: '/v1/projects', headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL');
    // and never leaks the internal message
    expect(res.json().error.message).not.toMatch(/boom/);
  });
});

describe('DELETE is idempotent by construction', () => {
  it('a repeated delete does not create a second teardown job', async () => {
    const a = app();
    const created = await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-00000009' }, payload: { name: 'twice-app' } });
    const { ref } = created.json();
    const first = await a.inject({ method: 'DELETE', url: `/v1/projects/${ref}`, headers: auth });
    const second = await a.inject({ method: 'DELETE', url: `/v1/projects/${ref}`, headers: auth });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    // Same job, not a second one: the key is derived from the project, so the
    // caller cannot cause two teardowns by clicking twice.
    expect(second.json().job.id).toBe(first.json().job.id);
  });
});

describe('idempotent replay ordering', () => {
  it('a replayed key wins over the duplicate-name check', async () => {
    const a = app();
    const body = { method: 'POST' as const, url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-replay-01' }, payload: { name: 'same-name' } };
    const first = await a.inject(body);
    const retry = await a.inject(body);
    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(200);           // not 409
    expect(retry.json().ref).toBe(first.json().ref);
  });

  it('a different key with a taken name still gets 409', async () => {
    const a = app();
    await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-distinct-1' }, payload: { name: 'occupied' } });
    const res = await a.inject({ method: 'POST', url: '/v1/projects',
      headers: { ...auth, 'idempotency-key': 'key-distinct-2' }, payload: { name: 'occupied' } });
    expect(res.statusCode).toBe(409);
  });
});
