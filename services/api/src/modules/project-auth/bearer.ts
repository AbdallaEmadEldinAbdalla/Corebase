import type { FastifyRequest } from 'fastify';
import type { Client } from 'pg';
import { verify as verifyJwt, JwtError } from '@corebase/jwt';
import { AUTH_ERROR_CODES } from '@corebase/types';
import { ApiError } from '../../kernel/errors.ts';
import type { ProjectContext } from './context.ts';
import { liveSession } from './store.ts';

/**
 * Who is calling, from `Authorization: Bearer <access JWT>` (P4e).
 *
 * ## Two checks, and both are needed
 *
 * The signature proves the token is ours and unmodified. The **session lookup**
 * proves it has not been revoked — and that second check is the reason `/logout`
 * means anything at all: an access token is stateless, so nothing about verifying
 * it can tell you the user signed out five minutes ago.
 *
 * ## Where this is *not* applied, deliberately
 *
 * It is not applied to the data plane. D-113's honest position is that PostgREST
 * verifies a signature and does not consult `auth.sessions`, so after revocation
 * an already-issued access token keeps working until its `exp` — up to an hour by
 * default. Adding a session lookup to every data-plane request is the "strict
 * mode" the doc defers to V1.x, because it puts a database round trip on the hot
 * path D-051 exists to keep database-free and turns auth availability into data
 * API availability.
 *
 * So the guarantee is precisely: **on the auth endpoints, revocation is
 * immediate; on the data API, refresh is dead immediately and access dies within
 * `exp`.** Anyone claiming stateless JWTs plus instant revocation everywhere is
 * selling something.
 */

export interface Bearer {
  userId: string;
  sessionId: string;
  email: string | null;
}

const unauthenticated = (message: string) =>
  new ApiError(401, AUTH_ERROR_CODES.UNAUTHORIZED, message);

/**
 * Verify the token's signature and claims. No database access — split out so the
 * cheap half runs before a connection is opened.
 */
export function verifyBearer(ctx: ProjectContext, header: string | undefined): Bearer {
  if (!header || !/^Bearer\s+/i.test(header)) {
    throw unauthenticated('This endpoint needs an access token in `Authorization: Bearer …`.');
  }
  const token = header.replace(/^Bearer\s+/i, '').trim();
  let claims;
  try {
    // The project's *own* public key and the auth issuer, both pinned. A token
    // signed by another project cannot act here even though the claim shape is
    // identical — which is the only thing separating tenants on this path.
    claims = verifyJwt(token, {
      publicKeyPem: ctx.signing.publicKeyPem, issuer: ctx.issuer });
  } catch (err) {
    if (err instanceof JwtError) {
      // One message for expired, forged, wrong-project and malformed. Which it
      // was is in the audit log; telling the caller lets them probe.
      throw unauthenticated('That access token is not valid.');
    }
    throw err;
  }

  const sub = typeof claims['sub'] === 'string' ? claims['sub'] : '';
  const sessionId = typeof claims['session_id'] === 'string' ? claims['session_id'] : '';
  const role = claims['role'];
  // A project API key is a valid JWT under the same keypair with the same issuer
  // family, so the role check is what stops an anon key being presented as a
  // user. It has no `sub` either, but relying on that would make the guard an
  // accident of the claim set rather than a decision.
  if (role !== 'authenticated' || !sub || !sessionId) {
    throw unauthenticated('That is not a user access token.');
  }
  return {
    userId: sub, sessionId,
    email: typeof claims['email'] === 'string' ? claims['email'] : null,
  };
}

/**
 * The database half: the session behind the token is still live.
 *
 * Separate from `verifyBearer` so the signature check can reject before a
 * connection is opened — an endpoint hammered with garbage tokens should cost a
 * signature verification, not a Postgres connect.
 */
export async function requireLiveSession(
  db: Client, bearer: Bearer,
): Promise<void> {
  const live = await liveSession(db, bearer.sessionId, bearer.userId);
  if (!live) {
    // Same message as a bad signature. A revoked session and a forged token are
    // the same answer to the caller: stop using this token.
    throw unauthenticated('That access token is not valid.');
  }
}

/** Convenience for routes that need both halves. */
export const bearerFrom = (req: FastifyRequest, ctx: ProjectContext): Bearer =>
  verifyBearer(ctx, req.headers['authorization']);
