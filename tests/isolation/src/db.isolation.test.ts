import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { setUp, tearDown, type Harness, type Fixture } from './harness.ts';

/**
 * Database-path isolation — the threat model's boundaries (b) and (c).
 *
 * Every session here is opened with the fixture's **own advertised credentials**
 * on its **own published port**: the connection string a customer is handed. That
 * is the attacker's surface for this boundary, and it is also the surface a
 * legitimate customer uses, which is why each denial is asserted by its exact
 * message rather than by "it threw" — the difference between "permission denied
 * for schema auth" and a connection error is the difference between a fence and
 * an outage.
 */
let h: Harness | undefined;
beforeAll(async () => { h = await setUp(); });
afterAll(async () => { await tearDown(h); });

const A = () => h!.a;
const B = () => h!.b;

const connect = async (f: Fixture, port = f.port, creds = f) => {
  const c = new Client({
    host: '127.0.0.1', port, database: 'postgres',
    user: creds.dbUser, password: creds.dbPassword, connectionTimeoutMillis: 8000,
  });
  await c.connect();
  return c;
};

/** Runs SQL expected to be refused, and hands back the message to assert on. */
async function denied(c: Client, sql: string): Promise<string> {
  try {
    await c.query(sql);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`SQL that must be refused succeeded: ${sql}`);
}

describe('DB-1 — A\'s database credentials at B\'s pooler', () => {
  it('fails authentication: the pooler has no entry for another project\'s role', async () => {
    // Both projects use the same *role name* (`developer`) — which is the point.
    // If the pooler resolved credentials globally rather than per project, A's
    // password would open B, and the role name would be no obstacle at all.
    await expect(connect(B(), B().poolerPort, A())).rejects.toThrow(
      /SASL authentication failed|password authentication failed/);
  });

  it('and A\'s own pooler still works, so the refusal above is not a broken pooler', async () => {
    // The positive control D-1 needs. Without it, a pooler that refuses everyone
    // passes the test above while serving nobody.
    const c = await connect(A(), A().poolerPort);
    try {
      expect((await c.query<{ n: number }>('select 1 as n')).rows[0]!.n).toBe(1);
    } finally { await c.end(); }
  });
});

describe('DB-3 — the auth schema from a customer session', () => {
  it('is not readable, and cannot be reached by switching role either', async () => {
    const c = await connect(A());
    try {
      // The direct attempt.
      expect(await denied(c, 'select * from auth.users'))
        .toMatch(/permission denied for schema auth/);
      // And the obvious escalation: become the role PostgREST uses. A customer
      // who could `set role authenticated` would inherit whatever the API role
      // may read, which is a different privilege set than their own.
      expect(await denied(c, 'set role authenticated'))
        .toMatch(/permission denied to set role/);
    } finally { await c.end(); }
  });
});

describe('DB-4 to DB-7 — the Postgres privilege fence', () => {
  it('refuses a non-allowlisted extension (DB-4)', async () => {
    const c = await connect(A());
    try {
      expect(await denied(c, 'create extension pg_cron'))
        .toMatch(/extension "pg_cron" is not available/);
    } finally { await c.end(); }
  });

  it('refuses COPY TO PROGRAM — the shortest path from SQL to a shell (DB-5)', async () => {
    const c = await connect(A());
    try {
      expect(await denied(c, `copy (select 1) to program 'id > /tmp/pwn'`))
        .toMatch(/permission denied to COPY to or from an external program/);
    } finally { await c.end(); }
  });

  it('refuses server-side file reads (DB-6)', async () => {
    const c = await connect(A());
    try {
      expect(await denied(c, `select lo_import('/etc/passwd')`))
        .toMatch(/permission denied for function lo_import/);
    } finally { await c.end(); }
  });

  it('refuses dblink, which would otherwise make the network the only obstacle (DB-7)', async () => {
    const c = await connect(A());
    try {
      expect(await denied(c, 'create extension dblink'))
        .toMatch(/extension "dblink" is not available/);
    } finally { await c.end(); }
  });
});

describe('DB-8 — a resource bomb is contained, and the co-tenant does not notice', () => {
  it('is killed by statement_timeout, which the customer cannot lift for the server', async () => {
    const c = await connect(A());
    try {
      const { rows } = await c.query<{ statement_timeout: string }>('show statement_timeout');
      expect(rows[0]!.statement_timeout).toBe('1min');

      // The interesting half: a customer *can* raise their own session's timeout,
      // so the timeout alone is not the containment — which is why the latency
      // measurement below is the actual assertion.
      await c.query('set statement_timeout = 0');
      expect((await c.query<{ statement_timeout: string }>('show statement_timeout'))
        .rows[0]!.statement_timeout).toBe('0');
    } finally { await c.end(); }
  });

  it('EXIT CRITERION: B\'s latency stays sane while A is under a bomb', async () => {
    const victim = await connect(B());
    const attacker = await connect(A());
    try {
      // A baseline for B, before anything is happening to A.
      const baseline = await timeQueries(victim, 20);

      // A raises its own timeout to 20s — a value a customer legitimately might —
      // and starts an unbounded scan. It is *not* awaited: the assertion is about
      // B while this runs, and the bomb terminates itself when the raised timeout
      // expires.
      //
      // An earlier version set `statement_timeout = 0` and tried to cancel the
      // query afterwards with `pg_cancel_backend(pg_backend_pid())` on the same
      // connection. That cannot work — the session is busy running the bomb, so
      // the cancel queues behind the thing it is meant to cancel — and the test
      // hung for its full timeout instead of failing with a reason.
      await attacker.query(`set statement_timeout = '20s'`);
      const bomb = attacker
        .query('select count(*) from generate_series(1, 100000000000)')
        .then(() => 'completed' as const)
        .catch((err: Error) => err.message);

      const under = await timeQueries(victim, 40);

      // The bomb must have been *killed*, not finished. If it ever completes, the
      // scan was not unbounded and this test measured nothing.
      const outcome = await bomb;
      expect(outcome).toMatch(/statement timeout|canceling statement/);

      // The claim is containment, not identical performance: A and B are separate
      // containers with their own CPU and memory limits (D-009), so B's latency
      // should stay in the same order of magnitude. A generous multiple, because
      // the failure this catches is "B became unusable", not a millisecond of
      // jitter — and a tight bound would make this flaky, which an isolation suite
      // may never be.
      expect(under).toBeLessThan(Math.max(baseline * 10, 250));

      // And B is still *correct*, not merely fast: a co-tenant that answers
      // quickly with the wrong thing is a worse failure than a slow one.
      expect((await victim.query<{ n: number }>('select 42 as n')).rows[0]!.n).toBe(42);
    } finally {
      await attacker.end().catch(() => undefined);
      await victim.end();
    }
  }, 120_000);
});

/** Median-ish latency of a trivial query, in milliseconds. */
async function timeQueries(c: Client, n: number): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await c.query('select 1');
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  return times[Math.floor(times.length / 2)]!;
}
