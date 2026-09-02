import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { createDocker, type Docker } from './docker.ts';
import { buildContainerSpec, IMAGE, PIDS_LIMIT, PLAN_IO_WEIGHT } from './container-spec.ts';
import { probeNodeCaps } from './node-caps.ts';

/**
 * P2f — the noisy-neighbour walls, read from the kernel (D-055).
 *
 * Every assertion here reads `/sys/fs/cgroup/...` from inside the container, and
 * that choice is the whole point of the file. `docker inspect` reports the
 * HostConfig we *sent*; it says nothing about whether the engine applied it, so a
 * test built on inspect can only ever confirm our own request back to us. The
 * existing T5d limits test does exactly that, which is why it kept passing while
 * the I/O weight was silently taking down every container on the node.
 *
 * Two assertions go further and measure behaviour rather than configuration,
 * because a limit written to a cgroup file is still only a claim that the kernel
 * will act on it.
 */
const CERT_DIR = process.env.CB_DOCKER_CERT_DIR
  ?? join(process.cwd(), '../../infra/docker/staging/certs');
const HOST = process.env.CB_DOCKER_HOST ?? '127.0.0.1';
const PORT = Number(process.env.CB_DOCKER_PORT ?? 2376);
const NAME = 'cb-p2f-cgroups-probe';

let docker: Docker; let up = false; let reason = '';
let caps = { ioWeight: false };

/**
 * The spec under test, built **after** the node has been probed.
 *
 * It used to be a module-level constant built without `ioWeight`, which made this
 * suite pass only on a kernel that *lacks* `io.weight`: the container carried no
 * weight, the `else` branch ran, and the assertion was never exercised. On a kernel
 * that has the feature — a CI runner's — the other branch fired and compared the
 * plan's weight against the container's `default 100`, because nothing had asked
 * for a weight. A test that only passes where the feature is missing is not a test
 * of the feature.
 */
const specFor = (ioWeight: boolean) => buildContainerSpec({
  ref: 'p2fcgroupsaaaaaaaaaa', projectId: '33333333-3333-4333-8333-333333333333',
  volumeName: 'unused-no-mount', hostPort: 0, ramLimitMb: 512,
  bootstrapSecret: 'p2f-cgroup-probe-secret-0123456789', plan: 'free',
  ioWeight,
});
let SPEC = specFor(false);

beforeAll(async () => {
  try {
    docker = createDocker({ host: HOST, port: PORT, certDir: CERT_DIR, timeoutMs: 20_000 });
    await docker.ping();
    if (!(await docker.imageExists(IMAGE))) {
      throw new Error(`${IMAGE} is not on the data node — run ./scripts/staging.sh seed-images`);
    }
    caps = await probeNodeCaps(docker, IMAGE);
    // Built from what the node can actually do, so the container under test is the
    // one provisioning would create on *this* node.
    SPEC = specFor(caps.ioWeight);
    await docker.removeContainer(NAME, true, true).catch(() => {});
    // The real spec, with the entrypoint given something cheap to run instead of
    // Postgres. The cgroup walls are HostConfig and identical either way, and
    // skipping initdb keeps this suite seconds rather than a minute — the walls
    // are what is under test, not the database.
    const id = await docker.createContainer(NAME, {
      ...SPEC,
      Cmd: ['sleep', '300'],
      HostConfig: { ...SPEC.HostConfig, Mounts: [], PortBindings: {} },
      ExposedPorts: {},
    });
    await docker.startContainer(id);
    up = true;
  } catch (err) {
    reason = (err as Error).message;
    console.error('P2f cgroup setup FAILED:', reason);
    up = false;
  }
}, 60_000);

afterAll(async () => {
  if (up) await docker.removeContainer(NAME, true, true).catch(() => {});
  docker?.close();
});

const t = (n: string, fn: () => Promise<void>, ms = 30_000) =>
  it(n, async () => {
    if (!up) throw new Error(`data node not usable (${reason}) — run ./scripts/staging.sh up. ` +
      'This is the P2f done-signal and must not skip silently.');
    await fn();
  }, ms);

/** What the kernel says, trimmed. Empty string when the file does not exist. */
async function cg(file: string): Promise<string> {
  const r = await docker.execCapture(NAME, ['sh', '-c', `cat /sys/fs/cgroup/${file} 2>/dev/null`]);
  return r.stdout.trim();
}

/**
 * Does the file exist? Separate from reading it, because presence and content are
 * different questions and conflating them was wrong here: `io.max` exists on this
 * kernel and reads as the empty string when no device limits are set, so an
 * emptiness check reports the controller as missing when it is present and usable.
 */
