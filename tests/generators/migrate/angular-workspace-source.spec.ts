import * as fs from 'fs';

import { aliasesToSource } from '../../../src/generators/migrate/angular-workspace/aliases';
import {
  discoverAngularProjects,
  libraryInfo,
} from '../../../src/generators/migrate/angular-workspace/source';
import { readSourceAliases, selectProjects } from '../../../src/generators/migrate/nx/selection';

import { fixtureCopy, put, putJson } from './helpers';

describe('angular.json discovery', () => {
  it('lists projects with kinds', () => {
    const src = fixtureCopy('angular15-workspace');
    expect(discoverAngularProjects(src).map((p) => [p.name, p.root, p.kind, p.origin])).toEqual([
      ['admin', 'projects/admin', 'angular-app', 'angular.json'],
      ['portal', '', 'angular-app', 'angular.json'],
      ['portal-e2e', 'e2e', 'e2e', 'angular.json'],
      ['ui-core', 'projects/ui-core', 'lib', 'angular.json'],
      ['ui-kit', 'projects/ui-kit', 'lib', 'angular.json'],
    ]);
  });

  it('classifies Capacitor apps, application builders and others', () => {
    const src = fixtureCopy('angular15-workspace');
    put(src, 'projects/admin/capacitor.config.json', '{}');
    const ws = JSON.parse(fs.readFileSync(`${src}/angular.json`, 'utf8'));
    ws.projects['next'] = {
      projectType: 'application',
      root: 'projects/next',
      architect: { build: { builder: '@angular-devkit/build-angular:application' } },
    };
    ws.projects['tool'] = { projectType: 'application', root: 'projects/tool', architect: {} };
    ws.projects['ssr'] = {
      projectType: 'application',
      root: 'projects/ssr',
      architect: {
        build: {
          builder: '@angular/build:application',
          options: {
            browser: 'projects/ssr/src/main.ts',
            server: 'projects/ssr/src/main.server.ts',
          },
        },
      },
    };
    put(src, 'projects/mobile/capacitor.config.ts', 'export default {};');
    ws.projects['mobile'] = {
      projectType: 'application',
      root: 'projects/mobile',
      architect: { build: { builder: '@angular/build:application', options: {} } },
    };
    putJson(src, 'angular.json', ws);
    const kinds = Object.fromEntries(discoverAngularProjects(src).map((p) => [p.name, p.kind]));
    put(src, 'projects/tool/config.xml', '<widget/>');
    ws.projects['tool'] = {
      projectType: 'application',
      root: 'projects/tool',
      architect: { build: { builder: '@angular-devkit/build-angular:browser' } },
    };
    putJson(src, 'angular.json', ws);
    expect(
      Object.fromEntries(discoverAngularProjects(src).map((p) => [p.name, p.kind])),
    ).toMatchObject({ tool: 'ionic-cordova' });
    expect(kinds).toMatchObject({
      admin: 'ionic-app',
      next: 'angular-app',
      ssr: 'angular-ssr',
      mobile: 'ionic-app',
      tool: 'other',
    });
  });

  it('reads a library entry file and build outputs', () => {
    const src = fixtureCopy('angular15-workspace');
    const ui = discoverAngularProjects(src).find((p) => p.name === 'ui-kit')!;
    expect(libraryInfo(src, ui)).toMatchObject({
      ngPackage: 'projects/ui-kit/ng-package.json',
      entryFile: 'src/public-api.ts',
      outputs: ['dist/ui-kit'],
    });
    put(src, 'projects/ui-kit/testing/ng-package.json', '{ "lib": { "entryFile": "index.ts" } }');
    expect(libraryInfo(src, ui).secondaryEntry('testing')).toBe('index.ts');
    expect(libraryInfo(src, ui).secondaryEntry('forms')).toBe('src/public-api.ts');
  });

  it('returns [] without angular.json', () => {
    expect(discoverAngularProjects(fixtureCopy('flutter-app'))).toEqual([]);
  });
});

describe('closure in an Angular CLI workspace', () => {
  const select = (src: string, requested: string[]) => {
    const projects = discoverAngularProjects(src);
    const libs = projects
      .filter((p) => p.kind === 'lib')
      .map((p) => ({ root: p.root, ...libraryInfo(src, p) }));
    return selectProjects({
      sourceDir: src,
      projects,
      requested,
      noDeps: false,
      aliases: aliasesToSource(readSourceAliases(src), libs),
    });
  };

  it('follows dist aliases to the library', () => {
    const src = fixtureCopy('angular15-workspace');
    expect(Object.fromEntries(select(src, ['portal']))).toEqual({
      portal: [],
      'ui-kit': ['portal'],
      'ui-core': ['ui-kit'],
    });
  });

  it('does not give a root app the imports of the projects nested under it', () => {
    const src = fixtureCopy('angular15-workspace');
    put(src, 'src/app/app.module.ts', 'export class AppModule {}\n');
    put(src, 'projects/admin/src/kit.ts', "export * from 'ui-kit';\n");
    expect([...select(src, ['portal']).keys()]).toEqual(['portal']);
    expect([...select(src, ['admin']).keys()].sort()).toEqual(['admin', 'ui-core', 'ui-kit']);
  });
});
