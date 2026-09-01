import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ERROR_CODES, encodeId } from '@corebase/types';
import { burnVerify, PasswordFormatError, MIN_PASSWORD_LENGTH } from '@corebase/crypto';
import { writeAudit } from '@corebase/audit';
import type { Pool } from 'pg';
import { ApiError } from '../../kernel/errors.ts';
import { resolvePrincipal, actorOf, type PrincipalDeps } from '../../kernel/principal.ts';
import {
  sessionCookie, clearedSessionCookie, CSRF_HEADER, type SessionStore,
} from '../../kernel/sessions.ts';
import type { TokenStore } from '../../kernel/tokens.ts';
import { EmailTakenError, type UserStore } from './store.ts';
import { rateLimitKey, type RateLimiter } from '../../kernel/rate-limit.ts';

/**
 * Platform auth: dashboard accounts and the tokens the CLI uses (D-062).
 *
 * Two rules run through every handler here.
 *
 * **Nothing distinguishes an unknown email from a wrong password** — not the
 * status, not the message, not the response time. The first two are a choice; the
 * third is why `burnVerify` exists, because a miss that returns in a millisecond
 * while a real failure takes 100 ms is an enumeration oracle regardless of what
 * the body says.
 *
 * **A secret is shown once or never.** A PAT is returned by the call that creates
 * it and is unrecoverable afterwards (D-060), so the endpoint that lists tokens
 * cannot leak one even if it is wrong.
 */

const SignupRequest = z.object({
  email: z.string().email().max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  display_name: z.string().min(1).max(120).optional(),
});

const LoginRequest = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
});

const CreateTokenRequest = z.object({
  name: z.string().min(1).max(120),
  expires_in_days: z.number().int().min(1).max(365).optional(),
  scopes: z.array(z.string().min(1).max(64)).max(20).optional(),
});

