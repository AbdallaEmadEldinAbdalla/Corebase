import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Client } from 'pg';
import { z } from 'zod';
import { AUTH_ERROR_CODES } from '@corebase/types';
import { toJwk } from '@corebase/jwt';
import {
  hashPassword, verifyPassword, burnVerify, validatePassword,
  PasswordFormatError, MIN_END_USER_PASSWORD_LENGTH,
} from '@corebase/crypto';
import { SECRET_NAMES } from '@corebase/secrets';
import { parsePageRequest, toPage } from '../../kernel/pagination.ts';
import { ApiError } from '../../kernel/errors.ts';
import { rateLimitKey, type RateLimiter } from '../../kernel/rate-limit.ts';
import {
  resolveProject, withProjectDb, AuthContextError,
  type ResolveDeps, type ProjectContext,
} from './context.ts';
import {
  mintAccessToken, newRefreshToken, newOneTimeToken, oneTimeHash,
  refreshHash, looksLikeRefreshToken, REFRESH_GRACE_MS,
} from './tokens.ts';
import {
  findUserByEmail, findUserById, createUser, updatePasswordHash, markSignedIn,
  openSession, writeAuthAudit, publicUser,
  issueOneTimeToken, consumeOneTimeToken, markEmailConfirmed,
  findRefreshToken, rotateRefreshToken, findChildToken, graceRotate,
  revokeSessionFamily, revokeUserSessions, listSessions, revokeOwnSession,
  updateUserMetadata, applyEmailChange, siblingConsumed, pendingEmailChange,
  clearEmailChangeTokens, consumeEitherToken,
  listUsers, adminUpdateUser, softDeleteUser, adminSignOutUser,
  type TokenType, type AuthUser,
} from './store.ts';
import { resolveRedirect, withTokenFragment } from './redirect.ts';
import { bearerFrom, requireLiveSession, type Bearer } from './bearer.ts';
import { createNullMailer, type AuthMailer } from './mail.ts';

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
  /** Where the confirmation link lands. Allowlisted, never trusted (P4c). */
  redirect_to: z.string().max(2048).optional(),
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
  /** `POST /recover` and `/resend`: 4/hour per email (P4c). */
  recoverEmailLimiter: RateLimiter;
  /** …and 10/hour per IP. */
  recoverIpLimiter: RateLimiter;
  /** `POST /verify`: 10/hour per IP. Mail-scanner prefetch counts, so it is generous. */
  verifyIpLimiter: RateLimiter;
  /** `POST /token?grant_type=refresh_token`: 60/5min per IP (P4e). */
  refreshIpLimiter: RateLimiter;
  /** Absent means owed emails are recorded and not sent — the state until P4d. */
  mailer?: AuthMailer;
}

const tooMany = (retryAfterSeconds: number) =>
  new ApiError(429, AUTH_ERROR_CODES.OVER_RATE_LIMIT,
    `Too many attempts. Try again in ${retryAfterSeconds}s.`);

/**
 * One answer for every way a refresh can fail: unknown, spent, revoked, expired,
 * banned. Distinguishing them tells an attacker holding a stolen token which of
 * those it is, which is exactly the information that would let them use it.
 */
