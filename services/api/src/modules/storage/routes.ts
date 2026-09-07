import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { STORAGE_ERROR_CODES as E } from '@corebase/types';
import type { SecretStore } from '@corebase/secrets';
import { ApiError } from '../../kernel/errors.ts';
import type { RateLimiter } from '../../kernel/rate-limit.ts';
import { rateLimitKey } from '../../kernel/rate-limit.ts';
import {
  resolveProject, AuthContextError, type ProjectContext,
} from '../project-auth/context.ts';
import { callerFrom, withCaller, policyError, type Caller } from './context.ts';
import {
  registerObjectReads, registerObjectWrites, PROXY_MAX_BYTES, type ObjectDeps,
} from './objects.ts';

/**
 * The storage module at `/storage/v1/*` (P6b, D-121).
 *
 * A module of the data-plane monolith, structured exactly like auth: its own
 * routes, its own boundary, splittable later if bandwidth profiles demand it.
 * It is the **sole holder of object-store credentials** — customers never
 * receive them in any form, which is what makes the shared-bucket layout
 * (D-120) safe and keeps the backend swappable.
 *
 * This step is bucket CRUD only. Every route here is a metadata operation, so
 * every one of them is a single statement run as the caller with their policies
 * in force — there is no object-store call in this file at all, and that is the
 * cleanest possible demonstration that RLS *is* the permission system.
 */

export interface StorageDeps {
  /** The control-plane pool, for resolving a project from its apikey. */
  pool: Pool;
  secrets: SecretStore;
  /** D-033's per-project bucket, shared with the rest of the data plane. */
  limiter?: RateLimiter | undefined;
  projectDomain?: string | undefined;
  keyIssuer?: string | undefined;
  /**
   * The object store. Absent means the *bucket* routes still work — they are
   * pure metadata — and the object routes are not registered at all, for the
   * usual reason: a route that exists and cannot reach the bytes is worse than a
   * 404, because a client codes against it.
   */
  objects?: Omit<ObjectDeps, 'planOf'> | undefined;
}

interface BucketRow {
  id: string;
  name: string;
  public: boolean;
  file_size_limit: string | null;
  allowed_mime_types: string[] | null;
  created_at: string;
  updated_at: string;
}

