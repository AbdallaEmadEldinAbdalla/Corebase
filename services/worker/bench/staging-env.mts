import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The control-plane URL the *services* should use: the least-privilege
 * `corebase_app` role, never the schema owner (P1b).
 *
 * Harnesses keep using the owner URL for their own fixture work — truncating
 * tables is an admin activity and pretending otherwise would mean granting the
 * application privileges it must not have. The split is the point: every live run
 * exercises the restricted role, while the fixtures that set the run up do not.
 */
export function appDatabaseUrl(root: string, port = 55433): string {
  if (process.env.CB_APP_DATABASE_URL) return process.env.CB_APP_DATABASE_URL;
  const file = join(root, 'infra/docker/staging/app-role.env');
  if (existsSync(file)) {
    const pw = /CB_APP_DB_PASSWORD=(.+)/.exec(readFileSync(file, 'utf8'))?.[1]?.trim();
    if (pw) return `postgres://corebase_app:${pw}@127.0.0.1:${port}/corebase_control`;
  }
  // Falling back to the owner would silently un-test the privilege split, so say
  // so rather than quietly running with more access than production has.
  console.warn('⚠ no app-role credentials found — services will run as the schema OWNER, ' +
    'which is not what production does. Run ./scripts/staging.sh app-role');
  return process.env.CB_CONTROL_DATABASE_URL
    ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
}

/** The owner URL, for fixtures and assertions only. */
export const ownerDatabaseUrl = (): string =>
  process.env.CB_CONTROL_DATABASE_URL
  ?? 'postgres://corebase:controlpass@127.0.0.1:55433/corebase_control';
