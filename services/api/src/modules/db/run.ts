import type { Client } from 'pg';
import { classify, withLimit, type Script } from '@steadhold/sql-guard';
import { ApiError } from '../../kernel/errors.ts';
import { ERROR_CODES } from '@steadhold/types';

/**
 * The four rails that are properties of *how* a statement runs.
 *
 * Rails 2 and 4 are questions about the text and live in `@steadhold/sql-guard`,
 * where they can be tested without a database. These four cannot: they are the
 * role the statement runs as, the timeout it runs under, the transaction it runs
 * in, and whether that transaction may write. Every one of them is a `SET LOCAL`
 * or a `BEGIN`, so every one of them needs a real session.
 *
 * The ordering inside the transaction is not arbitrary and is the part worth
 * reading twice:
 *
 *   1. `BEGIN`
 *   2. `SET LOCAL statement_timeout` — before anything that could hang
 *   3. `SET TRANSACTION READ ONLY` — before any statement, since it cannot be
 *      set once one has run
 *   4. `SET LOCAL ROLE` — last of the settings, because dropping to `anon` may
 *      remove the right to set the earlier two
 *   5. the caller's statements
 *   6. `COMMIT`, or `ROLLBACK` on any error
 *
 * Reversing 2 and 4 was the first version and it is wrong in a way that only
 * shows up as a role: `anon` cannot `SET statement_timeout`, so the timeout
 * silently failed to apply on exactly the runs where an unbounded query is most
 * likely — someone testing a policy against a table they cannot index.
 */

/** Rail 1's options, as they arrive on the wire (SQL-editor doc §Execution). */
export type ConsoleRole = 'admin' | 'anon' | 'authenticated';

/**
 * The database role each wire value maps to.
 *
 * `admin` becomes `developer`, which is the whole of D-462: the console's
 * default is the customer's own owning role, so it sees what their connection
 * string sees and anything it creates belongs to them.
 */
const DB_ROLE: Record<ConsoleRole, string> = {
  admin: 'developer',
  anon: 'anon',
  authenticated: 'authenticated',
};

/** Rail 3. D-134: 60s default, project-configurable, 10 minute cap. */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Rail 4. D-134: 500 rows render, and the 501st is how you know there are more. */
export const ROW_LIMIT = 501;

export interface RunRequest {
  sql: string;
  params?: readonly unknown[];
  role?: ConsoleRole;
  /** Only meaningful with `role: 'authenticated'` — the JWT claims to present. */
  claims?: Record<string, unknown>;
  readOnly?: boolean;
  confirmDestructive?: boolean;
  /** Names typed back, for statements at the top of the ladder. */
  confirmNames?: readonly string[];
  timeoutMs?: number;
}

export interface StatementResult {
  rows: unknown[];
  row_count: number;
  fields: { name: string; type: number }[];
  duration_ms: number;
  /** What actually ran, including any appended LIMIT. */
  executed_sql: string;
  /** True when a 501st row existed, so the UI can offer "show more". */
  truncated: boolean;
  command: string;
}

/**
 * Refuse a run that has not cleared rail 2, before opening a connection.
 *
 * Before, deliberately: a refused run should cost nothing, and a guard that
 * connects first is a guard an attacker can use to open connections. It also
 * means the refusal cannot be confused with a database error.
 */
export function enforceGuard(script: Script, req: RunRequest): void {
  if (script.danger === 'safe') return;

  if (!req.confirmDestructive) {
    throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
      script.dangerous.map((d) => d.reason).join(' ')
      + ' Re-send with confirm_destructive to run it.');
  }

  // The typed names, checked against what the statements actually name. A flag
  // is a claim that the user was asked; a matching name is evidence they read
  // the question — which is the entire difference between the two rungs.
  if (script.namesToType.length > 0) {
    const given = new Set((req.confirmNames ?? []).map((n) => n.trim()));
    const missing = script.namesToType.filter((n) => !given.has(n));
    if (missing.length > 0) {
      throw new ApiError(409, ERROR_CODES.VALIDATION_FAILED,
        `Type ${missing.map((m) => `"${m}"`).join(' and ')} to confirm `
        + 'dropping it. This cannot be undone from here.');
    }
  }
}

