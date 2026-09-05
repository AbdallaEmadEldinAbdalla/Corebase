import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { generateKeypair, toJwk, sign } from '@corebase/jwt';
import { createDocker, type Docker } from './docker.ts';
import { buildApp } from '@corebase/api';
import { createMemoryRateLimiter } from '@corebase/api/kernel/rate-limit.ts';
import type { RouteEntry, RoutingTable } from '@corebase/api/modules/gateway/routing.ts';
import type { FastifyInstance } from 'fastify';
import { ensureDeveloperRole } from './project-admin.ts';
import { join } from 'node:path';

/**
 * P5d — the RLS posture and the policy cookbook, proven through the gateway.
 *
 * Two things are under test, and they are different in kind.
 *
 * **The posture** is a claim about what a table is like *before anyone writes a
 * policy* — the state every project starts in and most tables stay in longest.
 * It is asserted per role, because "default-deny" means three different
 * mechanisms: `anon` has no table grant at all (D-108), `authenticated` has the
 * grant and no policies so it sees `[]`, and `service_role` bypasses by attribute
 * (D-082). Three different reasons for three different answers, and a test that
 * only checked "nothing leaked" would pass while any two of them were broken.
 *
 * **The cookbook** is the five patterns the docs and dashboard templates ship,
 * run **verbatim as the doc writes them**. That is the point: these are the
 * policies customers will copy, so the test's value is entirely in not improving
 * them on the way in. If a pattern needs a fix to work, the doc is what should
 * change.
 *
 * Everything is exercised through the gateway rather than in psql, because a
 * policy that works in psql and not through the API is the failure mode that
 * matters — the claims arrive as a GUC set by PostgREST, and a policy is only
 * correct if it reads them the way the request delivers them.
 */
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const PG_IMAGE = process.env.CB_PG_IMAGE ?? 'corebase/postgres:17.5';
const PGRST_IMAGE = process.env.CB_POSTGREST_IMAGE ?? 'corebase/postgrest:12.2';

const NET = 'cb-p5d-net';
const PG = 'cb-p5d-pg';
const PGRST = 'cb-p5d-pgrst';
const PGRST_PORT = Number(process.env.CB_P5D_PORT ?? 7489);
const ADMIN_PORT = PGRST_PORT + 1;
const DOMAIN = 'corebase.test';
const REF = 'p5dcookbookrefaa';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ORG_ACME = '33333333-3333-4333-8333-333333333333';
const ORG_OTHER = '44444444-4444-4444-8444-444444444444';

let docker: Docker; let up = false; let reason = '';
let pair: ReturnType<typeof generateKeypair>;
let app: FastifyInstance;
/** The customer's own connection — how a migration or an ORM arrives. */
let dev: Client;

/** Mints the tokens the platform would mint, including custom claims. */
function token(
  role: 'anon' | 'authenticated' | 'service_role',
  sub?: string, extra: Record<string, unknown> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: `https://${REF}.${DOMAIN}`, ref: REF, role,
    ...(sub ? { sub, aud: 'authenticated' } : {}),
    ...extra, iat: now, exp: now + 3600,
  } as Parameters<typeof sign>[0], { privateKeyPem: pair.privateKeyPem, kid: pair.kid });
}

