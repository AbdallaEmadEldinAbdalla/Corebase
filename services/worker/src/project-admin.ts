import { Client } from 'pg';

/**
 * The control plane's admin connection into a project database.
 *
 * Direct, never pooled (credentials doc §4a): role DDL and password changes must
 * not be multiplexed onto a shared session, and PgBouncer in transaction mode
 * cannot carry them safely.
 */

/**
 * Roles the image's init scripts create (init/10-roles.sql). The saga verifies
 * them rather than creating them: if they are missing, the node is running an
 * image that predates the role model, and provisioning a project against it
 * would produce a database that quietly has no API-facing privilege levels.
 */
export const IMAGE_ROLES = [
  'anon', 'authenticated', 'service_role', 'authenticator', 'corebase_admin',
  // P2b: the pooler's identity. Present as a passwordless LOGIN role in the
  // image; the worker sets its password at provision time (D-074).
  'pgbouncer_auth',
  // P4a: the auth module's identity. Same pattern — the image creates it
  // passwordless and the control plane gives it one at provision. It is the only
  // role with table privileges in the `auth` schema, which is what keeps
  // `auth.users.encrypted_password` out of reach of every role a customer's API
  // traffic can arrive as, service_role included.
  'corebase_auth',
];

/** Roles the control plane owns and creates at provision time. */
export const DEVELOPER_ROLE = 'developer';

/** The pooler's own login role (D-074). Created by the image, password set here. */
export const POOLER_AUTH_ROLE = 'pgbouncer_auth';

/** The auth module's own login role (P4a, D-110). */
export const AUTH_ROLE = 'corebase_auth';

export interface AdminTarget {
  host: string;
  port: number;
  /** Candidate superuser passwords, tried in order (see connectAsSuperuser). */
  passwords: string[];
  database?: string;
  timeoutMs?: number;
}

export class AdminConnectError extends Error {}

/**
 * Connect as `postgres`, trying each candidate password in order.
 *
 * Two passwords are legitimately possible mid-provision: the derived bootstrap
 * password the container was created with, and the stored random one that
 * replaces it. Which one is live depends on where the last attempt crashed, and
 * the saga must not need to know.
 */
export async function connectAsSuperuser(target: AdminTarget): Promise<Client> {
  const errors: string[] = [];
  for (const password of target.passwords) {
    const client = new Client({
      host: target.host, port: target.port, user: 'postgres', password,
      database: target.database ?? 'postgres',
      connectionTimeoutMillis: target.timeoutMs ?? 5_000,
      // The project's own certificate story starts when the pooler does; inside
      // the private network this is a plaintext hop to a port only the control
      // plane can reach.
      ssl: false,
    });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      const msg = (err as Error).message;
      errors.push(msg);
      // Anything that is not an auth rejection means the database is not there
      // to be talked to; trying another password cannot help.
      if (!/password authentication failed|no password supplied/i.test(msg)) {
        throw new AdminConnectError(
          `cannot reach project database at ${target.host}:${target.port}: ${msg}`);
      }
    }
  }
  throw new AdminConnectError(
    `no candidate superuser password was accepted at ${target.host}:${target.port} ` +
    `(${target.passwords.length} tried: ${errors.join(' | ')})`);
}

/**
 * SQL literal for a generated secret.
 *
 * ALTER ROLE takes no bind parameters, so the password has to be interpolated.
 * Generated secrets are base64url and contain nothing that could escape a
 * literal — this asserts that rather than assuming it, so the day someone passes
 * a customer-supplied string through here it fails loudly instead of quietly
 * becoming an injection point.
 */
export function secretLiteral(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(
      'refusing to interpolate a value outside the generated-secret alphabet ' +
      '([A-Za-z0-9_-]) into SQL');
  }
  return `'${value}'`;
}

/** Quote an identifier we control; same reasoning as secretLiteral. */
export function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

export interface RoleReport {
  present: string[];
  missing: string[];
}

/** Which of the image-created roles actually exist. */
export async function auditImageRoles(client: Client): Promise<RoleReport> {
  const { rows } = await client.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [IMAGE_ROLES]);
  const present = rows.map((r) => r.rolname);
  return { present, missing: IMAGE_ROLES.filter((r) => !present.includes(r)) };
}

/**
 * Create the customer's role and the privileges that make a table it creates
 * visible to the API.
 *
 * The subtle part is the second ALTER DEFAULT PRIVILEGES. The image sets default
 * privileges for objects created by `postgres`, but the customer's tables are
 * created by `developer`, and default privileges are per-creating-role. Without
 * this, every table the customer makes is invisible to `authenticated` until
 * they hand-write grants — a bug that would look like "the API cannot see my
 * table" long after provisioning.
 */
