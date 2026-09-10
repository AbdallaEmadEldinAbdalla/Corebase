'use client';

import { useQuery, useInfiniteQuery, useMutation, useQueryClient , keepPreviousData } from '@tanstack/react-query';
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
  tokens: ['tokens'] as const,
  /**
   * The whole schema under one key, because it is fetched and invalidated as one
   * thing — D-134 says any successful DDL invalidates the cache, and a key per
   * catalog list would mean five invalidations that can partially fail.
   */
  introspection: (ref: string) => ['project', ref, 'introspection'] as const,
  /**
   * Keyed by the search *and* the cursor, because both change what came back
   * and a shared key would show one page's rows under another's heading while
   * the fetch is in flight.
   */
  authUsers: (ref: string, q: string, cursor: string) =>
    ['project', ref, 'auth-users', q, cursor] as const,
  /** Every page of the list, for invalidating after a mutation. */
  authUsersAll: (ref: string) => ['project', ref, 'auth-users'] as const,
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
    /**
     * Poll while anything in the list is still settling.
     *
     * `useProject` has done this since D-425 and the *grid* never did, which only
     * became visible with Retry: pressing it puts the project back to `creating`,
     * and without this the badge would sit on CREATING until the user navigated
     * away and back — the same stall ProjectState.tsx already documents for the
     * detail view. Two seconds rather than that view's one: this is a list of many
     * projects and nobody watches a row the way they watch a page.
     */
    refetchInterval: (q) => {
      const rows = q.state.data?.pages.flatMap((page) => page.projects) ?? [];
      return rows.some((r) => SETTLING.has(r.status)) ? 2000 : false;
    },
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

/** Personal access tokens. The list never contains a secret. */
export const useTokens = () => useQuery({ queryKey: keys.tokens, queryFn: api.tokens });

/**
 * Mint a token.
 *
 * The result is deliberately **not** written into the cache: it is the only copy
 * of the secret that will ever exist, and the list must not hold it. The caller
 * keeps it in component state for as long as the page is open, and invalidating
 * the list refetches the safe shape.
 */
export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, expiresInDays }: { name: string; expiresInDays?: number }) =>
      api.createToken(name, expiresInDays),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.tokens }); },
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeToken(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.tokens }); },
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

/**
 * Rename an organization.
 *
 * Invalidates `orgs` and `me`: the shell's switcher and the breadcrumb both read
 * the name from `orgs`, and `me.memberships` carries it too — without both, the
 * page title changes and the chrome around it keeps the old name.
 */
export function useRenameOrg(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.renameOrg(orgId, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.orgs });
      void qc.invalidateQueries({ queryKey: keys.me });
    },
  });
}

/**
 * Delete an organization. A 409 is a real refusal — projects remain — and is left
 * for the caller to relay, because the count in the message is the authority.
 */
export function useDeleteOrg(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteOrg(orgId),
    onSuccess: () => {
      // `clear`, not invalidate: the org this page belonged to is gone, and every
      // cached query keyed by it is now describing something that does not exist.
      qc.clear();
    },
  });
}

/**
 * Try a failed project again.
 *
 * Invalidates both the project and its org's list: a retry moves the status to
 * `creating`, and the grid is where the person who pressed it is usually looking.
 * A 409 is a real refusal — not failed, or failed with no build behind it — and is
 * left for the caller to relay.
 */
export function useRetryProject(ref: string, orgId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryProject(ref),
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

/**
 * A page of the project's end users (P7s).
 *
 * `placeholderData: keepPreviousData` is what makes paging and typing bearable:
 * without it every keystroke and every Next blanks the table to a skeleton, and
 * a list that flashes empty while you type reads as "no results" for a moment
 * on every character. The previous page stays put and `isFetching` carries the
 * fact that a newer one is coming.
 */
export function useAuthUsers(
  ref: string, opts: { q?: string; cursor?: string; enabled?: boolean } = {},
) {
  const q = opts.q ?? '';
  const cursor = opts.cursor ?? '';
  return useQuery({
    queryKey: keys.authUsers(ref, q, cursor),
    queryFn: () => api.authUsers(ref, {
      ...(q ? { q } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 50,
    }),
    enabled: opts.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}

/**
 * Ban, unban, confirm, or sign out — one mutation, because the endpoint is one
 * PATCH and splitting it into four hooks would mean four cache invalidations
 * that can partially fail.
 */
export function useUpdateAuthUser(ref: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      id: string;
      change: { ban_until?: string | null; email_confirm?: boolean; sign_out?: boolean };
    }) => api.updateAuthUser(ref, v.id, v.change),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.authUsersAll(ref) }); },
  });
}

export function useDeleteAuthUser(ref: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteAuthUser(ref, id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.authUsersAll(ref) }); },
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

/**
 * The project's schema.
 *
 * `refetchOnWindowFocus` and a 60s interval are D-134's answer to DDL run
 * *outside* the dashboard — psql, `db push` — which the client cannot be told
 * about. Push-invalidation via an event trigger is OQ-133 and is not decided, so
 * the honest version is polling that says how stale it can be rather than a cache
 * that pretends to be live.
 *
 * DDL run *inside* the dashboard invalidates this key directly; that is the fast
 * path and it is what `useRunSql` does below.
 */
export function useIntrospection(ref: string) {
  return useQuery({
    queryKey: keys.introspection(ref),
    queryFn: () => api.introspect(ref),
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
    // The server sets `cache-control: private, max-age=10`; matching it here
    // stops several mounting panels from each firing a request.
    staleTime: 10_000,
  });
}

/**
 * Run SQL, and invalidate the schema when the statement changed it.
 *
 * "Changed it" is decided from the server's own `command` per statement rather
 * than by re-classifying the SQL in the browser: the server is the one that knows
 * what ran, including any statement it rewrote. A `SELECT` leaves the cache
 * alone, which is what makes the grid's own reads cheap.
 */
export function useRunSql(ref: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.runSql>[1]) => api.runSql(ref, body),
    onSuccess: (data) => {
      const ddl = data.results.some((r) => DDL_COMMANDS.has(r.command));
      if (ddl) void qc.invalidateQueries({ queryKey: keys.introspection(ref) });
    },
  });
}

/**
 * Leading keywords that change the schema.
 *
 * A list rather than "anything that is not SELECT", because the difference
 * matters in the cheap direction: an `INSERT` does not change the schema and
 * re-reading the whole catalog after every row edit would make the grid feel
 * slower the more it is used. Over-invalidating is only a performance bug, so
 * anything uncertain belongs *in* this set.
 */
const DDL_COMMANDS = new Set([
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'COMMENT', 'GRANT', 'REVOKE',
  'RENAME', 'REINDEX', 'CLUSTER', 'REFRESH', 'IMPORT', 'SECURITY',
]);