export interface AuthDeps extends PrincipalDeps {
  pool: Pool;
  users: UserStore;
  sessions: SessionStore;
  tokens: TokenStore;
  loginLimiter: RateLimiter;
  /** Separate budget from login: one protects an account, the other protects the
   *  node's memory. Sharing a counter would let failed logins exhaust signup. */
  signupLimiter: RateLimiter;
  /** False only for plain-HTTP local development. */
  secureCookies: boolean;
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps) {
  const requestIdOf = (reply: { getHeader(n: string): unknown }, fallback: string) =>
    String(reply.getHeader('x-request-id') ?? fallback);

  const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> => {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw ApiError.validation(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    return result.data;
  };

  const publicUser = (u: { id: string; email: string; display_name: string | null; email_verified: boolean }) => ({
    id: encodeId('user', u.id),
    email: u.email,
    display_name: u.display_name,
    email_verified: u.email_verified,
  });

  // ── signup ────────────────────────────────────────────────────────────────
  app.post('/v1/auth/signup', async (req, reply) => {
    const body = parse(SignupRequest, req.body);
    const requestId = requestIdOf(reply, req.id);
    const email = body.email.trim().toLowerCase();

    // Rate limited for a reason specific to how we hash passwords. scrypt at
    // N=2^16, r=8 costs **64 MiB of memory per call** (D-211), and signup is the
    // one unauthenticated endpoint that performs one. Twenty concurrent signups
    // is ~1.3 GiB — an availability hole reachable by anyone with a socket, and
    // considerably cheaper for an attacker than for us.
    //
    // D-211's own rationale worried about exactly this ("a memory spike that can
    // become an outage") and then only login was limited. Per address rather than
    // per email, because the email is attacker-chosen and never repeats.
    const hit = await deps.signupLimiter.hit(rateLimitKey('signup-ip', req.ip ?? 'unknown'));
    if (!hit.allowed) {
      throw new ApiError(429, ERROR_CODES.VALIDATION_FAILED,
        `Too many sign-ups from this address. Try again in ${hit.retryAfterSeconds}s.`);
    }

    try {
      const user = await deps.users.signup({
        email,
        password: body.password,
        ...(body.display_name ? { displayName: body.display_name } : {}),
        actor: { type: 'user', userId: null, ip: req.ip ?? null, requestId },
      });
      // Signing in immediately: the account was just proven to belong to whoever
      // holds the password, and a signup that then demands a login is friction
      // with no security value.
      const session = await deps.sessions.create(user.id);
      return reply
        .status(201)
        .header('set-cookie', sessionCookie(session.id, { secure: deps.secureCookies }))
        .send({
          user: publicUser(user),
          csrf_token: session.csrf,
          // Email verification gates project creation (platform API), and the
          // sender is Phase 4. Said out loud so a client is not left guessing why
          // a fresh account cannot create anything.
          email_verification: 'not_sent_yet',
        });
    } catch (err) {
      if (err instanceof EmailTakenError) {
        // Signup is the one place enumeration cannot be fully hidden — a unique
        // email is the product's own rule — so it is stated plainly rather than
        // half-hidden behind a 202 that lies about what happened.
        throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
          'An account with that email already exists.');
      }
      if (err instanceof PasswordFormatError) throw ApiError.validation(err.message);
      throw err;
    }
  });

  // ── login ─────────────────────────────────────────────────────────────────
  app.post('/v1/auth/login', async (req, reply) => {
    const body = parse(LoginRequest, req.body);
    const requestId = requestIdOf(reply, req.id);
    const email = body.email.trim().toLowerCase();

    // Per identifier *and* per address: either alone has an obvious hole.
    for (const key of [rateLimitKey('login', email), rateLimitKey('login-ip', req.ip ?? 'unknown')]) {
      const hit = await deps.loginLimiter.hit(key);
      if (!hit.allowed) {
        throw new ApiError(429, ERROR_CODES.VALIDATION_FAILED,
          `Too many login attempts. Try again in ${hit.retryAfterSeconds}s.`);
      }
    }

    const user = await deps.users.findByEmail(email);
    const invalid = new ApiError(401, ERROR_CODES.UNAUTHORIZED, 'Email or password is incorrect.');

    if (!user || !user.password_hash) {
      // Spend the same time as a real verification, then fail identically. The
      // bootstrap account has no hash on purpose and lands here.
      await burnVerify(body.password);
      await auditLoginFailure(email, requestId, req.ip ?? null, user ? 'no_password' : 'no_user');
      throw invalid;
    }
    if (user.disabled_at) {
      await burnVerify(body.password);
      await auditLoginFailure(email, requestId, req.ip ?? null, 'disabled');
      throw invalid;
    }

    const result = await deps.users.verify(body.password, user.password_hash);
    if (!result.ok) {
      await auditLoginFailure(email, requestId, req.ip ?? null, 'bad_password');
      throw invalid;
    }
    // Raising the cost later is worth nothing to existing users unless the login
    // path upgrades them.
    if (result.needsRehash) await deps.users.upgradeHash(user.id, body.password);

    const session = await deps.sessions.create(user.id);
    await writeAudit(deps.pool, { type: 'user', userId: user.id, ip: req.ip ?? null, requestId }, {
      action: 'user.logged_in', resourceType: 'user', resourceId: user.id,
      metadata: { email: user.email, rehashed: result.needsRehash },
    });

    return reply
      .header('set-cookie', sessionCookie(session.id, { secure: deps.secureCookies }))
      .send({
        user: publicUser(user),
        // The client echoes this in `x-csrf-token` on mutating requests.
        csrf_token: session.csrf,
      });
  });

  /**
   * Failed logins are audited with a reason the *operator* can use and the
   * *client* never sees. Without this, credential stuffing is invisible until
   * someone gets in.
   */
  async function auditLoginFailure(
    email: string, requestId: string, ip: string | null, reason: string,
  ): Promise<void> {
    await writeAudit(deps.pool, { type: 'system', userId: null, ip, requestId }, {
      action: 'user.login_failed', resourceType: 'user',
      metadata: { email, reason },
    });
  }

  // ── logout ────────────────────────────────────────────────────────────────
  app.post('/v1/auth/logout', async (req, reply) => {
    const principal = await resolvePrincipal(req, deps);
    const requestId = requestIdOf(reply, req.id);
    if (principal.session) await deps.sessions.destroy(principal.session.id);
    if (principal.userId) {
      await writeAudit(deps.pool, actorOf(principal, req, requestId), {
        action: 'user.logged_out', resourceType: 'user', resourceId: principal.userId,
        metadata: { via: principal.kind },
      });
    }
    return reply
      .header('set-cookie', clearedSessionCookie())
      .status(204)
      .send();
  });

  // ── me ────────────────────────────────────────────────────────────────────
  app.get('/v1/auth/me', async (req) => {
    const principal = await resolvePrincipal(req, deps);
    if (!principal.userId) {
      // The static token authenticates but is nobody. Better to say so than to
      // invent a user.
      return { user: null, memberships: [], principal: principal.kind };
    }
    const user = await deps.users.findById(principal.userId);
    if (!user) throw ApiError.unauthorized();
    const memberships = await deps.users.memberships(user.id);
    return {
      user: publicUser(user),
      memberships: memberships.map((m) => ({
        org_id: encodeId('organization', m.organization_id),
        name: m.organization_name,
        slug: m.organization_slug,
        role: m.role,
      })),
      principal: principal.kind,
    };
  });

  // ── personal access tokens ────────────────────────────────────────────────
  app.get('/v1/auth/tokens', async (req) => {
    const principal = await requireUser(req);
    return { tokens: (await deps.tokens.list(principal)).map((t) => ({
      id: t.id, name: t.name, prefix: t.token_prefix, scopes: t.scopes,
      expires_at: t.expires_at, last_used_at: t.last_used_at, created_at: t.created_at,
    })) };
  });

  app.post('/v1/auth/tokens', async (req, reply) => {
    const userId = await requireUser(req);
    const body = parse(CreateTokenRequest, req.body);
    const requestId = requestIdOf(reply, req.id);

    const expiresAt = body.expires_in_days
      ? new Date(Date.now() + body.expires_in_days * 86_400_000) : null;
    const issued = await deps.tokens.issue({
      userId, name: body.name, scopes: body.scopes ?? [], expiresAt,
    });
    await writeAudit(deps.pool, { type: 'user', userId, ip: req.ip ?? null, requestId }, {
      action: 'token.created', resourceType: 'access_token', resourceId: issued.id,
      // The prefix, never the token. The audit row must be safe to read.
      metadata: { name: body.name, key_prefix: issued.prefix, scopes: body.scopes ?? [],
                  expires_at: expiresAt?.toISOString() ?? null },
    });

    return reply.status(201).send({
      // Shown exactly once (D-060). There is no endpoint that can return it again.
      token: issued.token,
      id: issued.id,
      name: body.name,
      prefix: issued.prefix,
      expires_at: expiresAt?.toISOString() ?? null,
      warning: 'This token will not be shown again. Store it now.',
    });
  });

  app.delete('/v1/auth/tokens/:id', async (req, reply) => {
    const userId = await requireUser(req);
    const { id } = req.params as { id: string };
    const requestId = requestIdOf(reply, req.id);

    // Scoped to the owner inside the query, not checked before it: a
    // check-then-act here is a window in which the token could change hands.
    const revoked = await deps.tokens.revoke(userId, id);
    if (!revoked) throw ApiError.notFound('Token');
    await writeAudit(deps.pool, { type: 'user', userId, ip: req.ip ?? null, requestId }, {
      action: 'token.revoked', resourceType: 'access_token', resourceId: id,
    });
    return reply.status(204).send();
  });

  /** Endpoints that act on a user's own resources need an actual user. */
  async function requireUser(req: Parameters<typeof resolvePrincipal>[0]): Promise<string> {
    const principal = await resolvePrincipal(req, deps);
    if (!principal.userId) {
      throw new ApiError(403, ERROR_CODES.UNAUTHORIZED,
        'This endpoint acts on a user\'s own resources and the static token is not a user.');
    }
    return principal.userId;
  }

  // ── deferred, and said so ─────────────────────────────────────────────────
  // verify-email and password-reset need an email sender, which is Phase 4. They
  // are absent rather than stubbed: a 501 route is a promise a client will code
  // against, and a silently-succeeding stub is worse than either.
  void CSRF_HEADER;
}