/** `SET LOCAL ROLE` needs an identifier, and these three are the only options. */
function roleLiteral(role: ConsoleRole): string {
  const name = DB_ROLE[role];
  // Not interpolation of user input — `role` is a closed union validated by the
  // route's schema and `DB_ROLE` is a literal map. The assertion is here so that
  // stays true if someone widens the union later.
  if (!/^[a-z_]+$/.test(name)) throw new Error(`unexpected role literal ${name}`);
  return `"${name}"`;
}

/**
 * Run one script as one transaction.
 *
 * Multi-statement scripts execute sequentially and report per statement, which
 * is what the SQL editor renders. They share one transaction, so a three-
 * statement script never half-applies — the rail that matters most in practice,
 * because the half-applied migration is the classic way to break a database
 * from a console.
 */
export async function runScript(
  client: Client, req: RunRequest,
): Promise<{ results: StatementResult[]; script: Script }> {
  const script = classify(req.sql);
  if (script.statements.length === 0) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_FAILED,
      'There is no statement to run.');
  }
  enforceGuard(script, req);

  const role: ConsoleRole = req.role ?? 'admin';
  const timeout = Math.min(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  /**
   * Rail 5's passthrough. When the script manages its own transaction we add no
   * wrapper — `BEGIN` inside a transaction is a warning and a no-op, and the
   * caller's `COMMIT` would then close *our* transaction and leave the rest of
   * their script running outside one, which is the opposite of the guarantee.
   */
  const wrap = !script.ownsTransaction;

  const results: StatementResult[] = [];
  if (wrap) await client.query('BEGIN');
  try {
    if (wrap) {
      // Rail 3, before anything can hang.
      await client.query(`SET LOCAL statement_timeout = ${Math.round(timeout)}`);
      // Rail 6, before any statement has run — Postgres refuses it afterwards.
      if (req.readOnly) await client.query('SET TRANSACTION READ ONLY');
      // Rail 1, last: dropping to `anon` can remove the right to set the above.
      await client.query(`SET LOCAL ROLE ${roleLiteral(role)}`);
      if (role === 'authenticated' && req.claims) {
        // The same pattern the data plane uses (D-015), so what the editor tests
        // is literally what production executes — which is the only reason a
        // policy debugger is worth trusting.
        await client.query(`SELECT set_config('request.jwt.claims', $1, true)`,
          [JSON.stringify(req.claims)]);
      }
    }

    for (const stmt of script.statements) {
      const limitable = script.limitable !== null && script.limitable.sql === stmt.sql;
      const sql = limitable ? withLimit(stmt.sql, ROW_LIMIT) : stmt.sql;
      const started = process.hrtime.bigint();
      const res = await client.query({
        text: sql,
        ...(req.params && req.params.length > 0 ? { values: [...req.params] } : {}),
      });
      const duration = Number(process.hrtime.bigint() - started) / 1e6;

      const rows = res.rows ?? [];
      const truncated = limitable && rows.length === ROW_LIMIT;
      results.push({
        // The 501st row is the *signal*, not data — it exists so the UI can say
        // there are more. Returning it would put a row on screen that the count
        // does not include.
        rows: truncated ? rows.slice(0, ROW_LIMIT - 1) : rows,
        row_count: truncated ? ROW_LIMIT - 1 : (res.rowCount ?? rows.length),
        fields: (res.fields ?? []).map((f) => ({ name: f.name, type: f.dataTypeID })),
        duration_ms: Math.round(duration * 100) / 100,
        executed_sql: sql,
        truncated,
        command: stmt.command,
      });
    }

    if (wrap) await client.query('COMMIT');
    return { results, script };
  } catch (err) {
    if (wrap) await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
