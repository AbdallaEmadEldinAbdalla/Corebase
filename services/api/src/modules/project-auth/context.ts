import { Client } from 'pg';
import type { Pool } from 'pg';
import { decodeUnverified, verify as verifyJwt, JwtError } from '@corebase/jwt';
import { SECRET_NAMES, type SecretStore } from '@corebase/secrets';

/**
 * Which project a data-plane auth request belongs to, and how to reach it.
 *
 * ## Why the `apikey` and not the Host header
 *
 * The design has the **gateway** extract the ref from `<ref>.corebase.co` and hand
 * the auth module a resolved project context (D-051, D-110). There is no gateway
 * until Phase 5, so this resolves the project from the `apikey` header instead —
 * the project's own anon JWT, which carries `ref` in its claims and is **signed by
 * that project's key**.
 *
 * That is not a lesser substitute, and it is worth being precise about why: a Host
 * header is asserted by the caller and the gateway's job is to turn it into a
 * verified project. Here the assertion arrives already signed, so resolving it is
 * one verification rather than a lookup plus a trust decision. What the gateway
 * will add later is the *routing* (which node, which port) and the rate limits —
 * not the identity.
 *
 * `apikey` is required on every endpoint anyway (D-029), so nothing is being asked
 * of the client that the shipped design does not already ask.
 */

export class AuthContextError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthContextError';
    this.status = status;
  }
}

/** The project's auth settings, or the column defaults where it has no row. */
export interface AuthConfig {
  autoconfirm: boolean;
  disableSignup: boolean;
  accessTtlSeconds: number;
  passwordMinLength: number;
  /** Where auth links may send someone (P4c). Null means nowhere. */
  siteUrl: string | null;
  additionalRedirects: readonly string[];
  /** A session unrefreshed for this long is dead (P4e). */
  sessionIdleSeconds: number;
}

export const AUTH_CONFIG_DEFAULTS: AuthConfig = {
  autoconfirm: false, disableSignup: false,
  accessTtlSeconds: 3600, passwordMinLength: 8,
  // No default URL. A project that has configured nothing permits no redirect,
  // rather than permitting whatever the caller asked for (P4c).
  siteUrl: null, additionalRedirects: [],
  sessionIdleSeconds: 30 * 24 * 3600,
};

export interface ProjectContext {
  projectId: string;
  ref: string;
  /** The role the presented key carries: `anon` or `service_role`. */
  keyRole: 'anon' | 'service_role';
  /** Where the project's Postgres is, from the placement row. */
  host: string;
  port: number;
  /** The project's signing key, for minting access tokens. */
  signing: { privateKeyPem: string; publicKeyPem: string; kid: string };
  /** `corebase_auth`'s password in this project's database. */
  dbPassword: string;
  /** `https://<ref>.corebase.co/auth/v1` — the `iss` every *access token* carries. */
  issuer: string;
  /**
   * `https://<ref>.corebase.co` — the `iss` the project's **API keys** carry.
   *
   * A second issuer, and not an oversight: the anon key is minted by the
   * provisioning saga with the project's bare origin, while an access token's
   * `iss` is the auth module's own base URL per the token spec. Pinning one
   * string for both is how the first live run of this file 401'd every request —
   * the signature was fine and the issuer check was comparing an API key against
   * an endpoint URL.
   */
  keyIssuer: string;
  config: AuthConfig;
}

export interface ResolveDeps {
  pool: Pool;
  secrets: SecretStore;
  /** Overridable so tests and self-hosted deployments can name their own domain. */
  projectDomain?: string | undefined;
  /**
   * Pins the issuer that API keys must carry. Only needed where the saga was run
   * with `CB_JWT_ISSUER` set to something other than the project's own origin —
   * which is how the staging stack mints keys.
   */
  keyIssuer?: string | undefined;
}

/** The `iss` of access tokens this module mints. */
export const issuerFor = (ref: string, domain: string) => `https://${ref}.${domain}/auth/v1`;
/** The `iss` the provisioning saga puts in a project's anon/service_role keys. */
export const keyIssuerFor = (ref: string, domain: string) => `https://${ref}.${domain}`;

/**
 * Resolve and verify the project behind an `apikey`.
 *
 * The order matters. The key is decoded *unverified* first, purely to learn which
 * project's public key to check it against — there is no other way round, since
 * the verifying key is per project. Nothing from the unverified decode is trusted
 * beyond selecting that key: the signature check that follows is what makes the
 * ref real, and a key signed by project A naming project B fails it.
 */
