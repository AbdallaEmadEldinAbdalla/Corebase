import { Pool } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore, SECRET_NAMES } from '@corebase/secrets';
import { createDocker, type Docker } from '@corebase/worker/docker.ts';
import { buildSagas } from '@corebase/worker/jobs/sagas.ts';
import { registerNode } from '@corebase/worker/placement.ts';
import {
  IMAGE, POOLER_IMAGE, POSTGREST_IMAGE, LABEL_MANAGED,
  containerName, poolerName, postgrestName,
} from '@corebase/worker/container-spec.ts';
import type { JobRecord } from '@corebase/worker/jobs/repo.ts';
import type { SagaStep, SagaContext } from '@corebase/worker/jobs/runner.ts';
import { DEVELOPER_ROLE } from '@corebase/worker/project-admin.ts';

/**
 * The tenant-isolation harness (P5e) — the fixtures behind proposal §74.
 *
 * ## The rule that shapes this file
 *
 * The suite talks to its fixtures **only through the surfaces a real attacker
 * has**: HTTP endpoints, the pooler port, and a psql session opened with the
 * fixture's own advertised credentials. It holds no privileged backdoor.
 *
 * That rule is about *assertions*, not setup. Seeding a canary table needs the
 * superuser and minting a forged token needs the project's private key; both run
 * here, in the fixture phase, and never inside a test. The distinction matters
 * because a test that *observes* through privilege proves nothing about what an
 * attacker can see — the isolation doc's own words: confirm a blocked connection
 * by the connection failing, not by reading a host-side firewall log.
 *
 * ## Two projects, one node
 *
 * A and B are provisioned onto the same node on purpose (D-084): co-tenancy is
 * the interesting case, because two projects on separate machines are isolated by
 * the machines. Staging has one data node, so adjacency is automatic here and the
 * cross-node variant the doc also wants cannot be run — recorded as a gap rather
 * than quietly skipped.
 */

const DB = process.env['CB_CONTROL_DATABASE_URL']
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const CERT_DIR = process.env['CB_DOCKER_CERT_DIR']
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env['CB_DOCKER_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['CB_DOCKER_PORT'] ?? 2376);
const BOOTSTRAP = 'isolation-bootstrap-secret-0123456789';

export const PROJECT_DOMAIN = 'corebase.test';

/** Everything a test needs about one fixture, plus what only the seed may use. */
export interface Fixture {
  id: string;
  ref: string;
  /** Published on the node: the direct Postgres port, the pooler, the data API. */
  port: number;
  poolerPort: number;
  postgrestPort: number;
  /** The two published project keys — anon is genuinely public (D-029). */
  anonKey: string;
  serviceKey: string;
  /** Container names, for the network and database cases that exec inside them. */
  pg: string;
  pooler: string;
  rest: string;
  /** The database role and password a customer is handed. */
  dbUser: string;
  dbPassword: string;
  /**
   * Seed-only. The project's signing key, used to *mint* forged tokens — an
   * attacker never has this, which is exactly why a test that mints one and is
   * still refused proves something.
   */
  signing: { privateKeyPem: string; kid: string };
  /** The canary's owner (`user-A` in the doc's table) and a second identity. */
  ownerUid: string;
  otherUid: string;
}

export interface Harness {
  pool: Pool;
  docker: Docker;
  secrets: ReturnType<typeof createSecretStore>;
  a: Fixture;
  b: Fixture;
}

let kekDir: string | undefined;

/** Fails loudly rather than skipping: this suite blocks releases (D-085). */
export async function requirePreconditions(): Promise<{ pool: Pool; docker: Docker }> {
  const pool = new Pool({ connectionString: DB, max: 8, connectionTimeoutMillis: 2000 });
  await pool.query('select 1').catch((err: Error) => {
    throw new Error(`the staging control database is unreachable (${err.message}) — `
      + 'run ./scripts/staging.sh up. The isolation suite must never skip: a suite '
      + 'that skips is a release gate that is open (D-085).');
  });
  const docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 120_000 });
  await docker.ping().catch((err: Error) => {
    throw new Error(`the data node is unreachable (${err.message}) — ./scripts/staging.sh up.`);
  });
  for (const image of [IMAGE, POOLER_IMAGE, POSTGREST_IMAGE]) {
    if (!(await docker.imageExists(image))) {
      throw new Error(`${image} is not on the data node — ./scripts/staging.sh seed-images`);
    }
  }
  return { pool, docker };
}

