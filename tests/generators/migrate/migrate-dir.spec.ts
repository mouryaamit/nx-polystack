import * as path from 'path';

import { logger, parseJson, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import envGenerator from '../../../src/generators/env/generator';
import migrateGenerator from '../../../src/generators/migrate/generator';

import { fixtureCopy, putJson, tmpSource } from './helpers';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/workspace',
      scripts: {},
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

describe('migrate --dir', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = workspace();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('imports an Angular CLI app into apps/legacy/portal', async () => {
    await migrateGenerator(tree, {
      source: fixtureCopy('angular15-app'),
      name: 'portal',
      dir: 'legacy',
    });
    expect(tree.exists('apps/portal')).toBe(false);
    const pj = readJson(tree, 'apps/legacy/portal/project.json');
    expect(pj.name).toBe('portal');
    expect(pj.$schema).toBe('../../../node_modules/nx/schemas/project-schema.json');
    expect(pj.targets.build.options.outputPath).toBe('dist/apps/legacy/portal');
    expect(pj.targets.release.options.outputPath).toBe('dist/apps/legacy/portal');
    expect(pj.targets.build.options.main).toBe('apps/legacy/portal/src/main.ts');
    expect(readJson(tree, 'apps/legacy/portal/tsconfig.json').extends).toBe(
      '../../../tsconfig.base.json',
    );
    expect(readJson(tree, 'apps/legacy/portal/.eslintrc.json').extends[0]).toBe(
      '../../../.eslintrc.json',
    );
    expect(tree.read('docs/migrations/portal.md', 'utf-8')).toContain(
      '- App: `portal` in `apps/legacy/portal`',
    );
  });

  it('imports an Ionic app with its own dist and webDir', async () => {
    await migrateGenerator(tree, {
      source: fixtureCopy('ionic7-app'),
      name: 'field-notes',
      dir: 'mobile',
    });
    const pj = readJson(tree, 'apps/mobile/field-notes/project.json');
    expect(pj.targets.release.options.outputPath).toBe('dist/apps/mobile/field-notes');
    expect(pj.targets['cap-sync'].options).toEqual({
      command: 'sync',
      webDir: 'dist/apps/mobile/field-notes',
    });
    const cap = tree.read('apps/mobile/field-notes/capacitor.config.ts', 'utf-8') as string;
    expect(cap).toContain("'../../../dist/apps/mobile/field-notes'");
  });

  it('imports a Flutter app with root-aware targets and env files', async () => {
    await migrateGenerator(tree, { source: fixtureCopy('flutter-app'), name: 'notes', dir: 'a/b' });
    const pj = readJson(tree, 'apps/a/b/notes/project.json');
    expect(pj.sourceRoot).toBe('apps/a/b/notes/lib');
    expect(pj.targets['build-web'].options.dist).toBe('dist/apps/a/b/notes/web');
    expect(tree.exists('apps/a/b/notes/env/dev.json')).toBe(true);
    expect(tree.exists('apps/notes')).toBe(false);
  });

  it('pstack env finds the nested apps', async () => {
    await migrateGenerator(tree, {
      source: fixtureCopy('angular15-app'),
      name: 'portal',
      dir: 'legacy',
    });
    await migrateGenerator(tree, {
      source: fixtureCopy('flutter-app'),
      name: 'notes',
      dir: 'legacy',
    });
    await envGenerator(tree, { all: true, name: 'qa' });
    expect(tree.exists('apps/legacy/notes/env/qa.json')).toBe(true);
    expect(
      readJson(tree, 'apps/legacy/portal/project.json').targets.build.configurations.qa,
    ).toBeDefined();
    const scripts = readJson(tree, 'package.json').scripts;
    expect(scripts['build:portal:qa']).toBeDefined();
    expect(scripts['build:notes:qa:web']).toBeDefined();
  });

  it('the LLM block lists the nested app', async () => {
    tree.write(
      'CLAUDE.md',
      '# CLAUDE.md\n\n<!-- nx-polystack:start -->\n<!-- nx-polystack:end -->\n',
    );
    await migrateGenerator(tree, {
      source: fixtureCopy('flutter-app'),
      name: 'notes',
      dir: 'legacy',
    });
    expect(tree.read('CLAUDE.md', 'utf-8')).toContain('`apps/legacy/notes`');
  });

  it('refuses a dir that goes through another project', async () => {
    tree.write('apps/web/project.json', JSON.stringify({ name: 'web' }));
    await expect(
      migrateGenerator(tree, { source: fixtureCopy('flutter-app'), name: 'notes', dir: 'web' }),
    ).rejects.toThrow('goes through the project in "apps/web"');
  });

  it('notes an old flat knip entry glob', async () => {
    tree.write('knip.json', JSON.stringify({ entry: ['apps/*/src/main.ts'] }, null, 2));
    await migrateGenerator(tree, {
      source: fixtureCopy('flutter-app'),
      name: 'notes',
      dir: 'legacy',
    });
    expect(tree.read('docs/migrations/notes.md', 'utf-8')).toContain('`apps/**/src/main.ts`');
  });

  it('rolls back cleanly', async () => {
    const before = treeState(tree);
    await migrateGenerator(tree, {
      source: fixtureCopy('angular15-app'),
      name: 'portal',
      dir: 'legacy',
    });
    await migrateGenerator(tree, { rollback: 'portal' });
    expect(treeState(tree)).toEqual(before);
  });

  it('is refused for workspace adapters, with --rollback and when malformed', async () => {
    await expect(
      migrateGenerator(tree, { source: fixtureCopy('nx16-workspace'), dir: 'legacy' }),
    ).rejects.toThrow(
      '--dir is for single-app sources; the nx-workspace adapter keeps the source layout.',
    );
    await expect(migrateGenerator(tree, { rollback: 'x', dir: 'legacy' })).rejects.toThrow(
      '--rollback takes only --force',
    );
    await expect(
      migrateGenerator(tree, { source: fixtureCopy('flutter-app'), dir: '../up' }),
    ).rejects.toThrow('--dir="../up" must be kebab-case folder names');
  });

  it('in a batch, workspace entries ignore an inherited dir and refuse their own', async () => {
    const dir = tmpSource('pstack-batch-');
    putJson(dir, 'ok.json', {
      defaults: { dir: 'legacy' },
      migrations: [
        { source: fixtureCopy('flutter-app'), name: 'notes' },
        { source: fixtureCopy('nx16-workspace'), name: 'nxrepo' },
      ],
    });
    await migrateGenerator(tree, { config: path.join(dir, 'ok.json') });
    expect(tree.exists('apps/legacy/notes/project.json')).toBe(true);
    expect(tree.exists('docs/migrations/nxrepo.md')).toBe(true);

    const other = workspace();
    putJson(dir, 'bad.json', {
      migrations: [{ source: fixtureCopy('nx16-workspace'), name: 'nxrepo', dir: 'legacy' }],
    });
    await expect(migrateGenerator(other, { config: path.join(dir, 'bad.json') })).rejects.toThrow(
      'entry 1',
    );
  });
});
