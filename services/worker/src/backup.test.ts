import { describe, it, expect } from 'vitest';
import {
  renderPgbackrestConf, repoTargetFromEnv, repoPathFor, STANZA,
  PLAN_RETENTION_FULL, PLAN_ARCHIVE_TIMEOUT, isLockContention, withLockRetry,
  pgbackrestFailure, type RepoTarget,
} from './backup.ts';

const repo: RepoTarget = {
  endpoint: 'store.example', port: 9000, bucket: 'cb-backups',
  key: 'AKIA', secret: 's3cr3t', region: 'auto', uriStyle: 'path', verifyTls: false,
};
const base = {
  projectId: '11111111-1111-4111-8111-111111111111', plan: 'free',
  cipherPass: 'c'.repeat(48), repo,
};

describe('repo target from the environment', () => {
  it('needs all four essentials, or reports nothing configured', () => {
    // A partial configuration is how a fleet ends up with projects whose
    // archiving has been failing since they were created: archive_command retries
    // forever and nothing else looks.
    expect(repoTargetFromEnv({ CB_BACKUP_S3_ENDPOINT: 'h' })).toBeUndefined();
    expect(repoTargetFromEnv({
      CB_BACKUP_S3_ENDPOINT: 'h', CB_BACKUP_S3_BUCKET: 'b', CB_BACKUP_S3_KEY: 'k',
    })).toBeUndefined();
    expect(repoTargetFromEnv({
      CB_BACKUP_S3_ENDPOINT: 'h', CB_BACKUP_S3_BUCKET: 'b',
      CB_BACKUP_S3_KEY: 'k', CB_BACKUP_S3_SECRET: 's',
    })).toBeDefined();
  });

  it('defaults the port to 443, because S3 is TLS-only here', () => {
    const t = repoTargetFromEnv({
      CB_BACKUP_S3_ENDPOINT: 'h', CB_BACKUP_S3_BUCKET: 'b',
      CB_BACKUP_S3_KEY: 'k', CB_BACKUP_S3_SECRET: 's',
    })!;
    expect(t.port).toBe(443);
    expect(t.verifyTls).toBe(true);
  });
});

describe('the rendered config', () => {
  const conf = renderPgbackrestConf(base);

  it('isolates projects by repo path, not by stanza name', () => {
    // Every project's stanza is `main`, because archive_command lives in the
    // fleet-wide postgresql.base.conf and a per-project stanza name would need a
    // per-project Postgres config — the drift D-186 removed.
    expect(conf).toContain(`[${STANZA}]`);
    expect(conf).toContain(`repo1-path=${repoPathFor(base.projectId)}`);
    expect(repoPathFor('a')).not.toBe(repoPathFor('b'));
  });

  it('encrypts the repo, so the object store alone yields ciphertext', () => {
    expect(conf).toContain('repo1-cipher-type=aes-256-cbc');
    expect(conf).toContain(`repo1-cipher-pass=${base.cipherPass}`);
  });

  it('gives the endpoint the host and the port separately', () => {
    // `host:port` in the endpoint plus a different `repo1-storage-port` is a
    // 60-second connect timeout and exit 49 — which reads exactly like an
    // unreachable network rather than a misconfigured one.
    expect(conf).toContain('repo1-s3-endpoint=store.example');
    expect(conf).not.toContain('repo1-s3-endpoint=store.example:9000');
    expect(conf).toContain('repo1-storage-port=9000');
  });

  it('spools asynchronously onto the project volume, inside its own quota', () => {
    // A runaway spool has to be the tenant's ceiling, not the node's.
    expect(conf).toContain('archive-async=y');
    expect(conf).toContain('spool-path=/var/lib/postgresql/data/pgbackrest-spool');
  });

  it('bounds parallelism so a backup cannot starve the neighbours', () => {
    expect(conf).toContain('process-max=2');
  });

  it('sets retention from the plan, with the free tier at a 7-day window', () => {
    expect(renderPgbackrestConf(base)).toContain('repo1-retention-full=7');
    expect(renderPgbackrestConf({ ...base, plan: 'pro' })).toContain('repo1-retention-full=35');
    // Pro's 35 against a 30-day PITR window is deliberate slack: a day-30 target
    // needs a base backup *older* than it to replay from.
    expect(PLAN_RETENTION_FULL['pro']!).toBeGreaterThan(30);
  });

  it('falls back to the strictest retention for an unknown plan', () => {
    expect(renderPgbackrestConf({ ...base, plan: 'invented' }))
      .toContain(`repo1-retention-full=${PLAN_RETENTION_FULL['free']}`);
  });

  it('bounds RPO more tightly on paid plans', () => {
    expect(PLAN_ARCHIVE_TIMEOUT['free']).toBe(300);
    expect(PLAN_ARCHIVE_TIMEOUT['pro']).toBe(60);
  });

  it('takes PGDATA from the spec rather than assuming it (D-186)', () => {
    expect(conf).toContain('pg1-path=/var/lib/postgresql/data/pgdata');
    expect(renderPgbackrestConf({ ...base, pgPath: '/elsewhere/pgdata' }))
      .toContain('pg1-path=/elsewhere/pgdata');
  });
});

