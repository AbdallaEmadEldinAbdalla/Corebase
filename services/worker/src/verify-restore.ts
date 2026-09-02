import type { Pool } from 'pg';
import { Client } from 'pg';
import type { Docker } from './docker.ts';
import { IMAGE, PIDS_LIMIT } from './container-spec.ts';
import {
  repoTargetFromEnv, renderPgbackrestConf, writeConf, restore as pgbackrestRestore,
  info as repoInfo, pgbackrestFailure,
} from './backup.ts';

/**
 * Automated restore verification (P3h, D-019 operationalised by D-176).
 *
 * The backups doc's first line is the operating rule for the entire phase: **a
 * backup that has not been restore-tested is treated as not existing.** Every
 * step before this one built an archive — a repo, a schedule, retention, an
 * interlock at delete and at pause, provable destruction. None of it is a recovery
 * path until something restores it without being asked and checks what came back.
 *
 * ## What it actually does
 *
 * Restores the project's latest backup into a **scratch container with its own
 * volume**, on a node designated for verification rather than customer capacity,
 * then runs four checks and destroys everything. The scratch instance never joins
 * a project network and never publishes a port: it exists to be read once.
 *
 * The four checks are the doc's, and each one catches a failure the others cannot:
 *
 * 1. **Recovery reached consistency.** Anything else is a restore that did not
 *    finish, and it is the only check that can fail *loudly* on its own.
 * 2. **Data checksums verify.** Page-level corruption is silent — `initdb
 *    --data-checksums` (D-269) exists precisely so this check is possible, and
 *    without it a rotting cluster restores and reports healthy.
 * 3. **`pg_amcheck`.** A heap can be intact while a btree points at rows that are
 *    not there; the index is what queries actually read.
 * 4. **Sanity counts.** The strongest check and the least mechanical: tables the
 *    live project says are non-empty must be non-empty in the restore. A backup
 *    can pass every structural test and contain an empty database.
 */

/** Per-plan verification floors, in days (D-176). */
export const VERIFY_FLOOR_DAYS: Record<string, number> = {
  free: 90, pro: 30, team: 30, enterprise: 30,
};

export const floorFor = (plan: string): number =>
  VERIFY_FLOOR_DAYS[plan] ?? VERIFY_FLOOR_DAYS['free']!;

export type FailedCheck = 'restore' | 'recovery' | 'checksums' | 'amcheck' | 'sanity';

export interface VerifyOutcome {
  passed: boolean;
  backupLabel?: string | undefined;
  failedCheck?: FailedCheck | undefined;
  reason?: string | undefined;
  restoreMs?: number | undefined;
  durationMs: number;
  bytesRestored?: number | undefined;
}

