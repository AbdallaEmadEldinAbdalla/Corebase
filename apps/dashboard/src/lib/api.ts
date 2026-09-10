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

/**
 * A Postgres error's own detail, when the failure came from a customer database.
 *
 * `position` is why this type exists. It is a 1-based character offset into the
 * statement that was sent, which is what lets an editor put the cursor on the
 * offending token — the difference between "syntax error at or near \"form\""
 * and the caret sitting on the typo. A syntax error without it is a sentence the
 * user has to re-find by eye.
 *
 * The API deliberately narrows what it forwards (no `where`, no `internalQuery`,
 * which can carry the body of a platform trigger the customer did not write), so
 * these four fields are the whole of it.
 */
export interface PgErrorDetail {
  sqlstate: string;
  position: number | null;
  detail: string | null;
  hint: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  /**
   * Everything the envelope carried beyond `code`, `message` and `request_id`.
   *
   * This used to be dropped on the floor. `services/api/.../db/routes.ts` has a
   * `pgDetail()` function with a comment explaining that `position` "is the field
   * that matters and the reason this is not just `err.message`" — and the client
   * parsed three keys and discarded the rest, so every one of those fields was
   * computed, serialised, and thrown away. Found by reading both halves while
   * planning the surface that needed them.
   */
  readonly details: Record<string, unknown>;

  constructor(
    status: number, code: string, message: string, requestId: string | null,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }

  /** True when the fix is "log in again", which the client handles centrally. */
  get isUnauthenticated(): boolean { return this.status === 401; }

  /**
   * The Postgres detail, or null when this error did not come from a database.
   *
   * Checked rather than cast: a 429 from the rate limiter and a 503 from an
   * unreachable project both arrive as `ApiError` with no `pg` at all, and an
   * editor that assumed otherwise would render an empty "SQLSTATE:" label.
   */
  get pg(): PgErrorDetail | null {
    const pg = this.details['pg'];
    if (!pg || typeof pg !== 'object') return null;
    const d = pg as Record<string, unknown>;
    if (typeof d['sqlstate'] !== 'string') return null;
    return {
      sqlstate: d['sqlstate'],
      position: typeof d['position'] === 'number' ? d['position'] : null,
      detail: typeof d['detail'] === 'string' ? d['detail'] : null,
      hint: typeof d['hint'] === 'string' ? d['hint'] : null,
    };
  }
}

/**
 * The CSRF token lives in `sessionStorage`, not a cookie and not a module
 * variable.
 *
 * **Not a cookie**, because the API is a different origin: a cookie it sets is
 * unreadable by this script, so there is nothing to echo. (The earlier comment
 * here said a script-readable cookie "defeats the point of a double-submit
 * token", which is the wrong reason — same-origin readability is exactly how
 * double-submit works. The real obstacle is the origin split, and getting the
 * reason wrong is what kept the true fix out of sight. See D-473.)
 *
 * **Not a module variable**, because a full page reload — which the create flow
 * does on redirect — would lose it and every subsequent mutation would 403.
 *
 * `sessionStorage` is nonetheless per *tab* while the session cookie is per
 * *origin*, so a tab that did not itself log in has the session and not the
 * token. `ensureCsrf` below is what closes that gap.
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

/**
 * The token for this tab, obtaining one from the server if the tab has none.
 *
 * A new tab, a pasted URL, a duplicated tab and a restored window all arrive
 * with the session cookie — cookies are shared across an origin — and with an
 * empty `sessionStorage`. Every `GET` then works and every mutation 403s, which
 * in the table editor means the page renders and reads nothing, because D-132
 * runs even a read as `POST /db/query`. `GET /v1/auth/me` re-issues the token
 * for the session the cookie already proves (D-473).
 *
 * Single-flight: a page that fires several mutations at once must ask once, not
 * once per call. The promise is cleared in `finally` so a failed attempt does
 * not poison the next one, and the token is returned rather than only stored so
 * a caller cannot read `sessionStorage` back before the write lands.
 */
let seeding: Promise<string | null> | null = null;

export function resetCsrfSeeding(): void { seeding = null; }

