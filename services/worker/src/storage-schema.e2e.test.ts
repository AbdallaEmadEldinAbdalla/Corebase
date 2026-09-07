import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client, type QueryResultRow } from 'pg';
import { createDocker, type Docker } from './docker.ts';
import { ensureDeveloperRole, ensureStorageOwnership } from './project-admin.ts';
import { join } from 'node:path';

/**
 * P6a — the `storage` schema, and whether the documented policies can be written
 * at all.
 *
 * The interesting assertion is not that the tables exist. It is that a *customer*
 * — connected as their own role, with no platform privilege — can create the
 * policies the storage doc prints, and that those policies then decide what each
 * API role sees. Only a table's owner may create a policy, so this is the test
 * that would have caught the tables being owned by `postgres`: every documented
 * example would have failed with "must be owner of table objects", which reads
 * like a platform fault rather than a missing `ALTER TABLE ... OWNER TO`.
 */
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const PG_IMAGE = process.env.CB_PG_IMAGE ?? 'corebase/postgres:17.5';

const NET = 'cb-p6a-net';
const PG = 'cb-p6a-pg';
const PG_HOST_PORT = Number(process.env.CB_P6A_PG_PORT ?? 5461);

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

let docker: Docker; let up = false; let reason = '';
/** The customer's own connection: writes DDL and policies, owns the tables. */
let dev: Client;
/**
 * The connection that impersonates API roles, and it is deliberately not `dev`.
 *
 * The first version of this file had the customer's role `SET ROLE authenticated`
 * and it failed with `permission denied to set role` — correctly, and the
 * isolation suite's DB-3 is the test that says so. A customer who could become
 * the role a request runs as would inherit a different privilege set than their
 * own.
 *
 * `authenticator` is the role that legitimately holds that power: it is the login
 * role PostgREST and the storage service connect as, it is NOINHERIT so it can do
 * nothing as itself, and switching down into an API role is its entire job.
 */
let auth: Client;

