import { createHash, createHmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

/**
 * A minimal S3 client, shared by the two components that talk to object storage
 * directly: the control plane's repo destruction, and the storage service.
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

export interface S3Response {
  status: number;
  /** The response as text. Empty when `raw` was asked for. */
  body: string;
  /** The response as bytes. Always present — `body` is a convenience over it. */
  bytes: Buffer;
  headers: Record<string, string | undefined>;
}

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
      body?: Buffer | string;
      headers?: Record<string, string>;
      /** Keep the response as bytes. Text is the default and wrong for objects. */
      raw?: boolean;
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

    // Buffer throughout, because an object's bytes are not text: decoding a PNG
    // to a string to hash it corrupts both the hash and the upload.
    const body = Buffer.isBuffer(opts.body)
      ? opts.body
      : Buffer.from(opts.body ?? '', 'utf8');
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
      ...(body.length ? { 'content-length': String(body.length) } : {}),
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
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            body: opts.raw ? '' : buf.toString('utf8'),
            bytes: buf,
            headers: res.headers as Record<string, string | undefined>,
          });
        });
      });
      r.on('timeout', () => r.destroy(new Error(`${method} ${fullPath} timed out`)));
      r.on('error', reject);
      if (body.length) r.write(body);
      r.end();
    });
  }

  return {
    /**
     * A presigned PUT the client uses to upload **directly to the store**.
     *
     * The one place raw store presigning appears (D-122). Every other capability
     * we hand out is a Corebase-signed token this service verifies; here the
     * client genuinely must talk to the store, so the credential has to be one
     * the store recognises.
     *
     * ## The cap, and what it actually is
     *
     * `content-length` is a **signed header**, not a range. The doc calls for a
     * `content-length-range`, which is a POST-policy construct and belongs to a
     * different upload shape (browser form POST); for a presigned PUT the
     * equivalent guarantee is stronger: the client must send exactly the length
     * that was signed, or the signature does not match. So a URL issued for a
     * 200 MB upload cannot be reused to push 2 GB.
     *
     * `content-type` is signed for the same reason — a leaked upload URL cannot
     * be repurposed for a different file shape.
     *
     * ## `UNSIGNED-PAYLOAD`
     *
     * Unavoidable and correct here: the bytes do not exist yet when the URL is
     * signed, so their hash cannot be. That is precisely why the completion
     * callback re-reads the object's true size and etag from the store rather
     * than believing the client — see the storage module.
     */
    presignPut(
      key: string,
      opts: { expiresInSeconds: number; contentType: string; contentLength: number },
    ): string {
      const now = new Date();
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const scope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;

      const path = cfg.uriStyle === 'path'
        ? `/${cfg.bucket}/${encodeKeyPath(key)}`
        : `/${encodeKeyPath(key)}`;
      const host = cfg.uriStyle === 'path'
        ? `${cfg.endpoint}:${cfg.port}`
        : `${cfg.bucket}.${cfg.endpoint}:${cfg.port}`;

      // Both headers are signed, so both are in `SignedHeaders` and both must be
      // sent by the client exactly as signed.
      const signedHeaders = 'content-length;content-type;host';
      const canonicalHeaders =
        `content-length:${opts.contentLength}\n`
        + `content-type:${opts.contentType}\n`
        + `host:${host}\n`;

      const query: Record<string, string> = {
        'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
        'X-Amz-Credential': `${cfg.key}/${scope}`,
        'X-Amz-Date': amzDate,
        'X-Amz-Expires': String(opts.expiresInSeconds),
        'X-Amz-SignedHeaders': signedHeaders,
      };
      const canonicalQuery = Object.keys(query).sort()
        .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`).join('&');

      const canonicalRequest = [
        'PUT', path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD',
      ].join('\n');
      const stringToSign = [
        'AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest),
      ].join('\n');
      const signingKey = hmac(
        hmac(hmac(hmac(`AWS4${cfg.secret}`, dateStamp), cfg.region), service), 'aws4_request');
      const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

      return `https://${host}${path}?${canonicalQuery}`
        + `&X-Amz-Signature=${signature}`;
    },

    /**
     * Store bytes at a key, and hand back the store's own etag.
     *
     * The etag is the reason this returns anything: it is what the metadata row
     * records, and it is the only value that lets a later sweep tell "these
     * bytes are the ones the row describes" from "something overwrote them".
     * Inventing it locally from a hash of what we sent would defeat that — the
     * question is what the *store* holds.
     *
     * `Content-Type` is signed along with the rest, so a store that serves it
     * back is serving what was attested to rather than what a later request
     * claimed.
     */
    async putObject(
      key: string, body: Buffer,
      opts: { contentType?: string; cacheControl?: string } = {},
    ): Promise<{ etag: string }> {
      const res = await send('PUT', key, {
        body,
        headers: {
          'content-type': opts.contentType ?? 'application/octet-stream',
          ...(opts.cacheControl ? { 'cache-control': opts.cacheControl } : {}),
        },
      });
      if (res.status !== 200) {
        throw new Error(`S3 put ${key} → ${res.status}: ${res.body.slice(0, 300)}`);
      }
      // Quoted in the header, and the quotes are part of neither the value nor
      // anything a client should have to strip.
      return { etag: (res.headers['etag'] ?? '').replace(/^"|"$/g, '') };
    },

    /**
     * Fetch an object's bytes, optionally a byte range.
     *
     * The range is passed through rather than interpreted, because range
     * semantics are the store's to implement and a partial response is a 206
     * that the caller must be told about — collapsing it to 200 would make a
     * media player think it had the whole file.
     */
    async getObject(
      key: string, opts: { range?: string } = {},
    ): Promise<{ status: number; bytes: Buffer; headers: Record<string, string | undefined> }> {
      const res = await send('GET', key, {
        raw: true,
        ...(opts.range ? { headers: { range: opts.range } } : {}),
      });
      return { status: res.status, bytes: res.bytes, headers: res.headers };
    },

    /**
     * Size and etag without the bytes.
     *
     * Used by the presigned-upload completion and by the sweep's inverse pass —
     * both of which need to know what the store actually holds and neither of
     * which wants to transfer it. A 404 is a normal answer here, not an error:
     * "there is nothing at this key" is exactly the question being asked.
     */
    async headObject(
      key: string,
    ): Promise<{ exists: boolean; size: number; etag: string; contentType: string }> {
      const res = await send('HEAD', key, { raw: true });
      if (res.status === 404) return { exists: false, size: 0, etag: '', contentType: '' };
      if (res.status !== 200) {
        throw new Error(`S3 head ${key} → ${res.status}`);
      }
      return {
        exists: true,
        size: Number(res.headers['content-length'] ?? 0),
        etag: (res.headers['etag'] ?? '').replace(/^"|"$/g, ''),
        contentType: res.headers['content-type'] ?? 'application/octet-stream',
      };
    },

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
