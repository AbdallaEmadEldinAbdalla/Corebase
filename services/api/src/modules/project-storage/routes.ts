import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { Client } from 'pg';
import type { S3 } from '@steadhold/s3';
import { writeAudit } from '@steadhold/audit';
import { SECRET_NAMES, type SecretStore } from '@steadhold/secrets';
import { ERROR_CODES, type Role } from '@steadhold/types';
import { ApiError } from '../../kernel/errors.ts';
import { require_ } from '../../kernel/permissions.ts';
import { resolvePrincipal, actorOf, type PrincipalDeps } from '../../kernel/principal.ts';
import { objectKey } from '../storage/keys.ts';
import {
  masterSecret, signToken, CURRENT_KID, DEFAULT_EXPIRY_SECONDS, MAX_EXPIRY_SECONDS,
} from '../storage/signing.ts';

/**
 * `/v1/projects/:ref/storage/*` — the dashboard's file browser (P7u).
 *
 * ## What this does and does not duplicate
 *
 * The data plane already has a complete storage API, and this is not a second
 * one. Three of the four operations here are *thin*: listing is SQL against the
 * same two tables, a signed URL is the same `signToken` the data plane mints and
 * redeems, and a delete is the same two steps in the same order. What this file
 * owns is the part the data plane cannot provide a browser — **admission**.
 * `/storage/v1/*` is authorised by an `apikey`, and the key that sees every
 * object is `service_role`, which D-132 forbids a browser to hold.
 *
 * The data-plane routes take `admit` as an injected dependency, so registering
 * them a second time under this prefix with a dashboard-shaped `admit` was the
 * elegant option and is not the one taken: it would also expose upload,
 * overwrite and the public-object path, each of which needs its own thought
 * about what a dashboard should be able to do. Four operations, chosen, beats a
 * surface inherited wholesale.
 *
 * ## The role, and why this one is a member capability
 *
 * `developer` **owns** `storage.buckets` and `storage.objects`, and their RLS is
 * `ENABLE` without `FORCE` (D-191) — so the owner sees every row. That is the
 * dashboard's correct view, and it is also why the capability here is
 * `db.query`'s level rather than the admin gate the end-users page needed: a
 * member can already read these tables from psql with the connection string
 * `project.read` reveals. Unlike `auth.users`, where `developer` has no
 * privilege at all, there is nothing new being handed over.
 *
 * The bytes are the exception, and they are audited: a signed URL is a
 * capability that outlives the session that minted it, so minting one is a
 * recorded act.
 */

export interface ProjectStorageDeps {
  pool: Pool;
  secrets: SecretStore;
  principals: PrincipalDeps;
  orgs: { roleOf(userId: string, orgId: string): Promise<Role | undefined> };
  /** Absent means the object routes are not registered — see `main.ts`. */
  s3?: S3 | undefined;
  onError?: ((err: Error, at: Record<string, unknown>) => void) | undefined;
}

/** A page a person can read. Folders are cheap; a thousand files are not. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

const ListQuery = z.object({
  /** `photos/2026/` — the folder being looked at. Empty is the bucket's root. */
  prefix: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
});

const SignBody = z.object({
  bucket: z.string().min(1).max(200),
  path: z.string().min(1).max(1024),
  expires_in: z.coerce.number().int().min(1).max(MAX_EXPIRY_SECONDS).optional(),
});

const DeleteBody = z.object({
  bucket: z.string().min(1).max(200),
  paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
});

interface StorageContext {
  projectId: string;
  ref: string;
  organizationId: string;
  host: string;
  port: number;
  password: string;
}

/**
 * Connect as `steadhold_admin` and become `developer` for the transaction.
 *
 * The same two steps `/db/query` takes, and for the same reason: the platform
 * role is what has a credential, and the customer's role is what owns the data.
 * `steadhold_admin` has **no** privilege on the storage tables — checked, not
 * assumed — so the `SET LOCAL ROLE` is not a nicety, it is the whole access.
 *
 * `SET LOCAL` inside a transaction rather than `SET`, because a role that
 * outlives its transaction leaks into whoever gets the connection next.
 */
async function asOwner<T>(
  ctx: StorageContext, fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: ctx.host, port: ctx.port, user: 'steadhold_admin', database: 'postgres',
    password: ctx.password, connectionTimeoutMillis: 5_000, ssl: false,
  } as never);
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL statement_timeout = 10000');
      await client.query('SET LOCAL ROLE "developer"');
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