/**
 * The mutations that *create* the session, and so cannot be asked to prove one.
 *
 * Without this list, `ensureCsrf` fired on `POST /v1/auth/login` itself: a
 * browser with no session would call `GET /v1/auth/me`, get a 401, and the 401
 * handling would clear the token and redirect to `/login` — from inside the
 * login request, which never left. Logging in would have been impossible, and
 * only on a *fresh* browser, which is the one state a signed-in developer never
 * tests. Found by reading the call sites of the thing I had just changed rather
 * than by running it.
 *
 * `logout` is deliberately absent: it ends a session, so it has one, and the
 * server requires the header on it like any other mutation.
 */
const NO_SESSION_YET = new Set(['/v1/auth/login', '/v1/auth/signup']);

/**
 * The token for this tab, obtaining one from the server if the tab has none.
 *
 * Never throws. A failure here must not become the caller's error: if there is
 * genuinely no session then the real request 401s a moment later and the
 * central handler does the right thing with it, whereas a 401 raised from a
 * *probe* would report the wrong URL and pre-empt the caller's own error
 * handling.
 */
async function ensureCsrf(path: string): Promise<string | null> {
  const held = csrfToken();
  if (held) return held;
  if (NO_SESSION_YET.has(path)) return null;
  seeding ??= (async () => {
    try {
      // Not `api.me()`: this module's endpoint wrappers are defined below, and a
      // GET needs no token, so there is no recursion here.
      const me = await attempt<MeResponse>('/v1/auth/me');
      if (me.csrf_token) { setCsrfToken(me.csrf_token); return me.csrf_token; }
      return null;
    } catch {
      return null;
    } finally {
      seeding = null;
    }
  })();
  return seeding;
}

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

/**
 * One request, and the retry that makes a stale CSRF token recoverable.
 *
 * `ensureCsrf` covers the tab that has *no* token. The other half is the tab
 * whose token is *wrong*: log out and back in elsewhere and this tab's stored
 * token belongs to a session that no longer exists, and no amount of reloading
 * would fix it because `sessionStorage` survives a reload. `CSRF_REQUIRED` is
 * the server's word for "the session is fine, the token is not", so it is the
 * one 403 worth retrying — and retrying is safe because the check runs before
 * any handler does, so the rejected call had no effect.
 *
 * Exactly one retry, and only for that code. A loop here would turn a
 * server-side mistake into a request storm.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await attempt<T>(path, options);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'CSRF_REQUIRED') throw err;
    clearCsrfToken();
    resetCsrfSeeding();
    return attempt<T>(path, options);
  }
}

async function attempt<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (MUTATING.has(method)) {
    const csrf = await ensureCsrf(path);
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
    const envelope = (parsed as
      { error?: Record<string, unknown> & {
          code?: string; message?: string; request_id?: string } } | null)?.error;
    // Whatever else the envelope carried. The API spreads `details` into `error`
    // (see `kernel/errors.ts`), so the extra keys sit beside the three known
    // ones rather than under a `details` object — and picking them up by
    // subtraction means a new detail key reaches the client without a change
    // here.
    const { code: _c, message: _m, request_id: _r, ...details } = envelope ?? {};
    const err = new ApiError(
      res.status,
      envelope?.code ?? 'UNKNOWN',
      envelope?.message ?? `The API returned ${res.status} with no error envelope.`,
      envelope?.request_id ?? requestId,
      details,
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
  /**
   * Present for a cookie session, absent for a PAT (D-473). Optional because
   * the field is genuinely absent rather than null, which is the distinction
   * `exactOptionalPropertyTypes` exists to keep.
   */
  csrf_token?: string;
}

/**
 * Imported and re-exported, not redeclared. The capability matrix now lives in
 * `@steadhold/types` so the API and the dashboard answer "may this person invite
 * someone" from one table (D-428); a second `Role` union here would be the start
 * of the same drift one layer down.
 */
import type { Role } from '@steadhold/types';
export type { Role };

/**
 * One of the customer's **own** users — an end user of their app, not a member
 * of their Steadhold organization (P7s).
 *
 * The two are unrelated and the naming keeps them apart on purpose: `Member` is
 * a colleague with a role, `AuthUser` is a row in the project's `auth.users`.
 * Conflating them in the type layer is how a page ends up offering to change an
 * end user's organization role.
 *
 * No password field, and none is coming: the server shapes this list field by
 * field rather than spreading its row, so a new column has to be added
 * deliberately to reach here.
 */
