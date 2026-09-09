import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { writeAudit, type Actor } from '@steadhold/audit';
import type { SecretStore } from '@steadhold/secrets';
import { classify } from '@steadhold/sql-guard';
import { ApiError } from '../../kernel/errors.ts';
import { ERROR_CODES } from '@steadhold/types';
import { require_ } from '../../kernel/permissions.ts';
import { resolvePrincipal, type PrincipalDeps } from '../../kernel/principal.ts';
import type { Role } from '@steadhold/types';
import { consoleContext, withConsoleDb } from './context.ts';
import { introspect } from './introspect.ts';
import { runScript, enforceGuard, MAX_TIMEOUT_MS, type ConsoleRole } from './run.ts';
import { rateLimitKey, type RateLimiter } from '../../kernel/rate-limit.ts';

/**
 * `POST /v1/projects/:ref/db/query` — the D-132 execution path.
 *
 * Everything the table editor and the SQL editor do against a customer database
 * arrives here. There is exactly one of these on purpose: D-132's argument is
 * that funnelling every GUI action through one audited, request-id'd,
 * rate-limited path is what keeps god-mode credentials out of the browser, and
 * two paths would mean two places to forget the audit.
 */

const RunBody = z.object({
  sql: z.string().min(1).max(100_000),
  /** The table editor binds DML here; the editor usually inlines its literals. */
  params: z.array(z.unknown()).max(64).optional(),
  role: z.enum(['admin', 'anon', 'authenticated']).optional(),
  claims: z.record(z.unknown()).optional(),
  read_only: z.boolean().optional(),
  confirm_destructive: z.boolean().optional(),
  /** Names typed back for the top rung of rail 2's ladder. */
  confirm_names: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Rail 3, bounded server-side however large this is. */
  timeout_ms: z.number().int().min(100).max(MAX_TIMEOUT_MS).optional(),
});

export interface DbDeps {
  pool: Pool;
  secrets: SecretStore;
  principals: PrincipalDeps;
  /** Only `roleOf` is needed: the project already names its organization. */
  orgs: { roleOf(userId: string, orgId: string): Promise<Role | undefined> };
  /**
   * Per-user, and absent means unlimited — which is only correct in tests. The
   * service wires one in `main.ts`.
   */
  limiter?: RateLimiter;
}

/**
 * A Postgres error, turned into the envelope the editor needs.
 *
 * `position` is the field that matters and the reason this is not just
 * `err.message`: it is a 1-based character offset into the statement, which is
 * what lets the editor put the cursor on the offending token. A syntax error
 * without it is a sentence the user has to re-find by eye.
 *
 * Only these four fields, and no `where` or `internalQuery`: those can carry the
 * body of a function the customer did not write — a platform trigger, for
 * instance — and the console should not be a way to read one.
 */
function pgDetail(err: unknown): Record<string, unknown> | undefined {
  const e = err as { code?: unknown; position?: unknown; detail?: unknown; hint?: unknown };
  // A **SQLSTATE**, not any string `code`. Node puts `ECONNREFUSED` and
  // `ETIMEDOUT` in the same field, and treating those as the customer's SQL
  // being wrong turned "the project's database is unreachable" into a 400 that
  // blamed their query — found by a test expecting 409 and getting 400.
  // SQLSTATE is exactly five alphanumerics, which no Node errno is.
  if (typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return undefined;
  return {
    pg: {
      sqlstate: e.code,
      position: typeof e.position === 'string' ? Number(e.position) : (e.position ?? null),
      detail: typeof e.detail === 'string' ? e.detail : null,
      hint: typeof e.hint === 'string' ? e.hint : null,
    },
  };
}

/**
 * The membership check both routes need.
 *
 * Extracted rather than repeated: it decides a 404-not-403, which is the sort of
 * thing that gets one route right and the second one subtly wrong. A ref is
 * guessable in principle, so a non-member must get the same answer as a stranger
 * rather than a 403 that confirms the project exists.
 */
async function requireMember(
  deps: DbDeps, req: unknown, organizationId: string,
): Promise<{ userId: string; role: Role }> {
  const principal = await resolvePrincipal(req as never, deps.principals);
  if (!principal.userId) {
    throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
      'This endpoint runs SQL as a person and the static token is not a user.');
  }
  const role = await deps.orgs.roleOf(principal.userId, organizationId);
  if (!role) throw ApiError.notFound('Project');
  require_(role, 'db.query');
  return { userId: principal.userId, role };
}

