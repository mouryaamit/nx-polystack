import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import type { AngularProject } from '../../../src/generators/migrate/adapters/angular-cli';
import { angularCodeNotes } from '../../../src/generators/migrate/angular-code-scan';
import {
  convertAngular17Project,
  serverRendering,
  serverRenderingError,
  typeScript4Config,
} from '../../../src/generators/migrate/angular17';

const app = (architect: Record<string, unknown>): AngularProject =>
  ({ projectType: 'application', root: 'projects/web', architect } as AngularProject);

describe('Angular 17+ builders', () => {
  it('converts browser-esbuild with application options, index and outputPath objects', () => {
    const { project, notes } = convertAngular17Project(
      app({
        build: {
          builder: '@angular-devkit/build-angular:browser-esbuild',
          options: {
            browser: 'projects/web/src/main.ts',
            polyfills: 'zone.js',
            index: { input: 'projects/web/src/index.html', output: 'main.html' },
            outputPath: { base: 'dist/web', browser: 'public', media: 'media' },
            ssr: false,
          },
        },
      }),
      'web',
    );
    expect(project.architect?.['build']).toEqual({
      builder: '@angular-devkit/build-angular:browser',
      options: {
        main: 'projects/web/src/main.ts',
        polyfills: ['zone.js'],
        index: { input: 'projects/web/src/index.html', output: 'main.html' },
        outputPath: 'dist/web',
        tsConfig: 'projects/web/tsconfig.app.json',
        aot: true,
      },
    });
    expect(notes).toEqual([
      'target "build": @angular-devkit/build-angular:browser-esbuild became ' +
        '@angular-devkit/build-angular:browser (the workspace builds with Angular 15). The output ' +
        'is written to `outputPath` itself, not to a `browser/` folder inside it.',
      'target "build": `outputPath` sub-folders (browser, media) dropped; only `base` kept.',
      'target "build": option `ssr` dropped (the Angular 15 browser builder has no such option).',
    ]);
  });

  it('fills the options the browser builder needs', () => {
    const { project } = convertAngular17Project(
      {
        projectType: 'application',
        root: '',
        sourceRoot: 'src',
        targets: { build: { executor: '@angular/build:application', options: {} } },
      } as AngularProject,
      'shop',
    );
    expect(project.targets?.['build'].options).toEqual({
      main: 'src/main.ts',
      index: 'src/index.html',
      outputPath: 'dist/shop',
      tsConfig: 'tsconfig.app.json',
      aot: true,
    });
  });

  it('leaves Angular 15 projects alone', () => {
    const input = app({
      build: { builder: '@angular-devkit/build-angular:browser', options: { main: 'x.ts' } },
      serve: {
        builder: '@angular-devkit/build-angular:dev-server',
        options: { browserTarget: 'web:build' },
      },
      lint: { builder: '@angular-eslint/builder:lint', options: { buildTarget: 'kept' } },
    });
    const { project, notes } = convertAngular17Project(input, 'web');
    expect(project).toEqual(input);
    expect(notes).toEqual([]);
  });

  it('finds server rendering in options, configurations and targets', () => {
    const build = (options: Record<string, unknown>, configurations = {}) =>
      app({ build: { builder: '@angular/build:application', options, configurations } });
    expect(serverRendering(build({ ssr: false, prerender: false }))).toBeUndefined();
    expect(serverRendering(build({ server: 'src/main.server.ts' }))).toBe(
      'target "build" sets "server"',
    );
    expect(serverRendering(build({}, { production: { appShell: true } }))).toBe(
      'target "build" sets "appShell"',
    );
    expect(
      serverRendering(
        app({
          build: { builder: '@angular/build:application', options: {} },
          'app-shell': { builder: '@angular-devkit/build-angular:app-shell' },
        }),
      ),
    ).toBe('target "app-shell" uses @angular-devkit/build-angular:app-shell');
    // Angular 15 Universal apps keep their builders: not checked.
    expect(
      serverRendering(
        app({
          build: { builder: '@angular-devkit/build-angular:browser', options: {} },
          server: { builder: '@angular-devkit/build-angular:server' },
        }),
      ),
    ).toBeUndefined();
    // The browser builder's options are not application-builder ones.
    expect(
      serverRendering(
        app({ build: { builder: '@angular-devkit/build-angular:browser', options: { ssr: {} } } }),
      ),
    ).toBeUndefined();
    expect(serverRenderingError(build({ prerender: true }))).toContain(
      'Angular SSR apps are not supported',
    );
  });
});

