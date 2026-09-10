import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { Client } from 'pg';
import { writeAudit } from '@steadhold/audit';
import { SECRET_NAMES, type SecretStore } from '@steadhold/secrets';
import { ERROR_CODES, type Role } from '@steadhold/types';
import { ApiError } from '../../kernel/errors.ts';
import { require_ } from '../../kernel/permissions.ts';
import { resolvePrincipal, actorOf, type PrincipalDeps } from '../../kernel/principal.ts';
import {
  listUsers, searchUsers, findUserById, adminUpdateUser, softDeleteUser,
  revokeUserSessions, writeAuthAudit, estimateUsers, type AuthUser,
} from '../project-auth/store.ts';

/**
 * `/v1/projects/:ref/auth/users` — the dashboard's view of the customer's own
 * end users (P7s).
 *
 * ## Why this exists at all, when `/auth/v1/admin/users` already does
 *
 * That surface is the **data plane**, authorised by the project's
 * `service_role` key — and D-132's whole point is that a browser never holds
 * one. So the dashboard cannot call it, and the choice was between shipping the
 * key to the page and putting a scoped endpoint here. This is the same shape the
 * console took: the privileged credential stays server-side, the browser gets
 * the few operations the page needs, and every mutation is audited with a real
 * actor.
 *
 * It is deliberately **not** a second implementation. Every statement comes from
 * `modules/project-auth/store.ts`, so a ban means here exactly what a ban means
 * over the data plane — including the parts that are easy to get subtly
 * different, like banning also revoking sessions (D-113) and a delete being a
 * tombstone that does not cascade into the customer's schemas.
 *
 * ## The connection
 *
 * `steadhold_auth`, not `steadhold_admin`. The console's role cannot read
 * `auth.users` — `has_table_privilege('steadhold_admin', 'auth.users', 'SELECT')`
 * is **false**, which is worth stating because it is the fact that made this
 * module necessary rather than a page over `POST /db/query`. `auth.users` is
 * owned by `postgres` and reachable by the auth role, which is why the auth
 * module's own connection is the one to reuse.
 *
 * ## The role gate
 *
 * `authuser.read` and `authuser.manage` are **admin** capabilities (D-478), and
 * that is a departure from `db.query` rather than an inconsistency with it. The
 * console is a member's because a member can already do the same from psql; this
 * cannot be reached from psql at all, and the key that could reach it is behind
 * `key.manage`. So the page hands a member something new, and what it hands over
 * is other people's email addresses.
 */

export interface ProjectUsersDeps {
  pool: Pool;
  secrets: SecretStore;
  principals: PrincipalDeps;
  orgs: { roleOf(userId: string, orgId: string): Promise<Role | undefined> };
}

/**
 * Where the project's database is, from the control plane's point of view.
 *
 * **`nodes.address`, not `project_databases.connection_host`** — and the
 * distinction cost an afternoon. `connection_host` is the *customer-facing*
 * name: it is what goes in the connection string a developer copies, and in a
 * real deployment it is `<ref>.steadhold.app`. The control plane is not a
 * customer; it reaches the database over the private network, where the
 * addressable thing is the node. In staging the two happen to be the same
 * `127.0.0.1`, so a first version built on `consoleContext` worked by hand and
 * failed in the e2e fixture with `getaddrinfo ENOTFOUND
 * p49257….steadhold.app` — the fixture being the only place the two differ.
 *
 * `modules/project-auth/context.ts` already resolved it this way, which is the
 * clue that was there to be read: it is the other module that connects to a
 * project database from in here.
 */
interface UsersContext {
  projectId: string;
  ref: string;
  organizationId: string;
  host: string;
  port: number;
}

async function usersContext(deps: ProjectUsersDeps, ref: string): Promise<UsersContext> {
  const { rows } = await deps.pool.query<{
    id: string; ref: string; organization_id: string;
    host: string | null; port: number | null; status: string;
  }>(
    `SELECT p.id, p.ref::text AS ref, p.organization_id,
            n.address AS host, d.port, p.status::text AS status
       FROM projects p
       LEFT JOIN project_databases d ON d.project_id = p.id
       LEFT JOIN nodes n ON n.id = d.node_id
      WHERE p.ref = $1`, [ref]);
  const row = rows[0];
  if (!row) throw ApiError.notFound('Project');
  if (row.status !== 'ready') {
    // Named rather than surfaced as a connection timeout: "this project is
    // paused" is actionable and "ECONNREFUSED" is not.
    throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
      `This project is ${row.status}, so its users cannot be read yet.`);
  }
  if (!row.host || row.port === null) {
    throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
      'This project has no database placement yet.');
  }
  return {
    projectId: row.id, ref: row.ref, organizationId: row.organization_id,
    host: row.host, port: row.port,
  };
}

/** Defaults chosen to match the grid: a page a person can read, not a dump. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

const ListQuery = z.object({
  q: z.string().trim().min(1).max(320).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  /** Keyset cursor from a previous page: `created_at,id`. Ignored with `q`. */
  cursor: z.string().max(120).optional(),
});