export async function ensureDeveloperRole(client: Client): Promise<{ created: boolean }> {
  const dev = identifier(DEVELOPER_ROLE);
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT true AS ok FROM pg_roles WHERE rolname = $1`, [DEVELOPER_ROLE]);
  const created = rows.length === 0;

  if (created) {
    await client.query(
      `CREATE ROLE ${dev} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ` +
      `NOREPLICATION NOBYPASSRLS`);
  }

  // CREATE on the application schema is all the customer needs to make tables,
  // policies and functions; the schema itself stays owned by the database owner
  // so a customer cannot drop the schema the API depends on.
  await client.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${dev}`);

  // The image revokes information_schema from PUBLIC so anonymous clients cannot
  // enumerate a project's shape. The customer's own role needs it back (D-189):
  // psql's \d, every ORM's introspection and every migration tool reads it, and
  // information_schema already filters itself to objects the caller has rights
  // on — so this grants visibility of their own database, nothing more.
  await client.query(`GRANT USAGE ON SCHEMA information_schema TO ${dev}`);

  // The `auth` helpers, without which **the documented policy cookbook cannot be
  // written at all** (P5d).
  //
  // Every pattern in the cookbook calls `auth.uid()`, and creating a policy that
  // references it requires USAGE on the schema to resolve the function. The image
  // grants that to `anon`, `authenticated` and `service_role` — the roles a
  // *request* runs as — and to nobody else, so the role a customer actually runs
  // migrations as could not write a single one of them. Found by running the
  // cookbook verbatim; the error is `permission denied for schema auth` on the
  // CREATE POLICY, which reads like a platform fault rather than a missing grant.
  //
  // USAGE on the schema is not read access to it: `auth.users` and the token
  // tables have no grant to this role and stay unreadable, which the isolation
  // suite's DB-3 asserts. The helpers themselves leak nothing — they return the
  // caller's own request claims, which in a psql session are simply null.
  await client.query(`GRANT USAGE ON SCHEMA auth TO ${dev}`);
  await client.query(
    `GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role() TO ${dev}`);

  // CREATE on the database, for schemas.
  //
  // The cookbook's SECURITY DEFINER membership helper lives in an `app` schema,
  // and `create schema app` failed with `permission denied for database postgres`
  // — so that pattern was unreachable too. A customer creating schemas is
  // ordinary: PostgREST exposes `public` only, so a new schema is invisible to
  // the API until someone configures it, and a SECURITY DEFINER function the
  // customer creates runs as the *customer*, which escalates nothing.
  await client.query(
    `GRANT CREATE ON DATABASE ${identifier(await currentDatabase(client))} TO ${dev}`);

  // API-facing roles see what developer creates (D-108's asymmetry preserved:
  // anon gets nothing by default).
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${dev} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${dev} IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role`);

  return { created };
}

/**
 * Hand the `storage` metadata tables to the customer's role.
 *
 * **Only a table's owner may create a policy on it**, and policies on
 * `storage.objects` *are* the file-permission system — the storage doc says so in
 * those words, and every documented pattern is SQL a customer runs. Left owned by
 * `postgres`, not one of them could be created: `CREATE POLICY` would fail with
 * "must be owner of table objects", which reads as a platform fault.
 *
 * This is the opposite call from the `auth` schema, and deliberately so. There the
 * tables hold password hashes and token digests and no customer role may even
 * read them; here the tables hold the customer's own file inventory and the
 * customer is expected to govern it. The asymmetry is the point rather than an
 * inconsistency.
 *
 * Ownership does not weaken the platform's position: the storage service connects
 * as `service_role`, which bypasses RLS by attribute (D-082), so nothing the
 * customer writes here can lock the service out of its own bookkeeping. And
 * `storage.usage` stays with `postgres` — a customer who owned it could edit
 * their way to unlimited quota.
 */
export async function ensureStorageOwnership(client: Client): Promise<void> {
  const dev = identifier(DEVELOPER_ROLE);
  // USAGE on the schema first, and this is P5d's lesson repeating itself within
  // one phase: the image grants schema USAGE to the roles a *request* runs as and
  // to nobody else, so the role a customer runs migrations as could not so much
  // as name `storage.objects` — owning the table is useless without the right to
  // reach the schema it lives in. It failed with `permission denied for schema
  // storage`, which is the same message and the same cause as the `auth` gap.
  //
  // USAGE, not CREATE: the schema stays owned by the platform so a customer
  // cannot drop the schema the storage service depends on.
  await client.query(`GRANT USAGE ON SCHEMA storage TO ${dev}`);
  for (const table of ['storage.buckets', 'storage.objects', 'storage.upload_intents']) {
    await client.query(`ALTER TABLE ${table} OWNER TO ${dev}`);
  }
  // The helper too, or `CREATE POLICY ... storage.prefix_owner(name)` resolves a
  // function the customer may execute but a policy they own cannot depend on
  // being able to — and more practically, a customer refining the helper for
  // their own path layout should not need us.
  await client.query(`ALTER FUNCTION storage.prefix_owner(text) OWNER TO ${dev}`);
  // `bucket_id` is SECURITY DEFINER, so its owner is who it runs as. Moving it to
  // the customer keeps it able to read `storage.buckets` — the customer owns that
  // table — while making sure a platform-owned function is not executing customer
  // SQL as `postgres`.
  await client.query(`ALTER FUNCTION storage.bucket_id(text) OWNER TO ${dev}`);
  await client.query(`ALTER FUNCTION storage.bucket_config(text) OWNER TO ${dev}`);
}

/** The connected database's name, for a GRANT that must name it explicitly. */
async function currentDatabase(client: Client): Promise<string> {
  const { rows } = await client.query<{ db: string }>('SELECT current_database() AS db');
  return rows[0]!.db;
}

/** Set a role's password. Idempotent by nature — the same value re-applied. */
export async function setRolePassword(
  client: Client, role: string, password: string,
): Promise<void> {
  await client.query(
    `ALTER ROLE ${identifier(role)} WITH LOGIN PASSWORD ${secretLiteral(password)}`);
}

/** Does this password work for `postgres` right now? */
export async function passwordWorks(target: AdminTarget, password: string): Promise<boolean> {
  try {
    const c = await connectAsSuperuser({ ...target, passwords: [password] });
    await c.end();
    return true;
  } catch {
    return false;
  }
}
