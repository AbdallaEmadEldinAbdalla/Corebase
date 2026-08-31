import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from 'pg';

/**
 * Control-plane migration runner.
 *
 * Plain timestamped SQL applied in filename order, exactly the discipline we
 * sell to customers (D-028) — so the tool we use on ourselves and the tool they
 * get cannot drift apart.
 *
 * Three properties matter more than features:
 *  1. one writer at a time — a Postgres advisory lock, so two API instances
 *     booting together cannot interleave DDL;
 *  2. each file runs inside a transaction — a failed migration leaves nothing
 *     half-applied;
 *  3. checksums are verified on every run — editing an applied migration is a
 *     hard error, not a silent divergence between environments.
 */

const ADVISORY_LOCK_KEY = 4_919_268_001; // arbitrary, fixed: 'corebase migrate'

export interface MigrationFile {
  filename: string;
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export class MigrationError extends Error {}

/** `20260829120000_control_plane_init.sql` → version + name. */
export function parseFilename(filename: string): { version: string; name: string } | null {
  const m = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(filename);
  if (!m) return null;
  return { version: m[1]!, name: m[2]! };
}

export function checksum(sql: string): string {
  // newline-normalised so a checkout on another platform does not read as drift
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: MigrationFile[] = [];
  for (const filename of entries) {
    const parsed = parseFilename(filename);
    if (!parsed) {
      throw new MigrationError(
        `Migration "${filename}" is not named <14-digit-timestamp>_<snake_case>.sql — ` +
        `rename it so ordering stays unambiguous.`,
      );
    }
    const sql = await readFile(join(dir, filename), 'utf8');
    out.push({ filename, ...parsed, sql, checksum: checksum(sql) });
  }
  const versions = out.map((m) => m.version);
  const dupe = versions.find((v, i) => versions.indexOf(v) !== i);
  if (dupe) throw new MigrationError(`Two migrations share the timestamp ${dupe}.`);
  return out;
}

async function ensureTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL
    )`);
}

export async function runMigrations(
  client: Client,
  dir: string,
  opts: { logger?: (msg: string) => void } = {},
): Promise<MigrationResult> {
  const log = opts.logger ?? (() => {});
  const files = await loadMigrations(dir);

  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await ensureTable(client);
    const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r]));

    // Drift check first: never apply anything on top of a modified history.
    for (const f of files) {
      const seen = applied.get(f.version);
      if (seen && seen.checksum !== f.checksum) {
        throw new MigrationError(
          `Migration ${f.filename} was already applied but its contents changed ` +
          `(recorded ${seen.checksum.slice(0, 12)}…, file ${f.checksum.slice(0, 12)}…). ` +
          `Applied migrations are immutable — add a new migration instead.`,
        );
      }
    }
    const missing = [...applied.keys()].filter((v) => !files.some((f) => f.version === v));
    if (missing.length) {
      throw new MigrationError(
        `The database has migrations this checkout does not: ${missing.join(', ')}. ` +
        `You are probably pointed at a newer environment than your code.`,
      );
    }

    const result: MigrationResult = { applied: [], skipped: [] };
    for (const f of files) {
      if (applied.has(f.version)) { result.skipped.push(f.filename); continue; }
      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4)',
          [f.version, f.name, f.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new MigrationError(`Migration ${f.filename} failed and was rolled back: ${(err as Error).message}`);
      }
      log(`applied ${f.filename} (${Date.now() - started}ms)`);
      result.applied.push(f.filename);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
}
