import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AUTH_ERROR_CODES } from '@corebase/types';
import { toJwk } from '@corebase/jwt';
import {
  hashPassword, verifyPassword, burnVerify, validatePassword,
  PasswordFormatError, MIN_END_USER_PASSWORD_LENGTH,
} from '@corebase/crypto';
import { SECRET_NAMES } from '@corebase/secrets';
import { ApiError } from '../../kernel/errors.ts';
import { rateLimitKey, type RateLimiter } from '../../kernel/rate-limit.ts';
import {
  resolveProject, withProjectDb, AuthContextError,
  type ResolveDeps, type ProjectContext,
} from './context.ts';
import { mintAccessToken, newRefreshToken } from './tokens.ts';
import {
  findUserByEmail, createUser, updatePasswordHash, markSignedIn, openSession,
  writeAuthAudit, publicUser,
} from './store.ts';

/**
 * `/auth/v1/*` — the data-plane auth API (P4b, flows §1 and §3).
 *
 * ## What this is not
 *
 * It is not the control plane's `/v1/auth/*`, which logs *operators* into the
 * dashboard. These endpoints serve the **end users of a customer's application**,
 * they read and write the customer's own database, and the two surfaces share
 * nothing but the error envelope. The prefix is the only thing that keeps them
 * apart in a URL, so it is worth being loud about: `/v1/auth` is ours, `/auth/v1`
 * is theirs. (That collision is not our invention — it is the shape both Supabase
 * and this corpus's platform API already have.)
 *
 * ## The order of operations on the login path
 *
 * Rate limit → resolve project → connect → fetch user → hash → gates. The hash is
 * last of the expensive things and it is limited *before* it runs, because scrypt
 * at these parameters costs 64 MiB of memory per call (D-211): unlimited concurrent
 * logins is an out-of-memory kill reachable by anyone with a socket, and cheaper
 * for the attacker than for us. D-241 made that a rule after the control plane's
 * signup shipped without it.
 */

const emailSchema = z.string().trim().min(3).max(320).email();

const SignupBody = z.object({
  email: emailSchema,
  password: z.string(),
  /** → `raw_user_meta_data`; user-writable, never trusted for authorization. */
  data: z.record(z.unknown()).optional(),
});

const PasswordGrantBody = z.object({
  email: emailSchema,
  password: z.string(),
});

export interface ProjectAuthDeps extends ResolveDeps {
  /** `POST /signup`: 30/hour per IP (flows §rate limits). */
  signupLimiter: RateLimiter;
  /** `POST /token?grant_type=password`: 10/5min per email. */
  loginEmailLimiter: RateLimiter;
  /** …and 30/5min per IP. */
  loginIpLimiter: RateLimiter;
}

const tooMany = (retryAfterSeconds: number) =>
  new ApiError(429, AUTH_ERROR_CODES.OVER_RATE_LIMIT,
    `Too many attempts. Try again in ${retryAfterSeconds}s.`);

/** Same generic answer for a wrong password, an unknown email and a ban. */
const badCredentials = () =>
  new ApiError(400, AUTH_ERROR_CODES.INVALID_CREDENTIALS,
    'Invalid login credentials.');

/**
 * Rate-limit keys are per project, so one busy project cannot exhaust another's
 * budget and an attacker cannot dodge a project's limit by presenting a different
 * project's anon key. Keys carry the project id rather than the ref because a ref
 * is guessable and an id is not — not a security control, but it keeps a
 * mistyped ref from landing in somebody else's bucket.
 */
const projKey = (ctx: ProjectContext, bucket: string, id: string) =>
  rateLimitKey(`pauth:${bucket}:${ctx.projectId}`, id);

