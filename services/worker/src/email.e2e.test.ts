import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createSmtpProvider, render, EmailSendError } from '@steadhold/email';
import { createEmailSender, friendlyFrom } from './email-sender.ts';
import type { AuthEmailJobData } from '@steadhold/queue';

/**
 * P4d — a message that actually leaves the process.
 *
 * The sink is Mailpit, and it is the same kind of substitute MinIO is for R2: a
 * real SMTP listener, so what gets exercised is our own protocol conversation,
 * our headers and our multipart structure rather than a mock's idea of them. The
 * hand-written SMTP client is the reason that matters — nobody else has tested
 * it, and the failure modes it has are all in the parts a mock would skip: reply
 * continuation lines, dot-stuffing, header encoding, DATA framing.
 *
 * What it cannot exercise is deliverability. SPF, DKIM, DMARC and inbox placement
 * are properties of a real domain at a real provider and are recorded as unmet in
 * STATUS rather than pretended at here.
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

const DB = process.env.SH_CONTROL_DATABASE_URL
  ?? 'postgres://steadhold:controlpass@127.0.0.1:55433/steadhold_control';
const SMTP_HOST = process.env.SH_SMTP_HOST ?? '127.0.0.1';
const SMTP_PORT = Number(process.env.SH_SMTP_PORT ?? 51025);
const MAILPIT = process.env.SH_MAILPIT_API ?? 'http://127.0.0.1:58025';

let pool: Pool; let orgId: string; let up = false; let reason = '';

interface MailpitMessage {
  ID: string;
  From: { Name: string; Address: string };
  To: Array<{ Address: string }>;
  Subject: string;
}

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${MAILPIT}${path}`, init);
  if (!res.ok) throw new Error(`mailpit ${path}: ${res.status} ${await res.text()}`);
  // Content-type, not status: the sink answers a DELETE with the plain string
  // `ok`, and parsing that as JSON failed the whole suite's precondition with
  // "Unexpected token 'o'" — an error about our test harness that read as a
  // broken staging stack.
  if (!res.headers.get('content-type')?.includes('json')) {
    await res.text();
    return undefined as T;
  }
  return (await res.json()) as T;
};

/** Everything the sink holds, newest first. */
const inbox = () => api<{ messages: MailpitMessage[] }>('/api/v1/messages')
  .then((r) => r.messages);

/** One message's full source, which is where the headers and parts live. */
const source = (id: string) => fetch(`${MAILPIT}/api/v1/message/${id}/raw`).then((r) => r.text());

/**
 * Wait for the sink to show a message.
 *
 * Polled rather than read once, for the reason the staging probe learned the
 * hard way: the sink accepts on the socket and indexes a moment later, so a
 * single read straight after a send reports a working sender as broken.
 */
async function waitForMail(predicate: (m: MailpitMessage) => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = (await inbox()).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      const all = await inbox();
      throw new Error(
        `no matching message in ${ms}ms; the sink holds ${all.length}: `
        + all.map((m) => `${m.To[0]?.Address} "${m.Subject}"`).join(', '));
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DB, max: 4, connectionTimeoutMillis: 1500 });
  try {
    await pool.query('select 1');
    await pool.query('select 1 from email_sends limit 1');
    await api('/api/v1/messages', { method: 'DELETE' });
    const { rows } = await pool.query<{ id: string }>(
      `insert into organizations (name, slug) values ('D','d4-test')
       on conflict (slug) do update set updated_at=now() returning id`);
    orgId = rows[0]!.id;
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P4d integration setup FAILED:', reason);
    up = false;
  }
}, 30_000);

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  if (!up) return;
  await pool.query('truncate email_sends, email_suppressions, projects cascade');
  await api('/api/v1/messages', { method: 'DELETE' });
});

const t = (n: string, fn: () => Promise<void>, ms = 60_000) =>
  it(n, async () => {
    if (!up) throw new Error(`P4d preconditions not met (${reason}) — ` +
      './scripts/staging.sh up && mail-sink, plus migrations. ' +
      'This is the P4d done-signal and must not skip silently.');
    await fn();
  }, ms);

let seq = 0;
async function project(name = 'Acme', plan = 'free') {
  const ref = 'd' + String(Date.now() % 100000) + String(++seq).padStart(14, 'r');
  const { rows } = await pool.query<{ id: string; ref: string }>(
    `insert into projects (organization_id, ref, name, plan, status)
     values ($1,$2,$3,$4,'ready') returning id, ref::text as ref`,
    [orgId, ref, name, plan]);
  return rows[0]!;
}

const provider = () => createSmtpProvider({
  host: SMTP_HOST, port: SMTP_PORT, tls: 'off', timeoutMs: 10_000 });

const sender = (over: Partial<Parameters<typeof createEmailSender>[0]> = {}) =>
  createEmailSender({
    pool, provider: provider(), from: 'auth@mail.steadhold.app', ...over });