const UpdateBody = z.object({
  /** An ISO timestamp to ban until, or `null` to lift a ban. */
  ban_until: z.string().datetime().nullable().optional(),
  /** Confirm an address without the user clicking anything, or un-confirm it. */
  email_confirm: z.boolean().optional(),
  /** Revoke every session without changing the account. */
  sign_out: z.boolean().optional(),
}).strict();

/**
 * The user as the dashboard sees one.
 *
 * `encrypted_password` is in `AuthUser` because the login path needs it, and the
 * single most valuable thing this function does is not forward it. Listed field
 * by field rather than deleted from a spread: a new column on `auth.users`
 * should have to be *added* here to reach a browser, not remembered about.
 */
function view(u: AuthUser) {
  return {
    id: u.id,
    email: u.email,
    email_confirmed_at: u.email_confirmed_at?.toISOString() ?? null,
    banned_until: u.banned_until?.toISOString() ?? null,
    created_at: u.created_at.toISOString(),
    last_sign_in_at: u.last_sign_in_at?.toISOString() ?? null,
    user_metadata: u.raw_user_meta_data,
    app_metadata: u.raw_app_meta_data,
  };
}

/**
 * Connect as the auth role.
 *
 * A short `statement_timeout`, like the auth module's own: every statement here
 * is indexed except the search, which is bounded by `limit`. Ten seconds rather
 * than the auth module's two, because a substring search over a large
 * `auth.users` is the one query that legitimately takes longer than a login.
 */
