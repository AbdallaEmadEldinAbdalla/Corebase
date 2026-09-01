import { describe, it, expect } from 'vitest';
import {
  buildContainerSpec, buildPoolerSpec, bootstrapPassword, containerName, LABEL_REF,
  PIDS_LIMIT, PLAN_IO_WEIGHT, FREE_IO_BPS, ioDeviceLimits,
} from './container-spec.ts';

const base = {
  ref: 'kxqwrtplmzensfba2345', projectId: '11111111-1111-4111-8111-111111111111',
  volumeName: 'cb-kxqwrtplmzensfba2345-pgdata', hostPort: 5433, ramLimitMb: 512,
  bootstrapSecret: 'a-long-enough-dev-secret',
};

describe('bootstrapPassword', () => {
  it('is deterministic, so a retry recomputes the same value', () => {
    expect(bootstrapPassword(base.bootstrapSecret, base.projectId))
      .toBe(bootstrapPassword(base.bootstrapSecret, base.projectId));
  });
  it('differs per project and per secret', () => {
    expect(bootstrapPassword(base.bootstrapSecret, base.projectId))
      .not.toBe(bootstrapPassword(base.bootstrapSecret, '22222222-2222-4222-8222-222222222222'));
    expect(bootstrapPassword('another-long-dev-secret', base.projectId))
      .not.toBe(bootstrapPassword(base.bootstrapSecret, base.projectId));
  });
  it('refuses a short secret rather than deriving weak passwords', () => {
    expect(() => bootstrapPassword('short', base.projectId)).toThrow(/at least 16/);
  });
  it('never contains the project id', () => {
    expect(bootstrapPassword(base.bootstrapSecret, base.projectId)).not.toContain('1111');
  });
});

describe('buildContainerSpec', () => {
  it('applies the memory cgroup limit and disables swap', () => {
    const s = buildContainerSpec(base);
    expect(s.HostConfig.Memory).toBe(512 * 1024 * 1024);
    // equal values mean no swap: a swapping tenant degrades its neighbours
    expect(s.HostConfig.MemorySwap).toBe(s.HostConfig.Memory);
  });
  it('applies a CPU limit in NanoCpus', () => {
    expect(buildContainerSpec(base).HostConfig.NanoCpus).toBe(500_000_000);
    expect(buildContainerSpec({ ...base, cpuLimit: 2 }).HostConfig.NanoCpus).toBe(2_000_000_000);
  });
  it('mounts the project volume at the data directory', () => {
    const m = buildContainerSpec(base).HostConfig.Mounts[0]!;
    expect(m).toEqual({ Type: 'volume', Source: base.volumeName, Target: '/var/lib/postgresql/data' });
  });
  it('binds the allocated host port to 5432', () => {
    expect(buildContainerSpec(base).HostConfig.PortBindings['5432/tcp'])
      .toEqual([{ HostPort: '5433' }]);
  });
  it('labels the container so the reconciler can find orphans', () => {
    expect(buildContainerSpec(base).Labels[LABEL_REF]).toBe(base.ref);
  });
  it('is created with no restart policy so a failed init cannot flap (D-184)', () => {
    expect(buildContainerSpec(base).HostConfig.RestartPolicy.Name).toBe('no');
  });
  it('accepts the policy the health gate promotes it to', () => {
    expect(buildContainerSpec({ ...base, restartPolicy: 'unless-stopped' })
      .HostConfig.RestartPolicy.Name).toBe('unless-stopped');
  });
  it('names containers by ref', () => {
    expect(containerName(base.ref)).toBe('cb-kxqwrtplmzensfba2345');
  });
  it('puts PGDATA in a subdirectory so the volume root is not the data dir', () => {
    // initdb refuses a non-empty directory; volume roots carry lost+found
    expect(buildContainerSpec(base).Env).toContain('PGDATA=/var/lib/postgresql/data/pgdata');
  });
});

