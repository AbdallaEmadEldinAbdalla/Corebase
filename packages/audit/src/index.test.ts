import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { redact, REDACTED, writeAudit, SYSTEM, type Queryable } from './index.ts';

/** Captures the parameters a write would have sent, without a database. */
function recorder() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const q: Queryable = {
    query: (async (sql: unknown, params?: unknown[]) => {
      calls.push({ sql: String(sql), params: params ?? [] });
      return { rows: [], rowCount: 0 };
    }) as Queryable['query'],
  };
  return { q, calls };
}

describe('redaction by key', () => {
  it('drops anything that names a secret, however it is spelled', () => {
    const out = redact({
      password: 'hunter2',
      db_password_new: 'hunter3',
      service_role_token: 'abc',
      AUTHORIZATION: 'Bearer xyz',
      dek_wrapped: 'zzz',
      private_key: 'x',
      api_key: 'y',
      cookie: 'session=1',
      name: 'my-app',
    });
    for (const k of ['password', 'db_password_new', 'service_role_token', 'AUTHORIZATION',
      'dek_wrapped', 'private_key', 'api_key', 'cookie']) {
      expect(out[k]).toBe(REDACTED);
    }
    // Non-secrets survive, or the audit row says nothing useful.
    expect(out['name']).toBe('my-app');
  });

  it('keeps identifiers that merely look like secret names', () => {
    // Found live: the first audit trail read `idempotency_key: "[redacted]"`,
    // which loses "which retry created this" and protects nothing. These names
    // identify a thing rather than granting access to it.
    const out = redact({
      idempotency_key: 'demo-1788175004',
      kek_id: 'kek_2026_08',
      key_prefix: 'cbk_anon_kxq',
    });
    expect(out['idempotency_key']).toBe('demo-1788175004');
    expect(out['kek_id']).toBe('kek_2026_08');
    expect(out['key_prefix']).toBe('cbk_anon_kxq');
  });

  it('still checks the value of an allowlisted key', () => {
    // A field called key_prefix holding a whole JWT is a mistake worth catching.
    const out = redact({ key_prefix: 'eyJhbGciOiJFUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig' });
    expect(out['key_prefix']).toBe(`${REDACTED}:jwt`);
  });

  it('redacts nested objects and arrays', () => {
    const out = redact({
      project: { name: 'ok', credentials: { password: 'p' } },
      list: [{ token: 't' }, { note: 'fine' }],
    }) as Record<string, Record<string, unknown>>;
    expect((out['project']!['credentials'] as unknown)).toBe(REDACTED);
    expect((out['list'] as unknown as Array<Record<string, unknown>>)[0]!['token']).toBe(REDACTED);
    expect((out['list'] as unknown as Array<Record<string, unknown>>)[1]!['note']).toBe('fine');
  });
});

describe('redaction by value shape', () => {
  /**
   * The half that keeps working after someone renames a field. audit_logs is
   * append-only, so a secret written here can never be removed.
   */
  it('catches a generated secret under an innocent key', () => {
    const secret = randomBytes(32).toString('base64url');   // packages/crypto's shape
    const out = redact({ note: secret });
    expect(out['note']).toBe(`${REDACTED}:generated-secret`);
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it('catches a JWT', () => {
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl';
    expect(redact({ value: jwt })['value']).toBe(`${REDACTED}:jwt`);
  });

  it('catches a PEM private key', () => {
    const pem = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQ...\n-----END EC PRIVATE KEY-----';
    expect(redact({ blob: pem })['blob']).toBe(`${REDACTED}:pem-private-key`);
  });

  it('catches a connection string carrying a password', () => {
    const url = 'postgres://developer:s3cret@abc.steadhold.app:5432/postgres';
    expect(redact({ url })['url']).toBe(`${REDACTED}:connection-string-with-password`);
  });

  it('leaves a connection string with no password alone', () => {
    // Over-redaction hides the useful half of an audit row.
    const url = 'postgres://abc.steadhold.app:5432/postgres';
    expect(redact({ url })['url']).toBe(url);
  });

  it('does not redact ordinary short strings that merely look opaque', () => {
    expect(redact({ ref: 'kxqwrtplmzensfba' })['ref']).toBe('kxqwrtplmzensfba');
    expect(redact({ id: 'a1b2c3d4-0000-0000-0000-000000000001' })['id'])
      .toBe('a1b2c3d4-0000-0000-0000-000000000001');
  });
});

describe('writeAudit', () => {
  it('inserts with the actor and event fields in place', async () => {
    const { q, calls } = recorder();
    await writeAudit(q, { type: 'user', userId: 'u1', ip: '203.0.113.9', requestId: 'req_1' }, {
      action: 'project.created', resourceType: 'project', resourceId: 'ref1',
      organizationId: 'o1', projectId: 'p1', metadata: { name: 'my-app' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/INSERT INTO audit_logs/);
    expect(calls[0]!.params).toEqual([
      'o1', 'p1', 'u1', 'user', 'project.created', 'project', 'ref1',
      '{"name":"my-app"}', '203.0.113.9', 'req_1',
    ]);
  });

  it('redacts on the way in, so the append-only table never holds a secret', async () => {
    const { q, calls } = recorder();
    const secret = randomBytes(32).toString('base64url');
    await writeAudit(q, SYSTEM, {
      action: 'credentials.created', resourceType: 'project',
      metadata: { role: 'developer', password: secret, url: `postgres://developer:${secret}@h:5432/postgres` },
    });
    const metadata = String(calls[0]!.params[7]);
    expect(metadata).not.toContain(secret);
    expect(metadata).toContain('"role":"developer"');
  });

  it('truncates outsized metadata instead of failing the mutation', async () => {
    // The audit row travels in the mutation's transaction, so a rejected insert
    // would roll the mutation back. Losing the metadata beats losing the row,
    // and losing the row beats losing the operation.
    const { q, calls } = recorder();
    await writeAudit(q, SYSTEM, {
      action: 'big.thing', resourceType: 'test',
      metadata: { blob: 'x'.repeat(20_000) },
    });
    const metadata = JSON.parse(String(calls[0]!.params[7])) as { truncated: boolean; bytes: number };
    expect(metadata.truncated).toBe(true);
    expect(metadata.bytes).toBeGreaterThan(8 * 1024);
  });

  it('records the system actor with no user', async () => {
    const { q, calls } = recorder();
    await writeAudit(q, SYSTEM, { action: 'project.ready', resourceType: 'project' });
    expect(calls[0]!.params[2]).toBeNull();      // actor_user_id
    expect(calls[0]!.params[3]).toBe('system');
  });

  it('writes through whatever client it is given, so it can join a transaction', async () => {
    // The whole design: the caller's transaction, not a pool of our own.
    const { q, calls } = recorder();
    await writeAudit(q, SYSTEM, { action: 'a.b', resourceType: 'test' });
    expect(calls).toHaveLength(1);
  });
});
