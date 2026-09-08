import { describe, it, expect } from 'vitest';
import { demux } from './docker.ts';
import { probeNodeCaps, nodeCaps, setNodeCaps } from './node-caps.ts';
import type { Docker } from './docker.ts';

/**
 * P2f — the capability probe, and the framing it depends on.
 *
 * The probe's job is to answer one question about a node's kernel and to answer
 * it *safely* when it cannot: a wrong "supported" costs every provision on that
 * node, a wrong "unsupported" costs proportional I/O fairness.
 */

describe('stdcopy framing', () => {
  const frame = (stream: number, text: string) => {
    const body = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };

  it('separates stdout from stderr', () => {
    const buf = Buffer.concat([frame(1, 'yes\n'), frame(2, 'oops\n'), frame(1, 'more')]);
    expect(demux(buf)).toEqual({ stdout: 'yes\nmore', stderr: 'oops\n' });
  });

  it('returns an unframed buffer verbatim rather than decoding it as garbage', () => {
    // A TTY exec has no headers. We never ask for one, but a buffer whose first
    // byte is not a stream id must not be reinterpreted as a length prefix.
    expect(demux(Buffer.from('plain output'))).toEqual({ stdout: 'plain output', stderr: '' });
  });

  it('handles an empty stream and a truncated final frame without throwing', () => {
    expect(demux(Buffer.alloc(0))).toEqual({ stdout: '', stderr: '' });
    const truncated = Buffer.concat([frame(1, 'abc').subarray(0, 9)]);
    expect(demux(truncated).stdout).toBe('a');
  });
});

/** Just enough Docker to drive the probe down each path. */
const fakeDocker = (over: Partial<Record<string, unknown>>): Docker => ({
  createContainer: async () => 'cid',
  startContainer: async () => {},
  inspectContainer: async () => ({ State: { Running: false } }),
  containerLogs: async () => 'no\n',
  removeContainer: async () => {},
  ...over,
} as unknown as Docker);

describe('probeNodeCaps', () => {
  it('reads a yes from the probe container', async () => {
    const d = fakeDocker({ containerLogs: async () => 'yes\n' });
    expect(await probeNodeCaps(d, 'img')).toEqual({ ioWeight: true });
  });

  it('reads a no', async () => {
    expect(await probeNodeCaps(fakeDocker({}), 'img')).toEqual({ ioWeight: false });
  });

  it('resolves an unreachable node to unsupported, not to a throw or a yes', async () => {
    // The direction matters more than the probe. A missing I/O weight costs
    // fairness on a contended disk; a weight the kernel cannot apply costs every
    // provision on the node, with an `openat2` error naming nothing a reader
    // would connect to a plan's I/O share.
    const d = fakeDocker({ createContainer: async () => { throw new Error('node down'); } });
    expect(await probeNodeCaps(d, 'img')).toEqual({ ioWeight: false });
  });

  it('cleans up the probe container even when the probe fails', async () => {
    const removed: string[] = [];
    const d = fakeDocker({
      startContainer: async () => { throw new Error('boom'); },
      removeContainer: async (n: string) => { removed.push(n); },
    });
    await probeNodeCaps(d, 'img');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/^sh-caps-probe-/);
  });
});

describe('caching', () => {
  it('probes a node once — the answer cannot change without a reboot', async () => {
    let probes = 0;
    const d = fakeDocker({
      createContainer: async () => { probes++; return 'cid'; },
      containerLogs: async () => 'yes\n',
    });
    expect((await nodeCaps(d, 'img')).ioWeight).toBe(true);
    expect((await nodeCaps(d, 'img')).ioWeight).toBe(true);
    expect(probes).toBe(1);
  });

  it('lets a suite assert both branches without two kernels', async () => {
    const d = fakeDocker({});
    setNodeCaps(d, { ioWeight: true });
    expect((await nodeCaps(d, 'img')).ioWeight).toBe(true);
  });
});
