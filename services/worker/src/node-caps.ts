import type { Docker } from './docker.ts';

/**
 * What a node's kernel will actually enforce (P2f).
 *
 * This module exists because of one failure. Adding `BlkioWeight` to the
 * container spec — cgroup v2's `io.weight`, exactly what D-055 asks for — made
 * **every container on the node fail to start**:
 *
 *     OCI runtime create failed: unable to start container process:
 *     error setting cgroup config for procHooks process:
 *     openat2 /sys/fs/cgroup/docker/<id>/io.weight: no such file or directory
 *
 * `io.weight` is only present when the kernel was built with a weight-capable
 * I/O policy — `CONFIG_BFQ_GROUP_IOSCHED`, or `blk-iocost`. Without one, the io
 * controller offers `io.max` and `io.stat` and nothing to weight with, and runc
 * turns the missing file into a hard start failure rather than a warning.
 *
 * The engine will not answer the question either: on cgroup v2 `/info` has
 * dropped its blkio fields entirely and reports `Warnings: None`. So the only
 * source of truth is the file, and the only way to read it is from inside a
 * container on that node.
 *
 * Which direction to fail matters more than the probe. A missing I/O weight
 * costs fairness on a contended disk. A weight the kernel cannot apply costs
 * *every provision on that node*, with an error message about `openat2` that
 * names nothing a reader would connect to a plan's I/O share. So every
 * uncertainty here resolves to "unsupported".
 */

export interface NodeCaps {
  /** Can this node's kernel take `BlkioWeight` at all? */
  ioWeight: boolean;
}

/**
 * Cached per Docker client — i.e. per node — because the answer is a property of
 * the node's kernel and cannot change without a reboot, and because the probe
 * costs a container start.
 */
const cache = new WeakMap<object, NodeCaps>();

/**
 * Probe by starting one throwaway container and asking it whether the file
 * exists in its own cgroup.
 *
 * Reading it from inside is the right place to read it: with `cgroupns=private`
 * a container's `/sys/fs/cgroup` *is* its own cgroup directory, so the presence
 * of `io.weight` there is precisely the question runc will ask when it applies
 * the spec.
 *
 * The probe deliberately does not set `BlkioWeight` itself. A probe that fails
 * the way the real thing fails tells you nothing about *why*, and a container
 * that will not start gives no output to read.
 */
export async function probeNodeCaps(docker: Docker, image: string): Promise<NodeCaps> {
  const name = `sh-caps-probe-${Date.now().toString(36)}`;
  try {
    const id = await docker.createContainer(name, {
      Image: image,
      Env: [],
      // Deliberately NOT labelled `com.steadhold.managed`. The reconciler scans on
      // that label, and a container claiming to be managed while belonging to no
      // project is drift by construction — the reconciler happens to skip it
      // today only because it also has no ref label, which is a coincidence and
      // not a contract.
      Labels: { 'com.steadhold.role': 'caps-probe' },
      Cmd: ['sh', '-c', 'test -e /sys/fs/cgroup/io.weight && echo yes || echo no'],
      HostConfig: {
        Memory: 64 * 1024 * 1024,
        MemorySwap: 64 * 1024 * 1024,
        NanoCpus: Math.round(0.1 * 1e9),
        PidsLimit: 16,
        RestartPolicy: { Name: 'no' },
        Mounts: [],
        PortBindings: {},
      },
      ExposedPorts: {},
    });
    await docker.startContainer(id);
    // The command exits immediately; a short poll is enough and a long one would
    // put a container start on the critical path of the first provision.
    for (let i = 0; i < 30; i++) {
      const st = await docker.inspectContainer(name);
      if (st && !st.State.Running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const logs = await docker.containerLogs(name);
    return { ioWeight: /\byes\b/.test(logs) };
  } catch {
    // Any failure at all — no image, engine unreachable, a runtime that refuses
    // the probe — resolves to unsupported, for the reason in the module comment.
    return { ioWeight: false };
  } finally {
    // `v=1`: the probe runs the project image with no mount, so Docker gives it
    // an anonymous volume that would otherwise outlive it forever — one orphan
    // volume per worker start, each of which reconciliation reports as disk with
    // no owner. Safe here precisely because the probe has no mounts to lose.
    await docker.removeContainer(name, true, true).catch(() => { /* best effort */ });
  }
}

export async function nodeCaps(docker: Docker, image: string): Promise<NodeCaps> {
  const hit = cache.get(docker as unknown as object);
  if (hit) return hit;
  const caps = await probeNodeCaps(docker, image);
  cache.set(docker as unknown as object, caps);
  return caps;
}

/** Test seam: lets a suite assert both branches without two kernels. */
export function setNodeCaps(docker: Docker, caps: NodeCaps): void {
  cache.set(docker as unknown as object, caps);
}
