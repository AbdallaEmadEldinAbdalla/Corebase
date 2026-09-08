'use client';

import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Role } from '@steadhold/types';
import { api, type Org } from './api.ts';
import { SETTLING } from '../components/ProjectState.tsx';

/**
 * Query keys mirror API resources, exactly as the IA specifies, so an
 * invalidation reads like the thing it invalidates and nobody has to guess which
 * string a page used.
 */
export const keys = {
  me: ['me'] as const,
  orgs: ['orgs'] as const,
  projects: (orgId: string) => ['org', orgId, 'projects'] as const,
  project: (ref: string) => ['project', ref] as const,
  projectKeys: (ref: string) => ['project', ref, 'keys'] as const,
  projectUsage: (ref: string) => ['project', ref, 'usage'] as const,
  members: (orgId: string) => ['org', orgId, 'members'] as const,
  invites: (orgId: string) => ['org', orgId, 'invites'] as const,
};

export const useMe = () => useQuery({ queryKey: keys.me, queryFn: api.me });

export const useOrgs = () => useQuery({ queryKey: keys.orgs, queryFn: api.orgs });

/** The org whose `slug` is in the URL. Resolving slug → id is the switcher's job. */
export function useOrgBySlug(slug: string) {
  const query = useOrgs();
  const org: Org | undefined = query.data?.orgs.find((o) => o.slug === slug);
  return { ...query, org };
}

/**
 * An organization's projects, paginated.
 *
 * Infinite rather than a single page because the API's default limit is 20 and the
 * first version of the list ignored `pagination.next_cursor` entirely — so an
 * organization with 25 projects saw 20 of them under a footer reading "Showing 20
 * of 20". That is the exact failure the UX standard forbids: a list that shows part
 * of the data must say how much and offer the rest (§4), and silent truncation reads
 * as "you have seen everything".
 *
 * Callers that only need names — the breadcrumb switcher, the command palette — read
 * `projects` and get whatever pages are loaded, which is the first page until
 * someone asks for more. That is the right answer for a switcher.
 */
export function useProjects(orgId: string | undefined) {
  const query = useInfiniteQuery({
    queryKey: keys.projects(orgId ?? 'none'),
    queryFn: ({ pageParam }) => api.projects(orgId as string, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.pagination?.next_cursor ?? undefined,
    enabled: Boolean(orgId),
  });
  const projects = query.data?.pages.flatMap((p) => p.projects) ?? [];
  return { ...query, projects };
}

/**
 * A project, polled while it is still settling.
 *
 * Polling rather than SSE (D-220): provisioning takes about 2.5 seconds
 * measured, and a stream needs an endpoint that holds a connection plus a
 * reconnect story to answer a question two GETs answer. `refetchInterval`
 * returns false once the state is terminal, so a ready project costs nothing.
 *
 * The set of settling states comes from ProjectState.tsx, which derives it from
 * the enum in @steadhold/types. A second hand-written copy here is how the first
 * version missed `creating` and stopped polling a project that had just been
 * created.
 */
export function useProject(ref: string) {
  return useQuery({
    queryKey: keys.project(ref),
    queryFn: () => api.project(ref),
    refetchInterval: (query) => {
      const status = query.state.data?.project.status;
      return status && SETTLING.has(status) ? 1000 : false;
    },
  });
}

/**
 * A project's connection strings, fetched only when a page actually shows them.
 *
 * `staleTime: Infinity` and no refetch-on-focus: the API records a reveal, so
 * re-fetching because a window regained focus would write audit rows for nothing.
 * The credentials do not change on their own — a rotation invalidates this key.
 */
export function useProjectCredentials(ref: string, enabled = true) {
  return useQuery({
    queryKey: [...keys.project(ref), 'credentials'] as const,
    queryFn: () => api.projectCredentials(ref),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useProjectKeys(ref: string, enabled = true) {
  return useQuery({
    queryKey: keys.projectKeys(ref),
    queryFn: () => api.projectKeys(ref),
    enabled,
  });
}

/**
 * Project usage.
 *
 * A minute's `staleTime` and no polling: the numbers behind it come from sweeps
 * that run every few minutes, so a one-second refetch — which is what `useProject`
 * does while a project settles — would be traffic in exchange for the same answer.
 * The page prints when each figure was measured, so a slightly stale read is
 * visible rather than misleading.
 *
 * `retry: false` for the 409. A project with no database yet is a real answer, not
 * a transport failure, and retrying it three times only delays the message.
 */
export function useProjectUsage(ref: string, enabled = true) {
  return useQuery({
    queryKey: keys.projectUsage(ref),
    queryFn: () => api.projectUsage(ref),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, slug }: { name: string; slug: string }) => api.createOrg(name, slug),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.orgs }); },
  });
}

