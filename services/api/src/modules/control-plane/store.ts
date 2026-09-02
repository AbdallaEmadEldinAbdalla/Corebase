import type { Project, ProjectStatus, JobPayload } from '@corebase/types';
import type { Actor } from '@corebase/audit';

/**
 * What a ready project exposes to its owner (platform-api contract). Assembled
 * from the placement row plus the decrypted developer credential — the plaintext
 * exists in the control plane only to render these strings (credentials §2).
 */
export interface DatabaseInfo {
  host: string;
  port: number;
  pooler_port: number;
  pg_version: string;
  connection_strings?: { direct: string; pooled: string };
}

export interface ProjectDetail {
  project: Project;
  database?: DatabaseInfo;
}

export interface JobRow {
  id: string;
  kind: JobPayload['kind'];
  project_id: string;
  idempotency_key: string;
  state: 'queued' | 'running' | 'done' | 'failed';
}

/**
 * M0 store. Deliberately an interface with an in-memory implementation so T4
 * (API) is testable before T3 (Postgres) lands; the Postgres implementation
 * replaces it without touching the module's callers.
 *
 * The contract that matters and must survive: createProject writes the project
 * row and its job row in ONE atomic step (two-phase enqueue, D-067) — Redis is
 * never the source of truth for job existence.
 */
export interface ControlPlaneStore {
  createProject(input: {
    ref: string; name: string; region: string; plan: string; idempotencyKey: string;
    /**
     * The request that asked for this project. Stored in the job payload so the
     * worker's log lines can carry it — one field joins the API request to every
     * saga step it caused, which is what makes "why is project X stuck" a single
     * Loki query (D-147: request_id lives in the line, never in a label).
     */
    requestId?: string;
    /**
     * Who asked. Passed into the store rather than audited by the route,
     * because the audit row is written inside the same transaction as the
     * mutation — a mutation that can succeed without its audit row produces the
     * history you cannot trust.
     */
    actor?: Actor;
    /** Which organization the project belongs to; defaults to the M0 bootstrap. */
    organizationId?: string;
  }): Promise<{ project: Project; job: JobRow; replayed: boolean }>;
  /** Replay lookup: a seen key must return the original outcome (D-063). */
  findByIdempotencyKey(key: string): Promise<Project | undefined>;
  getProject(ref: string): Promise<Project | undefined>;
  /**
   * One page of projects, newest first, keyset-paginated (D-039). Fetches
   * `limit + 1` so the caller can answer `has_more` from rows rather than from a
   * second, racing count query.
   */
  listProjectsPage(args: {
    limit: number;
    cursor?: { created_at: string; id: string };
    organizationId?: string;
  }): Promise<Project[]>;
  /**
   * The project plus its connection details. Separate from getProject because
   * building it decrypts a credential, and most callers have no business doing
   * that.
   */
  getProjectDetail(ref: string): Promise<ProjectDetail | undefined>;
  listProjects(): Promise<Project[]>;
  markStatus(ref: string, status: ProjectStatus): Promise<Project | undefined>;
  /**
   * Move a project to `deleting` and write its deletion job in ONE transaction,
   * for the same reason createProject does (D-067): a project marked deleting
   * with no job never gets torn down, and its resources bill forever.
   *
   * The job's idempotency key is derived from the project, so two DELETEs
   * collapse onto one job by construction rather than by the caller remembering
   * to send a key.
   */
  requestDelete(ref: string, actor?: Actor): Promise<
    { project: Project; job: JobRow; alreadyRequested: boolean } | undefined>;
  /**
   * Request a credential rotation (P2d, credentials doc §4a).
   *
   * Same three outcomes as `requestLifecycle`, and separate from it because a
   * rotation carries a payload — `terminate` — that a state transition does not.
   */
  requestRotation?(
    ref: string,
    opts: { terminate?: boolean },
    actor?: Actor,
  ): Promise<
    | { project: Project; job: JobRow; alreadyRequested: boolean }
    | { project: Project; conflict: string }
    | undefined>;
  /**
   * Live projects in an organization, for the per-org ceiling.
   *
   * Counts everything that still holds resources on a node, including
   * soft-deleted projects: they keep a volume, a port and a disk reservation for
   * the recovery window, so they are as real to the node as running ones.
   */
  countProjectsInOrg?(organizationId: string): Promise<number>;
  /**
   * Pause or resume (P2c, D-008).
   *
   * Three outcomes rather than two, because "this project is in the wrong state"
   * is not the same answer as "no such project": `undefined` is not found, a
   * `conflict` carries the state that refused, and otherwise the job is returned.
   * Collapsing the middle case into a 404 would tell a caller their project does
   * not exist when it is merely already paused.
   */
  /**
   * Start a restore of `ref` to `targetTime`, as a **new** project (P3d).
   *
   * Returns the new project, never the source: production is never overwritten,
   * so the thing the caller then polls is a different project with a different
   * ref. A method that returned the source would be describing the wrong object.
   */
  requestRestore?(args: {
    ref: string;
    /** Absent means "latest" — everything the repo holds. */
    targetTime?: Date | undefined;
    newRef: string;
    actor?: Actor;
    projectsPerOrgLimit?: number;
  }): Promise<
    | undefined
    | { conflict: string; project: Project }
    | { refused: string }
    | { project: Project; job: JobRow; source: Project }
  >;

