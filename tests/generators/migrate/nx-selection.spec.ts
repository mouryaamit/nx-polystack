import {
  directDependencies,
  importSpecifiers,
  readSourceAliases,
  resolveAlias,
  selectProjects,
} from '../../../src/generators/migrate/nx/selection';
import { discoverProjects } from '../../../src/generators/migrate/nx/workspace-source';

import { fixtureCopy, putJson, readJsonFile } from './helpers';

const why = (m: Map<string, string[]>) => Object.fromEntries(m);

describe('aliases and imports', () => {
  it('reads tsconfig.base.json paths relative to baseUrl', () => {
    expect(readSourceAliases(fixtureCopy('nx16-workspace'))['@acme/shared-ui']).toEqual([
      'libs/shared/ui/src/index.ts',
    ]);
  });

  it('resolves exact and wildcard aliases (longest prefix wins)', () => {
    const aliases = {
      '@a/x': ['libs/x/src/index.ts'],
      '@a/*': ['libs/*'],
      '@a/feature/*': ['libs/feature/*/src/index.ts'],
    };
    expect(resolveAlias('@a/x', aliases)).toEqual(['libs/x/src/index.ts']);
    expect(resolveAlias('@a/feature/auth', aliases)).toEqual(['libs/feature/auth/src/index.ts']);
    expect(resolveAlias('@a/util/date', aliases)).toEqual(['libs/util/date']);
    expect(resolveAlias('rxjs', aliases)).toEqual([]);
  });

  it('collects import, export, dynamic import and require specifiers', () => {
    const text = [
      "import { a } from '@a/one';",
      'export * from "@a/two";',
      "import '@a/side';",
      "const m = import('@a/lazy');",
      "const r = require('@a/req');",
      "import x from './local';",
    ].join('\n');
    expect(importSpecifiers(text)).toEqual([
      './local',
      '@a/lazy',
      '@a/one',
      '@a/req',
      '@a/side',
      '@a/two',
    ]);
  });
});

describe('closure', () => {
  it('follows imports, implicit dependencies and pubspec path dependencies', () => {
    const src = fixtureCopy('nx16-workspace');
    const projects = discoverProjects(src);
    const aliases = readSourceAliases(src);
    const of = (n: string) => projects.find((p) => p.name === n)!;
    expect(directDependencies(src, of('portal'), projects, aliases)).toEqual([
      'shared-styles',
      'shared-ui',
      'shared-util',
    ]);
    expect(directDependencies(src, of('shared-ui'), projects, aliases)).toEqual([]);
    expect(directDependencies(src, of('mobile'), projects, aliases)).toEqual(['dart-core']);
  });

  it('defaults to every supported project', () => {
    const src = fixtureCopy('nx16-workspace');
    const chosen = selectProjects({
      sourceDir: src,
      projects: discoverProjects(src),
      noDeps: false,
    });
    expect([...chosen.keys()].sort()).toEqual([
      'admin',
      'dart-core',
      'field',
      'mobile',
      'portal',
      'shared-styles',
      'shared-ui',
      'shared-util',
    ]);
    expect(chosen.get('shared-util')).toEqual([]);
  });

  it('adds what --projects need, and records who needs them', () => {
    const src = fixtureCopy('nx16-workspace');
    const chosen = selectProjects({
      sourceDir: src,
      projects: discoverProjects(src),
      requested: ['portal', 'admin'],
      noDeps: false,
    });
    expect(why(chosen)).toEqual({
      portal: [],
      admin: [],
      'shared-styles': ['portal'],
      'shared-ui': ['portal'],
      'shared-util': ['admin', 'portal'],
    });
  });

  it('--no-deps takes only the named projects', () => {
    const src = fixtureCopy('nx16-workspace');
    const chosen = selectProjects({
      sourceDir: src,
      projects: discoverProjects(src),
      requested: ['portal'],
      noDeps: true,
    });
    expect([...chosen.keys()]).toEqual(['portal']);
  });

  it('fails on unknown and unsupported --projects', () => {
    const src = fixtureCopy('nx16-workspace');
    const projects = discoverProjects(src);
    expect(() =>
      selectProjects({ sourceDir: src, projects, requested: ['nope'], noDeps: false }),
    ).toThrow(/unknown project "nope" in --projects\. Projects in the source: admin, dart-core/);
    expect(() =>
      selectProjects({ sourceDir: src, projects, requested: ['portal-e2e'], noDeps: false }),
    ).toThrow('"portal-e2e" (e2e) cannot be migrated yet');
  });

  it('fails when a needed project cannot be migrated', () => {
    const src = fixtureCopy('nx16-workspace');
    const pj = readJsonFile<Record<string, unknown>>(src, 'libs/shared/util/project.json');
    putJson(src, 'libs/shared/util/project.json', { ...pj, implicitDependencies: ['portal-e2e'] });
    expect(() =>
      selectProjects({
        sourceDir: src,
        projects: discoverProjects(src),
        requested: ['admin'],
        noDeps: false,
      }),
    ).toThrow(
      '"portal-e2e" (e2e) is needed by shared-util but cannot be migrated yet. Pass --no-deps to ' +
        'copy only the projects you name (their imports of it will not resolve).',
    );
  });
});
