import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CreateProjectRequest, ERROR_CODES, decodeId, encodeId, InvalidIdError } from '@corebase/types';
import { parsePageRequest, toPage } from '../../kernel/pagination.ts';
import { serializeProject } from './serialize.ts';
import { DELIVERY_ID_PATTERN } from '@corebase/queue';
import { ApiError } from '../../kernel/errors.ts';
import { generateProjectRef } from '../../kernel/ref.ts';
import type { ControlPlaneStore } from './store.ts';
import type { Actor } from '@corebase/audit';
import { resolvePrincipal, actorOf, type PrincipalDeps } from '../../kernel/principal.ts';
import { require_, type Role } from '../../kernel/permissions.ts';
import type { OrgStore } from '../orgs/store.ts';

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
  /**
   * Org membership, for scoping projects to the caller's organizations (P1d).
   * Absent keeps Milestone 0's behaviour — one implicit org, no permission
   * checks — which is what the memory store and the unit tests use.
   */
  orgs?: OrgStore;
  principals?: PrincipalDeps;
}

export function registerControlPlane(app: FastifyInstance, deps: ControlPlaneDeps) {
  /**
   * Authenticate the request.
   *
   * When principals are configured this is the full dual-mode resolution — a
   * session cookie, a PAT, or the static token — because a project endpoint that
   * only understands the static token is one a logged-in user cannot call. That
   * was the bug: the org-scoped routes resolved membership from a cookie the
   * *first* check had already rejected.
   */
  const requireAuth = async (req: FastifyRequest) => {
    if (deps.principals) {
      await resolvePrincipal(req, deps.principals);
      return;
    }
    if (req.headers.authorization !== `Bearer ${deps.staticToken}`) throw ApiError.unauthorized();
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
  /**
   * The org this request acts in, and the caller's role in it.
   *
   * Returns undefined when org scoping is not configured, which is Milestone 0's
   * single-implicit-org behaviour and what the unit tests exercise. When it *is*
   * configured, a caller with no membership gets 404 rather than 403 — "you lack
   * permission on org X" confirms org X exists.
   */
  async function scope(req: FastifyRequest, orgIdRaw?: unknown): Promise<
    { orgId: string; role: Role; userId: string } | undefined
  > {
    if (!deps.orgs || !deps.principals) return undefined;
    const principal = await resolvePrincipal(req, deps.principals);
    if (!principal.userId) {
      throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
        'This endpoint acts within an organization and the static token is not a user.');
    }
    let orgId: string | undefined;
    if (typeof orgIdRaw === 'string' && orgIdRaw) {
      try { orgId = decodeId('organization', orgIdRaw); }
      catch (err) {
        if (!(err instanceof InvalidIdError)) throw err;
        throw ApiError.validation(err.message);
      }
    } else {
      // No org named: the caller's only org, or an error rather than a guess.
      // Picking one silently is how a project lands in the wrong organization.
      const orgs = await deps.orgs.listForUser(principal.userId);
      if (orgs.length === 0) {
        throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
          'You do not belong to an organization yet. Create one with POST /v1/orgs.');
      }
      if (orgs.length > 1) {
        throw ApiError.validation(
          'You belong to more than one organization; name it with org_id.');
      }
      orgId = orgs[0]!.id;
    }
    const role = await deps.orgs.roleOf(principal.userId, orgId);
    if (!role) {
      throw new ApiError(404, ERROR_CODES.PROJECT_NOT_FOUND,
        'No such organization, or you are not a member of it.');
    }
    return { orgId, role, userId: principal.userId };
  }

  const actorFor = (req: { headers: Record<string, unknown>; ip?: string }, requestId: string): Actor =>
    deps.actorUserId
      ? { type: 'user', userId: deps.actorUserId, ip: req.ip ?? null, requestId }
      : { type: 'system', userId: null, ip: req.ip ?? null, requestId };

  app.post('/v1/projects', async (req, reply) => {
    await requireAuth(req);

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

    // A member may create a project (platform API §Roles); anyone with no
    // membership at all cannot, which is why a fresh account must join an org
    // first rather than silently creating in someone else's.
    const scoped = await scope(req, (req.body as { org_id?: unknown } | undefined)?.org_id);
    if (scoped) require_(scoped.role, 'project.create');

    // Scoped to the caller's org: a name another tenant took is not the caller's
    // problem, and telling them it is taken would disclose it.
    const existing = await deps.store.findByName(parsed.data.name, scoped?.orgId);
    if (existing) {
      throw new ApiError(409, ERROR_CODES.PROJECT_NAME_TAKEN,
        `A project named "${parsed.data.name}" already exists in this organization.`);
    }

    const { project, job, replayed } = await deps.store.createProject({
      ref: generateProjectRef(),
      name: parsed.data.name,
      region: parsed.data.region,
      plan: parsed.data.plan,
      idempotencyKey: key,
      requestId: String(reply.getHeader('x-request-id') ?? req.id),
      ...(scoped ? { organizationId: scoped.orgId } : {}),
      actor: scoped
        ? { type: 'user' as const, userId: scoped.userId, ip: req.ip ?? null,
            requestId: String(reply.getHeader('x-request-id') ?? req.id) }
        : actorFor(req as never, String(reply.getHeader('x-request-id') ?? req.id)),
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
    await requireAuth(req);
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

    // Scoped to the caller's own organizations. Without this the list is every
    // project on the platform, which is the one bug in this file that would be a
    // cross-tenant disclosure rather than an inconvenience.
    if (deps.orgs && deps.principals) {
      const scoped = await scope(req, organizationId ? encodeId('organization', organizationId) : undefined);
      if (scoped) {
        require_(scoped.role, 'project.read');
        organizationId = scoped.orgId;
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
    await requireAuth(req);
    const { ref } = req.params as { ref: string };
    // { project, database } per the platform-API contract: the database block
    // appears once provisioning has written connection details, and carries the
    // connection strings only while the API can decrypt the credential.
    const detail = await deps.store.getProjectDetail(ref);
    if (!detail) throw ApiError.notFound('Project');
    if (deps.orgs && deps.principals) {
      // A ref is guessable in principle; membership is what makes it private.
      const scoped = await scope(req, encodeId('organization', detail.project.organization_id));
      if (scoped) require_(scoped.role, 'project.read');
    }
    return {
      project: serializeProject(detail.project),
      ...(detail.database ? { database: detail.database } : {}),
    };
  });

  app.delete('/v1/projects/:ref', async (req, reply) => {
    await requireAuth(req);
    const { ref } = req.params as { ref: string };

    // No Idempotency-Key required here, unlike create: the job's key is derived
    // from the project, so a retried DELETE cannot produce a second teardown.
    // Deleting is not a member's business (platform API §Roles lists their
    // mutations as create/pause/resume). Checked against the project's own org,
    // not the caller's default one.
    let actor: Actor = actorFor(req as never, String(reply.getHeader('x-request-id') ?? req.id));
    if (deps.orgs && deps.principals) {
      const project = await deps.store.getProject(ref);
      if (!project) throw ApiError.notFound('Project');
      const scoped = await scope(req, encodeId('organization', project.organization_id));
      if (scoped) {
        require_(scoped.role, 'project.delete');
        actor = { type: 'user', userId: scoped.userId, ip: req.ip ?? null,
                  requestId: String(reply.getHeader('x-request-id') ?? req.id) };
      }
    }

    const result = await deps.store.requestDelete(ref, actor);
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
