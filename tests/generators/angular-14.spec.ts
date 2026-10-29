import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import appGenerator from '../../src/generators/app/generator';
import libGenerator from '../../src/generators/lib/generator';
import presetGenerator from '../../src/generators/preset/generator';
import { angularGeneratorVersions } from '../../src/lib/utils/angular-deps';

/** A workspace on Angular 14 (what `pstack new --angular=14` declares). */
function workspace14(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/source',
      scripts: {},
      dependencies: { '@angular/core': '~14.3.0' },
      devDependencies: { nx: '17.0.6' },
    }),
  );
  tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  return tree;
}

const json = (tree: Tree, file: string) => JSON.parse(tree.read(file, 'utf8') ?? '{}');

describe('Angular 14 (NX-106)', () => {
  it('generator versions: Angular 14.3, TypeScript 4.8, zone.js 0.11, Ionic 7.8, Capacitor 5', () => {
    expect(angularGeneratorVersions(14)).toEqual({
      angular: '~14.3.0',
      angularCli: '~14.2.13',
      zoneJs: '~0.11.4',
      typescript: '~4.8.4',
      typesNode: '~18.16.9',
      angularEslint: '~14.4.0',
      ionicAngular: '~7.8.6',
      capacitor: '^5.0.0',
    });
  });

  it('apps load zone.js from src/polyfills.ts and target ES2020', async () => {
    const tree = workspace14();
    await appGenerator(tree, { name: 'web', type: 'angular' });
    const pj = json(tree, 'apps/web/project.json');
    expect(pj.targets.build.options.polyfills).toBe('apps/web/src/polyfills.ts');
    expect(pj.targets.serve.configurations.development).toEqual({
      browserTarget: 'web:build:development',
    });
    expect(tree.read('apps/web/src/polyfills.ts', 'utf8')).toContain("import 'zone.js';");
    expect(json(tree, 'apps/web/tsconfig.app.json').files).toEqual([
      'src/main.ts',
      'src/polyfills.ts',
    ]);
    expect(json(tree, 'apps/web/tsconfig.json').compilerOptions.target).toBe('es2020');
    expect(tree.exists('apps/web/src/app/app.module.ts')).toBe(true);
    const pkg = readJson(tree, 'package.json');
    // The CLI's last 14.x is 14.2.13 (no 14.3.0 exists), the compiler follows the framework.
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~14.2.13');
    expect(pkg.devDependencies['@angular/cli']).toBe('~14.2.13');
    expect(pkg.devDependencies['@angular/compiler-cli']).toBe('~14.3.0');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~14.4.0');
    expect(pkg.dependencies['zone.js']).toBe('~0.11.4');
  });

  it('Ionic apps on 14 get Ionic 7.8 and Capacitor 5', async () => {
    const tree = workspace14();
    await appGenerator(tree, { name: 'mobile', type: 'ionic' });
    expect(readJson(tree, 'package.json').dependencies['@ionic/angular']).toBe('~7.8.6');
    expect(json(tree, 'apps/mobile/package.json').dependencies['@capacitor/core']).toBe('^5.0.0');
    expect(json(tree, 'apps/mobile/project.json').targets.build.options.polyfills).toBe(
      'apps/mobile/src/polyfills.ts',
    );
  });

  it('refuses standalone code on 14', async () => {
    const tree = workspace14();
    await expect(
      appGenerator(tree, { name: 'web', type: 'angular', standalone: true }),
    ).rejects.toThrow(
      /standalone components need Angular 15 or later \(the workspace is on Angular 14\)/,
    );
    await expect(
      libGenerator(tree, { name: 'ui', type: 'angular', standalone: true }),
    ).rejects.toThrow(/standalone components need Angular 15/);
    const fresh = createTreeWithEmptyWorkspace();
    await expect(presetGenerator(fresh, { angular: 14, standalone: true })).rejects.toThrow(
      /preset: standalone components need Angular 15/,
    );
  });

  it('library starters: NgModules with forRoot(), no provide*() functions, ES2020', async () => {
    const tree = workspace14();
    await libGenerator(tree, { name: 'pii', type: 'pii' });
    await libGenerator(tree, { name: 'session', type: 'session' });
    const root = (n: string) =>
      tree.exists(`libs/shared/${n}/src/index.ts`) ? `libs/shared/${n}` : `libs/${n}`;
    for (const [lib, providers] of [
      ['pii', 'pii-mask.providers'],
      ['session', 'session-timeout.providers'],
    ]) {
      const r = root(lib);
      expect(tree.exists(`${r}/src/lib/${providers}.ts`)).toBe(false);
      expect(tree.read(`${r}/src/index.ts`, 'utf8')).not.toContain('providers');
      expect(tree.read(`${r}/src/index.ts`, 'utf8')).toContain('.module');
      expect(json(tree, `${r}/tsconfig.json`).compilerOptions.target).toBe('es2020');
    }
  });

  it('the NgRx state lib installs NgRx 14 and only its NgModule', async () => {
    const tree = workspace14();
    await libGenerator(tree, { name: 'orders', type: 'state', variant: 'ngrx' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@ngrx/store']).toBe('~14.3.0');
    expect(pkg.dependencies['@ngrx/effects']).toBe('~14.3.0');
    const index = tree
      .listChanges()
      .find((c) => c.path.endsWith('/src/index.ts') && c.path.includes('orders'));
    const text = index?.content?.toString() ?? '';
    expect(text).toContain('-state.module');
    expect(text).not.toContain('-state.providers');
    expect(
      tree.listChanges().some((c) => c.path.endsWith('-state.providers.ts') && c.type !== 'DELETE'),
    ).toBe(false);
  });

  it('pstack new --angular=14: Angular 14.3 on Nx 17.0.6 with TypeScript 4.8', async () => {
    const tree = createTreeWithEmptyWorkspace();
    await presetGenerator(tree, { angular: 14, infra: 'none' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('~14.3.0');
    expect(pkg.devDependencies['typescript']).toBe('~4.8.4');
    expect(pkg.devDependencies['nx']).toBe('~17.0.6');
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~14.2.13');
    expect(tree.read('.nvmrc', 'utf8')).toBe('20\n');
  });
});
