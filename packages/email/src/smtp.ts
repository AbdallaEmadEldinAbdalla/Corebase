import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { EmailSendError, type EmailProvider, type OutgoingMessage, type SendResult } from './provider.ts';

/**
 * SMTP, hand-written, for the same reason the S3 client and the JWT signer are
 * (D-005's "compose the proven thing" applies to *infrastructure*, not to every
 * library): what is needed here is one narrow conversation — EHLO, optional
 * STARTTLS, optional AUTH, MAIL FROM, RCPT TO, DATA — and a general-purpose mailer
 * brings a dependency tree, a plugin system and an API surface for none of it.
 *
 * It also has to run under `--experimental-strip-types`, which strips types
 * without transpiling, so every dependency is a dependency whose build output has
 * to be checked.
 *
 * ## What this is for
 *
 * Two destinations, both real. Locally it talks to the Mailpit container that
 * stands in for Postmark, so tests exercise an actual SMTP conversation rather
 * than a mock's idea of one. And it is the shape D-117's per-project custom SMTP
 * needs, which is the top production ask.
 *
 * ## What it deliberately does not do
 *
 * No pipelining, no CHUNKING, no connection reuse, no DSN. One message per
 * connection is slower and is the right trade for a queue-driven sender: a
 * connection that carries one message cannot half-fail in a way that leaves the
 * next message's state ambiguous, which is the failure mode that produces
 * duplicate mail.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** `require` fails rather than sending in clear; `off` is for a local sink. */
  tls: 'require' | 'starttls' | 'off';
  user?: string | undefined;
  password?: string | undefined;
  /** Refuse to hang forever on a provider that accepted the TCP connection and stopped. */
  timeoutMs?: number | undefined;
  /** What we call ourselves in EHLO. Some providers care; a sink does not. */
  clientName?: string | undefined;
}

type AnySocket = Socket | TLSSocket;

/** One SMTP reply: a code and its text, with continuation lines joined. */
interface Reply { code: number; text: string }

/**
 * A line-oriented reader over the socket.
 *
 * SMTP replies are multi-line — `250-STARTTLS` then `250 AUTH ...` — and the
 * hyphen after the code is what says "more follows". Reading a fixed chunk and
 * parsing the first line is the classic way to get this wrong: the next command's
 * reply then arrives already in the buffer and every subsequent read is one reply
 * out of step, which presents as a working sender that mysteriously fails on some
 * servers.
 */
class Conversation {
  private socket: AnySocket;
  private buffer = '';
  private waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  private failure: Error | undefined;
  readonly timeoutMs: number;

  constructor(socket: AnySocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attach();
  }

