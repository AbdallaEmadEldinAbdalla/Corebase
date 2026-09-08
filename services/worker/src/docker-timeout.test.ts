import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDocker } from './docker.ts';

/**
 * The guard for a production defect, and it needs no Docker to hold.
 *
 * `main.ts` built the worker's Engine API client with no `timeoutMs`, so it
 * inherited the client's short default for **every** request — including
 * `/exec/<id>/start`, the one request that stays open for as long as the command
 * runs. Production drives pgbackrest through that path: `stanza-create`, a
 * `check` that forces a WAL switch and waits for it to archive, scheduled base
 * backups, and the D-078 final backup that gates deletion. Those are minute-scale
 * on a real database, so a 30s transport ceiling meant a backup past a certain
 * size failed at the HTTP layer with the saga blaming pgbackrest.
 *
 * It surfaced as two CI shards failing on a commit that changed only CSS, both
 * with `POST /exec/…/start timed out`. It had stayed invisible because the suite
 * carried per-file timeouts tuned until each file passed — 20s, 30s, 60s, 120s —
 * which is how a real defect gets normalised into a flake.
 *
 * The assertions are the contract, not the number: a slow exec finishes even when
 * the general timeout is short, and an ordinary slow request still fails fast.
 * That second one matters as much as the first — fast-fail on a container that
 * will not answer is what the short timeout is *for*, and fixing backups must not
 * have been bought by throwing it away.
 */
let server: Server;
let port: number;
let certDir: string;
const SLOW_MS = 1_500;
const SHORT_TIMEOUT = 300;

/** One frame of Docker's exec stream muxing: [stream,0,0,0,len32] + payload. */
const frame = (text: string): Buffer => {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(8);
  head[0] = 1;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
};

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'sh-dockertimeout-'));
  const ssl = (args: string[]) =>
    execFileSync('openssl', args, { cwd: certDir, stdio: 'pipe' });
  // One CA signing one leaf, used as both ends. The server asks for a client
  // certificate, so this runs the real mTLS path (D-052) rather than a plaintext
  // shortcut that would not exercise the same code.
  ssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key',
       '-out', 'ca.pem', '-days', '2', '-subj', '/CN=sh-test-ca']);
  ssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem',
       '-out', 'leaf.csr', '-subj', '/CN=localhost']);
  ssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
       '-out', 'cert.pem', '-days', '2']);
  writeFileSync(join(certDir, 'noop'), '');

  const read = (f: string) => readFileSync(join(certDir, f));
  server = createServer(
    { key: read('key.pem'), cert: read('cert.pem'), ca: read('ca.pem'),
      requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      const url = req.url ?? '';
      req.resume();
      const json = (body: unknown, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (/\/exec$/.test(url)) json({ Id: 'exec1' }, 201);
      // Only /start dawdles — exactly as a long-running command does. `create`
      // and the `json` inspect are ordinary fast requests.
      else if (/\/exec\/exec1\/start$/.test(url)) {
        setTimeout(() => { res.writeHead(200); res.end(frame('stanza created')); }, SLOW_MS);
      } else if (/\/exec\/exec1\/json$/.test(url)) json({ ExitCode: 0 });
      else if (/\/containers\/json/.test(url)) setTimeout(() => json([]), SLOW_MS);
      else json({ Version: '99.0' });
    });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
}, 60_000);

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const client = (over?: { timeoutMs?: number; execTimeoutMs?: number }) =>
  createDocker({ host: '127.0.0.1', port, certDir, timeoutMs: SHORT_TIMEOUT, ...over });

describe('the Engine API client times an exec differently from a request', () => {
  it('lets a slow exec finish though the general timeout is far shorter', async () => {
    const out = await client().execCapture('c1', ['pgbackrest', 'stanza-create']);
    expect(out.stdout).toContain('stanza created');
    expect(out.exitCode).toBe(0);
  }, 30_000);

  it('still fails an ordinary slow request fast', async () => {
    // The property the short timeout exists for, kept intact.
    await expect(client().listContainers('sh-managed=true'))
      .rejects.toThrow(/timed out/);
  }, 30_000);

  it('honours an explicit per-call exec timeout', async () => {
    // A caller that knows its command should be quick can still say so.
    await expect(client().execCapture('c1', ['true'], { timeoutMs: 200 }))
      .rejects.toThrow(/timed out/);
  }, 30_000);

  it('honours a client-wide exec ceiling when one is given', async () => {
    await expect(client({ execTimeoutMs: 200 }).execCapture('c1', ['true']))
      .rejects.toThrow(/timed out/);
  }, 30_000);
});
