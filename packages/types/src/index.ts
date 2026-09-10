export * from './authz.ts';
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
  'pausing', 'paused', 'resuming',
  /**
   * A restore in progress, and a restored copy waiting to be validated (P3d).
   *
   * `restored` is deliberately not `ready`. A restored instance is a *copy*, and
   * double-serving live traffic against two databases loses data by construction —
   * the customer writes to whichever one their application is pointed at and
   * nothing can reconcile that afterwards. Marking it `ready` would make it
   * indistinguishable from production in every list, badge and API response, which
   * is precisely the confusion that ends with writes going to the wrong copy.
   */
  'restoring', 'restored',
  'deleting', 'soft_deleted', 'deleted',
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
  /** An organization must keep at least one owner (platform API §Roles). */
  LAST_OWNER: 'LAST_OWNER',
  /**
   * The customer's SQL was rejected by their own database (P7l, D-132).
   *
   * Its own code because it is not our failure and must not read as one: the
   * envelope carries the Postgres `sqlstate`, `position`, `detail` and `hint`
   * beside it, which is what the editor underlines the offending token with.
   * Folding it into VALIDATION_FAILED would lose all four and would put a
   * customer's typo in the platform's error-rate alert.
   */
  SQL_ERROR: 'SQL_ERROR',
  /**
   * A session cookie arrived without a matching `x-csrf-token` (P7r).
   *
   * Its own code rather than another `UNAUTHORIZED`, because it is the one 403
   * a *correctly authenticated* client can recover from without the user doing
   * anything: the session is valid, only the token the page holds is missing or
   * stale. The dashboard re-seeds it from `GET /v1/auth/me` and retries once,
   * and it can only tell that case from "your role is insufficient" by the
   * code. Matching on the message string was the alternative, and a message is
   * prose that gets reworded.
   */
  CSRF_REQUIRED: 'CSRF_REQUIRED',
  /**
   * A 404 for something that is not a project or an organization (P7s).
   *
   * Named in the platform API's error table from the start and missing from
   * this list, so every other 404 borrowed `PROJECT_NOT_FOUND` — which read
   * correctly for years because everything 404-able *was* a project. The
   * end-users page broke that: deleting an already-deleted end user answered
   * "PROJECT_NOT_FOUND", which points a client at the wrong resource entirely
   * and would send a developer to check whether their project still exists.
   */
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Error codes for the **data-plane** auth API at `/auth/v1/*` (P4b).
 *
 * Lowercase, unlike every code above, and that is not an inconsistency to tidy
 * up: the control plane's codes are ours to name, while these are matched by
 * client code — a supabase-js app branches on `error.code === 'invalid_credentials'`
 * to decide whether to show "wrong password" or "try again later". Renaming them
 * to fit our house style would mean every ported app's error handling silently
 * falls through to the generic branch, which is the one failure mode a
 * compatibility surface exists to avoid. See D-317.
 *
 * The uniformity within the set matters more than the names: `INVALID_CREDENTIALS`
 * is returned for a wrong password, an unknown email *and* a banned user, because
 * distinguishing them is an enumeration oracle (flows §3).
 */
export const AUTH_ERROR_CODES = {
  VALIDATION_FAILED: 'validation_failed',
  /** Wrong password, no such user, or banned — deliberately indistinguishable. */
  INVALID_CREDENTIALS: 'invalid_credentials',
  /** Only ever returned when the password was *correct*, so it reveals nothing. */
  EMAIL_NOT_CONFIRMED: 'email_not_confirmed',
  WEAK_PASSWORD: 'weak_password',
  OVER_RATE_LIMIT: 'over_rate_limit',
  /** A one-time token that is unknown, spent or expired — one code for all three. */
  INVALID_TOKEN: 'invalid_token',
  /** Any refresh-token failure (D-112). */
  INVALID_GRANT: 'invalid_grant',
  UNAUTHORIZED: 'unauthorized',
  UNAVAILABLE: 'unavailable',
  INTERNAL: 'internal_error',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/**
 * Error codes for the **storage** API at `/storage/v1/*` (P6b).
 *
 * Lowercase for the same reason the auth codes are (D-317): client code branches
 * on them. A storage SDK decides between "ask the user to pick a smaller file"
 * and "tell them the bucket is full" by comparing this string, so these are a
 * compatibility surface rather than ours to restyle.
 *
 * `STORAGE_QUOTA_EXCEEDED` is named in the storage doc as the 413 body, which is
 * why it is distinct from the per-file limit: one means *this file* is too big
 * and a smaller one would work, the other means the *project* is full and no file
 * will work until something is deleted. Collapsing them would leave a client
 * unable to say which.
 */
export const STORAGE_ERROR_CODES = {
  VALIDATION_FAILED: 'validation_failed',
  UNAUTHORIZED: 'unauthorized',
  /** A policy refused it. Distinct from 404: something is there. */
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  /** An object already exists at that path and upsert was not requested. */
  CONFLICT: 'conflict',
  /** Bucket deletion with objects still in it. */
  BUCKET_NOT_EMPTY: 'bucket_not_empty',
  /** This file exceeds the bucket's or the plan's per-file limit. */
  FILE_SIZE_LIMIT_EXCEEDED: 'file_size_limit_exceeded',
  /** The project has no room left, regardless of this file's size. */
  STORAGE_QUOTA_EXCEEDED: 'storage_quota_exceeded',
  /** Declared type is not in the bucket's allowlist, or the bytes contradict it. */
  MIME_TYPE_NOT_ALLOWED: 'mime_type_not_allowed',
  OVER_RATE_LIMIT: 'over_rate_limit',
  UNAVAILABLE: 'service_unavailable',
  INTERNAL: 'internal_error',
} as const;
export type StorageErrorCode =
  (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];

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