export async function resolveProject(
  deps: ResolveDeps, apikey: string | undefined,
): Promise<ProjectContext> {
  if (!apikey) {
    throw new AuthContextError(401,
      'This endpoint needs your project\'s anon key in the `apikey` header.');
  }

  let claimedRef: string;
  let claimedRole: string;
  try {
    const decoded = decodeUnverified(apikey);
    claimedRef = String(decoded.claims['ref'] ?? '');
    claimedRole = String(decoded.claims['role'] ?? '');
  } catch {
    throw new AuthContextError(401, 'The `apikey` header is not a Corebase API key.');
  }
  if (!claimedRef) {
    throw new AuthContextError(401, 'That API key names no project.');
  }
  if (claimedRole !== 'anon' && claimedRole !== 'service_role') {
    // A *user* access token in the apikey slot is the likeliest mistake here, and
    // it must not be accepted: it would let a user's own token select the project,
    // which is a different trust decision from a project key doing so.
    throw new AuthContextError(401,
      'That is not a project API key. Use the project\'s anon or service_role key.');
  }

  // One query, LEFT JOIN for the config: a project with no config row is the
  // normal case, not an error, and an inner join here would make every project
  // created before this table exists fail to serve auth at all.
  const { rows } = await deps.pool.query<{
    id: string; ref: string; host: string | null; port: number | null; status: string;
    autoconfirm: boolean | null; disable_signup: boolean | null;
    access_token_ttl_seconds: number | null; password_min_length: number | null;
    site_url: string | null; additional_redirects: string[] | null;
    session_idle_seconds: number | null;
  }>(
    `SELECT p.id, p.ref::text AS ref, n.address AS host, d.port, p.status::text AS status,
            c.autoconfirm, c.disable_signup, c.access_token_ttl_seconds, c.password_min_length,
            c.site_url, c.additional_redirects, c.session_idle_seconds
       FROM projects p
       JOIN project_databases d ON d.project_id = p.id
       JOIN nodes n ON n.id = d.node_id
       LEFT JOIN project_auth_config c ON c.project_id = p.id
      WHERE p.ref = $1`, [claimedRef]);
  const row = rows[0];
  // Deliberately the same answer as a bad signature. A distinguishable "no such
  // project" turns the anon key — which is *published in client code* — into a
  // probe for which refs exist.
  if (!row) throw new AuthContextError(401, 'That API key is not valid for this deployment.');

  const [priv, pub, kid] = await Promise.all([
    deps.secrets.get(row.id, SECRET_NAMES.jwtPrivateKey),
    deps.secrets.get(row.id, SECRET_NAMES.jwtPublicKey),
    deps.secrets.get(row.id, SECRET_NAMES.jwtKid),
  ]);
  if (!priv || !pub || !kid) {
    throw new AuthContextError(503,
      'This project has no signing key yet. It is probably still being created.');
  }

  const domain = deps.projectDomain ?? process.env['CB_PROJECT_DOMAIN'] ?? 'corebase.co';
  const issuer = issuerFor(row.ref, domain);
  const keyIssuer = deps.keyIssuer ?? keyIssuerFor(row.ref, domain);
  try {
    // The real check. The issuer is pinned, so a key minted for a different
    // deployment of the same project ref does not pass either.
    verifyJwt(apikey, { publicKeyPem: pub, issuer: keyIssuer });
  } catch (err) {
    if (err instanceof JwtError) {
      throw new AuthContextError(401, 'That API key is not valid for this deployment.');
    }
    throw err;
  }

  if (row.status !== 'ready') {
    // Named, because this one the caller can act on and it is not a security
    // boundary: a paused project's auth is genuinely unavailable rather than
    // forbidden, and telling them "invalid key" would send them rotating keys.
    throw new AuthContextError(503,
      `This project is ${row.status}, so its auth endpoints are not serving.`);
  }
  if (!row.host || row.port === null) {
    throw new AuthContextError(503, 'This project has no reachable database yet.');
  }

  const dbPassword = await deps.secrets.get(row.id, SECRET_NAMES.authRole);
  if (!dbPassword) {
    throw new AuthContextError(503,
      'This project has no auth-role credential. It predates the auth schema.');
  }

  return {
    projectId: row.id, ref: row.ref, keyRole: claimedRole,
    host: row.host, port: row.port,
    signing: { privateKeyPem: priv, publicKeyPem: pub, kid },
    dbPassword, issuer, keyIssuer,
    config: {
      autoconfirm: row.autoconfirm ?? AUTH_CONFIG_DEFAULTS.autoconfirm,
      disableSignup: row.disable_signup ?? AUTH_CONFIG_DEFAULTS.disableSignup,
      accessTtlSeconds: row.access_token_ttl_seconds ?? AUTH_CONFIG_DEFAULTS.accessTtlSeconds,
      passwordMinLength: row.password_min_length ?? AUTH_CONFIG_DEFAULTS.passwordMinLength,
      siteUrl: row.site_url ?? AUTH_CONFIG_DEFAULTS.siteUrl,
      additionalRedirects: row.additional_redirects ?? AUTH_CONFIG_DEFAULTS.additionalRedirects,
      sessionIdleSeconds: row.session_idle_seconds ?? AUTH_CONFIG_DEFAULTS.sessionIdleSeconds,
    },
  };
}

/**
 * One connection per request, closed after.
 *
 * Not a cached pool, and the reason is credential rotation (P2d): a pooled
 * connection holds a password, rotation replaces it, and every request served from
 * that pool afterwards fails authentication until something notices and rebuilds
 * it. Getting the invalidation wrong means *every login on a project breaks after a
 * routine credential rotation* — a failure with no relationship to what the
 * operator just did, in a subsystem they were not touching.
 *
 * The cost is a connect per request, which is milliseconds against a scrypt verify
 * that is deliberately tens of them. Pooling is a performance step to take with a
 * measurement in hand, and OQ-110 has to settle the pooler question first: the
 * pooler's `auth_query` lookup allowlists `developer` only (D-074), so routing auth
 * through it is a change to the pooler's security posture and deserves its own step.
 */
export async function withProjectDb<T>(
  ctx: ProjectContext, fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    host: ctx.host, port: ctx.port, user: 'corebase_auth', database: 'postgres',
    password: ctx.dbPassword, connectionTimeoutMillis: 5000,
    // The auth module's statements are all small and indexed. A request that
    // cannot finish in two seconds is a request to give up on rather than one to
    // let hold a connection while a customer's login page spins.
    statement_timeout: 2000,
  } as never);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}
