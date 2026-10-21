import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import appGenerator from '../../src/generators/app/generator';

describe('app generator --type=ionic', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {}, devDependencies: { nx: '17.0.6' } }));
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('generates an Ionic Angular app with Capacitor config and a per-app package.json', async () => {
    await appGenerator(tree, { name: 'field-ops', type: 'ionic' });
    expect(tree.read('apps/field-ops/src/app/app.module.ts', 'utf8')).toContain(
      'IonicModule.forRoot()',
    );
    const html = tree.read('apps/field-ops/src/app/app.component.html', 'utf8') ?? '';
    expect(html).toContain('<ion-app>');
    expect(html).toContain('<ion-router-outlet>');
    expect(tree.read('apps/field-ops/src/app/app.module.ts', 'utf8')).toContain(
      'IonicRouteStrategy',
    );
    expect(tree.read('apps/field-ops/src/index.html', 'utf8')).toContain('viewport-fit=cover');
    expect(tree.read('apps/field-ops/src/styles.scss', 'utf8')).toContain(
      '@ionic/angular/css/core.css',
    );

    const cap = tree.read('apps/field-ops/capacitor.config.ts', 'utf8') ?? '';
    expect(cap).toContain("appId: 'com.example.fieldops'");
    expect(cap).toContain("appName: 'Field Ops'");
    expect(cap).toContain("webDir: '../../dist/apps/field-ops'");

    const appPkg = readJson(tree, 'apps/field-ops/package.json');
    expect(appPkg.private).toBe(true);
    for (const p of ['@capacitor/core', '@capacitor/android', '@capacitor/ios']) {
      expect(appPkg.dependencies[p]).toBe('~5.7.0');
    }
    expect(appPkg.devDependencies['@capacitor/cli']).toBe('~5.7.0');
    expect(tree.read('apps/field-ops/.gitignore', 'utf8')).toContain('node_modules');
  });

  it('on an Angular 16 workspace: Ionic 7.8 and Capacitor 6', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        scripts: {},
        dependencies: { '@angular/core': '~16.2.12' },
        devDependencies: { nx: '17.0.6' },
      }),
    );
    await appGenerator(tree, { name: 'field-ops', type: 'ionic' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@ionic/angular']).toBe('~7.8.6');
    expect(pkg.dependencies['@angular/forms']).toBe('~16.2.12');
    expect(pkg.devDependencies.typescript).toBe('~5.1.6');
    const appPkg = readJson(tree, 'apps/field-ops/package.json');
    expect(appPkg.dependencies['@capacitor/core']).toBe('^6.0.0');
    expect(appPkg.devDependencies['@capacitor/cli']).toBe('^6.0.0');
  });

  it('uses --appId when given', async () => {
    await appGenerator(tree, { name: 'field-ops', type: 'ionic', appId: 'com.acme.field' });
    expect(tree.read('apps/field-ops/capacitor.config.ts', 'utf8')).toContain(
      "appId: 'com.acme.field'",
    );
  });

  it('rejects an invalid --appId', async () => {
    await expect(
      appGenerator(tree, { name: 'field-ops', type: 'ionic', appId: 'not an id' }),
    ).rejects.toThrow(/appId/);
  });

  it('has build/serve/release like Angular plus capacitor targets', async () => {
    await appGenerator(tree, { name: 'field-ops', type: 'ionic' });
    const pj = readJson(tree, 'apps/field-ops/project.json');
    expect(pj.targets.build.executor).toBe('@angular-devkit/build-angular:browser');
    expect(pj.targets.release.options.type).toBe('ionic');
    expect(pj.targets.release.configurations.prod).toMatchObject({
      leakCheck: 'fail',
      sourceMaps: 'fail',
      stripComments: true,
      dropConsole: ['log', 'debug', 'warn'],
    });
    expect(readJson(tree, 'package.json').devDependencies.terser).toBe('^5.16.0');
    expect(pj.targets.release.options.buildTarget).toBe('field-ops:build');
    for (const [target, command] of [
      ['cap-sync', 'sync'],
      ['cap-open', 'open'],
      ['cap-add', 'add'],
    ]) {
      expect(pj.targets[target]).toEqual({
        executor: '@mouryaamit/nx-polystack:capacitor',
        options: { command },
      });
    }
    expect(pj.tags).toContain('platform:mobile');
    expect(pj.tags).not.toContain('platform:web');
    expect(pj.targets.build.options.assets).toContainEqual({
      glob: '**/*.svg',
      input: 'node_modules/ionicons/dist/ionicons/svg',
      output: './svg',
    });
  });

  it('adds release and native npm scripts', async () => {
    await appGenerator(tree, { name: 'field-ops', type: 'ionic' });
    const { scripts } = readJson(tree, 'package.json');
    expect(scripts['build:field-ops:prod']).toBe('nx run field-ops:release:prod');
    expect(scripts['build:field-ops:prod:android']).toBe(
      'nx run field-ops:release:prod && nx run field-ops:cap-sync --platform=android',
    );
    expect(scripts['build:field-ops:dev:ios']).toBe(
      'nx run field-ops:release:dev && nx run field-ops:cap-sync --platform=ios',
    );
    expect(scripts['open:field-ops:android']).toBe('nx run field-ops:cap-open --platform=android');
  });

  it('adds Angular 15 and @ionic/angular when missing, and returns an install callback', async () => {
    const cb = await appGenerator(tree, { name: 'field-ops', type: 'ionic' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('~15.2.0');
    expect(pkg.dependencies['@ionic/angular']).toBe('~7.8.0');
    expect(typeof cb).toBe('function');
  });

  it('adds @angular/forms at the installed Angular version (an @ionic/angular peer)', async () => {
    tree.write(
      'package.json',
      JSON.stringify({ scripts: {}, dependencies: { '@angular/core': '~15.1.0' } }),
    );
    await appGenerator(tree, { name: 'field-ops', type: 'ionic' });
    expect(readJson(tree, 'package.json').dependencies['@angular/forms']).toBe('~15.1.0');
  });

  it('builds a valid default appId from names starting with a digit', async () => {
    await appGenerator(tree, { name: '9-lives', type: 'ionic' });
    expect(tree.read('apps/9-lives/capacitor.config.ts', 'utf8')).toContain(
      "appId: 'com.example.app9lives'",
    );
  });

  it('keeps an existing @ionic/angular version', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        scripts: {},
        dependencies: { '@angular/core': '~15.2.0', '@ionic/angular': '~7.5.0' },
      }),
    );
    await appGenerator(tree, { name: 'field-ops', type: 'ionic' });
    expect(readJson(tree, 'package.json').dependencies['@ionic/angular']).toBe('~7.5.0');
  });
});
