import { describe, it, expect } from 'vitest';
import { buildContainerSpec, bootstrapPassword, containerName, LABEL_REF } from './container-spec.ts';

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
