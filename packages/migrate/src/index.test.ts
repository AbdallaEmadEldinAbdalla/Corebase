import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFilename, checksum, loadMigrations, MigrationError } from './index.ts';

async function dirWith(files: Record<string, string>) {
  const d = await mkdtemp(join(tmpdir(), 'cb-mig-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(d, name), body);
  return d;
}

describe('parseFilename', () => {
  it('accepts <14-digit>_<snake_case>.sql', () => {
    expect(parseFilename('20260829120000_control_plane_init.sql'))
      .toEqual({ version: '20260829120000', name: 'control_plane_init' });
  });
  it('rejects a short timestamp, uppercase and spaces', () => {
    expect(parseFilename('202608_init.sql')).toBeNull();
    expect(parseFilename('20260829120000_Init.sql')).toBeNull();
    expect(parseFilename('20260829120000 init.sql')).toBeNull();
  });
});

describe('checksum', () => {
  it('is stable and content-sensitive', () => {
    expect(checksum('select 1;')).toBe(checksum('select 1;'));
    expect(checksum('select 1;')).not.toBe(checksum('select 2;'));
  });
  it('normalises CRLF so a Windows checkout is not read as drift', () => {
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'));
  });
});

describe('loadMigrations', () => {
  it('returns files in filename order regardless of directory order', async () => {
    const d = await dirWith({
      '20260829120001_second.sql': 'select 2;',
      '20260829120000_first.sql': 'select 1;',
    });
    const files = await loadMigrations(d);
    expect(files.map((f) => f.name)).toEqual(['first', 'second']);
  });

  it('refuses a badly named file rather than guessing its order', async () => {
    const d = await dirWith({ 'init.sql': 'select 1;' });
    await expect(loadMigrations(d)).rejects.toThrow(MigrationError);
  });

  it('refuses two migrations sharing a timestamp', async () => {
    const d = await dirWith({
      '20260829120000_a.sql': 'select 1;',
      '20260829120000_b.sql': 'select 2;',
    });
    await expect(loadMigrations(d)).rejects.toThrow(/share the timestamp/);
  });

  it('ignores non-sql files', async () => {
    const d = await dirWith({ '20260829120000_a.sql': 'select 1;', 'README.md': 'hi' });
    expect(await loadMigrations(d)).toHaveLength(1);
  });
});

describe('the real control-plane migration', () => {
  it('is discoverable and well-named', async () => {
    const files = await loadMigrations(new URL('../../../migrations', import.meta.url).pathname);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]!.name).toBe('control_plane_init');
  });
});
