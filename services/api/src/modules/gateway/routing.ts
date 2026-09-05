import type { Pool } from 'pg';
import { toJwk } from '@corebase/jwt';

/**
 * The routing table (P5c, D-051): everything the hot path needs about a project,
 * in memory, refreshed in the background.
 *
 * ## Why this is not a query
 *
 * D-051's rule is that the data plane never touches the control-plane database on
 * the hot path, and it is not about speed — it is about blast radius. A gateway
 * that queried per request would make every customer's API depend on the control
 * plane being up, so a control-plane incident would take out every project's data
 * API with it. An in-memory table means a control-plane outage costs *changes* —
 * new projects, key rotations, resumes — and nothing already running.
 *
 * The cost is staleness, bounded and deliberate: an entry is at most `refreshMs`
 * old. What that means differs by field, and the differences are the interesting
 * part:
 *
 *   - **status** is the one that matters. A project deleted seconds ago keeps
 *     serving until the next refresh — the same window Cloudflare's cache and the
 *     SDK's retry already give, and closing it costs the independence above.
 *   - **keys** are stale in the safe direction by construction: P4h's rotation
 *     *publishes before it signs*, precisely so verifiers may lag. A key that
 *     arrives here late is a key nothing has signed with yet.
 *   - **ports** change only when a project is re-placed, which cannot happen while
 *     it is running.
 */

export interface RouteEntry {
  projectId: string;
  ref: string;
  status: string;
  plan: string;
  /** Where the project's PostgREST is, or null if it has none (pre-P5b). */
  nodeAddress: string | null;
  postgrestPort: number | null;
  /** Every published key. Filled by `withKeys`, which reads the secret store. */
  jwks: Array<Record<string, unknown>>;
  /** sha256 hashes of revoked API keys, so revocation costs no query. */
  revoked: ReadonlySet<string>;
  loadedAt: number;
}

export interface RoutingTable {
  /** The hot path. In-memory only; never touches the database. */
  lookup(ref: string): RouteEntry | undefined;
  refresh(): Promise<number>;
  start(): void;
  stop(): void;
  size(): number;
}

export interface RoutingDeps {
  pool: Pool;
  /**
   * Reads a project's *active* public key and kid. The published-but-not-signing
   * keys come from `project_signing_keys`, which is plain SQL; the active one
   * lives envelope-encrypted in the secret store, so it needs this.
   */
  activeKey?: ((projectId: string) => Promise<{ pem: string; kid: string } | undefined>) | undefined;
  refreshMs?: number | undefined;
  onError?: ((err: Error) => void) | undefined;
  now?: (() => number) | undefined;
}

export function createRoutingTable(deps: RoutingDeps): RoutingTable {
  const refreshMs = deps.refreshMs ?? 10_000;
  const now = deps.now ?? (() => Date.now());
  let table = new Map<string, RouteEntry>();
  let timer: NodeJS.Timeout | undefined;

  async function load(): Promise<number> {
    // One query for the whole fleet rather than one per project. A per-project
    // fill would put the control plane back on the path of a cold lookup, which
    // is the dependency this table exists to remove — and a burst of traffic to
    // new projects is exactly when the control plane can least absorb it.
    const { rows } = await deps.pool.query<{
      id: string; ref: string; status: string; plan: string;
      node_address: string | null; postgrest_port: number | null;
      extra_keys: Array<{ kid: string; pem: string }> | null;
      revoked: string[] | null;
    }>(`
      SELECT p.id, p.ref::text AS ref, p.status::text AS status, p.plan::text AS plan,
             n.address AS node_address, d.postgrest_port,
             COALESCE((
               SELECT json_agg(json_build_object('kid', k.kid, 'pem', k.public_key_pem)
                               ORDER BY k.published_at)
                 FROM project_signing_keys k
                WHERE k.project_id = p.id AND k.status IN ('next', 'retiring')
             ), '[]'::json) AS extra_keys,
             COALESCE((
               SELECT array_agg(a.key_hash)
                 FROM project_api_keys a
                WHERE a.project_id = p.id AND a.revoked_at IS NOT NULL
             ), '{}') AS revoked
        FROM projects p
        LEFT JOIN project_databases d ON d.project_id = p.id
        LEFT JOIN nodes n ON n.id = d.node_id
       WHERE p.status <> 'deleted'`);

    const next = new Map<string, RouteEntry>();
    for (const r of rows) {
      const keys: Array<Record<string, unknown>> = [];
      // Active key first: it matches most tokens, and a verifier trying keys in
      // order should try the likely one first.
      const active = await deps.activeKey?.(r.id).catch(() => undefined);
      if (active) keys.push(toJwk(active.pem, active.kid));
      for (const k of r.extra_keys ?? []) keys.push(toJwk(k.pem, k.kid));

      next.set(r.ref, {
        projectId: r.id, ref: r.ref, status: r.status, plan: r.plan,
        nodeAddress: r.node_address, postgrestPort: r.postgrest_port,
        jwks: keys, revoked: new Set(r.revoked ?? []), loadedAt: now(),
      });
    }
    // Swapped whole rather than mutated in place, so a lookup never sees a
    // half-built table — a request during a refresh gets the previous entry,
    // which is correct, instead of a project that briefly has no keys.
    table = next;
    return next.size;
  }

  return {
    lookup: (ref) => table.get(ref),
    refresh: load,
    size: () => table.size,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void load().catch((err: Error) => deps.onError?.(err));
      }, refreshMs);
      // `unref`, so a refresh timer never keeps a process alive on its own: the
      // gateway's liveness is the HTTP server's business, not this table's.
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}

/**
 * The ref from a `Host` header, or undefined.
 *
 * The gateway resolves the project from the *host* rather than from the apikey
 * (which is what `/auth/v1` has done since D-318, in the gateway's absence). A
 * host is an unverified assertion — anyone can send any Host — so resolving it is
 * only half the job: the apikey's own `ref` claim must then match the resolved
 * project, and that check is what turns an assertion into an identity. Neither
 * half is sufficient alone, which is why the gateway does both.
 */
export function refFromHost(
  host: string | undefined, domain: string,
): string | undefined {
  if (!host) return undefined;
  const bare = host.split(':')[0]?.toLowerCase() ?? '';
  const suffix = `.${domain.toLowerCase()}`;
  if (!bare.endsWith(suffix)) return undefined;
  const sub = bare.slice(0, -suffix.length);
  // Refs are a fixed alphabet and length. Validating here means a malformed host
  // is a miss in a map rather than a string reaching anything that interpolates.
  return /^[a-z0-9]{8,32}$/.test(sub) ? sub : undefined;
}
