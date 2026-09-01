import type { Pool } from 'pg';
import { Client } from 'pg';
import { enqueueProvisioning, type Queue, type ProvisioningJobData } from '@corebase/queue';
import { DEVELOPER_ROLE, POOLER_AUTH_ROLE } from './project-admin.ts';
import { poolerName, networkName } from './container-spec.ts';
import type { Docker } from './docker.ts';

/**
 * The idle scan (P2c, D-008/D-072): what actually triggers a pause.
 *
 * The doc specifies **two signals, both required**:
 *
 *   1. no data-plane traffic — the gateway meters requests per project;
 *   2. no database connections — `pg_stat_activity` excluding internal roles.
 *
 * **Only the second exists today, and that is currently sufficient rather than a
 * gap.** There is no data plane yet: no PostgREST, no auth service, no storage, so
 * a client connection is the *only* way to use a project at all. The moment Phase 5
 * lands PostgREST, this becomes wrong in the dangerous direction — a project serving
 * HTTP traffic with no direct connections would look idle and be paused under its
 * users. The signal is therefore structured to take a second input, and the
 * omission is recorded rather than hidden (D-236).
 *
 * What "a connection" means is narrower than it looks, and getting it wrong here is
 * expensive in both directions. `pg_stat_activity` shows our own machinery — the
 * health probe, the admin path, the pooler's `auth_query` lookups — and, worse, it
 * shows **the pooler's parked server connections as the customer's own role**.
 * PgBouncer holds those for `server_idle_timeout` (240s) after the last real client
 * leaves, so counting backends alone reports a busy project for four minutes after
 * everyone has gone. A project that never looks idle never pauses, and the free tier
 * stops paying for itself.
 *
 * So the signal is arithmetic across both processes, which is what the doc means by
 * scraping pgbouncer as well as Postgres:
 *
 *     clients = pooler cl_active + cl_waiting     (real clients, from SHOW POOLS)
 *     direct  = developer backends whose client_addr is not the pooler's
 *     idle    = clients == 0 && direct == 0
 *
 * `direct` identifies the pooler's backends by address rather than subtracting a
 * count of them, and the difference is not cosmetic: subtraction cancels a real
 * direct connection against a pooler-held one, so a project with exactly one live
 * `psql` session and one parked pooler backend reads as idle and gets paused under
 * its user. Counting is only safe when you know *which* rows to exclude.
 */
