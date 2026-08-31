import { z } from 'zod';

/** Project lifecycle states (D-053 state machine; see docs/02-control-plane/03). */
export const ProjectStatus = z.enum([
  'CREATING', 'PROVISIONING', 'CONFIGURING', 'READY',
  'FAILED', 'PAUSING', 'PAUSED', 'RESUMING', 'DELETING', 'DELETED',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * Project ref: immutable, never reused, 20-char lowercase base32, first char
 * alphabetic so it is always a valid DNS label (D-056).
 */
export const ProjectRef = z.string().regex(/^[a-z][a-z2-7]{19}$/, 'invalid project ref');
export type ProjectRef = z.infer<typeof ProjectRef>;

export const CreateProjectRequest = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
    'lowercase letters, numbers and dashes only'),
  region: z.literal('eu-central').default('eu-central'), // single region in V1 (D-024)
  plan: z.enum(['free', 'pro', 'team']).default('free'),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const Project = z.object({
  id: z.string().uuid(),
  ref: ProjectRef,
  name: z.string(),
  region: z.string(),
  plan: z.string(),
  status: ProjectStatus,
  created_at: z.string(),
});
export type Project = z.infer<typeof Project>;

/** Uniform error envelope on every response, both planes (D-032). */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  PROJECT_NAME_TAKEN: 'PROJECT_NAME_TAKEN',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  CAPACITY_UNAVAILABLE: 'CAPACITY_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Job payloads consumed by services/worker (two-phase enqueue, D-067). */
export const ProvisionProjectJob = z.object({
  kind: z.literal('provision_project'),
  project_id: z.string().uuid(),
  idempotency_key: z.string(),
});
export const DeleteProjectJob = z.object({
  kind: z.literal('delete_project'),
  project_id: z.string().uuid(),
  idempotency_key: z.string(),
});
export const JobPayload = z.discriminatedUnion('kind', [ProvisionProjectJob, DeleteProjectJob]);
export type JobPayload = z.infer<typeof JobPayload>;
