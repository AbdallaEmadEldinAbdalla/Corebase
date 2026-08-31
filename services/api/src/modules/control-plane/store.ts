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
  }): Promise<{ project: Project; job: JobRow; replayed: boolean }>;
  /** Replay lookup: a seen key must return the original outcome (D-063). */
  findByIdempotencyKey(key: string): Promise<Project | undefined>;
  getProject(ref: string): Promise<Project | undefined>;
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
  findByName(name: string): Promise<Project | undefined>;
  jobs(): Promise<JobRow[]>;
}

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
    async findByName(name) { return [...projects.values()].find((p) => p.name === name); },
    async jobs() { return [...jobs]; },
  };
}
