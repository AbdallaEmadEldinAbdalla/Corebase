import { encodeId, type Project } from '@corebase/types';
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

export interface ProjectDetailResponse {
  project: ProjectResponse;
  database?: DatabaseInfo;
}