/**
 * P2f — the walls D-055 asks for, all of them.
 *
 * Memory and CPU were there from day one. These assert the two that were not,
 * and that the free tier is the strict default rather than the lenient one.
 */
describe('noisy-neighbour walls (D-055)', () => {
  it('caps processes, so a fork bomb inside a tenant cannot exhaust the node', () => {
    expect(buildContainerSpec(base).HostConfig.PidsLimit).toBe(PIDS_LIMIT);
    // Has to clear max_connections (20) plus the postmaster and its auxiliaries.
    expect(PIDS_LIMIT).toBeGreaterThan(64);
  });

  it('caps the pooler processes too, lower — it is one single-threaded process', () => {
    const pooler = buildPoolerSpec({
      ref: base.ref, networkName: 'cb-x-net', hostPort: 6433, authPassword: 'pw',
    });
    expect(pooler.HostConfig.PidsLimit).toBe(64);
  });

  it('disables swap by pinning MemorySwap to Memory', () => {
    // A tenant that swaps degrades every neighbour on the node, and a memory
    // limit with swap left open is a limit that does not bite.
    const hc = buildContainerSpec(base).HostConfig;
    expect(hc.MemorySwap).toBe(hc.Memory);
  });

  it('gives the free tier a smaller I/O share than a paid one', () => {
    const w = (plan: string) =>
      buildContainerSpec({ ...base, plan, ioWeight: true }).HostConfig.BlkioWeight;
    expect(w('free')).toBe(PLAN_IO_WEIGHT['free']);
    expect(w('pro')).toBe(PLAN_IO_WEIGHT['pro']);
    expect(PLAN_IO_WEIGHT['free']!).toBeLessThan(PLAN_IO_WEIGHT['pro']!);
  });

  it('defaults an unknown or missing plan to the strictest weight, not the loosest', () => {
    expect(buildContainerSpec({ ...base, ioWeight: true }).HostConfig.BlkioWeight)
      .toBe(PLAN_IO_WEIGHT['free']);
    expect(buildContainerSpec({ ...base, plan: 'enterprise-plus-invented', ioWeight: true })
      .HostConfig.BlkioWeight).toBe(PLAN_IO_WEIGHT['free']);
  });

  it('omits the weight entirely on a kernel that has no io.weight', () => {
    // Not a degradation to "no weight": runc refuses to start a container whose
    // cgroup lacks the file, so an unconditional BlkioWeight turned every
    // provision on this node into
    //   openat2 /sys/fs/cgroup/docker/<id>/io.weight: no such file or directory
    // The wall meant to protect the neighbours took down the tenant instead.
    expect(buildContainerSpec(base).HostConfig).not.toHaveProperty('BlkioWeight');
    expect(buildContainerSpec({ ...base, ioWeight: false }).HostConfig)
      .not.toHaveProperty('BlkioWeight');
  });

  it('omits device I/O caps when no device is configured, rather than guessing one', () => {
    // Docker rejects a BlkioDeviceWriteBps entry naming something that is not a
    // block device on that node, so a guess turns into a provisioning failure
    // for every project — worse than an uncapped rate behind a working weight.
    expect(ioDeviceLimits('free', undefined)).toEqual({});
    expect(buildContainerSpec(base).HostConfig.BlkioDeviceWriteBps).toBeUndefined();
  });

  it('applies device caps to the free tier when the operator names the device', () => {
    const caps = ioDeviceLimits('free', '/dev/vda');
    expect(caps.BlkioDeviceReadBps).toEqual([{ Path: '/dev/vda', Rate: FREE_IO_BPS }]);
    expect(caps.BlkioDeviceWriteBps).toEqual([{ Path: '/dev/vda', Rate: FREE_IO_BPS }]);
    // Paid plans get the weight, not an absolute ceiling.
    expect(ioDeviceLimits('pro', '/dev/vda')).toEqual({});
  });
});