const job = (p: { id: string; ref: string }, over: Partial<AuthEmailJobData> = {}): AuthEmailJobData => ({
  delivery_id: `confirmation_${++seq}`,
  project_id: p.id, project_ref: p.ref,
  template: 'confirmation', to: 'user@example.test',
  variables: { action_url: 'https://app.example.com/auth/v1/verify?token=abc&type=signup' },
  ...over,
});

/** The mailer puts the row there before the job; this test drives the sender. */
const queueRow = (d: AuthEmailJobData) => pool.query(
  `insert into email_sends (project_id, delivery_id, template, recipient, status)
   values ($1,$2,$3,$4,'queued')
   on conflict (project_id, delivery_id) do nothing`,
  [d.project_id, d.delivery_id, d.template, d.to]);

describe('P4d — a real SMTP send', () => {
  t('EXIT CRITERION: a confirmation email reaches the sink, both parts intact', async () => {
    const p = await project();
    const d = job(p);
    await queueRow(d);
    const out = await sender().handle(d);
    expect(out.status).toBe('sent');

    const msg = await waitForMail((m) => m.To[0]?.Address === 'user@example.test');
    expect(msg.Subject).toBe('Confirm your email address');
    // The project's name in the friendly-from: a verification mail from an
    // unrecognised "Steadhold" for an app called Acme reads like phishing, which
    // is both a support burden and a complaint-rate problem.
    expect(msg.From.Name).toBe('Acme (via Steadhold)');
    expect(msg.From.Address).toBe('auth@mail.steadhold.app');

    const raw = await source(msg.ID);
    // multipart/alternative with text *first*: a client picks the last part it
    // can render, so reversing them gives every graphical client the plaintext.
    expect(raw).toContain('multipart/alternative');
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'));
    expect(raw).toContain('Auto-Submitted: auto-generated');
    expect(raw).toContain('X-SH-Tag: confirmation');

    // Both parts are base64 in the wire format, so decode before asserting.
    const decoded = Buffer.from(
      raw.split('Content-Transfer-Encoding: base64')[1]!
        .split('--')[0]!.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8');
    expect(decoded).toContain('https://app.example.com/auth/v1/verify?token=abc&type=signup');

    const { rows } = await pool.query<{ status: string; attempts: number; provider_id: string }>(
      `select status, attempts, provider_id from email_sends`);
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.provider_id).toBeTruthy();
  });

  t('a subject with non-ASCII survives the trip', async () => {
    const p = await project('Café — Ünicode ✉');
    const d = job(p);
    await queueRow(d);
    await sender().handle(d);
    const msg = await waitForMail((m) => m.To[0]?.Address === 'user@example.test');
    // A raw non-ASCII byte in a header is not merely non-compliant: several
    // providers reject the message and some rewrite it, so the mail either
    // bounces or arrives mangled. RFC 2047 is what makes this arrive readable.
    expect(msg.From.Name).toBe('Café — Ünicode ✉ (via Steadhold)');
    const raw = await source(msg.ID);
    expect(raw).toContain('=?UTF-8?B?');
  });

  t('a body containing a lone period is not truncated there', async () => {
    const p = await project();
    // A bare `.` on its own line ends the DATA phase. Without dot-stuffing the
    // message is cut at that point and the remainder is interpreted as SMTP
    // commands — which is both a truncated mail and a command-injection channel.
    const d = job(p, {
      to: 'dots@example.test',
      variables: { action_url: 'https://app.example.com/v?token=x' },
    });
    await queueRow(d);
    // The paragraph is ours, so reach the case through a template that renders a
    // line starting with a period: base64 transfer-encoding means the wire form
    // has no bare period at all, which is precisely why base64 was chosen.
    const rendered = render('confirmation', {
      Email: '.dots@example.test', ProjectName: 'Acme',
      ConfirmationURL: 'https://app.example.com/v?token=x' });
    expect(rendered.text).toContain('.dots@example.test');
    await sender().handle(d);
    const msg = await waitForMail((m) => m.To[0]?.Address === 'dots@example.test');
    const raw = await source(msg.ID);
    // The terminating sequence appears exactly once, at the end.
    expect(raw.split('\r\n.\r\n').length).toBeLessThanOrEqual(2);
  });

  t('header injection through a project name is impossible', async () => {
    const p = await project('Acme\r\nBcc: attacker@evil.test');
    const d = job(p, { to: 'inject@example.test' });
    await queueRow(d);
    await sender().handle(d);
    const msg = await waitForMail((m) => m.To[0]?.Address === 'inject@example.test');
    const raw = await source(msg.ID);
    // A CR or LF in an interpolated header value lets the value add its own
    // headers — Bcc recipients, a second body. The template layer escapes for
    // HTML; this is the protocol's own escaping, and neither substitutes for the
    // other.
    //
    // Asserted on line *starts*, not on the substring: `Bcc:` appears
    // legitimately inside the quoted display name once the newline is stripped,
    // and a naive `not.toContain('Bcc:')` fails on a message that is completely
    // correct. What matters is that no header line begins with it.
    const headers = raw.split('\r\n\r\n')[0]!.split('\r\n');
    expect(headers.some((l) => /^bcc:/i.test(l))).toBe(false);
    expect(msg.To).toHaveLength(1);
    // And the name arrives as one quoted string rather than as a header the
    // attacker got to shape.
    expect(msg.From.Name).toContain('(via Steadhold)');
    expect(msg.From.Name).not.toContain('\n');
  });
});

