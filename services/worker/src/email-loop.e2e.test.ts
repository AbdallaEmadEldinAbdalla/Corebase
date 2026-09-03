import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRedis, createAuthEmailQueue, enqueueAuthEmail, authEmailBackoff,
         type Queue, type AuthEmailJobData, type Redis } from '@corebase/queue';
import { createSmtpProvider, CAPS } from '@corebase/email';
import { createMailer } from '@corebase/api/modules/project-auth/mailer.ts';
import { createEmailSender } from './email-sender.ts';

/**
 * P4d — the whole loop: a flow owes an email, and an email arrives.
 *
 * `email.e2e.test.ts` proves the SMTP conversation. This proves the pipeline
 * around it — the enqueue gate the API runs (suppression, then caps, then a row,
 * then a job) and the worker draining it. The two halves are in separate files
 * because they fail for unrelated reasons and a combined file makes "did the mail
 * go out" and "was the mail allowed" one red mark.
 *
 * The gate is what makes `/signup` and `/recover` safe to expose: they let any
 * anonymous visitor make Corebase email an arbitrary address, and V1 sends every
 * project's mail from one domain (D-116).
 */
/**
 * The sink's address comes from the file `./scripts/staging.sh mail-sink` writes,
 * loaded here rather than required in the environment — same reason the backup
 * suites do it: a suite that only runs when someone remembered to export four
 * variables is a suite that silently stops running.
 */
function loadMailEnv(): void {
  const file = join(process.cwd(), '../../infra/docker/staging/mail-sink.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}
loadMailEnv();

const DB = process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
const REDIS = process.env.CB_REDIS_URL ?? 'redis://127.0.0.1:56379';
const SMTP_HOST = process.env.CB_SMTP_HOST ?? '127.0.0.1';
const SMTP_PORT = Number(process.env.CB_SMTP_PORT ?? 51025);
const MAILPIT = process.env.CB_MAILPIT_API ?? 'http://127.0.0.1:58025';

let pool: Pool; let redis: Redis; let queue: Queue<AuthEmailJobData>;
let orgId: string; let up = false; let reason = '';

const purgeSink = () => fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' })
  .then((r) => r.text());
const inbox = () => fetch(`${MAILPIT}/api/v1/messages`).then((r) => r.json())
  .then((r) => (r as { messages: Array<{ To: Array<{ Address: string }>; Subject: string }> }).messages);

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1 from email_sends limit 1');
    redis = createRedis(REDIS);
    await redis.ping();
    queue = createAuthEmailQueue(createRedis(REDIS));
    await purgeSink();
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('E','e4-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P4d loop setup FAILED:', reason);
    up = false;
  }
}, 30_000);

afterAll(async () => {
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close();
  await redis?.quit();
  await pool?.end();
});

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate email_sends, email_suppressions, projects cascade');
  // The caps are Redis counters, so a leftover count from the previous test is a
  // cap already spent — the single most confusing way for these tests to fail.
  const keys = await redis.keys('cb:mail:*');
  if (keys.length) await redis.del(...keys);
  await queue.obliterate({ force: true }).catch(() => undefined);
  await purgeSink();
});

