import { describe, it, expect } from 'vitest';
import {
  buildPoolerSpec, poolerName, networkName, containerName,
  POOLER_ALIAS, POOLER_PORT, LABEL_ROLE, LABEL_REF,
} from './container-spec.ts';

const REF = 'abcdefghijklmnopqrst';
const spec = () => buildPoolerSpec({
  ref: REF, networkName: networkName(REF), hostPort: 6433, authPassword: 'pool-secret',
});

describe('P2b — the pooler container spec', () => {
  it('is a second container, named apart from the database', () => {
    expect(poolerName(REF)).toBe('sh-abcdefghijklmnopqrst-pooler');
    expect(poolerName(REF)).not.toBe(containerName(REF));
  });

  it('labels which of the project two containers it is', () => {
    // Reconciliation and the purge now reason about two containers per project.
    // Reading a role label beats parsing a name suffix.
    expect(spec().Labels[LABEL_ROLE]).toBe('pooler');
    expect(spec().Labels[LABEL_REF]).toBe(REF);
  });

  it('joins the project network under the pooler alias', () => {
    const endpoints = spec().NetworkingConfig?.EndpointsConfig ?? {};
    expect(endpoints[networkName(REF)]?.Aliases).toEqual([POOLER_ALIAS]);
  });

  it('publishes 6432 on the allocated host port', () => {
    // Placement allocates from a range the node publishes; an unpublished port is
    // a pooler the health gate cannot reach and a DATABASE_URL that cannot connect.
    expect(spec().HostConfig.PortBindings[`${POOLER_PORT}/tcp`]).toEqual([{ HostPort: '6433' }]);
  });

  it('carries exactly one secret, and it is the pooler credential', () => {
    // D-074: the pooler holds pgbouncer_auth's password and nothing else. It
    // resolves nothing on its own — the lookup function returns `developer` only.
    const env = spec().Env;
    expect(env).toEqual(['PGBOUNCER_AUTH_PASSWORD=pool-secret']);
  });

  it('starts with no restart policy, like the database (D-184)', () => {
    // A pooler that cannot reach its database would otherwise flap forever behind
    // a permanent "restarting" state, hiding the actual failure.
    expect(spec().HostConfig.RestartPolicy).toEqual({ Name: 'no' });
  });

  it('is sized to what a single-threaded pooler can use', () => {
    // The cost model books ~10–20 MiB RSS per pooler. A generous CPU allowance
    // would reserve capacity PgBouncer cannot use, and the booking is what the
    // density model is built on.
    const s = spec();
    expect(s.HostConfig.Memory).toBe(64 * 1024 * 1024);
    expect(s.HostConfig.MemorySwap).toBe(s.HostConfig.Memory);   // no swapping
    expect(s.HostConfig.NanoCpus).toBe(250_000_000);             // 0.25 cores
  });

  it('mounts nothing', () => {
    // The pooler is stateless: config is rendered at start from the environment,
    // so there is no volume to leak, back up, or purge.
    expect(spec().HostConfig.Mounts).toEqual([]);
  });
});