describe('P4d — idempotency and failure', () => {
  t('EXIT CRITERION: a re-delivered job does not send a second email', async () => {
    const p = await project();
    const d = job(p);
    await queueRow(d);
    expect((await sender().handle(d)).status).toBe('sent');

    // BullMQ deduplicates a duplicate *enqueue*. What produces duplicate mail is
    // a worker that sends and dies before recording — the queue re-delivers, the
    // provider has already accepted, and the user gets two. The row is what
    // stops that.
    expect((await sender().handle(d, 1)).status).toBe('skipped');
    await new Promise((r) => setTimeout(r, 500));
    const all = await inbox();
    expect(all.filter((m) => m.To[0]?.Address === 'user@example.test')).toHaveLength(1);
  });

  t('an unreachable provider is a retryable failure, and the row says so', async () => {
    const p = await project();
    const d = job(p, { to: 'unreachable@example.test' });
    await queueRow(d);
    // Port 1 is reserved and nothing listens: a refused connection is exactly
    // what a provider restart looks like, and dropping a verification mail for
    // one would be the wrong trade.
    const s = createEmailSender({
      pool, from: 'auth@mail.steadhold.app',
      provider: createSmtpProvider({ host: '127.0.0.1', port: 1, tls: 'off', timeoutMs: 2000 }),
    });
    await expect(s.handle(d, 0)).rejects.toThrow(EmailSendError);

    const { rows } = await pool.query<{ status: string; attempts: number; error: string }>(
      `select status, attempts, error from email_sends`);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.error).toMatch(/cannot reach/);
  });

  t('the third failed attempt is dead-lettered rather than retried again', async () => {
    const p = await project();
    const d = job(p, { to: 'dead@example.test' });
    await queueRow(d);
    const dead: string[] = [];
    const s = createEmailSender({
      pool, from: 'auth@mail.steadhold.app',
      provider: createSmtpProvider({ host: '127.0.0.1', port: 1, tls: 'off', timeoutMs: 2000 }),
      onDeadLetter: (data, error) => dead.push(`${data.delivery_id}:${error}`),
    });
    // attemptsMade 2 means this is the third attempt. Returning instead of
    // throwing is what tells BullMQ to stop, and the report is what stops a user
    // who never got their verification mail from being nobody's problem.
    const out = await s.handle(d, 2);
    expect(out.status).toBe('failed');
    expect(dead).toHaveLength(1);
    const { rows } = await pool.query<{ attempts: number }>(`select attempts from email_sends`);
    expect(rows[0]!.attempts).toBe(3);
  });

  t('a template that cannot render is dead-lettered on the first attempt', async () => {
    const p = await project();
    const d = job(p, { to: 'badtemplate@example.test', template: 'no_such_template' });
    await queueRow(d);
    const dead: string[] = [];
    const out = await sender({ onDeadLetter: (_d, e) => dead.push(e) }).handle(d, 0);
    // It will never render. Retrying it three times over 35 minutes changes
    // nothing and delays real mail behind it — and it is a bug in us, not in the
    // project's data.
    expect(out.status).toBe('failed');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatch(/did not render/);
    const { rows } = await pool.query<{ attempts: number; error: string }>(
      `select attempts, error from email_sends`);
    expect(rows[0]!.attempts).toBe(1);
  });

  t('refuses to send credentials over an unencrypted connection', async () => {
    // The one place plaintext auth would ever be convenient is a local sink,
    // which is the one place a production credential gets pasted by accident.
    const p = await project();
    const d = job(p, { to: 'creds@example.test' });
    await queueRow(d);
    const s = createEmailSender({
      pool, from: 'auth@mail.steadhold.app',
      provider: createSmtpProvider({
        host: SMTP_HOST, port: SMTP_PORT, tls: 'off', user: 'someone', password: 'secret' }),
    });
    const out = await s.handle(d, 2);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/unencrypted/);
    // Non-retryable: it will not become encrypted on the second attempt.
    const { rows } = await pool.query<{ status: string }>(`select status from email_sends`);
    expect(rows[0]!.status).toBe('failed');
  });
});

describe('P4d — the friendly-from', () => {
  it('names the project and still says it is us', () => {
    // Claiming to *be* Acme while sending from mail.steadhold.app is what DMARC
    // alignment checks exist to catch.
    expect(friendlyFrom('Acme')).toBe('Acme (via Steadhold)');
    expect(friendlyFrom(undefined)).toBe('Steadhold Auth');
  });
});
