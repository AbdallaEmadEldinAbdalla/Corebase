import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, Client } from 'pg';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createEnvelope, generateSecret } from '@corebase/crypto';
import { createDocker, type Docker } from './docker.ts';
import { createSecretStore } from '@corebase/secrets';
import { SECRET_NAMES } from '@corebase/secrets';
import { buildSagas } from './jobs/sagas.ts';
import { registerNode } from './placement.ts';
import { containerName, bootstrapPassword, IMAGE, LABEL_MANAGED } from './container-spec.ts';
import { connectAsSuperuser, secretLiteral, identifier, AdminConnectError } from './project-admin.ts';
import type { JobRecord } from './jobs/repo.ts';
import type { SagaStep, SagaContext } from './jobs/runner.ts';

/**
 * T5e integration: credentials and readiness against the real data node.
 *
 * The properties worth testing here are not "does it write a row" but: is the
 * bootstrap password actually gone afterwards, does a stored credential survive
 * a crash at every point in the sequence, and does mark_ready refuse to lie.
 */
const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const SECRET = 'test-bootstrap-secret-0123456789';

let pool: Pool; let docker: Docker; let orgId: string; let kekDir: string;
let secrets: ReturnType<typeof createSecretStore>;
let envelope: ReturnType<typeof createEnvelope>;
let up = false; let reason = '';

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 6, connectionTimeoutMillis: 1500 });
  kekDir = mkdtempSync(join(tmpdir(), 'cb-kek-t5e-'));
  writeFileSync(join(kekDir, 'kek_2026_08.key'), randomBytes(32));
  try {
    await pool.query('select 1');
    await pool.query('select address from nodes limit 0');   // T5e migration applied?
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    envelope = createEnvelope({ kekDir });
    secrets = createSecretStore(pool, envelope);
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('C','c-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('T5e integration setup FAILED:', reason);
    up = false;
  }
}, 40_000);

const createdVolumes = new Set<string>();

afterAll(async () => {
  if (up) {
    for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
      await docker.removeContainer(c.Id).catch(() => {});
    }
    for (const v of createdVolumes) await docker.removeVolume(v).catch(() => {});
  }
  await pool?.end();
  rmSync(kekDir, { recursive: true, force: true });
}, 90_000);

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate provisioning_jobs, project_secrets, project_databases, projects, nodes cascade');
  for (const c of await docker.listContainers(`${LABEL_MANAGED}=true`)) {
    await docker.removeContainer(c.Id).catch(() => {});
  }
  for (const v of createdVolumes) await docker.removeVolume(v).catch(() => {});
  createdVolumes.clear();
}, 90_000);

