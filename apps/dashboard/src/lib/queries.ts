'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

export function useProjects(orgId: string | undefined) {
  return useQuery({
    queryKey: keys.projects(orgId ?? 'none'),
    queryFn: () => api.projects(orgId as string),
    enabled: Boolean(orgId),
  });
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

export function useProjectKeys(ref: string, enabled = true) {
  return useQuery({
    queryKey: keys.projectKeys(ref),
    queryFn: () => api.projectKeys(ref),
    enabled,
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