/** A data-plane request through the gateway, as a client makes it. */
async function req(
  method: string, url: string,
  opts: { role?: 'anon' | 'authenticated' | 'service_role'; sub?: string;
          claims?: Record<string, unknown>; body?: unknown; headers?: Record<string, string> } = {},
) {
  const role = opts.role ?? 'anon';
  const anon = token('anon');
  const bearer = role === 'anon' && !opts.sub
    ? anon
    : token(role, opts.sub, opts.claims ?? {});
  return app.inject({
    method: method as 'GET', url,
    headers: {
      host: `${REF}.${DOMAIN}`, apikey: anon, authorization: `Bearer ${bearer}`,
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
}

/**
 * Asserts a status and, when it does not match, says what the body was.
 *
 * PostgREST's refusals carry the SQLSTATE and the policy that produced it, and a
 * bare "expected 403 to be 204" throws all of that away — which cost a debugging
 * round trip on pattern 5 before this existed.
 */
function expectStatus(
  res: { statusCode: number; body: string }, allowed: number[], what: string,
): void {
  if (!allowed.includes(res.statusCode)) {
    throw new Error(
      `${what}: expected ${allowed.join(' or ')}, got ${res.statusCode} — ${res.body}`);
  }
}

/** As the superuser: this is the platform migration's voice, never a customer's. */
async function sql(statements: string): Promise<string> {
  const r = await docker.execCapture(
    PG, ['psql', '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-c', statements]);
  if (r.exitCode !== 0) throw new Error(`psql failed: ${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

beforeAll(async () => {
  try {
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 60_000 });
    await docker.ping();
    for (const image of [PG_IMAGE, PGRST_IMAGE]) {
      if (!(await docker.imageExists(image))) {
        throw new Error(`${image} is not on the data node — ./scripts/staging.sh seed-images`);
      }
    }
    await teardown();
    await docker.createNetwork(NET, {});
    await docker.createContainer(PG, {
      Image: PG_IMAGE, Env: ['POSTGRES_PASSWORD=p5dsmoke'],
      Labels: { 'com.corebase.managed': 'true' },
      HostConfig: {
        Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 1e9,
        RestartPolicy: { Name: 'no' }, Mounts: [],
        PortBindings: { '5432/tcp': [{ HostPort: String(PGRST_PORT + 2) }] },
      },
      ExposedPorts: { '5432/tcp': {} },
      NetworkingConfig: { EndpointsConfig: { [NET]: {} } },
    });
    await docker.startContainer(PG);
    for (let i = 0; i < 60; i++) {
      const r = await docker.execCapture(PG, ['pg_isready', '-U', 'postgres', '-q']);
      if (r.exitCode === 0) break;
      await new Promise((r2) => setTimeout(r2, 1000));
    }

    pair = generateKeypair();
    await sql(`ALTER ROLE authenticator WITH PASSWORD 'p5dauth'`);

    // The customer's own role, created by the same function provisioning uses —
    // not a hand-rolled copy. Its per-role default privileges are the whole
    // subject of the posture block below, and a replica of that DDL here would be
    // free to drift away from the thing customers actually get.
    const su = new Client({
      host: '127.0.0.1', port: PGRST_PORT + 2, database: 'postgres',
      user: 'postgres', password: 'p5dsmoke', connectionTimeoutMillis: 8000 });
    await su.connect();
    await ensureDeveloperRole(su);
    await su.query(`ALTER ROLE developer WITH PASSWORD 'p5ddev'`);
    await su.end();
    dev = new Client({
      host: '127.0.0.1', port: PGRST_PORT + 2, database: 'postgres',
      user: 'developer', password: 'p5ddev', connectionTimeoutMillis: 8000 });
    await dev.connect();

    await docker.createContainer(PGRST, {
      Image: PGRST_IMAGE,
      Env: [
        'COREBASE_REF=p5d',
        `COREBASE_PG_HOST=${PG}`,
        `PGRST_DB_URI=postgres://authenticator:p5dauth@${PG}:5432/postgres`,
        `COREBASE_JWKS=${JSON.stringify({ keys: [toJwk(pair.publicKeyPem, pair.kid)] })}`,
      ],
      Labels: { 'com.corebase.managed': 'true' },
      HostConfig: {
        Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024, NanoCpus: 5e8,
        RestartPolicy: { Name: 'no' }, Mounts: [],
        PortBindings: {
          '3000/tcp': [{ HostPort: String(PGRST_PORT) }],
          '3001/tcp': [{ HostPort: String(ADMIN_PORT) }],
        },
      },
      ExposedPorts: { '3000/tcp': {}, '3001/tcp': {} },
      NetworkingConfig: { EndpointsConfig: { [NET]: {} } },
    });
    await docker.startContainer(PGRST);
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${ADMIN_PORT}/ready`)).ok) { up = true; break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!up) {
      const logs = await docker.containerLogs(PGRST).catch(() => '');
      throw new Error(`PostgREST never became ready:\n${String(logs).slice(-1200)}`);
    }

    const entry: RouteEntry = {
      projectId: 'p5d', ref: REF, status: 'ready', plan: 'free',
      nodeAddress: '127.0.0.1', postgrestPort: PGRST_PORT,
      jwks: [toJwk(pair.publicKeyPem, pair.kid)],
      revoked: new Set<string>(), loadedAt: Date.now(),
    };
    const routes: RoutingTable = {
      lookup: (r) => (r === entry.ref ? entry : undefined),
      refresh: async () => 1, start: () => {}, stop: () => {}, size: () => 1,
    };
    app = buildApp({
      gateway: {
        routes, projectDomain: DOMAIN,
        ipLimiter: createMemoryRateLimiter({ limit: 5000, windowSeconds: 60 }),
        keyLimiter: createMemoryRateLimiter({ limit: 5000, windowSeconds: 60 }),
        projectLimiter: createMemoryRateLimiter({ limit: 5000, windowSeconds: 60 }),
      },
    });
  } catch (err) {
    reason = (err as Error).message;
    console.error('P5d setup FAILED:', reason);
    up = false;
  }
}, 240_000);

async function teardown() {
  for (const c of [PGRST, PG]) await docker.removeContainer(c, true, true).catch(() => {});
  await docker.removeNetwork(NET).catch(() => {});
}

afterAll(async () => {
  await dev?.end().catch(() => {});
  await app?.close();
  if (docker) await teardown();
  docker?.close?.();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 90_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P5d preconditions not met (${reason}) — `
      + './scripts/staging.sh up && seed-images. '
      + 'This is the P5d done-signal and must not skip silently.');
    await fn();
  }, ms);

