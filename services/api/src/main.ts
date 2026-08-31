import { Pool } from 'pg';
import { createRedis, createQueue, enqueueProvisioning, type ProvisioningJobData } from '@corebase/queue';
import { buildApp } from './app.ts';
import { createPgStore, ensureBootstrapOrg } from './modules/control-plane/store.pg.ts';
import { createMemoryStore } from './modules/control-plane/store.ts';
import { createEnvelope } from '@corebase/crypto';
import { createSecretStore } from '@corebase/secrets';

const port = Number(process.env.PORT ?? 8080);
const url = process.env.CB_CONTROL_DATABASE_URL;

/**
 * Postgres when a control-plane URL is configured, in-memory otherwise. The
 * fallback exists so `pnpm dev` and unit tests need no database; it is never
 * the production path — a missing URL in production is a config error the
 * deploy should catch, which is why it is logged loudly rather than silently.
 */
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

const app = buildApp({
  store, logger: true,
  ...(actorUserId ? { actorUserId } : {}),
  ...(enqueue ? { enqueue } : {}),
});
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
