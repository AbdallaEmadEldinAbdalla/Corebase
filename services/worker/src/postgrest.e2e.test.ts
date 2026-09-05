import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeypair, toJwk, sign } from '@corebase/jwt';
import { createDocker, type Docker } from './docker.ts';
import { join } from 'node:path';

/**
 * P5b — the per-project PostgREST image, against a real database.
 *
 * Everything here is a claim the config file makes and cannot keep on its own,
 * and every one of them failed at least once while being written:
 *
 *   - `db-pre-request` names a function that has to exist, or **every request
 *     that carries a token** fails with a schema-permission error while `/ready`
 *     cheerfully answers 200;
 *   - PostgREST introspects `information_schema`, which the project image revokes
 *     from PUBLIC — so `authenticator` needs it back explicitly or the API starts,
 *     connects, and serves 503 forever;
 *   - the four-role model has to survive the trip through HTTP, not just exist in
 *     `pg_roles`.
 *
 * The one that matters most is the last group: `anon` and `authenticated` seeing
 * nothing on a table with no policy, `service_role` seeing everything, and a
 * policy on `auth.uid()` giving a user exactly their own rows. That is the whole
 * identity→policy pipeline, and it is the phase's demo in three assertions.
 */
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const PG_IMAGE = process.env.CB_PG_IMAGE ?? 'corebase/postgres:17.5';
const PGRST_IMAGE = process.env.CB_POSTGREST_IMAGE ?? 'corebase/postgrest:12.2';

const NET = 'cb-p5b-net';
const PG = 'cb-p5b-pg';
const PGRST = 'cb-p5b-pgrst';
// Inside the data node's published PostgREST range (P5b). A port outside it is
// unreachable from the host, and the symptom is a readiness probe timing out
// against a PostgREST that logged "Schema cache loaded" a second earlier.
const PGRST_PORT = Number(process.env.CB_P5B_PORT ?? 7491);
const ADMIN_PORT = PGRST_PORT + 1;

let docker: Docker; let up = false; let reason = '';
let keys: { anon: string; user: string; service: string };
const USER_ID = '11111111-1111-4111-8111-111111111111';

const api = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${PGRST_PORT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

async function sql(statements: string): Promise<string> {
  const r = await docker.execCapture(PG, ['psql', '-U', 'postgres', '-q', '-c', statements]);
  if (r.exitCode !== 0) throw new Error(`psql failed: ${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

beforeAll(async () => {
  try {
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 60_000 });
    await docker.ping();
    for (const image of [PG_IMAGE, PGRST_IMAGE]) {
      if (!(await docker.imageExists(image))) {
        throw new Error(`${image} is not on the data node — run ./scripts/staging.sh seed-images`);
      }
    }
    await teardown();
    await docker.createNetwork(NET, {});

    await docker.createContainer(PG, {
      Image: PG_IMAGE, Env: ['POSTGRES_PASSWORD=p5bsmoke'],
      Labels: { 'com.corebase.managed': 'true' },
      HostConfig: {
        Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 1e9,
        RestartPolicy: { Name: 'no' }, Mounts: [], PortBindings: {},
      },
      ExposedPorts: {},
      NetworkingConfig: { EndpointsConfig: { [NET]: {} } },
    });
    await docker.startContainer(PG);
    for (let i = 0; i < 60; i++) {
      const r = await docker.execCapture(PG, ['pg_isready', '-U', 'postgres', '-q']);
      if (r.exitCode === 0) break;
      await new Promise((r2) => setTimeout(r2, 1000));
    }

    // The project's published keys, exactly as P4h's rotation would produce them.
    const pair = generateKeypair();
    const now = Math.floor(Date.now() / 1000);
    const tok = (role: 'anon' | 'authenticated' | 'service_role', sub?: string) => sign({
      iss: 'https://p5b.localhost/auth/v1', ref: 'p5b', role,
      ...(sub ? { sub, aud: 'authenticated' } : {}),
      iat: now, exp: now + 3600,
    }, { privateKeyPem: pair.privateKeyPem, kid: pair.kid });
    keys = { anon: tok('anon'), user: tok('authenticated', USER_ID), service: tok('service_role') };

    await sql(`ALTER ROLE authenticator WITH PASSWORD 'p5bauth'`);
    await docker.createContainer(PGRST, {
      Image: PGRST_IMAGE,
      Env: [
        'COREBASE_REF=p5b',
        `COREBASE_PG_HOST=${PG}`,
        `PGRST_DB_URI=postgres://authenticator:p5bauth@${PG}:5432/postgres`,
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
      // Its own logs, because "never became ready" with nothing else is the
      // diagnostic this repository has been bitten by five times.
      const logs = await docker.containerLogs(PGRST).catch(() => '');
      throw new Error(`PostgREST never became ready:\n${String(logs).slice(-1200)}`);
    }
  } catch (err) {
    reason = (err as Error).message;
    console.error('P5b setup FAILED:', reason);
    up = false;
  }
}, 180_000);

async function teardown() {
  for (const c of [PGRST, PG]) await docker.removeContainer(c, true, true).catch(() => {});
  await docker.removeNetwork(NET).catch(() => {});
}

afterAll(async () => { if (docker) await teardown(); docker?.close?.(); }, 60_000);

const t = (n: string, fn: () => Promise<void>, ms = 90_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P5b preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && seed-images. ' +
      'This is the P5b done-signal and must not skip silently.');
    await fn();
  }, ms);

