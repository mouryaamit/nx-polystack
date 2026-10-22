import * as fs from 'fs';
import * as path from 'path';

import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrateGenerator from '../../../src/generators/migrate/generator';

import { fixtureCopy, put, putJson, readJsonFile, snapshot } from './helpers';

const HARDENED = {
  leakCheck: 'fail',
  sourceMaps: 'fail',
  stripComments: true,
  dropConsole: ['log', 'debug', 'warn'],
};

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
    JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@acme/kit': ['libs/kit/src/index.ts'] } },
    }),
  );
  return tree;
}

const json = (tree: Tree, file: string) => readJson(tree, file);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A markdown table row with these cells (the table pads them). */
const row = (...cells: string[]) =>
  new RegExp(`\\|\\s*${cells.map(escape).join('\\s*\\|\\s*')}\\s*\\|`);

describe('migrate generator: Nx workspace', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = workspace();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('imports every supported project by default, at the same paths', async () => {
    const src = fixtureCopy('nx16-workspace');
    const before = snapshot(src);
    await migrateGenerator(tree, { source: src });

    for (const root of [
      'apps/portal',
      'apps/admin',
      'apps/field',
      'apps/mobile',
      'libs/dart_core',
      'libs/shared/ui',
      'libs/shared/util',
      'libs/shared/styles',
    ]) {
      expect(tree.exists(`${root}/project.json`)).toBe(true);
    }
    expect(tree.exists('apps/portal-e2e')).toBe(false);
    expect(tree.read('apps/portal/src/app/app.module.ts', 'utf8')).toContain(
      "from '@acme/shared-ui'",
    );
    expect(snapshot(src)).toEqual(before);

    const portal = json(tree, 'apps/portal/project.json');
    expect(portal.targets.build.executor).toBe('@nx/angular:webpack-browser');
    expect(portal.targets.serve.executor).toBe('@nx/angular:dev-server');
    expect(portal.targets.lint.executor).toBe('@nx/eslint:lint');
    expect(portal.targets.test.executor).toBe('@nx/jest:jest');
    expect(portal.targets.release.configurations).toEqual({
      prod: { env: 'PROD', buildConfiguration: 'production', ...HARDENED },
      dev: { env: 'DEV', buildConfiguration: 'development' },
    });
    expect(portal.tags).toEqual(['scope:portal', 'type:app', 'platform:web']);

    const styles = json(tree, 'libs/shared/styles/project.json');
    expect(styles).toEqual({
      name: 'shared-styles',
      projectType: 'library',
      targets: {
        check: {
          executor: 'nx:run-commands',
          options: { command: 'echo shared-styles' },
        },
      },
      tags: ['type:lib'],
    });
    expect(json(tree, 'libs/shared/util/project.json').tags).toEqual(['scope:shared', 'type:util']);

    const mobile = json(tree, 'apps/mobile/project.json');
    expect(mobile.targets['build-web']).toMatchObject({
      executor: '@mouryaamit/nx-polystack:flutter-build',
      options: { dist: 'dist/apps/mobile/web' },
    });
    expect(mobile.targets.analyze.executor).toBe('nx:run-commands');
    expect(mobile.tags).toEqual(['scope:mobile', 'type:app', 'platform:flutter']);
    expect(tree.read('apps/mobile/env/dev.json', 'utf8')).toContain('dev.acme.test');
    expect(tree.read('apps/mobile/env/uat.json', 'utf8')).toBe('{}\n');

    expect(json(tree, 'apps/portal/.eslintrc.json').overrides[0]).toEqual({
      files: ['*.ts'],
      extends: ['plugin:@nx/angular', 'plugin:@angular-eslint/template/process-inline-templates'],
      rules: { '@nx/enforce-module-boundaries': 'error' },
    });
    expect(tree.read('jest.preset.js', 'utf8')).toContain("require('@nx/jest/preset')");

    const paths = json(tree, 'tsconfig.base.json').compilerOptions.paths;
    expect(paths['@acme/shared-ui']).toEqual(['libs/shared/ui/src/index.ts']);
    expect(paths['@acme/kit']).toEqual(['libs/kit/src/index.ts']);
    expect(paths['@acme/field-kit']).toEqual(['apps/field/src/kit.ts']);

    const pkg = json(tree, 'package.json');
    expect(pkg.devDependencies['@nx/angular']).toBe('~17.0.6');
    expect(pkg.devDependencies['@nx/jest']).toBe('~17.0.6');
    expect(pkg.devDependencies['@nrwl/angular']).toBeUndefined();
    expect(pkg.dependencies['rxjs']).toBe('~7.8.0');
    // The source lists only @angular/common and core; the runtime an Angular build needs is
    // filled in at the same version.
    expect(pkg.dependencies['@angular/compiler']).toBe('~15.2.0');
    expect(pkg.dependencies['@angular/platform-browser-dynamic']).toBe('~15.2.0');
    // A transitive TypeScript 5 would break the Angular 15 compiler.
    expect(pkg.devDependencies['typescript']).toBe('~4.9.5');
    // A latest @types/node uses TypeScript 5 syntax that 4.9 can't parse.
    expect(pkg.devDependencies['@types/node']).toBe('~18.16.9');
    expect(pkg.scripts['build:portal:prod']).toBe('nx run portal:release:prod');
    expect(pkg.scripts['build:mobile:dev:web']).toBe('nx run mobile:build-web:dev');

    const report = tree.read('docs/migrations/source.md', 'utf8')!;
    expect(report).toContain('- Adapter: `nx-workspace`');
    expect(report).toContain('- Projects: 8 migrated, 1 not supported');
    expect(report).toMatch(row('`shared-util`', 'lib', '`libs/shared/util`', 'selected'));
    expect(report).toMatch(row('`field`', 'ionic-app', '`apps/field`'));
    expect(report).toMatch(row('`portal-e2e`', 'e2e', '`apps/portal-e2e`'));
    expect(report).toContain('`@acme/field-kit`');
    expect(report).toContain('scope:portal');
    expect(report).toContain('`strict: true`');
    expect(report).toContain('The source used Nx 16.10.0');
    // Every package the run added is listed, not only the source's.
    const added = report.slice(report.indexOf('Added ('), report.indexOf('Version clashes'));
    for (const pkgName of ['@nx/angular', '@nx/jest', '@nx/eslint', 'ng-packagr', 'rxjs']) {
      if (pkgName === '@nx/eslint') expect(added).not.toContain(`\`${pkgName}\``);
      else expect(added).toContain(`\`${pkgName}\``);
    }
  });

  it('imports an Ionic app into the polystack Ionic shape', async () => {
    const src = fixtureCopy('nx16-workspace');
    const tree = workspace();
    await migrateGenerator(tree, { source: src, projects: 'field' });

    expect(tree.exists('apps/field/android/app/src/main/AndroidManifest.xml')).toBe(true);
    expect(tree.exists('apps/field/android/app/build/junk.txt')).toBe(false);

    const pj = readJson(tree, 'apps/field/project.json');
    expect(pj.targets.build.executor).toBe('@nx/angular:webpack-browser');
    expect(pj.targets.release.options).toMatchObject({
      type: 'ionic',
      outputPath: 'dist/apps/field',
    });
    expect(pj.targets['cap-sync']).toEqual({
      executor: '@mouryaamit/nx-polystack:capacitor',
      options: { command: 'sync' },
    });
    expect(pj.targets.cap).toBeUndefined();
    expect(pj.tags).toEqual(['scope:mobile', 'type:app', 'platform:mobile']);

    const appPkg = readJson(tree, 'apps/field/package.json');
    expect(appPkg.dependencies).toEqual({
      '@capacitor/android': '5.7.0',
      '@capacitor/core': '5.7.0',
    });
    expect(appPkg.devDependencies).toEqual({ '@capacitor/cli': '5.7.0' });

    const root = readJson(tree, 'package.json');
    expect(root.dependencies['@ionic/angular']).toBe('^7.8.0');
    // A peer of @ionic/angular the source only had through hoisting.
    expect(root.dependencies['@angular/forms']).toBe('~15.2.0');
    // The app code imports @capacitor/core: the web build resolves it from the root.
    expect(root.dependencies['@capacitor/core']).toBe('5.7.0');
    expect(root.devDependencies['@capacitor/cli']).toBeUndefined();
    expect(root.devDependencies['@nxext/capacitor']).toBeUndefined();
    expect(root.scripts['open:field:android']).toBe('nx run field:cap-open --platform=android');

    const report = tree.read('docs/migrations/source.md', 'utf8')!;
    expect(report).toContain('## Ionic');
    expect(report).toContain('- Targets dropped: `cap (@nxext/capacitor:cap)`');
  });

  it('splits native packages between several Ionic apps by what they import', async () => {
    const src = fixtureCopy('nx16-workspace');
    fs.cpSync(path.join(src, 'apps/field'), path.join(src, 'apps/scanner'), { recursive: true });
    const field = readJsonFile(src, 'apps/field/project.json');
    putJson(
      src,
      'apps/scanner/project.json',
      JSON.parse(
        JSON.stringify(field)
          .replace(/apps\/field/g, 'apps/scanner')
          .replace(/"field"/, '"scanner"'),
      ),
    );
    fs.rmSync(path.join(src, 'apps/scanner/package.json'));
    put(src, 'apps/field/src/camera.ts', "export { Camera } from '@capacitor/camera';\n");
    put(
      src,
      'apps/scanner/src/scan.ts',
      "export { BarcodeScanner } from '@capacitor-community/barcode-scanner';\n",
    );
    put(src, 'libs/shared/util/src/native.ts', "export { Haptics } from '@capacitor/haptics';\n");
    const pkg = readJsonFile<{ dependencies: Record<string, string> }>(src, 'package.json');
    Object.assign(pkg.dependencies, {
      '@capacitor/camera': '5.0.0',
      '@capacitor/haptics': '5.0.0',
      '@capacitor-community/barcode-scanner': '4.0.0',
      'cordova-plugin-x': '1.0.0',
    });
    putJson(src, 'package.json', pkg);

    const tree = workspace();
    await migrateGenerator(tree, { source: src, projects: 'field,scanner,shared-util' });

    const deps = (file: string) => Object.keys(readJson(tree, file).dependencies).sort();
    expect(deps('apps/field/package.json')).toEqual([
      '@capacitor/android',
      '@capacitor/camera',
      '@capacitor/core',
      '@capacitor/haptics',
      'cordova-plugin-x',
    ]);
    expect(deps('apps/scanner/package.json')).toEqual([
      '@capacitor-community/barcode-scanner',
      '@capacitor/core',
      '@capacitor/haptics',
      'cordova-plugin-x',
    ]);
    const root = readJson(tree, 'package.json');
    // Imported by copied code: also at the root, for the web build.
    for (const name of [
      '@capacitor/core',
      '@capacitor/camera',
      '@capacitor/haptics',
      '@capacitor-community/barcode-scanner',
    ]) {
      expect(root.dependencies[name]).toBeDefined();
    }
    // Not imported anywhere: only in the apps.
    expect(root.dependencies['cordova-plugin-x']).toBeUndefined();
    expect(root.devDependencies['@capacitor/cli']).toBeUndefined();
    const report = tree.read('docs/migrations/source.md', 'utf8')!;
    expect(report).toContain(
      '- Left to the other Ionic apps (this app does not import them): ' +
        '`@capacitor-community/barcode-scanner`',
    );
  });

  it('--projects adds the libs they need and says why', async () => {
    const src = fixtureCopy('nx16-workspace');
    await migrateGenerator(tree, { source: src, projects: 'admin' });
    expect(tree.exists('apps/admin/project.json')).toBe(true);
    expect(tree.exists('libs/shared/util/project.json')).toBe(true);
    expect(tree.exists('apps/portal')).toBe(false);
    expect(tree.read('docs/migrations/source.md', 'utf8')).toMatch(
      row('`shared-util`', 'lib', '`libs/shared/util`', 'needed by admin'),
    );
  });

  it('--no-deps copies only the named projects', async () => {
    const src = fixtureCopy('nx16-workspace');
    await migrateGenerator(tree, { source: src, projects: 'admin', noDeps: true });
    expect(tree.exists('libs/shared/util')).toBe(false);
  });

  it('--prefix renames projects, references and scripts, not paths', async () => {
    const src = fixtureCopy('nx16-workspace');
    await migrateGenerator(tree, { source: src, projects: 'portal', prefix: 'acme' });
    const portal = json(tree, 'apps/portal/project.json');
    expect(portal.name).toBe('acme-portal');
    expect(portal.implicitDependencies).toEqual(['acme-shared-styles']);
    expect(portal.targets.serve.configurations.production.browserTarget).toBe(
      'acme-portal:build:production',
    );
    expect(portal.targets.release.options.buildTarget).toBe('acme-portal:build');
    expect(json(tree, 'libs/shared/ui/project.json').name).toBe('acme-shared-ui');
    expect(json(tree, 'package.json').scripts['serve:acme-portal']).toBe('nx serve acme-portal');
    expect(tree.read('docs/migrations/source.md', 'utf8')).toMatch(
      row(
        '`acme-shared-ui` (source: `shared-ui`)',
        'lib',
        '`libs/shared/ui`',
        'needed by acme-portal',
      ),
    );
  });

  it('refuses clashes before writing anything', async () => {
    const src = fixtureCopy('nx16-workspace');
    tree.write('libs/shared/util/README.md', '# mine');
    tree.write('apps/other/project.json', JSON.stringify({ name: 'admin' }));
    tree.write(
      'tsconfig.base.json',
      JSON.stringify({
        compilerOptions: { paths: { '@acme/shared-util': ['libs/util/src/index.ts'] } },
      }),
    );
    const changes = tree.listChanges().length;
    await expect(migrateGenerator(tree, { source: src, projects: 'admin' })).rejects.toThrow(
      /cannot import from[\s\S]*a project named "admin" already exists in the workspace\. Rename the migrated projects with --prefix=<p>\.[\s\S]*`libs\/shared\/util` already exists[\s\S]*the path alias "@acme\/shared-util" maps to libs\/util\/src\/index\.ts/,
    );
    expect(tree.listChanges().length).toBe(changes);
  });

  it('refuses an Angular major mismatch unless --force-angular', async () => {
    const src = fixtureCopy('nx16-workspace');
    tree.write(
      'package.json',
      JSON.stringify({
        dependencies: { '@angular/core': '~16.2.0' },
        devDependencies: { nx: '~17.0.6' },
      }),
    );
    await expect(migrateGenerator(tree, { source: src, projects: 'admin' })).rejects.toThrow(
      'the workspace uses Angular 16',
    );
    await migrateGenerator(tree, { source: src, projects: 'admin', forceAngular: true });
    expect(tree.exists('apps/admin/project.json')).toBe(true);
  });

  it('Flutter-only imports leave package dependencies alone', async () => {
    const src = fixtureCopy('nx16-workspace');
    const before = json(tree, 'package.json');
    const cb = await migrateGenerator(tree, { source: src, projects: 'mobile' });
    expect(tree.exists('libs/dart_core/project.json')).toBe(true);
    const after = json(tree, 'package.json');
    expect(after.dependencies).toEqual(before.dependencies);
    expect(after.devDependencies).toEqual(before.devDependencies);
    expect(cb).toBeUndefined();
  });

  it('skips secrets and nested projects, and copies folders outside the projects that options use', async () => {
    const src = fixtureCopy('nx16-workspace');
    put(src, 'apps/portal/.env', 'TOKEN=1');
    putJson(src, 'apps/portal/e2e/project.json', {
      name: 'portal-inner-e2e',
      projectType: 'application',
      targets: { e2e: { executor: '@nx/cypress:cypress' } },
    });
    put(src, 'apps/portal/e2e/src/app.cy.ts', '');
    put(src, 'tools/legacy/analytics.js', '');
    const portalPj = JSON.parse(fs.readFileSync(`${src}/apps/portal/project.json`, 'utf8'));
    portalPj.targets.build.options.scripts = ['tools/legacy/analytics.js'];
    putJson(src, 'apps/portal/project.json', portalPj);
    await migrateGenerator(tree, { source: src, projects: 'portal' });
    expect(tree.exists('apps/portal/.env')).toBe(false);
    expect(tree.exists('apps/portal/e2e')).toBe(false);
    const report = tree.read('docs/migrations/source.md', 'utf8')!;
    expect(report).toContain('`apps/portal/.env`');
    expect(tree.exists('tools/legacy/analytics.js')).toBe(true);
    expect(report).toContain('`tools` (1 file; scripts of portal)');
  });

  it('applies --max-files to the whole run', async () => {
    const src = fixtureCopy('nx16-workspace');
    await expect(migrateGenerator(tree, { source: src, maxFiles: 5 })).rejects.toThrow(
      'the selected projects have more than 5 files to copy',
    );
  });

  it('--name names the report; single-app sources refuse the Nx options', async () => {
    const src = fixtureCopy('nx16-workspace');
    await migrateGenerator(tree, { source: src, projects: 'admin', name: 'legacy-suite' });
    expect(tree.exists('docs/migrations/legacy-suite.md')).toBe(true);

    const app = fixtureCopy('angular15-app');
    await expect(migrateGenerator(workspace(), { source: app, prefix: 'x' })).rejects.toThrow(
      '--projects, --no-deps and --prefix are for Nx workspace sources',
    );
  });

  it('adds the ng-packagr build packages for buildable Angular libs', async () => {
    const src = fixtureCopy('nx16-workspace');
    await migrateGenerator(tree, { source: src, projects: 'shared-ui' });
    const dev = json(tree, 'package.json').devDependencies;
    expect(dev['ng-packagr']).toBe('^15.0.0');
    expect(dev['postcss-preset-env']).toBeDefined();
  });

  it('brings over the named inputs the copied targets use', async () => {
    const src = fixtureCopy('nx16-workspace');
    putJson(src, 'nx.json', {
      namedInputs: {
        default: ['{projectRoot}/**/*'],
        noMarkdown: ['!{projectRoot}/**/*.md'],
      },
    });
    const pj = JSON.parse(fs.readFileSync(`${src}/libs/shared/util/project.json`, 'utf8'));
    pj.targets.lint.inputs = ['default', 'noMarkdown', '^production', 'unknownInput'];
    putJson(src, 'libs/shared/util/project.json', pj);
    tree.write('nx.json', JSON.stringify({ namedInputs: { default: ['{projectRoot}/**/*'] } }));
    await migrateGenerator(tree, { source: src, projects: 'shared-util' });
    expect(json(tree, 'nx.json').namedInputs).toEqual({
      default: ['{projectRoot}/**/*'],
      noMarkdown: ['!{projectRoot}/**/*.md'],
    });
    const report = tree.read('docs/migrations/source.md', 'utf8')!;
    expect(report).toContain('Added named inputs to `nx.json`: `noMarkdown`');
    expect(report).toContain('`production`, `unknownInput`');
  });

  it('drops dependencies on projects that are not copied, and says so', async () => {
    const src = fixtureCopy('nx16-workspace');
    await migrateGenerator(tree, { source: src, projects: 'portal', noDeps: true });
    expect(json(tree, 'apps/portal/project.json').implicitDependencies).toEqual([]);
    expect(tree.read('docs/migrations/source.md', 'utf8')).toContain(
      '`portal`: dropped references to projects that were not copied: `shared-styles`',
    );
  });

  it('adds wildcard aliases that cover copied projects', async () => {
    const src = fixtureCopy('nx16-workspace');
    const ts = JSON.parse(fs.readFileSync(`${src}/tsconfig.base.json`, 'utf8'));
    ts.compilerOptions.paths['@acme/shared/*'] = ['libs/shared/*/src/index.ts'];
    putJson(src, 'tsconfig.base.json', ts);
    await migrateGenerator(tree, { source: src, projects: 'shared-util' });
    expect(json(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/shared/*']).toEqual([
      'libs/shared/*/src/index.ts',
    ]);
  });

  it('adds @nx packages that copied code imports, and flags @nrwl imports', async () => {
    const src = fixtureCopy('nx16-workspace');
    put(src, 'apps/admin/src/testing.ts', "import { x } from '@nrwl/angular/testing';\n");
    await migrateGenerator(tree, { source: src, projects: 'admin', rewriteImports: false });
    expect(json(tree, 'package.json').devDependencies['@nx/angular']).toBe('~17.0.6');
    expect(tree.read('docs/migrations/source.md', 'utf8')).toContain(
      'import `@nrwl/*` packages; rename the imports to `@nx/*`: `apps/admin/src/testing.ts`',
    );
  });

  it('rewrites @nrwl imports to @nx by default', async () => {
    const src = fixtureCopy('nx16-workspace');
    put(src, 'apps/admin/src/testing.ts', "import { x } from '@nrwl/angular/testing';\n");
    await migrateGenerator(tree, { source: src, projects: 'admin' });
    expect(json(tree, 'package.json').devDependencies['@nx/angular']).toBe('~17.0.6');
    expect(tree.read('apps/admin/src/testing.ts', 'utf8')).toBe(
      "import { x } from '@nx/angular/testing';\n",
    );
    const report = tree.read('docs/migrations/source.md', 'utf8') as string;
    expect(report).not.toContain('rename the imports to `@nx/*`');
    expect(report).toMatch(
      /\| `apps\/admin\/src\/testing\.ts` +\| `@nrwl\/\*` to `@nx\/\*` +\| `@nrwl\/angular\/testing` +\| `@nx\/angular\/testing` +\|/,
    );
    expect(fs.readFileSync(path.join(src, 'apps/admin/src/testing.ts'), 'utf8')).toContain(
      '@nrwl/',
    );
  });

  it('finds name clashes with projects outside apps/ and libs/', async () => {
    const src = fixtureCopy('nx16-workspace');
    tree.write('packages/old/project.json', JSON.stringify({ name: 'admin' }));
    await expect(migrateGenerator(tree, { source: src, projects: 'admin' })).rejects.toThrow(
      'a project named "admin" already exists',
    );
  });
  describe('ESLint flat config sources (Nx 19+)', () => {
    const ROOT_FLAT =
      "const nx = require('@nx/eslint-plugin');\n" +
      "module.exports = [...nx.configs['flat/base'], ...nx.configs['flat/typescript']];\n";
    const APP_FLAT =
      "const nx = require('@nx/eslint-plugin');\n" +
      "const baseConfig = require('../../eslint.config.js');\n" +
      'module.exports = [\n' +
      '  ...baseConfig,\n' +
      "  ...nx.configs['flat/angular'],\n" +
      "  ...nx.configs['flat/angular-template'],\n" +
      '  {\n' +
      "    files: ['**/*.ts'],\n" +
      '    rules: {\n' +
      "      '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'acme', style: 'camelCase' }],\n" +
      "      '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'acme', style: 'kebab-case' }],\n" +
      '    },\n' +
      '  },\n' +
      '];\n';

    function flatSource(): string {
      const src = fixtureCopy('nx16-workspace');
      fs.rmSync(path.join(src, '.eslintrc.json'));
      fs.rmSync(path.join(src, 'apps/portal/.eslintrc.json'));
      put(src, 'eslint.config.js', ROOT_FLAT);
      put(src, 'apps/portal/eslint.config.js', APP_FLAT);
      const pkg = readJsonFile<{ devDependencies: Record<string, string> }>(src, 'package.json');
      pkg.devDependencies = {
        ...pkg.devDependencies,
        'typescript-eslint': '^8.0.0',
        '@eslint/js': '^9.8.0',
        'angular-eslint': '^18.3.0',
      };
      putJson(src, 'package.json', pkg);
      return src;
    }

    it('gives the projects .eslintrc.json in an .eslintrc workspace and leaves the flat config out', async () => {
      tree.write('.eslintrc.json', '{ "root": true }\n');
      await migrateGenerator(tree, { source: flatSource(), projects: 'portal' });
      expect(tree.exists('eslint.config.js')).toBe(false);
      expect(tree.exists('apps/portal/eslint.config.js')).toBe(false);
      const rc = json(tree, 'apps/portal/.eslintrc.json');
      expect(rc.extends).toEqual(['../../.eslintrc.json']);
      expect(rc.overrides[0].extends).toEqual([
        'plugin:@nx/angular',
        'plugin:@angular-eslint/template/process-inline-templates',
      ]);
      expect(rc.overrides[0].rules['@angular-eslint/component-selector'][1].prefix).toBe('acme');
      expect(rc.overrides[0].rules['@angular-eslint/directive-selector'][1].prefix).toBe('acme');
      expect(rc.overrides[1]).toEqual({
        files: ['*.html'],
        extends: ['plugin:@nx/angular-template'],
        rules: {},
      });
      const dev = json(tree, 'package.json').devDependencies;
      for (const name of ['typescript-eslint', '@eslint/js', 'angular-eslint']) {
        expect(dev[name]).toBeUndefined();
      }
      const report = tree.read('docs/migrations/source.md', 'utf8') ?? '';
      expect(report).toContain('ESLint flat config');
      expect(report).toContain('`apps/portal/.eslintrc.json`');
    });

    it('keeps the flat config in a workspace that lints with eslint.config.js', async () => {
      tree.write('eslint.config.js', 'module.exports = [];\n');
      await migrateGenerator(tree, { source: flatSource(), projects: 'portal' });
      expect(tree.read('apps/portal/eslint.config.js', 'utf8')).toContain('flat/angular');
      expect(tree.exists('apps/portal/.eslintrc.json')).toBe(false);
      expect(tree.read('eslint.config.js', 'utf8')).toBe('module.exports = [];\n');
      expect(json(tree, 'package.json').devDependencies['typescript-eslint']).toBe('^8.0.0');
    });
  });
});
