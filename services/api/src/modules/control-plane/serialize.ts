import { encodeId, type Project } from '@steadhold/types';
import type { DatabaseInfo } from './store.ts';

/**
 * The transport shape of a project (platform API §"Create a project", §"List
 * projects").
 *
 * Serialisation lives here rather than in the store because ids are prefixed
 * *in transport only*: the store, the worker and every join deal in bare uuids.
 * One place converts, and it is the boundary.
 */
export interface ProjectResponse {
  id: string;                    // prj_<uuid>
  ref: string;
  name: string;
  org_id: string;                // org_<uuid>
  region: string;
  plan: string;
  environment: string;
  status: string;
  created_at: string;
  /** Only while soft-deleted: when the recovery window closes (D-038, D-205). */
  restorable_until?: string;
  deleted_at?: string;
}

export function serializeProject(p: Project & { organization_id: string }): ProjectResponse {
  return {
    id: encodeId('project', p.id),
    ref: p.ref,
    name: p.name,
    org_id: encodeId('organization', p.organization_id),
    region: p.region,
    plan: p.plan,
    environment: p.environment ?? 'production',
    status: p.status,
    created_at: p.created_at,
    // Named for what a customer needs to know — the deadline — rather than for
    // the job that enforces it. `purge_after` is the column; this is the promise.
    ...(p.purge_after ? { restorable_until: p.purge_after } : {}),
    ...(p.deleted_at ? { deleted_at: p.deleted_at } : {}),
  };
}

/**
 * Where a restored copy came from and when it goes away (P3e).
 *
 * On the detail response rather than only on the create response, because the
 * customer who needs the deadline most is the one coming back to the project two
 * days later — and a deadline they can only see in the reply to a request they
 * already made is a deadline they cannot read.
 */
export interface RestoreInfo {
  source_ref: string;
  /** The point in time asked for; null means "the latest data available". */
  target_time: string | null;
  /** When the copy is soft-deleted. Its data stays recoverable after that. */
  expires_at: string | null;
}

export interface ProjectDetailResponse {
  project: ProjectResponse;
  database?: DatabaseInfo;
  /** Present only for projects that are themselves a restore. */
  restore?: RestoreInfo;
}