async function cgExists(file: string): Promise<boolean> {
  const r = await docker.execCapture(NAME, ['sh', '-c', `test -e /sys/fs/cgroup/${file}`]);
  return r.exitCode === 0;
}

/**
 * Every container in this file runs the project image with **no mount**, and
 * `corebase/postgres` declares `VOLUME /var/lib/postgresql/data` — so Docker
 * hands each one an anonymous volume that a normal remove (`v=0`, the right
 * default for a project) leaves behind forever. Each run left a 64-hex orphan
 * volume on the node, which reconciliation then reported as disk with no owner,
 * and the failure surfaced two suites away in a test asserting a clean report.
 * Hence `removeContainer(name, true, true)` everywhere below.
 */
describe('P2f — memory', () => {
  t('memory.max is the plan limit, as the kernel sees it', async () => {
    expect(await cg('memory.max')).toBe(String(512 * 1024 * 1024));
  });

  t('swap is zero, so exceeding RAM is an OOM kill and not node-wide thrashing', async () => {
    // MemorySwap == Memory is Docker's way of saying "no swap"; the kernel's way
    // is memory.swap.max = 0. A memory wall with swap left open is not a wall —
    // the tenant keeps running and takes the whole node's disk latency with it.
    expect(await cg('memory.swap.max')).toBe('0');
  });
});

describe('P2f — CPU', () => {
  t('cpu.max is a hard quota, not just a share', async () => {
    // 0.5 cores → "50000 100000": 50 ms of CPU per 100 ms period. A weight-only
    // limit (cpu.weight) would read "max 100000" here and would let a single
    // tenant take the whole node whenever the node happened to be quiet.
    expect(await cg('cpu.max')).toBe('50000 100000');
  });

  t('the quota is actually enforced: a busy loop gets half a core, not a whole one', async () => {
    const usage = async () => {
      const s = await cg('cpu.stat');
      const m = /usage_usec (\d+)/.exec(s);
      if (!m) throw new Error(`cpu.stat has no usage_usec:\n${s}`);
      return Number(m[1]);
    };
    const before = await usage();
    await docker.execCapture(NAME, ['sh', '-c', 'timeout 2 sh -c "while : ; do : ; done"; true']);
    const spent = (await usage()) - before;

    // One busy single-threaded loop for 2s of wall time consumes ~2.0s of CPU
    // unthrottled. Under a 0.5-core quota it must consume ~1.0s. The window is
    // wide because the loop also pays for exec setup and the shell, but it does
    // not overlap the unthrottled figure — which is the only thing that matters.
    expect(spent).toBeGreaterThan(400_000);
    expect(spent).toBeLessThan(1_500_000);
  }, 60_000);
});