export interface IdleScanOptions {
  pool: Pool;
  queue: Queue<ProvisioningJobData>;
  /** Used only to learn the pooler's address, so its own backends are excluded. */
  docker?: Pick<Docker, 'inspectContainer'>;
  /** Days of continuous idleness before a pause. 7 for Free (D-072). */
  idleDays?: number;
  batchSize?: number;
  /** How long to wait for a project's database to answer the activity query. */
  probeTimeoutMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export function createIdleScan(opts: IdleScanOptions) {
  const idleDays = opts.idleDays ?? 7;
  const batchSize = opts.batchSize ?? 20;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 3_000;
  const log = opts.log ?? (() => {});

  /**
   * Client connections a *customer* has open, right now.
   *
   * Returns undefined when the database cannot be asked, which is deliberately
   * different from zero: a project we cannot reach is not a project we know to be
   * idle, and pausing on a failed probe would pause healthy projects during a
   * network blip.
   */
  async function directConnections(
    host: string, port: number, password: string, poolerAddr: string | undefined,
  ): Promise<number | undefined> {
    const client = new Client({
      host, port, user: DEVELOPER_ROLE, password, database: 'postgres',
      connectionTimeoutMillis: probeTimeoutMs, ssl: false,
    });
    try {
      await client.connect();
      const { rows } = await client.query<{ n: number }>(
        // Excluding this connection, every internal role, and anything arriving
        // from the pooler's address — the pooler's clients are counted by the
        // pooler itself, and its parked server connections are not traffic at all.
        `SELECT count(*)::int AS n
           FROM pg_stat_activity
          WHERE datname IS NOT NULL
            AND pid <> pg_backend_pid()
            AND usename = $1
            AND ($2::text IS NULL OR host(client_addr) IS DISTINCT FROM $2::text)`,
        [DEVELOPER_ROLE, poolerAddr ?? null]);
      return rows[0]?.n ?? 0;
    } catch {
      return undefined;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** The pooler's address on the project network, for the exclusion above. */
  async function poolerAddress(ref: string): Promise<string | undefined> {
    if (!opts.docker) return undefined;
    const inspect = await opts.docker.inspectContainer(poolerName(ref)).catch(() => undefined);
    const nets = inspect?.NetworkSettings?.Networks ?? {};
    for (const [name, cfg] of Object.entries(nets)) {
      if (name === networkName(ref) && cfg.IPAddress) return cfg.IPAddress;
    }
    // Any network it is on, if the expected one is not there — better than
    // excluding nothing, which would count the pooler's backends as traffic.
    for (const cfg of Object.values(nets)) if (cfg.IPAddress) return cfg.IPAddress;
    return undefined;
  }

  /**
   * Ask the pooler about itself: how many clients it has, and how many server
   * connections it is holding on their behalf.
   *
   * `SHOW POOLS` on the `pgbouncer` virtual database, as `pgbouncer_auth` — which
   * `stats_users` permits and which grants SHOW and nothing else. Returns undefined
   * when the pooler cannot be asked, which the caller treats as "cannot conclude"
   * rather than "no clients": pausing a project because its pooler was briefly
   * unreachable would pause projects that are in use.
   */
  async function poolerCounts(
    host: string, poolerPort: number, password: string,
  ): Promise<{ clients: number; servers: number } | undefined> {
    const client = new Client({
      host, port: poolerPort, user: POOLER_AUTH_ROLE, password,
      // The admin/stats console lives on a virtual database of this name.
      database: 'pgbouncer', connectionTimeoutMillis: probeTimeoutMs, ssl: false,
    });
    try {
      await client.connect();
      // node-postgres cannot use the extended protocol here — PgBouncer's console
      // speaks simple query only — so this is a bare SHOW with no parameters.
      const { rows } = await client.query<Record<string, string | number>>('SHOW POOLS');
      let clients = 0; let servers = 0;
      for (const r of rows) {
        // The console has a pool of its own, and *this* connection is in it. Left
        // in, the scan counts itself as a customer and no project is ever idle —
        // which is the same failure as counting the pooler's parked backends, one
        // level up.
        if (String(r['database'] ?? '') === 'pgbouncer') continue;
        const num = (k: string) => Number(r[k] ?? 0) || 0;
        // Real clients waiting or working. `cl_cancel_req` is not a client.
        clients += num('cl_active') + num('cl_waiting');
        // Everything the pooler holds against Postgres on their behalf.
        servers += num('sv_active') + num('sv_idle') + num('sv_used')
                 + num('sv_tested') + num('sv_login');
      }
      return { clients, servers };
    } catch {
      return undefined;
    } finally {
      await client.end().catch(() => {});
    }
  }

  return {
    /**
     * One pass. Returns what it saw, so the caller can log a number rather than a
     * claim.
     */
    async scanOnce(deps: {
      /** Reads the developer password; the scan connects as the customer's role. */
      secretFor: (projectId: string) => Promise<string | undefined>;
      /** Reads `pgbouncer_auth`'s password, for the pooler's stats console. */
      poolerSecretFor?: (projectId: string) => Promise<string | undefined>;
    }): Promise<{ checked: number; active: number; paused: number; unreachable: number }> {
      const { rows: candidates } = await opts.pool.query<{
        id: string; ref: string; port: number; pooler_port: number;
        node_address: string | null; idle_since: string;
      }>(
        `SELECT p.id, p.ref::text AS ref, d.port, d.pooler_port, n.address AS node_address,
                COALESCE(d.last_active_at, p.created_at) AS idle_since
           FROM projects p
           JOIN project_databases d ON d.project_id = p.id
           JOIN nodes n ON n.id = d.node_id
          WHERE p.status = 'ready' AND d.status = 'running'
            -- NULL last_active_at means never observed active, not infinitely
            -- idle: a project created five minutes ago has not been idle a week.
            AND COALESCE(d.last_active_at, p.created_at) < now() - ($1 || ' days')::interval
          ORDER BY COALESCE(d.last_active_at, p.created_at)
          LIMIT $2`, [String(idleDays), batchSize]);

      let active = 0; let paused = 0; let unreachable = 0;
      for (const c of candidates) {
        const password = await deps.secretFor(c.id);
        if (!password || !c.node_address) { unreachable++; continue; }

        const poolerPassword = await deps.poolerSecretFor?.(c.id);
        const poolerAddr = await poolerAddress(c.ref);
        const [direct, pooler] = await Promise.all([
          directConnections(c.node_address, c.port, password, poolerAddr),
          poolerPassword
            ? poolerCounts(c.node_address, c.pooler_port, poolerPassword)
            : Promise.resolve(undefined),
        ]);
        if (direct === undefined || pooler === undefined) {
          // Cannot ask either process ⇒ cannot conclude. Left alone for the next
          // pass. Requiring *both* is the point: without the pooler's numbers, the
          // pooler's own parked connections read as customer traffic and nothing
          // would ever be paused; with only the pooler's, a direct connection would
          // be invisible and a project in use would be paused under its user.
          unreachable++;
          log('idle scan could not reach a project — left running', {
            project: c.ref,
            database_reachable: direct !== undefined,
            pooler_reachable: pooler !== undefined,
          });
          continue;
        }

        const conns = direct + pooler.clients;
        if (conns > 0) {
          // Seen active: the clock restarts. This is the only writer of
          // last_active_at, which is why an unscanned project's clock starts at
          // its creation.
          await opts.pool.query(
            `UPDATE project_databases SET last_active_at = now() WHERE project_id = $1`, [c.id]);
          active++;
          continue;
        }

        // Deterministic key so two workers, or two passes, produce one pause.
        // Underscore rather than colon: BullMQ rejects ':' in job ids (D-197).
        const key = `idlepause_${c.id}`;
        const { rows } = await opts.pool.query<{ id: string }>(
          `INSERT INTO provisioning_jobs (project_id, job_type, idempotency_key, payload, state)
           VALUES ($1, 'pause_project', $2, $3::jsonb, 'pending')
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id`,
          [c.id, key, JSON.stringify({ project_id: c.id, ref: c.ref, reason: 'idle' })]);
        const jobId = rows[0]?.id;
        if (!jobId) continue;              // already scheduled

        await opts.pool.query(
          `UPDATE projects SET status = 'pausing', updated_at = now() WHERE id = $1`, [c.id]);
        const { enqueued } = await enqueueProvisioning(opts.queue, {
          job_row_id: jobId, idempotency_key: key,
          job_type: 'pause_project', project_id: c.id,
        });
        paused++;
        log('pause scheduled — idle past the window', {
          project: c.ref, idle_since: c.idle_since, days: idleDays, delivered: enqueued,
        });
      }

      if (candidates.length > 0) {
        log('idle scan complete', {
          checked: candidates.length, active, paused, unreachable,
        });
      }
      return { checked: candidates.length, active, paused, unreachable };
    },
  };
}