const t = (n: string, fn: () => Promise<void>, ms = 120_000) =>
  it(n, async () => {
    if (!up) throw new Error(
      `staging not ready (${reason}) — run ./scripts/staging.sh up, ./scripts/migrate-staging.sh ` +
      'and ./scripts/staging.sh seed-images. T5e done-signal; must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
const mkRef = () => 'c' + String(Date.now() % 100000) + String(++seq).padStart(14, 'x');

async function mkProject(plan = 'free') {
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan)
     values ($1,$2,$3,$4::project_plan) returning id, ref::text as ref`,
    [orgId, mkRef(), 'proj-' + seq, plan]);
  return rows[0]!;
}

const ALL_STEPS = [
  'allocate_node', 'create_volume', 'start_container', 'wait_healthy',
  'create_base_roles', 'store_credentials', 'generate_api_keys', 'write_connection', 'mark_ready',
];

async function runSteps(projectId: string, names: string[], extra: Record<string, unknown> = {}) {
  const sagas = buildSagas({
    pool, docker, secrets, bootstrapSecret: SECRET, healthTimeoutMs: 60_000,
    projectDomain: 'corebase.test', ...extra,
  });
  const steps = sagas['provision_project']!;
  const logs: string[] = [];
  const job = { id: 'j', project_id: projectId } as unknown as JobRecord;
  for (const name of names) {
    const step = steps.find((s: SagaStep<SagaContext>) => s.name === name);
    if (!step) throw new Error(`no step named ${name}`);
    await step.run({ job, log: (m, e) => logs.push(m + (e ? ' ' + JSON.stringify(e) : '')) });
  }
  return logs;
}

/** Provision far enough that a database is up, and remember its volume. */
async function provision(upTo = ALL_STEPS) {
  await registerNode(pool, {
    hostname: 'data-1', ramTotalMb: 8192, diskTotalGb: 200, address: HOST,
  });
  const p = await mkProject();
  const logs = await runSteps(p.id, upTo);
  const row = await placement(p.id);
  if (row) createdVolumes.add(row.volume_name);
  return { project: p, logs };
}

const placement = async (projectId: string) => (await pool.query<{
  volume_name: string; container_id: string | null; port: number; connection_host: string | null;
  status: string;
}>(`select volume_name, container_id, port, connection_host, status
      from project_databases where project_id = $1`, [projectId])).rows[0];

const projectStatus = async (projectId: string) => (await pool.query<{ status: string }>(
  `select status::text as status from projects where id = $1`, [projectId])).rows[0]!.status;

/** Connect to a project database as an arbitrary role. */
async function connectAs(port: number, user: string, password: string, database = 'postgres') {
  const c = new Client({ host: HOST, port, user, password, database, connectionTimeoutMillis: 5_000 });
  await c.connect();
  return c;
}

describe('T5e — the role model', () => {
  t('verifies the image roles and creates the developer role', async () => {
    const { project, logs } = await provision(ALL_STEPS.slice(0, 5));
    const row = (await placement(project.id))!;
    const su = await connectAsSuperuser({
      host: HOST, port: row.port, passwords: [bootstrapPassword(SECRET, project.id)],
    });
    try {
      const { rows } = await su.query<{ rolname: string; rolcanlogin: boolean; rolbypassrls: boolean }>(
        `select rolname, rolcanlogin, rolbypassrls from pg_roles
          where rolname in ('anon','authenticated','service_role','authenticator','developer')
          order by rolname`);
      const byName = new Map(rows.map((r) => [r.rolname, r]));
      expect([...byName.keys()].sort())
        .toEqual(['anon', 'authenticated', 'authenticator', 'developer', 'service_role']);
      // The NOLOGIN trio is the point of D-029: an API key can never become a
      // database login.
      expect(byName.get('anon')!.rolcanlogin).toBe(false);
      expect(byName.get('authenticated')!.rolcanlogin).toBe(false);
      expect(byName.get('service_role')!.rolcanlogin).toBe(false);
      expect(byName.get('service_role')!.rolbypassrls).toBe(true);
      expect(byName.get('developer')!.rolcanlogin).toBe(true);
      expect(byName.get('developer')!.rolbypassrls).toBe(false);
      expect(logs.join('\n')).toContain('created the developer role');
    } finally { await su.end(); }
  });

  t('re-running create_base_roles is a no-op', async () => {
    const { project } = await provision(ALL_STEPS.slice(0, 5));
    const logs = await runSteps(project.id, ['create_base_roles']);
    expect(logs.join('\n')).toContain('developer role already present');
  });

  t('a table the developer creates is readable by authenticated, not by anon', async () => {
    // The default-privileges trap: ALTER DEFAULT PRIVILEGES is per creating role,
    // and the customer's tables are created by `developer`, not `postgres`.
    const { project } = await provision();
    const row = (await placement(project.id))!;
    const devPw = (await secrets.get(project.id, SECRET_NAMES.developer))!;

    const dev = await connectAs(row.port, 'developer', devPw);
    try {
      await dev.query('create table notes (id serial primary key, body text)');
      const { rows } = await dev.query<{ grantee: string; privilege_type: string }>(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_name = 'notes' order by grantee, privilege_type`);
      const granted = new Set(rows.map((r) => r.grantee));
      expect(granted.has('authenticated')).toBe(true);
      expect(granted.has('service_role')).toBe(true);
      // anon deliberately gets nothing: a new table is 403, never a public dump
      // (D-108).
      expect(granted.has('anon')).toBe(false);
    } finally { await dev.end(); }
  });

  t('the developer can introspect their own database (D-189)', async () => {
    // The image revokes information_schema from PUBLIC; without granting it back
    // to the customer's role, psql's \d and every ORM's introspection fail on a
    // brand-new project.
    const { project } = await provision();
    const row = (await placement(project.id))!;
    const devPw = (await secrets.get(project.id, SECRET_NAMES.developer))!;
    const dev = await connectAs(row.port, 'developer', devPw);
    try {
      await dev.query('create table widgets (id serial primary key)');
      const { rows } = await dev.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public'`);
      expect(rows.map((r) => r.table_name)).toContain('widgets');
    } finally { await dev.end(); }
  });

  t('a new table is RLS-enabled but still usable by its owner (D-191)', async () => {
    // The shape of the fix: ENABLE without FORCE. The API-facing roles are
    // denied by default; the customer's own connection is not broken.
    const { project } = await provision();
    const row = (await placement(project.id))!;
    const devPw = (await secrets.get(project.id, SECRET_NAMES.developer))!;
    const authPw = (await secrets.get(project.id, SECRET_NAMES.authenticator))!;

    const dev = await connectAs(row.port, 'developer', devPw);
    try {
      await dev.query('create table hello (id serial primary key, body text)');
      const { rows } = await dev.query<{ enabled: boolean; forced: boolean }>(
        `select relrowsecurity as enabled, relforcerowsecurity as forced
           from pg_class where relname = 'hello'`);
      expect(rows[0]).toEqual({ enabled: true, forced: false });
      // The owner can use their own table immediately — with FORCE this insert
      // failed with "new row violates row-level security policy", breaking every
      // ORM and seed script on a brand-new project.
      await dev.query(`insert into hello (body) values ('owner row')`);
      expect((await dev.query('select * from hello')).rowCount).toBe(1);
    } finally { await dev.end(); }

    const api = await connectAs(row.port, 'authenticator', authPw);
    try {
      await api.query('set role authenticated');
      // Granted, but no policy exists: zero rows, no writes.
      expect((await api.query('select * from hello')).rowCount).toBe(0);
      await expect(api.query(`insert into hello (body) values ('x')`)).rejects.toThrow();
      await api.query('reset role');
      await api.query('set role anon');
      // anon has no grant at all (D-108): 403, not an empty result.
      await expect(api.query('select * from hello')).rejects.toThrow(/permission denied/);
    } finally { await api.end(); }
  });

  t('the developer role cannot escalate to superuser or reach the filesystem', async () => {
    const { project } = await provision();
    const row = (await placement(project.id))!;
    const devPw = (await secrets.get(project.id, SECRET_NAMES.developer))!;
    const dev = await connectAs(row.port, 'developer', devPw);
    try {
      const { rows } = await dev.query<{ super: boolean; createrole: boolean; repl: boolean }>(
        `select rolsuper as super, rolcreaterole as createrole, rolreplication as repl
           from pg_roles where rolname = current_user`);
      expect(rows[0]).toEqual({ super: false, createrole: false, repl: false });
      await expect(dev.query(`copy (select 1) to program 'touch /tmp/pwned'`)).rejects.toThrow();
      await expect(dev.query(`alter role developer superuser`)).rejects.toThrow();
      await expect(dev.query(`create extension dblink`)).rejects.toThrow();
    } finally { await dev.end(); }
  });
});

