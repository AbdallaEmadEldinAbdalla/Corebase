import type { Pool } from 'pg';
import { Client } from 'pg';
import { DEVELOPER_ROLE } from './project-admin.ts';
import { QUOTA_HEADROOM } from './placement.ts';

/**
 * The disk-full enforcement ladder (D-073).
 *
 * The point of a ladder rather than a single limit is stated in the provisioning
 * doc and worth repeating: an out-of-disk Postgres PANICs mid-WAL-write, and on a
 * shared volume that takes every tenant on the node with it. The hard quota is the
 * backstop that converts "node down" into "one project's writes fail"; every rung
 * below it exists so customers almost never reach the backstop.
 *
 *   ≥80%  warn      — tell them, once
 *   ≥90%  critical  — tell them again, louder; ops sees it
 *   ≥95%  read_only — `default_transaction_read_only = on`; reads keep working
 *   120%  ENOSPC    — the filesystem quota, confined to this project
 *
 * **The read-only rung is advisory, and that is deliberate** (D-073's honesty
 * note). A session can `SET transaction_read_only = off`, which is exactly the
 * recovery path: the customer turns it off, deletes or vacuums, and the next sweep
 * lifts the flag for them. Making it unbypassable would lock a customer out of the
 * only action that fixes their problem. The hard guarantee is the quota; this rung
 * is UX with teeth.
 *
 * Hysteresis is on purpose: read-only engages at 95% and lifts below **90%**, not
 * below 95%. A project oscillating on the boundary would otherwise flap between
 * writable and not, and each flip is an incident from the application's side.
 */
export const LADDER = { warn: 80, critical: 90, readOnly: 95, lift: 90 } as const;

export type DiskState = 'ok' | 'warn' | 'critical' | 'read_only';

/** Which rung a usage percentage sits on, given where it already was. */
export function rungFor(pct: number, current: DiskState): DiskState {
  if (pct >= LADDER.readOnly) return 'read_only';
  // Coming down: read-only holds until the project is back under the lift line.
  if (current === 'read_only' && pct >= LADDER.lift) return 'read_only';
  if (pct >= LADDER.critical) return 'critical';
  if (pct >= LADDER.warn) return 'warn';
  return 'ok';
}

