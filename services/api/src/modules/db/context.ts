import { Client } from 'pg';
import { SECRET_NAMES, type SecretStore } from '@steadhold/secrets';
import type { Pool } from 'pg';
import { ApiError } from '../../kernel/errors.ts';
import { ERROR_CODES } from '@steadhold/types';

/**
 * Where a project's database is, and how the console reaches it.
 *
 * The same shape as `project-auth/context.ts`, which resolves a project for the
 * data plane, and deliberately so — that module established that the control
 * plane may hold a direct connection to a project database and this is the
 * second consumer of the same idea. What differs is the identity: that one
 * connects as `steadhold_auth` to touch the auth tables, this one connects as
 * `steadhold_admin` to run whatever the developer typed.
 *
 * **Direct, never pooled.** PgBouncer runs in transaction mode (D-015), which
 * cannot carry `SET LOCAL ROLE`, `SET LOCAL statement_timeout` or a multi-
 * statement transaction across a request — and those are three of the six rails.
 * The pooler exists to multiplex a customer's application traffic; a console run
 * is one deliberate statement from one person and does not need it.
 */
export interface ConsoleContext {
  projectId: string;
  ref: string;
  organizationId: string;
  host: string;
  port: number;
  /** `steadhold_admin`'s password for this project. */
  password: string;
}

export interface ConsoleDeps {
  pool: Pool;
  secrets: SecretStore;
}

/**
 * Resolve a project by ref, or say why not.
 *
 * A paused or still-provisioning project is refused by name rather than by
 * timeout: there is no container listening, and "connection refused" after 5
 * seconds is a worse answer than "this project is paused" immediately.
 */
export async function consoleContext(
  deps: ConsoleDeps, ref: string,
): Promise<ConsoleContext> {
  const { rows } = await deps.pool.query<{
    id: string; organization_id: string; status: string;
    host: string | null; port: number | null;
  }>(
    `SELECT p.id, p.organization_id, p.status::text AS status,
            d.connection_host AS host, d.port
       FROM projects p
       LEFT JOIN project_databases d ON d.project_id = p.id
      WHERE p.ref = $1`, [ref]);

  const row = rows[0];
  if (!row) throw ApiError.notFound('Project');

  if (row.status !== 'ready') {
    throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
      row.status === 'paused'
        ? 'This project is paused. Resume it to run SQL against it.'
        : `This project is ${row.status}, so there is nothing to connect to yet.`);
  }
  if (!row.host || row.port === null) {
    // Ready without a placement should be impossible; saying so beats a crash in
    // the connection call two lines later.
    throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
      'This project has no database placement recorded.');
  }

  const password = await deps.secrets.get(row.id, SECRET_NAMES.adminRole);
  if (!password) {
    // A project provisioned before P7l has no console credential. It is a real
    // state and it deserves a real sentence rather than an auth failure that
    // reads as a platform bug.
    throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
      'This project was created before the SQL console existed and has no console '
      + 'credential yet. Pausing and resuming it will provision one.');
  }

  return {
    projectId: row.id, ref, organizationId: row.organization_id,
    host: row.host, port: row.port, password,
  };
}

/**
 * One connection, one run, closed on every path.
 *
 * A per-run connection rather than a pool, and the reason is rail 5: each run is
 * its own transaction and transactions must not be able to outlive the request
 * that opened them. A pooled connection carrying an uncommitted transaction is
 * an idle-in-transaction leak waiting for the next abandoned editor tab, and
 * D-134 claims that cannot happen "by construction". This is that construction.
 */
export async function withConsoleDb<T>(
  ctx: ConsoleContext, fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: ctx.host, port: ctx.port, user: 'steadhold_admin', database: 'postgres',
    password: ctx.password,
    connectionTimeoutMillis: 5_000,
    // Inside the private network this is a plaintext hop to a port only the
    // control plane can reach — the same call `project-admin.ts` documents.
    ssl: false,
    // No client-side `statement_timeout` here. Rail 3 sets it per run with `SET
    // LOCAL` inside the transaction, because the value is the caller's (bounded)
    // choice and a connection-level setting would silently win over it.
  } as never);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
