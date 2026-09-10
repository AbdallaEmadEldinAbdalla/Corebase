import { Pool } from 'pg';
import { createRedis, createQueue, enqueueProvisioning, enqueueRecovery,
         type ProvisioningJobData } from '@steadhold/queue';
import { buildApp } from './app.ts';
import { parseOrigins } from './kernel/cors.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';
import { createMemoryStore } from './modules/control-plane/store.ts';
import { createEnvelope } from '@steadhold/crypto';
import { createSecretStore } from '@steadhold/secrets';
import { createUserStore } from './modules/auth/store.ts';
import { createTokenStore } from './kernel/tokens.ts';
import { createSessionStore, createMemorySessionStore } from './kernel/sessions.ts';
import { createRateLimiter, createMemoryRateLimiter } from './kernel/rate-limit.ts';
import type { ProjectAuthDeps } from './modules/project-auth/routes.ts';
import { createMailer } from './modules/project-auth/mailer.ts';
import { createTrafficMeter } from './modules/project-auth/traffic.ts';
import { createS3, s3FromEnv } from '@steadhold/s3';
import { createRoutingTable } from './modules/gateway/routing.ts';
import type { GatewayDeps } from './modules/gateway/routes.ts';
import { SECRET_NAMES } from '@steadhold/secrets';
import { createAuthEmailQueue } from '@steadhold/queue';
import type { AuthDeps } from './modules/auth/routes.ts';
import { createOrgStore } from './modules/orgs/store.ts';

const port = Number(process.env.PORT ?? 8080);
const url = process.env.SH_CONTROL_DATABASE_URL;

/**
 * Postgres when a control-plane URL is configured, in-memory otherwise. The
 * fallback exists so `pnpm dev` and unit tests need no database; it is never
 * the production path — a missing URL in production is a config error the
 * deploy should catch, which is why it is logged loudly rather than silently.
 */
/** Shared with the key endpoints, which read the same envelope-encrypted rows. */
let secretsForApi: ReturnType<typeof createSecretStore> | undefined;
/**
 * The control-plane pool, hoisted for the SQL console (P7l).
 *
 * The console needs it to resolve a project's placement and to write its audit
 * rows, and it must be the *same* pool the store uses rather than a second one —
 * the audit row and the run it describes belong to one connection budget.
 */
let poolForApi: Pool | undefined;

const store = await (async () => {
  if (!url) {
    console.warn(JSON.stringify({
      level: 'warn', service: 'api',
      msg: 'SH_CONTROL_DATABASE_URL not set — using the in-memory store. State will not survive a restart.',
    }));
    return createMemoryStore();
  }
  const pool = new Pool({ connectionString: url, max: 10 });
  poolForApi = pool;
  const organizationId = await ensureBootstrapOrg(pool);

  // The KEK lets the API render connection strings. Without it the API still
  // serves everything else — a dashboard that cannot show a password is far
  // better than a dashboard that will not load.
  const kekDir = process.env.SH_KEK_DIR;
  let secrets;
  if (kekDir) {
    const envelope = createEnvelope({
      kekDir, ...(process.env.SH_KEK_ID ? { kekId: process.env.SH_KEK_ID } : {}),
    });
    secrets = createSecretStore(pool, envelope);
    secretsForApi = secrets;
  } else {
    console.warn(JSON.stringify({ level: 'warn', service: 'api',
      msg: 'SH_KEK_DIR not set — connection strings will be omitted from project detail.' }));
  }
  return createPgStore({ pool, organizationId, ...(secrets ? { secrets } : {}) });
})();

const redisUrl = process.env.SH_REDIS_URL;
/**
 * One queue, two delivery rules.
 *
 * `enqueue` is the producer's: a second create with the same idempotency key must
 * not become a second delivery. `enqueueRetry` is the opposite, and has to be —
 * Redis still holds the delivery the dead worker was given, so the producer's rule
 * would make a retry do nothing at all.
 */
const delivery = redisUrl
  ? (() => {
      const queue = createQueue(createRedis(redisUrl));
      return {
        enqueue: async (job: ProvisioningJobData) => { await enqueueProvisioning(queue, job); },
        enqueueRetry: async (job: ProvisioningJobData, attempt: number) => {
          await enqueueRecovery(queue, job, attempt);
        },
      };
    })()
  : undefined;
