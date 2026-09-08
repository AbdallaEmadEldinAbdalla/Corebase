import { Client, type Pool } from 'pg';
import type { S3 } from '@steadhold/s3';
import { SECRET_NAMES, type SecretStore } from '@steadhold/secrets';

/**
 * The storage reconciliation sweep (P6f, D-124 §5, D-017 §6).
 *
 * ## Why this exists at all
 *
 * Postgres and the object store share no transaction, so every storage mutation
 * is two writes against two systems and either can fail. The write *orderings*
 * (object-then-row on upload, row-then-object on delete) make every such failure
 * land in the same harmless direction — bytes with no row, which nothing can see.
 * That is a deliberate trade of correctness for cost, and **this sweep is the
 * other half of it**: without something that collects the garbage, "harmless"
 * becomes "we bill ourselves forever".
 *
 * So the orderings plus this file are the entire consistency model. There is no
 * hidden transactional layer, and nothing here is best-effort cleanup of a system
 * that was supposed to be exact.
 *
 * ## Four passes, and why each is separate
 *
 * 1. **Orphans** — objects with no row and no intent, older than the grace
 *    window. Deleted.
 * 2. **Expired intents** — a presigned upload nobody completed (D-124's F4).
 *    Both the object, if any, and the intent go.
 * 3. **Missing objects** — a row whose bytes are gone. This is the direction the
 *    orderings are supposed to make impossible, so it is *quarantined and
 *    alerted*, never auto-deleted: deleting the row would erase the evidence and
 *    silently shrink a customer's file list.
 * 4. **Quota true-up** — the store's own totals overwrite the trigger-maintained
 *    counter when they have drifted. Billing reads the true-up, not the trigger.
 *
 * They are separate because they fail differently. An unreachable store stops
 * passes 1–3 and must not corrupt the counter in pass 4 by concluding a project
 * holds nothing.
 */

/** The doc's grace window: an object younger than this may be mid-upload. */
export const GRACE_MS = 24 * 60 * 60 * 1000;

/** Drift thresholds from the doc: overwrite the counter past either one. */
const DRIFT_FRACTION = 0.01;
const DRIFT_BYTES = 100 * 1024 * 1024;

export interface SweepReport {
  projects: number;
  orphansDeleted: number;
  bytesReclaimed: number;
  intentsExpired: number;
  missingObjects: number;
  quotaCorrected: number;
  /** Projects the sweep could not finish, and why. One does not stop the rest. */
  failures: Array<{ ref: string; error: string }>;
}

export interface SweepDeps {
  pool: Pool;
  secrets: SecretStore;
  s3: S3;
  /** Overridable so a test can prove the grace window rather than wait a day. */
  graceMs?: number | undefined;
  now?: (() => number) | undefined;
  log?: ((msg: string, fields?: Record<string, unknown>) => void) | undefined;
}

interface ProjectRow { id: string; ref: string; host: string; port: number }