export function registerProjectStorage(
  app: FastifyInstance, deps: ProjectStorageDeps,
): void {
  /**
   * Caller first, ref second (D-474): resolving a ref before authenticating
   * tells an unauthenticated caller whether it exists.
   */
  const authorise = async (req: unknown): Promise<{ userId: string; ctx: StorageContext }> => {
    const principal = await resolvePrincipal(req as never, deps.principals);
    if (!principal.userId) {
      throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
        'This endpoint reads a person\'s own project and the static token is not a user.');
    }
    const { ref } = (req as { params: { ref: string } }).params;
    const { rows } = await deps.pool.query<{
      id: string; ref: string; organization_id: string;
      host: string | null; port: number | null; status: string;
    }>(
      // `nodes.address`, not `project_databases.connection_host` — the
      // customer-facing name is not the one the control plane dials (D-478).
      `SELECT p.id, p.ref::text AS ref, p.organization_id,
              n.address AS host, d.port, p.status::text AS status
         FROM projects p
         LEFT JOIN project_databases d ON d.project_id = p.id
         LEFT JOIN nodes n ON n.id = d.node_id
        WHERE p.ref = $1`, [ref]);
    const row = rows[0];
    if (!row) throw ApiError.notFound('Project');

    const role = await deps.orgs.roleOf(principal.userId, row.organization_id);
    if (!role) throw ApiError.notFound('Project');
    require_(role, 'db.query');

    if (row.status !== 'ready') {
      throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
        `This project is ${row.status}, so its files cannot be read yet.`);
    }
    if (!row.host || row.port === null) {
      throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
        'This project has no database placement yet.');
    }
    const password = await deps.secrets.get(row.id, SECRET_NAMES.adminRole);
    if (!password) {
      throw new ApiError(503, ERROR_CODES.INTERNAL,
        'This project has no console credential, so its files cannot be read.');
    }
    return {
      userId: principal.userId,
      ctx: {
        projectId: row.id, ref: row.ref, organizationId: row.organization_id,
        host: row.host, port: row.port, password,
      },
    };
  };

  // ── buckets ───────────────────────────────────────────────────────────────
  app.get('/v1/projects/:ref/storage/buckets', async (req, reply) => {
    const { ctx } = await authorise(req);
    return asOwner(ctx, async (db) => {
      /**
       * One statement, with the counts, because a bucket list without them is a
       * list of names — "is anything in here" is the first question, and asking
       * it per bucket would be N+1 round trips to answer it.
       *
       * A `LEFT JOIN` and not a correlated subquery: an empty bucket must appear
       * with a zero rather than vanish, which is the state a developer is most
       * often looking at just after creating one.
       */
      const { rows } = await db.query<{
        id: string; name: string; public: boolean;
        file_size_limit: string | null; allowed_mime_types: string[] | null;
        created_at: Date; objects: string; bytes: string | null;
      }>(
        // `public`, not `is_public`: the column is `storage.buckets.public`,
        // and the `is_public` I first wrote came from a *type* in the
        // data-plane module — an alias in one of its selects — rather than from
        // the schema. A type is not a schema, and reading one for the other is
        // how this failed on its first request.
        `SELECT b.id, b.name, b.public, b.file_size_limit::text,
                b.allowed_mime_types, b.created_at,
                count(o.id)::text AS objects, sum(o.size)::text AS bytes
           FROM storage.buckets b
           LEFT JOIN storage.objects o ON o.bucket_id = b.id
          GROUP BY b.id, b.name, b.public, b.file_size_limit,
                   b.allowed_mime_types, b.created_at
          ORDER BY b.name`);
      return reply.status(200).send({
        buckets: rows.map((b) => ({
          id: b.id, name: b.name, is_public: b.public,
          file_size_limit: b.file_size_limit === null ? null : Number(b.file_size_limit),
          allowed_mime_types: b.allowed_mime_types,
          created_at: b.created_at.toISOString(),
          objects: Number(b.objects),
          // `sum` over no rows is null, and 0 is the honest rendering of it.
          bytes: b.bytes === null ? 0 : Number(b.bytes),
        })),
      });
    });
  });

  // ── objects, folder-style ─────────────────────────────────────────────────
  app.get('/v1/projects/:ref/storage/buckets/:bucket/objects', async (req, reply) => {
    const { ctx } = await authorise(req);
    const { bucket } = req.params as { bucket: string };
    const parsed = ListQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.issues[0]?.message ?? 'Invalid query.');
    }
    const prefix = parsed.data.prefix ?? '';
    const limit = parsed.data.limit ?? DEFAULT_LIMIT;

    return asOwner(ctx, async (db) => {
      const { rows: found } = await db.query<{ id: string }>(
        `SELECT id FROM storage.buckets WHERE name = $1`, [bucket]);
      if (!found[0]) throw ApiError.resourceNotFound('Bucket');
      const bucketId = found[0].id;

      /**
       * Folders are derived, not stored — the storage doc's `delimiter` model.
       *
       * `storage.objects.name` is a whole path (`photos/2026/a.jpg`), so a
       * "folder" is the distinct first segment after the prefix. Doing it in SQL
       * rather than in the page keeps the *count* honest: a bucket with 40,000
       * files under twelve folders returns twelve rows, and a page that fetched
       * the files to group them client-side would have to fetch all 40,000 to
       * know there were twelve.
       *
       * `position($2 in ...)` is deliberately not used to test the prefix —
       * `like` with an escaped pattern anchors at the start, which is what an
       * index on `name` can serve. The escape matters: a prefix containing `%`
       * or `_` is a legitimate folder name and would otherwise match wildly.
       */
      const like = prefix.replace(/([\\%_])/g, '\\$1') + '%';
      /**
       * `$2::int`, and the cast is load-bearing.
       *
       * `substring(x from y)` has two overloads: an offset when `y` is an
       * integer, and a **regex extraction** when it is text. An uncast
       * parameter is inferred as text, so `substring(name from $2)` silently
       * became `substring(name from '1')` — the regex `1`, which matches
       * nothing in these names and returns `NULL`. `NULL LIKE '%/%'` is `NULL`,
       * so every row was filtered out and both queries returned empty against
       * data that was plainly there. The predicate tested correctly by hand,
       * which is exactly why: typed literally it takes the other overload.
       */
      const { rows: folders } = await db.query<{ name: string; objects: string }>(
        `SELECT split_part(substring(name from $2::int), '/', 1) || '/' AS name,
                count(*)::text AS objects
           FROM storage.objects
          WHERE bucket_id = $1 AND name LIKE $3 ESCAPE '\\'
            AND substring(name from $2::int) LIKE '%/%'
          GROUP BY 1 ORDER BY 1 LIMIT $4`,
        [bucketId, prefix.length + 1, like, limit]);

      const { rows: files } = await db.query<{
        id: string; name: string; size: string | null; mime_type: string | null;
        etag: string | null; created_at: Date; updated_at: Date;
      }>(
        `SELECT id, name, size::text, mime_type, etag, created_at, updated_at
           FROM storage.objects
          WHERE bucket_id = $1 AND name LIKE $2 ESCAPE '\\'
            AND substring(name from $3::int) NOT LIKE '%/%'
          ORDER BY name LIMIT $4`,
        [bucketId, like, prefix.length + 1, limit + 1]);

      const more = files.length > limit;
      return reply.status(200).send({
        prefix,
        folders: folders.map((f) => ({ name: f.name, objects: Number(f.objects) })),
        objects: (more ? files.slice(0, limit) : files).map((o) => ({
          id: o.id,
          // The leaf, not the whole path: the prefix is the page's context and
          // repeating it in every row is noise the eye has to strip.
          name: o.name.slice(prefix.length),
          path: o.name,
          size: o.size === null ? 0 : Number(o.size),
          mime_type: o.mime_type,
          etag: o.etag,
          created_at: o.created_at.toISOString(),
          updated_at: o.updated_at.toISOString(),
        })),
        has_more: more,
      });
    });
  });

  // ── a signed URL, for download and for sharing ────────────────────────────
  app.post('/v1/projects/:ref/storage/sign', async (req, reply) => {
    const { userId, ctx } = await authorise(req);
    const requestId = String(reply.getHeader('x-request-id') ?? req.id);
    const parsed = SignBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw ApiError.validation('Send `bucket` and `path`, optionally `expires_in`.');
    }
    const { bucket, path } = parsed.data;
    const seconds = parsed.data.expires_in ?? DEFAULT_EXPIRY_SECONDS;

    // It has to exist, or the URL is a link to a 404 that looks like a working
    // share until someone clicks it.
    const exists = await asOwner(ctx, async (db) => (await db.query(
      `SELECT 1 FROM storage.objects o
         JOIN storage.buckets b ON b.id = o.bucket_id
        WHERE b.name = $1 AND o.name = $2`, [bucket, path])).rows.length > 0);
    if (!exists) throw ApiError.resourceNotFound('Object');

    const master = await masterSecret(deps.secrets, ctx.projectId);
    const token = signToken(master, {
      ref: ctx.ref, bucket, path,
      exp: Math.floor(Date.now() / 1000) + seconds,
      kid: CURRENT_KID,
    });

    /**
     * Audited, unlike the listing beside it.
     *
     * A signed URL is a **capability that outlives the session that minted it**:
     * anyone holding the link can read the object with no credential at all,
     * until it expires. That is the same shape as revealing the `service_role`
     * key, which is audited for the same reason — so who minted a share, for
     * what, and for how long is a recorded fact rather than an inference from
     * the request log.
     */
    await writeAudit(deps.pool,
      actorOf(await resolvePrincipal(req as never, deps.principals), req as never, requestId), {
        action: 'storage.url_signed', resourceType: 'storage_object',
        resourceId: `${bucket}/${path}`,
        organizationId: ctx.organizationId, projectId: ctx.projectId,
        metadata: { ref: ctx.ref, actor_user_id: userId, bucket, path, expires_in: seconds },
      });

    return reply.status(200).send({
      // A path, not an absolute URL, for the reason the data plane's own sign
      // route gives: behind a proxy this service does not reliably know its
      // public origin, and guessing produces links that work in staging only.
      path: `/storage/v1/object/sign/${encodeURIComponent(bucket)}`
        + `/${path.split('/').map(encodeURIComponent).join('/')}?token=${token}`,
      expires_in: seconds,
    });
  });

  // ── delete ────────────────────────────────────────────────────────────────
  app.post('/v1/projects/:ref/storage/delete', async (req, reply) => {
    const { userId, ctx } = await authorise(req);
    const requestId = String(reply.getHeader('x-request-id') ?? req.id);
    if (!deps.s3) {
      // Refused rather than half-done: deleting the row without the bytes is
      // exactly the orphan the storage architecture treats as its central
      // consistency problem, and doing it knowingly would be worse than a crash.
      throw new ApiError(503, ERROR_CODES.INTERNAL,
        'This deployment has no object store configured, so files cannot be deleted.');
    }
    const parsed = DeleteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw ApiError.validation('Send `bucket` and a `paths` array of 1–100 names.');
    }
    const { bucket, paths } = parsed.data;

    /**
     * Metadata first, then bytes — the ordering is the whole design.
     *
     * A row removed with its bytes left behind is an orphan the sweep can find
     * and clean (D-124). Bytes removed with the row left behind is a listing
     * that promises a file which 404s, which nothing can repair automatically.
     * So the recoverable failure is the one this risks, deliberately.
     */
    const removed = await asOwner(ctx, async (db) => {
      const { rows } = await db.query<{ name: string }>(
        `DELETE FROM storage.objects o
          USING storage.buckets b
          WHERE b.id = o.bucket_id AND b.name = $1 AND o.name = ANY($2::text[])
        RETURNING o.name`, [bucket, paths]);
      return rows.map((r) => r.name);
    });
    if (removed.length === 0) throw ApiError.resourceNotFound('Object');

    for (const name of removed) {
      await deps.s3.deleteObject(objectKey(ctx.ref, bucket, name))
        .catch((e: Error) => deps.onError?.(e, { at: 'dashboard-delete', bucket, name }));
    }

    await writeAudit(deps.pool,
      actorOf(await resolvePrincipal(req as never, deps.principals), req as never, requestId), {
        action: 'storage.objects_deleted', resourceType: 'storage_object',
        resourceId: `${bucket}/${removed[0]}`,
        organizationId: ctx.organizationId, projectId: ctx.projectId,
        metadata: { ref: ctx.ref, actor_user_id: userId, bucket, count: removed.length,
                    paths: removed.slice(0, 20) },
      });

    return reply.status(200).send({ deleted: removed.length });
  });
}
