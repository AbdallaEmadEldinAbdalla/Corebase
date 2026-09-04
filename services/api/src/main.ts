import { Pool } from 'pg';
import { createRedis, createQueue, enqueueProvisioning, type ProvisioningJobData } from '@corebase/queue';
import { buildApp } from './app.ts';
import { parseOrigins } from './kernel/cors.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';
import { createMemoryStore } from './modules/control-plane/store.ts';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore } from '@corebase/secrets';
import { createUserStore } from './modules/auth/store.ts';
import { createTokenStore } from './kernel/tokens.ts';
import { createSessionStore, createMemorySessionStore } from './kernel/sessions.ts';
import { createRateLimiter, createMemoryRateLimiter } from './kernel/rate-limit.ts';
import type { ProjectAuthDeps } from './modules/project-auth/routes.ts';
import { createMailer } from './modules/project-auth/mailer.ts';
import { createAuthEmailQueue } from '@corebase/queue';
import type { AuthDeps } from './modules/auth/routes.ts';
import { createOrgStore } from './modules/orgs/store.ts';

const port = Number(process.env.PORT ?? 8080);
const url = process.env.CB_CONTROL_DATABASE_URL;

/**
 * Postgres when a control-plane URL is configured, in-memory otherwise. The
 * fallback exists so `pnpm dev` and unit tests need no database; it is never
 * the production path — a missing URL in production is a config error the
 * deploy should catch, which is why it is logged loudly rather than silently.
 */
/** Shared with the key endpoints, which read the same envelope-encrypted rows. */
let secretsForApi: ReturnType<typeof createSecretStore> | undefined;

const store = await (async () => {
  if (!url) {
    console.warn(JSON.stringify({
      level: 'warn', service: 'api',
      msg: 'CB_CONTROL_DATABASE_URL not set — using the in-memory store. State will not survive a restart.',
    }));
    return createMemoryStore();
  }
  const pool = new Pool({ connectionString: url, max: 10 });
  const organizationId = await ensureBootstrapOrg(pool);

  // The KEK lets the API render connection strings. Without it the API still
  // serves everything else — a dashboard that cannot show a password is far
  // better than a dashboard that will not load.
  const kekDir = process.env.CB_KEK_DIR;
  let secrets;
  if (kekDir) {
    const envelope = createEnvelope({
      kekDir, ...(process.env.CB_KEK_ID ? { kekId: process.env.CB_KEK_ID } : {}),
    });
    secrets = createSecretStore(pool, envelope);
    secretsForApi = secrets;
  } else {
    console.warn(JSON.stringify({ level: 'warn', service: 'api',
      msg: 'CB_KEK_DIR not set — connection strings will be omitted from project detail.' }));
  }
  return createPgStore({ pool, organizationId, ...(secrets ? { secrets } : {}) });
})();

const redisUrl = process.env.CB_REDIS_URL;
const enqueue = redisUrl
  ? (() => {
      const queue = createQueue(createRedis(redisUrl));
      return async (job: ProvisioningJobData) => {
        await enqueueProvisioning(queue, job);
      };
    })()
  : undefined;
if (!redisUrl) {
  console.warn(JSON.stringify({ level: 'warn', service: 'api',
    msg: 'CB_REDIS_URL not set — jobs will only be delivered by the worker sweeper.' }));
}

/**
 * The user static-token mutations are attributed to, resolved once. Absent — a
 * database with no bootstrap user — records mutations as `system` rather than
 * inventing an actor.
 */
