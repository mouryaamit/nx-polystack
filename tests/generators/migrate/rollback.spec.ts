import { readJson, Tree, writeJson } from '@nx/devkit';
import { createTree } from '@nx/devkit/testing';

import {
  buildManifest,
  manifestPath,
  reportPath,
  rollbackNotesPath,
  writeManifest,
} from '../../../src/generators/migrate/rollback/manifest';
import { recordingTree } from '../../../src/generators/migrate/rollback/recording-tree';
import {
  formatRollbackSummary,
  rollbackMigration,
} from '../../../src/generators/migrate/rollback/rollback';

/** A tree, a "migration" applied through the recorder, and its manifest. */
function migrated(ionicApps: string[] = []): Tree {
  const base = createTree();
  writeJson(base, 'package.json', {
    dependencies: { keep: '1' },
    scripts: { lint: 'nx lint' },
    old: 'x',
  });
  base.write('README.md', 'old readme');
  base.write('docs/migrations/other.md', '# other');
  const { tree, originals } = recordingTree(base);
  tree.write('apps/a/main.ts', 'main');
  tree.write('apps/a/util.ts', 'util');
  writeJson(tree, 'package.json', {
    dependencies: { keep: '1', rxjs: '~7.8.0' },
    scripts: { lint: 'nx run-many -t lint', 'build:a': 'nx build a' },
    added: { nested: { deep: true } },
  });
  tree.write('README.md', 'new readme');
  tree.write(reportPath('a'), '# report');
  writeManifest(
    base,
    buildManifest(base, originals, {
      name: 'a',
      adapter: 'angular-cli',
      source: '../a',
      plugin: '0.13.0',
      ionicApps,
    }),
  );
  return base;
}