export interface AuthUser {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  banned_until: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
}

export interface AuthUserPage {
  users: AuthUser[];
  has_more: boolean;
  next_cursor: string | null;
  /**
   * `reltuples`, so the footer can say "of ~4,200" without a sequential scan
   * (D-466's argument, applied to `auth.users`). `-1` means the table has never
   * been analyzed and `null` means this was a search, where a table-wide total
   * beside a filtered count would answer a question nobody asked.
   */
  estimated_total: number | null;
}

export interface Org {
  id: string;              // org_<uuid>
  name: string;
  slug: string;
  created_at: string;
  role: Role;
  member_count: number;
  project_count: number;
}

/** `serializeProjectUsage` in services/api/src/modules/control-plane/serialize.ts. */
export interface ProjectUsage {
  disk: {
    used_bytes: number | null;
    limit_bytes: number;
    /** `ok | warn | critical | read_only`. */
    state: string;
    checked_at: string | null;
  };
  /** Reserved for placement — *not* a measurement of what the container uses. */
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
  activity: { last_active_at: string | null };
}

/** A personal access token as listed — never including the secret. */
export interface AccessToken {
  id: string;
  name: string;
  /** `shp_` plus the first characters, for telling two tokens apart. */
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** The create response, which is the only time the secret exists outside a hash. */
export interface NewAccessToken {
  token: string;
  id: string;
  name: string;
  prefix: string;
  expires_at: string | null;
  warning: string;
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
export interface Member {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Role;
  joined_at: string;
}

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  created_at?: string;
  invited_by?: string;
}

export const PROJECT_STATES = [
  'provisioning', 'ready', 'paused', 'resuming', 'restoring', 'failed', 'deleting', 'deleted',
] as const;

/* ── the SQL console (P7l) ───────────────────────────────────────────────── */

/** One statement's result. `type` is the Postgres OID, not a name. */
export interface StatementResult {
  rows: Record<string, unknown>[];
  row_count: number;
  fields: { name: string; type: number }[];
  duration_ms: number;
  /** What actually ran, including any LIMIT the server appended. */
  executed_sql: string;
  truncated: boolean;
  command: string;
}

export interface IntrospectionTable {
  schema: string;
  name: string;
  kind: string;
  owner: string;
  rls_enabled: boolean;
  /**
   * `reltuples`. An **estimate**, and `-1` means the table has never been
   * analysed — which is not zero, and must never be rendered as one.
   */
  rows_estimate: number;
  comment: string | null;
  /**
   * Whether `anon` can read this table — `null` when there is no `anon` role,
   * which is the case in a database restored from `steadhold export` (D-004).
   *
   * D-108 makes anonymous access opt-in per table, so this is what decides
   * whether a `CREATE POLICY … TO anon` does anything at all.
   */
  anon_can_select: boolean | null;
  anon_can_write: boolean | null;
}

export interface IntrospectionColumn {
  schema: string;
  table: string;
  name: string;
  /** `format_type` output, so `character varying(40)` keeps its length. */
  type: string;
  nullable: boolean;
  default: string | null;
  position: number;
  is_primary_key: boolean;
  is_identity: boolean;
  comment: string | null;
}

export interface IntrospectionIndex {
  schema: string;
  table: string;
  name: string;
  /**
   * Key columns in index order, `null` for anything that is not a plain column.
   *
   * A `null` in the leading slot means an expression index, which cannot serve a
   * lookup on a column — so `columns[0] === 'author_id'` is the correct test for
   * "is `author_id` indexed for a foreign-key check", and it is correct *because*
   * of the nulls. `INCLUDE`d columns are absent.
   */
  columns: (string | null)[];
  is_unique: boolean;
  is_primary: boolean;
  /** False means a failed `CREATE INDEX CONCURRENTLY` left it behind. */
  is_valid: boolean;
  definition: string;
}

export interface IntrospectionConstraint {
  schema: string;
  table: string;
  name: string;
  /** `primary_key`, `foreign_key`, `unique`, `check` or `exclusion`. */
  kind: string;
  columns: (string | null)[];
  references_schema: string | null;
  references_table: string | null;
  definition: string;
}

export interface IntrospectionPolicy {
  schema: string;
  table: string;
  name: string;
  command: string;
  permissive: boolean;
  roles: string[];
  using: string | null;
  check: string | null;
}

export interface Introspection {
  schemas: string[];
  tables: IntrospectionTable[];
  columns: IntrospectionColumn[];
  functions: { schema: string; name: string; arguments: string; returns: string; kind: string }[];
  policies: IntrospectionPolicy[];
  indexes: IntrospectionIndex[];
  constraints: IntrospectionConstraint[];
  roles: string[];
  /** Which lists hit their server-side cap. A short list must say it is short. */
  truncated: Record<string, boolean>;
}

export const api = {
  me: () => request<MeResponse>('/v1/auth/me'),

  /** The project's schema, in one payload — the editors' whole left-hand side. */
  introspect: (ref: string) =>
    request<Introspection>(`/v1/projects/${encodeURIComponent(ref)}/db/introspect`),

  /**
   * Run SQL through the audited console path (D-132).
   *
   * `params` are bound, never interpolated — the grid's filters and its row edits
   * both go through here and the table editor spec is explicit that user input
   * never reaches a statement as text.
   */
  runSql: (ref: string, body: {
    sql: string;
    params?: readonly unknown[];
    role?: 'admin' | 'anon' | 'authenticated';
    claims?: Record<string, unknown>;
    read_only?: boolean;
    confirm_destructive?: boolean;
    confirm_names?: readonly string[];
  }) =>
    request<{ results: StatementResult[] }>(
      `/v1/projects/${encodeURIComponent(ref)}/db/query`,
      { method: 'POST', body }),

  login: (email: string, password: string) =>
    request<{ user: NonNullable<MeResponse['user']>; csrf_token: string }>(
      '/v1/auth/login', { method: 'POST', body: { email, password } }),

  signup: (email: string, password: string, displayName?: string) =>
    request<{ user: NonNullable<MeResponse['user']>; csrf_token: string }>(
      '/v1/auth/signup', { method: 'POST',
        body: { email, password, ...(displayName ? { display_name: displayName } : {}) } }),

  logout: () => request<void>('/v1/auth/logout', { method: 'POST' }),

  // ── the project's end users (P7s) ────────────────────────────────────────
  authUsers: (ref: string, opts: { q?: string; limit?: number; cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.q) qs.set('q', opts.q);
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.cursor) qs.set('cursor', opts.cursor);
    const query = qs.toString();
    return request<AuthUserPage>(
      `/v1/projects/${encodeURIComponent(ref)}/auth/users${query ? `?${query}` : ''}`);
  },

