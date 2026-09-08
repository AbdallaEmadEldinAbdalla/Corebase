/**
 * The only way the dashboard talks to anything (D-130).
 *
 * Four things this module owns, because each of them is a bug if it is written
 * per-call-site instead:
 *
 * 1. **The error envelope.** Every failure from the platform API is
 *    `{error: {code, message, request_id}}` (D-032). It becomes an `ApiError`
 *    carrying all three, so every error surface can show a code, a sentence, and
 *    a request id with a copy button — which the design system requires and which
 *    is impossible if a caller only gets a string.
 * 2. **CSRF.** The session is a cookie, so the token has to be echoed in
 *    `x-csrf-token` on every mutating call. Forgetting it on one call is a 403
 *    the user cannot act on, so callers do not get to remember.
 * 3. **401.** An expired session means "go and log in again, then come back
 *    here" — never a stack of failed panels.
 * 4. **Credentials.** `credentials: 'include'` on every request, because the
 *    dashboard and the API are different origins and the cookie is the auth.
 */

/**
 * Read at runtime from the browser rather than baked in at build time, so one
 * build can serve staging and production. `window.__STEADHOLD__` is set by a
 * small inline script in the root layout from the server's own environment.
 */
declare global {
  interface Window { __STEADHOLD__?: { apiBase?: string } }
}

export function apiBase(): string {
  if (typeof window !== 'undefined' && window.__STEADHOLD__?.apiBase) {
    return window.__STEADHOLD__.apiBase.replace(/\/+$/, '');
  }
  // Server-render fallback. Nothing data-driven renders on the server (D-130),
  // so this is only ever used by code that also runs in the browser.
  return (process.env.NEXT_PUBLIC_STEADHOLD_API ?? 'http://localhost:8099').replace(/\/+$/, '');
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  /** True when the fix is "log in again", which the client handles centrally. */
  get isUnauthenticated(): boolean { return this.status === 401; }
}

/**
 * The CSRF token lives in `sessionStorage`, not a cookie and not a module
 * variable. Not a cookie, because a cookie readable by script defeats the point
 * of a double-submit token. Not a module variable, because a full page reload —
 * which the create flow does on redirect — would lose it and every subsequent
 * mutation would 403.
 */
const CSRF_STORAGE_KEY = 'sh.csrf';

export function setCsrfToken(token: string): void {
  try { window.sessionStorage.setItem(CSRF_STORAGE_KEY, token); } catch { /* private mode */ }
}
export function csrfToken(): string | null {
  try { return window.sessionStorage.getItem(CSRF_STORAGE_KEY); } catch { return null; }
}
export function clearCsrfToken(): void {
  try { window.sessionStorage.removeItem(CSRF_STORAGE_KEY); } catch { /* private mode */ }
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Create-project retries (D-055): the same key must mean the same create. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * Where an unauthenticated response sends the browser. Set once by the app shell
 * rather than imported, so this module does not depend on the router — and so a
 * test can call `request` without one.
 */
let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: () => void): void { onUnauthenticated = fn; }

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (MUTATING.has(method)) {
    const csrf = csrfToken();
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      // The cookie is the auth, and the API is another origin.
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    // A network failure has no envelope and no request id. Say so plainly rather
    // than rendering "undefined" into an error card.
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_UNREACHABLE',
      'Could not reach the Steadhold API. Check that it is running and that this origin is allowed.',
      null);
  }

  // The header is the request id that survives a body we could not parse, which
  // is exactly the case where support needs it.
  const requestId = res.headers.get('x-request-id');

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }

  if (!res.ok) {
    const envelope = (parsed as { error?: { code?: string; message?: string; request_id?: string } } | null)?.error;
    const err = new ApiError(
      res.status,
      envelope?.code ?? 'UNKNOWN',
      envelope?.message ?? `The API returned ${res.status} with no error envelope.`,
      envelope?.request_id ?? requestId,
    );
    if (err.isUnauthenticated) {
      // The session is gone, so the token that went with it is meaningless.
      clearCsrfToken();
      onUnauthenticated?.();
    }
    throw err;
  }

  return parsed as T;
}

// ── the endpoints the shell uses ────────────────────────────────────────────
// Typed against the platform API's *actual* responses — checked against
// services/api/src/modules/*/routes.ts, not guessed. Defensive unions were the
// first draft here and they were wrong: a union hides a contract mismatch behind
// a runtime check instead of failing the typecheck, which is the whole reason to
// have one place that knows the shapes.

export interface MeResponse {
  user: { id: string; email: string; display_name: string | null; email_verified: boolean } | null;
  memberships: { org_id: string; name: string; slug: string; role: Role }[];
  principal: string;
}

export type Role = 'owner' | 'admin' | 'member';

export interface Org {
  id: string;              // org_<uuid>
  name: string;
  slug: string;
  created_at: string;
  role: Role;
  member_count: number;
  project_count: number;
}

/** `serializeProject` in services/api/src/modules/control-plane/serialize.ts. */
export interface Project {
  id: string;              // prj_<uuid>
  ref: string;
  name: string;
  org_id: string;          // org_<uuid>
  region: string;
  plan: string;
  environment: string;
  status: string;
  created_at: string;
  /** Only while soft-deleted: when the recovery window closes (D-038, D-205). */
  restorable_until?: string;
  deleted_at?: string;
}

