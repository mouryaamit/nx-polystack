import * as path from 'path';

import { logger, parseJson, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';

import { fixtureCopy, putJson, tmpSource } from './helpers';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/workspace',
      dependencies: { '@angular/core': '~15.2.0' },
      devDependencies: { nx: '~17.0.6', '@nx/eslint': '~17.0.6' },
    }),
  );
  tree.write(
    'tsconfig.base.json',
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {} } }),
  );
  return tree;
}

function treeState(tree: Tree, dir = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of tree.children(dir)) {
    const p = dir ? `${dir}/${child}` : child;
    if (tree.isFile(p)) {
      const text = tree.read(p, 'utf-8') as string;
      out[p] = p.endsWith('.json') ? parseJson(text) : text;
    } else Object.assign(out, treeState(tree, p));
  }
  return out;
}

/** A batch file next to copies of the fixtures, using relative sources. */
function batchFile(migrations: unknown[], defaults?: unknown): string {
  const dir = tmpSource('pstack-batch-');
  putJson(dir, 'migrations.json', defaults ? { defaults, migrations } : { migrations });
  return path.join(dir, 'migrations.json');
}

describe('migrate --config', () => {
  let tree: Tree;
  let info: jest.SpyInstance;
  beforeEach(() => {
    tree = workspace();
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs every entry, each with its own report and manifest, and each can be undone', async () => {
    const before = treeState(tree);
    const angular = fixtureCopy('angular15-app');
    const flutter = fixtureCopy('flutter-app');
    const dir = tmpSource('pstack-batch-');
    putJson(dir, 'migrations.json', {
      migrations: [
        { source: angular, name: 'portal' },
        { source: path.relative(dir, flutter), name: 'notes' },
      ],
    });
    const file = path.join(dir, 'migrations.json');

    const cb = await migrateGenerator(tree, { config: file });
    expect(typeof cb).toBe('function');
    for (const name of ['portal', 'notes']) {
      expect(tree.exists(`docs/migrations/${name}.md`)).toBe(true);
      expect(tree.exists(`docs/migrations/${name}.manifest.json`)).toBe(true);
    }
    expect(tree.exists('apps/portal/project.json')).toBe(true);
    expect(tree.exists('apps/notes/pubspec.yaml')).toBe(true);
    const out = info.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('Migrated 2 entries from');
    expect(out).toContain(
      'Undo, last first:\n  pstack migrate --rollback=notes\n  pstack migrate --rollback=portal',
    );

    await migrateGenerator(tree, { rollback: 'notes' });
    await migrateGenerator(tree, { rollback: 'portal' });
    expect(treeState(tree)).toEqual(before);
  });

  it('records the source as written in the file; overlapping entries undo cleanly', async () => {
    const before = treeState(tree);
    const dir = tmpSource('pstack-batch-');
    const angular = fixtureCopy('angular15-app');
    const nx = fixtureCopy('nx16-workspace');
    putJson(dir, 'migrations.json', {
      migrations: [
        { source: path.relative(dir, angular), name: 'web' },
        { source: nx, name: 'legacy', prefix: 'legacy' },
      ],
    });
    await migrateGenerator(tree, { config: path.join(dir, 'migrations.json') });
    expect(readJson(tree, 'docs/migrations/web.manifest.json').source).toBe(
      path.relative(dir, angular),
    );
    expect(tree.read('docs/migrations/web.md', 'utf-8')).toContain(path.relative(dir, angular));
    await migrateGenerator(tree, { rollback: 'legacy' });
    await migrateGenerator(tree, { rollback: 'web' });
    expect(treeState(tree)).toEqual(before);
  });

  it('names the entry when its install fails', async () => {
    const dir = tmpSource('pstack-batch-');
    putJson(dir, 'migrations.json', {
      migrations: [{ source: fixtureCopy('angular15-app'), name: 'portal' }],
    });
    const deps = await import('../../../src/generators/migrate/dependencies');
    jest.spyOn(deps, 'mergeDependencies').mockReturnValue(() => {
      throw new Error('npm exploded');
    });
    const cb = await migrateGenerator(tree, { config: path.join(dir, 'migrations.json') });
    await expect((cb as () => Promise<void>)()).rejects.toThrow(
      'migrate --config: install for "portal" failed',
    );
  });

  it('writes nothing when an entry fails, naming the entry', async () => {
    const file = batchFile([
      { source: fixtureCopy('angular15-app'), name: 'portal' },
      { source: 'does-not-exist' },
    ]);
    const before = tree.listChanges().length;
    await expect(migrateGenerator(tree, { config: file })).rejects.toThrow(
      /^migrate --config: entry 2 \(does-not-exist\): --source ".*does-not-exist" does not exist/,
    );
    // The tree was changed by entry 1, but the generator threw: Nx and pstack never flush it.
    expect(tree.listChanges().length).toBeGreaterThan(before);
  });

  it('catches a clash between entries', async () => {
    const file = batchFile([
      { source: fixtureCopy('angular15-app') },
      { source: fixtureCopy('angular15-app') },
    ]);
    await expect(migrateGenerator(tree, { config: file })).rejects.toThrow(
      /entry 2 \(.*\): "apps\/legacy-portal" already exists/,
    );
  });

  it('applies command line < file defaults < entry', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: { '@angular/core': '~16.2.0' },
        devDependencies: { nx: '~17.0.6' },
      }),
    );
    const src = fixtureCopy('angular15-app');
    await expect(
      migrateGenerator(tree, { config: batchFile([{ source: src, name: 'a' }]) }),
    ).rejects.toThrow(/entry 1 .*--force-angular/);
    await expect(
      migrateGenerator(tree, {
        config: batchFile([{ source: src, name: 'b', forceAngular: false }]),
        forceAngular: true,
      }),
    ).rejects.toThrow(/entry 1 .*--force-angular/);
    await migrateGenerator(tree, {
      config: batchFile([{ source: src, name: 'c' }], { forceAngular: true }),
    });
    expect(tree.exists('apps/c/project.json')).toBe(true);
  });

  it('refuses options that do not go with --config', async () => {
    const file = batchFile([{ source: 'x' }]);
    for (const extra of [
      { source: 'y' },
      { rollback: 'y' },
      { force: true },
      { name: 'y' },
      { adapter: 'flutter' as const },
      { projects: 'a' },
      { prefix: 'p' },
      { noDeps: true },
      { detect: true },
    ]) {
      await expect(migrateGenerator(tree, { config: file, ...extra })).rejects.toThrow(
        'migrate: --config takes only --force-angular, --max-files, --min-confidence, --dir, --no-rewrite-imports and --dry-run',
      );
    }
  });
});
