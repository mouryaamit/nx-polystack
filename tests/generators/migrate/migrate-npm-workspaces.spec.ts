import * as fs from 'fs';
import * as path from 'path';

import { logger, parseJson, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';

import { FIXTURES, fixtureCopy, put, putJson, readJsonFile, snapshot } from './helpers';

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

/** The fixture as a Yarn 1 repo: `{ packages }`, workspace: specs, yarn.lock. */
function yarnSource(): string {
  const src = fixtureCopy('npm-workspace');
  const root = readJsonFile(src, 'package.json');
  putJson(src, 'package.json', { ...root, workspaces: { packages: ['packages/*'] } });
  fs.rmSync(path.join(src, 'package-lock.json'));
  put(src, 'yarn.lock', '# yarn lockfile v1\n');
  const web = readJsonFile<{ dependencies: Record<string, string> }>(
    src,
    'packages/web/package.json',
  );
  web.dependencies['@acme/utils'] = 'workspace:*';
  putJson(src, 'packages/web/package.json', web);
  return src;
}

const report = (tree: Tree, name = 'acme-mono') =>
  tree.read(`docs/migrations/${name}.md`, 'utf8') as string;

describe('migrate generator: Yarn / npm workspaces', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('imports the app to apps/, the library to libs/ with its package name as alias', async () => {
    const src = fixtureCopy('npm-workspace');
    const before = snapshot(src);
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(snapshot(src)).toEqual(before);

    expect(tree.exists('apps/web/src/main.ts')).toBe(true);
    expect(tree.exists('apps/web/package.json')).toBe(false);
    const web = readJson(tree, 'apps/web/project.json');
    expect(web.targets.build.options.outputPath).toBe('dist/apps/web');
    expect(web.targets.release).toBeDefined();
    expect(readJson(tree, 'apps/web/tsconfig.json').extends).toBe('../../tsconfig.base.json');
    // Env files go to environments/web/ like every polystack app's.
    expect(tree.exists('environments/web/environment.prod.ts')).toBe(true);
    expect(tree.exists('apps/web/src/environments/environment.prod.ts')).toBe(false);
    expect(web.targets.release.options.envProject).toBe('web');

    expect(tree.exists('libs/utils/src/greet.ts')).toBe(true);
    expect(tree.exists('libs/utils/package.json')).toBe(false);
    const utils = readJson(tree, 'libs/utils/project.json');
    expect(utils).toMatchObject({
      name: 'utils',
      projectType: 'library',
      sourceRoot: 'libs/utils/src',
      tags: ['scope:shared', 'type:lib'],
      targets: { lint: { options: { lintFilePatterns: ['libs/utils/**/*.ts'] } } },
    });
    expect(readJson(tree, 'libs/utils/tsconfig.json').extends).toBe('../../tsconfig.base.json');
    expect(readJson(tree, 'libs/utils/.eslintrc.json').extends).toEqual(['../../.eslintrc.json']);
    expect(tree.exists('apps/server')).toBe(false);
    expect(tree.exists('libs/server')).toBe(false);

    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/utils']).toEqual([
      'libs/utils/src/index.ts',
    ]);
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['date-fns']).toBe('^2.30.0');
    expect(pkg.dependencies['@angular/core']).toBeDefined();
    expect(pkg.devDependencies['@angular/cli']).toBe('~15.2.10');
    expect(pkg.dependencies['@acme/utils']).toBeUndefined();
    expect(pkg.dependencies['express']).toBeUndefined();
    expect(pkg.workspaces).toBeUndefined();
    expect(pkg.scripts['build:web:prod']).toBe('nx run web:release:prod');

    const r = report(tree);
    expect(r).toContain('- Adapter: `npm-workspaces`');
    expect(r).toContain(
      '| `utils` (source: `@acme/utils`) | lib         | `libs/utils` | selected |',
    );
    expect(r).toContain('| `@acme/server` | other | `packages/server` |');
    expect(r).toContain('The source used npm workspaces.');
    expect(r).toContain('`@acme/web: start`: `ng serve`');
    expect(r).toContain('`build`: `npm run build --workspaces`');
    expect(r).toContain('Not added: `@acme/utils` (packages of the source workspace');
    expect(r).toContain(
      'The source root `tsconfig.base.json` compilerOptions were not carried over',
    );
    expect(tree.exists('docs/migrations/acme-mono.manifest.json')).toBe(true);
  });

  it('imports a Yarn 1 repo with workspace: dependencies', async () => {
    const tree = workspace();
    await migrateGenerator(tree, { source: yarnSource() });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@acme/utils']).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain('workspace:');
    expect(report(tree)).toContain('The source used Yarn 1 workspaces.');
  });

  it('takes --projects by package or project name, with the packages they import', async () => {
    const tree = workspace();
    await migrateGenerator(tree, { source: fixtureCopy('npm-workspace'), projects: '@acme/web' });
    expect(tree.exists('apps/web/project.json')).toBe(true);
    expect(tree.exists('libs/utils/project.json')).toBe(true);
    expect(report(tree)).toContain(
      '| `utils` (source: `@acme/utils`) | lib         | `libs/utils` | needed by web |',
    );

    const only = workspace();
    await migrateGenerator(only, { source: fixtureCopy('npm-workspace'), projects: 'utils' });
    expect(only.exists('libs/utils/project.json')).toBe(true);
    expect(only.exists('apps/web')).toBe(false);
  });

  it('--no-deps leaves the library out and says so', async () => {
    const tree = workspace();
    await migrateGenerator(tree, {
      source: fixtureCopy('npm-workspace'),
      projects: 'web',
      noDeps: true,
    });
    expect(tree.exists('libs/utils')).toBe(false);
    expect(
      readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/utils'],
    ).toBeUndefined();
    expect(report(tree)).toContain(
      '`web` depends on workspace package `@acme/utils`, which was not imported.',
    );
  });

  it('--prefix renames the projects but keeps the package-name alias', async () => {
    const tree = workspace();
    await migrateGenerator(tree, { source: fixtureCopy('npm-workspace'), prefix: 'old' });
    expect(tree.exists('apps/old-web/project.json')).toBe(true);
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/utils']).toEqual([
      'libs/old-utils/src/index.ts',
    ]);
  });

  it('refuses unsupported, clashing and colliding imports, writing nothing', async () => {
    await expect(
      migrateGenerator(workspace(), {
        source: fixtureCopy('npm-workspace'),
        projects: '@acme/server',
      }),
    ).rejects.toThrow('"server" (other) cannot be migrated yet');

    const taken = workspace();
    taken.write('apps/web/project.json', JSON.stringify({ name: 'web' }));
    taken.write(
      'tsconfig.base.json',
      JSON.stringify({
        compilerOptions: { paths: { '@acme/utils': ['libs/shared/src/index.ts'] } },
      }),
    );
    const before = treeState(taken);
    const err = migrateGenerator(taken, { source: fixtureCopy('npm-workspace') });
    await expect(err).rejects.toThrow('`apps/web` already exists in the workspace');
    await expect(migrateGenerator(taken, { source: fixtureCopy('npm-workspace') })).rejects.toThrow(
      'the path alias "@acme/utils" maps to libs/shared/src/index.ts',
    );
    expect(treeState(taken)).toEqual(before);
  });

  it('imports an Ionic app package without the workspace packages in its package.json', async () => {
    const src = fixtureCopy('npm-workspace');
    fs.cpSync(path.join(FIXTURES, 'ionic7-app'), path.join(src, 'packages/mobile'), {
      recursive: true,
    });
    const mobile = readJsonFile<{ name: string; dependencies: Record<string, string> }>(
      src,
      'packages/mobile/package.json',
    );
    putJson(src, 'packages/mobile/package.json', {
      ...mobile,
      name: '@acme/mobile',
      dependencies: { ...mobile.dependencies, '@acme/utils': 'workspace:^' },
    });
    const tree = workspace();
    await migrateGenerator(tree, { source: src, projects: 'mobile' });
    expect(readJson(tree, 'apps/mobile/project.json').tags).toEqual([
      'scope:app',
      'type:app',
      'platform:mobile',
    ]);
    expect(readJson(tree, 'apps/mobile/package.json').dependencies['@acme/utils']).toBeUndefined();
    expect(readJson(tree, 'package.json').dependencies['@acme/utils']).toBeUndefined();
    expect(report(tree)).toContain('## Ionic');
  });

  it('notes differing library versions and subpath imports; rebases a lib ESLint config', async () => {
    const src = fixtureCopy('npm-workspace');
    const root = readJsonFile<{ devDependencies: Record<string, string> }>(src, 'package.json');
    putJson(src, 'package.json', {
      ...root,
      devDependencies: { ...root.devDependencies, 'date-fns': '^3.0.0' },
    });
    put(src, 'packages/web/src/app/extra.ts', "export { greet } from '@acme/utils/src/greet';\n");
    putJson(src, 'packages/utils/.eslintrc.json', { extends: ['../../.eslintrc.json'] });
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    const r = report(tree);
    expect(r).toContain(
      'Library packages declare other versions than the one carried over (the source root or ' +
        'the first package wins): `date-fns` (@acme/utils: `^2.30.0`).',
    );
    expect(r).toContain('`@acme/utils/src/greet`');
    expect(readJson(tree, 'libs/utils/.eslintrc.json')).toEqual({
      extends: ['../../.eslintrc.json'],
      ignorePatterns: ['!**/*'],
    });
  });

  it('writes the ts lib tsconfig pair for a library without one', async () => {
    const src = fixtureCopy('npm-workspace');
    fs.rmSync(path.join(src, 'packages/utils/tsconfig.json'));
    const tree = workspace();
    await migrateGenerator(tree, { source: src, projects: 'utils' });
    expect(readJson(tree, 'libs/utils/tsconfig.json').references).toEqual([
      { path: './tsconfig.lib.json' },
    ]);
    expect(readJson(tree, 'libs/utils/tsconfig.lib.json').compilerOptions.outDir).toBe(
      '../../dist/out-tsc',
    );
  });

  it('rolls back cleanly', async () => {
    const tree = workspace();
    const before = treeState(tree);
    await migrateGenerator(tree, { source: fixtureCopy('npm-workspace') });
    await migrateGenerator(tree, { rollback: 'acme-mono' });
    expect(treeState(tree)).toEqual(before);
  });

  it('names packages that share a short name after their scope', async () => {
    const src = fixtureCopy('npm-workspace');
    putJson(src, 'packages/utils2/package.json', { name: '@other/utils' });
    put(src, 'packages/utils2/src/index.ts', 'export const x = 1;\n');
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    const paths = readJson(tree, 'tsconfig.base.json').compilerOptions.paths;
    expect(paths['@acme/utils']).toEqual(['libs/acme-utils/src/index.ts']);
    expect(paths['@other/utils']).toEqual(['libs/other-utils/src/index.ts']);
  });

  it('takes the Angular versions from the app package, not the defaults', async () => {
    const src = fixtureCopy('npm-workspace');
    const web = readJsonFile<{ dependencies: Record<string, string> }>(
      src,
      'packages/web/package.json',
    );
    for (const k of Object.keys(web.dependencies)) {
      if (k.startsWith('@angular/')) web.dependencies[k] = '^16.2.0';
    }
    web.dependencies['rxjs'] = '~7.5.0';
    putJson(src, 'packages/web/package.json', web);
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('^16.2.0');
    expect(pkg.dependencies['rxjs']).toBe('~7.5.0');
    expect(report(tree)).not.toContain('--force-angular');
  });

  it("replaces an app's own tsconfig alias to a sibling package", async () => {
    const src = fixtureCopy('npm-workspace');
    const ts = readJsonFile<{ compilerOptions: Record<string, unknown> }>(
      src,
      'packages/web/tsconfig.json',
    );
    ts.compilerOptions['paths'] = { '@acme/utils': ['../utils/src/index.ts'] };
    putJson(src, 'packages/web/tsconfig.json', ts);
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/utils']).toEqual([
      'libs/utils/src/index.ts',
    ]);
  });

  it('moves local file: dependencies with their package', async () => {
    const src = fixtureCopy('npm-workspace');
    const utils = readJsonFile<{ dependencies: Record<string, string> }>(
      src,
      'packages/utils/package.json',
    );
    utils.dependencies['vendored'] = 'file:./vendor/vendored-1.0.0.tgz';
    putJson(src, 'packages/utils/package.json', utils);
    put(src, 'packages/utils/vendor/vendored-1.0.0.tgz', 'x');
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(readJson(tree, 'package.json').dependencies['vendored']).toBe(
      'file:libs/utils/vendor/vendored-1.0.0.tgz',
    );
    expect(tree.exists('libs/utils/vendor/vendored-1.0.0.tgz')).toBe(true);
  });

  it('honours the root .gitignore outside git and does not copy nested packages twice', async () => {
    const src = fixtureCopy('npm-workspace');
    put(src, '.gitignore', '*.log\n');
    put(src, 'packages/utils/debug.log', 'x');
    put(src, 'packages/web/build.log', 'x');
    const root = readJsonFile(src, 'package.json');
    putJson(src, 'package.json', { ...root, workspaces: ['packages/**'] });
    putJson(src, 'packages/utils/inner/package.json', { name: '@acme/inner' });
    put(src, 'packages/utils/inner/src/index.ts', 'export const inner = 1;\n');
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(tree.exists('libs/utils/debug.log')).toBe(false);
    expect(tree.exists('apps/web/build.log')).toBe(false);
    expect(tree.exists('libs/inner/src/index.ts')).toBe(true);
    expect(tree.exists('libs/utils/inner')).toBe(false);
  });

  it('does not let a config package block the import', async () => {
    const src = fixtureCopy('npm-workspace');
    putJson(src, 'packages/eslint-config/package.json', {
      name: '@acme/eslint-config',
      main: 'index.js',
    });
    put(src, 'packages/eslint-config/index.js', 'module.exports = {};\n');
    const utils = readJsonFile(src, 'packages/utils/package.json');
    putJson(src, 'packages/utils/package.json', {
      ...utils,
      devDependencies: { '@acme/eslint-config': '*' },
    });
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(tree.exists('libs/utils/project.json')).toBe(true);
    expect(report(tree)).toContain(
      '`utils` depends on workspace package `@acme/eslint-config`, which was not imported.',
    );
  });

  it('drops project references from a library tsconfig', async () => {
    const src = fixtureCopy('npm-workspace');
    const ts = readJsonFile(src, 'packages/utils/tsconfig.json');
    putJson(src, 'packages/utils/tsconfig.json', {
      ...ts,
      compilerOptions: { composite: true },
      references: [{ path: '../server' }],
    });
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    const lib = readJson(tree, 'libs/utils/tsconfig.json');
    expect(lib.references).toBeUndefined();
    expect(lib.compilerOptions.composite).toBeUndefined();
    expect(report(tree)).toContain('`utils`: `references`, `composite` removed from tsconfig.json');
  });

  it('names the whole import in a --max-files overflow during an app copy', async () => {
    await expect(
      migrateGenerator(workspace(), { source: fixtureCopy('npm-workspace'), maxFiles: 4 }),
    ).rejects.toThrow('the selected packages have more than 4 files to copy');
  });

  it('imports an Angular 17+ app package with the browser builder', async () => {
    const src = fixtureCopy('npm-workspace');
    const ng = readJsonFile<{
      projects: Record<string, { architect: Record<string, Record<string, unknown>> }>;
    }>(src, 'packages/web/angular.json');
    const build = ng.projects['web'].architect['build'];
    const { main, ...options } = build['options'] as Record<string, unknown>;
    ng.projects['web'].architect['build'] = {
      ...build,
      builder: '@angular/build:application',
      options: { ...options, browser: main, outputPath: { base: 'dist/web' } },
    };
    putJson(src, 'packages/web/angular.json', ng);
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    const web = readJson(tree, 'apps/web/project.json');
    expect(web.targets.build.executor).toBe('@angular-devkit/build-angular:browser');
    expect(web.targets.build.options).toMatchObject({
      main: 'apps/web/src/main.ts',
      outputPath: 'dist/apps/web',
    });
    expect(report(tree)).toContain('`web` target "build": @angular/build:application became');
  });

  it('leaves a server-rendered app package out', async () => {
    const src = fixtureCopy('npm-workspace');
    const ng = readJsonFile<{
      projects: Record<string, { architect: Record<string, Record<string, unknown>> }>;
    }>(src, 'packages/web/angular.json');
    const build = ng.projects['web'].architect['build'];
    ng.projects['web'].architect['build'] = {
      ...build,
      builder: '@angular/build:application',
      options: { ...(build['options'] as object), server: 'src/main.server.ts' },
    };
    putJson(src, 'packages/web/angular.json', ng);
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(tree.exists('apps/web')).toBe(false);
    expect(report(tree)).toMatch(/\|\s*`@acme\/web`\s*\|\s*angular-ssr\s*\|/);
  });
});
