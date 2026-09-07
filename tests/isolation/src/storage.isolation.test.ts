import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setUp, tearDown, storageApp, userToken, mint, type Harness } from './harness.ts';

/**
 * Storage-path isolation — ST-1 through ST-4 of the matrix.
 *
 * These were a named gap after P5e, because there was no storage service to
 * attack. There is now, so the gap closes.
 *
 * The shape of every assertion here is the same and worth stating once: a
 * refusal is not enough. Storage returns *bytes*, so each test also asserts that
 * the neighbour's content never appears in the response — every seeded secret
 * carries its own project's ref, which is what makes "no byte of B's is in this"
 * checkable without knowing which project answered.
 *
 * One app serves both projects, deliberately. The module resolves whichever
 * project the presented `apikey` names, so A's key and B's key reach the same
 * process and only that resolution keeps them apart. Two apps would prove
 * something about routing rather than about isolation.
 */
let h: Harness | undefined;
let app: FastifyInstance;

beforeAll(async () => { h = await setUp(); app = storageApp(h); });
afterAll(async () => { await app?.close(); await tearDown(h); });

const A = () => h!.a;
const B = () => h!.b;

const call = (
  method: string, url: string,
  opts: { key?: string; bearer?: string; body?: unknown; host?: string } = {},
) => app.inject({
  method: method as 'GET', url,
  headers: {
    ...(opts.key ? { apikey: opts.key } : {}),
    ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
  },
  ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
});

/** Neither project's secrets may ever appear in the other's response. */
function expectNoLeak(body: string, ...refs: string[]) {
  for (const ref of refs) {
    expect(body).not.toContain(`${ref}-VAULT-SECRET`);
    expect(body).not.toContain(`${ref}-PUBLIC-POSTER`);
    expect(body).not.toContain(`${ref}-ONLY-HERE`);
  }
}

/** The path that exists in exactly one project. */
const onlyIn = (f: () => { ownerUid: string; ref: string }) =>
  `${f().ownerUid}/${f().ref}-only.txt`;

/** The path both projects use, under an owner uid they share. */
const shared = (f: () => { ownerUid: string }) => `${f().ownerUid}/private.txt`;

