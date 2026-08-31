export * from './ids.ts';
import { z } from 'zod';

/** Project lifecycle states (D-053 state machine; see docs/02-control-plane/03). */
/**
 * Lowercase on the wire, matching the platform-API contract
 * (docs/02-control-plane/02-platform-api.md) AND the project_status Postgres
 * enum — so no casing translation layer exists to drift. Display casing
 * (a READY badge) is the UI's business.
 */
export const ProjectStatus = z.enum([
  'creating', 'provisioning', 'configuring', 'ready', 'failed',
  'pausing', 'paused', 'resuming', 'deleting', 'soft_deleted', 'deleted',
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
  /** Bare uuid at rest; the API prefixes it on the way out (see ids.ts). */
  organization_id: z.string().uuid(),
  region: z.string(),
  plan: z.string(),
  environment: z.string().default('production'),
  status: ProjectStatus,
  created_at: z.string(),
  /**
   * Present only while a project is soft-deleted. Without them the recovery
   * window (D-038) is a promise the customer cannot see the end of — and a
   * deadline you cannot read is not a deadline you can act on.
   */
  deleted_at: z.string().nullish(),
  purge_after: z.string().nullish(),
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
  /** The recovery window closed and the project's data is gone (D-038). */
  PROJECT_PURGED: 'PROJECT_PURGED',
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
/**
 * The purge is its own job, not a mode on delete_project (D-196): the two phases
 * are a week apart and must not share one row's checkpoint set, attempt budget
 * or idempotency key.
 */
export const PurgeProjectJob = z.object({
  kind: z.literal('purge_project'),
  project_id: z.string().uuid(),
  idempotency_key: z.string(),
});
export const JobPayload = z.discriminatedUnion('kind',
  [ProvisionProjectJob, DeleteProjectJob, PurgeProjectJob]);
export type JobPayload = z.infer<typeof JobPayload>;
