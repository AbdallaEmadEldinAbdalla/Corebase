'use client';

import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
 * the enum in @corebase/types. A second hand-written copy here is how the first
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