const enqueue = delivery?.enqueue;
if (!redisUrl) {
  console.warn(JSON.stringify({ level: 'warn', service: 'api',
    msg: 'SH_REDIS_URL not set — jobs will only be delivered by the worker sweeper.' }));
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
      `select id from users where email = 'dev@steadhold.local'`);
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
        msg: 'SH_REDIS_URL not set — sessions are in-memory and die with this process.' })),
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
    secureCookies: process.env.SH_SECURE_COOKIES !== 'false',
    // No default (see app.ts). Absent disables the static-token path entirely;
    // PATs (P1c) are the supported way for a human or a CLI to authenticate.
    ...(process.env.SH_STATIC_TOKEN ? { staticToken: process.env.SH_STATIC_TOKEN } : {}),
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
 * key and `steadhold_auth` password.
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
    ...(process.env.SH_PROJECT_DOMAIN ? { projectDomain: process.env.SH_PROJECT_DOMAIN } : {}),
    // Must match what the worker signed the project's keys with (SH_JWT_ISSUER
    // there), or every apikey fails its issuer check.
    ...(process.env.SH_JWT_ISSUER ? { keyIssuer: process.env.SH_JWT_ISSUER } : {}),
    // The traffic signal (P5a). Without it the idle scan concludes from database
    // connections alone, and a project used only through `/auth/v1/*` — whose
    // connections open as an internal role the scan excludes — looks idle and is
    // paused under its users.
    traffic: createTrafficMeter(pool, {
      onError: (err) => console.warn(JSON.stringify({
        level: 'warn', service: 'api', msg: 'could not record project activity',
        error: err.message })),
    }),
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
    msg: 'auth emails are recorded and NOT queued — SH_REDIS_URL is unset. '
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
if (process.env.SH_STATIC_TOKEN) {
  const t = process.env.SH_STATIC_TOKEN;
  if (WEAK_STATIC_TOKENS.has(t) && process.env.NODE_ENV === 'production') {
    throw new Error(
      `SH_STATIC_TOKEN is set to "${t}", which is a development placeholder. ` +
      'It grants the bootstrap owner\'s rights with no expiry and no revocation — ' +
      'set a generated value, or unset it and use a personal access token.');
  }
  if (t.length < 24) {
    throw new Error(
      'SH_STATIC_TOKEN is shorter than 24 characters. It is a bearer credential ' +
      'with no expiry and no revocation; generate one with ' +
      '`openssl rand -base64 32`, or unset it and use a personal access token.');
  }
}

/**
 * The data-plane gateway (P5c). Registered only with a control-plane database and
 * a secret store, for the reason `projectAuth` is: with neither there are no
 * projects to route to and no keys to validate against, and a `/rest/v1/*` that
 * exists and 503s is worse than one that 404s — a client codes against it.
 *
 * It reuses `projectAuth`'s pool. The routing table refreshes on a timer and is
 * off the hot path entirely (D-051), so its query load is one fleet-wide SELECT
 * every ten seconds regardless of traffic; a second pool would buy nothing and
 * spend connections the control plane needs.
 */