describe('T5e — credentials', () => {
  t('replaces the derived bootstrap password with a stored random one', async () => {
    const { project } = await provision();
    const row = (await placement(project.id))!;

    const stored = await secrets.get(project.id, SECRET_NAMES.postgres);
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored).not.toBe(bootstrapPassword(SECRET, project.id));

    // The fleet-wide derivable password must no longer open the door: until this
    // step runs, one leaked CB_BOOTSTRAP_SECRET is every project's superuser.
    await expect(connectAs(row.port, 'postgres', bootstrapPassword(SECRET, project.id)))
      .rejects.toThrow(/password authentication failed/);
    const su = await connectAs(row.port, 'postgres', stored!);
    await su.end();
  });

  t('stores ciphertext only — a control-plane dump decrypts to nothing', async () => {
    const { project } = await provision();
    const plain = (await secrets.get(project.id, SECRET_NAMES.developer))!;
    const { rows } = await pool.query<{ ciphertext: Buffer; dek_wrapped: Buffer; kek_id: string }>(
      `select ciphertext, dek_wrapped, kek_id from project_secrets
        where project_id = $1 and name = $2`, [project.id, SECRET_NAMES.developer]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ciphertext.toString('latin1')).not.toContain(plain);
    expect(rows[0]!.kek_id).toBe('kek_2026_08');

    // A different KEK — the attacker who has the database but not the key file.
    const otherDir = mkdtempSync(join(tmpdir(), 'cb-kek-thief-'));
    try {
      writeFileSync(join(otherDir, 'kek_2026_08.key'), randomBytes(32));
      const thief = createSecretStore(pool, createEnvelope({ kekDir: otherDir }));
      await expect(thief.get(project.id, SECRET_NAMES.developer)).rejects.toThrow();
    } finally { rmSync(otherDir, { recursive: true, force: true }); }
  });

  t('stores every secret a ready project needs, one active version each', async () => {
    const { project } = await provision();
    const { rows } = await pool.query<{ name: string; state: string; version: number }>(
      `select name, state, version from project_secrets where project_id = $1 order by name`,
      [project.id]);
    // Three role passwords (T5e) plus the signing keypair and the two minted API
    // keys (P1e). The keys are stored under envelope encryption rather than
    // re-derived, per D-214.
    expect(rows.map((r) => r.name)).toEqual([
      'ANON_KEY', 'AUTHENTICATOR_PASSWORD', 'DEVELOPER_PASSWORD',
      'JWT_KID', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY',
      'POSTGRES_PASSWORD', 'SERVICE_ROLE_KEY',
    ]);
    expect(rows.every((r) => r.state === 'active' && r.version === 1)).toBe(true);
  });

  t('re-running store_credentials reuses the stored values, never regenerating', async () => {
    const { project } = await provision();
    const before = await Promise.all(
      Object.values(SECRET_NAMES).map((n) => secrets.get(project.id, n)));

    const logs = await runSteps(project.id, ['store_credentials']);
    const after = await Promise.all(
      Object.values(SECRET_NAMES).map((n) => secrets.get(project.id, n)));

    expect(after).toEqual(before);
    expect(logs.join('\n')).toContain('"generated":[]');
    // And the reused password still works — the step re-applies rather than
    // assuming the database is in the state it left it.
    const row = (await placement(project.id))!;
    const su = await connectAs(row.port, 'postgres', before[0]!);
    await su.end();
  });

  t('survives a crash between storing a credential and applying it', async () => {
    // The window that store-then-apply exists to make safe: the row is written,
    // the ALTER never ran. The next attempt must apply the stored value, not
    // generate a new one.
    const { project } = await provision(ALL_STEPS.slice(0, 5));
    const row = (await placement(project.id))!;
    const preStored = generateSecret();
    const sealed = envelope.encrypt(preStored, {
      projectId: project.id, name: SECRET_NAMES.postgres, version: 1,
    });
    await pool.query(
      `insert into project_secrets (project_id, name, version, ciphertext, dek_wrapped, kek_id)
       values ($1,$2,1,$3,$4,$5)`,
      [project.id, SECRET_NAMES.postgres, sealed.ciphertext, sealed.dekWrapped, sealed.kekId]);

    // At this moment the database still has the bootstrap password.
    await runSteps(project.id, ['store_credentials']);

    expect(await secrets.get(project.id, SECRET_NAMES.postgres)).toBe(preStored);
    const su = await connectAs(row.port, 'postgres', preStored);
    await su.end();
  });

  t('survives a crash after applying a credential but before checkpointing', async () => {
    // The mirror image: the ALTER ran, the checkpoint did not, so the step runs
    // again against a database whose password is already the stored one.
    const { project } = await provision();
    const stored = (await secrets.get(project.id, SECRET_NAMES.postgres))!;
    await runSteps(project.id, ['store_credentials']);   // replay
    const row = (await placement(project.id))!;
    const su = await connectAs(row.port, 'postgres', stored);
    await su.end();
  });

  t('refuses to run without a KEK-backed secret store', async () => {
    const { project } = await provision(ALL_STEPS.slice(0, 5));
    await expect(runSteps(project.id, ['store_credentials'], { secrets: undefined }))
      .rejects.toThrow(/needs its KEK/);
  });

  t('the authenticator role can log in and SET ROLE, but owns nothing', async () => {
    const { project } = await provision();
    const row = (await placement(project.id))!;
    const authPw = (await secrets.get(project.id, SECRET_NAMES.authenticator))!;
    const c = await connectAs(row.port, 'authenticator', authPw);
    try {
      // NOINHERIT: it holds the trio but has none of their privileges until it
      // explicitly assumes one.
      await expect(c.query('create table nope (id int)')).rejects.toThrow();
      await c.query('set role authenticated');
      const { rows } = await c.query<{ role: string }>(`select current_user as role`);
      expect(rows[0]!.role).toBe('authenticated');
    } finally { await c.end(); }
  });
});

