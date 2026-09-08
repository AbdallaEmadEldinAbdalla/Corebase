import { Client } from 'pg';
import type { FastifyRequest } from 'fastify';
import { STORAGE_ERROR_CODES as E } from '@steadhold/types';
import { ApiError } from '../../kernel/errors.ts';
import type { ProjectContext } from '../project-auth/context.ts';
import { verifyBearer } from '../project-auth/bearer.ts';

/**
 * The storage module's authorization primitive (P6b, storage API §2).
 *
 * **The storage service holds no ACL engine.** For every operation it opens a
 * transaction against the project's database and evaluates access *as the
 * caller* — so the customer's policies on `storage.objects` are the file
 * permission system, and there is no second place where permissions could
 * disagree with them.
 *
 * That is why this file connects as `authenticator` rather than as the storage
 * module's own role. `authenticator` is NOINHERIT: it can do nothing as itself,
 * and its whole purpose is to drop into `anon`, `authenticated` or
 * `service_role`. A module connecting as a role of its own would have to
 * *reimplement* the customer's policies to decide anything, which is the design
 * this one exists to avoid.
 */

/** Who is calling, in the two terms Postgres needs: a role and a claims blob. */
export interface Caller {
  role: 'anon' | 'authenticated' | 'service_role';
  /** The user's id when a bearer token identified one. `auth.uid()` reads this. */
  userId: string | null;
  claims: Record<string, unknown>;
}

/**
 * The caller, from the same two headers the data API uses.
 *
 * `apikey` says which project and whether the caller is anonymous or a trusted
 * backend; `Authorization` optionally says *which user*. A user token upgrades
 * `anon` to `authenticated` — it never upgrades `service_role`, because a
 * service key already bypasses RLS and narrowing it to a user would be a
 * surprise rather than a safeguard.
 */
export function callerFrom(req: FastifyRequest, ctx: ProjectContext): Caller {
  if (ctx.keyRole === 'service_role') {
    return { role: 'service_role', userId: null, claims: { role: 'service_role' } };
  }
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header) {
    return { role: 'anon', userId: null, claims: { role: 'anon' } };
  }
  // Throws on a bad token rather than silently falling back to `anon`. A caller
  // who presented a credential is asking to be identified by it, and quietly
  // treating a broken one as anonymous turns "your token expired" into "you have
  // no files".
  const bearer = verifyBearer(ctx, header);
  return {
    role: 'authenticated',
    userId: bearer.userId,
    claims: {
      role: 'authenticated', sub: bearer.userId,
      ...(bearer.email ? { email: bearer.email } : {}),
      session_id: bearer.sessionId,
    },
  };
}

/**
 * Runs `fn` inside one transaction, as the caller, with their claims in place.
 *
 * `SET LOCAL` and `set_config(..., true)` rather than their session-wide forms,
 * because both are scoped to the transaction — the only session-state pattern
 * that survives transaction pooling (D-015). A `SET ROLE` that outlived its
 * transaction would leak one caller's identity into whoever got the connection
 * next, which on a pooled port is a cross-user authorization bug rather than an
 * untidiness.
 *
 * The transaction is also what makes the metadata verdict and the byte operation
 * orderable: the caller's INSERT either passes their own policy or it does not,
 * and the object store is touched only after it has.
 */
export async function withCaller<T>(
  ctx: ProjectContext, caller: Caller,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  if (!ctx.authenticatorPassword) {
    // Deliberately a 503 and not a 500: the project is real and its data is
    // intact, it simply predates the role model and has no switching credential.
    // Storage is unavailable for it until it is reprovisioned.
    throw new ApiError(503, E.UNAVAILABLE,
      'This project has no switching credential, so storage cannot evaluate '
      + 'its policies. It predates the role model.');
  }
  const client = new Client({
    host: ctx.host, port: ctx.port, user: 'authenticator', database: 'postgres',
    password: ctx.authenticatorPassword, connectionTimeoutMillis: 5000,
    // Longer than auth's two seconds: a list over a large bucket is a legitimate
    // slow query in a way that a login never is. Still bounded, because a
    // statement that cannot finish in ten seconds is one to give up on rather
    // than one to let hold a connection.
    statement_timeout: 10_000,
  } as never);
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL ROLE ${roleLiteral(caller.role)}`);
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify(caller.claims)]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * The role name, from a closed set, interpolated only after being matched.
 *
 * `SET ROLE` takes an identifier and cannot be parameterised, so this is the one
 * place a role name reaches SQL as text. Checking it against a literal list
 * rather than escaping it is the difference between "this cannot be injected"
 * and "this is escaped correctly" — and only the first survives someone later
 * adding a role name from a JWT claim.
 */
function roleLiteral(role: Caller['role']): string {
  switch (role) {
    case 'anon': return 'anon';
    case 'authenticated': return 'authenticated';
    case 'service_role': return 'service_role';
    default: throw new ApiError(500, E.INTERNAL, 'unknown caller role');
  }
}

/**
 * Turns a policy refusal into the status the caller deserves.
 *
 * Postgres reports "no policy allowed this" in two shapes and they mean
 * different things to a client. A refused *write* raises 42501 — there is
 * something there and you may not touch it, which is a 403. A refused *read*
 * raises nothing at all: the rows simply are not in the result, so the caller
 * gets 404 from the absence rather than an error from a check. Callers that
 * cannot tell those apart end up retrying the first as if it were the second.
 */
export function policyError(err: unknown): ApiError | undefined {
  const message = (err as { message?: string })?.message ?? '';
  const code = (err as { code?: string })?.code;
  if (code === '42501' || /row-level security/i.test(message)) {
    return new ApiError(403, E.FORBIDDEN,
      'The project\'s policies do not allow this operation.');
  }
  if (code === '23505') {
    return new ApiError(409, E.CONFLICT, 'An object already exists at that path.');
  }
  if (code === '23514') {
    return new ApiError(400, E.VALIDATION_FAILED,
      'That name is not a legal object path.');
  }
  return undefined;
}