describe('ST-1 — A\'s keys reach A\'s storage and nothing else', () => {
  /**
   * The doc frames ST-1 as "A's token against B's bucket, expect 401", which
   * assumes the project is named in the request — as it is for `/rest/v1`, where
   * the Host says which project and the key must match it.
   *
   * `/storage/v1` identifies the project from the **apikey itself**, so there is
   * no such thing as pointing A's key at B: the request simply operates on A. The
   * isolation is therefore *stronger* than a 401 and shows up differently — the
   * same URL with two different keys returns two different projects' bytes, and
   * neither ever sees the other's. Asserting 401 here would have been asserting
   * the wrong mechanism, and the first version of this file did exactly that.
   */
  it('the same URL with each project\'s key returns that project\'s bytes, never the other\'s',
    async () => {
      const atA = await call('GET', `/storage/v1/object/vault/${shared(A)}`,
        { key: A().serviceKey });
      expect(atA.statusCode).toBe(200);
      expect(atA.body).toContain(`${A().ref}-VAULT-SECRET`);
      expectNoLeak(atA.body, B().ref);

      const atB = await call('GET', `/storage/v1/object/vault/${shared(B)}`,
        { key: B().serviceKey });
      expect(atB.statusCode).toBe(200);
      expect(atB.body).toContain(`${B().ref}-VAULT-SECRET`);
      expectNoLeak(atB.body, A().ref);

      // The uid in that path is identical for both, which is the trap: matching
      // `auth.uid()` is not isolation, since two projects can mint the same
      // subject. What separates them is that the key chose the project.
      expect(shared(A)).toBe(shared(B));
    });

  it('a path that exists only in B is a 404 under A\'s key, with no bytes', async () => {
    // The closest expressible form of the doc's intent: name B's object and
    // present A's credential. It resolves to A, where nothing is at that path.
    for (const [label, key] of [
      ['anon', A().anonKey], ['service_role', A().serviceKey],
    ] as const) {
      const res = await call('GET', `/storage/v1/object/vault/${onlyIn(B)}`, { key });
      expect(res.statusCode, label).toBe(404);
      expectNoLeak(res.body, B().ref);
    }
  });

  it('a forged key naming the other project is refused outright', async () => {
    // This *is* a 401 case, and the one the doc's framing was reaching for: a
    // token minted by A's key that claims to be B's. The resolver checks the
    // claim against the signature, so it fails whichever project it names.
    const forged = mint(A(), { role: 'service_role', ref: B().ref });
    const res = await call('GET', `/storage/v1/object/vault/${shared(B)}`, { key: forged });
    expect(res.statusCode).toBe(401);
    expectNoLeak(res.body, A().ref, B().ref);
  });

  it('a write with A\'s key lands in A, and B is untouched', async () => {
    // A write is the more dangerous direction: a leak reads, a misrouted write
    // *modifies* a neighbour. It must land in the writer's own project.
    const res = await app.inject({
      method: 'POST', url: `/storage/v1/object/vault/${A().ownerUid}/planted.txt`,
      headers: { apikey: A().serviceKey, 'content-type': 'text/plain' },
      payload: Buffer.from('written with A key'),
    });
    expect([200, 201]).toContain(res.statusCode);

    // Present in A…
    expect((await call('GET', `/storage/v1/object/vault/${A().ownerUid}/planted.txt`,
      { key: A().serviceKey })).statusCode).toBe(200);
    // …and absent from B, under the identical path.
    expect((await call('GET', `/storage/v1/object/vault/${B().ownerUid}/planted.txt`,
      { key: B().serviceKey })).statusCode).toBe(404);
  });

  it('and A\'s own keys work at A, so the refusals are not a broken module', async () => {
    // The positive control. Without it, a storage module that refused everyone
    // would satisfy every assertion above.
    const own = await call('GET', '/storage/v1/object/signage/poster.txt',
      { key: A().anonKey });
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain(`${A().ref}-PUBLIC-POSTER`);
  });
});