export async function setUp(): Promise<Harness> {
  const { pool, docker } = await requirePreconditions();
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-iso-'));
  writeFileSync(join(kekDir, 'kek_2026_09.key'), randomBytes(32));
  const secrets = createSecretStore(pool, createEnvelope({ kekDir }));

  // A clean node. Two projects are provisioned here and left standing for the
  // whole suite, so anything already running would compete for the same ports.
  await wipeNode(docker);
  await pool.query(
    'truncate provisioning_jobs, project_databases, project_repos, projects, nodes cascade');

  const { rows } = await pool.query<{ id: string }>(
    `insert into organizations (name, slug) values ('Isolation','isolation-tests')
     on conflict (slug) do update set updated_at = now() returning id`);
  const orgId = rows[0]!.id;

  // One node, so A and B are necessarily co-tenants (D-084).
  await registerNode(pool, {
    hostname: 'data-node-local', ramTotalMb: 16384, diskTotalGb: 400, address: '127.0.0.1' });

  const a = await provision(pool, docker, secrets, orgId, 'a');
  const b = await provision(pool, docker, secrets, orgId, 'b');
  return { pool, docker, secrets, a, b };
}

export async function tearDown(h: Harness | undefined): Promise<void> {
  if (h) await wipeNode(h.docker).catch(() => {});
  await h?.pool.end().catch(() => {});
  h?.docker.close?.();
  if (kekDir) rmSync(kekDir, { recursive: true, force: true });
}

