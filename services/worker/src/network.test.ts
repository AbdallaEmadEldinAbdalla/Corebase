import { describe, it, expect } from 'vitest';
import { buildContainerSpec, networkName, containerName, DB_ALIAS } from './container-spec.ts';

/**
 * The project network (P2a). Unit-level: the naming and the spec it produces.
 * `network.e2e.test.ts` proves it against a real node.
 */
describe('P2a — the project network', () => {
  const args = {
    ref: 'abcdefghijklmnopqrst', projectId: 'p1', volumeName: 'v1',
    hostPort: 5433, ramLimitMb: 256, bootstrapSecret: 'a-sixteen-char-or-longer-secret',
  };

  it('derives one network per project, distinct from the container name', () => {
    expect(networkName('abcdefghijklmnopqrst')).toBe('cb-abcdefghijklmnopqrst-net');
    // A network and a container may not collide: Docker keeps separate namespaces,
    // but the operator reading `docker ps` and `docker network ls` does not.
    expect(networkName(args.ref)).not.toBe(containerName(args.ref));
  });

  it('joins the network at create time, with the alias the configs use', () => {
    const spec = buildContainerSpec({ ...args, networkName: networkName(args.ref) });
    const endpoints = spec.NetworkingConfig?.EndpointsConfig ?? {};
    expect(Object.keys(endpoints)).toEqual([networkName(args.ref)]);
    // `db` is what pgbouncer.ini and postgrest.conf say. If this alias moves,
    // every rendered config in the product has to move with it.
    expect(endpoints[networkName(args.ref)]?.Aliases).toEqual([DB_ALIAS]);
  });

  it('still publishes the host port — DIRECT_DATABASE_URL depends on it', () => {
    // The private network is for the pooler and PostgREST. A customer reaches
    // Postgres on the node's published port, and D-015 makes that a contract.
    const spec = buildContainerSpec({ ...args, networkName: networkName(args.ref) });
    expect(spec.HostConfig.PortBindings['5432/tcp']).toEqual([{ HostPort: '5433' }]);
  });

  it('omits the network entirely when none is given', () => {
    // The memory-store tests and any pre-Phase-2 path build specs without one;
    // an empty EndpointsConfig would make Docker attach to nothing rather than to
    // the default bridge, which is a different and worse behaviour.
    const spec = buildContainerSpec(args);
    expect(spec.NetworkingConfig).toBeUndefined();
  });
});
