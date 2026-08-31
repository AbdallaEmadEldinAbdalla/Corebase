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
];

/** Roles the control plane owns and creates at provision time. */
export const DEVELOPER_ROLE = 'developer';

/** The pooler's own login role (D-074). Created by the image, password set here. */
export const POOLER_AUTH_ROLE = 'pgbouncer_auth';

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