describe('P2f — processes', () => {
  t('pids.max is set, above what Postgres needs and far below the node', async () => {
    expect(await cg('pids.max')).toBe(String(PIDS_LIMIT));
  });

  t('the pid ceiling actually holds: the kernel refuses the fork', async () => {
    // Not a fork bomb for its own sake: `COPY ... PROGRAM`, an untrusted
    // extension, or anything else that gets to run inside the container can
    // exhaust the *node's* pid space, and a node that cannot fork cannot run any
    // tenant's database — or the reconciler that would notice.
    //
    // Deliberately a throwaway container with a tiny ceiling rather than a storm
    // against the real one. Storming the shared container leaves it pinned at its
    // limit, and every later exec into it then fails to fork — the wall working,
    // but it poisoned every assertion that came after it in this file. A small
    // limit reaches the same wall in a second and leaves nothing behind.
    const bomb = 'cb-p2f-pidbomb';
    await docker.removeContainer(bomb, true, true).catch(() => {});
    const id = await docker.createContainer(bomb, {
      ...SPEC,
      Cmd: ['sh', '-c', 'i=0; while [ $i -lt 50 ]; do sleep 10 & i=$((i+1)); done; echo NOWALL'],
      HostConfig: { ...SPEC.HostConfig, PidsLimit: 8, Mounts: [], PortBindings: {} },
      ExposedPorts: {},
    });
    try {
      await docker.startContainer(id);
      let state: { Running: boolean; ExitCode: number } | undefined;
      for (let i = 0; i < 100; i++) {
        const st = await docker.inspectContainer(bomb);
        if (st && !st.State.Running) { state = st.State; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      const logs = await docker.containerLogs(bomb);
      // The kernel's refusal, in the tenant's own words.
      expect(logs).toMatch(/Cannot fork|Resource temporarily unavailable/);
      expect(logs).not.toContain('NOWALL');
      expect(state?.ExitCode).not.toBe(0);
    } finally {
      await docker.removeContainer(bomb, true, true).catch(() => {});
    }
  }, 90_000);

  t('an engine error never comes back as though it were command output', async () => {
    // The cost of the wall, recorded rather than rediscovered: a project pinned at
    // `pids.max` cannot fork, so `docker exec` into it fails — an operator cannot
    // get a shell into the container that most needs one.
    //
    // Worse, the engine reports that on the exec's own stream with a 200, so
    // reading stdout yields "OCI runtime exec failed: ... unable to spawn stage-1"
    // where a value is expected. This suite asserted a cgroup value against that
    // sentence and reported it as a mismatch in the cgroup — an error arriving as
    // data, which is the failure mode P2e's swallowed ladder transition already
    // cost a day to. Whether the engine refuses at exec-create (null: "cannot
    // exec") or on the stream (a throw), the one thing it must never do is hand
    // the text back as output.
    const hog = 'cb-p2f-pidhog';
    await docker.removeContainer(hog, true, true).catch(() => {});
    const id = await docker.createContainer(hog, {
      ...SPEC,
      Cmd: ['sh', '-c', 'i=0; while [ $i -lt 50 ]; do sleep 25 & i=$((i+1)); done; sleep 25'],
      HostConfig: { ...SPEC.HostConfig, PidsLimit: 8, Mounts: [], PortBindings: {} },
      ExposedPorts: {},
    });
    try {
      await docker.startContainer(id);
      await new Promise((r) => setTimeout(r, 1500));
      let out = '';
      try {
        const r = await docker.execCapture(hog, ['sh', '-c', 'echo alive']);
        out = r.stdout + r.stderr;
        // If it did manage to exec, it must be a real answer and nothing else.
        if (out !== '') expect(out.trim()).toBe('alive');
      } catch (err) {
        expect((err as Error).message).toMatch(/OCI runtime exec failed|Resource temporarily/);
      }
      expect(out).not.toContain('OCI runtime');
    } finally {
      await docker.removeContainer(hog, true, true).catch(() => {});
    }
  }, 90_000);
});

describe('P2f — disk I/O', () => {
  t('the node is probed for io.weight rather than assumed to have it', async () => {
    // This assertion is environmental on purpose. On this node the answer is
    // *no*: the LinuxKit kernel has no weight-capable I/O policy (no BFQ, no
    // blk-iocost), so `io.weight` does not exist in the hierarchy — and runc
    // turns a BlkioWeight against that kernel into
    //   openat2 /sys/fs/cgroup/docker/<id>/io.weight: no such file or directory
    // i.e. the container never starts. The probe and the spec must agree, whichever
    // way the answer goes, and that agreement is what this test pins.
    const present = await cgExists('io.weight');
    // The probe and the kernel must agree, whichever way the answer goes. That is
    // the property worth pinning: everything else here follows from it.
    expect(caps.ioWeight).toBe(present);
    if (caps.ioWeight) {
      // The kernel has weights, so the spec asked for one and the kernel took it.
      expect(SPEC.HostConfig.BlkioWeight).toBe(PLAN_IO_WEIGHT['free']);
      expect(await cg('io.weight')).toContain(String(PLAN_IO_WEIGHT['free']));
    } else {
      // On this node the answer is *no*: the LinuxKit kernel has no weight-capable
      // I/O policy (no BFQ, no blk-iocost), so `io.weight` does not exist — and
      // runc turns a BlkioWeight against that kernel into
      //   openat2 /sys/fs/cgroup/docker/<id>/io.weight: no such file or directory
      // i.e. the container never starts. So the spec must omit it entirely.
      expect(SPEC.HostConfig).not.toHaveProperty('BlkioWeight');
    }
  });

  t('the io controller is present even where weights are not', async () => {
    // Worth pinning separately: `io.max` exists here, so the absolute per-device
    // ceilings D-055 asks for on the free tier are enforceable on this kernel
    // once an operator names the device. It is only the *proportional* half that
    // this kernel cannot do.
    //
    // Existence, not content: an `io.max` with no device limits set reads as the
    // empty string, so checking for non-empty content reports a controller that
    // is present and usable as missing.
    expect(await cgExists('io.max')).toBe(true);
    expect(await cgExists('io.stat')).toBe(true);
  });
});
