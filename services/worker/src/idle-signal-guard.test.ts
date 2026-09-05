import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * A tripwire for D-236, not a test of behaviour.
 *
 * The idle scan implements one of the two signals the design requires. "No
 * database connections" is built; "no data-plane traffic" needs a gateway that
 * does not exist. Today that is *sufficient rather than incomplete*, for one
 * reason: there is no data plane, so a client connection is the only way to use a
 * project at all.
 *
 * The moment that stops being true, the scan becomes wrong in the worst possible
 * direction — a project serving HTTP traffic with no direct connections looks idle
 * and gets paused under its users, and nothing anywhere would fail. A gap that
 * activates later and reports nothing is worse than a gap that is loud now.
 *
 * So this asserts the *precondition* rather than the behaviour: a project is
 * exactly two containers, database and pooler. Add PostgREST, an auth service or a
 * gateway to the per-project stack and this test fails with instructions, because
 * at that moment the idle signal has to grow its second half before it can be
 * trusted again.
 *
 * **P5a built that second half, and doing so showed this file had been watching
 * the wrong door.** The container count is a proxy for "a new way to use a
 * project", and the auth module became one without adding a container — it is a
 * shared multi-tenant process. So `/auth/v1/*` served per-project traffic from
 * P4b onward while the scan still concluded from database connections alone, and
 * a project whose users only signed up and logged in looked idle. Nothing failed,
 * which is exactly what this file exists to prevent.
 *
 * The container assertion stays until PostgREST lands, because it is still the
 * cheapest way to notice a *third container*. What has changed is that tripping it
 * is now a prompt to check the signal covers the new path, not to build the signal
 * from scratch.
 */
const SRC = new URL('.', import.meta.url).pathname;

describe('D-236 — the idle signal is only sufficient while there is no data plane', () => {
  it('every per-project container that serves traffic is covered by the signal', () => {
    const spec = readFileSync(`${SRC}container-spec.ts`, 'utf8');
    const builders = [...spec.matchAll(/export function (build\w*Spec)\b/g)].map((m) => m[1]!);
    // PostgREST joined in P5b, which is what this assertion was built to stop
    // happening *before* the traffic signal existed. It exists now (P5a), so the
    // list grows rather than the tripwire firing — and the list is still checked,
    // because a fourth builder is a fourth way to use a project and the question
    // has to be asked again: does the signal see it?
    //
    // For PostgREST the answer is yes and by construction: every data-plane
    // request resolves a project through the gateway, and resolution is where the
    // signal fires. A container that served traffic *without* passing through
    // project resolution would be invisible again, which is the thing to check
    // when this list next changes.
    expect(
      builders.sort(),
      'A new per-project container appeared. Does data-plane traffic to it pass ' +
      'through project resolution, where the traffic signal fires (P5a, D-374)? ' +
      'If not, the idle scan cannot see it and the project will be paused under ' +
      'its users — wire the signal before adding it here.',
    ).toEqual(['buildContainerSpec', 'buildPoolerSpec', 'buildPostgrestSpec']);
  });

  it('the traffic signal is recorded where the scan already reads it (P5a)', () => {
    // D-236's first signal now exists, and the tripwire it replaced was watching
    // the wrong door: it looked for a new *container*, and the data plane arrived
    // as a shared *process* — the auth module, serving `/auth/v1/*` per project
    // since P4b, whose connections open as an internal role the scan excludes.
    // For that whole time a project used only for signups and logins looked idle.
    //
    // The signal writes `project_databases.last_active_at`, which is the column
    // the scan already filters candidates on — so a project touched by traffic
    // simply stops being a candidate, and the scan needed no change at all. This
    // asserts that wiring, because it is the kind that would keep working after
    // being disconnected: nothing fails if the write stops, the projects just
    // quietly start pausing again.
    const meter = readFileSync(
      `${SRC}../../api/src/modules/project-auth/traffic.ts`, 'utf8');
    expect(meter).toMatch(/last_active_at = now\(\)/);
    const context = readFileSync(
      `${SRC}../../api/src/modules/project-auth/context.ts`, 'utf8');
    // Called from project resolution, which is the one place every data-plane
    // request passes through — today's auth endpoints and tomorrow's gateway
    // routes alike.
    expect(context).toMatch(/traffic\?\.seen\(/);
    const scan = readFileSync(`${SRC}idle-scan.ts`, 'utf8');
    expect(scan).toContain('last_active_at');
  });

  it('the scan refuses to conclude when a project cannot be asked', () => {
    // The one behavioural claim worth pinning here, because it is what keeps the
    // single-signal design safe: unreachable is not idle.
    const scan = readFileSync(`${SRC}idle-scan.ts`, 'utf8');
    expect(scan).toContain('cannot conclude');
    expect(scan).toMatch(/unreachable\+\+/);
  });
});
