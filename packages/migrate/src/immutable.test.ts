import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checksum, parseFilename } from './index.ts';

/**
 * A committed migration is immutable, and this is what enforces it.
 *
 * The runner already refuses to apply a migration whose contents changed since it
 * was applied — rule 3 in `index.ts`. That check is correct and it is also too
 * late: it fires on whoever next runs `migrate` against an existing database, as a
 * failure that looks like their problem, and because it exits non-zero it takes
 * every *later* migration down with it. Nothing at all fires in CI, where a fresh
 * database applies the edited file happily.
 *
 * That gap was not hypothetical. The brand rename edited five applied migrations
 * and the credential-prefix rename (D-433) edited a sixth again; the second one
 * was found only when `migrate-staging.sh` exited 1 during an unrelated step, six
 * commits later. It survived a `refactor` and a `fix` whose message said "the
 * migration change is comment-only; no schema is affected" — true of the schema,
 * false of the runner — because the verification for both ran against a database
 * that had been migrated after the edit. A fresh database cannot tell you that you
 * changed history.
 *
 * So the repo records the checksums itself. The repo cannot know what is applied
 * on any particular database, so it enforces the stricter rule it *can* know:
 * once a migration is committed, its bytes are fixed. To add a migration, add its
 * line. To change one, you may not — write a new migration, which is what the
 * runner's own error message says.
 *
 * To **add** a migration, regenerate the manifest:
 * `pnpm --filter @steadhold/migrate checksums`. That command will also cheerfully
 * rewrite the line for a migration you *edited*, which is the one thing this file
 * exists to stop — so if it is the thing making a failure here go away, the failure
 * was right.
 *
 * `COMMENT ON` exists for the case that motivated all this: prose about a column
 * that may need to change later belongs in the database as metadata, not in a
 * comment inside a file that can never be edited again.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '../../../migrations');
const MANIFEST = join(DIR, '.checksums');

/** `<sha256>  <filename>` per line — the format `sha256sum` prints. */
async function manifest(): Promise<Map<string, string>> {
  const text = await readFile(MANIFEST, 'utf8');
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [sum, name] = line.split(/\s+/);
    out.set(name!, sum!);
  }
  return out;
}

async function onDisk(): Promise<Map<string, string>> {
  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
  const out = new Map<string, string>();
  for (const f of files) out.set(f, checksum(await readFile(join(DIR, f), 'utf8')));
  return out;
}

describe('committed migrations are immutable', () => {
  it('every migration on disk still hashes to its recorded checksum', async () => {
    const recorded = await manifest();
    const actual = await onDisk();

    const changed: string[] = [];
    for (const [name, sum] of actual) {
      const was = recorded.get(name);
      // A file absent from the manifest is a *new* migration, which the next test
      // covers. Only a file that is present and different is history being edited.
      if (was !== undefined && was !== sum) changed.push(name);
    }

    expect(changed, changed.length === 0 ? '' :
      'These committed migrations were edited:\n  ' + changed.join('\n  ') +
      '\n\nApplied migrations are immutable — the runner will refuse to apply them\n' +
      'to any database that already has them, and because it exits non-zero it\n' +
      'blocks every later migration too. Add a NEW migration instead. Prose about\n' +
      'a column belongs in `COMMENT ON`, which a later migration can replace.\n' +
      'If you are genuinely un-committing one, delete its manifest line as well.',
    ).toEqual([]);
  });

  it('the manifest lists exactly the migrations that exist', async () => {
    const recorded = await manifest();
    const actual = await onDisk();

    // A new migration with no line would otherwise be free to change until
    // someone remembered to add it — which is the same hole one step along.
    const unlisted = [...actual.keys()].filter((f) => !recorded.has(f));
    // And a line with no file hides a deletion, which is history being edited by
    // removal rather than by change.
    const missing = [...recorded.keys()].filter((f) => !actual.has(f));

    expect({ unlisted, missing }).toEqual({ unlisted: [], missing: [] });
  });

  it('checksums are of normalised content, so a CRLF checkout is not drift', () => {
    // The manifest is only trustworthy if it survives the trip through another
    // platform's git config. `checksum` normalises; this states that it must.
    expect(checksum('CREATE TABLE t ();\r\n')).toBe(checksum('CREATE TABLE t ();\n'));
  });

  it('every listed file is a well-formed migration name', async () => {
    for (const name of (await manifest()).keys()) {
      expect(parseFilename(name), name).not.toBeNull();
    }
  });
});
