import type { FastifyInstance } from 'fastify';
import { CreateProjectRequest, ERROR_CODES, decodeId, encodeId, InvalidIdError } from '@corebase/types';
import { parsePageRequest, toPage } from '../../kernel/pagination.ts';
import { serializeProject } from './serialize.ts';
import { DELIVERY_ID_PATTERN } from '@corebase/queue';
import { ApiError } from '../../kernel/errors.ts';
import { generateProjectRef } from '../../kernel/ref.ts';
import type { ControlPlaneStore } from './store.ts';
import type { Actor } from '@corebase/audit';

/**
 * Phase two of the two-phase enqueue (D-067). Phase one — the job row — is
 * already committed by the store, so this is best-effort by design: if Redis is
 * down the row stays 'pending' and the worker's sweeper picks it up. The
 * request must NOT fail for it, because the project genuinely was accepted.
 */
export type Enqueue = (job: {
  job_row_id: string; idempotency_key: string; job_type: string; project_id: string | null;
}) => Promise<void>;

export interface ControlPlaneDeps {
  store: ControlPlaneStore;
  /** Optional: without it the sweeper is the only delivery path (slower, still correct). */
  enqueue?: Enqueue;
  onEnqueueError?: (err: Error) => void;
  /** M0: one static token (T4). Real dual-mode auth is D-062. */
  staticToken: string;
  /**
   * The user every static-token mutation is attributed to, until P1c brings real
   * sessions. Absent means mutations are recorded as `system` rather than as a
   * fabricated user.
   */
  actorUserId?: string | null;
}

