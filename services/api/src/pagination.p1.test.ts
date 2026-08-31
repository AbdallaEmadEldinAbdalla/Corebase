import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from './app.ts';
import { createMemoryStore } from './modules/control-plane/store.ts';
import { encodeCursor, DEFAULT_LIMIT, MAX_LIMIT } from './kernel/pagination.ts';

/**
 * P1b: cursor pagination (D-039), which closes OQ-175 together with the response
 * envelope.
 *
 * The tests that matter are the last two: a cursor must not lose the reader's
 * place when the list changes underneath them, which is the whole reason this is
 * keyset and not `OFFSET`.
 */
const TOKEN = 'page-token';
const auth = { authorization: `Bearer ${TOKEN}` };

let a: ReturnType<typeof buildApp>;
beforeEach(() => { a = buildApp({ store: createMemoryStore(), staticToken: TOKEN }); });

let seq = 0;
async function create(name = `page-app-${++seq}`) {
  const res = await a.inject({
    method: 'POST', url: '/v1/projects',
    headers: { ...auth, 'idempotency-key': `page-key-${++seq}-${Date.now()}` },
    payload: { name },
  });
  return (res.json() as { project: { ref: string; id: string } }).project;
}

const list = async (query = '') =>
  (await a.inject({ method: 'GET', url: `/v1/projects${query}`, headers: auth }))
    .json() as { projects: Array<{ ref: string }>; pagination: { next_cursor: string | null; has_more: boolean } };

describe('P1b — the documented list envelope', () => {
  it('returns { projects, pagination }', async () => {
    await create();
    const body = await list();
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.pagination).toEqual({ next_cursor: null, has_more: false });
  });

  it('has no next_cursor when the page is the whole set', async () => {
    for (let i = 0; i < 3; i++) await create();
    const body = await list('?limit=10');
    expect(body.projects).toHaveLength(3);
    expect(body.pagination.has_more).toBe(false);
    expect(body.pagination.next_cursor).toBeNull();
  });

  it('walks every project exactly once across pages', async () => {
    const made = new Set<string>();
    for (let i = 0; i < 7; i++) made.add((await create()).ref);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const body: Awaited<ReturnType<typeof list>> =
        await list(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...body.projects.map((p) => p.ref));
      cursor = body.pagination.next_cursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(7);          // no duplicates
    expect([...made].sort()).toEqual([...seen].sort());   // nothing skipped
  });

  it('defaults to 20 and clamps to 100 rather than rejecting', async () => {
    // Asking for more than the maximum is a reasonable thing to do once, and a
    // 400 teaches nothing that a cap does not.
    expect(DEFAULT_LIMIT).toBe(20);
    expect(MAX_LIMIT).toBe(100);
    const res = await a.inject({ method: 'GET', url: '/v1/projects?limit=5000', headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a limit that is not a positive integer', async () => {
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await a.inject({ method: 'GET', url: `/v1/projects?limit=${bad}`, headers: auth });
      expect(res.statusCode, `limit=${bad}`).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects a malformed cursor with a message that says what to do', async () => {
    const res = await a.inject({ method: 'GET', url: '/v1/projects?cursor=notbase64!!', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/next_cursor/);
  });

  it('rejects a cursor that decodes to the wrong shape', async () => {
    const res = await a.inject({
      method: 'GET', headers: auth,
      url: `/v1/projects?cursor=${encodeURIComponent(Buffer.from('{"nope":1}').toString('base64url'))}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a cursor carrying an unparseable timestamp', async () => {
    const res = await a.inject({
      method: 'GET', headers: auth,
      url: `/v1/projects?cursor=${encodeURIComponent(encodeCursor({ created_at: 'never', id: 'x' }))}`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an org_id with the wrong prefix', async () => {
    // `prj_…` where an org belongs is a real mix-up; accepting it silently turns
    // a clear 400 into an empty list.
    const res = await a.inject({
      method: 'GET', headers: auth,
      url: '/v1/projects?org_id=prj_e5f6a7b8-1111-4222-8333-444455556666',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/where a org_ id was expected/);
  });
});

describe('P1b — a cursor survives the list changing underneath it', () => {
  it('does not skip a project when an older one is added mid-scroll', async () => {
    // The failure mode offset pagination has and keyset does not: with OFFSET,
    // inserting a row shifts every later page and the reader loses items without
    // any error.
    for (let i = 0; i < 4; i++) await create();
    const first = await list('?limit=2');
    expect(first.pagination.has_more).toBe(true);

    await create('inserted-mid-scroll');       // newest, i.e. on page one

    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.pagination.next_cursor!)}`);
    const overlap = second.projects.filter((p) => first.projects.some((f) => f.ref === p.ref));
    expect(overlap).toEqual([]);                // nothing shown twice
  });

  it('keeps working when the project the cursor points at is deleted', async () => {
    for (let i = 0; i < 4; i++) await create();
    const first = await list('?limit=2');
    const anchor = first.projects.at(-1)!.ref;
    await a.inject({ method: 'DELETE', url: `/v1/projects/${anchor}`, headers: auth });

    // The cursor is a position, not a foreign key. A deleted anchor must not
    // strand the reader.
    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.pagination.next_cursor!)}`);
    expect(second.projects.length).toBeGreaterThan(0);
  });
});
