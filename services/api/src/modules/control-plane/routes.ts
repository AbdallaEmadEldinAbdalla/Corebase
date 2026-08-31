import type { FastifyInstance } from 'fastify';
import { CreateProjectRequest, ERROR_CODES } from '@corebase/types';
import { ApiError } from '../../kernel/errors.ts';
import { generateProjectRef } from '../../kernel/ref.ts';
import type { ControlPlaneStore } from './store.ts';

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
}

export function registerControlPlane(app: FastifyInstance, deps: ControlPlaneDeps) {
  const requireAuth = (auth: string | undefined) => {
    if (auth !== `Bearer ${deps.staticToken}`) throw ApiError.unauthorized();
  };

  app.post('/v1/projects', async (req, reply) => {
    requireAuth(req.headers.authorization);

    // Lifecycle mutations require an idempotency key (D-063) — enforced from the
    // first endpoint, not bolted on later.
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8) {
      throw new ApiError(400, ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        'Provide an Idempotency-Key header (min 8 chars) so retries cannot create duplicate projects.');
    }

    // A replay of a seen key returns the original outcome and must short-circuit
    // every later check — otherwise a retried create collides with the project
    // its own first attempt made and returns 409 instead of 200.
    const replay = await deps.store.findByIdempotencyKey(key);
    if (replay) return reply.status(200).send(replay);

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
    return reply.status(replayed ? 200 : 202).send(project);
  });

  app.get('/v1/projects', async (req) => {
    requireAuth(req.headers.authorization);
    return { data: await deps.store.listProjects() };
  });

  app.get('/v1/projects/:ref', async (req) => {
    requireAuth(req.headers.authorization);
    const { ref } = req.params as { ref: string };
    const project = await deps.store.getProject(ref);
    if (!project) throw ApiError.notFound('Project');
    return project;
  });

  app.delete('/v1/projects/:ref', async (req, reply) => {
    requireAuth(req.headers.authorization);
    const { ref } = req.params as { ref: string };
    const project = await deps.store.getProject(ref);
    if (!project) throw ApiError.notFound('Project');
    const next = await deps.store.markStatus(ref, 'deleting');
    return reply.status(202).send(next);
  });
}