const badGrant = () =>
  new ApiError(401, AUTH_ERROR_CODES.INVALID_GRANT, 'Invalid refresh token.');

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
  const mailer = deps.mailer ?? createNullMailer();

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
    const [pem, kid, extra] = await Promise.all([
      deps.secrets.get(row.id, SECRET_NAMES.jwtPublicKey),
      deps.secrets.get(row.id, SECRET_NAMES.jwtKid),
      // Dual-publish (P4h). During a rotation this serves the incoming key
      // *before* anything is signed with it and the outgoing one *after* it has
      // stopped — which is the entire mechanism: a verifier that caches this
      // document for ten minutes must never meet a token whose key it lacks.
      deps.pool.query<{ kid: string; public_key_pem: string }>(
        `SELECT kid, public_key_pem FROM project_signing_keys
          WHERE project_id = $1 AND status IN ('next', 'retiring')
          ORDER BY published_at`, [row.id]),
    ]);
    if (!pem || !kid) {
      throw new ApiError(503, AUTH_ERROR_CODES.UNAVAILABLE, 'This project has no keys yet.');
    }
    return reply.header('cache-control', 'public, max-age=300')
      .send({
        keys: [
          toJwk(pem, kid),
          ...extra.rows.map((r) => toJwk(r.public_key_pem, r.kid)),
        ],
      });
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

        // Flows §1 step 3b: the existing account's owner is told somebody tried.
        // It is the only channel that can say so, and it discloses nothing to
        // whoever triggered it — the mail goes to an address that already has an
        // account, so only its owner learns anything.
        //
        // An unconfirmed existing account gets its confirmation token refreshed
        // instead, because for that person this attempt is indistinguishable from
        // a legitimate retry of their own signup.
        const existing = await findUserByEmail(db, email);
        if (existing && !existing.email_confirmed_at) {
          await sendConfirmation(db, ctx, existing, parsed.data.redirect_to, meta);
        } else if (existing) {
          await mailer.enqueue({
            // Not a token id — there is no token in this branch. A uuid keyed to
            // nothing is right here: the job is genuinely one-off, and reusing
            // some other row's id would make two different mails collide on one
            // delivery key.
            deliveryId: `notice_${crypto.randomUUID()}`,
            projectId: ctx.projectId, projectRef: ctx.ref,
            email: 'account_exists_notice', to: email, variables: {},
          });
        }
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
        const sentAt = await sendConfirmation(
          db, ctx, created, parsed.data.redirect_to, meta);
        return reply.status(200).send({
          id: created.id, email: created.email,
          confirmation_sent_at: sentAt.toISOString(),
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
    if (grant === 'refresh_token') return refreshGrant(req, reply);
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

  /**
   * Flow 2 — `GET /verify` (the link in the mail) and `POST /verify` (the SDK).
   *
   * The two differ only in how they hand back the session: GET **302s** to the
   * allowlisted redirect with the tokens in the URL *fragment*, POST returns
   * them as JSON. The fragment is not incidental — it is never sent to a server,
   * so the tokens stay out of the destination's access logs, out of every proxy
   * in between, and out of the `Referer` header.
   *
   * Consuming the token on GET is a known tradeoff (OQ-114): corporate mail
   * scanners fetch every link, so a scanner's prefetch verifies the address and
   * spends the link. V1 accepts it — the redirect still goes to the allowlisted
   * page and the user is genuinely verified — and the fallback if it bites is an
   * interstitial confirm page.
   */
  const verifyTypes: Record<string, TokenType> = {
    // `signup` is what the mail links say and `confirmation` is what the column
    // stores. Both accepted, mapping to one type: a client that sends the
    // column's name is not wrong, and a 401 for a *correct* token because of a
    // vocabulary mismatch is the kind of failure nobody diagnoses from the
    // outside.
    signup: 'confirmation', confirmation: 'confirmation',
    recovery: 'recovery', magiclink: 'magic_link', magic_link: 'magic_link',
  };

  /**
   * Flow 9 steps 2–3 — consume one side of an email change.
   *
   * Its own path rather than a case in `doVerify`, because it differs in the two
   * ways that matter. It issues **no session**: the click may come from a mail
   * client on a device that was never logged in, and handing that device a
   * session for an account whose address is still changing would be a login
   * granted by a link the account owner did not necessarily intend as one. And
   * the *first* of the two confirmations does not complete anything, so there is
   * an outcome — "waiting for the other address" — that no other verify has.
   */
  async function verifyEmailChange(
    req: FastifyRequest, token: string, redirectTo: string | undefined,
  ): Promise<{ ctx: ProjectContext; redirect: string | null; state:
      'applied' | 'pending' | 'conflict' | 'invalid' }> {
    const ctx = await project(deps, req);
    const hit = await deps.verifyIpLimiter.hit(projKey(ctx, 'verify-ip', req.ip ?? 'unknown'));
    if (!hit.allowed) throw tooMany(hit.retryAfterSeconds);
    const { url: redirect } = resolveRedirect(ctx.config, redirectTo);
    const meta = clientMeta(req);

    return withProjectDb(ctx, async (db) => {
      // Across both types: the link says `email_change` and cannot say which
      // side it is, because the token is opaque and the recipient must not be
      // able to tell the two apart.
      const consumed = await consumeEitherToken(
        db, ['email_change_current', 'email_change_new'], oneTimeHash(token));
      if (!consumed || !consumed.relatesTo) {
        await writeAuthAudit(db, { action: 'verify_failed_email_change', ...meta });
        return { ctx, redirect, state: 'invalid' as const };
      }

      const other: TokenType = consumed.type === 'email_change_new'
        ? 'email_change_current' : 'email_change_new';
      const needsBoth = ctx.config.emailChangeConfirm === 'double';
      if (needsBoth && !(await siblingConsumed(db, consumed.userId, other))) {
        await writeAuthAudit(db, {
          action: 'email_change_half_confirmed', userId: consumed.userId, ...meta,
          payload: { side: consumed.type } });
        return { ctx, redirect, state: 'pending' as const };
      }

      const applied = await applyEmailChange(db, consumed.userId, consumed.relatesTo);
      if (!applied) {
        // Two users can request a change to the same address and both receive
        // their tokens; the partial unique index decides it and the loser is told
        // rather than 500'd. Tokens are cleared so they can start again.
        await clearEmailChangeTokens(db, consumed.userId);
        await writeAuthAudit(db, {
          action: 'email_change_conflict', userId: consumed.userId, ...meta,
          payload: { new_email: consumed.relatesTo } });
        return { ctx, redirect, state: 'conflict' as const };
      }
      await clearEmailChangeTokens(db, consumed.userId);
      // Every other session dies: the address a session was established under is
      // no longer the account's, and if the change was made from a hijacked
      // session the owner's own sessions going with it is the correct outcome.
      await revokeUserSessions(db, consumed.userId, 'global', '00000000-0000-0000-0000-000000000000');
      await writeAuthAudit(db, {
        action: 'email_changed', userId: consumed.userId, ...meta,
        payload: { new_email: consumed.relatesTo } });
      return { ctx, redirect, state: 'applied' as const };
    });
  }

  async function doVerify(
    req: FastifyRequest, token: string, typeParam: string,
    redirectTo: string | undefined,
  ): Promise<
    | { ok: true; ctx: ProjectContext; session: Session; user: AuthUser; redirect: string | null }
    | { ok: false; ctx: ProjectContext; redirect: string | null }
  > {
    const ctx = await project(deps, req);
    const hit = await deps.verifyIpLimiter.hit(projKey(ctx, 'verify-ip', req.ip ?? 'unknown'));
    if (!hit.allowed) throw tooMany(hit.retryAfterSeconds);

    const type = verifyTypes[typeParam];
    const { url: redirect, substituted } = resolveRedirect(ctx.config, redirectTo);
    if (!type) {
      // A type we do not issue cannot have a valid token, so this is the same
      // answer as a bad token rather than its own error — one code for every
      // reason a verification failed (flows §2).
      return { ok: false, ctx, redirect };
    }

    const meta = clientMeta(req);
    return withProjectDb(ctx, async (db) => {
      if (substituted) {
        // Audited rather than silent. Replacing the redirect is right for the
        // *user* and invisible to the *developer*, who otherwise sees "my
        // redirect is ignored" with nothing to go on — and this is also what an
        // exfiltration attempt looks like from our side.
        await writeAuthAudit(db, {
          action: 'redirect_not_allowlisted', ...meta,
          payload: { requested: redirectTo ?? null, type: typeParam },
        });
      }
      const consumed = await consumeOneTimeToken(db, type, oneTimeHash(token));
      if (!consumed) {
        await writeAuthAudit(db, { action: `verify_failed_${type}`, ...meta });
        return { ok: false as const, ctx, redirect };
      }
      const user = await findUserById(db, consumed.userId);
      if (!user) {
        // The token's own predicate excludes deleted users, so reaching here
        // means the row vanished between two statements. Treated as a failure
        // rather than crashing: a 500 on a verification link is indistinguishable
        // from "our email is broken" to the person holding it.
        await writeAuthAudit(db, { action: `verify_failed_${type}`, ...meta });
        return { ok: false as const, ctx, redirect };
      }

      // Confirming the address is part of *every* successful verify, not just
      // `signup`. A recovery link proves control of the mailbox exactly as well
      // as a confirmation link does, and leaving an unconfirmed user unconfirmed
      // after they proved it means their password reset ends at a login that
      // refuses them for `email_not_confirmed`.
      await markEmailConfirmed(db, user.id);
      // `amr: ['recovery']` on this token and no other (P4f). It is what lets
      // `PUT /user` take a new password with no `current_password`, and it lives
      // only as long as this token — a refresh does not carry it forward, so the
      // capability expires in an hour at most rather than lasting the session.
      const session = await issueSession(db, ctx, user.id, user.email, meta,
        type === 'recovery' ? ['recovery'] : undefined);
      await markSignedIn(db, user.id);
      await writeAuthAudit(db, {
        action: `verify_${type}`, userId: user.id, ...meta,
        payload: { token_id: consumed.id },
      });
      const fresh = (await findUserById(db, user.id)) ?? user;
      return { ok: true as const, ctx, session, user: fresh, redirect };
    });
  }

  app.get('/auth/v1/verify', async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    if (!q['token'] || !q['type']) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'A verification link needs `token` and `type`.');
    }
    if (q['type'] === 'email_change') {
      const out = await verifyEmailChange(req, q['token'], q['redirect_to']);
      if (!out.redirect) {
        return emailChangeBody(reply, out.state, req);
      }
      // No tokens in the fragment: this path issues no session, so there is
      // nothing to hand over — only which of the four things happened.
      return reply.status(302)
        .header('location', withTokenFragment(out.redirect, {
          type: 'email_change',
          ...(out.state === 'applied' ? { email_change: 'complete' }
            : out.state === 'pending' ? { email_change: 'pending' }
            : { error: out.state === 'conflict' ? 'email_exists' : 'invalid_token' }),
        }))
        .send();
    }
    const out = await doVerify(req, q['token'], q['type'], q['redirect_to']);
    if (!out.redirect) {
      // Nowhere to send them: the project configured no `site_url`, so there is
      // no allowlisted destination and inventing one would be the open redirect
      // this whole module exists to prevent. Answer in JSON instead of guessing.
      return out.ok
        ? reply.status(200).send({ ...out.session, user: publicUser(out.user) })
        : reply.status(401).send({
            error: {
              code: AUTH_ERROR_CODES.INVALID_TOKEN,
              message: 'This link is invalid or has already been used.',
              request_id: String(reply.getHeader('x-request-id') ?? req.id),
            },
          });
    }
    const target = out.ok
      ? withTokenFragment(out.redirect, {
          access_token: out.session.access_token,
          refresh_token: out.session.refresh_token,
          expires_in: out.session.expires_in,
          token_type: 'bearer',
          type: String((req.query as Record<string, string>)['type']),
        })
      // One generic error in the fragment, for the same reason the JSON form has
      // one code: which of unknown/spent/expired it was is not the user's
      // business and is an oracle for ours.
      : withTokenFragment(out.redirect, { error: 'invalid_token' });
    return reply.status(302).header('location', target).send();
  });

  app.post('/auth/v1/verify', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body['token'] === 'string' ? body['token'] : undefined;
    const type = typeof body['type'] === 'string' ? body['type'] : undefined;
    if (!token || !type) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Provide `token` and `type`.');
    }
    if (type === 'email_change') {
      const out = await verifyEmailChange(req, token, undefined);
      return emailChangeBody(reply, out.state, req);
    }
    const out = await doVerify(req, token, type, undefined);
    if (!out.ok) {
      throw new ApiError(401, AUTH_ERROR_CODES.INVALID_TOKEN,
        'This link is invalid or has already been used.');
    }
    return reply.status(200).send({ ...out.session, user: publicUser(out.user) });
  });

  /**
   * Flow 6 — `POST /recover`: request a password-reset mail.
   *
   * **Always 200 with an empty body**, whether or not the address exists. This is
   * the second classic enumeration oracle after signup, and it is a worse one:
   * signup at least has to guess a password, while `/recover` is a bare
   * "does this person have an account" endpoint if it answers honestly.
   *
   * Both rate-limit buckets matter for a reason that is not brute force: the
   * per-email bucket stops *targeted flooding* of one person's inbox, and the
   * per-IP bucket protects the shared sending domain's reputation, which every
   * project on the platform shares (D-116).
   */
  app.post('/auth/v1/recover', async (req, reply) => {
    const ctx = await project(deps, req);
    const parsed = z.object({ email: emailSchema, redirect_to: z.string().max(2048).optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED, 'Provide a valid `email`.');
    }
    const email = parsed.data.email;
    for (const [limiter, bucket, id] of [
      [deps.recoverEmailLimiter, 'recover-email', email.toLowerCase()],
      [deps.recoverIpLimiter, 'recover-ip', req.ip ?? 'unknown'],
    ] as const) {
      const hit = await limiter.hit(projKey(ctx, bucket, id));
      // A 429 here *is* a disclosure — but of our rate limit, not of the
      // account: the bucket is keyed on the address the caller supplied, and it
      // fills identically for an address that exists and one that does not.
      if (!hit.allowed) throw tooMany(hit.retryAfterSeconds);
    }

    const meta = clientMeta(req);
    await withProjectDb(ctx, async (db) => {
      const user = await findUserByEmail(db, email);
      if (!user) {
        await writeAuthAudit(db, { action: 'recover_unknown_email', ...meta });
        return;
      }
      const t = newOneTimeToken();
      const { expiresAt } = await issueOneTimeToken(
        db, { userId: user.id, type: 'recovery', hash: t.hash });
      // Validated *before* it goes into the link, not only when the link is
      // followed. The first version of this passed `parsed.data.redirect_to`
      // straight through, which would have put an attacker-chosen destination
      // into a mail Corebase sends from its own domain — the one thing D-116's
      // fixed templates exist to make impossible.
      const { url: dest, substituted } = resolveRedirect(ctx.config, parsed.data.redirect_to);
      if (substituted) {
        await writeAuthAudit(db, {
          action: 'redirect_not_allowlisted', userId: user.id, ...meta,
          payload: { requested: parsed.data.redirect_to ?? null, type: 'recovery' },
        });
      }
      const link = actionLink(ctx, t.token, 'recovery', dest ?? undefined);
      await mailer.enqueue({
        deliveryId: `recovery_${user.id}`,
        projectId: ctx.projectId, projectRef: ctx.ref,
        email: 'recovery', to: email,
        variables: { action_url: link, expires_at: expiresAt.toISOString() },
      });
      await writeAuthAudit(db, { action: 'recover_requested', userId: user.id, ...meta });
    });
    // Empty object, not `{ok: true}` or a message: the body is part of the
    // same-shape contract, so it must not vary and must not be worth reading.
    return reply.status(200).send({});
  });

  /**
   * `POST /resend`: re-issue a confirmation mail.
   *
   * Same-shape 200 as `/recover`, and for the same reason. Worth noting what the
   * upsert in `issueOneTimeToken` buys here: each resend *replaces* the previous
   * token, so ten resends leave one working link rather than ten. A user who
   * clicks the first of five mails gets a dead link, which is the correct
   * tradeoff — the alternative is five live credentials in an inbox.
   */
  app.post('/auth/v1/resend', async (req, reply) => {
    const ctx = await project(deps, req);
    const parsed = z.object({
      email: emailSchema,
      type: z.enum(['signup', 'confirmation']).optional(),
      redirect_to: z.string().max(2048).optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED, 'Provide a valid `email`.');
    }
    const email = parsed.data.email;
    for (const [limiter, bucket, id] of [
      [deps.recoverEmailLimiter, 'resend-email', email.toLowerCase()],
      [deps.recoverIpLimiter, 'resend-ip', req.ip ?? 'unknown'],
    ] as const) {
      const hit = await limiter.hit(projKey(ctx, bucket, id));
      if (!hit.allowed) throw tooMany(hit.retryAfterSeconds);
    }

    const meta = clientMeta(req);
    await withProjectDb(ctx, async (db) => {
      const user = await findUserByEmail(db, email);
      // An already-confirmed address gets nothing — not an error, and not a mail
      // either. Re-sending a confirmation to someone already confirmed is a way
      // to make our sending domain deliver mail on demand to any address that
      // happens to be registered.
      if (!user || user.email_confirmed_at) {
        await writeAuthAudit(db, {
          action: user ? 'resend_already_confirmed' : 'resend_unknown_email',
          ...(user ? { userId: user.id } : {}), ...meta,
        });
        return;
      }
      await sendConfirmation(db, ctx, user, parsed.data.redirect_to, meta);
      await writeAuthAudit(db, { action: 'resend_confirmation', userId: user.id, ...meta });
    });
    return reply.status(200).send({});
  });

  /**
   * Issue a confirmation token and hand its mail over. Shared by signup and
   * resend so the two cannot drift — a confirmation link built two ways is a
   * link that works from one endpoint and not the other.
   */
  async function sendConfirmation(
    db: Client, ctx: ProjectContext, user: AuthUser,
    redirectTo: string | undefined,
    meta: { userAgent?: string | undefined; ip?: string | undefined },
  ): Promise<Date> {
    const t = newOneTimeToken();
    const { expiresAt } = await issueOneTimeToken(
      db, { userId: user.id, type: 'confirmation', hash: t.hash });
    const { url, substituted } = resolveRedirect(ctx.config, redirectTo);
    if (substituted) {
      await writeAuthAudit(db, {
        action: 'redirect_not_allowlisted', userId: user.id, ...meta,
        payload: { requested: redirectTo ?? null, type: 'signup' },
      });
    }
    await mailer.enqueue({
      // The token id would be better still, but the upsert makes (user, type)
      // the stable identity of "the confirmation link currently owed to this
      // person" — which is exactly the deduplication a delivery id is for.
      deliveryId: `confirmation_${user.id}`,
      projectId: ctx.projectId, projectRef: ctx.ref,
      email: 'confirmation', to: user.email ?? '',
      variables: {
        action_url: actionLink(ctx, t.token, 'signup', url ?? undefined),
        expires_at: expiresAt.toISOString(),
      },
    });
    return new Date();
  }

  /**
   * Flow 4 — `POST /token?grant_type=refresh_token` (D-112).
   *
   * The protocol in one place, because every branch of it is a security decision:
   *
   *  - unknown, revoked, or a revoked session → `401 invalid_grant`, one code for
   *    all of them;
   *  - idle-expired session → revoke it, same 401;
   *  - unspent → rotate: spend it, mint a child, bump `last_refreshed_at`;
   *  - **spent within 10 s** → a network race, not an attack. Mobile clients on
   *    flaky networks genuinely retry, and two SPA tabs race. Zero tolerance turns
   *    those into forced logouts at a rate that teaches developers to switch
   *    rotation off, which is strictly worse than the window;
   *  - **spent longer ago** → theft. Somebody is replaying an old token, and
   *    whether it is the attacker or the victim who trips it is unknowable and
   *    irrelevant: the whole session family dies and both must re-authenticate.
   *    The attacker's stolen lineage dies with it.
   */
  async function refreshGrant(req: FastifyRequest, reply: FastifyReply) {
    const ctx = await project(deps, req);
    const hit = await deps.refreshIpLimiter.hit(projKey(ctx, 'refresh-ip', req.ip ?? 'unknown'));
    if (!hit.allowed) throw tooMany(hit.retryAfterSeconds);

    const body = (req.body ?? {}) as { refresh_token?: unknown };
    const presented = body.refresh_token;
    // A cheap shape reject before any database work: a value that is not one of
    // ours cannot match a hash, and hashing it to find that out costs a connect.
    if (!looksLikeRefreshToken(presented)) throw badGrant();

    const meta = clientMeta(req);
    return withProjectDb(ctx, async (db) => {
      const row = await findRefreshToken(db, refreshHash(presented));
      if (!row || row.revoked || row.sessionRevokedAt) {
        await writeAuthAudit(db, {
          action: 'refresh_failed', ...meta,
          ...(row ? { userId: row.userId } : {}),
          payload: { reason: !row ? 'unknown' : row.revoked ? 'token_revoked' : 'session_revoked' },
        });
        throw badGrant();
      }

      // Idle expiry measured from the last refresh, falling back to session
      // creation: a session that has never been refreshed is as old as it looks,
      // and treating a NULL as "never idle" would make an unrefreshed session
      // immortal.
      const idleFrom = row.lastRefreshedAt ?? row.sessionCreatedAt;
      if (Date.now() - idleFrom.getTime() > ctx.config.sessionIdleSeconds * 1000) {
        await revokeSessionFamily(db, row.sessionId);
        await writeAuthAudit(db, {
          action: 'refresh_failed', userId: row.userId, ...meta,
          payload: { reason: 'session_idle_expired' } });
        throw badGrant();
      }

      const user = await findUserById(db, row.userId);
      if (!user) {
        // Deleted or banned since the session began. Refresh is where a ban is
        // enforced in V1 (D-113): there is no per-request session check, so a
        // banned user survives at most one access-token lifetime.
        await revokeSessionFamily(db, row.sessionId);
        await writeAuthAudit(db, {
          action: 'refresh_failed', userId: row.userId, ...meta,
          payload: { reason: 'user_gone' } });
        throw badGrant();
      }
      if (user.banned_until && user.banned_until.getTime() > Date.now()) {
        await revokeSessionFamily(db, row.sessionId);
        await writeAuthAudit(db, {
          action: 'refresh_failed_banned', userId: row.userId, ...meta });
        throw badGrant();
      }

      const fresh = newRefreshToken();

      if (row.usedAt === null) {
        const rotated = await rotateRefreshToken(db, {
          tokenId: row.id, sessionId: row.sessionId, userId: row.userId,
          childHash: fresh.hash });
        // No row back means another request spent it between our read and our
        // write. Not an error and not a theft signal: fall through to the
        // already-spent handling, which is where the race belongs.
        if (rotated) {
          const access = mintAccessToken({
            ctx, userId: user.id, email: user.email, sessionId: row.sessionId,
            ttlSeconds: ctx.config.accessTtlSeconds });
          await writeAuthAudit(db, { action: 'token_refreshed', userId: user.id, ...meta });
          return reply.status(200).send({
            access_token: access.token, token_type: 'bearer',
            expires_in: access.expiresIn,
            expires_at: Math.floor(Date.now() / 1000) + access.expiresIn,
            refresh_token: fresh.token, user: publicUser(user),
          });
        }
        // Re-read, so the grace decision below is made against the row as it now
        // is rather than as it was.
        const again = await findRefreshToken(db, refreshHash(presented));
        if (!again || again.usedAt === null) throw badGrant();
        row.usedAt = again.usedAt;
      }

      const spentAgo = Date.now() - row.usedAt.getTime();
      if (spentAgo <= REFRESH_GRACE_MS) {
        const child = await findChildToken(db, row.id);
        if (child && !child.usedAt && !child.revoked) {
          const replaced = await graceRotate(db, {
            parentId: row.id, oldChildId: child.id,
            sessionId: row.sessionId, userId: row.userId, childHash: fresh.hash });
          if (replaced) {
            const access = mintAccessToken({
              ctx, userId: user.id, email: user.email, sessionId: row.sessionId,
              ttlSeconds: ctx.config.accessTtlSeconds });
            await writeAuthAudit(db, {
              action: 'token_refresh_replayed', userId: user.id, ...meta,
              payload: { spent_ago_ms: spentAgo } });
            return reply.status(200).send({
              access_token: access.token, token_type: 'bearer',
              expires_in: access.expiresIn,
              expires_at: Math.floor(Date.now() / 1000) + access.expiresIn,
              refresh_token: fresh.token, user: publicUser(user),
            });
          }
        }
        // The child is already spent (or gone), so this is not a lost-response
        // retry — the lineage has moved on and something is replaying an old
        // link in it. Fall through.
      }

      // Theft. Which party tripped it is unknowable — the attacker used the
      // stolen token first and the client's next legitimate refresh lands here,
      // or the reverse — and it does not matter: the family dies either way.
      await revokeSessionFamily(db, row.sessionId);
      await writeAuthAudit(db, {
        action: 'token_reuse_detected', userId: row.userId, ...meta,
        payload: { spent_ago_ms: spentAgo, session_id: row.sessionId } });
      throw badGrant();
    });
  }

  /**
   * Flow 5 — `POST /logout[?scope=local|global|others]`.
   *
   * 204 even when the session is already revoked. Logout is the one operation a
   * client must be able to complete unconditionally: an error here leaves an
   * application unable to sign a user out, and there is nothing to protect —
   * revoking an already-revoked session changes nothing.
   */
  app.post('/auth/v1/logout', async (req, reply) => {
    const ctx = await project(deps, req);
    const bearer = bearerFrom(req, ctx);
    const scopeParam = (req.query as { scope?: unknown } | undefined)?.scope;
    const scope = scopeParam === 'global' || scopeParam === 'others' ? scopeParam : 'local';
    const meta = clientMeta(req);

    await withProjectDb(ctx, async (db) => {
      const revoked = await revokeUserSessions(db, bearer.userId, scope, bearer.sessionId);
      await writeAuthAudit(db, {
        action: 'logout', userId: bearer.userId, ...meta,
        payload: { scope, sessions_revoked: revoked } });
    });
    // No body. The client discards both tokens; the access token it just threw
    // away stays cryptographically valid until `exp` (D-113) and its session is
    // dead from this instant, which is the honest description.
    return reply.status(204).send();
  });

  /**
   * `GET /auth/v1/sessions` — the bearer's own live sessions.
   *
   * This is the screen a user checks after a scare, so the fields are the ones
   * that let them recognise a device they do not own: when it started, when it was
   * last used, its user agent and its address. The current session is flagged,
   * because "which of these is me" is otherwise unanswerable and revoking the
   * wrong one is a self-inflicted logout.
   */
  app.get('/auth/v1/sessions', async (req, reply) => {
    const ctx = await project(deps, req);
    const bearer = bearerFrom(req, ctx);
    return withProjectDb(ctx, async (db) => {
      await requireLiveSession(db, bearer);
      const rows = await listSessions(db, bearer.userId);
      return reply.status(200).send({
        sessions: rows.map((s) => ({
          id: s.id,
          created_at: s.createdAt.toISOString(),
          last_refreshed_at: s.lastRefreshedAt?.toISOString() ?? null,
          user_agent: s.userAgent,
          ip: s.ip,
          current: s.id === bearer.sessionId,
        })),
      });
    });
  });

  /**
   * `DELETE /auth/v1/sessions/:id` — revoke one.
   *
   * 404 for a session that is not the caller's, rather than 403. The two are
   * distinguishable only to someone probing for which session ids exist, and a
   * session id is not a secret worth confirming.
   */
  app.delete('/auth/v1/sessions/:id', async (req, reply) => {
    const ctx = await project(deps, req);
    const bearer = bearerFrom(req, ctx);
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED, 'That is not a session id.');
    }
    const meta = clientMeta(req);
    return withProjectDb(ctx, async (db) => {
      await requireLiveSession(db, bearer);
      const done = await revokeOwnSession(db, id, bearer.userId);
      if (!done) {
        throw new ApiError(404, AUTH_ERROR_CODES.VALIDATION_FAILED, 'No such session.');
      }
      await writeAuthAudit(db, {
        action: 'session_revoked', userId: bearer.userId, ...meta,
        payload: { session_id: id, self: id === bearer.sessionId } });
      return reply.status(204).send();
    });
  });

  /**
   * `GET /auth/v1/user` — the bearer's own user object.
   *
   * The same allowlist every other endpoint returns (`publicUser`), read fresh
   * from the database rather than reconstructed from the token's claims. The
   * difference matters: a token issued an hour ago carries the email the user had
   * an hour ago, and this endpoint exists precisely so a client can find out what
   * changed.
   */
  app.get('/auth/v1/user', async (req, reply) => {
    const ctx = await project(deps, req);
    const bearer = bearerFrom(req, ctx);
    return withProjectDb(ctx, async (db) => {
      await requireLiveSession(db, bearer);
      const user = await findUserById(db, bearer.userId);
      // The session was live a statement ago, so a missing user means it was
      // deleted between the two. 401 rather than 404: the caller's credential is
      // what stopped being valid.
      if (!user) throw new ApiError(401, AUTH_ERROR_CODES.UNAUTHORIZED,
        'That access token is not valid.');
      const pending = await pendingEmailChange(db, user.id);
      return reply.status(200).send({
        ...publicUser(user),
        // Surfaced because a client otherwise cannot tell that a change is
        // half-confirmed, and "I clicked the link and nothing happened" is the
        // support ticket that follows.
        new_email: pending ?? null,
      });
    });
  });

  /**
   * `PUT /auth/v1/user` — password, email, or metadata (flows §7, §8, §9).
   *
   * ## The `current_password` rule is the security content
   *
   * Changing a password requires the current one (Flow 8 step 2), and the reason
   * is narrow and important: **a stolen access token alone must not be
   * convertible into permanent account ownership.** An attacker with a token
   * lifted from `localStorage` has at most an hour; one who can set the password
   * has forever.
   *
   * The single exception is a token minted by a recovery link, which carries
   * `amr: ["recovery"]` — that holder has proved control of the mailbox, which is
   * the same proof a password would give. It is checked on the **claim**, not on
   * the session, and that is deliberate: the capability dies with the token that
   * carried it (an hour at most, and not across a refresh) rather than lasting the
   * session's thirty days. A recovery link should be spent in seconds.
   *
   * ## Why an email change is not applied here
   *
   * `PUT /user {email}` only *proposes* one. Flow 9's double confirmation is the
   * whole mechanism, and applying the change on request would be the bug it exists
   * to prevent.
   */
  app.put('/auth/v1/user', async (req, reply) => {
    const ctx = await project(deps, req);
    const bearer = bearerFrom(req, ctx);
    const parsed = z.object({
      password: z.string().optional(),
      current_password: z.string().optional(),
      email: emailSchema.optional(),
      /** Merged into `raw_user_meta_data`. Never trusted for authorization. */
      data: z.record(z.unknown()).optional(),
      redirect_to: z.string().max(2048).optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Send some of `password`, `email` or `data`.');
    }
    const body = parsed.data;
    if (!body.password && !body.email && !body.data) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Nothing to change: send `password`, `email` or `data`.');
    }
    const meta = clientMeta(req);

    return withProjectDb(ctx, async (db) => {
      await requireLiveSession(db, bearer);
      const user = await findUserById(db, bearer.userId);
      if (!user) throw new ApiError(401, AUTH_ERROR_CODES.UNAUTHORIZED,
        'That access token is not valid.');

      if (body.password) {
        const viaRecovery = bearer.amr.includes('recovery');
        if (!viaRecovery) {
          if (!body.current_password) {
            throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
              'Send `current_password` to change your password.');
          }
          // Timing-safe, and against the decoy when the account somehow has no
          // password at all — so an OAuth-only user (once those exist) cannot be
          // distinguished from one whose password was simply wrong.
          const ok = user.encrypted_password
            ? (await verifyPassword(body.current_password, user.encrypted_password)).ok
            : (await burnVerify(body.current_password), false);
          if (!ok) {
            await writeAuthAudit(db, {
              action: 'password_change_failed', userId: user.id, ...meta });
            throw badCredentials();
          }
        }

        const min = Math.max(MIN_END_USER_PASSWORD_LENGTH, ctx.config.passwordMinLength);
        let hash: string;
        try {
          hash = await hashPassword(body.password, min);
        } catch (err) {
          if (err instanceof PasswordFormatError) {
            // Flows §7 notes the cost honestly: on the recovery path the token
            // is already spent, so a rejected new password means starting the
            // reset again. Acceptable and rare — and far better than accepting a
            // password below the project's own floor.
            throw new ApiError(422, AUTH_ERROR_CODES.WEAK_PASSWORD, (err as Error).message);
          }
          throw err;
        }
        await updatePasswordHash(db, user.id, hash);

        // Every other session dies. A reset usually means "someone may have my
        // password", and a change usually means the same suspicion — so every
        // existing session is presumed hostile. The current one survives, or the
        // user is logged out by their own security action, which is the fastest
        // way to teach people not to change their password.
        const revoked = await revokeUserSessions(db, user.id, 'others', bearer.sessionId);
        await writeAuthAudit(db, {
          action: viaRecovery ? 'password_reset' : 'password_changed',
          userId: user.id, ...meta,
          payload: { sessions_revoked: revoked, via_recovery: viaRecovery } });

        // The tripwire. This is the mail that tells the real owner an attacker
        // completed a reset, so it goes out on *both* paths and it is the one
        // notice a user cannot opt out of.
        if (user.email) {
          await mailer.enqueue({
            deliveryId: `pwchanged_${user.id}_${Date.now()}`,
            projectId: ctx.projectId, projectRef: ctx.ref,
            email: 'password_changed_notice', to: user.email, variables: {},
          });
        }
      }

      if (body.email) {
        if (user.email && body.email.toLowerCase() === user.email.toLowerCase()) {
          throw new ApiError(422, AUTH_ERROR_CODES.VALIDATION_FAILED,
            'That is already your email address.');
        }
        // Deliberately *not* checked for availability here. Answering "that
        // address is taken" to a logged-in user turns `PUT /user` into the
        // enumeration oracle that signup and `/recover` were carefully built to
        // avoid — with the same effort and one account. The collision is caught
        // when the change is applied, by the unique index.
        await proposeEmailChange(db, ctx, user, body.email, body.redirect_to, meta);
      }

      if (body.data) {
        // `raw_app_meta_data` is untouchable from here by construction: the store
        // function only writes the user half. A user who could write the app half
        // could grant themselves whatever a policy reads from it.
        await updateUserMetadata(db, user.id, body.data);
        await writeAuthAudit(db, {
          action: 'user_metadata_updated', userId: user.id, ...meta,
          payload: { keys: Object.keys(body.data) } });
      }

      const fresh = (await findUserById(db, user.id)) ?? user;
      const pending = await pendingEmailChange(db, user.id);
      return reply.status(body.email && !body.password && !body.data ? 202 : 200).send({
        ...publicUser(fresh), new_email: pending ?? null });
    });
  });

  /**
   * Propose an email change: two tokens, two mails, one pending state.
   *
   * The old address gets `email_change_current` and the new one
   * `email_change_new`, both 24 h and single-use, and the *new* address is carried
   * in `relates_to` rather than applied — so until both are spent the account's
   * email is unchanged and a half-finished change leaves nothing broken.
   *
   * `new_only` skips the old-address token entirely rather than issuing one and
   * ignoring it: an unspendable token in the table would make `siblingConsumed`
   * permanently false and the change could never complete.
   */
  async function proposeEmailChange(
    db: Client, ctx: ProjectContext, user: AuthUser, newEmail: string,
    redirectTo: string | undefined,
    meta: { userAgent?: string | undefined; ip?: string | undefined },
  ): Promise<void> {
    const { url } = resolveRedirect(ctx.config, redirectTo);
    const double = ctx.config.emailChangeConfirm === 'double';

    const toNew = newOneTimeToken();
    await issueOneTimeToken(db, {
      userId: user.id, type: 'email_change_new', hash: toNew.hash, relatesTo: newEmail });
    await mailer.enqueue({
      deliveryId: `emailchange_new_${user.id}`,
      projectId: ctx.projectId, projectRef: ctx.ref,
      email: 'email_change_new', to: newEmail,
      variables: {
        action_url: actionLink(ctx, toNew.token, 'email_change', url ?? undefined),
        new_email: newEmail,
      },
    });

    if (double && user.email) {
      const toOld = newOneTimeToken();
      await issueOneTimeToken(db, {
        userId: user.id, type: 'email_change_current', hash: toOld.hash,
        relatesTo: newEmail });
      await mailer.enqueue({
        deliveryId: `emailchange_current_${user.id}`,
        projectId: ctx.projectId, projectRef: ctx.ref,
        email: 'email_change_current', to: user.email,
        variables: {
          action_url: actionLink(ctx, toOld.token, 'email_change', url ?? undefined),
          new_email: newEmail,
        },
      });
    } else {
      // A previous double-confirmation attempt may have left one; it must not
      // block a change requested under the relaxed policy.
      await db.query(
        `DELETE FROM auth.one_time_tokens
          WHERE user_id = $1 AND token_type = 'email_change_current'`, [user.id]);
    }

    await writeAuthAudit(db, {
      action: 'email_change_requested', userId: user.id, ...meta,
      payload: { new_email: newEmail, confirm: ctx.config.emailChangeConfirm } });
  }

  /**
   * `/auth/v1/admin/users` — the developer's own user management (D-114).
   *
   * ## Why this surface has different rules from every other one
   *
   * It is authorised by the **service_role** key, which is the customer's own
   * server-side credential. So the enumeration resistance that shapes signup,
   * `/recover` and `PUT /user` is pointless here and is deliberately absent: a
   * caller holding service_role can already read every row in the schema, so
   * refusing to confirm that a user id exists would protect nothing and make the
   * surface unusable. Flow 10 says so explicitly — "the admin surface is not
   * enumeration-sensitive" — and that is why `404 user_not_found` is the right
   * answer here and would be a leak anywhere else in this file.
   *
   * The corollary is that the key check is the *only* thing standing between an
   * anon key and every user's account, so it is checked first, on every route,
   * before anything else happens.
   */
  const requireServiceRole = (ctx: ProjectContext) => {
    if (ctx.keyRole !== 'service_role') {
      // 403 rather than 401: the credential presented is valid, it is simply not
      // this one. A 401 would send a developer to check whether their key was
      // expired when the answer is that they used the published one.
      throw new ApiError(403, AUTH_ERROR_CODES.UNAUTHORIZED,
        'This endpoint needs the project\'s service_role key, not the anon key.');
    }
  };

  const adminUserView = (u: AuthUser) => ({
    ...publicUser(u),
    // Two fields the user-facing object deliberately omits. A developer managing
    // their own users needs to see a ban and needs to see the metadata half they
    // control; an end user has no business reading either about themselves.
    banned_until: u.banned_until?.toISOString() ?? null,
    app_metadata: u.raw_app_meta_data,
  });

  app.get('/auth/v1/admin/users', async (req, reply) => {
    const ctx = await project(deps, req);
    requireServiceRole(ctx);
    const page = parsePageRequest((req.query ?? {}) as Record<string, unknown>);
    return withProjectDb(ctx, async (db) => {
      const rows = await listUsers(db, page);
      const out = toPage(rows, page.limit, (u) => ({
        created_at: u.created_at.toISOString(), id: u.id }));
      return reply.status(200).send({
        users: out.items.map(adminUserView),
        pagination: out.pagination,
      });
    });
  });

  app.get('/auth/v1/admin/users/:id', async (req, reply) => {
    const ctx = await project(deps, req);
    requireServiceRole(ctx);
    const id = adminUserId(req);
    return withProjectDb(ctx, async (db) => {
      const user = await findUserById(db, id);
      if (!user) throw notSuchUser();
      return reply.status(200).send(adminUserView(user));
    });
  });

  /**
   * `POST /admin/users` — create a user directly.
   *
   * The endpoint a migration script uses, so it does the two things signup cannot:
   * it can mark the address confirmed without an email round trip, and it can
   * write `app_metadata`. It also answers **422 on a duplicate address** rather
   * than signup's same-shape 200 — the decoy exists to protect an anonymous
   * caller's privacy, and here the caller is the address's own custodian, so
   * hiding the collision from them would just make imports fail silently.
   */
  app.post('/auth/v1/admin/users', async (req, reply) => {
    const ctx = await project(deps, req);
    requireServiceRole(ctx);
    const parsed = z.object({
      email: emailSchema,
      password: z.string().optional(),
      email_confirm: z.boolean().optional(),
      user_metadata: z.record(z.unknown()).optional(),
      app_metadata: z.record(z.unknown()).optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Provide a valid `email`, and optionally `password`, `email_confirm`, '
        + '`user_metadata`, `app_metadata`.');
    }
    const b = parsed.data;
    const min = Math.max(MIN_END_USER_PASSWORD_LENGTH, ctx.config.passwordMinLength);
    let hash: string | undefined;
    if (b.password !== undefined) {
      try {
        hash = await hashPassword(b.password, min);
      } catch (err) {
        if (err instanceof PasswordFormatError) {
          throw new ApiError(422, AUTH_ERROR_CODES.WEAK_PASSWORD, (err as Error).message);
        }
        throw err;
      }
    }
    const meta = clientMeta(req);

    return withProjectDb(ctx, async (db) => {
      const created = await createUser(db, {
        email: b.email,
        // NULL, not an empty string. A user with no password is a legitimate
        // state — an imported account awaiting a reset, or one that will only
        // ever sign in through a provider — and `''` would be a value that means
        // "absent", which the login path's own NULL check would then miss.
        passwordHash: hash ?? null,
        emailConfirmed: b.email_confirm ?? false,
        ...(b.user_metadata ? { userMetadata: b.user_metadata } : {}),
      });
      if (!created) {
        await writeAuthAudit(db, {
          action: 'admin_create_user_duplicate', ...meta,
          payload: { email: b.email } });
        throw new ApiError(422, AUTH_ERROR_CODES.VALIDATION_FAILED,
          'A user with that email address already exists.');
      }
      const withApp = b.app_metadata
        ? await adminUpdateUser(db, created.id, { appMetadata: b.app_metadata })
        : created;
      await writeAuthAudit(db, {
        action: 'admin_create_user', userId: created.id, ...meta,
        payload: { email_confirm: b.email_confirm ?? false } });
      return reply.status(201).send(adminUserView(withApp ?? created));
    });
  });

  /**
   * `PUT /admin/users/:id` — ban, unban, confirm, set a password, write metadata.
   *
   * A ban is enforced at **login and at refresh**, not per request (D-113): there
   * is no session lookup on the data plane, so a banned user's already-issued
   * access token keeps working until it expires — up to an hour by default. That
   * is why banning also revokes every session here: it makes the ban immediate
   * for everything except one outstanding token, which is the tightest guarantee
   * a stateless token allows. A developer who needs it tighter configures a
   * shorter `exp`.
   */
  app.put('/auth/v1/admin/users/:id', async (req, reply) => {
    const ctx = await project(deps, req);
    requireServiceRole(ctx);
    const id = adminUserId(req);
    const parsed = z.object({
      email: emailSchema.optional(),
      password: z.string().optional(),
      email_confirm: z.boolean().optional(),
      /** ISO timestamp, or null to lift a ban. */
      ban_until: z.string().datetime().nullable().optional(),
      user_metadata: z.record(z.unknown()).optional(),
      app_metadata: z.record(z.unknown()).optional(),
      /** Revoke every session without changing the account. */
      sign_out: z.boolean().optional(),
    }).strict().safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED,
        'Send some of `email`, `password`, `email_confirm`, `ban_until`, '
        + '`user_metadata`, `app_metadata`, `sign_out`.');
    }
    const b = parsed.data;
    if (!Object.keys(b).length) {
      throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED, 'Nothing to change.');
    }

    const min = Math.max(MIN_END_USER_PASSWORD_LENGTH, ctx.config.passwordMinLength);
    let hash: string | undefined;
    if (b.password !== undefined) {
      try {
        hash = await hashPassword(b.password, min);
      } catch (err) {
        if (err instanceof PasswordFormatError) {
          throw new ApiError(422, AUTH_ERROR_CODES.WEAK_PASSWORD, (err as Error).message);
        }
        throw err;
      }
    }
    const meta = clientMeta(req);

    return withProjectDb(ctx, async (db) => {
      const banned = b.ban_until === undefined ? undefined
        : b.ban_until === null ? null : new Date(b.ban_until);
      const updated = await adminUpdateUser(db, id, {
        ...(b.email !== undefined ? { email: b.email } : {}),
        ...(hash !== undefined ? { passwordHash: hash } : {}),
        ...(b.email_confirm !== undefined ? { emailConfirm: b.email_confirm } : {}),
        ...(banned !== undefined ? { bannedUntil: banned } : {}),
        ...(b.user_metadata !== undefined ? { userMetadata: b.user_metadata } : {}),
        ...(b.app_metadata !== undefined ? { appMetadata: b.app_metadata } : {}),
      });
      if (!updated) throw notSuchUser();

      // A ban, a password change and an explicit sign-out all end every session.
      // A password set by an admin is the same suspicion as one set by the user
      // (flows §8), and a ban that leaves sessions refreshing is not a ban.
      const shouldSignOut = b.sign_out === true
        || hash !== undefined
        || (banned instanceof Date && banned.getTime() > Date.now());
      let revoked = 0;
      if (shouldSignOut) revoked = await adminSignOutUser(db, id);

      await writeAuthAudit(db, {
        action: 'admin_update_user', userId: id, ...meta,
        payload: {
          fields: Object.keys(b), sessions_revoked: revoked,
          ...(banned !== undefined ? { banned: banned !== null } : {}),
        },
      });
      const fresh = (await findUserById(db, id)) ?? updated;
      return reply.status(200).send(adminUserView(fresh));
    });
  });

  /**
   * Flow 10 — `DELETE /admin/users/:id`.
   *
   * Soft, with a tombstone, and no cascade into the customer's schemas. Their
   * tables reference `auth.users(id)` under their own FK semantics; deciding what
   * happens to a customer's data is not ours to do, and a hard delete would
   * either break those references or force that decision.
   *
   * Developer-initiated only in V1 (D-114). `DELETE /user` — an end user deleting
   * their own account, with re-auth and a grace window — needs product choices
   * that do not gate V1.
   */
  app.delete('/auth/v1/admin/users/:id', async (req, reply) => {
    const ctx = await project(deps, req);
    requireServiceRole(ctx);
    const id = adminUserId(req);
    const meta = clientMeta(req);
    return withProjectDb(ctx, async (db) => {
      const gone = await softDeleteUser(db, id);
      if (!gone) throw notSuchUser();
      // The audit row keeps the address the tombstone destroyed, because "which
      // account was this" is the question a developer asks afterwards and the
      // user row can no longer answer it. This log lives in the customer's own
      // database (D-314), so it leaves with their `pg_dump`.
      await writeAuthAudit(db, {
        action: 'user_deleted', userId: id, ...meta,
        payload: { email: gone.email } });
      return reply.status(200).send({});
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
  amr?: readonly string[] | undefined,
) {
  const refresh = newRefreshToken();
  const { sessionId } = await openSession(db, { userId, refreshHash: refresh.hash, ...meta });
  const access = mintAccessToken({
    ctx, userId, email, sessionId, ttlSeconds: ctx.config.accessTtlSeconds,
    ...(amr ? { amr } : {}),
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
 * The four outcomes of an email-change confirmation, as one JSON shape.
 *
 * `pending` is a 200 and not an error: the user did exactly what the link asked
 * and the change is genuinely half-done. Reporting it as a failure is how a
 * correctly-working double confirmation gets mistaken for a broken one — which is
 * the support ticket that makes a project switch to `new_only` and lose the
 * protection.
 */
function emailChangeBody(
  reply: FastifyReply, state: 'applied' | 'pending' | 'conflict' | 'invalid',
  req: FastifyRequest,
) {
  if (state === 'applied') return reply.status(200).send({ email_change: 'complete' });
  if (state === 'pending') {
    return reply.status(200).send({
      email_change: 'pending',
      message: 'Confirmed. The change completes once the other address confirms too.',
    });
  }
  const requestId = String(reply.getHeader('x-request-id') ?? req.id);
  if (state === 'conflict') {
    return reply.status(409).send({
      error: { code: AUTH_ERROR_CODES.VALIDATION_FAILED,
               message: 'That email address is already in use.', request_id: requestId },
    });
  }
  return reply.status(401).send({
    error: { code: AUTH_ERROR_CODES.INVALID_TOKEN,
             message: 'This link is invalid or has already been used.', request_id: requestId },
  });
}

/**
 * A user id from the path, validated before it reaches a query.
 *
 * `pg` parameterises, so this is not an injection guard — it is a diagnosis one.
 * Without it a typo'd id reaches Postgres and comes back as
 * `invalid input syntax for type uuid`, which renders as a 500 and sends a
 * developer looking for a server fault instead of at their own request.
 */
function adminUserId(req: FastifyRequest): string {
  const { id } = req.params as { id: string };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(400, AUTH_ERROR_CODES.VALIDATION_FAILED, 'That is not a user id.');
  }
  return id;
}

/** Flow 10's answer for an id that is not there. Safe here and nowhere else. */
const notSuchUser = () =>
  new ApiError(404, AUTH_ERROR_CODES.VALIDATION_FAILED, 'No such user.');

/**
 * The URL that goes in an auth email.
 *
 * Built here, from the project's issuer and an already-**validated** redirect —
 * never from anything the client sent. D-116 is the reason: the whole point of
 * fixed templates with variable interpolation is that Corebase cannot be made to
 * send an arbitrary link from a reputable domain, and a client-supplied
 * `action_url` would hand that capability straight back.
 */
function actionLink(
  ctx: ProjectContext, token: string, type: string, redirect: string | undefined,
): string {
  const u = new URL(`${ctx.issuer}/verify`);
  u.searchParams.set('token', token);
  u.searchParams.set('type', type);
  if (redirect) u.searchParams.set('redirect_to', redirect);
  return u.toString();
}

/** What `issueSession` hands back. Named so the verify helpers can carry it. */
type Session = Awaited<ReturnType<typeof issueSession>>;

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