/**
 * DDL as the customer, then wait for PostgREST to notice.
 *
 * The reload is not polled for: the project image's event trigger fires
 * `NOTIFY pgrst` on `ddl_command_end` (P5b, D-100), so this is waiting for a
 * push that has already been sent rather than for a timer.
 */
async function migrate(statements: string): Promise<void> {
  await dev.query(statements);
  await new Promise((r) => setTimeout(r, 900));
}

describe('P5d — the default-deny posture, per role and per mechanism', () => {
  t('a table the customer just created answers differently to each role, for three different reasons',
    async () => {
      await migrate(`create table public.fresh (id int primary key, note text);
                     insert into public.fresh values (1, 'not-public');`);

      // `anon` holds no table grant at all — the asymmetry in D-108. The failure
      // is a privilege error, not an empty list, and that difference is the
      // design: an accidentally-public table is impossible because there is
      // nothing to accidentally leave un-revoked.
      const anon = await req('GET', '/rest/v1/fresh?select=*');
      expect(anon.statusCode).toBe(401);
      expect(anon.json().code).toBe('42501');
      expect(anon.body).not.toContain('not-public');

      // `authenticated` holds the grant, so it gets past privileges and lands on
      // RLS — which has no policies, so it sees an empty list. 200 and `[]`, not
      // an error: the doc is explicit that this is the *safe* state and the
      // dashboard shows it as a badge rather than a failure.
      const user = await req('GET', '/rest/v1/fresh?select=*', { role: 'authenticated', sub: ALICE });
      expect(user.statusCode).toBe(200);
      expect(user.json()).toEqual([]);

      // `service_role` bypasses by role attribute (D-082), not by a policy — so
      // it works on a table nobody has written a policy for, which is the entire
      // reason the attribute was chosen over blanket `using (true)` policies.
      const svc = await req('GET', '/rest/v1/fresh?select=*', { role: 'service_role' });
      expect(svc.statusCode).toBe(200);
      expect(svc.json()).toEqual([{ id: 1, note: 'not-public' }]);
    });

  t('the grants come from the customer role\'s own default privileges, not the platform\'s',
    async () => {
      // The trap this pins: ALTER DEFAULT PRIVILEGES is scoped to the *creating*
      // role. The image sets them for `postgres`, which covers platform
      // migrations and covers nothing a customer does — so without the second
      // ALTER for `developer`, every table a customer creates would be invisible
      // to `authenticated` with a privilege error rather than an empty list, and
      // the documented posture would be wrong for every real table.
      const { rows } = await dev.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'public' and table_name = 'fresh'
            and grantee in ('anon', 'authenticated', 'service_role')
          order by grantee, privilege_type`);
      const byRole = new Map<string, string[]>();
      for (const r of rows) byRole.set(r.grantee, [...(byRole.get(r.grantee) ?? []), r.privilege_type]);
      expect(byRole.get('authenticated')?.sort())
        .toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(byRole.get('service_role')?.sort())
        .toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // The load-bearing absence.
      expect(byRole.get('anon')).toBeUndefined();
    });

  t('RLS is on without FORCE (D-191), so the customer\'s own connection still works',
    async () => {
      const { rows } = await dev.query<{ rls: boolean; forced: boolean }>(
        `select relrowsecurity as rls, relforcerowsecurity as forced
           from pg_class where oid = 'public.fresh'::regclass`);
      expect(rows[0]).toEqual({ rls: true, forced: false });
      // D-191's promise, in one query: the owner reads its own table even though
      // no policy grants anyone anything. FORCE would break exactly this, on
      // every ORM and every seed script.
      expect((await dev.query('select id from public.fresh')).rows).toEqual([{ id: 1 }]);
    });
});

describe('P5d — the policy cookbook, verbatim', () => {
  t('pattern 1 — own rows, select and update', async () => {
    await migrate(`
      create table public.profiles (user_id uuid primary key, bio text);
      insert into public.profiles values ('${ALICE}', 'alice'), ('${BOB}', 'bob');

      create policy "read own profile"
      on public.profiles for select
      to authenticated
      using ( user_id = (select auth.uid()) );

      create policy "update own profile"
      on public.profiles for update
      to authenticated
      using      ( user_id = (select auth.uid()) )
      with check ( user_id = (select auth.uid()) );
    `);

    const mine = await req('GET', '/rest/v1/profiles?select=user_id', { role: 'authenticated', sub: ALICE });
    expect(mine.json()).toEqual([{ user_id: ALICE }]);

    // The USING half of the update policy: Bob's row is not a *target*, so the
    // update matches nothing rather than being refused. Asserting the row is
    // unchanged is the only way to tell those apart.
    const steal = await req('PATCH', '/rest/v1/profiles?user_id=eq.' + BOB,
      { role: 'authenticated', sub: ALICE, body: { bio: 'stolen' } });
    expect([200, 204, 404]).toContain(steal.statusCode);
    const bob = await req('GET', `/rest/v1/profiles?user_id=eq.${BOB}&select=bio`,
      { role: 'service_role' });
    expect(bob.json()).toEqual([{ bio: 'bob' }]);

    const own = await req('PATCH', '/rest/v1/profiles?user_id=eq.' + ALICE,
      { role: 'authenticated', sub: ALICE, body: { bio: 'alice-edited' } });
    expect([200, 204]).toContain(own.statusCode);
  });

  t('pattern 2 — insert takes WITH CHECK, and WITH CHECK is what stops a forged owner',
    async () => {
      await migrate(`
        create table public.posts (id bigserial primary key, author_id uuid, title text);
        create policy "insert own rows"
        on public.posts for insert
        to authenticated
        with check ( author_id = (select auth.uid()) );
        create policy "read own posts"
        on public.posts for select
        to authenticated
        using ( author_id = (select auth.uid()) );
      `);

      const ok = await req('POST', '/rest/v1/posts',
        { role: 'authenticated', sub: ALICE, body: { author_id: ALICE, title: 'mine' } });
      expect([200, 201, 204]).toContain(ok.statusCode);

      // The half a USING-only policy gets wrong. There is no existing row to
      // filter on an INSERT, so a policy written with USING alone constrains
      // nothing and this lands owned by Bob.
      const forged = await req('POST', '/rest/v1/posts',
        { role: 'authenticated', sub: ALICE, body: { author_id: BOB, title: 'forged' } });
      expect(forged.statusCode).toBe(403);
      expect(forged.json().code).toBe('42501');

      const all = await req('GET', '/rest/v1/posts?select=title,author_id', { role: 'service_role' });
      expect(all.json()).toEqual([{ title: 'mine', author_id: ALICE }]);
    });

  t('pattern 3 — tenant-scoped by an org claim the client cannot write', async () => {
    await migrate(`
      create table public.documents (id bigserial primary key, org_id uuid, body text);
      insert into public.documents (org_id, body)
        values ('${ORG_ACME}', 'acme-doc'), ('${ORG_OTHER}', 'other-doc');

      create policy "org members read"
      on public.documents for select
      to authenticated
      using (
        org_id = (select (auth.jwt() -> 'app_metadata' ->> 'org_id')::uuid)
      );
    `);

    const acme = await req('GET', '/rest/v1/documents?select=body', {
      role: 'authenticated', sub: ALICE, claims: { app_metadata: { org_id: ORG_ACME } } });
    expect(acme.json()).toEqual([{ body: 'acme-doc' }]);

    const other = await req('GET', '/rest/v1/documents?select=body', {
      role: 'authenticated', sub: BOB, claims: { app_metadata: { org_id: ORG_OTHER } } });
    expect(other.json()).toEqual([{ body: 'other-doc' }]);

    // A token with no org claim sees nothing rather than everything: the
    // predicate compares against NULL, and NULL = anything is not true. Worth
    // asserting, because the failure mode of a claim-driven policy is a missing
    // claim reading as a wildcard.
    const none = await req('GET', '/rest/v1/documents?select=body',
      { role: 'authenticated', sub: ALICE });
    expect(none.json()).toEqual([]);

    // And the doc's loudest warning, made executable: the policy reads
    // `app_metadata`, which only the platform sets. A client-side claim in
    // `user_metadata` naming the other org changes nothing — the policy never
    // looks there.
    const spoof = await req('GET', '/rest/v1/documents?select=body', {
      role: 'authenticated', sub: ALICE,
      claims: { app_metadata: { org_id: ORG_ACME }, user_metadata: { org_id: ORG_OTHER } } });
    expect(spoof.json()).toEqual([{ body: 'acme-doc' }]);
  });

  t('pattern 4 — public read, authenticated write, and policies OR-combine per command',
    async () => {
      await migrate(`
        create table public.articles
          (id bigserial primary key, author_id uuid, title text, published bool default false);
        grant select on public.articles to anon;
        insert into public.articles (author_id, title, published)
          values ('${ALICE}', 'alice-draft', false), ('${ALICE}', 'alice-live', true),
                 ('${BOB}', 'bob-live', true);

        create policy "anyone reads published"
        on public.articles for select
        to anon, authenticated
        using ( published = true );

        create policy "authors write"
        on public.articles for insert
        to authenticated
        with check ( author_id = (select auth.uid()) );

        create policy "authors update own"
        on public.articles for update
        to authenticated
        using ( author_id = (select auth.uid()) )
        with check ( author_id = (select auth.uid()) );

        -- The second SELECT policy, which is what makes the OR observable.
        create policy "authors read own drafts"
        on public.articles for select
        to authenticated
        using ( author_id = (select auth.uid()) );
      `);

      // anon needed an explicit grant above — the opt-in D-108 describes — and
      // then sees published rows only.
      const anon = await req('GET', '/rest/v1/articles?select=title&order=title');
      expect(anon.json()).toEqual([{ title: 'alice-live' }, { title: 'bob-live' }]);

      // Alice sees published rows OR her own: her draft plus both live articles.
      const alice = await req('GET', '/rest/v1/articles?select=title&order=title',
        { role: 'authenticated', sub: ALICE });
      expect(alice.json()).toEqual([
        { title: 'alice-draft' }, { title: 'alice-live' }, { title: 'bob-live' }]);

      // Bob does not see Alice's draft — the OR widens each role's view by its
      // own identity, not by anybody's.
      const bob = await req('GET', '/rest/v1/articles?select=title&order=title',
        { role: 'authenticated', sub: BOB });
      expect(bob.json()).toEqual([{ title: 'alice-live' }, { title: 'bob-live' }]);
    });

  t('pattern 5 — soft delete: hidden by a view, because a policy cannot hide them',
    async () => {
      // The doc's original version filtered tombstones in the SELECT policy, and
      // it **cannot work through the API** (D-386): PostgREST writes with
      // RETURNING, so Postgres applies the SELECT policy to the *new* row, and
      // the entire purpose of this update is to move the row out of that policy's
      // reach. It failed with `new row violates row-level security policy`, and no
      // `Prefer` value avoided it — return=minimal, return=representation and
      // count=none all failed identically.
      //
      // The rule that generalises: an UPDATE may not move a row outside its own
      // SELECT policy. So the hiding moves into a view.
      await migrate(`
        create table public.notes
          (id bigserial primary key, user_id uuid, body text, deleted_at timestamptz);
        insert into public.notes (user_id, body) values ('${ALICE}', 'keep'), ('${ALICE}', 'trash');

        create policy "read own notes"
        on public.notes for select
        to authenticated
        using ( user_id = (select auth.uid()) );

        create policy "soft delete own"
        on public.notes for update
        to authenticated
        using      ( user_id = (select auth.uid()) and deleted_at is null )
        with check ( user_id = (select auth.uid()) );

        -- and no DELETE policy at all.

        create view public.live_notes with (security_invoker = true) as
          select id, user_id, body from public.notes where deleted_at is null;
        grant select on public.live_notes to authenticated;
      `);

      const tombstone = await req('PATCH', '/rest/v1/notes?body=eq.trash',
        { role: 'authenticated', sub: ALICE, body: { deleted_at: new Date().toISOString() } });
      expectStatus(tombstone, [200, 204], 'tombstoning own note');

      // Hidden through the view.
      const live = await req('GET', '/rest/v1/live_notes?select=body&order=body',
        { role: 'authenticated', sub: ALICE });
      expect(live.json()).toEqual([{ body: 'keep' }]);

      // `security_invoker` is what keeps the view from being a bypass: it runs
      // with the caller's RLS, so Bob sees nothing through it even though the
      // view's own definition has no user filter.
      const bobs = await req('GET', '/rest/v1/live_notes?select=body',
        { role: 'authenticated', sub: BOB });
      expect(bobs.json()).toEqual([]);

      // The row is hidden, not gone — the point of a soft delete.
      const all = await req('GET', '/rest/v1/notes?select=body&order=body', { role: 'service_role' });
      expect(all.json()).toEqual([{ body: 'keep' }, { body: 'trash' }]);

      // Resurrection is impossible: the UPDATE policy's USING requires
      // `deleted_at is null`, so a tombstoned row is not a legal target.
      await req('PATCH', '/rest/v1/notes?body=eq.trash',
        { role: 'authenticated', sub: ALICE, body: { deleted_at: null } });
      const stillDead = await req('GET', '/rest/v1/live_notes?select=body&order=body',
        { role: 'authenticated', sub: ALICE });
      expect(stillDead.json()).toEqual([{ body: 'keep' }]);

      // And hard delete is impossible: no DELETE policy exists, so the grant the
      // customer's default privileges handed `authenticated` is not the
      // constraint — RLS is.
      const hard = await req('DELETE', '/rest/v1/notes?body=eq.keep',
        { role: 'authenticated', sub: ALICE });
      expect([200, 204, 404]).toContain(hard.statusCode);
      const survived = await req('GET', '/rest/v1/notes?select=body&order=body',
        { role: 'service_role' });
      expect(survived.json()).toEqual([{ body: 'keep' }, { body: 'trash' }]);
    });

  t('the SECURITY DEFINER membership helper, with its mandatory search_path pin',
    async () => {
      await migrate(`
        create table public.org_members (user_id uuid, org_id uuid, primary key (user_id, org_id));
        insert into public.org_members values ('${ALICE}', '${ORG_ACME}'), ('${BOB}', '${ORG_OTHER}');
        create table public.reports (id bigserial primary key, org_id uuid, body text);
        insert into public.reports (org_id, body) values
          ('${ORG_ACME}', 'acme-report'), ('${ORG_OTHER}', 'other-report');

        create schema if not exists app;
        grant usage on schema app to authenticated;

        create or replace function app.current_org_ids()
        returns setof uuid
        language sql stable
        security definer
        set search_path = ''
        as $fn$
          select org_id from public.org_members
          where user_id = (select auth.uid())
        $fn$;
        revoke all on function app.current_org_ids() from public;
        grant execute on function app.current_org_ids() to authenticated;

        create policy "org read"
        on public.reports for select
        to authenticated
        using ( org_id in (select app.current_org_ids()) );
      `);

      // The membership table has no policy of its own and needs none: the
      // function runs as its owner and so skips RLS on the lookup. That is the
      // deliberate part of the pattern — otherwise `org_members` would need a
      // policy just to be readable *by the policy that reads it*.
      const alice = await req('GET', '/rest/v1/reports?select=body', { role: 'authenticated', sub: ALICE });
      expect(alice.json()).toEqual([{ body: 'acme-report' }]);
      const bob = await req('GET', '/rest/v1/reports?select=body', { role: 'authenticated', sub: BOB });
      expect(bob.json()).toEqual([{ body: 'other-report' }]);

      // And the membership table is still not readable *directly* — the bypass
      // belongs to the function, not to the caller.
      const direct = await req('GET', '/rest/v1/org_members?select=*', { role: 'authenticated', sub: ALICE });
      expect(direct.json()).toEqual([]);

      // The pin, asserted rather than assumed. An unpinned search_path on a
      // SECURITY DEFINER function is the classic privilege-escalation shape: the
      // caller prepends a schema, and the function resolves `public.org_members`
      // to a table the attacker controls, while running as the owner.
      const { rows } = await dev.query<{ config: string[] | null; secdef: boolean }>(
        `select proconfig as config, prosecdef as secdef from pg_proc
          where oid = 'app.current_org_ids'::regproc`);
      expect(rows[0]!.secdef).toBe(true);
      // `toContain` on an array is exact element equality, so the assertion has to
      // match what Postgres stores — `search_path=""`, the empty pin.
      expect(rows[0]!.config?.some((c) => c.startsWith('search_path='))).toBe(true);
    });
});

describe('P5d — the performance claim the cookbook rests on', () => {
  /**
   * EXPLAIN as the API role, with the claims the request would carry.
   *
   * The predicate under test lives in the **policy**, and the query is a plain
   * `select` — which matters, and cost a rewrite. The first version put
   * `(select auth.uid())` in the query's own WHERE clause and asserted an
   * InitPlan appeared. It did, and it proved nothing: that is a fact about scalar
   * subqueries in general, while the cookbook's instruction is about *policy*
   * predicates. Worse, the tables had no policies at all, so the plans it was
   * reading were `One-Time Filter: false` — default-deny, short-circuited before
   * any predicate mattered.
   */
  const planOf = async (table: string): Promise<string> => {
    const r = await docker.execCapture(PG, ['psql', '-U', 'postgres', '-q', '-t', '-c',
      `set role authenticated;
       set request.jwt.claims = '{"sub":"${ALICE}","role":"authenticated"}';
       explain (costs off) select id from ${table};`]);
    if (r.exitCode !== 0) throw new Error(`explain failed: ${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };

  t('a policy written `(select auth.uid())` becomes an InitPlan; the bare form does not',
    async () => {
      await migrate(`
        create table public.perf_wrapped (id bigserial primary key, owner uuid);
        create table public.perf_bare    (id bigserial primary key, owner uuid);
        insert into public.perf_wrapped (owner)
          select '${ALICE}' from generate_series(1, 500);
        insert into public.perf_bare (owner)
          select '${ALICE}' from generate_series(1, 500);
        create index on public.perf_wrapped (owner);
        create index on public.perf_bare (owner);
        analyze public.perf_wrapped; analyze public.perf_bare;

        -- The only difference between these two tables is the wrapping.
        create policy "wrapped" on public.perf_wrapped for select
          to authenticated using ( owner = (select auth.uid()) );
        create policy "bare" on public.perf_bare for select
          to authenticated using ( owner = auth.uid() );
      `);

      // An InitPlan is evaluated once per statement and compared as a constant,
      // which is what lets the index be used at all.
      expect(await planOf('public.perf_wrapped')).toMatch(/InitPlan/);

      // The bare form has the function in the predicate, so it is evaluated per
      // row — `current_setting` plus a jsonb parse, once per candidate row.
      const bare = await planOf('public.perf_bare');
      expect(bare).not.toMatch(/InitPlan/);
      expect(bare).toMatch(/Filter:|Index Cond/);
    });

  t('and an unindexed policy column seq-scans even with the InitPlan', async () => {
    // The second pitfall in the doc's table, worth pinning because the first fix
    // hides it: with the InitPlan the predicate is cheap *per row*, so an
    // unindexed column looks fine on a small table and stops looking fine in
    // production.
    // Selective data, which the first version of this test got wrong: it gave
    // every row the same owner, so after adding the index the planner still chose
    // a sequential scan — correctly, because an index that matches every row is
    // worse than not using one. The test read that as the index having no effect.
    // A realistic table has many owners and each sees a small slice.
    await migrate(`
      create table public.unindexed (id bigserial primary key, owner uuid);
      insert into public.unindexed (owner) select gen_random_uuid() from generate_series(1, 5000);
      insert into public.unindexed (owner) select '${ALICE}' from generate_series(1, 5);
      analyze public.unindexed;
      create policy "own" on public.unindexed for select
        to authenticated using ( owner = (select auth.uid()) );
    `);
    expect(await planOf('public.unindexed')).toMatch(/Seq Scan/);

    await migrate('create index on public.unindexed (owner); analyze public.unindexed;');
    // Same policy, same claims, one index: the plan changes. Nothing about the
    // policy or the token moved.
    expect(await planOf('public.unindexed')).toMatch(/Index|Bitmap/);
  });

  t('RLS with no policies short-circuits the plan, which is default-deny made visible',
    async () => {
      // Incidental, and worth keeping: the empty result on a policy-less table is
      // not a scan that finds nothing. The planner proves it empty and reads no
      // pages, which is why the safe default is also the cheap one.
      await migrate('create table public.nopolicy (id bigserial primary key, owner uuid);');
      expect(await planOf('public.nopolicy')).toMatch(/One-Time Filter: false/);
    });
});

describe('P5d — EXIT CRITERION: the filter, embed and RPC surface through the gateway', () => {
  t('filters, ordering and pagination arrive intact — and RLS still decides', async () => {
    await migrate(`
      create table public.items
        (id bigserial primary key, owner uuid, name text, qty int, tag text);
      insert into public.items (owner, name, qty, tag) values
        ('${ALICE}', 'apple',  5, 'fruit'),
        ('${ALICE}', 'banana', 12, 'fruit'),
        ('${ALICE}', 'cement', 3, 'material'),
        ('${BOB}',   'bob-apple', 99, 'fruit');
      create policy "own items" on public.items for select
        to authenticated using ( owner = (select auth.uid()) );
    `);

    const q = async (query: string) => {
      const r = await req('GET', `/rest/v1/items?${query}`, { role: 'authenticated', sub: ALICE });
      expectStatus(r, [200, 206], `GET ?${query}`);
      return r.json() as Array<Record<string, unknown>>;
    };

    // The gateway parses none of this — it cannot, by design (D-016) — so what is
    // under test is that an opaque query string survives the hop and that
    // PostgREST's own operators still apply *on top of* the policy rather than
    // instead of it. Bob's row has qty 99 and would top every one of these
    // orderings if the filter were applied without the policy.
    expect(await q('select=name&order=name')).toEqual(
      [{ name: 'apple' }, { name: 'banana' }, { name: 'cement' }]);
    expect(await q('select=name&qty=gt.4&order=name')).toEqual(
      [{ name: 'apple' }, { name: 'banana' }]);
    expect(await q('select=name&tag=eq.fruit&order=name')).toEqual(
      [{ name: 'apple' }, { name: 'banana' }]);
    expect(await q('select=name&name=like.*an*&order=name')).toEqual([{ name: 'banana' }]);
    expect(await q('select=name&tag=in.(fruit,material)&order=qty.desc')).toEqual(
      [{ name: 'banana' }, { name: 'apple' }, { name: 'cement' }]);
    expect(await q('select=name&order=name&limit=2')).toEqual(
      [{ name: 'apple' }, { name: 'banana' }]);
    expect(await q('select=name&order=name&limit=2&offset=2')).toEqual([{ name: 'cement' }]);
    // `or=` is the filter most likely to be mangled by a proxy, because of the
    // parentheses and the comma.
    expect(await q('select=name&or=(qty.eq.5,qty.eq.3)&order=name')).toEqual(
      [{ name: 'apple' }, { name: 'cement' }]);

    // Range headers, which is pagination by a different mechanism entirely.
    const ranged = await req('GET', '/rest/v1/items?select=name&order=name',
      { role: 'authenticated', sub: ALICE, headers: { range: '1-2', 'range-unit': 'items' } });
    expect([200, 206]).toContain(ranged.statusCode);
    expect(ranged.json()).toEqual([{ name: 'banana' }, { name: 'cement' }]);
  });

  t('embeds resolve across a foreign key — and the embedded table\'s RLS applies too',
    async () => {
      await migrate(`
        create table public.authors (id bigserial primary key, owner uuid, name text);
        insert into public.authors (owner, name) values ('${ALICE}', 'alice'), ('${BOB}', 'bob');
        create table public.books
          (id bigserial primary key, author_id bigint references public.authors(id), title text);
        insert into public.books (author_id, title) values
          (1, 'alice-book'), (2, 'bob-book');

        -- Only the parent gets a policy scoped to the owner. The child is
        -- readable per-row by anyone authenticated, which is the interesting
        -- case: the embed must not become a way around the parent's policy.
        create policy "own authors" on public.authors for select
          to authenticated using ( owner = (select auth.uid()) );
        create policy "all books" on public.books for select
          to authenticated using ( true );
      `);

      // Parent → child.
      const withBooks = await req('GET', '/rest/v1/authors?select=name,books(title)',
        { role: 'authenticated', sub: ALICE });
      expectStatus(withBooks, [200], 'embed parent→child');
      expect(withBooks.json()).toEqual([{ name: 'alice', books: [{ title: 'alice-book' }] }]);

      // Child → parent, which is where a leak would show: every book is readable,
      // so if the embed ignored the parent's policy, Bob's name would appear
      // under `bob-book`. It must come back null instead.
      const withAuthor = await req('GET', '/rest/v1/books?select=title,authors(name)&order=title',
        { role: 'authenticated', sub: ALICE });
      expectStatus(withAuthor, [200], 'embed child→parent');
      expect(withAuthor.json()).toEqual([
        { title: 'alice-book', authors: { name: 'alice' } },
        { title: 'bob-book', authors: null },
      ]);

      // And filtering *on* an embedded resource, which is the shape that makes
      // the query string hardest to pass through untouched.
      const inner = await req('GET',
        '/rest/v1/authors?select=name,books!inner(title)&books.title=like.*alice*',
        { role: 'authenticated', sub: ALICE });
      expectStatus(inner, [200], 'embed with inner filter');
      expect(inner.json()).toEqual([{ name: 'alice', books: [{ title: 'alice-book' }] }]);
    });

  t('RPC works, and a SECURITY INVOKER function is bound by the caller\'s policies',
    async () => {
      await migrate(`
        create table public.ledger (id bigserial primary key, owner uuid, amount int);
        insert into public.ledger (owner, amount) values
          ('${ALICE}', 10), ('${ALICE}', 32), ('${BOB}', 1000);
        create policy "own ledger" on public.ledger for select
          to authenticated using ( owner = (select auth.uid()) );

        -- SECURITY INVOKER is the default, and the default is the safe one: the
        -- function sees exactly what its caller may see.
        create or replace function public.my_total() returns int
        language sql stable
        as $fn$ select coalesce(sum(amount), 0)::int from public.ledger $fn$;
        grant execute on function public.my_total() to authenticated;

        create or replace function public.add_tax(amount int, rate numeric)
        returns numeric language sql immutable
        as $fn$ select round(amount * (1 + rate), 2) $fn$;
        grant execute on function public.add_tax(int, numeric) to authenticated;
      `);

      // The whole reason to assert this rather than assume it: the function's body
      // has no WHERE clause at all. Alice gets 42 and not 1042 because RLS applies
      // inside the function, so the policy is the query.
      const mine = await req('POST', '/rest/v1/rpc/my_total',
        { role: 'authenticated', sub: ALICE, body: {} });
      expectStatus(mine, [200], 'rpc my_total');
      expect(mine.json()).toBe(42);

      const bobs = await req('POST', '/rest/v1/rpc/my_total',
        { role: 'authenticated', sub: BOB, body: {} });
      expect(bobs.json()).toBe(1000);

      // Arguments in the body, which is the RPC shape a client SDK generates.
      const taxed = await req('POST', '/rest/v1/rpc/add_tax',
        { role: 'authenticated', sub: ALICE, body: { amount: 100, rate: 0.2 } });
      expectStatus(taxed, [200], 'rpc add_tax');
      expect(Number(taxed.json())).toBeCloseTo(120, 2);

      // GET-form RPC for an immutable function, which routes arguments through
      // the query string instead — a different path through the gateway.
      const viaGet = await req('GET', '/rest/v1/rpc/add_tax?amount=50&rate=0.1',
        { role: 'authenticated', sub: ALICE });
      expectStatus(viaGet, [200], 'rpc add_tax via GET');
      expect(Number(viaGet.json())).toBeCloseTo(55, 2);

      // And anon cannot call it: no grant, and the failure is a privilege error
      // rather than a 404 that would leave a caller guessing.
      const anon = await req('POST', '/rest/v1/rpc/my_total', { body: {} });
      expect(anon.statusCode).toBe(401);
      expect(anon.json().code).toBe('42501');
    });
});