const gateway: GatewayDeps | undefined = await (async () => {
  if (!projectAuth || !secretsForApi) return undefined;
  const secrets = secretsForApi;
  const limiter = (limit: number, windowSeconds: number) => (redisUrl
    ? createRateLimiter(createRedis(redisUrl), { limit, windowSeconds })
    : createMemoryRateLimiter({ limit, windowSeconds }));
  const routes = createRoutingTable({
    pool: projectAuth.pool,
    // The active key is envelope-encrypted in the secret store, so unlike the
    // published set it cannot come from the fleet query. Missing pieces yield
    // `undefined` rather than throwing: a project mid-provision has rows before
    // it has keys, and one such project must not fail the refresh for the fleet.
    activeKey: async (projectId) => {
      const [pem, kid] = await Promise.all([
        secrets.get(projectId, SECRET_NAMES.jwtPublicKey),
        secrets.get(projectId, SECRET_NAMES.jwtKid),
      ]);
      return pem && kid ? { pem, kid } : undefined;
    },
    onError: (err) => console.error(JSON.stringify({
      level: 'error', service: 'api', msg: 'routing table refresh failed', error: err.message })),
  });
  await routes.refresh();
  routes.start();
  return {
    routes,
    // No default. A guessed domain would make every Host resolve to a wrong ref
    // or none, and the failure ("no such project" for a project that exists) says
    // nothing about the cause.
    projectDomain: process.env.SH_PROJECT_DOMAIN ?? '',
    // D-033's three layers. Per-IP catches a single noisy source, per-key catches
    // one leaked credential, per-project is the plan's own ceiling — and they are
    // separate because each answers a different question about who to slow down.
    ipLimiter: limiter(Number(process.env['SH_GW_IP_RPS'] ?? 200), 10),
    keyLimiter: limiter(Number(process.env['SH_GW_KEY_RPS'] ?? 500), 10),
    projectLimiter: limiter(Number(process.env['SH_GW_PROJECT_RPS'] ?? 1000), 10),
    // Shared with `/auth/v1/*` deliberately: one project's activity is one
    // signal, and two meters would each see half the traffic and both conclude
    // the project is quieter than it is.
    ...(projectAuth.traffic ? { traffic: projectAuth.traffic } : {}),
    /**
     * Auto-resume (D-131) goes through the control plane's own lifecycle path
     * rather than pushing a job. That path owns the `paused → resuming`
     * transition, the in-flight dedupe that collapses a burst of requests into
     * one job, and the audit row. A direct push would skip all three — and the
     * burst arriving the instant a paused project is touched is exactly the case
     * the dedupe exists for.
     */
    ...(enqueue && store.requestLifecycle
      ? {
          resume: async (ref: string) => {
            const result = await store.requestLifecycle!(ref, 'resume');
            // `undefined` is an unknown project and `conflict` a project already
            // resuming or ready — both mean there is nothing to enqueue, and
            // neither is an error worth logging on a data-plane hot path.
            if (!result || 'conflict' in result || result.alreadyRequested) return;
            await enqueue({
              job_row_id: result.job.id, idempotency_key: result.job.idempotency_key,
              job_type: result.job.kind, project_id: result.project.id,
            });
          },
        }
      : {}),
    onError: (err, ctx) => console.error(JSON.stringify({
      level: 'error', service: 'api', msg: 'gateway upstream error',
      error: err.message, ...ctx })),
  };
})();
if (gateway && !gateway.projectDomain) {
  console.warn(JSON.stringify({ level: 'warn', service: 'api',
    msg: 'SH_PROJECT_DOMAIN is unset — every /rest/v1 request will 404 because no '
       + 'Host can resolve to a ref. Set it to the domain projects are served under.' }));
}

/**
 * The storage module (P6b). Registered under the same condition as the rest of
 * the data plane: a control-plane database and a secret store, because without
 * both there is no project to resolve and no credential to reach one with.
 *
 * It reuses `projectAuth`'s pool and secret store deliberately — the two modules
 * resolve the *same* project from the *same* apikey, and two resolvers would be
 * two chances to disagree about who a caller is.
 */
/**
 * The object store, from the same environment the backup path reads.
 *
 * Absent means the bucket routes work and the object routes are not registered:
 * a deployment with no store configured can still create buckets, and cannot
 * pretend to accept bytes.
 */
const objectStore = (() => {
  const cfg = s3FromEnv();
  return cfg ? createS3(cfg) : undefined;
})();
if (!objectStore) {
  console.warn(JSON.stringify({ level: 'warn', service: 'api',
    msg: 'no object store configured — /storage/v1/object/* is not registered. '
       + 'Set the SH_BACKUP_S3_* variables (./scripts/staging.sh backup-store).' }));
}

const storage = projectAuth && secretsForApi
  ? {
      pool: projectAuth.pool,
      secrets: secretsForApi,
      // Storage's own bucket, separate from the gateway's: an upload is a
      // heavier and rarer request than a row read, so sharing one ceiling would
      // either throttle reads to protect uploads or the reverse.
      limiter: redisUrl
        ? createRateLimiter(createRedis(redisUrl),
            { limit: Number(process.env['SH_STORAGE_RPS'] ?? 200), windowSeconds: 10 })
        : createMemoryRateLimiter(
            { limit: Number(process.env['SH_STORAGE_RPS'] ?? 200), windowSeconds: 10 }),
      ...(process.env.SH_PROJECT_DOMAIN ? { projectDomain: process.env.SH_PROJECT_DOMAIN } : {}),
      ...(process.env.SH_JWT_ISSUER ? { keyIssuer: process.env.SH_JWT_ISSUER } : {}),
      ...(objectStore
        ? {
            objects: {
              s3: objectStore,
              onError: (err: Error, at: Record<string, unknown>) => console.error(
                JSON.stringify({ level: 'error', service: 'api',
                  msg: 'storage object operation failed', error: err.message, ...at })),
            },
          }
        : {}),
    }
  : undefined;

