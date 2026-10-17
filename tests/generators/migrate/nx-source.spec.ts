import {
  classifyProject,
  discoverProjects,
  listProjectFiles,
  normalizeConfig,
  sourceNxVersion,
} from '../../../src/generators/migrate/nx/workspace-source';

import { fixtureCopy, put, putJson } from './helpers';

describe('Nx source discovery', () => {
  it('finds the project.json files and their kinds', () => {
    const src = fixtureCopy('nx16-workspace');
    const found = discoverProjects(src).map((p) => [p.name, p.root, p.kind, p.origin]);
    expect(found).toEqual([
      ['admin', 'apps/admin', 'angular-app', 'project.json'],
      ['dart-core', 'libs/dart_core', 'flutter-lib', 'project.json'],
      ['field', 'apps/field', 'ionic-app', 'project.json'],
      ['mobile', 'apps/mobile', 'flutter-app', 'project.json'],
      ['portal', 'apps/portal', 'angular-app', 'project.json'],
      ['portal-e2e', 'apps/portal-e2e', 'e2e', 'project.json'],
      ['shared-styles', 'libs/shared/styles', 'lib', 'project.json'],
      ['shared-ui', 'libs/shared/ui', 'lib', 'project.json'],
      ['shared-util', 'libs/shared/util', 'lib', 'project.json'],
    ]);
  });

  it('converts architect/builder to targets/executor', () => {
    expect(
      normalizeConfig({ root: 'x', architect: { lint: { builder: 'b:l', options: { a: 1 } } } }),
    ).toEqual({ root: 'x', targets: { lint: { executor: 'b:l', options: { a: 1 } } } });
  });

  it('names a project.json without a name like Nx does, and skips node_modules and dot folders', () => {
    const src = fixtureCopy('nx16-workspace');
    putJson(src, 'libs/feature/auth/project.json', { projectType: 'library' });
    putJson(src, 'libs/feature/Core/project.json', { projectType: 'library' });
    putJson(src, 'node_modules/pkg/project.json', { name: 'nope', projectType: 'library' });
    putJson(src, '.cache/project.json', { name: 'nope2', projectType: 'library' });
    const names = discoverProjects(src).map((p) => p.name);
    // Nx 16+: the folder name, lower-cased.
    expect(names).toContain('auth');
    expect(names).toContain('core');

    // Nx 15: the path under the apps/libs folders of workspaceLayout, "/" → "-".
    putJson(src, 'package.json', { devDependencies: { nx: '15.8.0' } });
    putJson(src, 'nx.json', { workspaceLayout: { libsDir: 'libs/feature' } });
    expect(discoverProjects(src).map((p) => p.name)).toEqual(
      expect.arrayContaining(['auth', 'core']),
    );
    putJson(src, 'nx.json', {});
    expect(discoverProjects(src).map((p) => p.name)).toEqual(
      expect.arrayContaining(['feature-auth', 'feature-core']),
    );
    expect(names).not.toContain('nope');
    expect(names).not.toContain('nope2');
  });

  it('reads angular.json projects in an Nx workspace and marks a root project', () => {
    const src = fixtureCopy('nx16-workspace');
    putJson(src, 'angular.json', {
      version: 1,
      projects: {
        legacy: {
          root: 'apps/legacy',
          projectType: 'application',
          architect: { build: { builder: '@angular-devkit/build-angular:browser' } },
        },
        top: { root: '', projectType: 'application', architect: {} },
      },
    });
    const byName = Object.fromEntries(discoverProjects(src).map((p) => [p.name, p]));
    expect(byName['legacy']).toMatchObject({ kind: 'angular-app', origin: 'angular.json' });
    expect(byName['top']).toMatchObject({ kind: 'root', root: '' });
  });

  it('classifies other shapes', () => {
    const src = fixtureCopy('nx16-workspace');
    const kind = (root: string, config: Record<string, unknown>) =>
      classifyProject(src, root, normalizeConfig(config));
    expect(
      kind('apps/new', {
        projectType: 'application',
        targets: { build: { executor: '@angular-devkit/build-angular:application' } },
      }),
    ).toBe('angular-app17');
    expect(
      kind('apps/api', {
        projectType: 'application',
        targets: { build: { executor: '@nx/webpack:webpack' } },
      }),
    ).toBe('other');
    expect(
      kind('libs/react-ui', {
        projectType: 'library',
        targets: { build: { executor: '@nx/rollup:rollup' } },
      }),
    ).toBe('lib');
    expect(
      kind('libs/custom', {
        projectType: 'library',
        targets: { build: { executor: '@acme/tools:pack' } },
      }),
    ).toBe('other');
    expect(
      kind('apps/fast', {
        projectType: 'application',
        targets: { build: { executor: '@angular-devkit/build-angular:browser-esbuild' } },
      }),
    ).toBe('angular-app');
    const angularBuild = { build: { executor: '@nx/angular:webpack-browser' } };
    // Ionic without Capacitor: a Cordova app, not supported.
    put(src, 'apps/shell/ionic.config.json', '{}');
    expect(kind('apps/shell', { projectType: 'application', targets: angularBuild })).toBe(
      'ionic-cordova',
    );
    // Capacitor (Ionic or not) with an Angular build.
    put(src, 'apps/shell/capacitor.config.json', '{}');
    expect(kind('apps/shell', { projectType: 'application', targets: angularBuild })).toBe(
      'ionic-app',
    );
    // Capacitor with the Angular 17+ application builder, or with a non-Angular build.
    expect(
      kind('apps/shell', {
        projectType: 'application',
        targets: { build: { executor: '@angular-devkit/build-angular:application' } },
      }),
    ).toBe('angular-app17');
    expect(
      kind('apps/shell', {
        projectType: 'application',
        targets: { build: { executor: '@nx/vite:build' } },
      }),
    ).toBe('other');
  });

  it('reads the Nx version', () => {
    expect(sourceNxVersion(fixtureCopy('nx16-workspace'))).toBe('16.10.0');
  });

  it('lists a project folder without node_modules, dist and dot folders', () => {
    const src = fixtureCopy('nx16-workspace');
    put(src, 'libs/shared/util/node_modules/x/index.js', '');
    put(src, 'libs/shared/util/dist/out.js', '');
    put(src, 'libs/shared/util/.cache/a', '');
    expect(listProjectFiles(src, 'libs/shared/util')).toEqual([
      '.eslintrc.json',
      'project.json',
      'src/index.ts',
      'tsconfig.json',
    ]);
  });

  it('uses only the projects a workspace.json lists, once per root', () => {
    const src = fixtureCopy('nx16-workspace');
    putJson(src, 'package.json', { devDependencies: { nx: '15.8.0' } });
    putJson(src, 'libs/shared/ui/project.json', { projectType: 'library', targets: {} });
    putJson(src, 'workspace.json', {
      version: 2,
      projects: {
        'ui-kit': 'libs/shared/ui',
        'ui-again': 'libs/shared/ui/',
        tokens: {
          root: 'libs/tokens',
          projectType: 'library',
          architect: { lint: { builder: '@nrwl/linter:eslint' } },
        },
      },
    });
    expect(discoverProjects(src).map((p) => [p.name, p.root, p.origin])).toEqual([
      ['tokens', 'libs/tokens', 'workspace.json'],
      ['ui-kit', 'libs/shared/ui', 'project.json'],
    ]);
  });
});