async function wipeNode(docker: Docker): Promise<void> {
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

let seq = 0;
const mkRef = () => 'iso' + String(Date.now() % 1000000) + String(++seq).padStart(11, 'x');

/** A genuinely provisioned project: three containers, roles, keys, JWKS. */
async function provision(
  pool: Pool, docker: Docker, secrets: ReturnType<typeof createSecretStore>,
  orgId: string, label: string,
): Promise<Fixture> {
  const ref = mkRef();
  const { rows } = await pool.query<{ id: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1, $2, $3, 'free', 'creating') returning id`,
    [orgId, ref, `isolation-${label}`]);
  const id = rows[0]!.id;

  // The real saga, every step, in order — not a shortcut that assembles the same
  // containers by hand. Provisioning *is* part of what this suite proves is
  // isolation-safe, so a fixture built any other way would be testing something
  // the platform does not do.
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: BOOTSTRAP,
    healthTimeoutMs: 180_000, projectDomain: PROJECT_DOMAIN,
  });
  const job = { id: `iso-${label}`, project_id: id } as unknown as JobRecord;
  for (const step of sagas['provision_project'] as SagaStep<SagaContext>[]) {
    await step.run({ job, log: () => {} });
  }

  const { rows: place } = await pool.query<{
    port: number; pooler_port: number; postgrest_port: number;
  }>(`select port, pooler_port, postgrest_port from project_databases where project_id = $1`, [id]);
  const p = place[0]!;

  const [anonKey, serviceKey, priv, kid, dbPassword] = await Promise.all([
    secrets.get(id, SECRET_NAMES.anonKey),
    secrets.get(id, SECRET_NAMES.serviceRoleKey),
    secrets.get(id, SECRET_NAMES.jwtPrivateKey),
    secrets.get(id, SECRET_NAMES.jwtKid),
    secrets.get(id, SECRET_NAMES.developer),
  ]);

  const fixture: Fixture = {
    id, ref,
    port: p.port, poolerPort: p.pooler_port, postgrestPort: p.postgrest_port,
    anonKey: anonKey!, serviceKey: serviceKey!,
    pg: containerName(ref), pooler: poolerName(ref), rest: postgrestName(ref),
    dbUser: DEVELOPER_ROLE, dbPassword: dbPassword!,
    signing: { privateKeyPem: priv!, kid: kid! },
    ownerUid: '11111111-1111-4111-8111-111111111111',
    otherUid: '22222222-2222-4222-8222-222222222222',
  };
  await seedCanary(docker, fixture);
  return fixture;
}

/**
 * The RLS regression canary, exactly as the isolation doc specifies it: known
 * rows, known policies, and a visibility table per role that any policy
 * regression breaks — a dropped FORCE, a helper returning null, a botched grant.
 *
 * Seeded over psql as the superuser, which is setup and not assertion. The rows
 * are then only ever read back through the data API, as an attacker would.
 */
async function seedCanary(docker: Docker, f: Fixture): Promise<void> {
  const sql = `
    create table public.canary (
      id int primary key, owner uuid, secret text, published bool);
    alter table public.canary enable row level security;
    alter table public.canary force  row level security;
    insert into public.canary values
      (1, '${f.ownerUid}', '${f.ref}-private', false),
      (2, '${f.ownerUid}', '${f.ref}-public',  true),
      (3, '${f.otherUid}', '${f.ref}-other',   true);
    create policy p_read_published on public.canary
      for select to anon, authenticated using (published);
    create policy p_read_own on public.canary
      for select to authenticated using (owner = (select auth.uid()));
    -- The write canary. WITH CHECK is the half that stops a user inserting a row
    -- owned by somebody else, which a USING-only policy would happily allow.
    create policy p_insert_own on public.canary
      for insert to authenticated with check (owner = (select auth.uid()));
    create policy p_update_own on public.canary
      for update to authenticated
      using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
    grant select, insert, update on public.canary to anon, authenticated;
    notify pgrst, 'reload schema';
  `;
  const r = await docker.execCapture(f.pg, ['psql', '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  if (r.exitCode !== 0) {
    throw new Error(`seeding the canary in ${f.ref} failed: ${r.stdout}\n${r.stderr}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The attacker's surfaces.
//
// Everything below is what a test is allowed to touch. Note what is absent: no
// helper takes a superuser connection, and none reads a container's logs or the
// host's firewall state to decide whether an attack was blocked. A test learns
// that something is denied the way an attacker would — by being denied.
// ─────────────────────────────────────────────────────────────────────────────

import { buildApp } from '@corebase/api';
import { createRoutingTable } from '@corebase/api/modules/gateway/routing.ts';
import { createMemoryRateLimiter } from '@corebase/api/kernel/rate-limit.ts';
import { sign as signJwt } from '@corebase/jwt';
import type { FastifyInstance } from 'fastify';

/**
 * The real gateway, over the real routing table, in front of the real PostgREST
 * containers — not a stub. A stubbed gateway would move the boundary under test
 * into the stub.
 *
 * `upstreamFor` is the one substitution: the routing table records the node
 * address, and on staging the containers publish onto the host rather than being
 * reachable at a node-internal address. It redirects *where* the proxy connects,
 * never *whether* the request was admitted, which is what these tests assert.
 */
export async function gateway(h: Harness): Promise<FastifyInstance> {
  const byPort = new Map([[h.a.ref, h.a.postgrestPort], [h.b.ref, h.b.postgrestPort]]);
  const routes = createRoutingTable({
    pool: h.pool,
    activeKey: async (projectId) => {
      const [pem, kid] = await Promise.all([
        h.secrets.get(projectId, SECRET_NAMES.jwtPublicKey),
        h.secrets.get(projectId, SECRET_NAMES.jwtKid),
      ]);
      return pem && kid ? { pem, kid } : undefined;
    },
    onError: (err) => { throw err; },
  });
  await routes.refresh();
  return buildApp({
    gateway: {
      routes, projectDomain: PROJECT_DOMAIN,
      // Deliberately generous. Rate limiting is P5c's concern and a limit that
      // tripped mid-matrix would turn an isolation failure into a 429 and hide it.
      ipLimiter: createMemoryRateLimiter({ limit: 100_000, windowSeconds: 60 }),
      keyLimiter: createMemoryRateLimiter({ limit: 100_000, windowSeconds: 60 }),
      projectLimiter: createMemoryRateLimiter({ limit: 100_000, windowSeconds: 60 }),
      upstreamFor: (entry) => {
        const port = byPort.get(entry.ref);
        return port ? `http://127.0.0.1:${port}` : undefined;
      },
    },
  });
}

/** The Host a project is served on. Identity comes from here, never from a header. */
export const hostOf = (f: Fixture) => `${f.ref}.${PROJECT_DOMAIN}`;

export interface MintOptions {
  role?: string;
  sub?: string;
  ref?: string;
  expSeconds?: number;
  kid?: string;
  issuer?: string;
}

/**
 * Mint a token with a project's *own* signing key.
 *
 * This is the harness's sharpest tool and the reason several matrix rows mean
 * anything. An attacker cannot do this — the private key never leaves the control
 * plane — so a forged token that is still refused proves the refusal does not
 * depend on the attacker's inability to sign. Every use is an attack the platform
 * would face if a key leaked.
 */
export function mint(signer: Fixture, o: MintOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const ref = o.ref ?? signer.ref;
  return signJwt({
    iss: o.issuer ?? `https://${ref}.${PROJECT_DOMAIN}`,
    ref,
    // Cast, because the attack rows deliberately mint roles the platform never
    // issues — proving the verifier rejects them rather than trusting the type.
    role: (o.role ?? 'authenticated') as 'anon' | 'authenticated' | 'service_role',
    ...(o.sub ? { sub: o.sub } : {}),
    iat: now,
    exp: now + (o.expSeconds ?? 3600),
  }, { privateKeyPem: signer.signing.privateKeyPem, kid: o.kid ?? signer.signing.kid });
}
