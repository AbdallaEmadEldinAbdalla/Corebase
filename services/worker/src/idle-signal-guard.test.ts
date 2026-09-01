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
 */
const SRC = new URL('.', import.meta.url).pathname;

describe('D-236 — the idle signal is only sufficient while there is no data plane', () => {
  it('a project is still exactly two containers', () => {
    const spec = readFileSync(`${SRC}container-spec.ts`, 'utf8');
    // The builders that produce a per-project container. A third one means a third
    // way to use a project.
    const builders = [...spec.matchAll(/export function (build\w*Spec)\b/g)].map((m) => m[1]!);
    expect(
      builders.sort(),
      'A new per-project container appeared. If it serves customer traffic — PostgREST, ' +
      'auth, storage, a gateway — the idle scan can no longer conclude a project is idle ' +
      'from database connections alone: HTTP traffic with no direct connections would look ' +
      'idle and the project would be paused under its users. Implement the traffic signal ' +
      '(idle-scan.ts already takes a second input) and update D-236 before adding it here.',
    ).toEqual(['buildContainerSpec', 'buildPoolerSpec']);
  });

  it('nothing in the worker meters data-plane requests yet', () => {
    // The other direction: if a traffic meter *does* appear, the scan must start
    // using it rather than quietly ignoring a signal that now exists.
    const files = readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    const meters = files.filter((f) =>
      /requests?_total|data_plane|gateway_requests/.test(readFileSync(`${SRC}${f}`, 'utf8')));
    expect(
      meters,
      'Something now meters data-plane traffic. That is the first of D-236\'s two ' +
      'signals — wire it into idle-scan.ts and delete this assertion.',
    ).toEqual([]);
  });

  it('the scan refuses to conclude when a project cannot be asked', () => {
    // The one behavioural claim worth pinning here, because it is what keeps the
    // single-signal design safe: unreachable is not idle.
    const scan = readFileSync(`${SRC}idle-scan.ts`, 'utf8');
    expect(scan).toContain('cannot conclude');
    expect(scan).toMatch(/unreachable\+\+/);
  });
});