// Unset means no browser may call this API. See kernel/cors.ts: a localhost
// default would be a production hole the first time someone forgot the variable.
const corsOrigins = parseOrigins(process.env.SH_DASHBOARD_ORIGINS);

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
  ...(delivery ? { enqueueRecovery: delivery.enqueueRetry } : {}),
  ...(gateway ? { gateway } : {}),
  ...(storage ? { storage } : {}),
  /**
   * The SQL console (P7l, D-132). Registered only with a control pool, a secret
   * store to read `steadhold_admin`'s password from, and real auth — without any
   * one of those the endpoint could not work, and an endpoint that exists and
   * cannot work is worse than one that is honestly absent.
   *
   * 60 runs per minute per user. Generous for a person typing, and it is the
   * *node's* CPU being protected rather than an account, so the budget is per
   * user across every project they can reach — a runaway loop in a script hits
   * all of them, not one.
   */
  ...(poolForApi && secretsForApi && orgs && auth
    ? {
        db: {
          pool: poolForApi,
          secrets: secretsForApi,
          orgs: { roleOf: orgs.orgs.roleOf.bind(orgs.orgs) },
          principals: {
            sessions: auth.sessions,
            tokens: auth.tokens,
            ...(auth.staticToken ? { staticToken: auth.staticToken } : {}),
            ...(auth.staticUserId ? { staticUserId: auth.staticUserId } : {}),
          },
          limiter: redisUrl
            ? createRateLimiter(createRedis(redisUrl), { limit: 60, windowSeconds: 60 })
            : createMemoryRateLimiter({ limit: 60, windowSeconds: 60 }),
        },
        /**
         * The end-users page (P7s). Same four prerequisites as the console and
         * absent for the same reason, but a separate option because it connects
         * as `steadhold_auth` rather than `steadhold_admin` — the console's role
         * has no privilege on `auth.users` at all, which is why this is not a
         * page over `POST /db/query`.
         *
         * No rate limiter. The console's exists because arbitrary SQL is a way
         * to spend the node's CPU; these are three indexed statements and one
         * bounded search, and a limiter on a list a person is paging through
         * would be a budget for reading.
         */
        projectUsers: {
          pool: poolForApi,
          secrets: secretsForApi,
          orgs: { roleOf: orgs.orgs.roleOf.bind(orgs.orgs) },
          principals: {
            sessions: auth.sessions,
            tokens: auth.tokens,
            ...(auth.staticToken ? { staticToken: auth.staticToken } : {}),
            ...(auth.staticUserId ? { staticUserId: auth.staticUserId } : {}),
          },
        },
        /**
         * The file browser (P7u). Listing and signing work without an object
         * store — the metadata is in Postgres — so the routes are registered
         * either way and only *delete* refuses, by name, when there is nowhere
         * to remove the bytes from. Half-deleting is the orphan the storage
         * architecture treats as its central consistency problem.
         */
        projectStorage: {
          pool: poolForApi,
          secrets: secretsForApi,
          orgs: { roleOf: orgs.orgs.roleOf.bind(orgs.orgs) },
          principals: {
            sessions: auth.sessions,
            tokens: auth.tokens,
            ...(auth.staticToken ? { staticToken: auth.staticToken } : {}),
            ...(auth.staticUserId ? { staticUserId: auth.staticUserId } : {}),
          },
          ...(objectStore ? { s3: objectStore } : {}),
          onError: (err: Error, at: Record<string, unknown>) => console.error(
            JSON.stringify({ level: 'error', service: 'api',
              msg: 'dashboard storage operation failed', error: err.message, ...at })),
        },
      }
    : {}),
});
// Said out loud at boot, because "the dashboard cannot log in" and "CORS is off"
// look nothing alike from the browser's console.
app.log.info({ corsOrigins }, corsOrigins.length
  ? 'browser origins allowed'
  : 'no browser origins allowed (set SH_DASHBOARD_ORIGINS)');

// The routing table owns an interval. `unref` keeps it from holding the process
// open on its own, but an explicit stop is what makes a close deterministic
// rather than dependent on when the timer next fires.
app.addHook('onClose', async () => { gateway?.routes.stop(); });

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
