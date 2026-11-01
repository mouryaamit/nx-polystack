import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';

import { fixtureCopy, snapshot } from './helpers';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/workspace',
      scripts: { lint: 'nx run-many -t lint' },
      devDependencies: { nx: '~17.0.6', '@nx/eslint': '~17.0.6' },
    }),
  );
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  return tree;
}

const report = (tree: Tree) => tree.read('docs/migrations/legacy.md', 'utf8') as string;

describe('migrate generator: Nx 14 workspace.json source', () => {
  let tree: Tree;
  let src: string;

  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    src = fixtureCopy('nx14-workspace');
    tree = workspace();
  });
  afterEach(() => jest.restoreAllMocks());

  it('brings the workspace.json app and lib in with @nx executors', async () => {
    const before = snapshot(src);
    await migrateGenerator(tree, { source: src, name: 'legacy' });
    expect(snapshot(src)).toEqual(before);

    const shop = readJson(tree, 'apps/shop/project.json');
    expect(shop.name).toBe('shop');
    expect(shop.targets.build.executor).toBe('@nx/angular:webpack-browser');
    expect(shop.targets.serve.executor).toBe('@nx/angular:webpack-dev-server');
    expect(shop.targets.lint.executor).toBe('@nx/eslint:lint');
    expect(shop.implicitDependencies).toEqual(['ui']);
    const ui = readJson(tree, 'libs/ui/project.json');
    expect(ui.name).toBe('ui');
    expect(ui.targets.test.executor).toBe('@nx/jest:jest');
    expect(ui.targets.lint.executor).toBe('@nx/eslint:lint');

    // workspace.json and the Nx 14 nx.json keys stay behind.
    expect(tree.exists('workspace.json')).toBe(false);
    const nx = readJson(tree, 'nx.json');
    expect(nx.npmScope).toBeUndefined();
    expect(nx.implicitDependencies).toBeUndefined();

    expect(JSON.stringify(readJson(tree, 'apps/shop/.eslintrc.json'))).toContain(
      'plugin:@nx/angular',
    );
    expect(JSON.stringify(readJson(tree, 'libs/ui/.eslintrc.json'))).not.toContain('@nrwl/');
    expect(tree.read('jest.preset.js', 'utf8')).toContain('@nx/jest/preset');
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toMatchObject({
      '@acme/ui': ['libs/ui/src/index.ts'],
    });

    const r = report(tree);
    expect(r).toContain('Detection: nx.json, Nx 14.8.6; projects: 1 angular-app, 1 lib');
    expect(r).toContain('The source used Nx 14.8.6; the workspace has Nx ~17.0.6');
    expect(r).toContain('The source used Jest 28.1.3');
  });

  it('takes Angular 14 from the source and adds the release target', async () => {
    await migrateGenerator(tree, { source: src, name: 'legacy' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('~14.2.12');
    expect(pkg.devDependencies['@nx/angular']).toBe('~17.0.6');
    expect(pkg.devDependencies['@nrwl/angular']).toBeUndefined();
    expect(pkg.devDependencies['nx']).toBe('~17.0.6');
    expect(pkg.scripts).toMatchObject({
      lint: 'nx run-many -t lint',
      start: 'nx serve shop',
      'build:shop:prod': 'nx run shop:release:prod',
    });

    const release = readJson(tree, 'apps/shop/project.json').targets.release;
    expect(release.executor).toBe('@mouryaamit/nx-polystack:build');
    expect(release.options).toMatchObject({ envProject: 'shop', buildTarget: 'shop:build' });
    expect(release.configurations.prod.buildConfiguration).toBe('production');
    expect(report(tree)).toContain('The workspace had no Angular; the source');
  });

  it('renames projects in target references, implicitDependencies and scripts with --prefix', async () => {
    await migrateGenerator(tree, { source: src, name: 'legacy', prefix: 'old' });
    const shop = readJson(tree, 'apps/shop/project.json');
    expect(shop.name).toBe('old-shop');
    expect(shop.implicitDependencies).toEqual(['old-ui']);
    expect(shop.targets.serve.configurations.production.browserTarget).toBe(
      'old-shop:build:production',
    );
    expect(shop.targets.release.options.buildTarget).toBe('old-shop:build');
    expect(readJson(tree, 'libs/ui/project.json').name).toBe('old-ui');
    expect(readJson(tree, 'package.json').scripts).toMatchObject({
      start: 'nx serve old-shop',
      test: 'nx test old-ui',
    });
  });

  it('refuses an Angular 15 workspace', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: { '@angular/core': '~15.2.10' },
        devDependencies: { nx: '~17.0.6' },
      }),
    );
    await expect(migrateGenerator(tree, { source: src, name: 'legacy' })).rejects.toThrow(
      'the workspace uses Angular 15',
    );
  });

  it('rolls back cleanly', async () => {
    const pristine = workspace();
    await migrateGenerator(tree, { source: src, name: 'legacy' });
    await migrateGenerator(tree, { rollback: 'legacy' });
    for (const gone of ['apps/shop', 'libs/ui', 'jest.preset.js']) {
      expect(tree.exists(gone)).toBe(false);
    }
    expect(readJson(tree, 'package.json')).toEqual(readJson(pristine, 'package.json'));
  });
});