/** Turn a context failure into the auth surface's own error shape. */
async function project(deps: ProjectAuthDeps, req: FastifyRequest): Promise<ProjectContext> {
  const apikey = req.headers['apikey'];
  try {
    return await resolveProject(deps, typeof apikey === 'string' ? apikey : undefined);
  } catch (err) {
    if (err instanceof AuthContextError) {
      throw new ApiError(err.status,
        err.status === 503 ? AUTH_ERROR_CODES.UNAVAILABLE : AUTH_ERROR_CODES.UNAUTHORIZED,
        err.message);
    }
    throw err;
  }
}

const clientMeta = (req: FastifyRequest) => {
  const ua = req.headers['user-agent'];
  return {
    ...(typeof ua === 'string' ? { userAgent: ua.slice(0, 512) } : {}),
    ...(req.ip ? { ip: req.ip } : {}),
  };
};

export function registerProjectAuth(app: FastifyInstance, deps: ProjectAuthDeps) {
  /**
   * Liveness of the *module*, not of any project (proposal §69).
   *
   * It deliberately touches no database and resolves no project: a health check
   * that depends on a tenant's database reports the module down when one project
   * is down, which is the opposite of what an operator needs from it.
   */
  app.get('/auth/v1/health', async () => ({ status: 'ok', service: 'auth' }));

  /**
   * The project's public keys (D-014).
   *
   * Unauthenticated, per the API table — a public key is public, and a JWKS
   * behind auth breaks every verifier the moment a credential rotates.
   *
   * The ref comes from the Host subdomain when there is one and from `?ref=`
   * otherwise. The shipped design has the gateway supply it from
   * `<ref>.corebase.co` (D-051); there is no gateway before Phase 5 and a Docker
   * stack answers on one host, so the query parameter is the stand-in. It leaks
   * nothing: the response is public by design and the control plane already
   * serves the same document at a ref-keyed path.
   */
  app.get('/auth/v1/.well-known/jwks.json', async (req, reply) => {
    const ref = refFromRequest(req, deps.projectDomain);
    if (!ref) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Name the project: `?ref=<ref>`, or call this on the project\'s own host.');
    }
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM projects WHERE ref = $1 AND deleted_at IS NULL`, [ref]);
    const row = rows[0];
    if (!row) throw new ApiError(404, AUTH_ERROR_CODES.VALIDATION_FAILED, 'No such project.');
    const [pem, kid] = await Promise.all([
      deps.secrets.get(row.id, SECRET_NAMES.jwtPublicKey),
      deps.secrets.get(row.id, SECRET_NAMES.jwtKid),
    ]);
    if (!pem || !kid) {
      throw new ApiError(503, AUTH_ERROR_CODES.UNAVAILABLE, 'This project has no keys yet.');
    }
    return reply.header('cache-control', 'public, max-age=300')
      .send({ keys: [toJwk(pem, kid)] });
  });

  /**
   * Flow 1 — signup.
   *
   * The response is the **same shape whether or not the address is taken**, and
   * that is the whole security content of this endpoint: signup is the classic
   * enumeration oracle, and a 409 on a taken address turns a public form into a
   * "does this person have an account here" service. So an existing address gets
   * a 200 carrying a freshly generated decoy uuid.
   *
   * The cost of honouring that is real and worth naming: we also spend a scrypt
   * hash on the duplicate case, because skipping it would make the taken address
   * answer in 2 ms and the new one in 100 ms — the same oracle, moved from the
   * body into the clock.
   */
  app.post('/auth/v1/signup', async (req, reply) => {
    const ctx = await project(deps, req);
    if (ctx.config.disableSignup) {
      throw new ApiError(422, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Sign-ups are disabled for this project.');
    }

    // Before the hash, not after (D-241).
    const hit = await deps.signupLimiter.hit(projKey(ctx, 'signup-ip', req.ip ?? 'unknown'));
    if (!hit.allowed) throw tooMany(hit.retryAfterSeconds);

    const parsed = SignupBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Provide a valid `email` and a `password`.');
    }
    const { email, password } = parsed.data;

    // Specific on purpose: a password-policy message reveals nothing about any
    // account, and "invalid request" in its place is the single most common way
    // to make a sign-up form unusable.
    const min = Math.max(MIN_END_USER_PASSWORD_LENGTH, ctx.config.passwordMinLength);
    try {
      validatePassword(password, min);
    } catch (err) {
      if (err instanceof PasswordFormatError) {
        throw new ApiError(422, AUTH_ERROR_CODES.WEAK_PASSWORD, err.message);
      }
      throw err;
    }

    const hash = await hashPassword(password, min);
    const meta = clientMeta(req);

    return withProjectDb(ctx, async (db) => {
      const created = await createUser(db, {
        email, passwordHash: hash,
        emailConfirmed: ctx.config.autoconfirm,
        ...(parsed.data.data ? { userMetadata: parsed.data.data } : {}),
      });

      if (!created) {
        // Taken. The audit log is where the truth lives — it is ours and the
        // client never sees it, so it can be precise where the response cannot.
        await writeAuthAudit(db, { action: 'signup_duplicate_email', ...meta });
        return reply.status(200).send({
          id: crypto.randomUUID(),          // decoy, per flows §1 step 5
          email,
          confirmation_sent_at: new Date().toISOString(),
        });
      }

      await writeAuthAudit(db, {
        action: 'signup', userId: created.id, ...meta,
        payload: { autoconfirm: ctx.config.autoconfirm },
      });

      if (!ctx.config.autoconfirm) {
        // No confirmation token and no email yet — both are P4c/P4d. What is
        // returned is still the doc's shape, and `confirmation_sent_at` is a
        // claim we are not yet entitled to make; STATUS records it as a gap
        // rather than letting the response quietly lie about a sent email.
        return reply.status(200).send({
          id: created.id, email: created.email,
          confirmation_sent_at: new Date().toISOString(),
        });
      }

      const session = await issueSession(db, ctx, created.id, created.email, meta);
      return reply.status(200).send({ ...session, user: publicUser(created) });
    });
  });

  /**
   * Flow 3 — `POST /token?grant_type=password`.
   *
   * Two rate-limit buckets, and neither is redundant: per-IP alone lets a botnet
   * spread one password across thousands of addresses, and per-email alone lets
   * one host walk a list of emails. Both are checked before any hashing.
   */
  app.post('/auth/v1/token', async (req, reply) => {
    const grant = (req.query as { grant_type?: unknown } | undefined)?.grant_type;
    if (grant === 'refresh_token') {
      // Named rather than a generic 400: a client sending this is doing the right
      // thing against a server that has not built it yet, and `invalid_grant`
      // would send them looking for a bad token they do not have.
      throw new ApiError(501, AUTH_ERROR_CODES.INVALID_GRANT,
        'The refresh_token grant is not available in this build yet.');
    }
    if (grant !== 'password') {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Set `grant_type=password` in the query string.');
    }

    const ctx = await project(deps, req);
    const parsed = PasswordGrantBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Provide `email` and `password`.');
    }
    const email = parsed.data.email;
    const password = parsed.data.password;

    for (const [limiter, bucket, id] of [
      [deps.loginEmailLimiter, 'login-email', email.toLowerCase()],
      [deps.loginIpLimiter, 'login-ip', req.ip ?? 'unknown'],
    ] as const) {
      const hit = await limiter.hit(projKey(ctx, bucket, id));
      if (!hit.allowed) throw tooMany(hit.retryAfterSeconds);
    }

    const meta = clientMeta(req);
    return withProjectDb(ctx, async (db) => {
      const user = await findUserByEmail(db, email);

      // No row, or a row with no password (an OAuth-only user, once that
      // exists): still spend a verify against the decoy hash, so "no such user"
      // and "wrong password" take the same time. Skipping it is a free
      // enumeration oracle that no amount of care in the response body closes.
      if (!user || !user.encrypted_password) {
        await burnVerify(password);
        await writeAuthAudit(db, { action: 'login_failed_no_user', ...meta });
        throw badCredentials();
      }

      const { ok, needsRehash } = await verifyPassword(password, user.encrypted_password);
      if (!ok) {
        await writeAuthAudit(db, { action: 'login_failed_bad_password', userId: user.id, ...meta });
        throw badCredentials();
      }

      // Gates *after* the hash, all mapped to one external error except the
      // confirmation one — which is safe to name precisely because it only fires
      // on a correct password, so an attacker learns it only for accounts they
      // could already log into (flows §3 step 4).
      if (user.banned_until && user.banned_until.getTime() > Date.now()) {
        await writeAuthAudit(db, { action: 'login_failed_banned', userId: user.id, ...meta });
        throw badCredentials();
      }
      if (!user.email_confirmed_at && !ctx.config.autoconfirm) {
        await writeAuthAudit(db, { action: 'login_failed_unconfirmed', userId: user.id, ...meta });
        throw new ApiError(400, AUTH_ERROR_CODES.EMAIL_NOT_CONFIRMED,
          'Confirm your email address before signing in.');
      }

      // Upgrade-on-verify (D-111/D-313). We hold the plaintext exactly once — on
      // a successful login — so this is the only moment a weak hash can be
      // replaced without asking the user to reset anything.
      if (needsRehash) {
        // `min: 1` — deliberately *not* the project's policy. This password was
        // accepted when it was set, and a project that later raised its minimum
        // must not have re-hashing throw on the way through a successful login:
        // the user would be told their correct password is invalid, at a moment
        // they cannot do anything about. Policy belongs on the paths that *set* a
        // password, and nowhere else.
        await updatePasswordHash(db, user.id, await hashPassword(password, 1));
        await writeAuthAudit(db, { action: 'password_hash_upgraded', userId: user.id, ...meta });
      }

      const session = await issueSession(db, ctx, user.id, user.email, meta);
      await markSignedIn(db, user.id);
      await writeAuthAudit(db, { action: 'login', userId: user.id, ...meta });
      return reply.status(200).send({ ...session, user: publicUser(user) });
    });
  });
}

/**
 * The session + token triple every successful flow returns.
 *
 * One function rather than three copies, because the invariant it carries is easy
 * to break in one place and not notice: the access token's `session_id` must be
 * the session the refresh token belongs to. Mint them apart and you get tokens
 * that work until the first logout, which revokes a session the access token
 * never named.
 */
async function issueSession(
  db: Parameters<typeof openSession>[0], ctx: ProjectContext,
  userId: string, email: string | null,
  meta: { userAgent?: string | undefined; ip?: string | undefined },
) {
  const refresh = newRefreshToken();
  const { sessionId } = await openSession(db, { userId, refreshHash: refresh.hash, ...meta });
  const access = mintAccessToken({
    ctx, userId, email, sessionId, ttlSeconds: ctx.config.accessTtlSeconds,
  });
  return {
    access_token: access.token,
    token_type: 'bearer' as const,
    expires_in: access.expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + access.expiresIn,
    refresh_token: refresh.token,
  };
}

/**
 * The project ref, from the Host subdomain or `?ref=`.
 *
 * Only for the unauthenticated JWKS endpoint. Every other route takes the ref
 * from the *signed* apikey, which is a verified claim rather than a header the
 * caller wrote — see context.ts. Using a Host header to select a tenant on a
 * route that returns anything private would be exactly the wrong trade.
 */
export function refFromRequest(
  req: FastifyRequest, domain: string | undefined,
): string | undefined {
  const q = (req.query as { ref?: unknown } | undefined)?.ref;
  const host = String(req.headers['host'] ?? '').split(':')[0] ?? '';
  const suffix = `.${domain ?? process.env['CB_PROJECT_DOMAIN'] ?? 'corebase.co'}`;
  if (host.endsWith(suffix)) {
    const sub = host.slice(0, -suffix.length);
    if (/^[a-z0-9]{8,32}$/.test(sub)) return sub;
  }
  if (typeof q === 'string' && /^[a-z0-9]{8,32}$/.test(q)) return q;
  return undefined;
}