  private attach() {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const parsed = this.takeReply();
        if (!parsed) break;
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(parsed);
      }
    });
    const fail = (err: Error) => {
      this.failure ??= err;
      while (this.waiters.length) this.waiters.shift()!.reject(err);
    };
    this.socket.on('error', fail);
    this.socket.on('close', () => fail(new Error('the SMTP server closed the connection')));
  }

  /** Pull one complete reply out of the buffer, or nothing if it is incomplete. */
  private takeReply(): Reply | undefined {
    const lines: string[] = [];
    let consumed = 0;
    for (;;) {
      const nl = this.buffer.indexOf('\r\n', consumed);
      if (nl === -1) return undefined;
      const line = this.buffer.slice(consumed, nl);
      consumed = nl + 2;
      lines.push(line);
      // A space in the fourth position ends the reply; a hyphen continues it.
      if (line.length >= 4 && line[3] === '-') continue;
      this.buffer = this.buffer.slice(consumed);
      const code = Number(lines[0]!.slice(0, 3));
      return { code, text: lines.map((l) => l.slice(4)).join('\n') };
    }
  }

  read(): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`the SMTP server said nothing for ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.waiters.push({
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  write(line: string): void { this.socket.write(line + '\r\n'); }

  /** Send a command and insist on an expected class of reply. */
  async command(line: string, expect: number[], redact = false): Promise<Reply> {
    this.write(line);
    const reply = await this.read();
    if (!expect.includes(Math.floor(reply.code / 100))) {
      // The command is in the message because "SMTP said 550" with no context is
      // undiagnosable — but never the AUTH line, which carries the password.
      throw new EmailSendError(
        `SMTP ${reply.code} in reply to ${redact ? '<credentials>' : line.split(' ')[0]}: ${reply.text}`,
        // 4xx is "try later" by definition and 5xx is "do not"; that is the
        // protocol's own distinction and the one the retry budget needs.
        Math.floor(reply.code / 100) === 4);
    }
    return reply;
  }

  replaceSocket(socket: AnySocket) {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    this.socket = socket;
    this.buffer = '';
    this.attach();
  }

  get raw(): AnySocket { return this.socket; }
  end() { try { this.socket.end(); } catch { /* already gone */ } }
}

/**
 * Fold a header value to stay under SMTP's 998-octet line limit, and encode it if
 * it is not ASCII.
 *
 * Subjects carry project names, which carry apostrophes, accents and emoji. A raw
 * non-ASCII byte in a header is not merely non-compliant — several providers
 * reject the message and some rewrite it, so the mail either bounces or arrives
 * mangled. RFC 2047 base64 is the encoding every client understands.
 */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Quote a display name, so RFC 5322 reads it as one.
 *
 * The friendly-from is `Acme (via Corebase)`, and unquoted that is **not** the
 * name it looks like: parentheses delimit a *comment* in a mail header, so
 * `Acme (via Corebase) <auth@…>` parses as the display name "Acme" with a
 * comment beside it, and the recipient sees "Acme" alone. The live sink caught
 * exactly that — which matters because the "via Corebase" half is the part that
 * keeps us from claiming to *be* the customer while sending from our own domain,
 * which is what DMARC alignment exists to catch.
 *
 * Quoting also removes the whole class of `,` `;` `<` `>` `:` parsing surprises
 * in a name a customer typed. Inside the quotes only `"` and `\` need escaping.
 */