export function createStorageSweep(deps: SweepDeps) {
  const graceMs = deps.graceMs ?? GRACE_MS;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});

  /**
   * A superuser connection to one project's database.
   *
   * The sweep is platform maintenance and reads across every bucket regardless
   * of policy, so it connects as `postgres` rather than switching into an API
   * role. That is the one place in storage where RLS is deliberately not the
   * authority — and it is safe because nothing here returns data to a caller: it
   * compares two inventories and deletes from one of them.
   */
  async function connect(p: ProjectRow): Promise<Client> {
    const password = await deps.secrets.get(p.id, SECRET_NAMES.postgres);
    if (!password) throw new Error('no stored superuser password');
    const client = new Client({
      host: p.host, port: p.port, user: 'postgres', database: 'postgres',
      password, connectionTimeoutMillis: 10_000, statement_timeout: 60_000,
    } as never);
    await client.connect();
    return client;
  }

  async function sweepProject(p: ProjectRow, report: SweepReport): Promise<void> {
    const prefix = `projects/${p.ref}/`;
    // The store's inventory first. If this throws, the project is skipped
    // entirely — and in particular the true-up does not run, because an empty
    // listing from a failed call is indistinguishable from a project that holds
    // nothing, and writing that into the quota counter would zero a customer's
    // usage on a transient error.
    const stored = await deps.s3.listDetailed(prefix);

    const client = await connect(p);
    try {
      // The metadata inventory, as derived keys so the two sides are comparable.
      // The bucket name is joined in rather than stored per object (the key is
      // derived, never persisted — see the schema).
      const { rows: objects } = await client.query<{
        bucket: string; name: string; size: string; etag: string;
      }>(`SELECT b.name AS bucket, o.name, o.size::text AS size, o.etag
            FROM storage.objects o JOIN storage.buckets b ON b.id = o.bucket_id`);
      const { rows: intents } = await client.query<{ bucket: string; name: string }>(
        `SELECT b.name AS bucket, i.name
           FROM storage.upload_intents i JOIN storage.buckets b ON b.id = i.bucket_id
          WHERE i.expires_at > now()`);

      const known = new Set<string>();
      for (const o of objects) known.add(`${prefix}${o.bucket}/${o.name}`);
      // Live intents protect their key too. Without this the sweep would race a
      // presigned upload in progress: the bytes are there, the row is not yet,
      // and the grace window alone would not save an upload that finished
      // quickly but has not been completed.
      for (const i of intents) known.add(`${prefix}${i.bucket}/${i.name}`);

      // ── pass 1: orphans ──────────────────────────────────────────────────
      const cutoff = now() - graceMs;
      const orphans = stored.filter((o) =>
        !known.has(o.key) && o.lastModified.getTime() < cutoff);
      for (const o of orphans) {
        await deps.s3.deleteObject(o.key);
        report.orphansDeleted += 1;
        report.bytesReclaimed += o.size;
      }
      if (orphans.length) {
        log('orphans collected', { ref: p.ref, count: orphans.length });
      }

      // ── pass 2: expired intents (F4) ─────────────────────────────────────
      const { rows: expired } = await client.query<{
        id: string; bucket: string; name: string;
      }>(`SELECT i.id, b.name AS bucket, i.name
            FROM storage.upload_intents i JOIN storage.buckets b ON b.id = i.bucket_id
           WHERE i.expires_at <= now()`);
      for (const e of expired) {
        // The object first, then the intent — the same ordering discipline as a
        // delete. Dropping the intent first would leave bytes nothing knows
        // about, which is an orphan this pass had the information to avoid
        // creating.
        await deps.s3.deleteObject(`${prefix}${e.bucket}/${e.name}`).catch(() => {});
        await client.query(`DELETE FROM storage.upload_intents WHERE id = $1`, [e.id]);
        report.intentsExpired += 1;
      }

      // ── pass 3: rows whose bytes are gone ────────────────────────────────
      //
      // The direction the orderings are supposed to make impossible. Quarantined
      // and counted, never deleted: this is evidence of a platform fault, and
      // erasing the row would erase both the evidence and a file the customer
      // believes they have.
      const present = new Set(stored.map((o) => o.key));
      for (const o of objects) {
        if (present.has(`${prefix}${o.bucket}/${o.name}`)) continue;
        await deps.pool.query(
          `INSERT INTO storage_missing_objects
             (project_id, bucket, name, expected_size, etag)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (project_id, bucket, name) DO UPDATE
             SET last_seen_at = now(), seen_count = storage_missing_objects.seen_count + 1,
                 resolved_at = NULL`,
          [p.id, o.bucket, o.name, Number(o.size), o.etag]);
        report.missingObjects += 1;
        log('row with no object behind it', { ref: p.ref, bucket: o.bucket, name: o.name });
      }

      // ── pass 4: quota true-up ────────────────────────────────────────────
      //
      // The store is the authority on how many bytes a project is using, and the
      // trigger-maintained counter is a fast approximation of it. Billing reads
      // this pass rather than the counter, because the counter can drift — an
      // overwrite race, a sweep deletion, a bug — and a customer must not be
      // charged for a number nobody checked.
      //
      // Run *after* the deletions above, so the total reflects what is left
      // rather than what was there when the sweep started.
      const remaining = stored.filter((o) => !orphans.some((x) => x.key === o.key));
      const trueBytes = remaining.reduce((sum, o) => sum + o.size, 0);
      const { rows: usage } = await client.query<{ total_bytes: string }>(
        `SELECT total_bytes::text AS total_bytes FROM storage.usage`);
      const counted = Number(usage[0]?.total_bytes ?? 0);
      const drift = Math.abs(trueBytes - counted);
      if (drift > DRIFT_BYTES || (counted > 0 && drift / counted > DRIFT_FRACTION)) {
        await client.query(
          `UPDATE storage.usage SET total_bytes = $1, object_count = $2, updated_at = now()`,
          [trueBytes, remaining.length]);
        report.quotaCorrected += 1;
        log('quota corrected', { ref: p.ref, counted, trueBytes, drift });
      }
    } finally {
      await client.end().catch(() => {});
    }
  }

  return {
    /**
     * One pass over every project that could be holding objects.
     *
     * A project that fails is recorded and the sweep continues. The alternative —
     * aborting the run — means one unreachable node stops garbage collection for
     * the whole fleet, and the fleet is where the cost accumulates.
     */
    async sweepOnce(): Promise<SweepReport> {
      const report: SweepReport = {
        projects: 0, orphansDeleted: 0, bytesReclaimed: 0,
        intentsExpired: 0, missingObjects: 0, quotaCorrected: 0, failures: [],
      };
      // Soft-deleted projects are included deliberately: their objects still
      // exist and still cost money, and their rows are still there to compare
      // against. Only a fully deleted project has had its prefix removed
      // wholesale, and it has no database left to read.
      const { rows } = await deps.pool.query<ProjectRow>(
        `SELECT p.id, p.ref::text AS ref, n.address AS host, d.port
           FROM projects p
           JOIN project_databases d ON d.project_id = p.id
           JOIN nodes n ON n.id = d.node_id
          WHERE p.status NOT IN ('deleted', 'creating')
            AND d.status <> 'paused'
          ORDER BY p.created_at`);
      for (const p of rows) {
        report.projects += 1;
        try {
          await sweepProject(p, report);
        } catch (err) {
          report.failures.push({ ref: p.ref, error: (err as Error).message });
          log('project sweep failed', { ref: p.ref, error: (err as Error).message });
        }
      }
      return report;
    },
  };
}

export type StorageSweep = ReturnType<typeof createStorageSweep>;
