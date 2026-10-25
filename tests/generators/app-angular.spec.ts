import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import appGenerator from '../../src/generators/app/generator';

describe('app generator --type=angular', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: {} }));
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('generates apps/<name>/src/index.html with filled title', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    expect(tree.exists('apps/my-app/src/index.html')).toBe(true);
    const html = tree.read('apps/my-app/src/index.html')!.toString();
    expect(html).toContain('My App');
  });

  it('generates environment files for all three tiers', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    expect(tree.exists('environments/my-app/environment.ts')).toBe(true);
    expect(tree.exists('environments/my-app/environment.uat.ts')).toBe(true);
    expect(tree.exists('environments/my-app/environment.prod.ts')).toBe(true);
    const envContent = tree.read('environments/my-app/environment.ts')!.toString();
    expect(envContent).toContain('export const environment');
  });

  it('build is the Angular builder and release wraps it with the plugin executor', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const pj = JSON.parse(tree.read('apps/my-app/project.json')!.toString());
    expect(pj.targets.build.executor).toBe('@angular-devkit/build-angular:browser');
    expect(pj.targets.build.options.main).toBe('apps/my-app/src/main.ts');
    expect(tree.read('apps/my-app/src/main.ts', 'utf8')).toMatch(
      /^\/\/ .*\nimport '@mouryaamit\/nx-polystack\/runtime\/csp-nonce';\n/,
    );
    expect(pj.targets.release.executor).toBe('@mouryaamit/nx-polystack:build');
    expect(pj.targets.release.options.buildTarget).toBe('my-app:build');
    expect(pj.targets.serve.configurations.production.browserTarget).toBe(
      'my-app:build:production',
    );
  });

  it('project.json has build configurations (production / uat / development) and release configurations (dev / uat / prod)', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const pj = JSON.parse(tree.read('apps/my-app/project.json')!.toString());
    expect(pj.targets.build.configurations).toHaveProperty('production');
    expect(pj.targets.build.configurations).toHaveProperty('uat');
    expect(pj.targets.build.configurations).toHaveProperty('development');
    expect(pj.targets.release.configurations).toHaveProperty('dev');
    expect(pj.targets.release.configurations).toHaveProperty('uat');
    expect(pj.targets.release.configurations).toHaveProperty('prod');
    expect(pj.targets.release.configurations.dev.env).toBe('DEV');
    expect(pj.targets.release.configurations.prod.env).toBe('PROD');
  });

  it('turns on release hardening for uat and prod and adds terser', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const { configurations } = JSON.parse(tree.read('apps/my-app/project.json')!.toString()).targets
      .release;
    const hardening = {
      leakCheck: 'fail',
      sourceMaps: 'fail',
      stripComments: true,
      dropConsole: ['log', 'debug', 'warn'],
    };
    expect(configurations.uat).toMatchObject(hardening);
    expect(configurations.prod).toMatchObject(hardening);
    expect(configurations.dev).toEqual({ env: 'DEV', buildConfiguration: 'development' });
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.devDependencies.terser).toBe('^5.16.0');
  });

  it('keeps a terser version the workspace already declares', async () => {
    tree.write(
      'package.json',
      JSON.stringify({ scripts: {}, devDependencies: { terser: '5.19.2' } }),
    );
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    expect(JSON.parse(tree.read('package.json')!.toString()).devDependencies.terser).toBe('5.19.2');
  });

  it('adds 6 npm scripts to root package.json', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.scripts).toHaveProperty('serve:my-app');
    expect(pkg.scripts).toHaveProperty('build:my-app:dev');
    expect(pkg.scripts).toHaveProperty('build:my-app:uat');
    expect(pkg.scripts).toHaveProperty('build:my-app:prod');
    expect(pkg.scripts).toHaveProperty('build:my-app:prod:secure');
    expect(pkg.scripts).toHaveProperty('build:my-app:prod:secure:sri');
    expect(pkg.scripts['build:my-app:prod']).toBe('nx run my-app:release:prod');
    expect(pkg.scripts['build:my-app:prod:secure']).toBe('nx run my-app:release:prod --secure');
    expect(pkg.scripts['build:my-app:prod:secure:sri']).toBe(
      'nx run my-app:release:prod --secure --sri',
    );
  });

  it('adds Angular packages when missing and returns an install callback', async () => {
    const cb = await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.dependencies['@angular/core']).toBe('~15.2.0');
    expect(typeof cb).toBe('function');
  });

  it('leaves an Angular major the generators do not support alone (adds only terser)', async () => {
    tree.write(
      'package.json',
      JSON.stringify({ scripts: {}, dependencies: { '@angular/core': '~22.0.0' } }),
    );
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.dependencies).toEqual({ '@angular/core': '~22.0.0' });
    expect(pkg.devDependencies).toEqual({ terser: '^5.16.0' });
  });

  it('on Angular 17, serve and extract-i18n use buildTarget (browserTarget below 17)', async () => {
    await appGenerator(tree, { name: 'old', type: 'angular' });
    const old = JSON.parse(tree.read('apps/old/project.json')!.toString());
    expect(old.targets.serve.configurations.production).toEqual({
      browserTarget: 'old:build:production',
    });
    tree.write(
      'package.json',
      JSON.stringify({
        scripts: {},
        dependencies: { '@angular/core': '~17.3.12' },
        devDependencies: { nx: '18.3.5' },
      }),
    );
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const pj = JSON.parse(tree.read('apps/my-app/project.json')!.toString());
    expect(pj.targets.serve.configurations.development).toEqual({
      buildTarget: 'my-app:build:development',
    });
    expect(pj.targets['extract-i18n'].options).toEqual({ buildTarget: 'my-app:build' });
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~17.3.12');
    expect(pkg.devDependencies['@nx/angular']).toBe('18.3.5');
    expect(pkg.devDependencies.typescript).toBe('~5.4.5');
  });

  it('uses HttpClientModule below Angular 18 and provideHttpClient from 18', async () => {
    await appGenerator(tree, { name: 'old', type: 'angular' });
    const old = tree.read('apps/old/src/app/app.module.ts', 'utf8') ?? '';
    expect(old).toContain('imports: [BrowserModule, HttpClientModule, AppRoutingModule]');
    expect(old).not.toContain('provideHttpClient');
    tree.write(
      'package.json',
      JSON.stringify({
        scripts: {},
        dependencies: { '@angular/core': '~18.2.14' },
        devDependencies: { nx: '19.8.14' },
      }),
    );
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const mod = tree.read('apps/my-app/src/app/app.module.ts', 'utf8') ?? '';
    expect(mod).not.toContain('HttpClientModule');
    expect(mod).toMatch(
      /import \{\s*provideHttpClient,\s*withInterceptorsFromDi,?\s*\} from '@angular\/common\/http';/,
    );
    expect(mod).toContain('imports: [BrowserModule, AppRoutingModule]');
    expect(mod).toContain('providers: [provideHttpClient(withInterceptorsFromDi())]');
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~18.2.14');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~18.4.3');
    expect(pkg.devDependencies.typescript).toBe('~5.5.4');
  });

  it('marks the NgModule-declared root component standalone: false from Angular 19', async () => {
    await appGenerator(tree, { name: 'old', type: 'angular' });
    expect(tree.read('apps/old/src/app/app.component.ts', 'utf8')).not.toContain('standalone');
    tree.write(
      'package.json',
      JSON.stringify({
        scripts: {},
        dependencies: { '@angular/core': '~19.2.25' },
        devDependencies: { nx: '20.8.4' },
      }),
    );
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    expect(tree.read('apps/my-app/src/app/app.component.ts', 'utf8')).toContain(
      '  standalone: false,\n})',
    );
    const lintRules = (app: string) =>
      JSON.parse(tree.read(`apps/${app}/.eslintrc.json`, 'utf8') ?? '{}').overrides[0].rules;
    expect(lintRules('old')['@angular-eslint/prefer-standalone']).toBeUndefined();
    expect(lintRules('my-app')['@angular-eslint/prefer-standalone']).toBe('off');
    const mod = tree.read('apps/my-app/src/app/app.module.ts', 'utf8') ?? '';
    expect(mod).toContain('declarations: [AppComponent]');
    expect(mod).toContain('providers: [provideHttpClient(withInterceptorsFromDi())]');
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~19.2.25');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~19.8.1');
    expect(pkg.devDependencies.typescript).toBe('~5.8.3');
  });

  it('on Angular 20: Nx 21 lint packages, TypeScript 5.9 and prefer-standalone off', async () => {
    tree.write(
      'package.json',
      JSON.stringify({
        scripts: {},
        dependencies: { '@angular/core': '~20.3.32' },
        devDependencies: { nx: '21.6.11' },
      }),
    );
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const rules = JSON.parse(tree.read('apps/my-app/.eslintrc.json', 'utf8') ?? '{}').overrides[0]
      .rules;
    expect(rules['@angular-eslint/prefer-standalone']).toBe('off');
    expect(tree.read('apps/my-app/src/app/app.component.ts', 'utf8')).toContain(
      '  standalone: false,\n})',
    );
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.dependencies['zone.js']).toBe('~0.15.0');
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~20.3.32');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~20.7.0');
    expect(pkg.devDependencies['@nx/angular']).toBe('21.6.11');
    expect(pkg.devDependencies.typescript).toBe('~5.9.3');
  });

  it('on Angular 21: keeps zone.js change detection in bootstrapModule', async () => {
    await appGenerator(tree, { name: 'old', type: 'angular' });
    expect(tree.read('apps/old/src/main.ts', 'utf8')).not.toContain('provideZoneChangeDetection');
    tree.write(
      'package.json',
      JSON.stringify({
        scripts: {},
        dependencies: { '@angular/core': '~21.2.24' },
        devDependencies: { nx: '22.7.12' },
      }),
    );
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const main = tree.read('apps/my-app/src/main.ts', 'utf8') ?? '';
    expect(main).toContain(
      "import { enableProdMode, provideZoneChangeDetection } from '@angular/core';",
    );
    expect(main).toContain(
      '.bootstrapModule(AppModule, {\n    applicationProviders: [provideZoneChangeDetection()],\n  })',
    );
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.dependencies['zone.js']).toBe('~0.16.0');
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~21.2.24');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('^21.0.0');
    expect(pkg.devDependencies['@nx/angular']).toBe('22.7.12');
  });

  it('adds @mouryaamit/<name> path alias to tsconfig.base.json', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    const tsconfig = JSON.parse(tree.read('tsconfig.base.json')!.toString());
    expect(tsconfig.compilerOptions.paths).toHaveProperty('@mouryaamit/my-app');
    expect(tsconfig.compilerOptions.paths['@mouryaamit/my-app']).toEqual(['apps/my-app/src']);
  });

  it('generates one htaccess.<env> per release env under environments/<app>/', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    expect(tree.exists('apps/my-app/src/.htaccess')).toBe(false);
    for (const env of ['dev', 'uat', 'prod']) {
      expect(tree.exists(`environments/my-app/htaccess.${env}`)).toBe(true);
    }
    const pj = JSON.parse(tree.read('apps/my-app/project.json', 'utf-8') as string);
    expect(JSON.stringify(pj.targets.build.options.assets ?? [])).not.toContain('htaccess');
    const htaccess = tree.read('environments/my-app/htaccess.prod')!.toString();
    expect(htaccess.startsWith('# Generated by pstack csp from csp-allowlist.json')).toBe(true);
    expect(htaccess).toContain('RewriteRule ^ index.html [L]');
    expect(htaccess).toContain("'nonce-%{CSP_NONCE}e'");
    expect(htaccess).toContain('X-Content-Type-Options');
  });

  it('generates server/nginx.conf', async () => {
    await appGenerator(tree, { name: 'my-app', type: 'angular' });
    expect(tree.exists('apps/my-app/server/nginx.conf')).toBe(true);
    const nginx = tree.read('apps/my-app/server/nginx.conf')!.toString();
    expect(nginx).toContain('try_files');
    expect(nginx).toContain('Content-Security-Policy');
  });

  it('--csp-connect-src populates csp-allowlist.json connect-src array', async () => {
    await appGenerator(tree, {
      name: 'my-app',
      type: 'angular',
      cspConnectSrc: 'https://api.example.com',
    });
    expect(tree.exists('apps/my-app/csp-allowlist.json')).toBe(true);
    const allowlist = JSON.parse(tree.read('apps/my-app/csp-allowlist.json')!.toString());
    expect(allowlist['connect-src']).toContain('https://api.example.com');
  });

  it('throws when project directory already exists', async () => {
    tree.write('apps/my-app/placeholder.txt', '');
    await expect(appGenerator(tree, { name: 'my-app', type: 'angular' })).rejects.toThrow(
      /apps\/my-app.*already exists/,
    );
  });
});