describe('losing a race with the async archiver', () => {
  const lockError = `P00   INFO: stanza-create command begin 2.59.1: --exec-id=1 --repo1-path=/x
P00  ERROR: [050]: unable to acquire lock on file '/tmp/pgbackrest/main-archive-1.lock': Resource temporarily unavailable
      HINT: is another pgBackRest process running?`;

  it('recognises the archiver holding the lock', () => {
    expect(isLockContention(lockError)).toBe(true);
    expect(isLockContention('ERROR: [087]: unable to find a valid repository')).toBe(false);
  });

  it('retries through contention and returns the success', async () => {
    let calls = 0;
    const r = await withLockRetry(async () => {
      calls++;
      return calls < 3
        ? { exitCode: 50, stdout: lockError, stderr: '' }
        : { exitCode: 0, stdout: 'ok', stderr: '' };
    }, { attempts: 5, delayMs: 1 });
    expect(r.exitCode).toBe(0);
    expect(calls).toBe(3);
  });

  it('does NOT retry a real failure — that would hide it behind a delay', async () => {
    let calls = 0;
    const r = await withLockRetry(async () => {
      calls++;
      return { exitCode: 87, stdout: 'ERROR: [087]: unable to find a valid repository', stderr: '' };
    }, { attempts: 5, delayMs: 1 });
    expect(r.exitCode).toBe(87);
    expect(calls).toBe(1);
  });

  it('gives up rather than waiting forever on a stuck lock', async () => {
    let calls = 0;
    const r = await withLockRetry(async () => {
      calls++;
      return { exitCode: 50, stdout: lockError, stderr: '' };
    }, { attempts: 3, delayMs: 1 });
    expect(r.exitCode).toBe(50);
    expect(calls).toBe(3);
  });
});

describe('reporting a pgBackRest failure', () => {
  it('reports the ERROR line, not the option banner', () => {
    // Every command opens by echoing its full option list, so the first 600
    // characters are the same wall of configuration whatever went wrong. Slicing
    // from the front produced an error message containing nothing about the error.
    const output = 'P00   INFO: stanza-create command begin 2.59.1: ' + '--repo1-x=y '.repeat(80) +
      "\nP00  ERROR: [050]: unable to acquire lock on file '/tmp/x.lock'";
    const msg = pgbackrestFailure(output);
    expect(msg).toContain('[050]');
    expect(msg).not.toContain('command begin');
  });

  it('falls back to the tail when there is no ERROR line at all', () => {
    const msg = pgbackrestFailure('P00 INFO: begin\nP00 INFO: middle\nP00 INFO: the last thing');
    expect(msg).toContain('the last thing');
  });
});
