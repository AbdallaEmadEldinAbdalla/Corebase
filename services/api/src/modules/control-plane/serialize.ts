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

/**
 * What a project is using (P7e).
 *
 * Every number here is one the control plane already maintains, and the shape is
 * chosen so that nothing on it can be mistaken for something it is not:
 *
 *  - **`memory` is booked, not consumed.** The platform reserves RAM per project
 *    for placement (`ram_booked_mb` against a node's capacity); it does not
 *    measure a container's resident set. Calling this "memory used" would be a
 *    fabricated number on a page whose whole job is real ones, so the field is
 *    named for the reservation it is.
 *  - **`checked_at` travels with everything sampled.** Disk is measured by a
 *    sweep, not on request, so a figure without its timestamp invites the reader
 *    to treat a ten-minute-old sample as live.
 *  - **Nulls are real.** A project that has never been swept has no
 *    `disk_used_bytes`, and a project with no successful backup has no size. The
 *    page says so rather than printing a zero, which would read as "empty".
 *
 * Object-storage bytes are deliberately absent: `storage.usage` lives inside each
 * project's own database, so serving it needs a live connection and a credential
 * this path does not carry — and it would be null exactly when a project is
 * paused, which is when usage is most worth looking at. The sweep that trues that
 * counter up already computes the authoritative figure per project; recording it
 * centrally is the way in, and it is a worker change rather than a route.
 */
export interface ProjectUsageResponse {
  disk: {
    used_bytes: number | null;
    limit_bytes: number;
    /** `ok | warn | critical | read_only` — the ladder, not a percentage. */
    state: string;
    checked_at: string | null;
  };
  /** Reserved for placement. Not a measurement of what the container is using. */
  memory: { limit_bytes: number; booked_bytes: number };
  archiving: {
    /** `unknown | ok | warn | critical`. */
    state: string;
    lag_seconds: number | null;
    pending_segments: number | null;
    last_archived_at: string | null;
    failed_count: number;
  };
  backups: {
    last_success_at: string | null;
    last_success_bytes: number | null;
    successful_runs: number;
    checked_at: string | null;
    check_ok: boolean | null;
  };
  /** Drives the idle pause, so it is the one figure a free project should watch. */
  activity: { last_active_at: string | null };
}

export interface ProjectUsage {
  disk_limit_mb: number | null;
  disk_used_bytes: string | number | null;
  disk_checked_at: Date | null;
  disk_state: string | null;
  ram_limit_mb: number | null;
  ram_booked_mb: number | null;
  archive_state: string | null;
  wal_archive_lag_seconds: number | null;
  wal_archive_pending: number | null;
  wal_last_archived_at: Date | null;
  wal_archive_failed_count: string | number | null;
  backup_checked_at: Date | null;
  backup_check_ok: boolean | null;
  last_active_at: Date | null;
  last_backup_at: Date | null;
  last_backup_bytes: string | number | null;
  successful_backup_runs: string | number | null;
}

/** `bigint` arrives from `pg` as a string, because it does not fit a JS number. */
const num = (v: string | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

const MB = 1024 * 1024;

export function serializeProjectUsage(u: ProjectUsage): ProjectUsageResponse {
  return {
    disk: {
      used_bytes: num(u.disk_used_bytes),
      // Stored in MB, published in bytes: one unit on the wire means the reader
      // never has to know which fields were which, and a mixed-unit response is
      // how a limit ends up rendered a million times too small.
      limit_bytes: (u.disk_limit_mb ?? 0) * MB,
      state: u.disk_state ?? 'unknown',
      checked_at: u.disk_checked_at?.toISOString() ?? null,
    },
    memory: {
      limit_bytes: (u.ram_limit_mb ?? 0) * MB,
      booked_bytes: (u.ram_booked_mb ?? 0) * MB,
    },
    archiving: {
      state: u.archive_state ?? 'unknown',
      lag_seconds: u.wal_archive_lag_seconds,
      pending_segments: u.wal_archive_pending,
      last_archived_at: u.wal_last_archived_at?.toISOString() ?? null,
      failed_count: num(u.wal_archive_failed_count) ?? 0,
    },
    backups: {
      last_success_at: u.last_backup_at?.toISOString() ?? null,
      last_success_bytes: num(u.last_backup_bytes),
      successful_runs: num(u.successful_backup_runs) ?? 0,
      checked_at: u.backup_checked_at?.toISOString() ?? null,
      check_ok: u.backup_check_ok,
    },
    activity: { last_active_at: u.last_active_at?.toISOString() ?? null },
  };
}