describe('rollbackMigration', () => {
  it('reverts everything unchanged since the run', () => {
    const tree = migrated();
    const r = rollbackMigration(tree, 'a', false);
    expect(tree.exists('apps/a/main.ts')).toBe(false);
    expect(readJson(tree, 'package.json')).toEqual({
      dependencies: { keep: '1' },
      scripts: { lint: 'nx lint' },
      old: 'x',
    });
    expect(tree.read('README.md', 'utf-8')).toBe('old readme');
    expect(tree.exists(reportPath('a'))).toBe(false);
    expect(tree.exists(manifestPath('a'))).toBe(false);
    expect(tree.exists(rollbackNotesPath('a'))).toBe(false);
    expect(tree.exists('docs/migrations/other.md')).toBe(true);
    expect(r).toEqual({
      name: 'a',
      complete: true,
      removed: ['apps/a/main.ts', 'apps/a/util.ts'],
      restored: ['README.md'],
      jsonFiles: ['package.json'],
      jsonReverted: 5,
      gone: [],
      kept: [],
      ionicApps: [],
    });
  });

  it('keeps edited files and values, lists them, keeps the manifest; --force finishes', () => {
    const tree = migrated();
    tree.write('apps/a/main.ts', 'mine');
    tree.delete('apps/a/util.ts');
    tree.write('README.md', 'my readme');
    writeJson(tree, 'package.json', {
      dependencies: { keep: '1', rxjs: '~7.8.1' },
      scripts: { lint: 'nx run-many -t lint', 'build:a': 'nx build a', mine: 'x' },
      added: { nested: { deep: true }, mine: 1 },
    });

    const r = rollbackMigration(tree, 'a', false);
    expect(r.complete).toBe(false);
    expect(r.gone).toEqual(['apps/a/util.ts']);
    expect(r.kept).toEqual([
      { path: 'apps/a/main.ts', what: 'created by the migration, edited since' },
      { path: 'package.json', what: '`dependencies.rxjs` changed since the migration' },
      { path: 'README.md', what: 'changed by the migration, edited since' },
    ]);
    expect(tree.read('apps/a/main.ts', 'utf-8')).toBe('mine');
    expect(readJson(tree, 'package.json')).toEqual({
      dependencies: { keep: '1', rxjs: '~7.8.1' },
      scripts: { lint: 'nx lint', mine: 'x' },
      added: { mine: 1 },
      old: 'x',
    });
    expect(tree.exists(reportPath('a'))).toBe(false);
    expect(tree.exists(manifestPath('a'))).toBe(true);
    const notes = tree.read(rollbackNotesPath('a'), 'utf-8') as string;
    expect(notes).toContain('- `apps/a/main.ts`: created by the migration, edited since');
    expect(notes).toContain('`pstack migrate --rollback=a --force`');

    // A rerun without --force changes nothing more; with --force it finishes.
    expect(rollbackMigration(tree, 'a', false).kept).toEqual(r.kept);
    const f = rollbackMigration(tree, 'a', true);
    expect(f.complete).toBe(true);
    expect(tree.exists('apps/a/main.ts')).toBe(false);
    expect(readJson(tree, 'package.json').dependencies).toEqual({ keep: '1' });
    expect(tree.read('README.md', 'utf-8')).toBe('old readme');
    expect(tree.exists(manifestPath('a'))).toBe(false);
    expect(tree.exists(rollbackNotesPath('a'))).toBe(false);
  });

  it('restores an unchanged JSON file byte for byte (comments and formatting kept)', () => {
    const base = createTree();
    const original = '{\n  // workspace paths\n  "compilerOptions": { "paths": {} }\n}\n';
    base.write('tsconfig.base.json', original);
    const { tree, originals } = recordingTree(base);
    writeJson(tree, 'tsconfig.base.json', { compilerOptions: { paths: { '@a/x': ['x'] } } });
    tree.write(reportPath('a'), '# report');
    writeManifest(
      base,
      buildManifest(base, originals, {
        name: 'a',
        adapter: 'angular-cli',
        source: '../a',
        plugin: '0.13.0',
        ionicApps: [],
      }),
    );
    const r = rollbackMigration(base, 'a', false);
    expect(base.read('tsconfig.base.json', 'utf-8')).toBe(original);
    expect(r.jsonReverted).toBe(1);
  });

  it('reverts array elements, keeping elements added later', () => {
    const base = createTree();
    writeJson(base, 'nx.json', { plugins: ['p1'] });
    const { tree, originals } = recordingTree(base);
    writeJson(tree, 'nx.json', { plugins: ['p1', 'a1', 'a2'] });
    tree.write(reportPath('a'), '# report');
    writeManifest(
      base,
      buildManifest(base, originals, {
        name: 'a',
        adapter: 'nx-workspace',
        source: '../a',
        plugin: '0.13.0',
        ionicApps: [],
      }),
    );
    writeJson(base, 'nx.json', { plugins: ['p1', 'a1', 'a2', 'b1'] });
    const r = rollbackMigration(base, 'a', false);
    expect(readJson(base, 'nx.json')).toEqual({ plugins: ['p1', 'b1'] });
    expect(r.kept).toEqual([]);
  });

  it('refuses a missing manifest and lists the reports', () => {
    const tree = migrated();
    expect(() => rollbackMigration(tree, 'b', false)).toThrow(
      'migrate: no manifest for "b" (docs/migrations/b.manifest.json): it was migrated before ' +
        'v0.13.0, or the name is wrong. Reports in docs/migrations: a, other.',
    );
  });

  it('summarises, with the npm install and Ionic node_modules notes', () => {
    const tree = migrated(['apps/a']);
    tree.write('apps/a/main.ts', 'mine');
    const out = formatRollbackSummary(rollbackMigration(tree, 'a', false));
    expect(out).toBe(
      [
        'Rolled back migration "a":',
        '- 1 file(s) removed',
        '- 1 file(s) restored',
        '- 5 JSON setting(s) reverted in 1 file(s)',
        'Kept because they changed after the migration (1):',
        '- apps/a/main.ts: created by the migration, edited since',
        'Listed in docs/migrations/a.rollback.md. To remove or restore them too: ' +
          'pstack migrate --rollback=a --force',
        'Run `npm install` to update node_modules.',
        'apps/a/node_modules and apps/a/package-lock.json (from its own npm install) are not removed.',
      ].join('\n'),
    );
  });
});
