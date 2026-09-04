import type { FastifyInstance } from 'fastify';

/**
 * Cross-origin access for the dashboard (P1g).
 *
 * The dashboard is the first browser client, and it runs on its own origin, so
 * every call it makes is cross-origin and carries the session cookie. That
 * combination is the one CORS gets wrong most often, so the rules here are
 * narrow on purpose:
 *
 * **No wildcard, ever.** `Access-Control-Allow-Origin: *` with credentials is
 * rejected by browsers anyway, but the reason to refuse it in code is the
 * configuration foot-gun: a wildcard that works in development because nothing
 * sends cookies yet becomes a hole the day something does. An origin is echoed
 * only if it is on the allowlist.
 *
 * **`Vary: Origin` on every response**, allowlisted or not. Without it a shared
 * cache can hand one origin's `Allow-Origin` header to another, which turns a
 * correct allowlist into an incorrect one at the edge.
 *
 * **Off by default.** An unset `CB_DASHBOARD_ORIGINS` allows no cross-origin
 * requests at all. A default of `localhost:3000` would be convenient and would
 * also be a production hole the day someone forgets to set the variable — and
 * forgetting is the normal case, since the service starts fine either way.
 *
 * This is defence in depth, not the CSRF defence. The wall against a hostile
 * page is the double-submit token that `resolvePrincipal` demands on mutating
 * methods: setting `x-csrf-token` forces a preflight, and a preflight from an
 * origin that is not on the list gets no permission. CORS keeps a *reader* on
 * another origin from seeing responses; the CSRF token keeps a *writer* from
 * making them happen.
 */

/** Headers a browser client is allowed to send. Each one is here for a reason. */
const ALLOWED_HEADERS = [
  'content-type',
  // The double-submit CSRF token. Requiring a custom header is what forces the
  // preflight that the allowlist then refuses.
  'x-csrf-token',
  // Create-project retries (D-055). A browser that retries a create must be able
  // to say it is the same create.
  'idempotency-key',
  // A PAT, for a client that holds one rather than a session.
  'authorization',
  // A client that wants its own correlation id to appear in our logs.
  'x-request-id',
  /**
   * The project key every `/auth/v1/*` endpoint requires (D-029).
   *
   * Missing until P4i, and the omission made the **entire data plane unreachable
   * from a browser**: a custom header forces a preflight, the preflight lists
   * only these, and `apikey` was not among them — so every signup and login from
   * a customer's frontend failed before it left the browser. This list was
   * written for the dashboard, which talks to the control plane and never sends
   * one, and the data plane inherited it. Found by writing the phase's demo page,
   * which is the first browser client the auth API has ever had.
   */
  'apikey',
].join(', ');

/**
 * Headers a browser client is allowed to *read*. Only `x-request-id`, and it
 * matters: the design system requires every error surface to show a request id
 * with a copy button (D-032/D-179), and the header is the one that survives a
 * response whose body the client could not parse.
 */
const EXPOSED_HEADERS = 'x-request-id';

// PUT alongside PATCH: `PUT /auth/v1/user` is how a user changes their password,
// their email or their metadata, and without it that endpoint is unreachable from
// a browser for the same reason `apikey` was.
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/** Ten minutes. Long enough to save the preflight round-trip on a page of calls,
 *  short enough that an allowlist change takes effect within a coffee break. */
const MAX_AGE_SECONDS = 600;

export interface CorsOptions {
  /** Exact origins, scheme and port included. Empty disables cross-origin access. */
  origins: readonly string[];
}

/** Parse `CB_DASHBOARD_ORIGINS`. Empty or unset means no cross-origin access. */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))   // a trailing slash is never part of an Origin
    .filter((o) => o.length > 0);
}

export function registerCors(app: FastifyInstance, opts: CorsOptions) {
  const allowed = new Set(opts.origins);

  app.addHook('onRequest', async (req, reply) => {
    // Always, regardless of outcome: the response depends on the request's
    // Origin whether or not we allow it.
    reply.header('vary', 'Origin');

    const origin = req.headers.origin;
    // No Origin at all is the normal case for curl, the CLI, and every
    // server-to-server caller. Those are not browsers and CORS has nothing to
    // say about them.
    if (typeof origin !== 'string') return;

    const permitted = allowed.has(origin);
    if (permitted) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-expose-headers', EXPOSED_HEADERS);
    }

    if (req.method !== 'OPTIONS') return;

    // Preflight. Answer it here rather than letting it fall through to the
    // 404 handler — and answer it *without* permission headers when the origin
    // is not allowlisted, which is what makes the browser refuse the real call.
    if (permitted) {
      reply.header('access-control-allow-methods', ALLOWED_METHODS);
      reply.header('access-control-allow-headers', ALLOWED_HEADERS);
      reply.header('access-control-max-age', String(MAX_AGE_SECONDS));
    }
    // 204 either way. A 403 here would tell a probing page that the origin was
    // considered and rejected; silence plus missing headers is the same refusal
    // with less to learn from.
    return reply.status(204).send();
  });
}