const actorUserId = await (async () => {
  if (!url) return null;
  try {
    const probe = new Pool({ connectionString: url, max: 1 });
    const { rows } = await probe.query<{ id: string }>(
      `select id from users where email = 'dev@corebase.local'`);
    await probe.end();
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
})();

/**
 * Platform auth needs both Postgres and Redis. Without them the endpoints are not
 * registered at all, rather than registered and broken — a route that exists is a
 * route a client will code against.
 */
const auth: AuthDeps | undefined = await (async () => {
  if (!url) return undefined;
  const authPool = new Pool({ connectionString: url, max: 5 });
  const sessions = redisUrl
    ? createSessionStore(createRedis(redisUrl))
    : (console.warn(JSON.stringify({ level: 'warn', service: 'api',
        msg: 'CB_REDIS_URL not set — sessions are in-memory and die with this process.' })),
       createMemorySessionStore());
  const loginLimiter = redisUrl
    ? createRateLimiter(createRedis(redisUrl), { limit: 10, windowSeconds: 300 })
    : createMemoryRateLimiter({ limit: 10, windowSeconds: 300 });
  // Tighter than login and for a different reason: each signup is a 64 MiB scrypt
  // call (D-211), so this budget protects the node's memory rather than an
  // account. Five per address per five minutes is generous for a human and
  // useless for a memory-exhaustion attempt.
  const signupLimiter = redisUrl
    ? createRateLimiter(createRedis(redisUrl), { limit: 5, windowSeconds: 300 })
    : createMemoryRateLimiter({ limit: 5, windowSeconds: 300 });
  return {
    pool: authPool,
    users: createUserStore(authPool),
    tokens: createTokenStore(authPool),
    sessions,
    loginLimiter,
    signupLimiter,
    // Off only for plain-HTTP local development; a Secure cookie is never sent
    // over http:// and the failure looks like "login does nothing".
    secureCookies: process.env.CB_SECURE_COOKIES !== 'false',
    // No default (see app.ts). Absent disables the static-token path entirely;
    // PATs (P1c) are the supported way for a human or a CLI to authenticate.
    ...(process.env.CB_STATIC_TOKEN ? { staticToken: process.env.CB_STATIC_TOKEN } : {}),
    staticUserId: actorUserId,
  };
})();

/**
 * Organizations reuse auth's pool and principal resolution: they are the same
 * request path, and two pools for one path is two places to run out of
 * connections.
 */
const orgs = auth
  ? {
      orgs: createOrgStore(auth.pool),
      users: auth.users,
      sessions: auth.sessions,
      tokens: auth.tokens,
      ...(auth.staticToken ? { staticToken: auth.staticToken } : {}),
      ...(auth.staticUserId ? { staticUserId: auth.staticUserId } : {}),
    }
  : undefined;

/**
 * The data-plane auth API (P4b), which needs the control-plane pool to resolve a
 * project from its anon key and the secret store to read that project's signing
 * key and `corebase_auth` password.
 *
 * Without envelope encryption configured there is no secret store, so there are
 * no signing keys and no database credentials — every request would 503. The
 * routes are therefore not registered at all in that case, for the same reason
 * platform auth is not: a route that exists and cannot work is worse than a 404,
 * because a client codes against it.
 */
const projectAuth: ProjectAuthDeps | undefined = await (async () => {
  if (!url || !secretsForApi) return undefined;
  const pool = new Pool({ connectionString: url, max: 5 });
  const limiter = (limit: number, windowSeconds: number) => (redisUrl
    ? createRateLimiter(createRedis(redisUrl), { limit, windowSeconds })
    : createMemoryRateLimiter({ limit, windowSeconds }));
  return {
    pool, secrets: secretsForApi,
    // The doc's V1 numbers (flows §rate limits). They are per project *and* per
    // identifier — see routes.ts for the key shape.
    signupLimiter: limiter(30, 3600),
    loginEmailLimiter: limiter(10, 300),
    loginIpLimiter: limiter(30, 300),
    // The mail-sending endpoints are the tightest of the set, and not because of
    // brute force: the per-address bucket stops targeted flooding of one
    // person's inbox, and the per-IP bucket protects a sending domain that every
    // project on the platform shares (D-116).
    recoverEmailLimiter: limiter(4, 3600),
    recoverIpLimiter: limiter(10, 3600),
    // Generous, because a corporate mail scanner fetching every link in an inbox
    // counts against it (OQ-114).
    verifyIpLimiter: limiter(30, 3600),
    // Looser than login by design: a legitimate client refreshes on a schedule
    // and a mobile app on a flaky network retries, so a tight bucket here logs
    // real users out. It is also the least useful endpoint to brute-force —
    // a refresh token is 256 bits of CSPRNG, not a password.
    refreshIpLimiter: limiter(60, 300),
    ...(process.env.CB_PROJECT_DOMAIN ? { projectDomain: process.env.CB_PROJECT_DOMAIN } : {}),
    // Must match what the worker signed the project's keys with (CB_JWT_ISSUER
    // there), or every apikey fails its issuer check.
    ...(process.env.CB_JWT_ISSUER ? { keyIssuer: process.env.CB_JWT_ISSUER } : {}),
    /**
     * The mail path (P4d): suppression and caps are checked here, at enqueue,
     * and the worker does the sending.
     *
     * Redis is not optional for it. The caps are Redis counters and they are the
     * blast radius of `/signup` and `/recover` being usable as a bulk mailer by
     * any anonymous visitor (D-116) — so with no Redis the honest behaviour is to
     * keep the null mailer, which records every owed mail and sends none, rather
     * than to send uncapped. That fails the flows and protects the domain, which
     * is the right way round.
     */
    ...(redisUrl
      ? {
          mailer: createMailer({
            pool,
            // Two connections, not one: BullMQ issues blocking commands on its
            // own and sharing a connection with ordinary counter traffic is how
            // an INCR ends up waiting behind a BRPOPLPUSH.
            redis: createRedis(redisUrl),
            queue: createAuthEmailQueue(createRedis(redisUrl)),
            onError: (err, job) => console.error(JSON.stringify({
              level: 'error', service: 'api', msg: 'could not queue an auth email',
              template: job.email, project_ref: job.projectRef, error: err.message })),
          }),
        }
      : {}),
  };
})();
if (projectAuth && !projectAuth.mailer) {
  console.warn(JSON.stringify({ level: 'warn', service: 'api',
    msg: 'auth emails are recorded and NOT queued — CB_REDIS_URL is unset. '
       + 'Signup with confirmation required will not deliver a link; set a '
       + 'project\'s autoconfirm for local development.' }));
}

/**
 * A static token that is short, guessable, or one of the values this repo's own
 * scripts default to is refused at boot rather than served.
 *
 * The variable used to have a default of `dev-token`, so an API deployed without
 * it accepted that literal string as the bootstrap owner — a credential shipped
 * in the source. Removing the default fixes the unset case; this covers the case
 * where someone copies the dev value into a real environment.
 */
const WEAK_STATIC_TOKENS = new Set(['dev-token', 'test-token', 'changeme', 'secret']);
if (process.env.CB_STATIC_TOKEN) {
  const t = process.env.CB_STATIC_TOKEN;
  if (WEAK_STATIC_TOKENS.has(t) && process.env.NODE_ENV === 'production') {
    throw new Error(
      `CB_STATIC_TOKEN is set to "${t}", which is a development placeholder. ` +
      'It grants the bootstrap owner\'s rights with no expiry and no revocation — ' +
      'set a generated value, or unset it and use a personal access token.');
  }
  if (t.length < 24) {
    throw new Error(
      'CB_STATIC_TOKEN is shorter than 24 characters. It is a bearer credential ' +
      'with no expiry and no revocation; generate one with ' +
      '`openssl rand -base64 32`, or unset it and use a personal access token.');
  }
}

// Unset means no browser may call this API. See kernel/cors.ts: a localhost
// default would be a production hole the first time someone forgot the variable.
const corsOrigins = parseOrigins(process.env.CB_DASHBOARD_ORIGINS);

const app = buildApp({
  store, logger: true,
  ...(corsOrigins.length ? { corsOrigins } : {}),
  ...(auth ? { auth } : {}),
  ...(orgs ? { orgs } : {}),
  ...(secretsForApi ? { projectSecrets: { secrets: secretsForApi } } : {}),
  // Dual-publish for the control plane's JWKS (P4h). A plain query rather than a
  // service, because the only thing this endpoint needs is the published set and
  // the rotation itself is driven from the worker.
  // Reuses the data-plane auth pool rather than opening a third: it is already a
  // control-plane pool, and it exists under exactly the condition that makes
  // rotation possible at all (a configured secret store).
  ...(projectAuth
    ? {
        signingKeys: {
          published: async (projectId: string) => {
            const { rows } = await projectAuth.pool.query<{ kid: string; public_key_pem: string }>(
              `SELECT kid, public_key_pem FROM project_signing_keys
                WHERE project_id = $1 AND status IN ('next', 'retiring')
                ORDER BY published_at`, [projectId]);
            return rows.map((r) => ({ kid: r.kid, publicKeyPem: r.public_key_pem }));
          },
        },
      }
    : {}),
  ...(projectAuth ? { projectAuth } : {}),
  ...(orgs && auth
    ? {
        projects: {
          orgs: orgs.orgs,
          // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not
          // the same as an absent key — spread the optional fields conditionally.
          principals: {
            sessions: auth.sessions,
            tokens: auth.tokens,
            ...(auth.staticToken ? { staticToken: auth.staticToken } : {}),
            ...(auth.staticUserId ? { staticUserId: auth.staticUserId } : {}),
          },
        },
      }
    : {}),
  ...(actorUserId ? { actorUserId } : {}),
  ...(enqueue ? { enqueue } : {}),
});
// Said out loud at boot, because "the dashboard cannot log in" and "CORS is off"
// look nothing alike from the browser's console.
app.log.info({ corsOrigins }, corsOrigins.length
  ? 'browser origins allowed'
  : 'no browser origins allowed (set CB_DASHBOARD_ORIGINS)');

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
