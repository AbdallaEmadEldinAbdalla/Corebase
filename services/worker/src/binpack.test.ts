import { describe, it, expect } from 'vitest';
import {
  fillRatio, fits, rankNodes, FILL_CEILING,
  type NodeCandidate, type Booking,
} from './placement.ts';

/**
 * P2f — the bin-packer, without a database.
 *
 * Every case here is a fleet the old selection got wrong. `ORDER BY
 * ram_reserved_mb ASC LIMIT 1` is indistinguishable from correct on a fleet of
 * one identically-sized node, which is the only fleet that existed until now.
 */

const node = (
  hostname: string, ramTotal: number, ramUsed: number, diskTotal = 1000, diskUsed = 0,
): NodeCandidate => ({
  id: `id-${hostname}`, hostname,
  ramTotalMb: ramTotal, ramReservedMb: ramUsed,
  diskTotalGb: diskTotal, diskReservedGb: diskUsed,
});

const free: Booking = { ramMb: 350, diskGb: 1 };

describe('fill ratio', () => {
  it('is measured against the ceiling, not the total', () => {
    // 850 of 1000 MB is 85% of total and therefore 100% of what is bookable.
    expect(fillRatio(node('a', 1000, 850))).toBeCloseTo(1);
    expect(fillRatio(node('a', 1000, 425))).toBeCloseTo(0.5);
  });

  it('is the worse of RAM and disk, not RAM alone', () => {
    const lopsided = node('a', 64_000, 6_400, 1000, 800);   // 12% RAM, 94% disk
    expect(fillRatio(lopsided)).toBeGreaterThan(0.9);
  });

  it('treats a node with no capacity on an axis as full, not empty', () => {
    // 0/0 is not "empty". A node registered with no disk must never be chosen
    // because a division produced NaN and NaN sorted first.
    expect(fillRatio(node('a', 1000, 0, 0, 0))).toBe(Infinity);
  });
});

describe('ranking (the bug absolute-reserved ordering had)', () => {
  it('prefers the emptier node by ratio, not the one with fewer MB booked', () => {
    // The small node holds less RAM in absolute terms and is nearly full; the
    // big one holds more and is nearly empty. Absolute ordering picks the small
    // one — i.e. it hands projects to the fullest node in the fleet.
    const small = node('small', 4_000, 3_000);
    const big = node('big', 64_000, 8_000);
    expect(rankNodes([small, big], free)[0]!.hostname).toBe('big');
  });

  it('returns every node that fits, so a lost race has somewhere to go', () => {
    const ranked = rankNodes([node('a', 64_000, 0), node('b', 64_000, 100)], free);
    expect(ranked.map((n) => n.hostname)).toEqual(['a', 'b']);
  });

  it('excludes a node that does not fit rather than choosing it and failing', () => {
    // This is the false "no capacity": the emptiest node by ratio is too small
    // for the booking, and a single-candidate packer stops there.
    const tiny = node('tiny', 200, 0);            // emptiest, cannot hold 350 MB
    const roomy = node('roomy', 64_000, 32_000);  // half full, plenty of room
    expect(fillRatio(tiny)).toBeLessThan(fillRatio(roomy));
    expect(rankNodes([tiny, roomy], free).map((n) => n.hostname)).toEqual(['roomy']);
  });

  it('excludes a node with RAM but no disk headroom', () => {
    const noDisk = node('nodisk', 64_000, 0, 10, 9);   // ceiling is 8 GB, 9 booked
    expect(rankNodes([noDisk], free)).toEqual([]);
  });

  it('breaks ties on hostname so the order is total and reproducible', () => {
    const a = node('aaa', 64_000, 1_000);
    const b = node('bbb', 64_000, 1_000);
    expect(rankNodes([b, a], free).map((n) => n.hostname)).toEqual(['aaa', 'bbb']);
    expect(rankNodes([a, b], free).map((n) => n.hostname)).toEqual(['aaa', 'bbb']);
  });

  it('returns nothing when the region is full, rather than the least-bad node', () => {
    expect(rankNodes([node('a', 1000, 850), node('b', 1000, 900)], free)).toEqual([]);
  });
});

describe('the 85% stop holds on both axes (D-090, D-250)', () => {
  it('refuses the booking that would cross it, to the megabyte', () => {
    expect(fits(node('a', 1000, 500), { ramMb: 350, diskGb: 1 })).toBe(true);
    expect(fits(node('a', 1000, 501), { ramMb: 350, diskGb: 1 })).toBe(false);
  });

  it('refuses on disk with RAM to spare', () => {
    expect(fits(node('a', 64_000, 0, 100, 85), { ramMb: 350, diskGb: 1 })).toBe(false);
  });

  it('rejects a non-positive booking on either axis', () => {
    expect(() => fits(node('a', 1000, 0), { ramMb: 0, diskGb: 1 })).toThrow();
    expect(() => fits(node('a', 1000, 0), { ramMb: 350, diskGb: 0 })).toThrow();
  });

  it('spread-first fills a two-node fleet evenly, and stops at the stop', () => {
    // 4 GB nodes, free projects: 3481 MB bookable each, so 9 per node, 18 total.
    const fleet = [node('a', 4096, 0, 1000, 0), node('b', 4096, 0, 1000, 0)];
    let placed = 0;
    for (;;) {
      const pick = rankNodes(fleet, free)[0];
      if (!pick) break;
      const live = fleet.find((n) => n.hostname === pick.hostname)!;
      live.ramReservedMb += free.ramMb;
      live.diskReservedGb += free.diskGb;
      placed++;
      if (placed > 100) throw new Error('packer never filled up');
    }
    expect(placed).toBe(18);
    // Even, because spread-first alternates — that is the resume headroom D-091
    // relies on, and the reason not to fill one node before touching the next.
    expect(fleet[0]!.ramReservedMb).toBe(fleet[1]!.ramReservedMb);
    for (const n of fleet) expect(n.ramReservedMb).toBeLessThanOrEqual(4096 * FILL_CEILING);
  });
});
