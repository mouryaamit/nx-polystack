import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';

const ROOT = 'libs/shared/ui';

describe('lib generator --type=angular', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('creates an NgModule lib with one component', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    expect(tree.read(`${ROOT}/src/index.ts`, 'utf8')).toBe(
      "export * from './lib/ui.module';\nexport * from './lib/ui/ui.component';\n",
    );
    const mod = tree.read(`${ROOT}/src/lib/ui.module.ts`, 'utf8') ?? '';
    expect(mod).toContain('imports: [CommonModule]');
    expect(mod).toContain('declarations: [UiComponent]');
    expect(mod).toContain('exports: [UiComponent]');
    expect(mod).toContain('export class UiModule {}');
    const cmp = tree.read(`${ROOT}/src/lib/ui/ui.component.ts`, 'utf8') ?? '';
    expect(cmp).toContain("selector: 'lib-ui'");
    expect(cmp).toContain('export class UiComponent {}');
    expect(tree.exists(`${ROOT}/src/lib/ui/ui.component.html`)).toBe(true);
    expect(tree.exists(`${ROOT}/src/lib/ui/ui.component.scss`)).toBe(true);
  });

  it('writes Angular tsconfigs', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    const ts = readJson(tree, `${ROOT}/tsconfig.json`);
    expect(ts.compilerOptions.target).toBe('es2022');
    expect(ts.compilerOptions.useDefineForClassFields).toBe(false);
    expect(ts.compilerOptions.strict).toBe(true);
    expect(ts.angularCompilerOptions).toEqual({
      enableI18nLegacyMessageIdFormat: false,
      strictInjectionParameters: true,
      strictInputAccessModifiers: true,
      strictTemplates: true,
    });
    const lib = readJson(tree, `${ROOT}/tsconfig.lib.json`);
    expect(lib.compilerOptions).toMatchObject({
      declaration: true,
      declarationMap: true,
      inlineSources: true,
      types: [],
    });
    const prod = readJson(tree, `${ROOT}/tsconfig.lib.prod.json`);
    expect(prod.compilerOptions.declarationMap).toBe(false);
    expect(prod.angularCompilerOptions.compilationMode).toBe('partial');
  });

  it('uses --prefix in the selector and ESLint selector rules', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular', prefix: 'acme-ui' });
    expect(tree.read(`${ROOT}/src/lib/ui/ui.component.ts`, 'utf8')).toContain(
      "selector: 'acme-ui-ui'",
    );
    const eslint = readJson(tree, `${ROOT}/.eslintrc.json`);
    expect(eslint.extends).toEqual(['../../../.eslintrc.json']);
    const [tsOverride, htmlOverride] = eslint.overrides;
    expect(tsOverride.extends).toContain('plugin:@nx/angular');
    expect(tsOverride.rules['@angular-eslint/component-selector'][1]).toEqual({
      type: 'element',
      prefix: 'acme-ui',
      style: 'kebab-case',
    });
    expect(tsOverride.rules['@angular-eslint/directive-selector'][1]).toEqual({
      type: 'attribute',
      prefix: 'acmeUi',
      style: 'camelCase',
    });
    expect(htmlOverride.extends).toEqual(['plugin:@nx/angular-template']);
    expect(readJson(tree, `${ROOT}/project.json`).prefix).toBe('acme-ui');
  });

  it('buildable (default): ng-packagr-lite build, ng-package.json and lib package.json', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    const pj = readJson(tree, `${ROOT}/project.json`);
    expect(pj.name).toBe('shared-ui');
    expect(pj.tags).toEqual(['scope:shared', 'type:angular', 'platform:web']);
    expect(pj.targets.build).toEqual({
      executor: '@nx/angular:ng-packagr-lite',
      outputs: ['{workspaceRoot}/dist/{projectRoot}'],
      options: { project: `${ROOT}/ng-package.json` },
      configurations: {
        production: { tsConfig: `${ROOT}/tsconfig.lib.prod.json` },
        development: { tsConfig: `${ROOT}/tsconfig.lib.json` },
      },
      defaultConfiguration: 'production',
    });
    expect(pj.targets.lint.options.lintFilePatterns).toEqual([
      `${ROOT}/**/*.ts`,
      `${ROOT}/**/*.html`,
    ]);
    expect(readJson(tree, `${ROOT}/ng-package.json`)).toEqual({
      $schema: '../../../node_modules/ng-packagr/ng-package.schema.json',
      dest: '../../../dist/libs/shared/ui',
      lib: { entryFile: 'src/index.ts' },
    });
    expect(readJson(tree, `${ROOT}/package.json`)).toEqual({
      name: '@acme/shared-ui',
      version: '0.0.1',
      peerDependencies: { '@angular/common': '^15.2.0', '@angular/core': '^15.2.0' },
      dependencies: { tslib: '^2.3.0' },
      sideEffects: false,
    });
  });

  it('publishable: @nx/angular:package build', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular', variant: 'publishable' });
    const pj = readJson(tree, `${ROOT}/project.json`);
    expect(pj.targets.build.executor).toBe('@nx/angular:package');
    expect(pj.targets.build.configurations.production.tsConfig).toBe(
      `${ROOT}/tsconfig.lib.prod.json`,
    );
    expect(readJson(tree, `${ROOT}/package.json`).name).toBe('@acme/shared-ui');
  });

  it('internal: lint only, no packaging files, no ng-packagr', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular', variant: 'internal' });
    const pj = readJson(tree, `${ROOT}/project.json`);
    expect(Object.keys(pj.targets)).toEqual(['lint', 'typecheck']);
    for (const f of ['ng-package.json', 'package.json', 'tsconfig.lib.prod.json']) {
      expect(tree.exists(`${ROOT}/${f}`)).toBe(false);
    }
    const dev = readJson(tree, 'package.json').devDependencies;
    expect(dev['ng-packagr']).toBeUndefined();
    expect(dev['postcss-preset-env']).toBeUndefined();
  });

  it('buildable libs get the PostCSS packages the Nx package executors load', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    expect(readJson(tree, 'package.json').devDependencies).toMatchObject({
      postcss: '^8.4.5',
      'postcss-preset-env': '~7.5.0',
      'postcss-url': '~10.1.3',
      autoprefixer: '^10.4.0',
    });
  });

  it('rejects an unknown variant', async () => {
    await expect(
      libGenerator(tree, { name: 'ui', type: 'angular', variant: 'signal' }),
    ).rejects.toThrow(/internal, buildable, publishable/);
  });

  it('maps the import alias to src/index.ts', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/shared-ui']).toEqual([
      `${ROOT}/src/index.ts`,
    ]);
  });

  it('adds Angular 15 and ng-packagr when Angular is missing', async () => {
    const cb = await libGenerator(tree, { name: 'ui', type: 'angular' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('~15.2.0');
    expect(pkg.dependencies['@angular/common']).toBe('~15.2.0');
    expect(pkg.devDependencies['ng-packagr']).toBe('^15.0.0');
    expect(pkg.devDependencies['@nx/angular']).toBe('17.0.6');
    expect(pkg.devDependencies['@nx/eslint-plugin']).toBe('17.0.6');
    expect(typeof cb).toBe('function');
  });

  it('pins ng-packagr to the Angular major, not the patch', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        dependencies: { '@angular/core': '~15.2.10' },
        devDependencies: { nx: '17.0.6' },
      }),
    );
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.devDependencies['ng-packagr']).toBe('^15.0.0');
    expect(pkg.dependencies['@angular/common']).toBe('~15.2.10');
  });

  it('keeps the default component class suffix', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    const [tsOverride] = readJson(tree, `${ROOT}/.eslintrc.json`).overrides;
    expect(tsOverride.rules['@angular-eslint/component-class-suffix']).toBeUndefined();
  });

  it('matches the installed Angular version and keeps existing versions', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        dependencies: { '@angular/core': '~15.1.0' },
        devDependencies: { nx: '17.0.6', 'ng-packagr': '15.0.0' },
      }),
    );
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('~15.1.0');
    expect(pkg.dependencies['@angular/common']).toBe('~15.1.0');
    expect(pkg.devDependencies['ng-packagr']).toBe('15.0.0');
    expect(readJson(tree, `${ROOT}/package.json`).peerDependencies['@angular/core']).toBe(
      '^15.1.0',
    );
  });
});