const t = (n: string, fn: () => Promise<void>, ms = 60_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P4d loop preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && mail-sink, plus migrations. ' +
      'This is the P4d done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
async function project(plan = 'free', ageHours = 48) {
  const ref = 'e' + String(Date.now() % 100000) + String(++seq).padStart(14, 'r');
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status, created_at)
     values ($1,$2,'Acme',$3,'ready', now() - make_interval(hours => $4::int))
     returning id, ref::text as ref`,
    [orgId, ref, plan, ageHours]);
  return rows[0]!;
}

const mailer = () => createMailer({ pool, redis, queue });

const owe = (p: { id: string; ref: string }, over: Record<string, unknown> = {}) => ({
  deliveryId: `confirmation_${p.id}_${++seq}`,
  projectId: p.id, projectRef: p.ref,
  email: 'confirmation' as const, to: 'user@example.test',
  variables: { action_url: 'https://app.example.com/auth/v1/verify?token=t&type=signup' },
  ...over,
});

/** Drain everything waiting, the way the worker does. */
async function drain() {
  const sender = createEmailSender({
    pool, from: 'auth@mail.corebase.co',
    provider: createSmtpProvider({ host: SMTP_HOST, port: SMTP_PORT, tls: 'off', timeoutMs: 8000 }),
  });
  const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
  for (const job of jobs) {
    await sender.handle(job.data, job.attemptsMade);
    await job.remove().catch(() => undefined);
  }
  return jobs.length;
}

const rows = () => pool.query<{ status: string; recipient: string; error: string | null }>(
  `select status, recipient, error from email_sends order by created_at`).then((r) => r.rows);

describe('P4d — enqueue to inbox', () => {
  t('EXIT CRITERION: an owed email becomes a queued job, a row, and a delivered message',
    async () => {
      const p = await project();
      await mailer().enqueue(owe(p));

      // The row before the job, for the same reason a credential is stored
      // before it is applied: a crash between the two leaves a row saying mail
      // is owed and no job, which is recoverable. The reverse leaves a mail in
      // an inbox that no row accounts for.
      expect((await rows())[0]).toMatchObject({ status: 'queued', recipient: 'user@example.test' });
      expect(await queue.getWaitingCount()).toBe(1);

      expect(await drain()).toBe(1);
      expect((await rows())[0]!.status).toBe('sent');
      const mail = await inbox();
      expect(mail).toHaveLength(1);
      expect(mail[0]!.To[0]!.Address).toBe('user@example.test');
      expect(mail[0]!.Subject).toBe('Confirm your email address');
    });

  t('a duplicate delivery id does not become a second job', async () => {
    const p = await project();
    const job = owe(p);
    await mailer().enqueue(job);
    await mailer().enqueue(job);
    // The delivery id is `<template>_<user id>` (D-330), which is the stable
    // identity of "the link currently owed to this person" — so five resend
    // clicks while the first is still waiting produce one mail, not five.
    expect(await queue.getWaitingCount()).toBe(1);
    await drain();
    expect(await inbox()).toHaveLength(1);
  });
});

describe('P4d — the gate', () => {
  t('EXIT CRITERION: a suppressed address is never queued, and the row says why',
    async () => {
      const p = await project();
      await pool.query(
        `insert into email_suppressions (project_id, email, reason)
         values ($1, 'bounced@example.test', 'hard_bounce')`, [p.id]);

      await mailer().enqueue(owe(p, { to: 'Bounced@Example.test' }));
      // Case-insensitive, or the suppression is bypassed by capitalising a
      // letter — and continuing to send to an address that hard-bounced is the
      // single most effective way to convince a provider we are a spammer.
      expect(await queue.getWaitingCount()).toBe(0);
      const r = await rows();
      expect(r[0]).toMatchObject({ status: 'suppressed' });
      expect(r[0]!.error).toMatch(/project suppression/);
      expect(await drain()).toBe(0);
      expect(await inbox()).toHaveLength(0);
    });

  t('the global list applies to a project that never bounced anything', async () => {
    const p = await project();
    // project_id NULL. An address here is a trap or long dead, and protecting the
    // shared domain outranks any one project's wish to retry it.
    await pool.query(
      `insert into email_suppressions (project_id, email, reason)
       values (NULL, 'trap@example.test', 'complaint')`);
    await mailer().enqueue(owe(p, { to: 'trap@example.test' }));
    expect(await queue.getWaitingCount()).toBe(0);
    expect((await rows())[0]!.error).toMatch(/global suppression/);
  });

  t('another project\'s suppression does not apply to this one', async () => {
    const a = await project();
    const b = await project();
    await pool.query(
      `insert into email_suppressions (project_id, email, reason)
       values ($1, 'shared@example.test', 'hard_bounce')`, [a.id]);
    await mailer().enqueue(owe(b, { to: 'shared@example.test' }));
    // A bounce is a fact about one project's relationship with an address —
    // often a typo in *their* signup form. Sharing it across tenants would let
    // one project's bad data silence another's mail.
    expect(await queue.getWaitingCount()).toBe(1);
    expect((await rows())[0]!.status).toBe('queued');
  });

  t('EXIT CRITERION: the per-recipient cap stops a mail-bomb and records each refusal',
    async () => {
      const p = await project();
      const m = mailer();
      // Free allows 4/hour to one address, which is what a real person needs:
      // sign up, mistype, resend, reset.
      for (let i = 0; i < CAPS['free']!.perRecipientPerHour; i++) {
        await m.enqueue(owe(p, { to: 'victim@example.test' }));
      }
      expect(await queue.getWaitingCount()).toBe(4);

      for (let i = 0; i < 6; i++) {
        await m.enqueue(owe(p, { to: 'victim@example.test' }));
      }
      // Refused at enqueue, so the queue never grows — the point of checking
      // here rather than at send is that a burst is stopped while it is one
      // Redis round trip, instead of filling a queue whose drain rate is the
      // thing being protected.
      expect(await queue.getWaitingCount()).toBe(4);

      const r = await rows();
      expect(r.filter((x) => x.status === 'queued')).toHaveLength(4);
      const refused = r.filter((x) => x.status === 'rate_limited');
      expect(refused).toHaveLength(6);
      // Named, because "not sent" is useless to a developer: this one means
      // "you are sending too much", and suppression means "your data is wrong".
      expect(refused[0]!.error).toMatch(/perRecipientPerHour cap for the free plan/);

      await drain();
      expect(await inbox()).toHaveLength(4);
    });

  t('the project hourly cap applies across different recipients', async () => {
    // A project under a day old on Free gets half caps (15/hour), which is the
    // doc's new-project throttle: abuse arrives on brand-new free projects,
    // because that is the account an attacker is willing to lose.
    const p = await project('free', 1);
    const m = mailer();
    for (let i = 0; i < 15; i++) await m.enqueue(owe(p, { to: `u${i}@example.test` }));
    expect(await queue.getWaitingCount()).toBe(15);
    await m.enqueue(owe(p, { to: 'u99@example.test' }));
    expect(await queue.getWaitingCount()).toBe(15);
    const refused = (await rows()).filter((x) => x.status === 'rate_limited');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.error).toMatch(/perHour/);
  });

  t('a paid plan is not throttled for being new', async () => {
    const p = await project('pro', 1);
    const m = mailer();
    // 20 is over Free's halved hourly cap and well under Pro's 200.
    for (let i = 0; i < 20; i++) await m.enqueue(owe(p, { to: `p${i}@example.test` }));
    expect(await queue.getWaitingCount()).toBe(20);
    expect((await rows()).every((x) => x.status === 'queued')).toBe(true);
  });

  t('a refused send can be queued later, and the row moves with it', async () => {
    const p = await project();
    const m = mailer();
    const job = owe(p, { to: 'later@example.test' });
    // Spend the per-recipient hour on other delivery ids for the same address.
    for (let i = 0; i < 4; i++) await m.enqueue(owe(p, { to: 'later@example.test' }));
    await m.enqueue(job);
    expect((await rows()).find((r) => r.status === 'rate_limited')).toBeTruthy();

    const keys = await redis.keys('cb:mail:*:r:*');
    if (keys.length) await redis.del(...keys);          // the window reopening
    await m.enqueue(job);
    // `ON CONFLICT DO UPDATE`, not DO NOTHING: otherwise the developer's view
    // says a mail was refused when it was later sent.
    const row = (await rows()).find((r) => r.recipient === 'later@example.test'
                                            && r.status === 'queued');
    expect(row).toBeTruthy();
  });

  t('nothing the gate does can fail a flow', async () => {
    const p = await project();
    // A pool pointed at a closed port: the flow has already committed to a
    // same-shape 200, so a database or Redis failure here must not become a 500
    // that tells the caller their address was interesting (D-330).
    const broken = new Pool({
      connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    const errors: string[] = [];
    const m = createMailer({
      pool: broken, redis, queue, onError: (err) => errors.push(err.message) });
    await expect(m.enqueue(owe(p))).resolves.toBeUndefined();
    // Swallowed, but not silently: an operator has to be able to see it.
    expect(errors).toHaveLength(1);
    await broken.end().catch(() => undefined);
  });
});

describe('P4d — the retry schedule', () => {
  it('is 30s, 5min, 30min — not a doubling', () => {
    // BullMQ's built-in `exponential` would give 30s/1min/2min and exhaust the
    // whole budget inside three minutes. A provider outage lasts longer than
    // that, and surviving one is the only reason to retry at all.
    expect(authEmailBackoff(1)).toBe(30_000);
    expect(authEmailBackoff(2)).toBe(300_000);
    expect(authEmailBackoff(3)).toBe(1_800_000);
    // Past the budget it clamps rather than returning undefined, which BullMQ
    // would read as "retry immediately".
    expect(authEmailBackoff(4)).toBe(1_800_000);
  });

  t('a job carries the schedule and the attempt budget', async () => {
    const p = await project();
    await enqueueAuthEmail(queue, {
      delivery_id: `sched_${p.id}`, project_id: p.id, project_ref: p.ref,
      template: 'confirmation', to: 'sched@example.test', variables: {},
    });
    const job = (await queue.getJobs(['waiting']))[0]!;
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toMatchObject({ type: 'authEmail' });
  });
});
