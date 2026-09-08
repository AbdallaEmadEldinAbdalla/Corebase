import { describe, it, expect } from 'vitest';
import { buildSagas, type SagaStep, type SagaContext } from './jobs/sagas.ts';

/**
 * Rules about which steps a saga must contain, as opposed to what any one step
 * does. They need no infrastructure — a saga's composition is a property of the
 * code — and they catch the class of bug that has now happened twice in the same
 * saga for the same reason.
 *
 * `resume_project` rebuilds the project's Postgres container: pause removes it,
 * resume starts a new one. Anything provisioning wrote **into the container
 * filesystem** is therefore gone, and only what lives on the mounted volume
 * (`/var/lib/postgresql/data`) survives. That was missed once for PostgREST — the
 * saga's own comment records it, "a resumed project has a database and a pooler
 * and no data API" — and then again for pgbackrest, whose config lives at
 * `/etc/pgbackrest/pgbackrest.conf` and is not on the volume.
 *
 * The second one was far worse than the first, because nothing a customer or the
 * dashboard touches fails: the project came back READY with `archive_command`
 * failing on every WAL segment, backups failing `[037] backup command requires
 * option: pg1-path`, the D-078 gate refusing to let it ever be *deleted*, and the
 * next pause dead-lettering after five attempts. A silent stop to backups is the
 * worst failure mode this system has.
 *
 * So the rule is stated once, over every saga, rather than spot-checked on the
 * one that broke: **a saga that starts a Postgres container has to configure that
 * container.** A future saga that moves or rebuilds a project inherits the rule
 * without anybody remembering it.
 */
const sagas = buildSagas({
  pool: {} as never, docker: {} as never, secrets: {} as never, bootstrapSecret: 'x'.repeat(32),
});

const stepNames = (kind: string): string[] =>
  (sagas[kind] as SagaStep<SagaContext>[]).map((s) => s.name);

/** Everything provisioning writes inside the container, not on the volume. */
const CONTAINER_SETUP = ['configure_backups'];

describe('a saga that starts a Postgres container configures it', () => {
  const kinds = Object.keys(sagas).filter((k) => stepNames(k).includes('start_container'));

  it('finds the sagas this applies to', () => {
    // If this list ever empties, the rule below has silently stopped applying —
    // a guard that matches nothing passes forever.
    expect(kinds.length, 'no saga starts a container, which cannot be right')
      .toBeGreaterThanOrEqual(2);
    expect(kinds).toContain('resume_project');
  });

  for (const kind of ['provision_project', 'resume_project']) {
    it(`${kind} configures the container it starts`, () => {
      const names = stepNames(kind);
      expect(names, `${kind} does not start a container`).toContain('start_container');
      for (const required of CONTAINER_SETUP) {
        expect(names,
          `${kind} starts a Postgres container but never runs ${required}. Anything `
          + `written into the container filesystem — pgbackrest's conf at `
          + `/etc/pgbackrest/pgbackrest.conf — does not survive, because only `
          + `/var/lib/postgresql/data is a volume.`,
        ).toContain(required);
      }
    });

    it(`${kind} configures backups before it starts serving traffic`, () => {
      // Ordering, not just presence: WAL accumulates from the moment Postgres is
      // healthy, and archiving is what stops the node filling up. Configuring it
      // after the pooler and the data API are live means a window where the
      // project takes writes it cannot archive.
      const names = stepNames(kind);
      const conf = names.indexOf('configure_backups');
      const serving = ['start_pooler', 'start_postgrest']
        .map((n) => names.indexOf(n)).filter((i) => i >= 0);
      for (const i of serving) {
        expect(conf, `${kind} runs configure_backups after ${names[i]}`).toBeLessThan(i);
      }
    });
  }

  it('every container-starting saga waits for health before configuring', () => {
    // `configure_backups` execs into the container and talks to Postgres, so it
    // cannot run before the health gate.
    for (const kind of kinds) {
      const names = stepNames(kind);
      const conf = names.indexOf('configure_backups');
      const healthy = names.indexOf('wait_healthy');
      if (conf < 0 || healthy < 0) continue;
      expect(conf, `${kind} configures backups before the container is healthy`)
        .toBeGreaterThan(healthy);
    }
  });
});