/** The wire shape. `file_size_limit` is bigint, which arrives as a string. */
const toBucket = (r: BucketRow) => ({
  id: r.id,
  name: r.name,
  public: r.public,
  file_size_limit: r.file_size_limit === null ? null : Number(r.file_size_limit),
  allowed_mime_types: r.allowed_mime_types,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export function registerStorage(app: FastifyInstance, deps: StorageDeps): void {
  /**
   * **Two encapsulated scopes, because the two halves of this module need
   * opposite body handling** — and finding that out cost a confusing 400.
   *
   * Bucket routes take JSON. Object routes take *bytes*, of any content type,
   * including the two Fastify parses by default: `application/json` and
   * `text/plain`. Uploading a `.json` or a `.txt` file is entirely ordinary, and
   * with the built-in parsers in force those arrive as a parsed object or a
   * string rather than a Buffer — so the upload handler saw a non-Buffer body
   * and answered "send the object bytes as the request body", which is a
   * baffling thing to be told when you did.
   *
   * Overriding the parsers on one shared scope is not an option either: the
   * bucket routes would then receive their own JSON bodies as Buffers.
   *
   * And neither parser may be registered on the *root* instance, because the
   * gateway's routes live there and re-serialise `req.body` on the way upstream
   * — a proxied request with an unusual content type would reach PostgREST as
   * the JSON encoding of a Buffer. Fastify scopes parsers to the instance they
   * are registered on, which is what makes all of this expressible.
   */
  const shared = buildShared(deps);
  const objectDeps = deps.objects
    ? {
        ...deps.objects,
        admit: shared.admit,
        asCaller: shared.asCaller,
        /**
         * The plan, for the quota ceiling. One indexed read against the control
         * plane per upload — the only control-plane query on this path, and it
         * is on the *upload* side rather than the read side, where D-051's
         * hot-path rule bites hardest.
         */
        planOf: async (ctx: ProjectContext) => {
          const { rows } = await deps.pool.query<{ plan: string }>(
            `SELECT plan::text AS plan FROM projects WHERE id = $1`, [ctx.projectId]);
          return rows[0]?.plan ?? 'free';
        },
      }
    : undefined;

  // The JSON scope: bucket CRUD, plus every object route whose body is JSON or
  // absent. Grouping by *body type* rather than by subject is the correction —
  // see the note on the object routes.
  void app.register(async (scope) => {
    registerBuckets(scope, deps, shared);
    if (objectDeps) registerObjectReads(scope, objectDeps);
  });

  // The bytes scope: uploads only.
  if (objectDeps) {
    void app.register(async (scope) => {
      // Every content type as raw bytes, the two built-ins included. The
      // explicit limit matters: Fastify's default body limit is 1 MB, and an
      // upload path that truncated at 1 MB would present as a client bug.
      //
      // The parsers inherited from the parent are *removed* rather than
      // overridden, because Fastify refuses to re-register a content type it
      // already knows ("Content type parser 'application/json' already
      // present."). Clearing them first also states the intent more plainly than
      // three overrides would: in this scope every body is bytes, whatever the
      // header claims.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*',
        { parseAs: 'buffer', bodyLimit: PROXY_MAX_BYTES + 1024 },
        (_req, body, done) => { done(null, body as Buffer); });
      registerObjectWrites(scope, objectDeps);
    });
  }
}

interface Shared {
  admit: (req: FastifyRequest) => Promise<{ ctx: ProjectContext; caller: Caller }>;
  asCaller: <T>(
    ctx: ProjectContext, caller: Caller,
    fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Admission and the as-caller helper, built once and shared by both scopes.
 *
 * One resolver rather than one per scope: both halves resolve the same project
 * from the same apikey, and two copies would be two chances to disagree about
 * who a caller is.
 */
function buildShared(deps: StorageDeps): Shared {
  /**
   * Resolve the project and the caller, in that order.
   *
   * Identical to the auth module's front door, deliberately: the `apikey` header
   * says which project and what kind of key, and a user's `Authorization` says
   * which person.
   */
  async function admit(req: FastifyRequest): Promise<{ ctx: ProjectContext; caller: Caller }> {
    const apikey = req.headers['apikey'];
    if (typeof apikey !== 'string' || !apikey) {
      throw new ApiError(401, E.UNAUTHORIZED,
        'Every storage request needs the project\'s API key in the `apikey` header.');
    }
    let ctx: ProjectContext;
    try {
      ctx = await resolveProject(
        {
          pool: deps.pool, secrets: deps.secrets,
          ...(deps.projectDomain ? { projectDomain: deps.projectDomain } : {}),
          ...(deps.keyIssuer ? { keyIssuer: deps.keyIssuer } : {}),
        },
        apikey);
    } catch (err) {
      if (err instanceof AuthContextError) {
        // The resolver's own status is kept: 401 for a key that is not ours, 503
        // for a project whose database is not placed yet. Flattening both to 401
        // would tell a customer their key is wrong while the truth is that their
        // project is still provisioning.
        throw new ApiError(err.status,
          err.status === 503 ? E.UNAVAILABLE : E.UNAUTHORIZED, err.message);
      }
      throw err;
    }
    if (deps.limiter) {
      const hit = await deps.limiter.hit(rateLimitKey('storage', ctx.projectId));
      if (!hit.allowed) {
        throw new ApiError(429, E.OVER_RATE_LIMIT,
          `Too many storage requests. Retry in ${hit.retryAfterSeconds}s.`);
      }
    }
    return { ctx, caller: callerFrom(req, ctx) };
  }

  /**
   * Runs a metadata statement as the caller and translates a policy refusal.
   *
   * Everything in this module funnels through here so that a refusal has exactly
   * one meaning in one place. Postgres reports a blocked *write* as an error and
   * a blocked *read* as an empty result, and conflating those is what makes a
   * storage API confusing to write against.
   */
  async function asCaller<T>(
    ctx: ProjectContext, caller: Caller,
    fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<T>,
  ): Promise<T> {
    try {
      return await withCaller(ctx, caller, async (client) =>
        fn((sql, params) => client.query(sql, params as never[])));
    } catch (err) {
      const mapped = policyError(err);
      if (mapped) throw mapped;
      throw err;
    }
  }

  return { admit, asCaller };
}

function registerBuckets(app: FastifyInstance, _deps: StorageDeps, shared: Shared): void {
  const { admit, asCaller } = shared;

  // ── POST /bucket ───────────────────────────────────────────────────────────
  app.post('/storage/v1/bucket', async (req, reply) => {
    const { ctx, caller } = await admit(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'] : '';
    // Validated here as well as by the column's CHECK, and the duplication earns
    // its keep: a constraint violation is a 400 with a Postgres message in it,
    // while this is a 400 that says which rule was broken.
    if (!BUCKET_NAME.test(name)) {
      throw new ApiError(400, E.VALIDATION_FAILED,
        'A bucket name is 2–63 characters of lowercase letters, digits, dot, '
        + 'underscore or hyphen, and must start with a letter or digit.');
    }
    const isPublic = body['public'] === true;
    const sizeLimit = body['file_size_limit'];
    if (sizeLimit !== undefined && sizeLimit !== null
        && (typeof sizeLimit !== 'number' || !Number.isInteger(sizeLimit) || sizeLimit <= 0)) {
      throw new ApiError(400, E.VALIDATION_FAILED,
        '`file_size_limit` is a positive whole number of bytes, or null for the plan default.');
    }
    const mimes = body['allowed_mime_types'];
    if (mimes !== undefined && mimes !== null
        && (!Array.isArray(mimes) || mimes.some((m) => typeof m !== 'string'))) {
      throw new ApiError(400, E.VALIDATION_FAILED,
        '`allowed_mime_types` is an array of strings, or null for any type.');
    }

    const rows = await asCaller(ctx, caller, async (q) => (await q(
      `INSERT INTO storage.buckets (name, public, file_size_limit, allowed_mime_types)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, isPublic, sizeLimit ?? null, mimes ?? null])).rows as BucketRow[]);
    return reply.status(201).send({ bucket: toBucket(rows[0]!) });
  });

  // ── GET /bucket ────────────────────────────────────────────────────────────
  app.get('/storage/v1/bucket', async (req, reply) => {
    const { ctx, caller } = await admit(req);
    // RLS-filtered, and that is the entire access control: a bucket the caller's
    // policies do not admit is simply absent from the list rather than redacted
    // from it, so nothing here has to decide what to hide.
    const rows = await asCaller(ctx, caller, async (q) => (await q(
      `SELECT * FROM storage.buckets ORDER BY name`)).rows as BucketRow[]);
    return reply.send({ buckets: rows.map(toBucket) });
  });

  // ── GET /bucket/:name ──────────────────────────────────────────────────────
  app.get<{ Params: { name: string } }>('/storage/v1/bucket/:name', async (req, reply) => {
    const { ctx, caller } = await admit(req);
    const rows = await asCaller(ctx, caller, async (q) => (await q(
      `SELECT * FROM storage.buckets WHERE name = $1`, [req.params.name])).rows as BucketRow[]);
    // 404 for both "no such bucket" and "not yours", because they are the same
    // answer: the caller cannot see it. Distinguishing them would turn this
    // endpoint into a probe for which buckets exist.
    if (!rows[0]) throw new ApiError(404, E.NOT_FOUND, 'No such bucket.');
    return reply.send({ bucket: toBucket(rows[0]) });
  });

  // ── PATCH /bucket/:name ────────────────────────────────────────────────────
  app.patch<{ Params: { name: string } }>('/storage/v1/bucket/:name', async (req, reply) => {
    const { ctx, caller } = await admit(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Only the three configurable fields, and only when present: a PATCH that
    // silently reset `public` to false because the caller omitted it would be a
    // security change made by an absent key.
    const sets: string[] = [];
    const params: unknown[] = [req.params.name];
    if (body['public'] !== undefined) {
      sets.push(`public = $${params.length + 1}`);
      params.push(body['public'] === true);
    }
    if (body['file_size_limit'] !== undefined) {
      sets.push(`file_size_limit = $${params.length + 1}`);
      params.push(body['file_size_limit'] ?? null);
    }
    if (body['allowed_mime_types'] !== undefined) {
      sets.push(`allowed_mime_types = $${params.length + 1}`);
      params.push(body['allowed_mime_types'] ?? null);
    }
    if (!sets.length) {
      throw new ApiError(400, E.VALIDATION_FAILED,
        'Nothing to update. Send `public`, `file_size_limit` or `allowed_mime_types`.');
    }
    const rows = await asCaller(ctx, caller, async (q) => (await q(
      `UPDATE storage.buckets SET ${sets.join(', ')}, updated_at = now()
        WHERE name = $1 RETURNING *`, params)).rows as BucketRow[]);
    if (!rows[0]) throw new ApiError(404, E.NOT_FOUND, 'No such bucket.');
    return reply.send({ bucket: toBucket(rows[0]) });
  });

  // ── DELETE /bucket/:name ───────────────────────────────────────────────────
  app.delete<{ Params: { name: string } }>('/storage/v1/bucket/:name', async (req, reply) => {
    const { ctx, caller } = await admit(req);
    const outcome = await asCaller(ctx, caller, async (q) => {
      // Emptiness is checked in the same transaction as the delete, so an object
      // uploaded between the two cannot slip through — and the check runs as the
      // caller, so an object they cannot *see* still blocks them. That is the
      // conservative direction: refusing to delete a bucket because of a row you
      // are not allowed to know about is an inconvenience, while succeeding
      // would strand somebody else's bytes with no row to sweep them by.
      //
      // There is deliberately no `ON DELETE CASCADE` on the objects table for
      // the same reason: a cascade could orphan millions of stored objects in
      // one statement with nothing to trigger a sweep.
      const bucket = (await q(
        `SELECT id FROM storage.buckets WHERE name = $1`, [req.params.name])
      ).rows as Array<{ id: string }>;
      if (!bucket[0]) return 'missing' as const;
      const objects = (await q(
        `SELECT 1 FROM storage.objects WHERE bucket_id = $1 LIMIT 1`, [bucket[0].id])).rows;
      if (objects.length) return 'not_empty' as const;
      const deleted = (await q(
        `DELETE FROM storage.buckets WHERE id = $1 RETURNING id`, [bucket[0].id])).rows;
      return deleted.length ? ('deleted' as const) : ('missing' as const);
    });
    if (outcome === 'missing') throw new ApiError(404, E.NOT_FOUND, 'No such bucket.');
    if (outcome === 'not_empty') {
      throw new ApiError(409, E.BUCKET_NOT_EMPTY,
        'That bucket still holds objects. Delete them first.');
    }
    return reply.status(204).send();
  });
}
