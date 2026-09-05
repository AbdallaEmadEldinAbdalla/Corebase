import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { decodeUnverified, verify as verifyJwt, JwtError } from '@corebase/jwt';
import type { RateLimiter } from '../../kernel/rate-limit.ts';
import { rateLimitKey } from '../../kernel/rate-limit.ts';
import { refFromHost, type RoutingTable, type RouteEntry } from './routing.ts';

/**
 * The thin gateway (P5c, D-016): resolve, validate, rate-limit, proxy.
 *
 * The mandate is a negative one and worth stating as such, because every future
 * feature will want to violate it. The gateway does **not** parse queries, does
 * **not** query the control plane on the hot path (D-051), does **not** inspect
 * response bodies, and does **not** hold customer data. The entire hot path is a
 * map lookup, one ES256 verification, three Redis bucket checks and a proxy.
 *
 * Hops 3–7 of the request pipeline live here; hops 8–9 are PostgREST's and
 * Postgres's, and their responses pass through **verbatim** (D-106). Rewriting
 * them would put a JSON parse and serialize on the hot path *and* break every
 * Supabase-compatible client, which keys off PGRST and SQLSTATE codes.
 */

export interface GatewayDeps {
  routes: RoutingTable;
  /** `<ref>.<domain>` — how a Host becomes a ref. */
  projectDomain: string;
  /** D-033's layered buckets. Per-IP, per-key, per-project. */
  ipLimiter: RateLimiter;
  keyLimiter: RateLimiter;
  projectLimiter: RateLimiter;
  /** Wakes a paused project. Absent means a paused project stays 503 forever. */
  resume?: ((projectId: string) => Promise<void>) | undefined;
  /** P5a's signal: this project served data-plane traffic. */
  traffic?: { seen(projectId: string): void } | undefined;
  /** Overridable so tests can point at a local PostgREST. */
  upstreamFor?: ((entry: RouteEntry) => string | undefined) | undefined;
  onError?: ((err: Error, ctx: Record<string, unknown>) => void) | undefined;
}

/** The D-032 envelope, for gateway-originated errors only (hops 3–7). */
function fail(
  reply: FastifyReply, req: FastifyRequest,
  status: number, code: string, message: string,
  headers: Record<string, string> = {},
) {
  const requestId = String(reply.getHeader('x-request-id') ?? req.id);
  for (const [k, v] of Object.entries(headers)) reply.header(k, v);
  return reply.status(status).send({ error: { code, message, request_id: requestId } });
}

