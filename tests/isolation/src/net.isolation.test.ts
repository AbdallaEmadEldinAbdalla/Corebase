import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setUp, tearDown, type Harness, type Fixture } from './harness.ts';

/**
 * Network and node isolation — the threat model's boundaries (c) and (d).
 *
 * These assume the worst case the whole baseline is designed for: **the Postgres
 * privilege fence has already failed and an attacker has code execution inside
 * A's container**. That is not pessimism, it is the premise of D-081 — the
 * container is the real isolation wall, and its job is to turn "code exec in the
 * database" into "code exec in a box that can reach nothing".
 *
 * So every probe here runs *inside* A's container, and each one asks a question
 * the attacker would ask: can I reach the metadata service, the co-tenant, the
 * node's control surface, the open internet?
 *
 * The reachability answers come from the connection itself — a bash `/dev/tcp`
 * redirect that either opens or does not. Nothing here reads a firewall rule or a
 * host-side log to decide, because a test that confirms a block by inspecting the
 * blocker proves only that the rule exists, not that it works.
 */
let h: Harness | undefined;
beforeAll(async () => { h = await setUp(); });
afterAll(async () => { await tearDown(h); });

const A = () => h!.a;
const B = () => h!.b;

/**
 * Attempts a TCP connection from inside a project's container.
 *
 * `bash`, not `sh`: `/dev/tcp` is a bash builtin and the image's `/bin/sh` is
 * dash, where the redirect is a syntax error — which fails for a reason that has
 * nothing to do with routing and reads exactly like a routing failure.
 */
async function reachable(f: Fixture, host: string, port: number): Promise<boolean> {
  const r = await h!.docker.execCapture(f.pg, ['bash', '-lc',
    `timeout 5 bash -c "exec 3<>/dev/tcp/${host}/${port}" >/dev/null 2>&1 && echo OPEN || echo SHUT`]);
  const out = r.stdout.trim();
  if (out !== 'OPEN' && out !== 'SHUT') {
    throw new Error(`the probe itself failed (exit ${r.exitCode}): ${r.stdout} ${r.stderr}`);
  }
  return out === 'OPEN';
}

/**
 * The WAL archive endpoint, from the file that configured the firewall.
 *
 * Deliberately fails loudly rather than defaulting: a missing file means the
 * allowlist was never applied, and a default would turn that into a confusing
 * connectivity failure instead of a clear setup one.
 */
function storeEndpoint(): { store: string; port: number } {
  const path = join(
    new URL('../../../', import.meta.url).pathname,
    'infra/docker/staging/backup-store.env');
  const text = readFileSync(path, 'utf8');
  const store = /^SH_BACKUP_S3_ENDPOINT=(.+)$/m.exec(text)?.[1]?.trim();
  const port = /^SH_BACKUP_S3_PORT=(.+)$/m.exec(text)?.[1]?.trim();
  if (!store) {
    throw new Error(`no SH_BACKUP_S3_ENDPOINT in ${path} — `
      + 'run ./scripts/staging.sh backup-store, then harden-egress.');
  }
  return { store, port: Number(port ?? 9000) };
}

/** B's container address, discovered host-side — setup, never an assertion. */
async function addressOf(f: Fixture): Promise<string> {
  const insp = await h!.docker.inspectContainer(f.pg) as unknown as {
    NetworkSettings: { Networks: Record<string, { IPAddress: string }> } };
  const ip = Object.values(insp.NetworkSettings.Networks)[0]?.IPAddress;
  if (!ip) throw new Error(`could not determine ${f.ref}'s container address`);
  return ip;
}

describe('NET-1 — the cloud metadata endpoint', () => {
  it('is unreachable from a tenant container', async () => {
    // 169.254.169.254 is one request away from cloud credentials on most
    // providers, which makes it the highest-value destination on this list.
    expect(await reachable(A(), '169.254.169.254', 80)).toBe(false);
  });
});