beforeAll(async () => {
  try {
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 60_000 });
    await docker.ping();
    if (!(await docker.imageExists(PG_IMAGE))) {
      throw new Error(`${PG_IMAGE} is not on the data node — ./scripts/staging.sh seed-images`);
    }
    await teardown();
    await docker.createNetwork(NET, {});
    await docker.createContainer(PG, {
      Image: PG_IMAGE, Env: ['POSTGRES_PASSWORD=p6asmoke'],
      Labels: { 'com.corebase.managed': 'true' },
      HostConfig: {
        Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 1e9,
        RestartPolicy: { Name: 'no' }, Mounts: [],
        PortBindings: { '5432/tcp': [{ HostPort: String(PG_HOST_PORT) }] },
      },
      ExposedPorts: { '5432/tcp': {} },
      NetworkingConfig: { EndpointsConfig: { [NET]: {} } },
    });
    await docker.startContainer(PG);

    // Both signals, per the lesson P5d paid for twice: the init phase runs a
    // temporary server that is then shut down, so a role appearing is not the
    // same as the database being usable.
    let initDone = false;
    for (let i = 0; i < 180; i++) {
      const log = String(await docker.containerLogs(PG).catch(() => ''));
      if (log.includes('init process complete')) { initDone = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    let ready = false;
    for (let i = 0; initDone && i < 120; i++) {
      const r = await docker.execCapture(PG, ['psql', '-U', 'postgres', '-tAc',
        `select 1 from pg_roles where rolname = 'authenticator'`]);
      if (r.exitCode === 0 && r.stdout.trim() === '1') { ready = true; break; }
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    if (!ready) {
      const logs = await docker.containerLogs(PG).catch(() => '');
      throw new Error('the project database never became usable:\n'
        + String(logs).slice(-1200));
    }

    const su = new Client({
      host: '127.0.0.1', port: PG_HOST_PORT, database: 'postgres',
      user: 'postgres', password: 'p6asmoke', connectionTimeoutMillis: 8000 });
    await su.connect();
    // The real provisioning functions, not a hand-rolled copy of what they do.
    await ensureDeveloperRole(su);
    await ensureStorageOwnership(su);
    await su.query(`ALTER ROLE developer WITH PASSWORD 'p6adev'`);
    await su.query(`ALTER ROLE authenticator WITH PASSWORD 'p6aauth'`);
    // Two users, so `owner` references resolve and the avatar policy has
    // somebody to be about.
    await su.query(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at)
       VALUES ($1,'alice@example.com','x',now()), ($2,'bob@example.com','x',now())`,
      [ALICE, BOB]);
    await su.end();

    dev = new Client({
      host: '127.0.0.1', port: PG_HOST_PORT, database: 'postgres',
      user: 'developer', password: 'p6adev', connectionTimeoutMillis: 8000 });
    await dev.connect();
    auth = new Client({
      host: '127.0.0.1', port: PG_HOST_PORT, database: 'postgres',
      user: 'authenticator', password: 'p6aauth', connectionTimeoutMillis: 8000 });
    await auth.connect();
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P6a setup FAILED:', reason);
    up = false;
  }
}, 240_000);

async function teardown() {
  await docker.removeContainer(PG, true, true).catch(() => {});
  await docker.removeNetwork(NET).catch(() => {});
}

afterAll(async () => {
  await auth?.end().catch(() => {});
  await dev?.end().catch(() => {});
  if (docker) await teardown();
  docker?.close?.();
}, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 60_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P6a preconditions not met (${reason}) — `
      + './scripts/staging.sh up && seed-images. '
      + 'This is the P6a done-signal and must not skip silently.');
    await fn();
  }, ms);

/**
 * Runs a statement as one of the API roles, with the claims a request would
 * carry — the same context-injection the data API and the storage service use.
 * `SET LOCAL` inside a transaction, because that is the only session-state
 * pattern that survives transaction pooling.
 */
async function asRole<T extends QueryResultRow = QueryResultRow>(
  role: 'anon' | 'authenticated' | 'service_role', sql: string, sub?: string,
): Promise<{ rows: T[]; error?: string }> {
  const claims = JSON.stringify({ role, ...(sub ? { sub } : {}) });
  await auth.query('BEGIN');
  try {
    await auth.query(`SET LOCAL ROLE ${role}`);
    await auth.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
    const res = await auth.query<T>(sql);
    await auth.query('COMMIT');
    return { rows: res.rows };
  } catch (err) {
    await auth.query('ROLLBACK').catch(() => {});
    return { rows: [], error: (err as Error).message };
  }
}

describe('P6a — the schema arrives closed', () => {
  t('every table has RLS on and no policies, so no API role sees anything', async () => {
    const { rows } = await dev.query<{ tbl: string; rls: boolean; policies: number }>(`
      select c.relname as tbl, c.relrowsecurity as rls,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'storage' and c.relkind = 'r'
       order by c.relname`);
    expect(rows.map((r) => r.tbl)).toEqual(
      ['buckets', 'objects', 'upload_intents', 'usage']);
    for (const r of rows) {
      if (r.tbl === 'usage') continue;   // platform bookkeeping, no RLS needed
      expect(r.rls, `${r.tbl} rls`).toBe(true);
      expect(r.policies, `${r.tbl} policies`).toBe(0);
    }
  });

  t('a bucket and object seeded by the owner are invisible to anon and authenticated',
    async () => {
      await dev.query(`insert into storage.buckets (name, public) values ('assets', false)`);
      await dev.query(`
        insert into storage.objects (bucket_id, name, owner, size, etag)
        select storage.bucket_id('assets'), 'logo.png', null, 100, 'e1'`);

      for (const role of ['anon', 'authenticated'] as const) {
        const got = await asRole(role, 'select name from storage.objects');
        expect(got.error, `${role} error`).toBeUndefined();
        expect(got.rows, `${role} rows`).toEqual([]);
      }
      // The control: service_role bypasses by attribute, so the row is really
      // there and the empty results above are RLS deciding.
      const svc = await asRole<{ name: string }>('service_role', 'select name from storage.objects');
      expect(svc.rows.map((r) => r.name)).toEqual(['logo.png']);
    });

  t('anon holds the table grant, so its empty read is RLS and not a privilege error',
    async () => {
      // D-391's departure from D-108, asserted rather than assumed. If the grant
      // were missing, every documented `TO anon` policy would fail with a
      // privilege error instead of working — and the read above would have
      // "passed" for the wrong reason.
      const { rows } = await dev.query<{ n: number }>(`
        select count(*)::int as n from information_schema.role_table_grants
         where table_schema = 'storage' and table_name = 'objects'
           and grantee = 'anon' and privilege_type = 'SELECT'`);
      expect(rows[0]!.n).toBe(1);
    });
});

describe('P6a — the documented policies, written by the customer, verbatim', () => {
  t('pattern 1 — a public-read bucket: anyone reads, only service_role writes',
    async () => {
      // Exactly as the doc prints it. The customer's own connection creates it,
      // which is only possible because the table is theirs (P6a).
      await dev.query(`
        CREATE POLICY "assets are readable by all"
          ON storage.objects FOR SELECT
          TO anon, authenticated
          USING (bucket_id = storage.bucket_id('assets'));`);

      for (const role of ['anon', 'authenticated'] as const) {
        const got = await asRole<{ name: string }>(role, 'select name from storage.objects');
        expect(got.rows.map((r) => r.name), `${role} reads`).toEqual(['logo.png']);
      }
      // No INSERT policy exists, so writes are still refused — the second half of
      // the pattern, and the half a reader would assume rather than check.
      const write = await asRole('authenticated', `
        insert into storage.objects (bucket_id, name, size, etag)
        values (storage.bucket_id('assets'), 'sneaky.png', 1, 'e')`);
      expect(write.error).toMatch(/row-level security|permission denied/);
    });

  t('pattern 2 — avatars: signed-in users read, each writes only their own folder',
    async () => {
      await dev.query(`insert into storage.buckets (name, public) values ('avatars', false)`);
      await dev.query(`
        CREATE POLICY "avatars are readable by signed-in users"
          ON storage.objects FOR SELECT TO authenticated
          USING (bucket_id = storage.bucket_id('avatars'));

        CREATE POLICY "users manage their own avatar folder"
          ON storage.objects FOR ALL TO authenticated
          USING (bucket_id = storage.bucket_id('avatars')
                 AND storage.prefix_owner(name) = auth.uid()::text)
          WITH CHECK (bucket_id = storage.bucket_id('avatars')
                      AND storage.prefix_owner(name) = auth.uid()::text);`);

      // Alice writes under her own uid — the EXIT CRITERION's "avatars own-path
      // case", and the reason `prefix_owner` exists.
      const mine = await asRole('authenticated', `
        insert into storage.objects (bucket_id, name, owner, size, etag)
        select storage.bucket_id('avatars'), '${ALICE}/photo.png', '${ALICE}', 10, 'a1'
`, ALICE);
      expect(mine.error).toBeUndefined();

      // And under Bob's — refused by WITH CHECK, which is the half that matters:
      // a USING-only policy would filter reads and let this write land.
      const theirs = await asRole('authenticated', `
        insert into storage.objects (bucket_id, name, owner, size, etag)
        select storage.bucket_id('avatars'), '${BOB}/planted.png', '${ALICE}', 10, 'a2'
`, ALICE);
      expect(theirs.error).toMatch(/row-level security/);

      // Reads are deliberately wider than writes in this pattern: any signed-in
      // user sees any avatar. Asserting it stops a future "tighten the policy"
      // from silently changing the documented behaviour.
      const bobReads = await asRole<{ name: string }>('authenticated',
        `select name from storage.objects where name like '%photo.png'`, BOB);
      expect(bobReads.rows.map((r) => r.name)).toEqual([`${ALICE}/photo.png`]);

      // Bob cannot delete it, though — FOR ALL is scoped by the same prefix.
      const bobDeletes = await asRole('authenticated',
        `delete from storage.objects where name = '${ALICE}/photo.png'`, BOB);
      expect(bobDeletes.rows).toEqual([]);
      const stillThere = await asRole<{ n: string }>('service_role',
        `select count(*)::text as n from storage.objects where name = '${ALICE}/photo.png'`);
      expect(stillThere.rows[0]!.n).toBe('1');
    });

  t('pattern 3 — org-shared files gated by a membership table in the customer\'s schema',
    async () => {
      await dev.query(`
        create table public.org_members (user_id uuid, org_id uuid, primary key (user_id, org_id));
        insert into public.org_members values ('${ALICE}', '33333333-3333-4333-8333-333333333333');
        grant select on public.org_members to authenticated;
        -- The piece the doc was missing, and the reason pattern 3 failed: the
        -- policy's subselect reads this table *as the caller*, and the event
        -- trigger put RLS on it at creation. Without a policy here the caller
        -- sees no memberships, the predicate is false, and the bucket is closed
        -- to everybody with no error to explain it.
        CREATE POLICY "members read their own memberships"
          ON public.org_members FOR SELECT TO authenticated
          USING (user_id = (SELECT auth.uid()));
        insert into storage.buckets (name, public) values ('org-files', false);

        CREATE POLICY "org members access org files"
          ON storage.objects FOR ALL TO authenticated
          USING (bucket_id = storage.bucket_id('org-files')
                 AND storage.prefix_owner(name) IN
                     (SELECT org_id::text FROM public.org_members WHERE user_id = auth.uid()))
          WITH CHECK (bucket_id = storage.bucket_id('org-files')
                      AND storage.prefix_owner(name) IN
                          (SELECT org_id::text FROM public.org_members WHERE user_id = auth.uid()));`);

      const inOrg = await asRole('authenticated', `
        insert into storage.objects (bucket_id, name, owner, size, etag)
        select storage.bucket_id('org-files'), '33333333-3333-4333-8333-333333333333/report.pdf', '${ALICE}', 20, 'o1'
`, ALICE);
      expect(inOrg.error).toBeUndefined();

      // Bob is in no org, so the subselect is empty and the predicate is false —
      // not an error, which is the failure mode worth checking: a claim-driven
      // policy whose lookup returns nothing must deny rather than match all.
      const notInOrg = await asRole('authenticated', `
        insert into storage.objects (bucket_id, name, owner, size, etag)
        select storage.bucket_id('org-files'), '33333333-3333-4333-8333-333333333333/sneak.pdf', '${BOB}', 20, 'o2'
`, BOB);
      expect(notInOrg.error).toMatch(/row-level security/);
      const bobSees = await asRole('authenticated',
        `select name from storage.objects where name like '%report.pdf'`, BOB);
      expect(bobSees.rows).toEqual([]);
    });
});

describe('P6a — quota accounting, on the fast path', () => {
  t('the trigger tracks inserts, overwrites and deletes without any API role\'s help',
    async () => {
      // Read as `service_role`, because that is the role the storage service
      // connects as and the only one granted SELECT here. Reading it as the
      // customer failed with `permission denied for table usage` — correct, and
      // the reason the grant exists at all.
      const usage = async () => (await asRole<{ b: string; c: string }>('service_role',
        `select total_bytes::text as b, object_count::text as c from storage.usage`)).rows[0]!;
      const before = await usage();

      // Inserted as `authenticated`, which has no privilege on `storage.usage` at
      // all. The trigger is SECURITY DEFINER precisely so this works; without it
      // the upload fails on a permission error *inside* the trigger, which reads
      // as the upload being refused.
      await asRole('authenticated', `
        insert into storage.objects (bucket_id, name, owner, size, etag)
        select storage.bucket_id('avatars'), '${ALICE}/big.png', '${ALICE}', 5000, 'q1'
`, ALICE);
      const afterInsert = await usage();
      expect(Number(afterInsert.b) - Number(before.b)).toBe(5000);
      expect(Number(afterInsert.c) - Number(before.c)).toBe(1);

      // An overwrite moves only the delta — the row survives, so counting it
      // again would inflate the project's bill.
      await asRole('authenticated',
        `update storage.objects set size = 7000 where name = '${ALICE}/big.png'`, ALICE);
      expect(Number((await usage()).b) - Number(before.b)).toBe(7000);
      expect(Number((await usage()).c) - Number(before.c)).toBe(1);

      await asRole('authenticated',
        `delete from storage.objects where name = '${ALICE}/big.png'`, ALICE);
      expect((await usage()).b).toBe(before.b);
      expect((await usage()).c).toBe(before.c);
    });

  t('a customer cannot edit their own quota row', async () => {
    // Quota is a billing boundary. It is not a security boundary — the doc says
    // so — but it must not be *self-service*, and the way that is enforced is the
    // absence of a grant rather than a policy.
    for (const role of ['anon', 'authenticated', 'service_role'] as const) {
      const got = await asRole(role, 'update storage.usage set total_bytes = 0');
      expect(got.error, `${role}`).toMatch(/permission denied/);
    }
  });
});

describe('P6a — the path check is in the column, not only in the service', () => {
  t('refuses traversal, absolute paths and over-long names', async () => {
    const bucket = `storage.bucket_id('assets')`;
    for (const bad of ['../etc/passwd', 'a/../../b', '/absolute.png', '..']) {
      const got = await dev.query(
        `insert into storage.objects (bucket_id, name, size, etag)
         values (${bucket}, $1, 1, 'e')`, [bad]).then(() => undefined, (e: Error) => e.message);
      expect(got, bad).toMatch(/violates check constraint/);
    }
    const long = 'a'.repeat(1025);
    await expect(dev.query(
      `insert into storage.objects (bucket_id, name, size, etag)
       values (${bucket}, $1, 1, 'e')`, [long])).rejects.toThrow(/violates check constraint/);

    // The control: a path that merely *contains* dots is fine. A check that
    // rejected `photo..png` or `v1.2/logo.png` would be a bug of its own.
    await expect(dev.query(
      `insert into storage.objects (bucket_id, name, size, etag)
       values (${bucket}, $1, 1, 'e')`, ['v1.2/photo..png'])).resolves.toBeTruthy();
  });
});
