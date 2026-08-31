import { describe, it, expect } from 'vitest';
import { ProjectStatus } from '@corebase/types';
import { TONE, SETTLING } from './ProjectState.tsx';

/**
 * The regression this file exists for: the first live create came back with
 * status `creating`, which a hand-written list of states did not contain. The
 * badge went neutral — cosmetic — and the overview page concluded the project was
 * not settling and stopped polling, which is not cosmetic: the page would have
 * sat on CREATING until the user reloaded, on the very first thing they ever do
 * with the product.
 *
 * `TONE` is typed `Record<ProjectStatus, string>` so a *new* state is a compile
 * error. These tests cover what the type cannot: that the settling set is the
 * right subset, and that nothing terminal is in it (a project polled forever is
 * the same bug facing the other way).
 */
describe('project state', () => {
  const ALL = ProjectStatus.options;

  it('gives every status in the enum a tone', () => {
    for (const s of ALL) expect(TONE, `no tone for ${s}`).toHaveProperty(s);
  });

  it('treats every in-flight state as settling', () => {
    // These are the states where the control plane is still working, so the page
    // must keep asking.
    for (const s of ['creating', 'provisioning', 'configuring', 'pausing', 'resuming', 'deleting']) {
      expect(SETTLING.has(s), `${s} must be polled`).toBe(true);
    }
  });

  it('treats every resting state as terminal', () => {
    // And these are where it must stop, or a ready project polls once a second
    // forever — one request per second per open tab, for nothing.
    for (const s of ['ready', 'failed', 'paused', 'soft_deleted', 'deleted']) {
      expect(SETTLING.has(s), `${s} must not be polled`).toBe(false);
    }
  });

  it('partitions the enum with no state left undecided', () => {
    // The real invariant: settling ∪ resting = every state the API can return.
    // A state that is in neither list is one nobody thought about, which is
    // exactly how `creating` slipped through.
    const resting = ALL.filter((s) => !SETTLING.has(s));
    expect([...SETTLING].filter((s) => !ALL.includes(s as never)),
      'SETTLING names a state the API cannot return').toEqual([]);
    expect(resting.length + SETTLING.size).toBe(ALL.length);
  });
});
