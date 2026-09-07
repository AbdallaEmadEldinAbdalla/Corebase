import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { STORAGE_ERROR_CODES as E } from '@corebase/types';
import type { S3 } from '@corebase/s3';
import { ApiError } from '../../kernel/errors.ts';
import type { ProjectContext } from '../project-auth/context.ts';
import { policyError, type Caller } from './context.ts';
import { normalizeBucket, normalizePath, objectKey, PathError } from './keys.ts';
import { mimeAllowed, servingHeaders, sniff, SNIFF_BYTES } from './mime.ts';

/**
 * The proxied object path (P6c, D-122's ≤ 50 MB half).
 *
 * ## The two orderings, which are the whole consistency model (D-124)
 *
 * Postgres and the object store do not share a transaction. Every mutation is
 * two writes against two systems and either can fail, so the *orderings* are the
 * guarantee — there is no hidden transactional layer, and this comment is the
 * complete statement of it.
 *
 * The invariant chosen: **a metadata row must never reference bytes that do not
 * exist.** A row without bytes is a visible 500 on download and a false quota
 * charge; bytes without a row are invisible garbage that a sweep collects. So:
 *
 * - **Upload writes the object first, then the row.** A crash between them
 *   leaves an orphan, which nothing can see and the sweep deletes after its
 *   grace window. The reverse ordering would leave a row whose download 500s.
 * - **Delete removes the row first, then the object.** A crash between them
 *   leaves an orphan again — already invisible, since the row is gone. The
 *   reverse would leave a row pointing at nothing.
 *
 * Both failure directions therefore produce *cost*, never incorrectness. That is
 * the trade the whole design is built on, and it is why the sweep is a
 * requirement rather than a nicety.
 *
 * ## Why the RLS check comes before the bytes
 *
 * The metadata statement runs first and as the caller, so the customer's policy
 * decides. Only after it succeeds is the object store touched. An upload that
 * wrote bytes and then discovered the policy refuses it would be doing the
 * expensive half of the work for requests that were never allowed — and on the
 * delete side, would remove somebody's bytes on the strength of a check that had
 * not happened yet.
 */

/** D-122's threshold. Above this the presigned path applies (P6e). */
export const PROXY_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Per-project storage quotas, from the pricing table.
 *
 * Over quota, the contract is *uploads rejected, existing files keep serving* —
 * a customer at their limit has a read-only bucket, not a broken product.
 */
export const PLAN_STORAGE_BYTES: Record<string, number> = {
  free: 1 * 1024 ** 3,
  pro: 100 * 1024 ** 3,
  team: 250 * 1024 ** 3,
  // Custom by contract; the number here is a ceiling that should never bind.
  enterprise: 10 * 1024 ** 4,
};

export interface ObjectDeps {
  s3: S3;
  /** The plan, for the quota ceiling. Resolved with the project. */
  planOf: (ctx: ProjectContext) => Promise<string>;
  onError?: ((err: Error, ctx: Record<string, unknown>) => void) | undefined;
}

interface BucketConfig {
  id: string;
  is_public: boolean;
  file_size_limit: string | null;
  allowed_mime_types: string[] | null;
}

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * Everything the routes need from the module that owns admission.
 *
 * Passed in rather than imported so this file has no opinion about how a caller
 * was identified — it receives one and enforces policy with it.
 */