describe('T5e — connection details and readiness', () => {
  t('writes the customer-facing host and marks the project ready', async () => {
    const { project } = await provision();
    const row = (await placement(project.id))!;
    expect(row.connection_host).toBe(`${project.ref}.corebase.test`);
    expect(await projectStatus(project.id)).toBe('ready');
  });

  t('write_connection never overwrites a host a project was already handed', async () => {
    const { project } = await provision();
    await pool.query(
      `update project_databases set connection_host = 'legacy.example.test' where project_id = $1`,
      [project.id]);
    await runSteps(project.id, ['write_connection']);
    expect((await placement(project.id))!.connection_host).toBe('legacy.example.test');
  });

  t('mark_ready refuses when credentials are missing', async () => {
    const { project } = await provision(
      [...ALL_STEPS.slice(0, 5), 'write_connection']);          // no store_credentials
    await expect(runSteps(project.id, ['mark_ready'])).rejects.toThrow(/only 0 credentials/);
    expect(await projectStatus(project.id)).not.toBe('ready');
  });

  t('mark_ready refuses when the database is not running', async () => {
    const { project } = await provision(ALL_STEPS.slice(0, 7));  // everything but mark_ready
    await pool.query(
      `update project_databases set status = 'failed' where project_id = $1`, [project.id]);
    await expect(runSteps(project.id, ['mark_ready'])).rejects.toThrow(/database status is failed/);
    expect(await projectStatus(project.id)).not.toBe('ready');
  });

  t('mark_ready refuses when no connection host was written', async () => {
    const { project } = await provision(ALL_STEPS.slice(0, 6));  // no write_connection
    await expect(runSteps(project.id, ['mark_ready'])).rejects.toThrow(/no connection host/);
  });

  t('re-running mark_ready leaves a ready project ready', async () => {
    const { project } = await provision();
    await runSteps(project.id, ['mark_ready']);
    expect(await projectStatus(project.id)).toBe('ready');
  });

  t('the full saga is idempotent end to end', async () => {
    const { project } = await provision();
    const before = await pool.query(
      `select (select count(*) from project_secrets where project_id=$1) as secrets,
              (select count(*) from project_databases where project_id=$1) as dbs`, [project.id]);
    await runSteps(project.id, ALL_STEPS);
    const after = await pool.query(
      `select (select count(*) from project_secrets where project_id=$1) as secrets,
              (select count(*) from project_databases where project_id=$1) as dbs`, [project.id]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await projectStatus(project.id)).toBe('ready');
    const all = await docker.listContainers(`${LABEL_MANAGED}=true`);
    expect(all.filter((c) => c.Names.includes('/' + containerName(project.ref)))).toHaveLength(1);
  });
});