/** `DatabaseInfo` in services/api/src/modules/control-plane/store.ts. */
/**
 * Where a restored copy came from and when it goes away (P3e).
 *
 * `expires_at` is the whole reason this is on the detail response: the customer who
 * needs the deadline is the one coming back two days later, not the one who just
 * pressed the button.
 */
export interface RestoreInfo {
  source_ref: string;
  target_time: string | null;
  expires_at: string | null;
}

export interface DatabaseInfo {
  host: string;
  port: number;
  pooler_port: number;
  pg_version: string;
  connection_strings?: { direct: string; pooled: string };
}

export interface ApiKey {
  kind: 'anon' | 'service_role';
  prefix: string;
  created_at: string;
  /** anon is always present; service_role only under `?reveal=true` + key.manage. */
  key?: string;
}

export interface Pagination { next_cursor?: string | null; has_more?: boolean }

/** The project states the shell renders. Anything else falls through to neutral. */
export const PROJECT_STATES = [
  'provisioning', 'ready', 'paused', 'resuming', 'restoring', 'failed', 'deleting', 'deleted',
] as const;

export const api = {
  me: () => request<MeResponse>('/v1/auth/me'),

  login: (email: string, password: string) =>
    request<{ user: NonNullable<MeResponse['user']>; csrf_token: string }>(
      '/v1/auth/login', { method: 'POST', body: { email, password } }),

  signup: (email: string, password: string, displayName?: string) =>
    request<{ user: NonNullable<MeResponse['user']>; csrf_token: string }>(
      '/v1/auth/signup', { method: 'POST',
        body: { email, password, ...(displayName ? { display_name: displayName } : {}) } }),

  logout: () => request<void>('/v1/auth/logout', { method: 'POST' }),

  orgs: () => request<{ orgs: Org[] }>('/v1/orgs'),

  createOrg: (name: string, slug: string) =>
    request<{ org: Org }>('/v1/orgs', { method: 'POST', body: { name, slug } }),

  projects: (orgId: string, cursor?: string) =>
    request<{ projects: Project[]; pagination: Pagination }>(
      `/v1/projects?org_id=${encodeURIComponent(orgId)}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')),

  /**
   * Status and details, without credentials. Safe to poll — and it must be, since
   * the overview polls it while a project settles.
   */
  project: (ref: string) =>
    request<{ project: Project; database?: DatabaseInfo; restore?: RestoreInfo }>(
      `/v1/projects/${encodeURIComponent(ref)}`),

  /**
   * The same thing *with* connection strings. A separate call because taking
   * credentials is a deliberate act that the API records — polling this would
   * write an audit row an hour forever and teach nobody anything.
   */
  projectCredentials: (ref: string) =>
    request<{ project: Project; database?: DatabaseInfo }>(
      `/v1/projects/${encodeURIComponent(ref)}?reveal=true`),

  /**
   * Replace the project's database credentials (P2d).
   *
   * `terminate` ends established sessions. Off by default because Postgres
   * authenticates at connect time only, so a rotation is invisible to a running
   * application — which is what makes it safe to do routinely.
   */
  rotateCredentials: (ref: string, terminate = false) =>
    request<{ project: Project; job: { id: string; type: string; state: string }; effect: string }>(
      `/v1/projects/${encodeURIComponent(ref)}/rotate-credentials`,
      { method: 'POST', body: { terminate } }),

  /**
   * Pause a project (D-008). Only a `ready` project can be paused, so a 409 here
   * is a real refusal and is left to the caller.
   */
  pauseProject: (ref: string) =>
    request<{ project: Project; job: { id: string; type: string; state: string } }>(
      `/v1/projects/${encodeURIComponent(ref)}/pause`, { method: 'POST' }),

  /**
   * Resume a project. A 409 is reported, not thrown.
   *
   * D-131 makes opening a paused project the intent to resume, so this is fired
   * on navigation *before* the caller knows the state — which makes "already
   * ready" and "already resuming" the expected answers rather than failures. The
   * control plane answers both with 409 and the current state (routes.ts calls it
   * "the honest answer for an idempotent-looking call that is actually a no-op").
   *
   * A 409 means exactly one thing: **no job was enqueued.** Whether that is fine
   * is not this function's question — it is answered by the project's own status,
   * which the caller is already polling. Deciding here would mean matching on the
   * message prose, and a refusal that matters (`failed`, `deleting`) is visible in
   * the status anyway, where the banner reads it. So the state is returned and the
   * caller keeps its single source of truth.
   */
  resumeProject: async (ref: string): Promise<{ enqueued: boolean; conflict?: string }> => {
    try {
      await request<{ project: Project }>(
        `/v1/projects/${encodeURIComponent(ref)}/resume`, { method: 'POST' });
      return { enqueued: true };
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        return { enqueued: false, conflict: err.message };
      }
      throw err;
    }
  },

  projectKeys: (ref: string) =>
    request<{ api_keys: ApiKey[] }>(`/v1/projects/${encodeURIComponent(ref)}/keys`),

  createProject: (
    input: { org_id: string; name: string; region?: string },
    idempotencyKey: string,
  ) =>
    // 202 with the project already addressable at its ref — the create flow polls
    // it rather than holding a connection open. See D-220.
    request<{ project: Project; job: { id: string; type: string; state: string } }>(
      '/v1/projects', { method: 'POST', body: input, idempotencyKey }),
};