  updateAuthUser: (
    ref: string, id: string,
    change: { ban_until?: string | null; email_confirm?: boolean; sign_out?: boolean },
  ) =>
    request<AuthUser>(
      `/v1/projects/${encodeURIComponent(ref)}/auth/users/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: change }),

  deleteAuthUser: (ref: string, id: string) =>
    request<void>(
      `/v1/projects/${encodeURIComponent(ref)}/auth/users/${encodeURIComponent(id)}`,
      { method: 'DELETE' }),

  /** `GET /v1/auth/tokens`. The token itself is never in this response. */
  tokens: () => request<{ tokens: AccessToken[] }>('/v1/auth/tokens'),

  /**
   * Mint a personal access token.
   *
   * The 201 carries the token **once** (D-060) and its own `warning`. The caller
   * relays that field rather than writing its own sentence: if the platform ever
   * changes what it promises about storage, the page changes with it.
   *
   * `scopes` is deliberately not a parameter. The column exists and D-062 lists
   * scoping as future work — nothing authorizes against it, so a token created
   * with `scopes: ['read']` has full access. Offering the field would be offering
   * a restriction that is not applied.
   */
  createToken: (name: string, expiresInDays?: number) =>
    request<NewAccessToken>('/v1/auth/tokens', {
      method: 'POST',
      body: { name, ...(expiresInDays === undefined ? {} : { expires_in_days: expiresInDays }) },
    }),

  revokeToken: (id: string) =>
    request<void>(`/v1/auth/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  orgs: () => request<{ orgs: Org[] }>('/v1/orgs'),

  createOrg: (name: string, slug: string) =>
    request<{ org: Org }>('/v1/orgs', { method: 'POST', body: { name, slug } }),

  /**
   * Rename an organization. **Name only** — the slug is permanent, because it is
   * in every URL anyone has bookmarked or pasted, and the platform API has no
   * route to change it.
   */
  renameOrg: (orgId: string, name: string) =>
    request<{ org: Org }>(`/v1/orgs/${encodeURIComponent(orgId)}`,
      { method: 'PATCH', body: { name } }),

  /**
   * Delete an organization. **Permanently** — unlike a project, there is no
   * recovery window: the row is deleted outright, and only the audit trail
   * survives (it has no foreign key, for exactly this reason).
   *
   * A 409 means the org still holds projects. The check is `status <> 'deleted'`,
   * so a project inside its own seven-day recovery window still counts, which is
   * the case a caller is most likely to be surprised by.
   */
  deleteOrg: (orgId: string) =>
    request<void>(`/v1/orgs/${encodeURIComponent(orgId)}`, { method: 'DELETE' }),

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

  /**
   * What a project is using (P7e).
   *
   * Its own request, not fields on `project()`, because that one polls every
   * second while a project settles and these figures are refreshed by a sweep
   * every few minutes. A 409 here is meaningful and is left to the caller: it is
   * the control plane saying the project has no database to measure yet.
   */
  projectUsage: (ref: string) =>
    request<{ usage: ProjectUsage }>(`/v1/projects/${encodeURIComponent(ref)}/usage`),

  /**
   * Try a failed project again (P7j).
   *
   * The saga resumes from its checkpoint rather than starting over, so completed
   * steps are skipped — which is what makes this cheap enough to be a plain
   * button. A 409 means the project is not failed, or is failed with no build
   * behind it; the message names which, and the caller relays it.
   */
  retryProject: (ref: string) =>
    request<{ project: Project; job: { id: string; type: string; state: string }; retry: number }>(
      `/v1/projects/${encodeURIComponent(ref)}/retry`, { method: 'POST' }),

  /**
   * Delete a project — which is a **soft** delete (D-038).
   *
   * The saga sets `deleted_at` and `purge_after = now() + 7 days` and stops the
   * containers; the row, the volume and the final backup outlive the request.
   * The 202 carries the project back with `restorable_until` on it, which is the
   * deadline this UI shows rather than the phrase "seven days" — the promise is a
   * date, and a date is checkable.
   *
   * There is no self-serve undo: nothing in the platform API flips
   * `soft_deleted` back, so the confirmation must not imply a button exists.
   */
  deleteProject: (ref: string) =>
    request<{ project: Project; job: { id: string; type: string; state: string } }>(
      `/v1/projects/${encodeURIComponent(ref)}`, { method: 'DELETE' }),

  /**
   * Accept an invitation.
   *
   * The platform answers a single 404 for expired, revoked, already-used and
   * addressed-to-someone-else, on purpose: distinguishing them would turn an
   * invite token into an oracle about an organization's membership. So the caller
   * must not try to explain which — it can only relay the message and say which
   * account is signed in, which is a fact about the user's own session.
   */
  acceptInvite: (token: string) =>
    request<{ org_id: string; role: Role }>('/v1/invites/accept',
      { method: 'POST', body: { token } }),

  // ── organization members and invites ─────────────────────────────────────
  members: (orgId: string) =>
    request<{ members: Member[] }>(`/v1/orgs/${encodeURIComponent(orgId)}/members`),

  setMemberRole: (orgId: string, userId: string, role: Role) =>
    request<{ member: Member }>(
      `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: { role } }),

  removeMember: (orgId: string, userId: string) =>
    request<void>(
      `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }),

  invites: (orgId: string) =>
    request<{ invites: Invite[] }>(`/v1/orgs/${encodeURIComponent(orgId)}/invites`),

  /**
   * Create an invite.
   *
   * The response carries a **one-time token** and `delivery: 'not_emailed_yet'`,
   * because the email sender is a later phase — the API says so in its own
   * `warning` field. The caller has to surface that: a UI that says "invitation
   * sent" would be describing something that did not happen.
   */
  invite: (orgId: string, email: string, role: Role) =>
    request<{
      invite: Invite; token: string; delivery: string; warning: string;
    }>(`/v1/orgs/${encodeURIComponent(orgId)}/invites`,
      { method: 'POST', body: { email, role } }),

  revokeInvite: (orgId: string, inviteId: string) =>
    request<void>(
      `/v1/orgs/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
      { method: 'DELETE' }),

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