export interface ObjectRouteDeps extends ObjectDeps {
  admit: (req: FastifyRequest) => Promise<{ ctx: ProjectContext; caller: Caller }>;
  asCaller: <T>(
    ctx: ProjectContext, caller: Caller, fn: (q: Query) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Bucket config, via the SECURITY DEFINER lookup — see the SQL for why it is a
 * function rather than a plain select.
 *
 * At module scope because both halves of the route split need it, and a copy in
 * each would be two places for the 404-on-missing-bucket decision to drift.
 */
async function bucketConfig(q: Query, bucket: string): Promise<BucketConfig> {
  const rows = (await q(
    `SELECT id, is_public, file_size_limit, allowed_mime_types
       FROM storage.bucket_config($1)`, [bucket])).rows as BucketConfig[];
  if (!rows[0]) throw new ApiError(404, E.NOT_FOUND, 'No such bucket.');
  return rows[0];
}

/** The `*` part of the route, which Fastify hands over as `params['*']`. */
const wildcard = (req: FastifyRequest): string =>
  (req.params as Record<string, string>)['*'] ?? '';

function pathOrThrow(raw: string): string {
  try {
    return normalizePath(raw);
  } catch (err) {
    if (err instanceof PathError) throw new ApiError(400, E.VALIDATION_FAILED, err.message);
    throw err;
  }
}

function bucketOrThrow(raw: string): string {
  try {
    return normalizeBucket(raw);
  } catch (err) {
    if (err instanceof PathError) throw new ApiError(400, E.VALIDATION_FAILED, err.message);
    throw err;
  }
}

/**
 * The object routes split by **how their body arrives**, not by what they act on.
 *
 * That distinction cost two rounds of debugging, so it is the one the code is
 * organised around now. An upload's body is opaque bytes of any content type; a
 * list's body is JSON. Fastify's parsers are per-instance, so the two cannot
 * share a scope — and grouping them "by object vs bucket" put `POST /object/list`
 * in the bytes scope, where its JSON body arrived as a Buffer, the `prefix` field
 * read as `undefined`, and the endpoint silently listed the whole bucket.
 *
 * Silently is the word that matters: nothing errored. The prefix was simply
 * ignored, which for a file listing is a client seeing more than it asked for.
 */
export function registerObjectWrites(app: FastifyInstance, deps: ObjectRouteDeps): void {
  /**
   * Accept an upload, enforce, store, record.
   *
   * `upsert` distinguishes POST (create, 409 on collision) from PUT (overwrite).
   */
  async function upload(
    req: FastifyRequest, reply: FastifyReply, upsert: boolean,
  ): Promise<FastifyReply> {
    const { ctx, caller } = await deps.admit(req);
    const bucket = bucketOrThrow((req.params as Record<string, string>)['bucket'] ?? '');
    const name = pathOrThrow(wildcard(req));

    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      throw new ApiError(400, E.VALIDATION_FAILED,
        'Send the object bytes as the request body.');
    }
    // The size that matters is the one measured, never the one declared:
    // `Content-Length` is a client's claim and the body is the fact. The proxy
    // ceiling is checked here rather than after storing, so an oversized upload
    // costs a rejected request instead of a stored object and a deletion.
    if (body.length > PROXY_MAX_BYTES) {
      throw new ApiError(413, E.FILE_SIZE_LIMIT_EXCEEDED,
        `This path proxies objects up to ${PROXY_MAX_BYTES} bytes. `
        + 'Use a signed upload URL for anything larger.');
    }

    const declared = String(req.headers['content-type'] ?? 'application/octet-stream');

    const prepared = await deps.asCaller(ctx, caller, async (q) => {
      const cfg = await bucketConfig(q, bucket);

      const bucketLimit = cfg.file_size_limit === null ? null : Number(cfg.file_size_limit);
      if (bucketLimit !== null && body.length > bucketLimit) {
        throw new ApiError(413, E.FILE_SIZE_LIMIT_EXCEEDED,
          `This bucket accepts objects up to ${bucketLimit} bytes.`);
      }
      if (!mimeAllowed(declared, cfg.allowed_mime_types)) {
        throw new ApiError(415, E.MIME_TYPE_NOT_ALLOWED,
          `This bucket does not accept ${declared}.`);
      }
      const verdict = sniff(body.subarray(0, SNIFF_BYTES), declared);
      if (!verdict.ok) {
        // The reason is returned, not swallowed. A caller told only "rejected"
        // will retry the same file; one told "the declared type is image/png but
        // the content is not a PNG" will fix it.
        throw new ApiError(415, E.MIME_TYPE_NOT_ALLOWED,
          `Upload refused: ${verdict.reason}.`);
      }

      // Quota, read from the one-row fast path. Concurrent uploads can overshoot
      // by the in-flight window and that is accepted — quota is a billing
      // boundary, not a security one, and hard precision would need locking on
      // the hot path.
      const plan = await deps.planOf(ctx);
      const ceiling = PLAN_STORAGE_BYTES[plan] ?? PLAN_STORAGE_BYTES['free']!;
      const usage = (await q(`SELECT total_bytes FROM storage.usage`)).rows as
        Array<{ total_bytes: string }>;
      // `service_role` alone may read it; for any other caller the row is simply
      // absent, and an upload must not fail because the *quota check* was
      // unreadable. Absent means unenforced here and enforced by the true-up.
      const used = usage[0] ? Number(usage[0].total_bytes) : 0;
      // An upsert replaces bytes, so only the delta counts against the ceiling.
      const existing = (await q(
        `SELECT size FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
        [cfg.id, name])).rows as Array<{ size: string }>;
      const replacing = existing[0] ? Number(existing[0].size) : 0;
      if (used - replacing + body.length > ceiling) {
        throw new ApiError(413, E.STORAGE_QUOTA_EXCEEDED,
          'This project has no storage left. Delete something, or move to a larger plan.');
      }
      if (existing[0] && !upsert) {
        throw new ApiError(409, E.CONFLICT,
          'An object already exists at that path. Send `x-upsert: true` to replace it.');
      }
      return { bucketId: cfg.id, replacing: Boolean(existing[0]) };
    });

    // ── the object store, second ────────────────────────────────────────────
    const key = objectKey(ctx.ref, bucket, name);
    const { etag } = await deps.s3.putObject(key, body, { contentType: declared });

    // ── the row, third ──────────────────────────────────────────────────────
    //
    // If this fails the object is an orphan (D-124's F2): the caller gets their
    // error, and the object is deleted on a best-effort basis right away with
    // the sweep as the backstop. Best-effort is the honest word — if the delete
    // also fails there is nothing more to do here, and that is precisely the
    // case the sweep exists for.
    try {
      const rows = await deps.asCaller(ctx, caller, async (q) => (await q(
        `INSERT INTO storage.objects (bucket_id, name, owner, size, mime_type, etag)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (bucket_id, name) DO UPDATE
           SET size = EXCLUDED.size, mime_type = EXCLUDED.mime_type,
               etag = EXCLUDED.etag, updated_at = now()
         RETURNING id, name, size, mime_type, etag`,
        [prepared.bucketId, name, caller.userId, body.length, declared, etag])).rows as
        Array<Record<string, unknown>>);
      return reply.status(prepared.replacing ? 200 : 201).send({
        object: {
          ...rows[0], size: Number(rows[0]!['size']), bucket, key: undefined,
        },
      });
    } catch (err) {
      await deps.s3.deleteObject(key).catch((e: Error) =>
        deps.onError?.(e, { at: 'orphan-cleanup', key }));
      const mapped = policyError(err);
      if (mapped) throw mapped;
      throw err;
    }
  }

  app.post('/storage/v1/object/:bucket/*', async (req, reply) =>
    upload(req, reply, String(req.headers['x-upsert'] ?? '') === 'true'));

  // PUT is POST with upsert implied, per the endpoint table.
  app.put('/storage/v1/object/:bucket/*', async (req, reply) => upload(req, reply, true));
}

/** Everything whose body is JSON or absent: reads, listing and deletes. */
export function registerObjectReads(app: FastifyInstance, deps: ObjectRouteDeps): void {
  // ── GET /object/info/:bucket/* — metadata, no bytes ───────────────────────
  //
  // Registered before the download route because Fastify matches static segments
  // ahead of parameters, and `info` must not be read as a bucket name.
  app.get('/storage/v1/object/info/:bucket/*', async (req, reply) => {
    const { ctx, caller } = await deps.admit(req);
    const bucket = bucketOrThrow((req.params as Record<string, string>)['bucket'] ?? '');
    const name = pathOrThrow(wildcard(req));
    const rows = await deps.asCaller(ctx, caller, async (q) => {
      const cfg = await bucketConfig(q, bucket);
      return (await q(
        `SELECT name, size, mime_type, etag, metadata, created_at, updated_at
           FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
        [cfg.id, name])).rows as Array<Record<string, unknown>>;
    });
    if (!rows[0]) throw new ApiError(404, E.NOT_FOUND, 'No such object.');
    return reply.send({ object: { ...rows[0], size: Number(rows[0]['size']), bucket } });
  });

