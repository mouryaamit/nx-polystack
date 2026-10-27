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

  it('marks declared components, directives and pipes standalone: false from Angular 19', async () => {
    await libGenerator(tree, { name: 'ui', type: 'angular' });
    expect(tree.read(`${ROOT}/src/lib/ui/ui.component.ts`, 'utf8')).not.toContain('standalone');
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        dependencies: { '@angular/core': '~19.2.25' },
        devDependencies: { nx: '20.8.4' },
      }),
    );
    await libGenerator(tree, { name: 'cards', type: 'angular' });
    expect(tree.read('libs/shared/cards/src/lib/cards/cards.component.ts', 'utf8')).toContain(
      '  standalone: false,\n})',
    );
    const lintRules = (lib: string) =>
      JSON.parse(tree.read(`libs/shared/${lib}/.eslintrc.json`, 'utf8') ?? '{}').overrides[0].rules;
    expect(lintRules('ui')['@angular-eslint/prefer-standalone']).toBeUndefined();
    expect(lintRules('cards')['@angular-eslint/prefer-standalone']).toBe('off');
    await libGenerator(tree, { name: 'pages', type: 'ionic' });
    await libGenerator(tree, { name: 'pii', type: 'pii' });
    await libGenerator(tree, { name: 'session', type: 'session' });
    const sources = tree
      .listChanges()
      .map((c) => c.path)
      .filter((f) => /\.(component|page|directive|pipe)\.ts$/.test(f) && !f.includes('/ui/'));
    expect(sources.length).toBeGreaterThanOrEqual(5);
    for (const f of sources)
      expect([f, tree.read(f, 'utf8')]).toEqual([f, expect.stringContaining('standalone: false')]);
  });

  it('injects with inject() so angular-eslint 20 prefer-inject passes', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        dependencies: { '@angular/core': '~20.3.34' },
        devDependencies: { nx: '21.6.11' },
      }),
    );
    await libGenerator(tree, { name: 'cards', type: 'angular' });
    await libGenerator(tree, { name: 'pages', type: 'ionic' });
    await libGenerator(tree, { name: 'pii', type: 'pii' });
    await libGenerator(tree, { name: 'session', type: 'session' });
    await libGenerator(tree, { name: 'orders', type: 'state', variant: 'ngrx' });
    await libGenerator(tree, { name: 'cart', type: 'state' });
    const sources = tree
      .listChanges()
      .map((c) => c.path)
      .filter((f) => f.startsWith('libs/') && f.endsWith('.ts'));
    expect(sources.some((f) => f.endsWith('session-timeout.service.ts'))).toBe(true);
    expect(sources.some((f) => f.endsWith('.effects.ts'))).toBe(true);
    // A constructor with parameters in a class Angular injects into fails prefer-inject.
    const injecting =
      /@(?:Component|Directive|Pipe|Injectable)\b[\s\S]*?\bconstructor\s*\(\s*[^)\s]/;
    for (const f of sources)
      expect([f, injecting.test(tree.read(f, 'utf8') ?? '')]).toEqual([f, false]);
    const pkg = readJson(tree, 'package.json');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~20.7.0');
    expect(pkg.devDependencies.typescript).toBe('~5.9.3');
  });

  it('uses the built-in control flow from Angular 21 (prefer-control-flow)', async () => {
    const html = (lib: string) =>
      `libs/shared/${lib}/src/lib/session-warning/session-warning.component.html`;
    await libGenerator(tree, { name: 'session', type: 'session' });
    expect(tree.read(html('session'), 'utf8')).toContain('*ngIf');
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        dependencies: { '@angular/core': '~21.2.25' },
        devDependencies: { nx: '22.7.12' },
      }),
    );
    await libGenerator(tree, { name: 'idle', type: 'session' });
    const text = tree.read(html('idle'), 'utf8') ?? '';
    expect(text).not.toContain('*ngIf');
    expect(text).toContain('@let view = view$ | async;');
    expect(text).toContain('@if (view.idle) {');
  });

  describe('--standalone', () => {
    const read = (f: string) => tree.read(f, 'utf8') ?? '';
    const files = (root: string) =>
      tree
        .listChanges()
        .filter((c) => c.type !== 'DELETE' && c.path.startsWith(`${root}/src/`))
        .map((c) => c.path.slice(root.length + 1))
        .sort();

    it('angular and ionic libs: no NgModule, standalone components (15: standalone: true)', async () => {
      await libGenerator(tree, { name: 'ui', type: 'angular', standalone: true });
      expect(files(ROOT)).not.toContain('src/lib/ui.module.ts');
      expect(read(`${ROOT}/src/index.ts`)).not.toContain('ui.module');
      expect(read(`${ROOT}/src/lib/ui/ui.component.ts`)).toContain('  standalone: true,\n');
      await libGenerator(tree, { name: 'pages', type: 'ionic', standalone: true });
      const pages = 'libs/ionic/pages';
      expect(tree.exists(`${pages}/src/lib/pages.module.ts`)).toBe(false);
      const page = read(`${pages}/src/lib/pages/pages.page.ts`);
      expect(page).toMatch(
        /import \{\s*IonContent,\s*IonHeader,\s*IonTitle,\s*IonToolbar,?\s*\} from '@ionic\/angular\/standalone';/,
      );
      expect(page).toContain('imports: [IonHeader, IonToolbar, IonTitle, IonContent]');
    });

    it('pii, session and ngrx state libs export provide*() functions and no modules', async () => {
      await libGenerator(tree, { name: 'pii', type: 'pii', standalone: true });
      expect(tree.exists('libs/shared/pii/src/lib/pii-mask.module.ts')).toBe(false);
      const pii = read('libs/shared/pii/src/index.ts');
      expect(pii).toContain("export * from './lib/pii-mask.providers';");
      expect(pii).not.toContain('pii-mask.module');
      expect(read('libs/shared/pii/src/lib/pii-mask.pipe.ts')).toContain('standalone: true');
      expect(read('libs/shared/pii/README.md')).toContain('providePiiMask({');

      await libGenerator(tree, { name: 'session', type: 'session', standalone: true });
      expect(tree.exists('libs/shared/session/src/lib/session-timeout.module.ts')).toBe(false);
      const warning = read(
        'libs/shared/session/src/lib/session-warning/session-warning.component.ts',
      );
      expect(warning).toContain("import { AsyncPipe, NgIf } from '@angular/common';");
      expect(warning).toContain('imports: [NgIf, AsyncPipe]');
      expect(read('libs/shared/session/src/index.ts')).toContain(
        "export * from './lib/session-timeout.providers';",
      );

      await libGenerator(tree, {
        name: 'orders',
        type: 'state',
        variant: 'ngrx',
        standalone: true,
      });
      expect(tree.exists('libs/shared/orders/src/lib/orders-state.module.ts')).toBe(false);
      expect(read('libs/shared/orders/src/index.ts')).not.toContain('orders-state.module');
      expect(read('libs/shared/orders/README.md')).toContain('provideOrdersState()');
    });

    it('on Angular 21: no standalone flag, @let/@if session template importing AsyncPipe only', async () => {
      tree.write(
        'package.json',
        JSON.stringify({
          name: '@acme/source',
          dependencies: { '@angular/core': '~21.2.25' },
          devDependencies: { nx: '22.7.12' },
        }),
      );
      await libGenerator(tree, { name: 'session', type: 'session', standalone: true });
      const warning = read(
        'libs/shared/session/src/lib/session-warning/session-warning.component.ts',
      );
      expect(warning).not.toContain('standalone:');
      expect(warning).toContain('imports: [AsyncPipe]');
      await libGenerator(tree, { name: 'pages', type: 'ionic', standalone: true });
      expect(read('libs/ionic/pages/src/lib/pages/pages.page.ts')).toMatch(
        /from '@ionic\/angular';/,
      );
      const rules = JSON.parse(read('libs/shared/session/.eslintrc.json')).overrides[0].rules;
      expect(rules['@angular-eslint/prefer-standalone']).toBeUndefined();
    });

    it('follows the workspace style and rejects the flags on other types', async () => {
      const nx = JSON.parse(tree.read('nx.json', 'utf8') ?? '{}');
      tree.write(
        'nx.json',
        JSON.stringify({ ...nx, pstack: { angular: { style: 'standalone' } } }),
      );
      await libGenerator(tree, { name: 'ui', type: 'angular' });
      expect(tree.exists(`${ROOT}/src/lib/ui.module.ts`)).toBe(false);
      await libGenerator(tree, { name: 'cards', type: 'angular', module: true });
      expect(tree.exists('libs/shared/cards/src/lib/cards.module.ts')).toBe(true);
      await expect(
        libGenerator(tree, { name: 'util', type: 'ts', standalone: true }),
      ).rejects.toThrow('--standalone and --module are for angular, ionic, pii, session, state');
    });
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
