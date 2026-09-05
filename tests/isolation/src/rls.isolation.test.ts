import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import type { FastifyInstance } from 'fastify';
import { setUp, tearDown, gateway, hostOf, mint, type Harness, type Fixture } from './harness.ts';

/**
 * The RLS regression canaries.
 *
 * These are not attacks. They are a fixed table with known rows and known
 * policies, read back through every role, asserting an **exact** set of visible
 * ids. That shape is deliberate: the failures they exist to catch are silent
 * ones — a migration that drops FORCE, a helper function returning null, a
 * `service_role` grant applied to the wrong role. None of those announce
 * themselves; all of them change exactly this table.
 *
 * Asserting a set rather than a count matters. A policy that returns the wrong
 * three rows passes any count assertion, and "the user saw somebody else's row"
 * is the entire failure mode.
 */
let h: Harness | undefined;
let app: FastifyInstance;

beforeAll(async () => { h = await setUp(); app = await gateway(h); });
afterAll(async () => { await app?.close(); await tearDown(h); });

const A = () => h!.a;
const B = () => h!.b;

/** Reads the canary through the data API as whatever identity the token carries. */
async function visibleIds(
  f: Fixture, opts: { apikey: string; bearer?: string },
): Promise<number[]> {
  const res = await app.inject({
    method: 'GET', url: '/rest/v1/canary?select=id&order=id',
    headers: {
      host: hostOf(f), apikey: opts.apikey,
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
  });
  if (res.statusCode !== 200) {
    throw new Error(`reading the canary returned ${res.statusCode}: ${res.body}`);
  }
  return (res.json() as Array<{ id: number }>).map((r) => r.id);
}

describe('the read canary — exact visibility per role', () => {
  it('anon sees published rows only', async () => {
    expect(await visibleIds(A(), { apikey: A().anonKey })).toEqual([2, 3]);
  });

  it('authenticated as the owner sees its own unpublished row plus the published ones', async () => {
    const token = mint(A(), { role: 'authenticated', sub: A().ownerUid });
    expect(await visibleIds(A(), { apikey: A().anonKey, bearer: token })).toEqual([1, 2, 3]);
  });

  it('authenticated as another user must NOT see row 1', async () => {
    const token = mint(A(), { role: 'authenticated', sub: A().otherUid });
    // The single most important assertion in the file: row 1 is another user's
    // unpublished row, and `p_read_own` is the only thing standing between them.
    expect(await visibleIds(A(), { apikey: A().anonKey, bearer: token })).toEqual([2, 3]);
  });

  it('service_role bypasses RLS and sees everything', async () => {
    expect(await visibleIds(A(), { apikey: A().serviceKey })).toEqual([1, 2, 3]);
  });

  it('a user of A sees none of B\'s rows, and the reverse', async () => {
    // Same uid on both sides, which is the trap: `auth.uid()` matching is not
    // isolation, because two projects can mint the same subject. The isolation is
    // that A's token cannot be presented at B at all.
    const aToken = mint(A(), { role: 'authenticated', sub: A().ownerUid });
    const bRows = await app.inject({
      method: 'GET', url: '/rest/v1/canary?select=secret',
      headers: { host: hostOf(B()), apikey: B().anonKey, authorization: `Bearer ${aToken}` },
    });
    expect(bRows.statusCode).toBe(401);
    expect(bRows.body).not.toContain(B().ref);

    // And B's own anon read returns only B's secrets — never A's.
    const own = await app.inject({
      method: 'GET', url: '/rest/v1/canary?select=secret',
      headers: { host: hostOf(B()), apikey: B().anonKey },
    });
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain(`${B().ref}-public`);
    expect(own.body).not.toContain(A().ref);
  });
});

describe('the write canary — WITH CHECK, not just USING', () => {
  const insert = (f: Fixture, row: unknown, opts: { apikey: string; bearer?: string }) =>
    app.inject({
      method: 'POST', url: '/rest/v1/canary',
      headers: {
        host: hostOf(f), apikey: opts.apikey, 'content-type': 'application/json',
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      },
      payload: JSON.stringify(row),
    });

  it('anon cannot insert', async () => {
    const res = await insert(A(),
      { id: 90, owner: A().ownerUid, secret: 'x', published: true },
      { apikey: A().anonKey });
    // No policy grants anon INSERT, so default-deny answers — 401 or 403 both say
    // "not you"; a 201 is the failure, and a 500 would mean we broke differently
    // than designed.
    expect([401, 403]).toContain(res.statusCode);
  });

  it('authenticated cannot insert a row owned by someone else', async () => {
    const token = mint(A(), { role: 'authenticated', sub: A().ownerUid });
    const res = await insert(A(),
      { id: 91, owner: A().otherUid, secret: 'forged', published: true },
      { apikey: A().anonKey, bearer: token });
    // This is the half a USING-only policy gets wrong: reads are filtered, writes
    // are not, and the row lands owned by a victim.
    expect([401, 403]).toContain(res.statusCode);
  });

  it('authenticated can insert and update its own row', async () => {
    const token = mint(A(), { role: 'authenticated', sub: A().ownerUid });
    const created = await insert(A(),
      { id: 92, owner: A().ownerUid, secret: 'mine', published: false },
      { apikey: A().anonKey, bearer: token });
    expect([200, 201, 204]).toContain(created.statusCode);

    const updated = await app.inject({
      method: 'PATCH', url: '/rest/v1/canary?id=eq.92',
      headers: { host: hostOf(A()), apikey: A().anonKey,
        authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ secret: 'mine-edited' }),
    });
    expect([200, 204]).toContain(updated.statusCode);

    // A positive control. Without it every assertion above would also pass
    // against a table nobody can write at all, which proves nothing about the
    // policies and everything about a missing grant.
    expect(await visibleIds(A(), { apikey: A().anonKey, bearer: token }))
      .toEqual([1, 2, 3, 92]);
  });

  it('a user cannot update another user\'s row', async () => {
    const other = mint(A(), { role: 'authenticated', sub: A().otherUid });
    const res = await app.inject({
      method: 'PATCH', url: '/rest/v1/canary?id=eq.1',
      headers: { host: hostOf(A()), apikey: A().anonKey,
        authorization: `Bearer ${other}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ secret: 'stolen' }),
    });
    // PostgREST reports zero matched rows rather than a denial, because the USING
    // clause filtered the row out before the update — so the assertion that
    // matters is the row's *content*, not the status.
    expect([200, 204, 404]).toContain(res.statusCode);
    const still = await app.inject({
      method: 'GET', url: '/rest/v1/canary?id=eq.1&select=secret',
      headers: { host: hostOf(A()), apikey: A().serviceKey },
    });
    expect(still.body).toContain(`${A().ref}-private`);
    expect(still.body).not.toContain('stolen');
  });
});

describe('default-deny posture — what a customer-created table arrives as', () => {
  /**
   * This block was wrong twice, and both mistakes are worth keeping written down
   * because each looked like a pass.
   *
   * **First**, it read the seeded canary as `developer` and passed on "permission
   * denied for table canary" — a *missing grant*, which never reaches RLS at all.
   * FORCE could have been off the whole time and it would still have been green.
   *
   * **Second**, rewritten to use a table the role owns, it asserted `FORCE` was
   * applied and failed. That was the test being wrong, not the platform: **D-191**
   * supersedes the FORCE half of D-083 and applies ENABLE only, because FORCE
   * affects a table's *owner* — here the customer's own `developer` role — so it
   * would break the first `INSERT` after the first `CREATE TABLE` on every ORM
   * and migration tool, while buying no isolation (cross-tenant isolation is the
   * container boundary, and `anon`/`authenticated` are non-owners already
   * constrained by ENABLE).
   *
   * The isolation doc's canary is not in conflict: it applies FORCE in its own
   * seed, explicitly, to the one table whose owner-visibility it wants to pin.
   *
   * So the assertions below pin the *decided* posture in both directions —
   * including that the owner CAN read its own table, which is the half a future
   * change back to FORCE would break. It should have to come here and argue with
   * D-191 rather than discovering this in a customer's migration.
   */
  it('gets ENABLE without FORCE (D-191), so its owner still works and the API roles see nothing', async () => {
    const client = new Client({
      host: '127.0.0.1', port: A().port, database: 'postgres',
      user: A().dbUser, password: A().dbPassword, connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      await client.query('create table public.owned (id int primary key, mine text)');

      const { rows: flags } = await client.query<{ rls: boolean; forced: boolean }>(
        `select relrowsecurity as rls, relforcerowsecurity as forced
           from pg_class where oid = 'public.owned'::regclass`);
      // Set by nobody in this test — the event trigger is what makes it
      // non-optional, and a tooling-layer lint would be bypassable by anyone with
      // SQL access.
      expect(flags[0]).toEqual({ rls: true, forced: false });

      // D-191's own promise: the customer's connection keeps working. An insert
      // on a brand-new table is the exact operation FORCE would have broken.
      await client.query("insert into public.owned values (1, 'secret')");
      const { rows } = await client.query('select id from public.owned');
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      await client.query('drop table if exists public.owned cascade').catch(() => {});
      await client.end();
    }
  });

  it('and the API-facing roles see nothing on it, which is what ENABLE alone guarantees', async () => {
    // The security half, asserted through the data API rather than in SQL: this is
    // the claim that survives D-191, so it is the one that must be continuously
    // proven. A table with RLS on and no policies is invisible to anon and to an
    // authenticated user alike, even though both hold a grant.
    const client = new Client({
      host: '127.0.0.1', port: A().port, database: 'postgres',
      user: A().dbUser, password: A().dbPassword, connectionTimeoutMillis: 5000,
    });
    await client.connect();
    try {
      await client.query('create table public.exposed (id int primary key, mine text)');
      await client.query("insert into public.exposed values (1, 'must-not-leak')");
      // Grants on purpose — the interesting case is a table the roles *can* reach
      // and still cannot read. Without the grant this would pass on a 401 and
      // prove nothing about RLS, which is the first mistake above.
      await client.query('grant select on public.exposed to anon, authenticated');
      await client.query("notify pgrst, 'reload schema'");
      await new Promise((r) => setTimeout(r, 1500));

      for (const identity of [
        { label: 'anon', headers: { apikey: A().anonKey } },
        { label: 'authenticated', headers: {
            apikey: A().anonKey,
            authorization: `Bearer ${mint(A(), { role: 'authenticated', sub: A().ownerUid })}` } },
      ]) {
        const res = await app.inject({
          method: 'GET', url: '/rest/v1/exposed?select=*',
          headers: { host: hostOf(A()), ...identity.headers },
        });
        expect(res.statusCode, `${identity.label} status`).toBe(200);
        expect(res.json(), `${identity.label} rows`).toEqual([]);
        expect(res.body).not.toContain('must-not-leak');
      }

      // The positive control: service_role does see it, so the empty results
      // above are RLS deciding rather than the table being empty or unreachable.
      const bypass = await app.inject({
        method: 'GET', url: '/rest/v1/exposed?select=*',
        headers: { host: hostOf(A()), apikey: A().serviceKey },
      });
      expect(bypass.statusCode).toBe(200);
      expect(bypass.body).toContain('must-not-leak');
    } finally {
      await client.query('drop table if exists public.exposed cascade').catch(() => {});
      await client.end();
    }
  });
});