describe('ST-2 — a signed URL is not transferable across objects or projects', () => {
  it('refuses A\'s signed URL with B\'s object path substituted', async () => {
    const signed = await call('POST', `/storage/v1/object/sign/vault/${onlyIn(A)}`,
      { key: A().serviceKey, body: { expires_in: 600 } });
    expect(signed.statusCode).toBe(200);
    const url = signed.json().signed_url as string;

    // Works for what it was signed for.
    const ok = await app.inject({ method: 'GET', url });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain(`${A().ref}-ONLY-HERE`);

    // Swapped to a path that exists **only in B**. The signature covers the path,
    // so this is not a signature for that object — and separately the token names
    // A, so it would resolve to A even if it verified. Either reason alone
    // suffices, which is the point of checking both.
    const swapped = url.replace(onlyIn(A), onlyIn(B));
    const res = await app.inject({ method: 'GET', url: swapped });
    expect(res.statusCode).toBe(403);
    expectNoLeak(res.body, B().ref);
  });

  it('refuses a URL whose bucket has been swapped', async () => {
    const signed = await call('POST', `/storage/v1/object/sign/vault/${onlyIn(A)}`,
      { key: A().serviceKey, body: {} });
    const url = (signed.json().signed_url as string).replace('/vault/', '/signage/');
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(403);
  });

  it('B cannot mint a URL for a path that exists only in A', async () => {
    // The other direction: B's key resolves to B, where that path is absent, so
    // there is nothing to sign.
    const res = await call('POST', `/storage/v1/object/sign/vault/${onlyIn(A)}`,
      { key: B().serviceKey, body: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('ST-3 — a signed URL stops working when it expires', () => {
  it('serves before exp and refuses after, with no bytes either way after', async () => {
    const signed = await call('POST', `/storage/v1/object/sign/vault/${onlyIn(A)}`,
      { key: A().serviceKey, body: { expires_in: 1 } });
    const url = signed.json().signed_url as string;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);

    await new Promise((r) => setTimeout(r, 1300));
    const after = await app.inject({ method: 'GET', url });
    expect(after.statusCode).toBe(403);
    expectNoLeak(after.body, A().ref);
    // Identical to every other refusal, so a replayed URL cannot be
    // distinguished from a forged one by the holder.
    expect(after.json().error.message).toBe('That signed URL is not valid.');
  });
});

describe('ST-4 — a user of A against B, where B\'s policies would deny', () => {
  it('refuses A\'s authenticated token at B, however it is presented', async () => {
    const aUser = userToken(A(), A().ownerUid);

    // As the apikey: refused at the front door — a user credential must not
    // select a project.
    const asKey = await call('GET', `/storage/v1/object/vault/${shared(B)}`,
      { key: aUser });
    expect(asKey.statusCode).toBe(401);

    // The subtler shape, and the one ST-4 is really about: B's own *public* anon
    // key gets past project resolution, and A's user token is offered as the
    // identity. B's keys verify tokens B signed, so this fails on the signature.
    const asBearer = await call('GET', `/storage/v1/object/vault/${shared(B)}`,
      { key: B().anonKey, bearer: aUser });
    expect(asBearer.statusCode).toBe(401);
    expectNoLeak(asBearer.body, B().ref);
  });

  it('the same uid at B sees only what B\'s policies allow', async () => {
    // The trap this closes: both projects seeded their vault under the *same*
    // owner uid, so `auth.uid()` matching is not what separates them. A token
    // minted by B for that uid legitimately reads B's file — and A's identical
    // token cannot, because the token itself is project-bound.
    const bUser = userToken(B(), B().ownerUid);
    const legitimate = await call('GET', `/storage/v1/object/vault/${shared(B)}`,
      { key: B().anonKey, bearer: bUser });
    expect(legitimate.statusCode).toBe(200);
    expect(legitimate.body).toContain(`${B().ref}-VAULT-SECRET`);
    // And that same user cannot reach a path that exists only in A: their key
    // resolves to B, where it is absent.
    const across = await call('GET', `/storage/v1/object/vault/${onlyIn(A)}`,
      { key: B().anonKey, bearer: bUser });
    expect(across.statusCode).toBe(404);
    expectNoLeak(across.body, A().ref);
  });

  it('a listing shows only the caller\'s own project, filtered by their policy',
    async () => {
      const bUser = userToken(B(), B().ownerUid);
      const list = await call('POST', '/storage/v1/object/list/vault',
        { key: B().anonKey, bearer: bUser, body: {} });
      expect(list.statusCode).toBe(200);
      const names = (list.json().objects as Array<{ name: string }>).map((o) => o.name);
      // B's own two vault objects and nothing else — in particular not A's
      // project-unique one, whose name would be unmistakable.
      expect(names.sort()).toEqual([shared(B), onlyIn(B)].sort());
      // Nothing of A's, by name or by content.
      expectNoLeak(list.body, A().ref);
    });

  it('the public bucket is public within its project and not across projects', async () => {
    // A public bucket is the one place per-object RLS is skipped, which makes it
    // the most likely place for a cross-tenant read to hide. The Host decides
    // which project's public bucket is served.
    const atB = await app.inject({
      method: 'GET', url: '/storage/v1/object/public/signage/poster.txt',
      headers: { host: `${B().ref}.corebase.test` },
    });
    expect(atB.statusCode).toBe(200);
    expect(atB.body).toContain(`${B().ref}-PUBLIC-POSTER`);
    // Same path, A's Host: A's own poster, never B's.
    const atA = await app.inject({
      method: 'GET', url: '/storage/v1/object/public/signage/poster.txt',
      headers: { host: `${A().ref}.corebase.test` },
    });
    expect(atA.statusCode).toBe(200);
    expect(atA.body).toContain(`${A().ref}-PUBLIC-POSTER`);
    expectNoLeak(atA.body, B().ref);
  });
});