export function registerGateway(app: FastifyInstance, deps: GatewayDeps) {
  /**
   * Hops 3–6, in the doc's order — and the order is the design.
   *
   * Resolution before key validation, because a key cannot be checked against a
   * project that has not been identified. Key validation before rate limiting, so
   * an unauthenticated flood cannot consume a *valid* key's budget. Rate limiting
   * before the paused check, so a burst at a paused project cannot enqueue a
   * resume per request. Every one of those is a denial-of-service on somebody
   * else if it moves.
   */
  async function admit(
    req: FastifyRequest, reply: FastifyReply,
  ): Promise<RouteEntry | undefined> {
    // ── hop 3: project resolution ──────────────────────────────────────────
    const ref = refFromHost(req.headers['host'], deps.projectDomain);
    const entry = ref ? deps.routes.lookup(ref) : undefined;
    if (!entry) {
      await fail(reply, req, 404, 'project_not_found', 'No such project.');
      return undefined;
    }

    // ── hop 4: apikey validation ───────────────────────────────────────────
    const apikey = req.headers['apikey'];
    if (typeof apikey !== 'string' || !apikey) {
      await fail(reply, req, 401, 'missing_api_key',
        'Every data-plane request needs the project\'s API key in the `apikey` header.');
      return undefined;
    }
    // Revocation is a set membership test on a hash, not a query — the whole
    // point of carrying it in the routing entry. A revoked key must fail on the
    // hot path or revocation is advisory.
    const hash = createHash('sha256').update(apikey).digest('hex');
    if (entry.revoked.has(hash)) {
      await fail(reply, req, 401, 'invalid_api_key', 'That API key has been revoked.');
      return undefined;
    }
    if (!verifyApiKey(apikey, entry, deps.projectDomain)) {
      // One code for a bad signature, a wrong ref and a malformed token. They are
      // the same answer to the caller, and distinguishing them tells somebody
      // holding a key from another project which half they got right.
      await fail(reply, req, 401, 'invalid_api_key',
        'That API key is not valid for this project.');
      return undefined;
    }

    // Recorded here, after the key is verified and before anything else can
    // reject: traffic to a paused project is still traffic, and it is exactly the
    // evidence that pausing it was wrong (P5a).
    deps.traffic?.seen(entry.projectId);

    // ── hop 5: rate limits ─────────────────────────────────────────────────
    // Layered, because each catches what the others cannot: per-IP stops one host
    // from drowning a project, per-key stops one leaked key from spending the
    // project's whole budget, and per-project is the tier's actual ceiling.
    for (const [limiter, bucket, id] of [
      [deps.ipLimiter, 'gw-ip', req.ip ?? 'unknown'],
      [deps.keyLimiter, 'gw-key', hash.slice(0, 32)],
      [deps.projectLimiter, 'gw-project', entry.projectId],
    ] as const) {
      const hit = await limiter.hit(rateLimitKey(bucket, id));
      if (!hit.allowed) {
        await fail(reply, req, 429, 'rate_limited',
          `Too many requests. Retry in ${hit.retryAfterSeconds}s.`, {
            'retry-after': String(hit.retryAfterSeconds),
            'x-ratelimit-remaining': String(hit.remaining),
          });
        return undefined;
      }
    }

    // ── hop 6: paused, deleted, suspended ──────────────────────────────────
    if (entry.status === 'paused' || entry.status === 'pausing') {
      // The first request back is the wake-up call (D-103). Enqueued with a
      // per-project idempotency key, so a burst collapses to one job rather than
      // one per request — the reason this sits *after* the rate limits.
      if (deps.resume) {
        await deps.resume(entry.projectId).catch((err: Error) =>
          deps.onError?.(err, { ref: entry.ref, at: 'resume' }));
      }
      // 503 and not a held-open request: the gateway does not block in V1
      // (OQ-102). `Retry-After: 5` puts an SDK's retries at ~5/10/15s, riding the
      // p50 <5s / p95 <15s resume targets, so the first retry lands at the median.
      await fail(reply, req, 503, 'project_resuming',
        'Project is resuming; retry after the indicated delay.', { 'retry-after': '5' });
      return undefined;
    }
    if (entry.status === 'soft_deleted' || entry.status === 'deleting') {
      // 410 rather than 404: the project existed and is gone, which is a
      // different thing for a client to log than a typo in a hostname.
      await fail(reply, req, 410, 'project_deleted', 'This project has been deleted.');
      return undefined;
    }
    if (entry.status !== 'ready') {
      await fail(reply, req, 503, 'service_unavailable',
        `This project is ${entry.status} and is not serving yet.`);
      return undefined;
    }
    return entry;
  }

  /**
   * Hop 7 — `/rest/v1/*` to the project's PostgREST.
   *
   * A wildcard rather than a route per verb, because the gateway is deliberately
   * ignorant of what PostgREST's surface *is*: filters, embeds, RPC and whatever
   * upstream adds next all arrive here identically. Knowing the shape of the API
   * it proxies is exactly the thing D-016 forbids.
   */
  app.all('/rest/v1/*', async (req, reply) => {
    const entry = await admit(req, reply);
    if (!entry) return reply;

    const upstream = deps.upstreamFor?.(entry)
      ?? (entry.nodeAddress && entry.postgrestPort
        ? `http://${entry.nodeAddress}:${entry.postgrestPort}`
        : undefined);
    if (!upstream) {
      await fail(reply, req, 503, 'service_unavailable',
        'This project has no data API yet.');
      return reply;
    }

    const url = new URL(req.url.replace(/^\/rest\/v1/, '') || '/', upstream);
    const requestId = String(reply.getHeader('x-request-id') ?? req.id);

    // D-109: when `Authorization` is absent the apikey becomes it, so PostgREST
    // has exactly one authorization path — "verify Authorization, read role" —
    // and `db-anon-role` never handles anything security-relevant on its own.
    // Without this there are two paths and the fallback is the one nobody tests;
    // P5b's own suite tripped over exactly that.
    const auth = req.headers['authorization'] ?? `Bearer ${req.headers['apikey'] as string}`;

    const headers: Record<string, string> = {
      authorization: auth as string,
      // Forwarded so `corebase.pre_request` can stamp it into application_name
      // (D-105) — this is how a slow query traces back to an HTTP request.
      'x-request-id': requestId,
      accept: (req.headers['accept'] as string) ?? 'application/json',
    };
    // A short allowlist rather than a blanket copy. `Host` must not be forwarded
    // (it names the gateway's world, not the upstream's), and neither must
    // `apikey` — PostgREST has no use for it and it is a credential.
    for (const h of ['content-type', 'prefer', 'range', 'accept-profile', 'content-profile']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }

    try {
      const res = await fetch(url, {
        method: req.method,
        headers,
        // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not
        // an absent key — the body is spread conditionally or not at all.
        ...(req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined
          ? { body: JSON.stringify(req.body) }
          : {}),
        signal: AbortSignal.timeout(30_000),
      });

      // Verbatim (D-106). The body is streamed through as bytes and never parsed:
      // rewriting it would put a JSON round trip on the hot path and break every
      // Supabase-compatible client, which branches on PGRST and SQLSTATE codes.
      reply.status(res.status);
      for (const [k, v] of res.headers) {
        // Hop-by-hop headers belong to the connection we just used, not to the
        // one we are answering on; forwarding them corrupts framing.
        if (['transfer-encoding', 'connection', 'keep-alive'].includes(k.toLowerCase())) continue;
        reply.header(k, v);
      }
      reply.header('x-request-id', requestId);
      return reply.send(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      deps.onError?.(err as Error, { ref: entry.ref, at: 'proxy', upstream });
      // The project's API is unreachable — a node problem, not a client one, and
      // the alert fires on the gateway's own error rate rather than here.
      return fail(reply, req, 503, 'service_unavailable',
        'The project\'s data API is not reachable right now.');
    }
  });
}

/**
 * Is this apikey valid for this project?
 *
 * Two checks that are easy to mistake for one. The **signature** proves the key
 * was minted by this project's keypair; the **`ref` claim** proves it was minted
 * for this project rather than merely by a key this project also publishes. They
 * come apart during a rotation, when two projects could in principle be handed
 * overlapping key sets by a bug — and the ref check is what makes that
 * unexploitable.
 *
 * Every published key is tried, not just the first: P4h's rotation means a valid
 * key may be signed by the outgoing kid for the length of a swap window.
 */
function verifyApiKey(apikey: string, entry: RouteEntry, domain: string): boolean {
  let claimedRef: string;
  let role: unknown;
  try {
    const decoded = decodeUnverified(apikey);
    claimedRef = String(decoded.claims['ref'] ?? '');
    role = decoded.claims['role'];
  } catch {
    return false;
  }
  if (claimedRef !== entry.ref) return false;
  // A *user* access token in the apikey slot is the likeliest mistake, and it
  // must not pass: letting a user's own credential select the project is a
  // different trust decision from a project key doing so (D-320).
  if (role !== 'anon' && role !== 'service_role') return false;

  const issuer = `https://${entry.ref}.${domain}`;
  for (const jwk of entry.jwks) {
    const pem = jwkToPem(jwk);
    if (!pem) continue;
    try {
      verifyJwt(apikey, { publicKeyPem: pem, issuer });
      return true;
    } catch (err) {
      if (!(err instanceof JwtError)) throw err;
    }
  }
  return false;
}

/**
 * P-256 JWK → SPKI PEM.
 *
 * The routing table carries JWKs because that is what both JWKS endpoints serve
 * and keeping one representation avoids the two drifting. Verification wants a
 * PEM, so the conversion happens here rather than storing both — and it is a
 * fixed prefix plus the two coordinates, because the curve is fixed (ES256, D-014)
 * and a general JWK library would be a dependency for one shape.
 */
const P256_SPKI_PREFIX = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

function jwkToPem(jwk: Record<string, unknown>): string | undefined {
  if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256') return undefined;
  const x = typeof jwk['x'] === 'string' ? Buffer.from(jwk['x'], 'base64url') : undefined;
  const y = typeof jwk['y'] === 'string' ? Buffer.from(jwk['y'], 'base64url') : undefined;
  if (!x || !y || x.length !== 32 || y.length !== 32) return undefined;
  const der = Buffer.concat([P256_SPKI_PREFIX, Buffer.from([0x04]), x, y]);
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}
