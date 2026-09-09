/**
 * Regenerate `migrations/.checksums`.
 *
 * Run it when you **add** a migration. It will happily rewrite a line for a
 * migration you edited, which is the one thing the manifest exists to stop — so
 * read `immutable.test.ts` before reaching for this to make a failure go away.
 * Editing an applied migration breaks every database that already has it.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checksum, parseFilename } from './index.ts';

const dir = process.argv[2] ?? 'migrations';
const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
const lines: string[] = [];
for (const f of files) {
  if (!parseFilename(f)) throw new Error(`not a migration filename: ${f}`);
  lines.push(`${checksum(await readFile(join(dir, f), 'utf8'))}  ${f}`);
}
await writeFile(join(dir, '.checksums'), lines.join('\n') + '\n');
console.log(`wrote ${lines.length} checksums to ${join(dir, '.checksums')}`);
