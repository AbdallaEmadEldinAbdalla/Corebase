import { createHash, createHmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

/**
 * A minimal S3 client, for the one thing only the control plane may do: delete.
 *
 * ## Why this exists at all
 *
 * Every other interaction with object storage happens inside a project's
 * container, through pgBackRest. Destruction cannot: by the time a purged
 * project's repo is due to be destroyed (D-066: purge + 30 days) the container,
 * the volume and the credentials are all gone, so there is nowhere to run
 * `pgbackrest` any more. The control plane has to reach the bucket itself.
 *
 * That is also the access model the design already asks for (backups §6): nodes
 * hold tokens that can put/get/list their own prefixes, and **delete rights live
 * only with the control plane**. A compromised node can read its tenants'
 * encrypted repos and cannot destroy history. This module is the other half of
 * that sentence.
 *
 * ## Why hand-written
 *
 * The surface needed is two operations — list a prefix, delete a batch — and
 * SigV4 is a specified, stable algorithm. The same reasoning put the Docker
 * Engine client in this repo rather than a Docker SDK: an SDK that wraps all of
 * S3 is a large supply-chain and upgrade cost for a list and a delete, and the
 * signing is the only hard part, which is eighty lines of `node:crypto`.
 */

export interface S3Config {
  /** Host only — no scheme, no port. */
  endpoint: string;
  port: number;
  bucket: string;
  key: string;
  secret: string;
  region: string;
  /** MinIO needs path-style; R2 accepts it. */
  uriStyle: 'path' | 'host';
  /** Off against the staging store, whose certificate is self-signed. */
  verifyTls: boolean;
  timeoutMs?: number;
}

const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();

/**
 * URI-encode a path segment the way S3 requires.
 *
 * `encodeURIComponent` leaves `!'()*` alone and S3's canonical request does not,
 * so a key containing any of them signs correctly here and fails against the real
 * service — the class of bug that only ever appears for the one customer whose
 * object name has an apostrophe in it.
 */
const uriEncode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Encode a key for a URL path: every segment escaped, the slashes kept. */
const encodeKeyPath = (key: string): string => key.split('/').map(uriEncode).join('/');

export interface S3Response { status: number; body: string }

export function createS3(cfg: S3Config) {
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const service = 's3';

  /**
   * Sign and send one request.
   *
   * `UNSIGNED-PAYLOAD` is deliberately not used: the payload hash is computed and
   * signed, which is what lets the store reject a body that was altered in
   * flight. For a *delete* that is worth the hash — a truncated or rewritten
   * delete request is the one request whose corruption is silently destructive.
   */
  async function send(
    method: string, key: string, opts: {
      query?: Record<string, string>;
      body?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<S3Response> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const path = cfg.uriStyle === 'path'
      ? `/${cfg.bucket}${key ? '/' + encodeKeyPath(key) : ''}`
      : `/${key ? encodeKeyPath(key) : ''}`;
    const host = cfg.uriStyle === 'path'
      ? `${cfg.endpoint}:${cfg.port}`
      : `${cfg.bucket}.${cfg.endpoint}:${cfg.port}`;

    // Canonical query: sorted by key, both halves URI-encoded.
    const query = opts.query ?? {};
    const canonicalQuery = Object.keys(query).sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`).join('&');

    const body = opts.body ?? '';
    const payloadHash = sha256Hex(body);
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      // Explicit, because Node falls back to chunked transfer encoding without it
      // and S3 rejects a chunked `DeleteObjects` outright:
      //   411 MissingContentLength: You must provide the Content-Length header.
      // Signed along with everything else, which is the correct handling — the
      // length is part of what the signature attests to.
      ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
      ...(opts.headers ?? {}),
    };
    const signedNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = signedNames
      .map((h) => `${h}:${String(headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim()}\n`)
      .join('');
    const signedHeaders = signedNames.join(';');

    const canonicalRequest = [
      method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secret}`, dateStamp), cfg.region), service), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    headers['authorization'] =
      `AWS4-HMAC-SHA256 Credential=${cfg.key}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const fullPath = canonicalQuery ? `${path}?${canonicalQuery}` : path;
    // Always TLS. pgBackRest has no plain-HTTP mode for S3, so every store this
    // talks to — R2 or the staging substitute — serves HTTPS (D-266); the
    // self-signed case is covered by relaxing verification, not the protocol.
    return new Promise<S3Response>((resolve, reject) => {
      const r = httpsRequest({
        host: cfg.endpoint, port: cfg.port, path: fullPath, method, headers,
        rejectUnauthorized: cfg.verifyTls, timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      r.on('timeout', () => r.destroy(new Error(`${method} ${fullPath} timed out`)));
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  }

  return {
    /**
     * Every key under a prefix, following continuation tokens.
     *
     * Paged rather than capped: a repo with more than a thousand objects is
     * ordinary — WAL segments alone reach that in days — and a delete that
     * silently stopped at the first page would report success over a prefix it had
     * mostly left alone. That is the exact failure "provable destruction" is
     * supposed to rule out.
     */
    async list(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      let token: string | undefined;
      for (let page = 0; page < 10_000; page++) {
        const res = await send('GET', '', {
          query: {
            'list-type': '2',
            prefix,
            'max-keys': '1000',
            ...(token ? { 'continuation-token': token } : {}),
          },
        });
        if (res.status !== 200) {
          throw new Error(`S3 list ${prefix} → ${res.status}: ${res.body.slice(0, 300)}`);
        }
        for (const m of res.body.matchAll(/<Key>([^<]*)<\/Key>/g)) {
          keys.push(decodeXml(m[1]!));
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(res.body);
        token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(res.body)?.[1];
        if (!truncated || !token) return keys;
        token = decodeXml(token);
      }
      throw new Error(`S3 list ${prefix} did not terminate after 10000 pages`);
    },

    /** Delete one object. Used for the residue a batch delete reports as failed. */
    async deleteObject(key: string): Promise<void> {
      const res = await send('DELETE', key);
      // 204 is the success; 404 means someone else already removed it, which for a
      // destruction is the desired end state rather than an error.
      if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
        throw new Error(`S3 delete ${key} → ${res.status}: ${res.body.slice(0, 300)}`);
      }
    },

    /**
     * Delete up to 1000 keys in one request, returning the ones that failed.
     *
     * Failures are returned rather than thrown, because a partial delete is the
     * normal shape of an S3 batch response and the caller's job is to notice the
     * prefix is not yet empty — not to guess which half of the batch landed.
     */
    async deleteBatch(keys: readonly string[]): Promise<string[]> {
      if (keys.length === 0) return [];
      if (keys.length > 1000) throw new Error('S3 DeleteObjects takes at most 1000 keys');
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join('') +
        '<Quiet>true</Quiet></Delete>';
      const res = await send('POST', '', {
        query: { delete: '' },
        body,
        headers: {
          'content-md5': createHash('md5').update(body).digest('base64'),
          'content-type': 'application/xml',
        },
      });
      if (res.status !== 200) {
        throw new Error(`S3 batch delete → ${res.status}: ${res.body.slice(0, 300)}`);
      }
      // With Quiet=true only errors come back.
      return [...res.body.matchAll(/<Error>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<\/Error>/g)]
        .map((m) => decodeXml(m[1]!));
    },
  };
}

export type S3 = ReturnType<typeof createS3>;

const escapeXml = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const decodeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * Build a client from the environment.
 *
 * The endpoint is **the control plane's** view of the store, which is not always
 * the projects' view. In production both are R2 over the internet and the two are
 * the same hostname; locally they cannot be. A project container reaches the store
 * through the data node's NAT egress, so its endpoint is the store's address on the
 * compose network — and the control plane runs on the host, which cannot route to a
 * container IP at all and must use the published port instead.
 *
 * Getting this wrong is a 30-second timeout that looks exactly like a wrong secret
 * or a firewall, which is why the two are separate variables rather than one
 * variable and a hope. `CB_BACKUP_S3_CONTROL_ENDPOINT` falls back to the
 * project-facing one, so a production config that sets only the latter is correct
 * by default.
 */
export function s3FromEnv(env = process.env): S3Config | undefined {
  const endpoint = env['CB_BACKUP_S3_CONTROL_ENDPOINT'] ?? env['CB_BACKUP_S3_ENDPOINT'];
  const bucket = env['CB_BACKUP_S3_BUCKET'];
  const key = env['CB_BACKUP_S3_KEY'];
  const secret = env['CB_BACKUP_S3_SECRET'];
  if (!endpoint || !bucket || !key || !secret) return undefined;
  return {
    endpoint, bucket, key, secret,
    port: Number(env['CB_BACKUP_S3_CONTROL_PORT'] ?? env['CB_BACKUP_S3_PORT'] ?? 443),
    region: env['CB_BACKUP_S3_REGION'] === 'auto'
      // SigV4 needs a real region in the credential scope, and R2 wants
      // `auto` in the config but signs with `us-east-1`. Sending `auto` here
      // produces a SignatureDoesNotMatch that reads like a wrong secret.
      ? 'us-east-1' : (env['CB_BACKUP_S3_REGION'] ?? 'us-east-1'),
    uriStyle: env['CB_BACKUP_S3_URI_STYLE'] === 'host' ? 'host' : 'path',
    verifyTls: env['CB_BACKUP_S3_VERIFY_TLS'] !== 'n',
  };
}
