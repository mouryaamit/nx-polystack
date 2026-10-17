import * as fs from 'fs';
import * as path from 'path';

import { MigrationEntry, runMigrations, selectMigrations } from '../../src/cli/migrations';

const manifest = {
  generators: {
    'b-later': { version: '0.4.0', description: 'B', implementation: './src/migrations/b/b' },
    'a-first': { version: '0.3.0', description: 'A', implementation: './src/migrations/a/a' },
    'c-same': { version: '0.3.0', description: 'C', implementation: './src/migrations/c/c' },
    old: { version: '0.2.2', implementation: './src/migrations/old/old' },
    future: { version: '0.5.0', implementation: './src/migrations/f/f' },
    broken: { version: '0.3.0' },
  },
};

describe('selectMigrations', () => {
  it('selects from < version <= to, sorted by version then name', () => {
    expect(selectMigrations(manifest, '0.2.2', '0.4.0').map((m) => m.name)).toEqual([
      'a-first',
      'c-same',
      'b-later',
    ]);
  });

  it('skips entries without an implementation and ignores a legacy factory key', () => {
    const picked = selectMigrations(
      {
        generators: {
          ...manifest.generators,
          legacy: { version: '0.3.0', factory: './x' } as never,
        },
      },
      '0.2.2',
      '0.3.0',
    );
    expect(picked.map((m) => m.name)).not.toContain('broken');
    expect(picked.map((m) => m.name)).not.toContain('legacy');
    expect(picked.find((m) => m.name === 'c-same')?.implementation).toBe('./src/migrations/c/c');
  });

  it('returns [] for an empty manifest', () => {
    expect(selectMigrations({ generators: {} }, '0.2.2', '0.3.0')).toEqual([]);
    expect(selectMigrations({}, '0.2.2', '0.3.0')).toEqual([]);
  });
});

describe('runMigrations', () => {
  const entries: MigrationEntry[] = [
    { name: 'one', version: '0.3.0', implementation: 'x' },
    { name: 'two', version: '0.3.0', implementation: 'y' },
    { name: 'three', version: '0.3.0', implementation: 'z' },
  ];

  it('runs all in order', async () => {
    const seen: string[] = [];
    const r = await runMigrations(entries, async (e) => {
      seen.push(e.name);
    });
    expect(seen).toEqual(['one', 'two', 'three']);
    expect(r).toEqual({ applied: ['one', 'two', 'three'] });
  });

  it('stops at the first failure', async () => {
    const seen: string[] = [];
    const r = await runMigrations(entries, async (e) => {
      seen.push(e.name);
      if (e.name === 'two') throw new Error('boom');
    });
    expect(seen).toEqual(['one', 'two']);
    expect(r).toEqual({ applied: ['one'], failed: { name: 'two', error: 'boom' } });
  });
});

describe('real migrations.json', () => {
  it('selects add-executor-peers for 0.2.2 → 0.3.0', () => {
    const real = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'migrations.json'), 'utf8'),
    );
    expect(selectMigrations(real, '0.2.2', '0.3.0').map((m) => m.name)).toEqual([
      'add-executor-peers',
    ]);
  });

  it('selects angular-release-target for 0.3.2 → 0.4.0', () => {
    const real = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'migrations.json'), 'utf8'),
    );
    expect(selectMigrations(real, '0.3.2', '0.4.0').map((m) => m.name)).toEqual([
      'angular-release-target',
    ]);
    expect(selectMigrations(real, '0.4.0', '0.4.1').map((m) => m.name)).toEqual([
      'add-lint-dependencies',
    ]);
    expect(selectMigrations(real, '0.9.0', '0.9.1').map((m) => m.name)).toEqual([
      'prepush-audit-warn-only',
    ]);
    expect(selectMigrations(real, '0.18.0', '0.18.1').map((m) => m.name)).toEqual([
      'add-lint-staged-config',
    ]);
    expect(selectMigrations(real, '0.27.1', '0.28.0').map((m) => m.name)).toEqual([
      'env-encryption-key-sources',
    ]);
    expect(selectMigrations(real, '0.28.0', '0.29.0').map((m) => m.name)).toEqual([
      'release-hardening',
    ]);
  });
});