describe('T5e — admin connection guards', () => {
  t('refuses to reach a node with no recorded address', async () => {
    await registerNode(pool, { hostname: 'addressless', ramTotalMb: 8192, diskTotalGb: 200 });
    const p = await mkProject();
    await runSteps(p.id, ['allocate_node']);
    createdVolumes.add((await placement(p.id))!.volume_name);
    await expect(runSteps(p.id, ['create_base_roles'])).rejects.toThrow(/no address recorded/);
  });

  t('distinguishes a wrong password from an unreachable database', async () => {
    // A wrong password is worth retrying with another candidate; a refused
    // connection is not, and reporting one as the other sends the operator
    // looking in the wrong place.
    await expect(connectAsSuperuser({ host: HOST, port: 1, passwords: ['x'], timeoutMs: 2000 }))
      .rejects.toThrow(AdminConnectError);
    const { project } = await provision();
    const row = (await placement(project.id))!;
    await expect(connectAsSuperuser({ host: HOST, port: row.port, passwords: ['definitely-wrong'] }))
      .rejects.toThrow(/no candidate superuser password was accepted/);
  });

  t('refuses to interpolate anything outside the generated-secret alphabet', async () => {
    expect(() => secretLiteral("'; drop role postgres; --")).toThrow(/refusing to interpolate/);
    expect(() => secretLiteral('abc')).not.toThrow();
    expect(() => identifier('drop table"')).toThrow(/unsafe SQL identifier/);
  });
});