  // ── POST /object/list/:bucket ─────────────────────────────────────────────
  app.post('/storage/v1/object/list/:bucket', async (req, reply) => {
    const { ctx, caller } = await deps.admit(req);
    const bucket = bucketOrThrow((req.params as Record<string, string>)['bucket'] ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const prefix = typeof body['prefix'] === 'string' ? body['prefix'] : '';
    const limit = Math.min(Math.max(Number(body['limit'] ?? 100) || 100, 1), 1000);
    const cursor = typeof body['cursor'] === 'string' ? body['cursor'] : '';

    const rows = await deps.asCaller(ctx, caller, async (q) => {
      const cfg = await bucketConfig(q, bucket);
      // `LIKE prefix || '%'` with the `text_pattern_ops` index behind it, and a
      // keyset cursor on `name` rather than OFFSET: offset pagination over a
      // bucket someone is uploading into skips and repeats rows, which for a
      // file listing means a client that misses files without knowing it.
      //
      // Rows the caller's policies exclude simply do not appear. There is no
      // filtering step in this handler at all, which is the point.
      return (await q(
        `SELECT name, size, mime_type, etag, updated_at
           FROM storage.objects
          WHERE bucket_id = $1 AND name LIKE $2 || '%' AND name > $3
          ORDER BY name LIMIT $4`,
        [cfg.id, prefix, cursor, limit])).rows as Array<Record<string, unknown>>;
    });
    const objects = rows.map((r) => ({ ...r, size: Number(r['size']) }));
    // The cursor is the last *row's* name rather than the mapped object's, so
    // the type stays honest about where the value comes from.
    const last = rows[rows.length - 1];
    return reply.send({
      objects,
      // Present only when there may be more, so a client stops without a
      // trailing empty request.
      next_cursor: rows.length === limit && last ? String(last['name']) : null,
    });
  });

  // ── POST /object/delete/:bucket — batch ───────────────────────────────────
  app.post('/storage/v1/object/delete/:bucket', async (req, reply) => {
    const { ctx, caller } = await deps.admit(req);
    const bucket = bucketOrThrow((req.params as Record<string, string>)['bucket'] ?? '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const paths = body['paths'];
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 1000
        || paths.some((p) => typeof p !== 'string')) {
      throw new ApiError(400, E.VALIDATION_FAILED,
        '`paths` is an array of 1 to 1000 object paths.');
    }
    const names = (paths as string[]).map(pathOrThrow);

    // Rows first, then the bytes (D-124's F5). The rows that came back are the
    // ones the caller's policies permitted, so the byte deletions that follow
    // are exactly the permitted set — nothing here has to decide which.
    const deleted = await deps.asCaller(ctx, caller, async (q) => {
      const cfg = await bucketConfig(q, bucket);
      return (await q(
        `DELETE FROM storage.objects WHERE bucket_id = $1 AND name = ANY($2::text[])
         RETURNING name`, [cfg.id, names])).rows as Array<{ name: string }>;
    });
    for (const row of deleted) {
      await deps.s3.deleteObject(objectKey(ctx.ref, bucket, row.name))
        .catch((e: Error) => deps.onError?.(e, { at: 'batch-delete', name: row.name }));
    }
    return reply.send({ deleted: deleted.map((d) => d.name) });
  });

  // ── DELETE /object/:bucket/* ──────────────────────────────────────────────
  app.delete('/storage/v1/object/:bucket/*', async (req, reply) => {
    const { ctx, caller } = await deps.admit(req);
    const bucket = bucketOrThrow((req.params as Record<string, string>)['bucket'] ?? '');
    const name = pathOrThrow(wildcard(req));

    const gone = await deps.asCaller(ctx, caller, async (q) => {
      const cfg = await bucketConfig(q, bucket);
      return (await q(
        `DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2 RETURNING name`,
        [cfg.id, name])).rows.length > 0;
    });
    // 404 whether it was never there or the policy hid it — the same answer, and
    // distinguishing them would make this a probe for which objects exist.
    if (!gone) throw new ApiError(404, E.NOT_FOUND, 'No such object.');

    await deps.s3.deleteObject(objectKey(ctx.ref, bucket, name))
      .catch((e: Error) => deps.onError?.(e, { at: 'delete', name }));
    return reply.status(204).send();
  });

  // ── GET /object/:bucket/* — the download ──────────────────────────────────
  app.get('/storage/v1/object/:bucket/*', async (req, reply) => {
    const { ctx, caller } = await deps.admit(req);
    const bucket = bucketOrThrow((req.params as Record<string, string>)['bucket'] ?? '');
    const name = pathOrThrow(wildcard(req));

    const row = await deps.asCaller(ctx, caller, async (q) => {
      const cfg = await bucketConfig(q, bucket);
      return ((await q(
        `SELECT size, mime_type, etag FROM storage.objects
          WHERE bucket_id = $1 AND name = $2`, [cfg.id, name])).rows as
        Array<{ size: string; mime_type: string; etag: string }>)[0];
    });
    if (!row) throw new ApiError(404, E.NOT_FOUND, 'No such object.');

    // Conditional request, answered from the metadata row rather than from the
    // store: a cache revalidating an unchanged object should cost one indexed
    // read, not a fetch of bytes that get thrown away.
    const inm = req.headers['if-none-match'];
    if (typeof inm === 'string' && inm.replace(/"/g, '').split(/,\s*/).includes(row.etag)) {
      reply.header('etag', `"${row.etag}"`);
      return reply.status(304).send();
    }

    const range = typeof req.headers['range'] === 'string' ? req.headers['range'] : undefined;
    const fetched = await deps.s3.getObject(objectKey(ctx.ref, bucket, name),
      ...(range ? [{ range }] : []));
    if (fetched.status === 404) {
      // A row with no bytes. D-124 calls this a bug rather than a state to
      // handle gracefully, and it is reported as one — 502, not 404, because the
      // object *should* be there and telling the caller it never existed would
      // hide a platform fault as a client mistake.
      deps.onError?.(new Error('metadata row with no object behind it'),
        { at: 'download', ref: ctx.ref, bucket, name });
      throw new ApiError(502, E.INTERNAL,
        'The stored object behind this row is missing. This has been recorded.');
    }
    if (fetched.status !== 200 && fetched.status !== 206) {
      throw new ApiError(502, E.INTERNAL, 'The object store did not return the object.');
    }

    for (const [k, v] of Object.entries(servingHeaders(row.mime_type))) reply.header(k, v);
    reply.header('content-type', row.mime_type);
    reply.header('etag', `"${row.etag}"`);
    reply.header('accept-ranges', 'bytes');
    if (fetched.headers['content-range']) {
      reply.header('content-range', fetched.headers['content-range']);
    }
    return reply.status(fetched.status).send(fetched.bytes);
  });
}