function displayName(value: string): string {
  const safe = headerSafe(value).replace(/[\\"]/g, (c) => '\\' + c);
  // A non-ASCII name becomes an RFC 2047 encoded-word, which must *not* be
  // quoted: a quoted `=?UTF-8?B?…?=` is a literal string, not an encoding, and
  // the recipient sees the raw base64.
  return /^[\x20-\x7e]*$/.test(safe) ? `"${safe}"` : encodeHeader(safe);
}

/**
 * Strip anything that could end a header or inject one.
 *
 * Header injection through a display name or a subject is the classic mail bug: a
 * CR or LF in an interpolated value lets the value add `Bcc:` recipients or a
 * second body. The template layer escapes for HTML; this escapes for the
 * *protocol*, and neither substitutes for the other.
 */
const headerSafe = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();

/**
 * Escape a line that begins with a period.
 *
 * A bare `.` on its own line ends the DATA phase. A message body containing one —
 * which any quoted text or ASCII art can — would otherwise be truncated there and
 * the remainder interpreted as SMTP commands. Doubling the leading period is the
 * protocol's own answer and is not optional.
 */
const dotStuff = (body: string) =>
  body.split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');

function buildMime(m: OutgoingMessage, messageId: string): string {
  const boundary = `cb_${randomUUID().replace(/-/g, '')}`;
  const from = m.fromName ? `${displayName(m.fromName)} <${headerSafe(m.from)}>`
                          : headerSafe(m.from);
  const headers = [
    `From: ${from}`,
    `To: ${headerSafe(m.to)}`,
    `Subject: ${encodeHeader(headerSafe(m.subject))}`,
    `Message-ID: <${messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    ...(m.replyTo ? [`Reply-To: ${headerSafe(m.replyTo)}`] : []),
    // Transactional mail must not be bulk-unsubscribed or auto-replied to; the
    // first stops vacation responders talking to a no-reply address, the second
    // is what tells a provider this is not a campaign.
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
    ...(m.tag ? [`X-CB-Tag: ${headerSafe(m.tag)}`] : []),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  // Text first, HTML second, and the order is meaningful in multipart/alternative:
  // a client picks the *last* part it can render, so reversing these gives every
  // graphical client the plaintext.
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ];
  // base64 for both parts, which sidesteps the whole quoted-printable line-length
  // and trailing-whitespace class of bug — and makes dot-stuffing a formality
  // rather than a correctness requirement.
  return [...headers, '', ...body].join('\r\n');
}

export function createSmtpProvider(config: SmtpConfig): EmailProvider {
  const timeoutMs = config.timeoutMs ?? 15_000;
  const clientName = config.clientName ?? 'corebase';

  return {
    name: `smtp:${config.host}:${config.port}`,

    async send(m: OutgoingMessage): Promise<SendResult> {
      const messageId = `${randomUUID()}@corebase`;
      let socket: AnySocket;
      try {
        socket = config.tls === 'require'
          ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
          : createConnection({ host: config.host, port: config.port });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`no SMTP connection to ${config.host}:${config.port} in ${timeoutMs}ms`)),
            timeoutMs);
          socket.once(config.tls === 'require' ? 'secureConnect' : 'connect', () => {
            clearTimeout(timer); resolve();
          });
          socket.once('error', (err) => { clearTimeout(timer); reject(err); });
        });
      } catch (err) {
        // Connection-level failures are transient by default: a refused or reset
        // connection is exactly what a provider restart or a network blip looks
        // like, and dropping a verification mail for one is the wrong trade.
        throw new EmailSendError(`cannot reach the SMTP server: ${(err as Error).message}`, true);
      }

      const conv = new Conversation(socket, timeoutMs);
      try {
        const greeting = await conv.read();
        if (Math.floor(greeting.code / 100) !== 2) {
          throw new EmailSendError(`SMTP greeting was ${greeting.code}: ${greeting.text}`, true);
        }
        let ehlo = await conv.command(`EHLO ${clientName}`, [2]);

        if (config.tls === 'starttls') {
          if (!/STARTTLS/i.test(ehlo.text)) {
            // Fail rather than fall back to plaintext. A silent downgrade is how
            // credentials and a whole message end up on the wire in clear, and
            // the caller asked for STARTTLS.
            throw new EmailSendError(
              'the SMTP server does not offer STARTTLS, and downgrading is not an option', false);
          }
          await conv.command('STARTTLS', [2]);
          const secure = tlsConnect({ socket: conv.raw as Socket, servername: config.host });
          await new Promise<void>((resolve, reject) => {
            secure.once('secureConnect', () => resolve());
            secure.once('error', reject);
          });
          conv.replaceSocket(secure);
          // EHLO again: the extension list before and after TLS may differ, and
          // AUTH is commonly only advertised once the channel is encrypted.
          ehlo = await conv.command(`EHLO ${clientName}`, [2]);
        }

        if (config.user) {
          if (config.tls === 'off') {
            // Refusing to authenticate in clear even to a local sink, because the
            // one place this would ever be convenient is the one place a
            // production credential gets pasted by accident.
            throw new EmailSendError(
              'refusing to send SMTP credentials over an unencrypted connection', false);
          }
          const payload = Buffer.from(
            `\0${config.user}\0${config.password ?? ''}`, 'utf8').toString('base64');
          await conv.command(`AUTH PLAIN ${payload}`, [2], true);
        }

        await conv.command(`MAIL FROM:<${headerSafe(m.from)}>`, [2]);
        await conv.command(`RCPT TO:<${headerSafe(m.to)}>`, [2]);
        await conv.command('DATA', [3]);
        conv.raw.write(dotStuff(buildMime(m, messageId)) + '\r\n.\r\n');
        const accepted = await conv.read();
        if (Math.floor(accepted.code / 100) !== 2) {
          throw new EmailSendError(
            `the SMTP server refused the message: ${accepted.code} ${accepted.text}`,
            Math.floor(accepted.code / 100) === 4);
        }
        // QUIT is best-effort. The message is accepted at the 250 above, so
        // failing here would report a send that happened as a send that did not —
        // and the retry would put a second copy in somebody's inbox.
        await conv.command('QUIT', [2]).catch(() => undefined);
        return { providerId: messageId };
      } catch (err) {
        if (err instanceof EmailSendError) throw err;
        throw new EmailSendError((err as Error).message, true);
      } finally {
        conv.end();
      }
    },
  };
}
