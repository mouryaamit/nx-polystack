import * as fs from 'fs';
import * as path from 'path';

import { logger, parseJson, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';

import { FIXTURES, fixtureCopy, put, putJson, readJsonFile, snapshot } from './helpers';

type Pkg = Record<string, unknown> & { dependencies: Record<string, string> };

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({ name: '@ws/root', scripts: {}, devDependencies: { nx: '~17.0.6' } }),
  );
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
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

const WORKSPACE_YAML = [
  'packages:',
  "  - 'packages/*'",
  'catalog:',
  '  rxjs: ~7.8.0',
  '  date-fns: ^2.30.0',
  'catalogs:',
  '  ng15:',
  "    '@angular/core': ^15.2.0",
  'overrides:',
  '  semver: ^7.5.4',
  'onlyBuiltDependencies:',
  '  - esbuild',
  '',
].join('\n');

/** The fixture as a pnpm repo: pnpm-workspace.yaml with catalogs, workspace: and catalog: specs. */
function pnpmSource(): string {
  const src = fixtureCopy('npm-workspace');
  const root = readJsonFile<Pkg>(src, 'package.json');
  delete root['workspaces'];
  putJson(src, 'package.json', {
    ...root,
    packageManager: 'pnpm@9.12.0',
    pnpm: {
      overrides: {
        lodash: '4.17.21',
        '@scope/pkg': '1.2.3',
        'foo>bar': '1.0.0',
        'baz@<2': '2.0.0',
        qux: '-',
        '@acme/utils': 'workspace:*',
        vendored: 'link:./vendor/x',
        typescript: '4.9.5',
        nx: '17.0.7',
      },
      patchedDependencies: { 'left-pad@1.3.0': 'patches/left-pad@1.3.0.patch' },
      peerDependencyRules: { ignoreMissing: ['x'] },
    },
  });
  fs.rmSync(path.join(src, 'package-lock.json'));
  put(src, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  put(src, 'pnpm-workspace.yaml', WORKSPACE_YAML);
  put(src, '.npmrc', 'auto-install-peers=true\n');
  put(src, '.pnpmfile.cjs', 'module.exports = { hooks: {} };\n');
  const web = readJsonFile<Pkg>(src, 'packages/web/package.json');
  web.dependencies['@acme/utils'] = 'workspace:*';
  web.dependencies['@angular/core'] = 'catalog:ng15';
  web.dependencies['rxjs'] = 'catalog:';
  putJson(src, 'packages/web/package.json', web);
  const utils = readJsonFile<Pkg>(src, 'packages/utils/package.json');
  utils.dependencies['date-fns'] = 'catalog:default';
  putJson(src, 'packages/utils/package.json', utils);
  return src;
}

const report = (tree: Tree, name = 'acme-mono') =>
  tree.read(`docs/migrations/${name}.md`, 'utf8') as string;

describe('migrate generator: pnpm workspaces', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('imports the packages with catalog versions resolved and workspace: packages left out', async () => {
    const src = pnpmSource();
    const before = snapshot(src);
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(snapshot(src)).toEqual(before);

    expect(tree.exists('apps/web/src/main.ts')).toBe(true);
    expect(tree.exists('libs/utils/src/greet.ts')).toBe(true);
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/utils']).toEqual([
      'libs/utils/src/index.ts',
    ]);
    for (const f of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc', '.pnpmfile.cjs']) {
      expect(tree.exists(f)).toBe(false);
    }

    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('^15.2.0');
    expect(pkg.dependencies['rxjs']).toBe('~7.8.0');
    expect(pkg.dependencies['date-fns']).toBe('^2.30.0');
    expect(pkg.dependencies['@acme/utils']).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toMatch(/workspace:|catalog:/);
    expect(pkg.pnpm).toBeUndefined();
    expect(pkg.overrides).toEqual({
      '@scope/pkg': '1.2.3',
      lodash: '4.17.21',
      semver: '^7.5.4',
      typescript: '4.9.5',
    });

    const text = report(tree);
    expect(text).toContain('The source used pnpm workspaces.');
    expect(text).toContain('pnpm files (`pnpm-workspace.yaml`, `.pnpmfile.cjs`)');
    expect(text).toContain(
      'pnpm overrides became npm `overrides` in package.json: `@scope/pkg` → `1.2.3`, ' +
        '`lodash` → `4.17.21`, `semver` → `^7.5.4`, `typescript` → `4.9.5`.',
    );
    expect(text).toContain(
      'pnpm overrides not carried over automatically (selectors, version ranges, removals, local ' +
        'or workspace specs): `foo>bar`: `1.0.0`, `baz@<2`: `2.0.0`, `qux`: `-`, ' +
        '`@acme/utils`: `workspace:*`, `vendored`: `link:./vendor/x`.',
    );
    // typescript came in with the import (root devDependencies): it takes the override, as npm
    // refuses an override that differs from a direct dependency. nx is the workspace's own.
    expect(pkg.devDependencies['typescript']).toBe('4.9.5');
    expect(pkg.devDependencies['nx']).toBe('~17.0.6');
    expect(text).toContain(
      'also changed those dependencies (npm refuses an override that differs from a direct ' +
        'dependency): `typescript` `~4.9.4` → `4.9.5`.',
    );
    expect(text).toContain(
      'pnpm overrides not carried over because the workspace depends on the package directly at ' +
        'another version (npm would refuse the override): `nx` (workspace `~17.0.6`, override ' +
        '`17.0.7`).',
    );
    expect(text).toContain(
      'pnpm patches were not applied or copied: `left-pad@1.3.0` (`patches/left-pad@1.3.0.patch`).',
    );
    expect(text).toContain('The source `.pnpmfile.cjs` hooks did not run');
    expect(text).toContain('The source root `.npmrc` was not copied.');
    expect(text).toContain('its pnpm settings do not apply to npm.');
    expect(text).toContain(
      'pnpm settings not carried over: pnpm-workspace.yaml `onlyBuiltDependencies`, ' +
        'package.json `pnpm.peerDependencyRules`.',
    );
  });

  it('keeps workspace overrides and notes the ones that differ', async () => {
    const tree = workspace();
    const pkg = readJson(tree, 'package.json');
    tree.write(
      'package.json',
      JSON.stringify({ ...pkg, overrides: { lodash: '4.17.20', semver: '^7.5.4' } }),
    );
    await migrateGenerator(tree, { source: pnpmSource() });
    expect(readJson(tree, 'package.json').overrides).toEqual({
      '@scope/pkg': '1.2.3',
      lodash: '4.17.20',
      semver: '^7.5.4',
      typescript: '4.9.5',
    });
    expect(report(tree)).toContain(
      'pnpm overrides the workspace already overrides differently (kept): `lodash` (workspace ' +
        '`4.17.20`, source `4.17.21`).',
    );
  });

  it('refuses unknown catalog entries and an unreadable pnpm-workspace.yaml, writing nothing', async () => {
    const src = pnpmSource();
    const web = readJsonFile<Pkg>(src, 'packages/web/package.json');
    web.dependencies['zone.js'] = 'catalog:ng16';
    putJson(src, 'packages/web/package.json', web);
    const tree = workspace();
    const before = treeState(tree);
    await expect(migrateGenerator(tree, { source: src })).rejects.toThrow(
      '@acme/web uses catalog entries that no pnpm-workspace.yaml catalog defines: ' +
        'zone.js (catalog:ng16).',
    );
    expect(treeState(tree)).toEqual(before);
    // Only the selected packages count.
    await migrateGenerator(tree, { source: src, projects: 'utils' });
    expect(tree.exists('libs/utils/project.json')).toBe(true);

    const broken = pnpmSource();
    put(broken, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n catalog: x\n');
    const other = workspace();
    const otherBefore = treeState(other);
    await expect(
      migrateGenerator(other, { source: broken, adapter: 'npm-workspaces' }),
    ).rejects.toThrow('cannot read pnpm-workspace.yaml (line 3');
    expect(treeState(other)).toEqual(otherBefore);
  });

  it('refuses catalog specs in the root, or without any pnpm catalogs', async () => {
    const src = pnpmSource();
    const root = readJsonFile<Pkg>(src, 'package.json');
    putJson(src, 'package.json', {
      ...root,
      devDependencies: { ...(root['devDependencies'] as object), karma: 'catalog:test' },
    });
    await expect(migrateGenerator(workspace(), { source: src })).rejects.toThrow(
      'the source root package.json uses catalog entries that no pnpm-workspace.yaml catalog ' +
        'defines: karma (catalog:test).',
    );

    // An npm/Yarn repo (no pnpm-workspace.yaml, e.g. Yarn catalogs): nothing can resolve them.
    const npm = fixtureCopy('npm-workspace');
    const utils = readJsonFile<Pkg>(npm, 'packages/utils/package.json');
    utils.dependencies['date-fns'] = 'catalog:';
    utils['peerDependencies'] = { rxjs: 'catalog:' };
    putJson(npm, 'packages/utils/package.json', utils);
    await expect(migrateGenerator(workspace(), { source: npm })).rejects.toThrow(
      '@acme/utils uses catalog entries that no pnpm-workspace.yaml catalog defines: ' +
        'date-fns (catalog:). (Yarn catalogs are not read.)',
    );
  });

  it('resolves catalogs in an Nx workspace root package.json', async () => {
    const src = fixtureCopy('nx16-workspace');
    put(src, 'pnpm-workspace.yaml', "packages: ['apps/*', 'libs/*']\ncatalog:\n  rxjs: ~7.8.0\n");
    const root = readJsonFile<Pkg>(src, 'package.json');
    putJson(src, 'package.json', {
      ...root,
      dependencies: { ...root.dependencies, rxjs: 'catalog:' },
    });
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(readJson(tree, 'package.json').dependencies['rxjs']).toBe('~7.8.0');

    putJson(src, 'package.json', {
      ...root,
      dependencies: { ...root.dependencies, rxjs: 'catalog:other' },
    });
    await expect(migrateGenerator(workspace(), { source: src })).rejects.toThrow(
      'the source root package.json uses catalog entries that no pnpm-workspace.yaml catalog ' +
        'defines: rxjs (catalog:other).',
    );
  });

  it('names a broken pnpm-workspace.yaml in an Nx import, and refuses empty catalog entries', async () => {
    const src = fixtureCopy('nx16-workspace');
    put(src, 'pnpm-workspace.yaml', 'catalog:\n  rxjs: ~7.8.0\n bad: x\n');
    await expect(migrateGenerator(workspace(), { source: src })).rejects.toThrow(
      'cannot read pnpm-workspace.yaml (line 3',
    );

    const empty = pnpmSource();
    put(empty, 'pnpm-workspace.yaml', WORKSPACE_YAML.replace('rxjs: ~7.8.0', 'rxjs: null'));
    await expect(migrateGenerator(workspace(), { source: empty })).rejects.toThrow(
      'rxjs (catalog:)',
    );
  });

  it('resolves catalogs in an Ionic app package.json too', async () => {
    const src = pnpmSource();
    fs.cpSync(path.join(FIXTURES, 'ionic7-app'), path.join(src, 'packages/mobile'), {
      recursive: true,
    });
    const mobile = readJsonFile<Pkg>(src, 'packages/mobile/package.json');
    put(
      src,
      'pnpm-workspace.yaml',
      WORKSPACE_YAML.replace('catalog:\n', "catalog:\n  '@capacitor/app': 5.0.7\n"),
    );
    putJson(src, 'packages/mobile/package.json', {
      ...mobile,
      name: '@acme/mobile',
      dependencies: {
        ...mobile.dependencies,
        '@capacitor/app': 'catalog:',
        '@acme/utils': 'workspace:^',
      },
    });
    const tree = workspace();
    await migrateGenerator(tree, { source: src, projects: 'mobile' });
    const app = readJson(tree, 'apps/mobile/package.json');
    expect(app.dependencies['@capacitor/app']).toBe('5.0.7');
    expect(JSON.stringify(app)).not.toMatch(/workspace:|catalog:/);
    expect(JSON.stringify(readJson(tree, 'package.json'))).not.toMatch(/workspace:|catalog:/);
  });

  it('rolls back cleanly, overrides included', async () => {
    const tree = workspace();
    const before = treeState(tree);
    await migrateGenerator(tree, { source: pnpmSource() });
    await migrateGenerator(tree, { rollback: 'acme-mono' });
    expect(treeState(tree)).toEqual(before);
  });
});