describe('P5b — PostgREST serves a project', () => {
  t('the admin server separates liveness from readiness', async () => {
    // Two different questions, and the reconciler needs both: `/live` says the
    // process is up, `/ready` says it reached Postgres and built a schema cache.
    // A container-local healthcheck could only ever answer the first, which is
    // why this image has none.
    expect((await fetch(`http://127.0.0.1:${ADMIN_PORT}/live`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${ADMIN_PORT}/ready`)).status).toBe(200);
  });

  t('EXIT CRITERION: default-deny holds through HTTP, and service_role bypasses it',
    async () => {
      await sql(`
        CREATE TABLE public.notes (id serial primary key, owner uuid, body text);
        INSERT INTO public.notes (owner, body) VALUES
          ('${USER_ID}', 'mine'),
          ('22222222-2222-4222-8222-222222222222', 'theirs');
        GRANT SELECT ON public.notes TO anon, authenticated;`);
      await new Promise((r) => setTimeout(r, 2000));   // the DDL reload

      // A brand-new table with a SELECT grant and no policy. The grant is what
      // makes this interesting: without RLS it would be a public dump, and the
      // force-RLS trigger is what turns it into nothing.
      expect(await (await api('/notes', keys.anon)).json()).toEqual([]);
      expect(await (await api('/notes', keys.user)).json()).toEqual([]);
      // BYPASSRLS, which is why this key must never reach a browser.
      expect(await (await api('/notes', keys.service)).json()).toHaveLength(2);
    });

  t('a forged token is refused; an absent one falls back to anon — which is why D-109 exists',
    async () => {
      // A tampered signature never reaches SQL. This is the boundary the whole
      // data plane rests on: a token from another project fails verification
      // before any query runs.
      expect((await api('/notes', keys.anon + '.tampered')).status).toBe(401);

      // But a request with **no** `Authorization` at all is *not* refused — it is
      // served as `db-anon-role`. That surprised this test, which asserted 401 and
      // got 404 (anon, on a table that did not exist yet).
      //
      // It is also exactly why D-109 has the gateway inject
      // `Authorization: Bearer <apikey>` when the header is absent: without it
      // PostgREST has two authorization paths — "verify a token" and "fall back to
      // anon" — and the second is the one nobody writes tests for. With the
      // injection there is one path, and `db-anon-role` handles nothing
      // security-relevant on its own.
      //
      // Until the gateway lands (P5c) this fallback is reachable, and what makes
      // it safe meanwhile is the posture rather than the plumbing: default-deny
      // means anon sees nothing it was not granted *and* given a policy for.
      const tokenless = await fetch(`http://127.0.0.1:${PGRST_PORT}/notes`);
      expect(tokenless.status).toBe(200);
      expect(await tokenless.json()).toEqual([]);
    });

  t('EXIT CRITERION: a policy on auth.uid() gives a user exactly their own rows',
    async () => {
      await sql(`CREATE POLICY notes_own ON public.notes FOR SELECT TO authenticated
                 USING (owner = auth.uid());`);
      await new Promise((r) => setTimeout(r, 1500));

      // The whole identity→policy pipeline in one assertion: a JWT verified by
      // PostgREST against the project's JWKS, its `role` claim selecting a
      // Postgres role, its `sub` claim reaching `auth.uid()` inside a policy.
      const mine = await (await api('/notes', keys.user)).json() as Array<{ owner: string }>;
      expect(mine).toHaveLength(1);
      expect(mine[0]!.owner).toBe(USER_ID);
      // …and the policy is scoped `TO authenticated`, so anon gains nothing from
      // its existence.
      expect(await (await api('/notes', keys.anon)).json()).toEqual([]);
    });

  t('EXIT CRITERION: DDL reloads the schema cache with no restart (D-100)', async () => {
    // The classic embedded-PostgREST failure is "I created the table and the API
    // 404s". The event trigger in the project image is what makes the reload
    // source-agnostic: this DDL arrives over psql, not through any Corebase code
    // path, and the API picks it up anyway.
    expect((await api('/widgets', keys.service)).status).toBe(404);
    await sql(`CREATE TABLE public.widgets (id serial primary key, name text);
               INSERT INTO public.widgets (name) VALUES ('a');
               GRANT SELECT ON public.widgets TO service_role;`);
    await new Promise((r) => setTimeout(r, 3000));
    expect((await api('/widgets', keys.service)).status).toBe(200);
  });

  t('the request id reaches application_name (D-105)', async () => {
    await sql(`CREATE OR REPLACE FUNCTION public.whoami() RETURNS text
                 LANGUAGE sql SECURITY INVOKER
                 AS $$ SELECT current_setting('application_name', true) $$;
               GRANT EXECUTE ON FUNCTION public.whoami() TO service_role;`);
    await new Promise((r) => setTimeout(r, 2500));

    // Without this a customer reporting "the API was slow at 14:03" leaves an
    // operator correlating timestamps by hand.
    const stamped = await api('/rpc/whoami', keys.service, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'req_p5b' } });
    expect(await stamped.json()).toBe('pgrst:req_p5b');

    // And a request without the header still works — a developer's own curl is
    // normal, and a bookkeeping hook must never fail a request.
    const bare = await api('/rpc/whoami', keys.service, {
      method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(bare.status).toBe(200);
  });
});