export interface VerifyOptions {
  pool: Pool;
  docker: Docker;
  /** Seconds to wait for the scratch cluster to finish recovery. */
  recoveryTimeoutMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * What the *live* project says should be in the restore.
 *
 * Read before the scratch instance is touched, because a sanity check compares two
 * databases and the comparison is only meaningful if the expectation came from
 * somewhere other than the thing being tested. A paused project has nothing
 * running to ask, which is why the expectation is optional rather than required —
 * and D-176 verifies paused projects too, since their backup is their only life.
 */
export interface LiveExpectation {
  /** Tables the live project reports as non-empty, largest first. */
  nonEmptyTables: string[];
}

export function createVerifier(opts: VerifyOptions) {
  const recoveryTimeoutMs = opts.recoveryTimeoutMs ?? 180_000;
  const log = opts.log ?? (() => {});

  /**
   * Ask a running project which of its tables have rows.
   *
   * `pg_class.reltuples` rather than `count(*)` on every table: this runs against
   * a *customer's live database* and must not be a full scan of it. An estimate is
   * the right tool — the check that follows only needs to know which tables should
   * not come back empty, and reltuples being approximate cannot turn a populated
   * table into an empty one.
   */
  async function expectationFrom(
    host: string, port: number, password: string,
  ): Promise<LiveExpectation | undefined> {
    const client = new Client({
      host, port, user: 'postgres', database: 'postgres', password,
      connectionTimeoutMillis: 8000,
    });
    try {
      await client.connect();
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT c.relname AS table_name
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema')
            AND c.reltuples > 0
          ORDER BY c.reltuples DESC
          LIMIT 5`);
      return { nonEmptyTables: rows.map((r) => r.table_name) };
    } catch {
      return undefined;
    } finally {
      await client.end().catch(() => {});
    }
  }

  return {
    expectationFrom,

    /**
     * Restore one project's latest backup into a scratch instance and check it.
     *
     * Everything is torn down in a `finally`, including on the failure paths — a
     * verifier that leaked a container and a volume per failure would fill the
     * verification node exactly when the fleet is having its worst day.
     */
    async verify(args: {
      projectId: string;
      ref: string;
      plan: string;
      /** The live project's own view, when it has one. */
      expect?: LiveExpectation | undefined;
      cipherPass: string;
    }): Promise<VerifyOutcome> {
      const started = Date.now();
      const repo = repoTargetFromEnv();
      if (!repo) {
        return { passed: false, failedCheck: 'restore', durationMs: 0,
          reason: 'no backup repo configured, so nothing can be verified' };
      }

      // Named for the verification, not the project: this container is scratch and
      // must never be mistaken for the project's own by a reconciliation sweep.
      // No `com.corebase.project.ref` label, for the same reason (D-235's lesson:
      // the reconciler keys on that label, and an unexpected container carrying it
      // is drift).
      const name = `cb-verify-${args.ref}-${Date.now().toString(36)}`;
      const volume = `${name}-data`;
      let restoreMs: number | undefined;

      try {
        await opts.docker.createVolume(volume, { 'com.corebase.role': 'verify-scratch' });
        const id = await opts.docker.createContainer(name, {
          Image: IMAGE,
          Env: ['PGDATA=/var/lib/postgresql/data/pgdata'],
          Labels: { 'com.corebase.role': 'verify-scratch' },
          // No entrypoint run: the volume has to be filled before Postgres ever
          // starts on it, exactly as in the real restore (D-284).
          Cmd: ['sleep', '1800'],
          HostConfig: {
            Memory: 768 * 1024 * 1024, MemorySwap: 768 * 1024 * 1024,
            NanoCpus: Math.round(1 * 1e9), PidsLimit: PIDS_LIMIT, Init: true,
            RestartPolicy: { Name: 'no' },
            Mounts: [{ Type: 'volume', Source: volume, Target: '/var/lib/postgresql/data' }],
            PortBindings: {},
          },
          ExposedPorts: {},
        });
        await opts.docker.startContainer(id);

        // The project's own repo config, so the restore reads its history and
        // nothing else.
        await writeConf(opts.docker, name, renderPgbackrestConf({
          projectId: args.projectId, plan: args.plan, cipherPass: args.cipherPass, repo,
        }));

        const info = await repoInfo(opts.docker, name);
        const label = info.labels[info.labels.length - 1];
        if (!label) {
          return { passed: false, failedCheck: 'restore', durationMs: Date.now() - started,
            reason: 'the repo holds no backups at all' };
        }

        // ── 1. restore ───────────────────────────────────────────────────────
        const t0 = Date.now();
        try {
          // Latest, with no target: recovery ends when the archive is exhausted
          // and the cluster promotes itself, so there is no pause to resume from.
          await pgbackrestRestore(opts.docker, name, {});
        } catch (err) {
          return { passed: false, failedCheck: 'restore', backupLabel: label,
            durationMs: Date.now() - started, reason: (err as Error).message };
        }
        restoreMs = Date.now() - t0;

        // Start Postgres on the restored directory. `docker exec` rather than a
        // second container: the data is already here and the entrypoint would try
        // to initdb around it.
        const startPg = await opts.docker.execCapture(name, ['sh', '-c',
          'pg_ctl -D /var/lib/postgresql/data/pgdata -l /tmp/pg.log ' +
          '-o "-c config_file=/etc/corebase/postgresql.base.conf -c archive_mode=off ' +
          '-c listen_addresses=127.0.0.1" -w -t 120 start 2>&1 || cat /tmp/pg.log']);

        // ── 2. recovery reached consistency ──────────────────────────────────
        let recovered = false;
        const deadline = Date.now() + recoveryTimeoutMs;
        let lastState = '';
        while (Date.now() < deadline) {
          const r = await opts.docker.execCapture(name, ['psql', '-U', 'postgres',
            '-d', 'postgres', '-tAc', 'select pg_is_in_recovery()']);
          lastState = (r.stdout + r.stderr).trim();
          if (lastState === 'f') { recovered = true; break; }
          await new Promise((res) => setTimeout(res, 2000));
        }
        if (!recovered) {
          return { passed: false, failedCheck: 'recovery', backupLabel: label, restoreMs,
            durationMs: Date.now() - started,
            reason: `the restored cluster never left recovery (last answer: ` +
              `${lastState.slice(0, 200) || 'none'}; start output: ` +
              `${startPg.stdout.split('\n').slice(-3).join(' | ').slice(0, 300)})` };
        }

        // ── 3. data checksums ────────────────────────────────────────────────
        // The reason `initdb --data-checksums` exists (D-269). Page corruption is
        // otherwise silent, and a rotting cluster restores and reports healthy.
        const checksums = await opts.docker.execCapture(name, ['psql', '-U', 'postgres',
          '-d', 'postgres', '-tAc', 'show data_checksums']);
        if (checksums.stdout.trim() !== 'on') {
          return { passed: false, failedCheck: 'checksums', backupLabel: label, restoreMs,
            durationMs: Date.now() - started,
            reason: `the restored cluster has data checksums ${checksums.stdout.trim() || 'unknown'}, ` +
              'so corruption in it cannot be detected at all' };
        }

        // ── 4. pg_amcheck ────────────────────────────────────────────────────
        // A heap can be intact while a btree points at rows that are not there,
        // and the index is what queries actually read.
        // Redirect-then-report rather than a pipe, because the exit status has to
        // be pg_amcheck's and `${PIPESTATUS[0]}` is a bash-ism: the image's /bin/sh
        // is dash, where it is a bad substitution that makes the shell itself exit
        // non-zero — so every healthy cluster was reported as corrupt, by the
        // check's own plumbing. The same trap as `/dev/tcp` earlier in this phase.
        const amcheck = await opts.docker.execCapture(name, ['sh', '-c',
          // `--database` is the pattern flag and the database is *positional*;
          // `--dbname` is psql's spelling and pg_amcheck rejects it outright, which
          // reported every healthy cluster as corrupt.
          'pg_amcheck --username=postgres --heapallindexed --install-missing ' +
          'postgres > /tmp/amcheck.log 2>&1; rc=$?; ' +
          'tail -20 /tmp/amcheck.log; exit $rc']);
        if (amcheck.exitCode !== 0) {
          return { passed: false, failedCheck: 'amcheck', backupLabel: label, restoreMs,
            durationMs: Date.now() - started,
            reason: `pg_amcheck reported corruption: ${(amcheck.stdout || amcheck.stderr)
              .split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 500)}` };
        }

        // ── 5. sanity counts ─────────────────────────────────────────────────
        // The strongest check and the least mechanical: a backup can pass every
        // structural test and contain an empty database.
        if (args.expect && args.expect.nonEmptyTables.length > 0) {
          const empties: string[] = [];
          for (const table of args.expect.nonEmptyTables) {
            // The table name comes from the live project's own catalogue, never
            // from input, and is still quoted — a table called `my table` is
            // ordinary and would otherwise be a syntax error read as corruption.
            const q = await opts.docker.execCapture(name, ['psql', '-U', 'postgres',
              '-d', 'postgres', '-tAc',
              `select count(*) from "${table.replace(/"/g, '""')}"`]);
            const n = Number((q.stdout || '').trim());
            if (!Number.isFinite(n) || n === 0) empties.push(table);
          }
          if (empties.length > 0) {
            return { passed: false, failedCheck: 'sanity', backupLabel: label, restoreMs,
              durationMs: Date.now() - started,
              reason: `tables the live project reports as non-empty came back empty in ` +
                `the restore: ${empties.join(', ')}` };
          }
        }

        const size = await opts.docker.execCapture(name, ['psql', '-U', 'postgres',
          '-d', 'postgres', '-tAc', 'select pg_database_size(current_database())']);
        log('info', 'restore verification passed', {
          project: args.ref, backup: label, restore_ms: restoreMs });
        return {
          passed: true, backupLabel: label, restoreMs, durationMs: Date.now() - started,
          bytesRestored: Number(size.stdout.trim()) || undefined,
        };
      } catch (err) {
        return { passed: false, failedCheck: 'restore', durationMs: Date.now() - started,
          reason: pgbackrestFailure((err as Error).message, 500) };
      } finally {
        // Both, always, on every path. A verifier that leaked a container and a
        // volume per failure would fill the verification node exactly when the
        // fleet is having its worst day.
        await opts.docker.removeContainer(name, true, false).catch(() => {});
        await opts.docker.removeVolume(volume).catch(() => {});
      }
    },
  };
}