async function withAuthDb<T>(
  ctx: UsersContext, password: string, fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: ctx.host, port: ctx.port, user: 'steadhold_auth', database: 'postgres',
    password, connectionTimeoutMillis: 5_000, statement_timeout: 10_000, ssl: false,
  } as never);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export function registerProjectUsers(app: FastifyInstance, deps: ProjectUsersDeps): void {
  /**
   * Caller first, ref second — the ordering D-474 established on the console
   * routes for the same reason: resolving a ref before authenticating tells an
   * unauthenticated caller whether it exists.
   */
  const authorise = async (
    req: unknown, capability: 'authuser.read' | 'authuser.manage',
  ): Promise<{ userId: string; ctx: UsersContext; password: string }> => {
    const principal = await resolvePrincipal(req as never, deps.principals);
    if (!principal.userId) {
      throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
        'This endpoint reads a person\'s own project and the static token is not a user.');
    }
    const { ref } = (req as { params: { ref: string } }).params;
    const ctx = await usersContext(deps, ref);
    const role = await deps.orgs.roleOf(principal.userId, ctx.organizationId);
    if (!role) throw ApiError.notFound('Project');
    require_(role, capability);

    const password = await deps.secrets.get(ctx.projectId, SECRET_NAMES.authRole);
    if (!password) {
      // A project provisioned before the auth schema existed. Said plainly
      // rather than surfacing as a connection failure naming a role.
      throw new ApiError(503, ERROR_CODES.INTERNAL,
        'This project has no auth-role credential, so its users cannot be read. '
        + 'It predates the auth schema.');
    }
    return { userId: principal.userId, ctx, password };
  };

  app.get('/v1/projects/:ref/auth/users', async (req, reply) => {
    const { ctx, password } = await authorise(req, 'authuser.read');
    const parsed = ListQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.issues[0]?.message ?? 'Invalid query.');
    }
    const { q, limit = DEFAULT_LIMIT, cursor } = parsed.data;

    return withAuthDb(ctx, password, async (db) => {
      const [rows, estimate] = await Promise.all([
        q ? searchUsers(db, { q, limit })
          : listUsers(db, { limit, ...(cursor ? { cursor: parseCursor(cursor) } : {}) }),
        // Cheap enough to send on every page: the alternative is a footer that
        // can say "1–50" and never "of how many", which the UX standard calls a
        // lie of omission (D-466's argument, one table over).
        estimateUsers(db),
      ]);
      // `limit + 1` came back if there is another page — the store's own
      // convention, so `has_more` is a fact rather than a second racing count.
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return reply.status(200).send({
        users: page.map(view),
        has_more: hasMore,
        /**
         * `reltuples`, with `-1` meaning "never analyzed" rather than zero. Not
         * sent for a search, where the denominator would be the table's total
         * while the numerator is the matches — two different questions in one
         * sentence, which is worse than no sentence.
         */
        estimated_total: q ? null : estimate,
        // Absent for a search, because a keyset cursor is only valid for one
        // query string and one that silently means nothing is worse than none.
        next_cursor: hasMore && last && !q
          ? `${last.created_at.toISOString()},${last.id}` : null,
      });
    });
  });

  app.get('/v1/projects/:ref/auth/users/:id', async (req, reply) => {
    const { ctx, password } = await authorise(req, 'authuser.read');
    const { id } = req.params as { id: string };
    return withAuthDb(ctx, password, async (db) => {
      const user = await findUserById(db, id);
      // 404 here and an oracle nowhere else in the product: a caller who reached
      // this route is already an admin of the project that owns the row, so
      // confirming the id exists tells them nothing they cannot list.
      if (!user) throw ApiError.resourceNotFound('User');
      return reply.status(200).send(view(user));
    });
  });

  app.patch('/v1/projects/:ref/auth/users/:id', async (req, reply) => {
    const { userId, ctx, password } = await authorise(req, 'authuser.manage');
    const { id } = req.params as { id: string };
    const requestId = String(reply.getHeader('x-request-id') ?? req.id);
    const parsed = UpdateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw ApiError.validation(
        'Send some of `ban_until`, `email_confirm`, `sign_out`.');
    }
    const b = parsed.data;
    if (Object.keys(b).length === 0) throw ApiError.validation('Nothing to change.');

    const principal = await resolvePrincipal(req as never, deps.principals);

    return withAuthDb(ctx, password, async (db) => {
      let user: AuthUser | undefined;
      if (b.ban_until !== undefined || b.email_confirm !== undefined) {
        user = await adminUpdateUser(db, id, {
          ...(b.ban_until !== undefined
            ? { bannedUntil: b.ban_until === null ? null : new Date(b.ban_until) }
            : {}),
          ...(b.email_confirm !== undefined ? { emailConfirm: b.email_confirm } : {}),
        });
        if (!user) throw ApiError.resourceNotFound('User');
      } else {
        user = await findUserById(db, id);
        if (!user) throw ApiError.resourceNotFound('User');
      }

      /**
       * A ban revokes every session, and so does an explicit sign-out.
       *
       * D-113: a ban is enforced at login and refresh, not per request, because
       * the data plane has no session lookup. Revoking here is what makes it
       * immediate for everything except one outstanding access token — the
       * tightest guarantee a stateless token allows. Leaving it out would make a
       * ban look applied and behave as if it were not, for up to an hour.
       */
      const banning = b.ban_until !== undefined && b.ban_until !== null;
      if (banning || b.sign_out) {
        // `global`, and the current-session argument is unused for that scope —
        // there is no end-user session on this call, the actor is a developer.
        await revokeUserSessions(db, id, 'global', '');
      }

      // In the customer's own database (D-314), so it leaves with their pg_dump
      // — the same log the data-plane admin surface writes to.
      await writeAuthAudit(db, {
        action: banning ? 'user_banned'
          : b.ban_until === null ? 'user_unbanned'
          : b.sign_out ? 'user_signed_out' : 'user_updated',
        userId: id,
        payload: { via: 'dashboard', ...(b.email_confirm !== undefined
          ? { email_confirm: b.email_confirm } : {}) },
      });

      // And in ours, because "who banned this user" is a question about a
      // Steadhold account and the customer's log does not know our user ids.
      await writeAudit(deps.pool, actorOf(principal, req as never, requestId), {
        action: 'auth_user.updated', resourceType: 'auth_user', resourceId: id,
        organizationId: ctx.organizationId, projectId: ctx.projectId,
        metadata: { ref: ctx.ref, actor_user_id: userId, changes: Object.keys(b) },
      });

      return reply.status(200).send(view(user));
    });
  });

  app.delete('/v1/projects/:ref/auth/users/:id', async (req, reply) => {
    const { userId, ctx, password } = await authorise(req, 'authuser.manage');
    const { id } = req.params as { id: string };
    const requestId = String(reply.getHeader('x-request-id') ?? req.id);
    const principal = await resolvePrincipal(req as never, deps.principals);

    return withAuthDb(ctx, password, async (db) => {
      const gone = await softDeleteUser(db, id);
      if (!gone) throw ApiError.resourceNotFound('User');
      // The address the tombstone destroyed, kept in the audit row because
      // "which account was this" is the question asked afterwards and the user
      // row can no longer answer it.
      await writeAuthAudit(db, {
        action: 'user_deleted', userId: id,
        payload: { via: 'dashboard', email: gone.email },
      });
      await writeAudit(deps.pool, actorOf(principal, req as never, requestId), {
        action: 'auth_user.deleted', resourceType: 'auth_user', resourceId: id,
        organizationId: ctx.organizationId, projectId: ctx.projectId,
        metadata: { ref: ctx.ref, actor_user_id: userId, email: gone.email },
      });
      return reply.status(204).send();
    });
  });
}

/**
 * `created_at,id` from a previous page.
 *
 * A malformed cursor is a validation error rather than a silent first page: a
 * client that mangles it should be told, and a page that quietly restarts is how
 * a paging bug hides.
 */
function parseCursor(raw: string): { created_at: string; id: string } {
  const comma = raw.lastIndexOf(',');
  if (comma <= 0) throw ApiError.validation('cursor must be "created_at,id".');
  const created_at = raw.slice(0, comma);
  const id = raw.slice(comma + 1);
  if (Number.isNaN(Date.parse(created_at)) || id.length === 0) {
    throw ApiError.validation('cursor must be "created_at,id".');
  }
  return { created_at, id };
}