export function registerDbRoutes(app: FastifyInstance, deps: DbDeps): void {
  app.post('/v1/projects/:ref/db/query', async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const requestId = String(reply.getHeader('x-request-id') ?? req.id);

    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.issues[0]?.message ?? 'Invalid request.');
    }
    const body = parsed.data;

    // Claims without `authenticated` is a request that does not mean what its
    // author thinks: the claims would be set and then ignored, and a policy
    // debugging session would silently test the wrong thing.
    if (body.claims && body.role !== 'authenticated') {
      throw ApiError.validation(
        'claims apply only to role "authenticated" — the run would ignore them.');
    }

    const ctx = await consoleContext(deps, ref);

    /**
     * Membership is what makes a ref private — a ref is guessable in principle,
     * so a non-member gets the same 404 as a stranger rather than a 403 that
     * confirms the project exists.
     *
     * `db.query` is a member capability for the reason recorded on it: a member
     * can already reveal the connection string and run the same SQL from psql.
     */
    const { userId } = await requireMember(deps, req, ctx.organizationId);
    const actor: Actor = { type: 'user', userId, ip: req.ip ?? null, requestId };

    /**
     * Rate limited per user, not per project.
     *
     * The thing being protected is the node's CPU, and a person with a runaway
     * loop in a script hits every project they can reach rather than one. Per
     * project would also let a large organization DoS its own smallest project
     * by being busy elsewhere.
     */
    if (deps.limiter) {
      const hit = await deps.limiter.hit(rateLimitKey('db-query', userId));
      if (!hit.allowed) {
        reply.header('retry-after', String(hit.retryAfterSeconds));
        throw new ApiError(429, ERROR_CODES.VALIDATION_FAILED,
          `Too many queries. Try again in ${hit.retryAfterSeconds}s.`);
      }
    }

    /**
     * Audited **before** it runs, and that ordering is the point.
     *
     * A statement recorded only on success is a log that cannot answer the one
     * question an audit log exists for: what was attempted. A `DROP TABLE` that
     * failed on a lock, or timed out halfway, is exactly what someone will come
     * looking for later. The outcome is a second row, so a run that never
     * finishes still leaves the attempt behind.
     */
    const script = classify(body.sql);

    // Also before the connection, and for the same reason the guard is: an empty
    // script is a client bug, and answering it with whatever the socket did is
    // both slower and wrong. It surfaced as a 500 from the dead-port fixture.
    if (script.statements.length === 0) {
      throw ApiError.validation('There is no statement to run.');
    }

    /**
     * Rail 2, here rather than inside the runner — and the ordering is the point,
     * not tidiness. `runScript` also enforces it, but it runs inside
     * `withConsoleDb`, so leaving this to the runner meant the *connection*
     * happened first: a `DROP TABLE` with no confirmation opened a socket before
     * being refused. The test that asserts a 409 caught it as a 400, because the
     * connection failed before the guard ever ran.
     *
     * Two consequences, both wanted. A refused run costs nothing, so the endpoint
     * cannot be used to open connections. And a refusal is not an attempt on the
     * database, so it writes no audit row — the log stays a record of what was
     * actually tried.
     */
    enforceGuard(script, {
      sql: body.sql,
      ...(body.confirm_destructive === undefined
        ? {} : { confirmDestructive: body.confirm_destructive }),
      ...(body.confirm_names ? { confirmNames: body.confirm_names } : {}),
    });

    await writeAudit(deps.pool, actor, {
      action: 'db.query',
      resourceType: 'project',
      resourceId: ref,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      metadata: {
        // The SQL verbatim, which the history panel is documented as storing
        // (SQL-editor doc §History) along with its own caution that literals
        // persist. Redaction is OQ-134 and is not decided here.
        sql: body.sql,
        role: body.role ?? 'admin',
        read_only: body.read_only ?? false,
        statements: script.statements.length,
        danger: script.danger,
        confirmed: body.confirm_destructive ?? false,
      },
    });

    const started = Date.now();
    try {
      const { results } = await withConsoleDb(ctx, (client) => runScript(client, {
        sql: body.sql,
        ...(body.params ? { params: body.params } : {}),
        ...(body.role ? { role: body.role as ConsoleRole } : {}),
        ...(body.claims ? { claims: body.claims } : {}),
        ...(body.read_only === undefined ? {} : { readOnly: body.read_only }),
        ...(body.confirm_destructive === undefined
          ? {} : { confirmDestructive: body.confirm_destructive }),
        ...(body.confirm_names ? { confirmNames: body.confirm_names } : {}),
        ...(body.timeout_ms === undefined ? {} : { timeoutMs: body.timeout_ms }),
      }));

      await writeAudit(deps.pool, actor, {
        action: 'db.query_succeeded',
        resourceType: 'project',
        resourceId: ref,
        projectId: ctx.projectId,
        organizationId: ctx.organizationId,
        metadata: {
          duration_ms: Date.now() - started,
          statements: results.length,
          rows: results.reduce((n: number, r) => n + r.row_count, 0),
        },
      });

      return reply.status(200).send({ results });
    } catch (err) {
      // An ApiError here is one of our own rails refusing — pass it through
      // rather than dressing a refusal up as a database failure.
      if (err instanceof ApiError) throw err;

      /**
       * A database we could not reach is our problem, not the customer's SQL.
       *
       * `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` here mean the project's
       * container is not answering on the port the placement row names — the
       * project says `ready` and the substrate disagrees. 503 says "try again",
       * which is true, where a 500 says "we crashed" and a 400 blames a query
       * that never ran.
       */
      const netCode = (err as { code?: unknown }).code;
      if (typeof netCode === 'string'
          && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']
            .includes(netCode)) {
        await writeAudit(deps.pool, actor, {
          action: 'db.query_failed',
          resourceType: 'project',
          resourceId: ref,
          projectId: ctx.projectId,
          organizationId: ctx.organizationId,
          metadata: { duration_ms: Date.now() - started, unreachable: netCode },
        });
        throw new ApiError(503, ERROR_CODES.INTERNAL,
          'This project\'s database is not answering. It may be restarting — '
          + 'try again in a moment.');
      }

      const detail = pgDetail(err);
      await writeAudit(deps.pool, actor, {
        action: 'db.query_failed',
        resourceType: 'project',
        resourceId: ref,
        projectId: ctx.projectId,
        organizationId: ctx.organizationId,
        metadata: {
          duration_ms: Date.now() - started,
          sqlstate: (detail?.pg as { sqlstate?: string } | undefined)?.sqlstate ?? null,
        },
      });

      if (detail) {
        // 400, not 500: the customer's SQL was rejected by the customer's own
        // database. A 500 would put their typo in our error-rate alert and tell
        // them the platform is broken.
        throw new ApiError(400, ERROR_CODES.SQL_ERROR, (err as Error).message, detail);
      }
      throw err;
    }
  });

  /**
   * `GET /v1/projects/:ref/db/introspect` — the editors' schema payload.
   *
   * One request returning schemas, tables, columns, functions, policies and role
   * names, because that is what the doc specifies and what the client caches: the
   * SQL editor's completion source and the table editor's whole left-hand side
   * are one query key, invalidated together on any successful DDL.
   *
   * A **GET**, and that is a real decision rather than REST habit. It reads and
   * changes nothing, so it wants HTTP caching and it must not need a CSRF token —
   * the editor refetches this on window focus and every 60 seconds while it is
   * open (D-134), and a mutating verb would make that a stream of audited
   * "attempts" in a log that is meant to record what a person did.
   *
   * Not audited, for the same reason. Reading one's own schema is not an event;
   * recording it 60 times a minute per open tab would bury the statements that
   * matter under the polling of a UI. The *connection* is still the audited
   * `steadhold_admin` path — what is skipped is a row per read, not the identity.
   */
  app.get('/v1/projects/:ref/db/introspect', async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const ctx = await consoleContext(deps, ref);
    await requireMember(deps, req, ctx.organizationId);

    try {
      const data = await withConsoleDb(ctx, async (client) => {
        // Read-only and short. Introspection touches only the catalog, so a run
        // that cannot finish in ten seconds is a database in trouble rather than
        // a big schema — and holding the console's 60s budget for a sidebar
        // would make a slow project feel broken twice over.
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL statement_timeout = 10000');
          await client.query('SET TRANSACTION READ ONLY');
          await client.query('SET LOCAL ROLE "developer"');
          const out = await introspect(client);
          await client.query('COMMIT');
          return out;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      });

      // Private, and briefly. The payload is one customer's schema, so a shared
      // cache must never hold it; 10 seconds is enough to collapse the burst of
      // requests an editor makes when several panels mount at once, and short
      // enough that the DDL-invalidation the client does is still what governs
      // freshness.
      reply.header('cache-control', 'private, max-age=10');
      return reply.status(200).send(data);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const netCode = (err as { code?: unknown }).code;
      if (typeof netCode === 'string'
          && ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH']
            .includes(netCode)) {
        throw new ApiError(503, ERROR_CODES.INTERNAL,
          'This project\'s database is not answering. It may be restarting — '
          + 'try again in a moment.');
      }
      const detail = pgDetail(err);
      if (detail) {
        throw new ApiError(400, ERROR_CODES.SQL_ERROR, (err as Error).message, detail);
      }
      throw err;
    }
  });
}
