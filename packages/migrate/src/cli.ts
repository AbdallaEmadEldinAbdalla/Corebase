#!/usr/bin/env node
import { Client } from 'pg';
import { runMigrations } from './index.ts';

const url = process.env.CB_CONTROL_DATABASE_URL;
if (!url) {
  console.error('CB_CONTROL_DATABASE_URL is not set.');
  process.exit(2);
}
const dir = process.argv[2] ?? 'migrations';
const client = new Client({ connectionString: url });
await client.connect();
try {
  const r = await runMigrations(client, dir, { logger: (m) => console.log(m) });
  console.log(`applied ${r.applied.length}, already present ${r.skipped.length}`);
} catch (err) {
  console.error(String((err as Error).message));
  process.exit(1);
} finally {
  await client.end();
}
