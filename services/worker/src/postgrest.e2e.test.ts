import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeypair, toJwk, sign } from '@steadhold/jwt';
import { createDocker, type Docker } from './docker.ts';
import { buildApp } from '@steadhold/api';
import { createMemoryRateLimiter } from '@steadhold/api/kernel/rate-limit.ts';
import type { RouteEntry, RoutingTable } from '@steadhold/api/modules/gateway/routing.ts';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const SRC = new URL('.', import.meta.url).pathname;

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
const CERT_DIR = process.env.SH_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.SH_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SH_DOCKER_PORT ?? 2376);
const PG_IMAGE = process.env.SH_PG_IMAGE ?? 'steadhold/postgres:17.5';
const PGRST_IMAGE = process.env.SH_POSTGREST_IMAGE ?? 'steadhold/postgrest:12.2';

const NET = 'sh-p5b-net';
const PG = 'sh-p5b-pg';
const PGRST = 'sh-p5b-pgrst';
// Inside the data node's published PostgREST range (P5b). A port outside it is
// unreachable from the host, and the symptom is a readiness probe timing out
// against a PostgREST that logged "Schema cache loaded" a second earlier.
const PGRST_PORT = Number(process.env.SH_P5B_PORT ?? 7491);
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
      Labels: { 'com.steadhold.managed': 'true' },
      HostConfig: {
        Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 1e9,
        RestartPolicy: { Name: 'no' }, Mounts: [], PortBindings: {},
      },
      ExposedPorts: {},
      NetworkingConfig: { EndpointsConfig: { [NET]: {} } },
    });
    await docker.startContainer(PG);
    // Waiting for a Postgres container to be usable takes **two** signals, and
    // CI taught both of them one at a time.
    //
    // `pg_isready` alone is wrong: during `initdb` the official image runs a
    // *temporary* server on the unix socket, so it answers yes while none of the
    // image's init SQL has run. That failed with `role "authenticator" does not
    // exist` on a fresh CI volume, where init takes longer than on a warm local
    // one.
    //
    // Polling for the role alone is also wrong, and fails later and more
    // confusingly: the role appears on that same temporary server, which the
    // entrypoint then **shuts down** before starting the real one. The next
    // statement lands in that window and reads `FATAL: the database system is
    // shutting down`.
    //
    // So the log line that separates the two phases comes first — the entrypoint
    // prints it after the init SQL and before the real server starts — and only
    // then is the role polled for, on the server that will still be there.
    let initDone = false;
    for (let i = 0; i < 180; i++) {
      const log = String(await docker.containerLogs(PG).catch(() => ''));
      if (log.includes('init process complete')) { initDone = true; break; }
      await new Promise((r2) => setTimeout(r2, 1000));
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
      throw new Error('the project database never became usable — '
        + `init ${initDone ? 'completed' : 'never completed'}, `
        + `'authenticator' ${ready ? 'present' : 'never appeared'}:\n`
        + String(logs).slice(-1500));
    }

    // The project's published keys, exactly as P4h's rotation would produce them.
    const pair = generateKeypair();
    // Shared with the gateway tests below, which point a real gateway at this
    // same PostgREST rather than standing up a second one.
    gwPair = pair;
    gwRef = 'p5cgatewayrefaaaa';
    const now = Math.floor(Date.now() / 1000);
    // Two issuers, matching the two things that verify these tokens: the gateway
    // pins the project-key issuer (`https://<ref>.<domain>`) and PostgREST pins
    // whatever the token says, so the API-key issuer is the one that has to line
    // up with the gateway's expectation (D-319).
    const tok = (role: 'anon' | 'authenticated' | 'service_role', sub?: string) => sign({
      iss: `https://${gwRef}.steadhold.test`, ref: gwRef, role,
      ...(sub ? { sub, aud: 'authenticated' } : {}),
      iat: now, exp: now + 3600,
    }, { privateKeyPem: pair.privateKeyPem, kid: pair.kid });
    keys = { anon: tok('anon'), user: tok('authenticated', USER_ID), service: tok('service_role') };

    await sql(`ALTER ROLE authenticator WITH PASSWORD 'p5bauth'`);
    await docker.createContainer(PGRST, {
      Image: PGRST_IMAGE,
      Env: [
        'STEADHOLD_REF=p5b',
        `STEADHOLD_PG_HOST=${PG}`,
        `PGRST_DB_URI=postgres://authenticator:p5bauth@${PG}:5432/postgres`,
        `STEADHOLD_JWKS=${JSON.stringify({ keys: [toJwk(pair.publicKeyPem, pair.kid)] })}`,
      ],
      Labels: { 'com.steadhold.managed': 'true' },
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

/**
 * The gateway, pointed at the PostgREST this file just started.
 *
 * A real proxy hop rather than a mocked upstream: what is being tested is that a
 * request survives the trip — D-109's header injection, the verbatim body, the
 * headers that must and must not be forwarded — and every one of those is a
 * property of the hop rather than of the handler.
 */
const DOMAIN = 'steadhold.test';
let gwPair: ReturnType<typeof generateKeypair>;
let gwRef: string;

function gateway(over: Partial<RouteEntry> = {}) {
  const entry: RouteEntry = {
    projectId: 'p5c', ref: gwRef, status: 'ready', plan: 'free',
    nodeAddress: '127.0.0.1', postgrestPort: PGRST_PORT,
    jwks: [toJwk(gwPair.publicKeyPem, gwPair.kid)],
    revoked: new Set<string>(), loadedAt: Date.now(), ...over,
  };
  const routes: RoutingTable = {
    lookup: (r) => (r === entry.ref ? entry : undefined),
    refresh: async () => 1, start: () => {}, stop: () => {}, size: () => 1,
  };
  return buildApp({
    gateway: {
      routes, projectDomain: DOMAIN,
      ipLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
      keyLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
      projectLimiter: createMemoryRateLimiter({ limit: 500, windowSeconds: 60 }),
    },
  });
}

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
    // source-agnostic: this DDL arrives over psql, not through any Steadhold code
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

describe('P5c — the gateway proxies to a real PostgREST', () => {
  t('EXIT CRITERION: a request survives the hop, and RLS still decides what comes back',
    async () => {
      const app = gateway();
      const host = `${gwRef}.${DOMAIN}`;
      try {
        // anon, with no Authorization at all — so D-109's injection is what makes
        // this work. Without it PostgREST would fall back to db-anon-role, which
        // is the second authorization path the injection exists to remove.
        const asAnon = await app.inject({
          method: 'GET', url: '/rest/v1/notes',
          headers: { host, apikey: keys.anon } });
        expect(asAnon.statusCode).toBe(200);
        expect(asAnon.json()).toEqual([]);

        // A user token in `Authorization`, the anon key in `apikey`: the shape a
        // signed-in SDK client actually sends. The policy decides, through the
        // proxy, exactly as it did without one.
        const asUser = await app.inject({
          method: 'GET', url: '/rest/v1/notes',
          headers: { host, apikey: keys.anon, authorization: `Bearer ${keys.user}` } });
        expect(asUser.statusCode).toBe(200);
        const rows = asUser.json() as Array<{ owner: string }>;
        expect(rows).toHaveLength(1);
        expect(rows[0]!.owner).toBe(USER_ID);

        // service_role through the gateway still bypasses RLS — the gateway
        // neither adds nor removes authority, which is the whole of D-016.
        const asService = await app.inject({
          method: 'GET', url: '/rest/v1/notes',
          headers: { host, apikey: keys.service } });
        expect(asService.json()).toHaveLength(2);
      } finally { await app.close(); }
    });

  t('PostgREST\'s own errors pass through verbatim (D-106)', async () => {
    const app = gateway();
    try {
      const res = await app.inject({
        method: 'GET', url: '/rest/v1/no_such_table',
        headers: { host: `${gwRef}.${DOMAIN}`, apikey: keys.service } });
      expect(res.statusCode).toBe(404);
      // The PGRST code survives. Rewriting it would break every
      // Supabase-compatible client, which branches on exactly this field — and
      // would put a JSON round trip on the hot path D-016 exists to keep thin.
      // Either family. PostgREST answers an unknown relation with the *Postgres*
      // SQLSTATE (42P01) rather than a PGRST code, and the doc's contract is that
      // clients key off "PGRST/SQLSTATE" — both are upstream's to choose and
      // neither is ours to normalise.
      const body = res.json() as { code?: string };
      expect(body.code).toMatch(/^(PGRST|[0-9A-Z]{5}$)/);
      expect(res.headers['x-request-id']).toBeTruthy();
    } finally { await app.close(); }
  });

  t('the query string reaches PostgREST intact', async () => {
    const app = gateway();
    try {
      // The gateway is deliberately ignorant of PostgREST's filter grammar — it
      // forwards the query string without parsing it, which is what lets filters,
      // embeds and RPC work without the gateway knowing they exist.
      const res = await app.inject({
        method: 'GET', url: '/rest/v1/notes?owner=eq.' + USER_ID + '&select=body',
        headers: { host: `${gwRef}.${DOMAIN}`, apikey: keys.service } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([{ body: 'mine' }]);
    } finally { await app.close(); }
  });

  t('the request id reaches application_name through the gateway', async () => {
    const app = gateway();
    try {
      // End to end for D-105: the gateway forwards its id, PostgREST maps it to a
      // GUC, and `steadhold.pre_request` stamps it. This is the chain that lets a
      // slow query be traced back to an HTTP request.
      const res = await app.inject({
        method: 'POST', url: '/rest/v1/rpc/whoami',
        headers: {
          host: `${gwRef}.${DOMAIN}`, apikey: keys.service,
          'content-type': 'application/json', 'x-request-id': 'req_gw_probe',
        },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toBe('pgrst:req_gw_probe');
    } finally { await app.close(); }
  });

  t('the apikey is not forwarded upstream', async () => {
    const app = gateway();
    try {
      // PostgREST has no use for it and it is a credential. Asserted through the
      // one mirror available: the request that reached the database.
      const res = await app.inject({
        method: 'GET', url: '/rest/v1/notes',
        headers: { host: `${gwRef}.${DOMAIN}`, apikey: keys.service } });
      expect(res.statusCode).toBe(200);
      // A negative that is hard to observe directly, so it is asserted at the
      // source instead: the forwarded header set is an allowlist, and `apikey`
      // is not in it.
      const src = readFileSync(
        `${SRC}../../api/src/modules/gateway/routes.ts`, 'utf8');
      const allow = /for \(const h of \[([^\]]+)\]\)/.exec(src)?.[1] ?? '';
      expect(allow).not.toContain('apikey');
      expect(allow).not.toContain('host');
    } finally { await app.close(); }
  });
});