export function registerControlPlane(app: FastifyInstance, deps: ControlPlaneDeps) {
  const requireAuth = (auth: string | undefined) => {
    if (auth !== `Bearer ${deps.staticToken}`) throw ApiError.unauthorized();
  };

  /**
   * Who to record as the actor.
   *
   * The static bearer token is Milestone 0's stand-in for a session, so every
   * mutation is attributed to the bootstrap user (P1c replaces this with the
   * session's real user). `actorUserId` is resolved once at startup rather than
   * per request; when it is absent the actor is `system`, which is honest — an
   * unattributed mutation should read as unattributed, not as somebody.
   */
  const actorFor = (req: { headers: Record<string, unknown>; ip?: string }, requestId: string): Actor =>
    deps.actorUserId
      ? { type: 'user', userId: deps.actorUserId, ip: req.ip ?? null, requestId }
      : { type: 'system', userId: null, ip: req.ip ?? null, requestId };

  app.post('/v1/projects', async (req, reply) => {
    requireAuth(req.headers.authorization);

    // Lifecycle mutations require an idempotency key (D-063) — enforced from the
    // first endpoint, not bolted on later.
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      throw new ApiError(400, ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        'Provide an Idempotency-Key header (min 8 chars) so retries cannot create duplicate projects.');
    }
    // The key becomes the job's delivery id (D-067), and the queue rejects some
    // characters — notably ':'. Refusing it here turns an accepted-but-silently-
    // undelivered project into a clear 400, and stops one client's creative key
    // from breaking orphan recovery for every project on the fleet.
    if (!DELIVERY_ID_PATTERN.test(key)) {
      throw new ApiError(400, ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        'Idempotency-Key must be 8-255 characters of [A-Za-z0-9_.=#@-] — it is used ' +
        'as the job delivery id, which cannot contain ":".');
    }

    // A replay of a seen key returns the original outcome and must short-circuit
    // every later check — otherwise a retried create collides with the project
    // its own first attempt made and returns 409 instead of 200.
    const replay = await deps.store.findByIdempotencyKey(key);
    if (replay) {
      return reply
        .status(200)
        .header('location', `/v1/projects/${replay.ref}`)
        .send({ project: serializeProject(replay) });
    }

    const parsed = CreateProjectRequest.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.validation(parsed.error.issues.map((i) => i.message).join('; '));
    }

    const existing = await deps.store.findByName(parsed.data.name);
    if (existing) {
      throw new ApiError(409, ERROR_CODES.PROJECT_NAME_TAKEN,
        `A project named "${parsed.data.name}" already exists.`);
    }

    const { project, job, replayed } = await deps.store.createProject({
      ref: generateProjectRef(),
      name: parsed.data.name,
      region: parsed.data.region,
      plan: parsed.data.plan,
      idempotencyKey: key,
      requestId: String(reply.getHeader('x-request-id') ?? req.id),
      actor: actorFor(req as never, String(reply.getHeader('x-request-id') ?? req.id)),
    });

    if (deps.enqueue) {
      try {
        await deps.enqueue({
          job_row_id: job.id,
          idempotency_key: job.idempotency_key,
          job_type: job.kind,
          project_id: project.id,
        });
      } catch (err) {
        // Intentionally swallowed: the row of record exists and the sweeper will
        // deliver it. Failing the request here would tell the caller their
        // project was rejected when it was not.
        req.log.warn({ err, project: project.ref }, 'enqueue failed; sweeper will recover');
        deps.onEnqueueError?.(err as Error);
      }
    }
    // 202 with a Location header, per the platform-API contract: the API has
    // accepted the intent, and the resource it points at is not ready yet.
    return reply
      .status(replayed ? 200 : 202)
      .header('location', `/v1/projects/${project.ref}`)
      .send({
        project: serializeProject(project),
        job: { id: encodeId('job', job.id), type: job.kind, state: job.state },
      });
  });

  app.get('/v1/projects', async (req) => {
    requireAuth(req.headers.authorization);
    const query = (req.query ?? {}) as Record<string, unknown>;
    const page = parsePageRequest(query);

    let organizationId: string | undefined;
    if (typeof query['org_id'] === 'string' && query['org_id']) {
      try {
        organizationId = decodeId('organization', query['org_id']);
      } catch (err) {
        if (!(err instanceof InvalidIdError)) throw err;
        throw ApiError.validation(err.message);
      }
    }

    const rows = await deps.store.listProjectsPage({
      limit: page.limit,
      ...(page.cursor ? { cursor: page.cursor } : {}),
      ...(organizationId ? { organizationId } : {}),
    });
    const { items, pagination } = toPage(rows, page.limit,
      (p) => ({ created_at: p.created_at, id: p.id }));
    return { projects: items.map(serializeProject), pagination };
  });

  app.get('/v1/projects/:ref', async (req) => {
    requireAuth(req.headers.authorization);
    const { ref } = req.params as { ref: string };
    // { project, database } per the platform-API contract: the database block
    // appears once provisioning has written connection details, and carries the
    // connection strings only while the API can decrypt the credential.
    const detail = await deps.store.getProjectDetail(ref);
    if (!detail) throw ApiError.notFound('Project');
    return {
      project: serializeProject(detail.project),
      ...(detail.database ? { database: detail.database } : {}),
    };
  });

  app.delete('/v1/projects/:ref', async (req, reply) => {
    requireAuth(req.headers.authorization);
    const { ref } = req.params as { ref: string };

    // No Idempotency-Key required here, unlike create: the job's key is derived
    // from the project, so a retried DELETE cannot produce a second teardown.
    const result = await deps.store.requestDelete(
      ref, actorFor(req as never, String(reply.getHeader('x-request-id') ?? req.id)));
    if (!result) throw ApiError.notFound('Project');
    const { project, job, alreadyRequested } = result;

    if (!alreadyRequested && deps.enqueue) {
      try {
        await deps.enqueue({
          job_row_id: job.id,
          idempotency_key: job.idempotency_key,
          job_type: job.kind,
          project_id: project.id,
        });
      } catch (err) {
        // Same reasoning as create: the row of record exists and the sweeper
        // will deliver it. Telling the caller their delete failed when the
        // project is already marked deleting would be a lie.
        req.log.warn({ err, project: project.ref }, 'enqueue failed; sweeper will recover');
        deps.onEnqueueError?.(err as Error);
      }
    }
    return reply.status(202).send({
      project: serializeProject(project),
      job: { id: encodeId('job', job.id), type: job.kind, state: job.state },
    });
  });
}