/**
 * Rotate a project's credentials.
 *
 * On success the cached credentials are *removed* rather than refetched. Refetching
 * would reveal them again — a recorded act — for a page the user may not be looking
 * at; removing means the next render of Connect asks, which is a reveal the user
 * actually caused.
 */
export function useRotateCredentials(ref: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (terminate: boolean) => api.rotateCredentials(ref, terminate),
    onSuccess: () => {
      qc.removeQueries({ queryKey: [...keys.project(ref), 'credentials'] });
      void qc.invalidateQueries({ queryKey: keys.project(ref) });
    },
  });
}

/**
 * Resume a paused project (D-131).
 *
 * Invalidating the project **and** its org's list is deliberate: the projects
 * grid carries a Resume button of its own, so a resume started from the grid has
 * to move the badge there, and one started by opening the project has to move the
 * badge on the grid the user goes back to.
 *
 * A 409 is not an error here — `api.resumeProject` reports it as
 * `enqueued: false`, because "already ready" and "already resuming" are the
 * expected answers to a call fired on navigation. The project's polled status
 * stays the single source of truth for what the UI shows.
 */
export function useResumeProject(ref: string, orgId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.resumeProject(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.project(ref) });
      if (orgId) void qc.invalidateQueries({ queryKey: keys.projects(orgId) });
    },
  });
}

/** Pause a project by hand. Unlike resume, a 409 here is a real refusal. */
export function usePauseProject(ref: string, orgId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.pauseProject(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.project(ref) });
      if (orgId) void qc.invalidateQueries({ queryKey: keys.projects(orgId) });
    },
  });
}

/**
 * Delete a project.
 *
 * Invalidates the org's project list as well as the project itself, because the
 * grid hides soft-deleted projects — without it the caller navigates back to a
 * list still showing the thing they just deleted.
 */
export function useDeleteProject(ref: string, orgId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteProject(ref),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.project(ref) });
      if (orgId) void qc.invalidateQueries({ queryKey: keys.projects(orgId) });
    },
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.acceptInvite(token),
    onSuccess: () => {
      // Both, and in this order matters only in that both are needed: `orgs`
      // gains the organization, and `me` gains the membership that decides every
      // affordance in the shell (D-428).
      void qc.invalidateQueries({ queryKey: keys.orgs });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useMembers(orgId: string | undefined) {
  return useQuery({
    queryKey: keys.members(orgId ?? 'none'),
    queryFn: () => api.members(orgId!),
    enabled: Boolean(orgId),
  });
}

export function useInvites(orgId: string | undefined) {
  return useQuery({
    queryKey: keys.invites(orgId ?? 'none'),
    queryFn: () => api.invites(orgId!),
    enabled: Boolean(orgId),
  });
}

export function useSetMemberRole(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { userId: string; role: Role }) =>
      api.setMemberRole(orgId, v.userId, v.role),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.members(orgId) });
      // A role change can be the *current* user demoting themselves, which
      // changes what the whole shell may offer — so the identity that drives
      // every affordance has to be refetched too, not just the row that moved.
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useRemoveMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.removeMember(orgId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.members(orgId) });
      void qc.invalidateQueries({ queryKey: keys.orgs });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

export function useInvite(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; role: Role }) => api.invite(orgId, v.email, v.role),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.invites(orgId) }); },
  });
}

export function useRevokeInvite(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.revokeInvite(orgId, inviteId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.invites(orgId) }); },
  });
}

export function useCreateProject(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; region?: string; idempotencyKey: string }) =>
      api.createProject(
        { org_id: orgId, name: input.name, ...(input.region ? { region: input.region } : {}) },
        input.idempotencyKey,
      ),
    onSuccess: (result) => {
      // Seed the detail cache from the 202 body so the progress page renders the
      // project immediately instead of flashing a spinner for one poll interval.
      qc.setQueryData(keys.project(result.project.ref), { project: result.project });
      void qc.invalidateQueries({ queryKey: keys.projects(orgId) });
      // The org list carries project_count, which the switcher renders. Without
      // this the header says "1 project" next to a page showing two — a small
      // wrongness in the most persistent piece of chrome in the app.
      void qc.invalidateQueries({ queryKey: keys.orgs });
    },
  });
}
