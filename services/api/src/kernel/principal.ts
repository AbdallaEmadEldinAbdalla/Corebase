import type { FastifyRequest } from 'fastify';
import { ERROR_CODES } from '@steadhold/types';
import type { Actor } from '@steadhold/audit';
import { ApiError } from './errors.ts';
import {
  SESSION_COOKIE, CSRF_HEADER, csrfOk, readCookie,
  type Session, type SessionStore,
} from './sessions.ts';
import { TOKEN_PREFIX, type TokenStore } from './tokens.ts';

/**
 * Dual-mode authentication (D-062): a dashboard session cookie, or a `shp_`
 * personal access token.
 *
 * One function resolves both, so every route asks the same question and no route
 * invents its own answer. The two modes differ in exactly one way that matters
 * further up: **CSRF applies to cookies and not to tokens.** A cookie is attached
 * by the browser whether or not the page meant to send it, which is what CSRF is;
 * a bearer token has to be put there by the caller, so there is nothing to forge.
 * Demanding a CSRF header from the CLI would be security theatre that breaks
 * `curl`.
 */

export type PrincipalKind = 'session' | 'token' | 'static';

export interface Principal {
  userId: string | null;
  kind: PrincipalKind;
  session?: Session;
  tokenId?: string;
  scopes?: string[];
}

export interface PrincipalDeps {
  sessions?: SessionStore;
  tokens?: TokenStore;
  /** M0's transitional static token. Kept until the CLI exists (D-062). */
  staticToken?: string;
  staticUserId?: string | null;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Resolve the caller, or throw 401.
 *
 * Order is session, then bearer. A request carrying both is answered by the
 * session, because a browser that also has a token in a header is far more likely
 * to be a confused fetch than a deliberate escalation — and either way the
 * session is the narrower credential.
 */
export async function resolvePrincipal(
  req: FastifyRequest, deps: PrincipalDeps,
): Promise<Principal> {
  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (cookie && deps.sessions) {
    const session = await deps.sessions.touch(cookie);
    if (session) {
      // CSRF is checked here rather than in each route, so a new mutating route
      // cannot forget it.
      if (MUTATING.has(req.method) && !csrfOk(session, req.headers[CSRF_HEADER] as string | undefined)) {
        // `CSRF_REQUIRED`, not `UNAUTHORIZED`: the session is valid and only the
        // token is missing or stale, which is the one 403 a client can recover
        // from on its own — see the code's own docblock, and D-473.
        throw new ApiError(403, ERROR_CODES.CSRF_REQUIRED,
          `This request needs a ${CSRF_HEADER} header matching the session's CSRF token.`
          // Not "reload the page": `sessionStorage` survives a reload, so a
          // stale token would survive one too. The endpoint is the actual cure,
          // and naming it serves the CLI and curl callers who read this message
          // as well as the dashboard, which now recovers on its own (D-473).
          + ' GET /v1/auth/me returns the token for the current session.');
      }
      return { userId: session.user_id, kind: 'session', session };
    }
    // A cookie that no longer resolves is an expired session, not an anonymous
    // request: fall through so a bearer token can still authenticate, but do not
    // pretend the cookie was absent.
  }

  const authorization = req.headers.authorization;
  const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim() : undefined;

  if (bearer && deps.tokens && bearer.startsWith(TOKEN_PREFIX)) {
    const resolved = await deps.tokens.resolve(bearer);
    if (resolved) {
      return {
        userId: resolved.userId, kind: 'token',
        tokenId: resolved.tokenId, scopes: resolved.scopes,
      };
    }
    // A `shp_` that does not resolve is revoked, expired or forged. Saying which
    // would help someone testing stolen tokens.
    throw ApiError.unauthorized();
  }

  if (bearer && deps.staticToken && bearer === deps.staticToken) {
    return { userId: deps.staticUserId ?? null, kind: 'static' };
  }

  throw ApiError.unauthorized();
}

/** The audit actor for a resolved principal. */
export function actorOf(principal: Principal, req: FastifyRequest, requestId: string): Actor {
  return {
    // A PAT acts on behalf of its user, so `user` is the honest type; `api_key`
    // is reserved for a project key acting with no human behind it.
    type: principal.userId ? 'user' : 'system',
    userId: principal.userId,
    ip: req.ip ?? null,
    requestId,
  };
}