describe('NET-2 — the co-tenant', () => {
  it('cannot be addressed at all: A\'s container cannot reach B\'s Postgres', async () => {
    // The most direct expression of §74. DB-1 proved A's credentials do not open
    // B; this proves A cannot even open a socket to B, so the credential check is
    // the second line of defence rather than the only one.
    expect(await reachable(A(), await addressOf(B()), 5432)).toBe(false);
  });

  it('and A can reach its own database, so the block above is not a broken network', async () => {
    // The positive control. Without it, a container with no networking at all
    // passes every assertion in this file.
    expect(await reachable(A(), await addressOf(A()), 5432)).toBe(true);
  });
});

describe('NET-3 — the node\'s control surface', () => {
  it('has no Docker socket mounted', async () => {
    const r = await h!.docker.execCapture(A().pg, ['bash', '-lc',
      'test -S /var/run/docker.sock && echo PRESENT || echo ABSENT']);
    expect(r.stdout.trim()).toBe('ABSENT');
  });

  it('and the node\'s Engine API port is unreachable', async () => {
    // Reachability matters even though the API demands mutual TLS (D-052): the
    // Engine API is the control surface for every tenant on the box, so a tenant
    // that can *address* it is one stolen client certificate away from the fleet.
    // Defence in depth means the network says no before the certificate does.
    //
    // This was OPEN until P5e. The egress policy is what closes it.
    // The default gateway *is* the node, so this is how a tenant finds the
    // control surface — no guessing required, which is the point.
    //
    // Read from /proc/net/route and converted here rather than in the container.
    // Two earlier versions returned an empty string: `ip route` because the image
    // has no iproute2, then an awk one-liner because `strtonum` is a gawk
    // extension and the image ships mawk. Both would have made the reachability
    // check below probe nothing at all, and only the format assertion caught it —
    // which is the argument for asserting the *input* to a security check and not
    // just its outcome.
    const route = await h!.docker.execCapture(A().pg, ['bash', '-lc',
      `awk '$2 == "00000000" { print $3; exit }' /proc/net/route`]);
    const hex = route.stdout.trim();
    expect(hex).toMatch(/^[0-9A-Fa-f]{8}$/);
    // Little-endian, so the octets come back reversed.
    const nodeAddress = [6, 4, 2, 0]
      .map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
    expect(nodeAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(await reachable(A(), nodeAddress, 2376)).toBe(false);
  });
});

describe('NET-4 — arbitrary egress', () => {
  it('is denied by default, which is the half of D-081 that had never been built', async () => {
    // Exfiltration and mining are the two things a compromised tenant container
    // is actually used for, and both need outbound reach. This assertion failed
    // when it was first written — the internet was wide open from every project
    // container, and it was not recorded as a gap anywhere.
    expect(await reachable(A(), '1.1.1.1', 443)).toBe(false);
    expect(await reachable(A(), '8.8.8.8', 443)).toBe(false);
  });

  it('but the named allowlist still works, or the platform would be broken instead of secure', async () => {
    // A deny-all that also blocks WAL archiving is not a win: backups would fail
    // slowly and look like a backup bug. This is the counterpart assertion that
    // stops a future tightening from silently breaking durability.
    // Read from `backup-store.env` — the same file `staging.sh harden-egress`
    // built the allowlist from. An earlier version defaulted to a hardcoded
    // 172.18.0.3, which is this developer's compose address and not CI's: the
    // probe hit an address nothing listens on, was correctly dropped, and
    // reported the *platform* as broken. A test that hardcodes an address the
    // environment assigns is a test that fails somewhere it was never run.
    const { store, port } = storeEndpoint();
    expect(await reachable(A(), store, port)).toBe(true);
  });

  it('and DNS still resolves, or every hostname in the platform stops working', async () => {
    const r = await h!.docker.execCapture(A().pg, ['bash', '-lc',
      'getent hosts localhost >/dev/null && echo RESOLVES || echo BROKEN']);
    expect(r.stdout.trim()).toBe('RESOLVES');
  });
});
