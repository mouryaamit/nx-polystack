import { detectAll } from '../../../src/generators/migrate/adapters';
import { detectNpmWorkspaces } from '../../../src/generators/migrate/adapters/npm-workspaces';
import {
  classifyPackage,
  discoverPackages,
  expandWorkspaceGlobs,
  libEntry,
  packageManager,
  readPnpmWorkspace,
  resolveCatalogs,
  sourceWorkspaceGlobs,
  workspaceGlobs,
} from '../../../src/generators/migrate/npm-workspaces/source';

import { fixtureCopy, put, putJson, readJsonFile, tmpSource } from './helpers';

describe('npm/Yarn workspaces source', () => {
  it('reads both "workspaces" shapes', () => {
    expect(workspaceGlobs({ workspaces: ['packages/*', ''] })).toEqual(['packages/*']);
    expect(workspaceGlobs({ workspaces: { packages: ['apps/*'], nohoist: ['**/x'] } })).toEqual([
      'apps/*',
    ]);
    expect(workspaceGlobs({})).toBeUndefined();
    expect(workspaceGlobs({ workspaces: 'packages/*' })).toBeUndefined();
  });

  it('expands *, ** and literal globs, honours ! and skips node_modules', () => {
    const dir = tmpSource();
    for (const p of [
      'packages/a',
      'packages/b',
      'packages/node_modules/c',
      'apps/web',
      'apps/group/admin',
      'tools/cli',
    ]) {
      putJson(dir, `${p}/package.json`, { name: p.split('/').pop() });
    }
    put(dir, 'misc/no-package/readme.md', 'x');
    putJson(dir, 'packages/.hidden/package.json', {});
    expect(expandWorkspaceGlobs(dir, ['packages/*', '!packages/b'])).toEqual(['packages/a']);
    expect(expandWorkspaceGlobs(dir, ['apps/**'])).toEqual(['apps/group/admin', 'apps/web']);
    expect(expandWorkspaceGlobs(dir, ['./tools/cli/', 'misc/*', '../x'])).toEqual(['tools/cli']);
  });

  it('finds the library entry', () => {
    const dir = tmpSource();
    put(dir, 'a/src/index.ts', '');
    expect(libEntry(dir, 'a', { types: 'dist/index.d.ts' })).toBe('src/index.ts');
    put(dir, 'b/src/public-api.ts', '');
    expect(libEntry(dir, 'b', { typings: './lib/public-api.d.ts' })).toBe('src/public-api.ts');
    put(dir, 'c/main.ts', '');
    expect(libEntry(dir, 'c', { source: './main.ts' })).toBe('main.ts');
    putJson(dir, 'd/ng-package.json', { lib: { entryFile: 'src/api.ts' } });
    put(dir, 'd/src/api.ts', '');
    put(dir, 'd/src/index.ts', '');
    expect(libEntry(dir, 'd', {})).toBe('src/api.ts');
    put(dir, 'e/index.ts', '');
    expect(libEntry(dir, 'e', {})).toBe('index.ts');
    put(dir, 'f/index.js', '');
    expect(libEntry(dir, 'f', { main: 'index.js' } as never)).toBeUndefined();
  });

  it('classifies packages', () => {
    const dir = tmpSource();
    put(dir, 'lib/src/index.ts', '');
    expect(classifyPackage(dir, 'lib', {})).toEqual({ kind: 'lib', entry: 'src/index.ts' });
    put(dir, 'cli/src/index.ts', '');
    expect(classifyPackage(dir, 'cli', { bin: { x: 'bin/x.js' } }).kind).toBe('other');
    put(dir, 'ui/src/index.ts', '');
    expect(classifyPackage(dir, 'ui', { peerDependencies: { react: '^18.0.0' } }).kind).toBe(
      'other',
    );
    put(dir, 'api/src/index.ts', '');
    expect(classifyPackage(dir, 'api', { dependencies: { express: '^4.0.0' } }).kind).toBe('other');
  });

  it('discovers the fixture packages, their kinds and workspace dependencies', () => {
    const src = fixtureCopy('npm-workspace');
    const found = discoverPackages(src);
    expect(found.map((p) => [p.name, p.packageName, p.root, p.kind, p.entry, p.config])).toEqual([
      [
        'server',
        '@acme/server',
        'packages/server',
        'other',
        undefined,
        { implicitDependencies: ['utils'] },
      ],
      [
        'utils',
        '@acme/utils',
        'packages/utils',
        'lib',
        'src/index.ts',
        { implicitDependencies: [] },
      ],
      [
        'web',
        '@acme/web',
        'packages/web',
        'angular-app',
        undefined,
        { implicitDependencies: ['utils'] },
      ],
    ]);
  });

  it('classifies an Ionic app package and a package with two apps', () => {
    const src = fixtureCopy('npm-workspace');
    put(src, 'packages/web/capacitor.config.ts', 'export default {};');
    expect(discoverPackages(src).find((p) => p.name === 'web')?.kind).toBe('ionic-app');
    const ng = readJsonFile<{ projects: Record<string, unknown> }>(
      src,
      'packages/web/angular.json',
    );
    ng.projects['second'] = ng.projects['web'];
    putJson(src, 'packages/web/angular.json', ng);
    expect(discoverPackages(src).find((p) => p.name === 'web')?.kind).toBe('other');
  });

  it('names the package manager', () => {
    const src = fixtureCopy('npm-workspace');
    expect(packageManager(src)).toBe('npm');
    put(src, 'yarn.lock', '');
    expect(packageManager(src)).toBe('Yarn 1');
    const root = readJsonFile(src, 'package.json');
    putJson(src, 'package.json', { ...root, packageManager: 'yarn@4.1.0' });
    expect(packageManager(src)).toBe('Yarn Berry');
    putJson(src, 'package.json', { ...root, packageManager: 'yarn@1.22.19' });
    expect(packageManager(src)).toBe('Yarn 1');
    put(src, '.yarnrc.yml', 'nodeLinker: pnp\n');
    expect(packageManager(src)).toBe('Yarn Berry');
    putJson(src, 'package.json', { ...root, packageManager: 'pnpm@9.12.0' });
    expect(packageManager(src)).toBe('pnpm');
    const lock = fixtureCopy('npm-workspace');
    put(lock, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    expect(packageManager(lock)).toBe('pnpm');
  });

  describe('pnpm', () => {
    it('reads pnpm-workspace.yaml: packages, catalogs, overrides, patches, other keys', () => {
      const src = tmpSource();
      expect(readPnpmWorkspace(src)).toBeUndefined();
      put(
        src,
        'pnpm-workspace.yaml',
        [
          'packages:',
          '  - packages/*',
          'catalog:',
          '  rxjs: ~7.8.0',
          'catalogs:',
          '  default:',
          '    tslib: ^2.3.0',
          '  ng:',
          "    '@angular/core': ~15.2.0",
          'overrides:',
          '  lodash: 4.17.21',
          'patchedDependencies:',
          '  left-pad: patches/left-pad.patch',
          'onlyBuiltDependencies: [esbuild]',
        ].join('\n'),
      );
      expect(readPnpmWorkspace(src)).toEqual({
        packages: ['packages/*'],
        catalogs: {
          default: { tslib: '^2.3.0', rxjs: '~7.8.0' },
          ng: { '@angular/core': '~15.2.0' },
        },
        overrides: { lodash: '4.17.21' },
        patchedDependencies: { 'left-pad': 'patches/left-pad.patch' },
        otherKeys: ['onlyBuiltDependencies'],
      });
      put(src, 'pnpm-workspace.yaml', 'packages:\n  - a\n b\n');
      expect(() => readPnpmWorkspace(src)).toThrow(
        'migrate: cannot read pnpm-workspace.yaml (line 3',
      );
    });

    it('takes the globs from pnpm-workspace.yaml over package.json', () => {
      const src = tmpSource();
      putJson(src, 'package.json', { workspaces: ['legacy/*'] });
      expect(sourceWorkspaceGlobs(src)).toEqual(['legacy/*']);
      put(src, 'pnpm-workspace.yaml', "packages: ['packages/*']\n");
      expect(sourceWorkspaceGlobs(src)).toEqual(['packages/*']);
      put(src, 'pnpm-workspace.yaml', 'onlyBuiltDependencies: []\n');
      expect(sourceWorkspaceGlobs(src)).toBeUndefined();
    });

    it('resolves catalog: specs and lists the ones it cannot', () => {
      const catalogs = { default: { rxjs: '~7.8.0' }, ng: { '@angular/core': '~15.2.0' } };
      expect(
        resolveCatalogs(
          {
            dependencies: {
              rxjs: 'catalog:',
              '@angular/core': 'catalog:ng',
              tslib: 'catalog:default',
              zone: '~0.12.0',
            },
            devDependencies: { typescript: 'catalog:tools' },
          },
          catalogs,
        ),
      ).toEqual({
        pkg: {
          dependencies: {
            rxjs: '~7.8.0',
            '@angular/core': '~15.2.0',
            tslib: 'catalog:default',
            zone: '~0.12.0',
          },
          devDependencies: { typescript: 'catalog:tools' },
        },
        unresolved: ['tslib (catalog:default)', 'typescript (catalog:tools)'],
      });
      // peerDependencies are never merged: an unknown entry there is left as it is.
      expect(
        resolveCatalogs({ peerDependencies: { rxjs: 'catalog:x' } }, catalogs).unresolved,
      ).toEqual([]);
      expect(resolveCatalogs({ dependencies: { rxjs: 'catalog:' } }, {})).toEqual({
        pkg: { dependencies: { rxjs: 'catalog:' } },
        unresolved: ['rxjs (catalog:)'],
      });
    });
  });

  describe('detection', () => {
    it('is the best match for the fixture', () => {
      const rows = detectAll(fixtureCopy('npm-workspace'));
      expect(rows[0].adapter.id).toBe('npm-workspaces');
      expect(rows[0].confidence).toBe(0.95);
      expect(rows[0].reasons).toEqual([
        'npm workspaces with 3 packages: 1 angular-app, 1 lib, 1 other',
      ]);
    });

    it('leaves Nx and Angular roots to their adapters', () => {
      const nx = fixtureCopy('npm-workspace');
      putJson(nx, 'nx.json', {});
      expect(detectNpmWorkspaces(nx).confidence).toBe(0);
      // A pnpm-workspace.yaml the reader cannot read does not hide the Nx adapter's turn.
      put(nx, 'pnpm-workspace.yaml', 'packages: [a\n');
      expect(detectNpmWorkspaces(nx)).toEqual({
        confidence: 0,
        reasons: ['nx.json: the nx-workspace adapter handles it'],
      });
      const ng = fixtureCopy('npm-workspace');
      putJson(ng, 'angular.json', { projects: {} });
      expect(detectNpmWorkspaces(ng).confidence).toBe(0);
    });

    it('names pnpm, and is weak when pnpm-workspace.yaml is broken or lists no packages', () => {
      const src = fixtureCopy('npm-workspace');
      put(src, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
      expect(detectNpmWorkspaces(src).reasons).toEqual([
        'pnpm workspaces with 3 packages: 1 angular-app, 1 lib, 1 other',
      ]);
      put(src, 'pnpm-workspace.yaml', 'packages: [packages/*\n');
      expect(detectNpmWorkspaces(src)).toEqual({
        confidence: 0.3,
        reasons: ['cannot read pnpm-workspace.yaml (line 1: unclosed "[")'],
      });
      put(src, 'pnpm-workspace.yaml', 'catalog: {}\n');
      expect(detectNpmWorkspaces(src)).toEqual({
        confidence: 0.3,
        reasons: ['pnpm-workspace.yaml lists no `packages`'],
      });
    });

    it('is weak without packages or without a supported one', () => {
      const none = tmpSource();
      putJson(none, 'package.json', { workspaces: ['packages/*'] });
      expect(detectNpmWorkspaces(none)).toEqual({
        confidence: 0.3,
        reasons: ['npm workspaces, but no package folder matches packages/*'],
      });
      putJson(none, 'packages/api/package.json', { name: 'api', dependencies: { express: '4' } });
      expect(detectNpmWorkspaces(none).confidence).toBe(0.3);
      expect(detectNpmWorkspaces(tmpSource()).confidence).toBe(0);
    });
  });
});
