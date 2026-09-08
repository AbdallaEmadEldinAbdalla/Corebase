import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './app.ts';

/**
 * Two guards against classes of bug this codebase has already produced once each.
 *
 * The first is a default credential. `SH_STATIC_TOKEN` used to fall back to the
 * literal string `dev-token`, so an API deployed with no configuration accepted
 * `Authorization: Bearer dev-token` as the bootstrap *owner* — no expiry, no
 * revocation, full rights. That is the same mistake the project refuses elsewhere
 * on purpose: the bootstrap user has no password (P1a), `trust` auth is banned
 * (D-185), `steadhold_app` is created NOLOGIN (D-216). It got in through a `??`.
 *
 * The second is an unmetered expensive operation. Every scrypt call costs 64 MiB
 * (D-211), and signup is the one unauthenticated endpoint that makes one.
 */
const SRC = new URL('.', import.meta.url).pathname;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.includes('.test.') ? [join(dir, e.name)] : []);

describe('no default credentials anywhere in the API', () => {
  it('an unconfigured app authenticates nothing', async () => {
    // "Unconfigured" has to mean it, and `buildApp` falls back to
    // `process.env.SH_STATIC_TOKEN` (app.ts) — so with the variable exported, as
    // STATUS §2's recipe does, the app under test is configured and accepts
    // exactly the token this asserts it must reject. The assertion was right and
    // the fixture was not.
    delete process.env['SH_STATIC_TOKEN'];
    const app = buildApp({});
    for (const authorization of ['Bearer dev-token', 'Bearer test-token', 'Bearer changeme']) {
      const res = await app.inject({ method: 'GET', url: '/v1/projects', headers: { authorization } });
      expect(res.statusCode, `"${authorization}" was accepted by an unconfigured API`).toBe(401);
    }
    const none = await app.inject({ method: 'GET', url: '/v1/projects' });
    expect(none.statusCode).toBe(401);
  });

  it('no source file gives a credential-shaped variable a fallback value', () => {
    // The shape of the original bug: `process.env.SH_X ?? '<literal>'` where X is a
    // secret. Catching the shape rather than the one literal is the point — the
    // next one will have a different string.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /process\.env\.(\w*(?:TOKEN|SECRET|PASSWORD|KEY)\w*)\s*\?\?\s*['"`]([^'"`]+)['"`]/g)) {
        offenders.push(`${file.replace(SRC, '')}: ${m[1]} ?? '${m[2]}'`);
      }
    }
    expect(offenders,
      `a credential with a default is a credential shipped in the source:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('every unauthenticated endpoint that hashes a password is metered', () => {
  it('signup consults a rate limiter before doing any work', () => {
    const src = readFileSync(join(SRC, 'modules/auth/routes.ts'), 'utf8');
    const signup = src.slice(src.indexOf("app.post('/v1/auth/signup'"),
                             src.indexOf("app.post('/v1/auth/login'"));
    expect(signup, 'signup does not rate limit').toContain('signupLimiter');
    // Before the work, not after: a limiter consulted after `users.signup()` has
    // already spent the 64 MiB it was supposed to prevent.
    expect(signup.indexOf('signupLimiter'),
      'the limiter is consulted after the expensive call, which defeats it')
      .toBeLessThan(signup.indexOf('deps.users.signup'));
  });

  it('signup and login do not share one budget', () => {
    // Sharing would let failed logins exhaust the signup allowance and vice
    // versa — two different things being protected, two counters.
    const src = readFileSync(join(SRC, 'modules/auth/routes.ts'), 'utf8');
    expect(src).toContain('signupLimiter');
    expect(src).toContain('loginLimiter');
    expect(src).toContain("rateLimitKey('signup-ip'");
  });
});