describe('TypeScript 5 compilerOptions', () => {
  it('replaces or removes them', () => {
    const out = typeScript4Config(
      {
        extends: '../../tsconfig.base.json',
        compilerOptions: {
          module: 'Preserve',
          moduleResolution: 'Bundler',
          allowImportingTsExtensions: true,
          strict: true,
        },
      },
      'apps/web/tsconfig.json',
    );
    expect(out.config).toEqual({
      extends: '../../tsconfig.base.json',
      compilerOptions: { module: 'es2022', moduleResolution: 'node', strict: true },
    });
    expect(out.notes).toHaveLength(3);
  });

  it('brings ES2023+ target and lib down to ES2022', () => {
    const out = typeScript4Config(
      { compilerOptions: { target: 'ES2023', lib: ['ES2023', 'es2023.array', 'ES2022', 'dom'] } },
      'x',
    );
    expect(out.config).toEqual({ compilerOptions: { target: 'es2022', lib: ['es2022', 'dom'] } });
    expect(typeScript4Config({ compilerOptions: { module: 'preserve' } }, 'x').config).toEqual({
      compilerOptions: { module: 'es2022', moduleResolution: 'node' },
    });
  });

  it('returns the same object when nothing changes', () => {
    const config = { compilerOptions: { moduleResolution: 'node' } };
    expect(typeScript4Config(config, 'x').config).toBe(config);
  });
});

describe('Angular 16+ code scan', () => {
  it('finds control flow (also in inline templates), newer APIs and entry points', () => {
    const tree = createTreeWithEmptyWorkspace();
    const files: Record<string, string> = {
      'src/a.component.ts':
        "import { Component, Input } from '@angular/core';\n" +
        "@Component({ selector: 'a', template: `@for (x of xs; track x) { {{ x }} }` })\n" +
        'export class A { @Input() xs: string[] = []; }\n',
      'src/b.component.html':
        '<a href="mailto:me@if.example">mail</a> <p *ngIf="x">ok</p>\n' +
        '<p>Write to us @for questions, or @if you like.</p>\n',
      'src/e.ts': "export { signal } from '@angular/core';\n",
      'src/c.ts':
        "import type { Signal } from '@angular/core';\n" +
        "import { type WritableSignal, signal as s, effect } from '@angular/core';\n" +
        "import { withFetch } from '@angular/common/http';\n" +
        "import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';\n",
      'src/d.html': '@let total = 1;\n',
      'src/types.d.ts': "import { signal } from '@angular/core';\n",
    };
    for (const [f, text] of Object.entries(files)) tree.write(`apps/web/${f}`, text);
    const notes = angularCodeNotes(tree, 'apps/web', Object.keys(files), '`web`');
    expect(notes).toEqual([
      '`web`: Angular 17 template syntax (`@if`, `@for`, `@switch`, `@defer`, `@let`) in ' +
        '`apps/web/src/a.component.ts`, `apps/web/src/d.html`. Angular 15 does not compile it: ' +
        'rewrite to `*ngIf`, `*ngFor` and `[ngSwitch]` (`@defer` has no Angular 15 equivalent).',
      '`web`: Angular 16+ APIs `Signal`, `WritableSignal`, `effect`, `signal`, `withFetch` used in ' +
        '`apps/web/src/c.ts`, `apps/web/src/e.ts`. ' +
        'Angular 15 does not have them.',
      '`web`: Angular 17+ APIs `provideAnimationsAsync` used in `apps/web/src/c.ts`. Angular 15 ' +
        'does not have them.',
      '`web`: `@angular/platform-browser/animations/async` (Angular 17+) imported in ' +
        '`apps/web/src/c.ts`. Angular 15 does not have it.',
    ]);
  });

  it('says nothing for Angular 15 code', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write('apps/web/src/a.ts', "import { Component, inject } from '@angular/core';\n");
    expect(angularCodeNotes(tree, 'apps/web', ['src/a.ts'])).toEqual([]);
  });
});