export interface DiskScanOptions {
  pool: Pool;
  batchSize?: number;
  probeTimeoutMs?: number;
  /** Node volume percentage at which the node stops accepting placements (D-073). */
  nodeCordonPct?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export interface DiskScanResult {
  checked: number;
  unreachable: number;
  transitions: Array<{ ref: string; from: DiskState; to: DiskState; pct: number }>;
  cordoned: string[];
}

export function createDiskScan(opts: DiskScanOptions) {
  const batchSize = opts.batchSize ?? 20;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  const nodeCordonPct = opts.nodeCordonPct ?? 85;
  const log = opts.log ?? (() => {});

  /**
   * Ask the project's own database how big it is.
   *
   * `pg_database_size()` and not `du` on the volume: it is what the billing path
   * uses (pricing doc §metering), so the number the customer is charged on and the
   * number the ladder acts on are the same one. Two sources would eventually
   * disagree, and the disagreement would surface as "you throttled me at 94%".
   */
  async function usedBytes(
    host: string, port: number, password: string,
  ): Promise<number | undefined> {
    const client = new Client({
      host, port, user: DEVELOPER_ROLE, password, database: 'postgres',
      connectionTimeoutMillis: probeTimeoutMs, ssl: false,
    });
    try {
      await client.connect();
      const { rows } = await client.query<{ n: string }>(
        `SELECT pg_database_size(current_database())::text AS n`);
      return Number(rows[0]!.n);
    } catch {
      return undefined;
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** Apply or lift the read-only flag. Needs an admin connection, not the customer's. */
  async function setReadOnly(
    host: string, port: number, superuserPasswords: string[], on: boolean,
    log2: (msg: string, extra?: Record<string, unknown>) => void,
  ): Promise<void> {
    let lastError = 'no password accepted';
    for (const password of superuserPasswords) {
      const client = new Client({
        host, port, user: 'postgres', password, database: 'postgres',
        connectionTimeoutMillis: probeTimeoutMs, ssl: false,
      });
      try {
        await client.connect();
        // Lift the flag for *this session* first, and yes, even when we are turning
        // it on.
        //
        // `default_transaction_read_only = on` applies to every transaction in the
        // database, including ours — and `ALTER DATABASE` is itself a write. So once
        // a project went read-only, the control plane could no longer change it
        // back: the ladder was a one-way door, and the customer would have been
        // stuck read-only forever no matter how much space they freed. The session
        // override is the same mechanism the customer's own recovery uses, and it
        // has to be its own statement because the GUC only affects transactions
        // that begin after it (D-249).
        await client.query(`SET default_transaction_read_only = off`);
        // ALTER DATABASE takes no bind parameters and the value is a literal from
        // this file, never from input.
        await client.query(
          `ALTER DATABASE postgres SET default_transaction_read_only = ${on ? 'on' : 'off'}`);
        if (on) {
          // Sessions idle *in a transaction* hold locks and would keep writing
          // under the old setting — the setting only applies to transactions that
          // start after it. Terminating those is what makes the rung take effect
          // now rather than whenever the application happens to reconnect.
          const { rows } = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM (
               SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                WHERE usename = $1 AND state = 'idle in transaction'
                  AND pid <> pg_backend_pid()
             ) t`, [DEVELOPER_ROLE]);
          log2('read-only applied; idle-in-transaction sessions ended', {
            terminated: rows[0]?.n ?? 0,
          });
        } else {
          log2('read-only lifted');
        }
        return;
      } catch (err) {
        lastError = (err as Error).message;
      } finally {
        await client.end().catch(() => {});
      }
    }
    throw new Error(`could not change the read-only flag: ${lastError}`);
  }

  return {
    async scanOnce(deps: {
      developerSecretFor: (projectId: string) => Promise<string | undefined>;
      superuserPasswordsFor: (projectId: string) => Promise<string[]>;
    }): Promise<DiskScanResult> {
      const { rows: candidates } = await opts.pool.query<{
        id: string; ref: string; port: number; node_address: string | null;
        disk_limit_mb: number; disk_state: DiskState; org: string;
      }>(
        `SELECT p.id, p.ref::text AS ref, d.port, n.address AS node_address,
                d.disk_limit_mb, d.disk_state::text AS disk_state,
                p.organization_id AS org
           FROM projects p
           JOIN project_databases d ON d.project_id = p.id
           JOIN nodes n ON n.id = d.node_id
          WHERE p.status = 'ready' AND d.status = 'running'
          ORDER BY d.disk_checked_at NULLS FIRST
          LIMIT $1`, [batchSize]);

      const transitions: DiskScanResult['transitions'] = [];
      let unreachable = 0;

      for (const c of candidates) {
        const password = await deps.developerSecretFor(c.id);
        if (!password || !c.node_address) { unreachable++; continue; }
        const used = await usedBytes(c.node_address, c.port, password);
        if (used === undefined) {
          // Cannot measure ⇒ cannot act. Acting on a missing reading would put a
          // healthy project into read-only during a network blip.
          unreachable++;
          log('warn', 'disk scan could not measure a project — left as it was',
            { ref: c.ref, state: c.disk_state });
          continue;
        }

        const capBytes = c.disk_limit_mb * 1024 * 1024;
        const pct = (used / capBytes) * 100;
        const next = rungFor(pct, c.disk_state);

        await opts.pool.query(
          `UPDATE project_databases
              SET disk_used_bytes = $2, disk_checked_at = now(), disk_state = $3
            WHERE project_id = $1`, [c.id, used, next]);

        if (next === c.disk_state) continue;

        // Only the read-only rung has a database-side action; warn and critical are
        // notifications, and the sender is Phase 4.
        if (next === 'read_only' || c.disk_state === 'read_only') {
          try {
            await setReadOnly(
              c.node_address, c.port, await deps.superuserPasswordsFor(c.id),
              next === 'read_only',
              (m, e) => log('warn', m, { ref: c.ref, ...e }));
          } catch (err) {
            // Put the stored rung back: claiming read-only while writes still
            // succeed is worse than reporting the failure, because the next sweep
            // would see no transition and never retry.
            await opts.pool.query(
              `UPDATE project_databases SET disk_state = $2 WHERE project_id = $1`,
              [c.id, c.disk_state]);
            log('error', 'disk ladder could not change the read-only flag', {
              ref: c.ref, wanted: next, error: (err as Error).message,
            });
            continue;
          }
        }

        transitions.push({ ref: c.ref, from: c.disk_state, to: next, pct: Math.round(pct) });
        log(next === 'ok' ? 'info' : 'warn', 'disk ladder transition', {
          ref: c.ref, from: c.disk_state, to: next,
          used_mb: Math.round(used / 1024 / 1024), cap_mb: c.disk_limit_mb,
          pct: Math.round(pct),
        });
      }

      // ── the node's own volume ─────────────────────────────────────────────
      //
      // Every project is quota-capped and every placement is disk-booked, so a node
      // approaching full means an accounting bug rather than a tenant event — which
      // is why this cordons rather than throttling anyone: stop placing new work
      // here and let a human find out why the arithmetic was wrong.
      const cordoned: string[] = [];
      const { rows: nodes } = await opts.pool.query<{
        id: string; hostname: string; pct: number; status: string;
      }>(
        `SELECT id, hostname, status::text AS status,
                CASE WHEN disk_total_gb > 0
                     THEN (disk_reserved_gb::numeric / disk_total_gb * 100)::int
                     ELSE 0 END AS pct
           FROM nodes WHERE status = 'active'`);
      for (const n of nodes) {
        if (n.pct < nodeCordonPct) continue;
        await opts.pool.query(
          `UPDATE nodes SET status = 'cordoned' WHERE id = $1 AND status = 'active'`, [n.id]);
        cordoned.push(n.hostname);
        log('error', 'node cordoned: disk booking passed the ceiling', {
          node: n.hostname, pct: n.pct, ceiling: nodeCordonPct,
        });
      }

      if (candidates.length > 0 || cordoned.length > 0) {
        log('info', 'disk scan complete', {
          checked: candidates.length, unreachable,
          transitions: transitions.length, cordoned: cordoned.length,
        });
      }
      return { checked: candidates.length, unreachable, transitions, cordoned };
    },
  };
}

/** The quota the filesystem enforces for a plan cap, in MB (D-073). */
export const quotaFor = (capMb: number): number => Math.ceil(capMb * QUOTA_HEADROOM);
