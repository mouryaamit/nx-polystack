import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { detectAll } from '../../../src/generators/migrate/adapters';
import migrateGenerator from '../../../src/generators/migrate/generator';

import { fixtureCopy, put, putJson, readJsonFile, snapshot } from './helpers';

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({ name: '@acme/ws', scripts: {}, devDependencies: { nx: '~17.0.6' } }),
  );
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  return tree;
}

describe('migrate generator: multi-project Angular CLI workspace', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is detected', () => {
    const rows = detectAll(fixtureCopy('angular15-workspace'));
    expect(rows[0].adapter.id).toBe('angular-workspace');
    expect(rows[0].confidence).toBe(0.95);
    expect(rows[0].reasons).toContain('angular.json with 5 projects: 2 angular-app, 1 e2e, 2 lib');
    expect(rows.find((r) => r.adapter.id === 'angular-cli')?.confidence).toBe(0);
  });

  it('imports apps to apps/ and libraries to libs/', async () => {
    const src = fixtureCopy('angular15-workspace');
    const before = snapshot(src);
    const tree = workspace();
    await migrateGenerator(tree, { source: src });
    expect(snapshot(src)).toEqual(before);

    // portal: the repo root without projects/ and e2e/
    expect(tree.exists('apps/portal/src/main.ts')).toBe(true);
    expect(tree.exists('apps/portal/projects')).toBe(false);
    expect(tree.exists('apps/portal/e2e')).toBe(false);
    expect(tree.exists('apps/admin/src/main.ts')).toBe(true);
    expect(tree.exists('libs/ui-kit/src/public-api.ts')).toBe(true);
    expect(tree.exists('apps/portal-e2e')).toBe(false);

    const portal = readJson(tree, 'apps/portal/project.json');
    expect(portal.targets.build.options.outputPath).toBe('dist/apps/portal');
    expect(portal.targets.release).toBeDefined();
    const admin = readJson(tree, 'apps/admin/project.json');
    expect(admin.targets.build.options.main).toBe('apps/admin/src/main.ts');
    expect(readJson(tree, 'apps/admin/tsconfig.app.json').extends).toBe('./tsconfig.json');
    expect(readJson(tree, 'apps/admin/tsconfig.json').extends).toBe('../../tsconfig.base.json');

    const lib = readJson(tree, 'libs/ui-kit/project.json');
    expect(lib.projectType).toBe('library');
    expect(lib.targets.build.options.project).toBe('libs/ui-kit/ng-package.json');
    expect(lib.targets.build.executor).toBe('@nx/angular:package');
    expect(lib.targets.build.dependsOn).toEqual(['^build']);
    expect(lib.targets.build.outputs).toEqual(['{workspaceRoot}/dist/libs/ui-kit']);
    expect(lib.tags).toEqual(['scope:shared', 'type:lib']);
    expect(readJson(tree, 'libs/ui-kit/ng-package.json').dest).toBe('../../dist/libs/ui-kit');
    expect(readJson(tree, 'libs/ui-kit/tsconfig.lib.json').extends).toBe('./tsconfig.json');
    // @nx/angular:package rebases a library tsconfig into tmp/; an implicit include would then
    // match nothing (TS18003), so it is made explicit.
    expect(readJson(tree, 'libs/ui-kit/tsconfig.lib.json').include).toEqual(['**/*.ts']);
    expect(readJson(tree, 'libs/ui-kit/tsconfig.lib.prod.json').include).toBeUndefined();

    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['ui-kit']).toEqual([
      'libs/ui-kit/src/public-api.ts',
    ]);
    const pkg = readJson(tree, 'package.json');
    expect(pkg.devDependencies['ng-packagr']).toBeDefined();
    expect(pkg.scripts['build:portal:prod']).toBe('nx run portal:release:prod');
    expect(pkg.scripts['build:admin:prod']).toBe('nx run admin:release:prod');

    const report = tree.read('docs/migrations/field-workspace.md', 'utf8')!;
    expect(report).toContain('- Adapter: `angular-workspace`');
    expect(report).toContain('- Projects: 4 migrated, 1 not supported');
    expect(report).toMatch(/\|\s*`ui-kit`\s*\|\s*lib\s*\|\s*`libs\/ui-kit`\s*\|\s*selected\s*\|/);
    expect(report).toContain('Apps were copied to `apps/<name>` and libraries to `libs/<name>`');
    expect(report).toMatch(/\|\s*`portal-e2e`\s*\|\s*e2e\s*\|/);
  });

  it('--projects=portal brings the library it imports', async () => {
    const tree = workspace();
    await migrateGenerator(tree, {
      source: fixtureCopy('angular15-workspace'),
      projects: 'portal',
    });
    expect(tree.exists('apps/admin')).toBe(false);
    const report = tree.read('docs/migrations/field-workspace.md', 'utf8')!;
    expect(report).toMatch(
      /\|\s*`ui-kit`\s*\|\s*lib\s*\|\s*`libs\/ui-kit`\s*\|\s*needed by portal\s*\|/,
    );
  });

  it('--projects=admin --no-deps copies only admin; --prefix renames folders', async () => {
    const src = fixtureCopy('angular15-workspace');
    const tree = workspace();
    await migrateGenerator(tree, { source: src, projects: 'admin', noDeps: true, prefix: 'old' });
    expect(tree.exists('apps/old-admin/project.json')).toBe(true);
    expect(readJson(tree, 'apps/old-admin/project.json').name).toBe('old-admin');
    expect(tree.exists('libs/old-ui-kit')).toBe(false);
    expect(tree.exists('apps/old-portal')).toBe(false);
  });

  it('refuses, writing nothing, when folders or aliases clash', async () => {
    const src = fixtureCopy('angular15-workspace');
    const tree = workspace();
    tree.write('apps/admin/project.json', JSON.stringify({ name: 'admin' }));
    tree.write(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { paths: { 'ui-kit': ['libs/other/src/index.ts'] } } }),
    );
    await expect(migrateGenerator(tree, { source: src })).rejects.toThrow(
      /Nothing was written[\s\S]*apps\/admin[\s\S]*"ui-kit"/,
    );
    expect(tree.exists('apps/portal')).toBe(false);
  });

  it('renames references to other projects, fills ESLint extends and notes baseUrl imports', async () => {
    const src = fixtureCopy('angular15-workspace');
    const ws = readJsonFile<{ projects: Record<string, any> }>(src, 'angular.json');
    ws.projects['ui-kit'].architect['storybook'] = {
      builder: '@storybook/angular:start-storybook',
      options: { browserTarget: 'portal:build' },
    };
    putJson(src, 'angular.json', ws);
    putJson(src, 'projects/admin/.eslintrc.json', {
      extends: '../../.eslintrc.json',
      ignorePatterns: ['!**/*'],
      overrides: [
        { files: ['*.ts'], rules: { '@angular-eslint/component-selector': 'error' } },
        { files: ['*.html'], rules: {} },
      ],
    });
    put(src, 'src/app/util.ts', "import { environment } from 'src/environments/environment';\n");
    const tree = workspace();
    await migrateGenerator(tree, { source: src, prefix: 'old' });

    expect(
      readJson(tree, 'libs/old-ui-kit/project.json').targets.storybook.options.browserTarget,
    ).toBe('old-portal:build');
    const eslint = readJson(tree, 'apps/old-admin/.eslintrc.json');
    expect(eslint.overrides[0].extends).toEqual([
      'plugin:@nx/angular',
      'plugin:@angular-eslint/template/process-inline-templates',
    ]);
    expect(eslint.overrides[1].extends).toEqual(['plugin:@nx/angular-template']);
    expect(tree.read('docs/migrations/field-workspace.md', 'utf8')).toContain(
      '`apps/old-portal/src/app/util.ts`',
    );
  });

  it('converts application-builder apps and leaves server-rendered ones out', async () => {
    const src = fixtureCopy('angular15-workspace');
    const ws = readJsonFile<{
      projects: Record<string, { architect: Record<string, Record<string, unknown>> }>;
    }>(src, 'angular.json');
    const admin = ws.projects['admin'].architect;
    const options = admin['build']['options'] as Record<string, unknown>;
    admin['build'] = {
      builder: '@angular-devkit/build-angular:application',
      options: { ...options, browser: options['main'], main: undefined },
      configurations: admin['build']['configurations'],
    };
    admin['serve'] = {
      builder: '@angular-devkit/build-angular:dev-server',
      configurations: { development: { buildTarget: 'admin:build:development' } },
    };
    ws.projects['shop'] = {
      projectType: 'application',
      root: 'projects/shop',
      architect: {
        build: {
          builder: '@angular-devkit/build-angular:application',
          options: { browser: 'projects/shop/src/main.ts', prerender: true },
        },
      },
    } as never;
    putJson(src, 'angular.json', ws);
    put(src, 'projects/shop/src/main.ts', 'export {};\n');
    put(
      src,
      'projects/admin/src/app/flags.ts',
      "import { computed } from '@angular/core';\nexport const on = computed(() => true);\n",
    );

    const tree = workspace();
    await migrateGenerator(tree, { source: src, name: 'field-workspace' });
    const pj = readJson(tree, 'apps/admin/project.json');
    expect(pj.targets.build.executor).toBe('@angular-devkit/build-angular:browser');
    expect(pj.targets.build.options.main).toBe('apps/admin/src/main.ts');
    expect(pj.targets.build.options.browser).toBeUndefined();
    expect(pj.targets.serve.configurations.development).toEqual({
      browserTarget: 'admin:build:development',
    });
    expect(tree.exists('apps/shop')).toBe(false);
    const report = tree.read('docs/migrations/field-workspace.md', 'utf8') as string;
    expect(report).toMatch(
      /\|\s*`shop`\s*\|\s*angular-ssr\s*\|\s*`projects\/shop`\s*\|\s*Angular app with server rendering/,
    );
    expect(report).toContain(
      '`admin` target "build": @angular-devkit/build-angular:application became',
    );
    expect(report).toContain(
      '`admin`: Angular 16+ APIs `computed` used in `apps/admin/src/app/flags.ts`',
    );

    await expect(
      migrateGenerator(workspace(), { source: src, name: 'x', projects: 'shop' }),
    ).rejects.toThrow(
      '"shop" (angular-ssr: Angular app with server rendering (SSR, prerender or app shell)) ' +
        'cannot be migrated yet',
    );
  });
});