  requestLifecycle?(ref: string, kind: 'pause' | 'resume', actor?: Actor): Promise<
    | { project: Project; job: JobRow; alreadyRequested: boolean }
    | { project: Project; conflict: string }
    | undefined>;
  /**
   * A project with this name in this organization, if any.
   *
   * Org-scoped, not global. Before P1d there was one implicit org so the
   * distinction was invisible; with real organizations a global check means one
   * tenant taking "api" denies it to every other tenant forever — and the 409
   * tells them a stranger has it, which is a small cross-tenant disclosure. The
   * globally unique identifier is the `ref`; the name is a label its owners chose.
   */
  findByName(name: string, organizationId?: string): Promise<Project | undefined>;
  jobs(): Promise<JobRow[]>;
  /** The project's live API keys — hashes stay behind; prefixes are for display. */
  listApiKeys?(projectId: string): Promise<Array<{
    id: string; kind: 'anon' | 'service_role'; key_prefix: string; created_at: string;
  }>>;
}

/** One implicit organization, for the store that has no database behind it. */
const MEMORY_ORG_ID = '00000000-0000-4000-8000-000000000001';

export function createMemoryStore(): ControlPlaneStore {
  const projects = new Map<string, Project>();          // ref -> project
  const jobs: JobRow[] = [];
  const byIdempotency = new Map<string, string>();      // key -> ref

  return {
    async createProject({ ref, name, region, plan, idempotencyKey }) {
      // Replay of a seen key returns the original result, never a second project
      // (D-063: 24h replay window).
      const seen = byIdempotency.get(idempotencyKey);
      if (seen) {
        const project = projects.get(seen)!;
        const job = jobs.find((j) => j.project_id === project.id)!;
        return { project, job, replayed: true };
      }
      const project: Project = {
        id: crypto.randomUUID(),
        ref, name, region, plan,
        // The memory store has one implicit org, same as the pg store's M0
        // bootstrap; a stable value keeps the transport shape honest.
        organization_id: MEMORY_ORG_ID,
        environment: 'production',
        status: 'creating',
        created_at: new Date().toISOString(),
      };
      const job: JobRow = {
        id: crypto.randomUUID(),
        kind: 'provision_project',
        project_id: project.id,
        idempotency_key: idempotencyKey,
        state: 'queued',
      };
      projects.set(ref, project);
      jobs.push(job);
      byIdempotency.set(idempotencyKey, ref);
      return { project, job, replayed: false };
    },
    async findByIdempotencyKey(key) {
      const ref = byIdempotency.get(key);
      return ref ? projects.get(ref) : undefined;
    },
    async getProject(ref) { return projects.get(ref); },
    async getProjectDetail(ref) {
      // The memory store has no data plane, so there are never connection
      // details — the shape is still the real one.
      const project = projects.get(ref);
      return project ? { project } : undefined;
    },
    async listProjects() { return [...projects.values()]; },
    async listProjectsPage({ limit, cursor, organizationId }) {
      const sorted = [...projects.values()]
        .filter((p) => p.status !== 'deleted')
        .filter((p) => !organizationId || p.organization_id === organizationId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.id < b.id ? 1 : -1)));
      const after = cursor
        ? sorted.filter((p) => p.created_at < cursor.created_at
            || (p.created_at === cursor.created_at && p.id < cursor.id))
        : sorted;
      return after.slice(0, limit + 1);
    },
    async requestDelete(ref, _actor) {
      const project = projects.get(ref);
      if (!project) return undefined;
      const key = `delete_${project.id}`;
      const existing = jobs.find((j) => j.idempotency_key === key);
      if (existing) return { project, job: existing, alreadyRequested: true };
      const next = { ...project, status: 'deleting' as ProjectStatus };
      projects.set(ref, next);
      const job: JobRow = {
        id: crypto.randomUUID(), kind: 'delete_project',
        project_id: project.id, idempotency_key: key, state: 'queued',
      };
      jobs.push(job);
      return { project: next, job, alreadyRequested: false };
    },

    async markStatus(ref, status) {
      const p = projects.get(ref);
      if (!p) return undefined;
      const next = { ...p, status };
      projects.set(ref, next);
      return next;
    },
    async findByName(name, organizationId) {
      return [...projects.values()].find((p) => p.name === name
        && (!organizationId || p.organization_id === organizationId));
    },
    async jobs() { return [...jobs]; },
  };
}
