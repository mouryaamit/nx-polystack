import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';

const ROOT = 'libs/ionic/field-kit';

describe('lib generator --type=ionic', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('on Angular 21 imports IonicModule from @ionic/angular/lazy (Ionic 9)', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        dependencies: { '@angular/core': '~21.2.24' },
        devDependencies: { nx: '22.7.12' },
      }),
    );
    await libGenerator(tree, { name: 'field-kit', type: 'ionic' });
    expect(tree.read(`${ROOT}/src/lib/field-kit.module.ts`, 'utf8')).toContain(
      "import { IonicModule } from '@ionic/angular/lazy';",
    );
    expect(readJson(tree, 'package.json').dependencies['@ionic/angular']).toBe('^9.0.0');
  });

  it('creates an Angular lib importing IonicModule with a page component', async () => {
    await libGenerator(tree, { name: 'field-kit', type: 'ionic' });
    const mod = tree.read(`${ROOT}/src/lib/field-kit.module.ts`, 'utf8') ?? '';
    expect(mod).toContain("import { IonicModule } from '@ionic/angular';");
    expect(mod).toContain('imports: [CommonModule, IonicModule]');
    expect(mod).toContain('declarations: [FieldKitPage]');
    const page = tree.read(`${ROOT}/src/lib/field-kit/field-kit.page.ts`, 'utf8') ?? '';
    expect(page).toContain("selector: 'lib-field-kit'");
    expect(page).toContain('export class FieldKitPage {}');
    const html = tree.read(`${ROOT}/src/lib/field-kit/field-kit.page.html`, 'utf8') ?? '';
    for (const tag of [
      '<ion-header>',
      '<ion-toolbar>',
      '<ion-title>Field Kit</ion-title>',
      '<ion-content',
    ]) {
      expect(html).toContain(tag);
    }
    expect(tree.read(`${ROOT}/src/index.ts`, 'utf8')).toContain(
      "export * from './lib/field-kit/field-kit.page';",
    );
    expect(tree.exists(`${ROOT}/src/lib/field-kit/field-kit.component.ts`)).toBe(false);
  });

  it('defaults to the ionic scope and the mobile platform', async () => {
    await libGenerator(tree, { name: 'field-kit', type: 'ionic' });
    const pj = readJson(tree, `${ROOT}/project.json`);
    expect(pj.name).toBe('ionic-field-kit');
    expect(pj.tags).toEqual(['scope:ionic', 'type:ionic', 'platform:mobile']);
    expect(pj.targets.build.executor).toBe('@nx/angular:ng-packagr-lite');
    expect(
      readJson(tree, 'tsconfig.base.json').compilerOptions.paths['@acme/ionic-field-kit'],
    ).toEqual([`${ROOT}/src/index.ts`]);
  });

  it('adds @ionic/angular, @angular/forms and @angular/router', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        name: '@acme/source',
        dependencies: { '@angular/core': '~15.1.0' },
        devDependencies: { nx: '17.0.6' },
      }),
    );
    await libGenerator(tree, { name: 'field-kit', type: 'ionic' });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@ionic/angular']).toBe('~7.8.0');
    expect(pkg.dependencies['@angular/forms']).toBe('~15.1.0');
    expect(pkg.dependencies['@angular/router']).toBe('~15.1.0');
  });

  it('lets ESLint accept the Page class suffix', async () => {
    await libGenerator(tree, { name: 'field-kit', type: 'ionic' });
    const [tsOverride] = readJson(tree, `${ROOT}/.eslintrc.json`).overrides;
    expect(tsOverride.rules['@angular-eslint/component-class-suffix']).toEqual([
      'error',
      { suffixes: ['Page', 'Component'] },
    ]);
    expect(tree.read(`${ROOT}/src/lib/field-kit/field-kit.page.ts`, 'utf8')).toContain(
      'export class FieldKitPage',
    );
  });

  it('publishable: lists @ionic/angular as a peer', async () => {
    await libGenerator(tree, { name: 'field-kit', type: 'ionic', variant: 'publishable' });
    const pj = readJson(tree, `${ROOT}/project.json`);
    expect(pj.targets.build.executor).toBe('@nx/angular:package');
    expect(readJson(tree, `${ROOT}/package.json`).peerDependencies).toEqual({
      '@angular/common': '^15.2.0',
      '@angular/core': '^15.2.0',
      '@ionic/angular': '^7.8.0',
    });
  });

  it('internal: lint target only', async () => {
    await libGenerator(tree, { name: 'field-kit', type: 'ionic', variant: 'internal' });
    expect(Object.keys(readJson(tree, `${ROOT}/project.json`).targets)).toEqual([
      'lint',
      'typecheck',
    ]);
    expect(tree.exists(`${ROOT}/ng-package.json`)).toBe(false);
  });
});
