import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load the object store's settings from the gitignored env file.
 *
 * Three integration suites had grown their own byte-identical copy of this and
 * a fourth was about to, which is the point at which duplication stops being
 * cheaper than a module. The shape of the bug it prevents is worth naming: the
 * settings live in a file rather than the environment because they carry a
 * secret, so a suite that forgets to load them does not fail with "no
 * credentials" — it fails with `s3FromEnv()` returning undefined, and then with
 * whatever that suite decided to do about it.
 *
 * Existing environment variables win, so CI (which exports them directly) is
 * unaffected and a developer can override one for a single run.
 */
export function loadBackupEnv(cwd = process.cwd()): void {
  const file = join(cwd, '../../infra/docker/staging/backup-store.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
  }
}
