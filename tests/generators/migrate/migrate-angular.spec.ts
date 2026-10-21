import * as fs from 'fs';
import * as path from 'path';

import { logger, readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { ANGULAR_SKIP } from '../../../src/generators/migrate/adapters/angular-cli';
import { copyIntoTree, shouldSkip } from '../../../src/generators/migrate/copy';
import migrateGenerator, {
  containsOrEquals,
  kebabName,
} from '../../../src/generators/migrate/generator';
import { LLM_END, LLM_START } from '../../../src/lib/utils/llm-block';

import { FIXTURES, fixtureCopy, put, putJson, readJsonFile, snapshot, tmpSource } from './helpers';

const HARDENED = {
  leakCheck: 'fail',
  sourceMaps: 'fail',
  stripComments: true,
  dropConsole: ['log', 'debug', 'warn'],
};

const FIXTURE = path.join(FIXTURES, 'angular15-app');

function workspace(): Tree {
  const tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  tree.write(
    'package.json',
    JSON.stringify({
      name: '@acme/workspace',
      scripts: { lint: 'nx run-many -t lint' },
      devDependencies: { nx: '~17.0.6', '@nx/eslint': '~17.0.6', prettier: '^3.0.0' },
    }),
  );
  tree.write(
    'tsconfig.base.json',
    JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@acme/ui': ['libs/shared/ui/src/index.ts'] } },
    }),
  );
  return tree;
}

const pkgOf = (tree: Tree) => readJson(tree, 'package.json');

describe('migrate generator: standalone Angular CLI app', () => {
  let tree: Tree;
  let info: jest.SpyInstance;

  beforeEach(() => {
    tree = workspace();
    info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('options', () => {
    it('--detect prints the table and writes nothing', async () => {
      const before = tree.listChanges().length;
      const cb = await migrateGenerator(tree, { source: FIXTURE, detect: true });
      expect(cb).toBeUndefined();
      expect(tree.listChanges().length).toBe(before);
      const out = info.mock.calls.map((c) => c[0]).join('\n');
      expect(out).toContain(
        'angular-cli        1.00        angular.json with one application project (legacy-portal)',
      );
      expect(out).toContain('flutter            0.00        no pubspec.yaml');
    });

    it('requires --source, and an existing directory', async () => {
      await expect(migrateGenerator(tree, { source: '' })).rejects.toThrow('--source is required');
      await expect(migrateGenerator(tree, { source: '/no/such/dir' })).rejects.toThrow(
        '--source "/no/such/dir" does not exist',
      );
      const file = path.join(tmpSource(), 'f.txt');
      fs.writeFileSync(file, '');
      await expect(migrateGenerator(tree, { source: file })).rejects.toThrow('is not a directory');
    });

    it('fails below the confidence threshold, writing nothing', async () => {
      const src = tmpSource();
      put(src, 'README.md', '# nothing to see');
      await expect(migrateGenerator(tree, { source: src })).rejects.toThrow(
        /no adapter is confident enough[\s\S]*--adapter=<angular-cli\|flutter\|nx-workspace\|angular-workspace\|ionic\|npm-workspaces>/,
      );
      expect(tree.exists('apps/README.md')).toBe(false);
    });

    it('--adapter migrates a source below the threshold (an Ionic app without Capacitor)', async () => {
      const src = fixtureCopy('angular15-app');
      put(src, 'ionic.config.json', '{}');
      await expect(migrateGenerator(tree, { source: src })).rejects.toThrow(/Ionic\/Capacitor app/);
      await migrateGenerator(tree, { source: src, adapter: 'angular-cli' });
      expect(tree.exists('apps/legacy-portal/project.json')).toBe(true);
      expect(tree.read('docs/migrations/legacy-portal.md', 'utf8')).toContain(
        '- Confidence: 0.50 (selected with `--adapter`)',
      );
    });

    it('--adapter=angular-cli on a multi-project angular.json fails clearly', async () => {
      const src = fixtureCopy('angular15-app');
      const ws = readJsonFile<{ projects: Record<string, unknown> }>(src, 'angular.json');
      ws.projects['admin'] = { projectType: 'application', root: 'projects/admin' };
      putJson(src, 'angular.json', ws);
      await expect(
        migrateGenerator(tree, { source: src, adapter: 'angular-cli', name: 'x' }),
      ).rejects.toThrow(
        'needs exactly one application project in angular.json; found 2 (legacy-portal, admin)',
      );
    });

    describe('Angular 17+ sources', () => {
      /** The fixture, as `ng new` writes it from Angular 18 (application builder, @angular/build). */
      function angular18Source(): string {
        const src = fixtureCopy('angular15-app');
        const ws = readJsonFile<{
          projects: Record<string, { architect: Record<string, unknown> }>;
        }>(src, 'angular.json');
        ws.projects['legacy-portal'].architect = {
          build: {
            builder: '@angular/build:application',
            options: {
              outputPath: { base: 'dist/legacy-portal', browser: '' },
              index: 'src/index.html',
              browser: 'src/main.ts',
              polyfills: ['zone.js'],
              tsConfig: 'tsconfig.app.json',
              inlineStyleLanguage: 'scss',
              assets: [{ glob: '**/*', input: 'public' }, 'src/favicon.ico'],
              styles: ['src/styles.scss'],
              scripts: [],
              stylePreprocessorOptions: {
                includePaths: ['src/styles'],
                sass: { silenceDeprecations: [] },
              },
              define: { BUILD: '"x"' },
              serviceWorker: 'ngsw-config.json',
            },
            configurations: {
              production: { outputHashing: 'all', loader: { '.svg': 'text' } },
              development: { optimization: false, extractLicenses: false, sourceMap: true },
            },
            defaultConfiguration: 'production',
          },
          serve: {
            builder: '@angular/build:dev-server',
            options: { prebundle: false },
            configurations: {
              production: { buildTarget: 'legacy-portal:build:production' },
              development: { buildTarget: 'legacy-portal:build:development' },
            },
            defaultConfiguration: 'development',
          },
          'extract-i18n': { builder: '@angular/build:extract-i18n' },
          test: {
            builder: '@angular-devkit/build-angular:karma',
            options: {
              polyfills: ['zone.js', 'zone.js/testing'],
              tsConfig: 'tsconfig.spec.json',
              assets: [{ glob: '**/*', input: 'public' }],
              builderMode: 'application',
            },
          },
          vitest: { builder: '@angular/build:unit-test', options: {} },
        };
        (ws.projects['legacy-portal'] as Record<string, unknown>)['i18n'] = {
          sourceLocale: { code: 'en', subPath: '' },
        };
        putJson(src, 'angular.json', ws);
        put(src, 'public/robots.txt', 'User-agent: *\n');
        const tsconfig = fs.readFileSync(path.join(src, 'tsconfig.json'), 'utf8');
        put(
          src,
          'tsconfig.json',
          tsconfig.replace(
            '"moduleResolution": "node",',
            '"moduleResolution": "bundler",\n    "verbatimModuleSyntax": true,',
          ),
        );
        put(
          src,
          'src/app/app.component.html',
          '@if (user(); as u) {\n  <p>{{ u }}</p>\n} @else {\n  <p>none</p>\n}\n',
        );
        put(
          src,
          'src/app/app.component.ts',
          "import { Component, signal, input as inp } from '@angular/core';\n" +
            "import { toSignal } from '@angular/core/rxjs-interop';\n" +
            "@Component({ selector: 'app-root', templateUrl: './app.component.html' })\n" +
            'export class AppComponent { user = signal(1); name = inp(); }\n',
        );
        return src;
      }

      /** angular18Source with Angular 18 in its package.json, and a workspace on Angular 18. */
      function onAngular18(): string {
        const src = angular18Source();
        const pkg = readJsonFile<{ dependencies: Record<string, string> }>(src, 'package.json');
        for (const k of Object.keys(pkg.dependencies)) {
          if (k.startsWith('@angular/')) pkg.dependencies[k] = '^18.2.0';
        }
        putJson(src, 'package.json', pkg);
        const ws = pkgOf(tree);
        ws.dependencies = { ...(ws.dependencies ?? {}), '@angular/core': '~18.2.0' };
        tree.write('package.json', JSON.stringify(ws));
        return src;
      }

      it('keeps the application builder when the workspace is on Angular 17+', async () => {
        await migrateGenerator(tree, { source: onAngular18(), name: 'portal' });
        const pj = readJson(tree, 'apps/portal/project.json');
        expect(pj.targets.build.executor).toBe('@angular/build:application');
        expect(pj.targets.build.outputs).toEqual(['{options.outputPath.base}']);
        expect(pj.targets.build.options).toMatchObject({
          outputPath: { base: 'dist/apps/portal', browser: '' },
          browser: 'apps/portal/src/main.ts',
          index: 'apps/portal/src/index.html',
          serviceWorker: 'apps/portal/ngsw-config.json',
          define: { BUILD: '"x"' },
        });
        expect(pj.targets.build.options.main).toBeUndefined();
        expect(pj.targets.serve.executor).toBe('@angular/build:dev-server');
        expect(pj.targets.serve.configurations.development.buildTarget).toBe(
          'portal:build:development',
        );
        expect(pj.targets.release.options.outputPath).toBe('dist/apps/portal');
        expect(readJson(tree, 'apps/portal/tsconfig.json').compilerOptions).toMatchObject({
          moduleResolution: 'bundler',
          verbatimModuleSyntax: true,
        });
        const report = tree.read('docs/migrations/portal.md', 'utf8') ?? '';
        expect(report).not.toContain('became @angular-devkit/build-angular:browser');
      });

      it('converts the application builder to the Angular 15 browser builder', async () => {
        await migrateGenerator(tree, { source: angular18Source(), name: 'portal' });
        const pj = readJson(tree, 'apps/portal/project.json');
        expect(pj.targets.build.executor).toBe('@angular-devkit/build-angular:browser');
        expect(pj.targets.build.options).toMatchObject({
          outputPath: 'dist/apps/portal',
          index: 'apps/portal/src/index.html',
          main: 'apps/portal/src/main.ts',
          tsConfig: 'apps/portal/tsconfig.app.json',
          aot: true,
          serviceWorker: true,
          ngswConfigPath: 'apps/portal/ngsw-config.json',
          assets: [
            { glob: '**/*', input: 'apps/portal/public', output: '/' },
            'apps/portal/src/favicon.ico',
          ],
        });
        expect(pj.targets.build.options.browser).toBeUndefined();
        expect(pj.targets.build.options.define).toBeUndefined();
        expect(pj.targets.build.outputs).toEqual(['{options.outputPath}']);
        expect(pj.targets.build.configurations.production).toEqual({ outputHashing: 'all' });
        expect(pj.targets.build.configurations.development).toMatchObject({
          optimization: false,
          buildOptimizer: false,
          vendorChunk: true,
          namedChunks: true,
        });
        expect(pj.targets.serve.executor).toBe('@angular-devkit/build-angular:dev-server');
        expect(pj.targets.serve.options).toEqual({});
        expect(pj.targets.serve.configurations.production).toEqual({
          browserTarget: 'portal:build:production',
        });
        expect(pj.targets['extract-i18n'].executor).toBe(
          '@angular-devkit/build-angular:extract-i18n',
        );
        expect(pj.targets.test.executor).toBe('@angular-devkit/build-angular:karma');
        expect(pj.targets.test.options).toEqual({
          polyfills: ['zone.js', 'zone.js/testing'],
          tsConfig: 'apps/portal/tsconfig.spec.json',
          assets: [{ glob: '**/*', input: 'apps/portal/public', output: '/' }],
        });
        expect(pj.targets['extract-i18n'].options).toEqual({ browserTarget: 'portal:build' });
        expect(pj.targets.build.options.stylePreprocessorOptions).toEqual({
          includePaths: ['apps/portal/src/styles'],
        });
        expect(pj.targets.release.options.outputPath).toBe('dist/apps/portal');

        const ts = readJson(tree, 'apps/portal/tsconfig.json');
        expect(ts.compilerOptions.moduleResolution).toBe('node');
        expect(ts.compilerOptions.verbatimModuleSyntax).toBeUndefined();

        const report = tree.read('docs/migrations/portal.md', 'utf8') as string;
        for (const text of [
          'target "build": @angular/build:application became @angular-devkit/build-angular:browser',
          'option `define` dropped',
          'configuration "production": option `loader` dropped',
          'target "serve": `buildTarget` became `browserTarget`',
          'target "serve": option `prebundle` dropped',
          'target "test": option `builderMode` dropped',
          'target "extract-i18n": `browserTarget` added, pointing at the build target (Angular 15',
          'target "vitest": @angular/build:unit-test does not exist in Angular 15',
          '`stylePreprocessorOptions.sass` dropped',
          'i18n `subPath` (sourceLocale) is Angular 17.2+',
          '`moduleResolution: "bundler"` became `"node"`',
          '`verbatimModuleSyntax` removed',
          'Angular 17 template syntax',
          '`apps/portal/src/app/app.component.html`',
          'Angular 16+ APIs `signal` used in `apps/portal/src/app/app.component.ts`',
          'Angular 17+ APIs `input` used in',
          '`@angular/core/rxjs-interop` (Angular 16+) imported in `apps/portal/src/app/app.component.ts`',
        ]) {
          expect(report).toContain(text);
        }
        // `browser: ""` is the browser builder's layout already.
        expect(report).not.toContain('`outputPath` sub-folders');
      });

      it('refuses a server-rendered app before writing anything', async () => {
        const src = angular18Source();
        const ws = readJsonFile<{
          projects: Record<
            string,
            { architect: Record<string, { options: Record<string, unknown> }> }
          >;
        }>(src, 'angular.json');
        ws.projects['legacy-portal'].architect['build'].options['ssr'] = { entry: 'server.ts' };
        putJson(src, 'angular.json', ws);
        await expect(migrateGenerator(tree, { source: src, name: 'portal' })).rejects.toThrow(
          'migrate: the app renders on the server (target "build" sets "ssr"). Angular SSR apps ' +
            'are not supported',
        );
        expect(tree.exists('apps/portal')).toBe(false);
        expect(tree.exists('docs/migrations/portal.md')).toBe(false);
      });

      it('still migrates an Angular 15 Universal app (browser builder plus a server target)', async () => {
        const src = fixtureCopy('angular15-app');
        const ws = readJsonFile<{
          projects: Record<string, { architect: Record<string, unknown> }>;
        }>(src, 'angular.json');
        ws.projects['legacy-portal'].architect['server'] = {
          builder: '@angular-devkit/build-angular:server',
          options: { outputPath: 'dist/legacy-portal/server', main: 'server.ts' },
        };
        putJson(src, 'angular.json', ws);
        await migrateGenerator(tree, { source: src, name: 'portal' });
        const pj = readJson(tree, 'apps/portal/project.json');
        expect(pj.targets.server.executor).toBe('@angular-devkit/build-angular:server');
        expect(pj.targets.build.executor).toBe('@angular-devkit/build-angular:browser');
      });

      it('refuses an app with a server target', async () => {
        const src = angular18Source();
        const ws = readJsonFile<{
          projects: Record<string, { architect: Record<string, unknown> }>;
        }>(src, 'angular.json');
        ws.projects['legacy-portal'].architect['server'] = {
          builder: '@angular-devkit/build-angular:server',
          options: {},
        };
        putJson(src, 'angular.json', ws);
        await expect(migrateGenerator(tree, { source: src, name: 'portal' })).rejects.toThrow(
          'target "server" uses @angular-devkit/build-angular:server',
        );
      });

      it('still needs --force-angular when the workspace has another Angular major', async () => {
        const pkg = pkgOf(tree);
        pkg.dependencies = { '@angular/core': '~15.2.0' };
        tree.write('package.json', JSON.stringify(pkg));
        const src = angular18Source();
        const sp = readJsonFile<{ dependencies: Record<string, string> }>(src, 'package.json');
        sp.dependencies['@angular/core'] = '^18.2.0';
        putJson(src, 'package.json', sp);
        await expect(migrateGenerator(tree, { source: src, name: 'portal' })).rejects.toThrow(
          'the workspace uses Angular 15',
        );
        await migrateGenerator(tree, { source: src, name: 'portal', forceAngular: true });
        expect(readJson(tree, 'apps/portal/project.json').targets.build.executor).toBe(
          '@angular-devkit/build-angular:browser',
        );
      });
    });

    it('defaults the name to the Angular project name, kebab-cased', async () => {
      expect(kebabName('LegacyPortal')).toBe('legacy-portal');
      expect(kebabName('field_notes')).toBe('field-notes');
      expect(kebabName('my.app')).toBe('my-app');
      await migrateGenerator(tree, { source: FIXTURE });
      expect(tree.exists('apps/legacy-portal/project.json')).toBe(true);
    });

    it('validates --name', async () => {
      await expect(migrateGenerator(tree, { source: FIXTURE, name: 'Portal_App' })).rejects.toThrow(
        '--name="Portal_App" must be kebab-case',
      );
    });

    it('refuses an existing app folder or project name', async () => {
      tree.write('apps/portal/project.json', JSON.stringify({ name: 'portal' }));
      await expect(migrateGenerator(tree, { source: FIXTURE, name: 'portal' })).rejects.toThrow(
        '"apps/portal" already exists',
      );
      tree.write('libs/shared/thing/project.json', JSON.stringify({ name: 'thing' }));
      await expect(migrateGenerator(tree, { source: FIXTURE, name: 'thing' })).rejects.toThrow(
        'a project named "thing" already exists',
      );
    });

    it('refuses --source=/ (it contains every workspace)', async () => {
      await expect(migrateGenerator(tree, { source: '/' })).rejects.toThrow(
        'is the workspace or contains it',
      );
      expect(containsOrEquals('/', '/virtual')).toBe(true);
      expect(containsOrEquals('C:\\', 'C:\\ws')).toBe(path.sep === '\\');
      expect(containsOrEquals('/src/app', '/src/app-ws')).toBe(false);
    });

    it('fails over --max-files, and validates it', async () => {
      await expect(
        migrateGenerator(tree, { source: FIXTURE, name: 'portal', maxFiles: 5 }),
      ).rejects.toThrow('migrate: the source has more than 5 files to copy after the skip lists.');
      await expect(
        migrateGenerator(tree, { source: FIXTURE, name: 'portal', maxFiles: 0 }),
      ).rejects.toThrow('--max-files must be a positive whole number');
    });

    it('reports possible secrets, and the service configs the app still needs', async () => {
      const src = fixtureCopy('angular15-app');
      put(src, '.env', 'API_KEY=1');
      put(src, '.env.example', 'API_KEY=');
      put(src, '.npmrc', '//registry.example.com/:_authToken=x');
      put(src, 'src/google-services.json', '{}');
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(tree.exists('apps/portal/.env')).toBe(false);
      expect(tree.exists('apps/portal/.env.example')).toBe(true);
      const report = tree.read('docs/migrations/portal.md', 'utf8') ?? '';
      expect(report).toContain('- Possible secrets not copied: 3');
      expect(report).toContain('## Not copied: possible secrets');
      expect(report).toContain('- `.env`\n- `.npmrc`\n- `src/google-services.json`');
      expect(report).toContain(
        '`src/google-services.json` was not copied (it holds project credentials), but the app needs it',
      );
      expect(report).toContain('`.npmrc` was not copied (it can hold registry tokens).');
      expect(report).toContain(
        '- File list: all files except those the source .gitignore files ignore (not a git work tree)',
      );
    });

    it('refuses a source that is the workspace or contains it', async () => {
      const ws = tmpSource();
      const t = createTreeWithEmptyWorkspace();
      (t as unknown as { root: string }).root = path.join(ws, 'inner');
      fs.mkdirSync(path.join(ws, 'inner'));
      await expect(migrateGenerator(t, { source: ws })).rejects.toThrow(
        'is the workspace or contains it',
      );
    });
  });

  describe('copy', () => {
    it('skip rules: junk anywhere or at the top, workspace files at the top only', () => {
      expect(shouldSkip('node_modules', ANGULAR_SKIP)).toBe(true);
      expect(shouldSkip('src/app/node_modules', ANGULAR_SKIP)).toBe(true);
      expect(shouldSkip('.git', ANGULAR_SKIP)).toBe(true);
      for (const top of [
        'dist',
        '.angular',
        '.vscode',
        '.idea',
        'coverage',
        'package.json',
        'package-lock.json',
        'yarn.lock',
        'pnpm-lock.yaml',
        'angular.json',
        'tsconfig.json',
      ]) {
        expect([top, shouldSkip(top, ANGULAR_SKIP)]).toEqual([top, true]);
      }
      expect(shouldSkip('src/assets/package.json', ANGULAR_SKIP)).toBe(false);
      expect(shouldSkip('src/dist', ANGULAR_SKIP)).toBe(false);
      expect(shouldSkip('README.md', ANGULAR_SKIP)).toBe(false);
      expect(shouldSkip('tsconfig.app.json', ANGULAR_SKIP)).toBe(false);
    });

    it('copies the app and lists what it skipped', async () => {
      const src = fixtureCopy('angular15-app');
      for (const junk of [
        'node_modules/x/index.js',
        'dist/legacy-portal/main.js',
        '.angular/cache/x',
        '.git/HEAD',
        '.vscode/settings.json',
        '.idea/workspace.xml',
        'coverage/lcov.info',
        'package-lock.json',
        'yarn.lock',
        'src/app/node_modules/y.js',
      ]) {
        put(src, junk, 'junk');
      }
      fs.symlinkSync(path.join(src, 'README.md'), path.join(src, 'LINK.md'));
      const t = createTreeWithEmptyWorkspace();
      const r = copyIntoTree(t, src, 'apps/portal', ANGULAR_SKIP);
      expect(r.skipped).toEqual([
        '.angular/',
        '.git/',
        '.idea/',
        '.vscode/',
        'LINK.md (symlink)',
        'angular.json',
        'coverage/',
        'dist/',
        'node_modules/',
        'package-lock.json',
        'package.json',
        'src/app/node_modules/',
        'tsconfig.json',
        'yarn.lock',
      ]);
      expect(r.copied).toEqual([
        '.editorconfig',
        '.gitignore',
        'README.md',
        'src/app/app-routing.module.ts',
        'src/app/app.component.html',
        'src/app/app.component.scss',
        'src/app/app.component.spec.ts',
        'src/app/app.component.ts',
        'src/app/app.module.ts',
        'src/assets/.gitkeep',
        'src/environments/environment.prod.ts',
        'src/environments/environment.ts',
        'src/favicon.ico',
        'src/index.html',
        'src/main.ts',
        'src/styles.scss',
        'tsconfig.app.json',
        'tsconfig.spec.json',
      ]);
    });

    it('copies binary files byte for byte', async () => {
      const src = fixtureCopy('angular15-app');
      const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a, 0x0d, 0x1a, 0xc3, 0x28]);
      put(src, 'src/assets/blob.bin', bytes);
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(tree.read('apps/portal/src/assets/blob.bin')!.equals(bytes)).toBe(true);
      expect(
        tree
          .read('apps/portal/src/favicon.ico')!
          .equals(fs.readFileSync(path.join(FIXTURE, 'src/favicon.ico'))),
      ).toBe(true);
    });

    it('never modifies the source', async () => {
      const src = fixtureCopy('angular15-app');
      const before = snapshot(src);
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(snapshot(src)).toEqual(before);
    });
  });

  describe('the migrated app', () => {
    beforeEach(async () => {
      await migrateGenerator(tree, { source: FIXTURE, name: 'portal' });
    });

    it('writes project.json with every target, paths under apps/portal, release and lint, and tags', () => {
      const pj = readJson(tree, 'apps/portal/project.json');
      expect(Object.keys(pj.targets)).toEqual([
        'build',
        'serve',
        'extract-i18n',
        'test',
        'release',
        'lint',
      ]);
      expect(pj.tags).toEqual(['scope:app', 'type:app', 'platform:web']);
      expect(pj.targets.build.options.outputPath).toBe('dist/apps/portal');
      expect(pj.targets.build.configurations.production.fileReplacements).toEqual([
        {
          replace: 'apps/portal/src/environments/environment.ts',
          with: 'apps/portal/src/environments/environment.prod.ts',
        },
      ]);
      expect(pj.targets.serve.configurations.development.browserTarget).toBe(
        'portal:build:development',
      );
      expect(pj.targets.release.configurations).toEqual({
        prod: { env: 'PROD', buildConfiguration: 'production', ...HARDENED },
        dev: { env: 'DEV', buildConfiguration: 'development' },
      });
      expect(pj.targets.test.options.tsConfig).toBe('apps/portal/tsconfig.spec.json');
    });

    it('rewrites the tsconfigs for the new depth', () => {
      expect(readJson(tree, 'apps/portal/tsconfig.json')).toEqual({
        extends: '../../tsconfig.base.json',
        compileOnSave: false,
        compilerOptions: {
          forceConsistentCasingInFileNames: true,
          strict: true,
          noImplicitOverride: true,
          noPropertyAccessFromIndexSignature: true,
          noImplicitReturns: true,
          noFallthroughCasesInSwitch: true,
          sourceMap: true,
          declaration: false,
          downlevelIteration: true,
          experimentalDecorators: true,
          moduleResolution: 'node',
          importHelpers: true,
          target: 'ES2022',
          module: 'ES2022',
          useDefineForClassFields: false,
          lib: ['ES2022', 'dom'],
        },
        angularCompilerOptions: {
          enableI18nLegacyMessageIdFormat: false,
          strictInjectionParameters: true,
          strictInputAccessModifiers: true,
          strictTemplates: true,
        },
      });
      expect(readJson(tree, 'apps/portal/tsconfig.app.json')).toEqual({
        extends: './tsconfig.json',
        compilerOptions: { outDir: '../../dist/out-tsc', types: [] },
        files: ['src/main.ts'],
        include: ['src/**/*.d.ts'],
      });
      expect(readJson(tree, 'apps/portal/tsconfig.spec.json').compilerOptions.outDir).toBe(
        '../../dist/out-tsc',
      );
    });

    it('generates the polystack app .eslintrc.json when the source has none', () => {
      const eslint = readJson(tree, 'apps/portal/.eslintrc.json');
      expect(eslint.extends).toEqual(['../../.eslintrc.json']);
      expect(tree.read('apps/portal/.eslintrc.json', 'utf-8')).not.toContain('<%');
      expect(eslint.ignorePatterns).toEqual(['!**/*']);
      expect(eslint.overrides[0].rules['@angular-eslint/component-selector'][1].prefix).toBe('app');
    });

    it('adds the source dependencies and the Angular build/lint packages, keeping workspace versions', () => {
      const pkg = pkgOf(tree);
      expect(pkg.dependencies['@angular/core']).toBe('^15.2.0');
      expect(pkg.dependencies['zone.js']).toBe('~0.12.0');
      expect(pkg.devDependencies['karma']).toBe('~6.4.0');
      expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('^15.2.10');
      expect(pkg.devDependencies['@nx/angular']).toBe('~17.0.6');
      expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~15.2.0');
      expect(pkg.devDependencies['prettier']).toBe('^3.0.0');
      // The release target's hardening loads terser from the workspace.
      expect(pkg.devDependencies['terser']).toBe('^5.16.0');
    });

    it('adds serve and build npm scripts per release configuration', () => {
      const scripts = pkgOf(tree).scripts;
      expect(scripts).toEqual({
        lint: 'nx run-many -t lint',
        'serve:portal': 'nx serve portal',
        'build:portal:prod': 'nx run portal:release:prod',
        'build:portal:dev': 'nx run portal:release:dev',
        'build:portal:prod:secure': 'nx run portal:release:prod --secure',
        'build:portal:prod:secure:sri': 'nx run portal:release:prod --secure --sri',
      });
    });

    it('does not add tsconfig paths when the source has none', () => {
      expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({
        '@acme/ui': ['libs/shared/ui/src/index.ts'],
      });
    });

    it('keeps the source environments where they are', () => {
      expect(tree.exists('apps/portal/src/environments/environment.prod.ts')).toBe(true);
      expect(tree.exists('environments/portal')).toBe(false);
    });

    it('writes a deterministic report', () => {
      const report = tree.read('docs/migrations/portal.md', 'utf8')!;
      expect(report).toContain(`- Source: \`${FIXTURE}\``);
      expect(report).toContain('- Adapter: `angular-cli` (standalone Angular CLI app)');
      expect(report).toContain('- Confidence: 1.00\n');
      expect(report).toContain('- Files copied: 18');
      expect(report).toContain('- Paths skipped: 3');
      expect(report).toContain('- `angular.json`\n- `package.json`\n- `tsconfig.json`');
      expect(report).toContain('- `@angular/core`');
      expect(report).toContain('- `@nx/angular`');
      expect(report).toContain('- `start`: `ng serve`');
      expect(report).toContain("The workspace had no Angular; the source's versions were added");
      expect(report).toContain('- [ ] `npx nx build portal`');
      expect(report).toContain('- [ ] `npx nx lint portal`');
      expect(report).toContain('`pstack env --name=<env>`');
      expect(report).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

      const again = workspace();
      return migrateGenerator(again, { source: FIXTURE, name: 'portal' }).then(() =>
        expect(again.read('docs/migrations/portal.md', 'utf8')).toBe(report),
      );
    });

    it('returns an install callback', async () => {
      const t = workspace();
      expect(typeof (await migrateGenerator(t, { source: FIXTURE, name: 'portal' }))).toBe(
        'function',
      );
    });
  });

  describe('workspace merges', () => {
    it('merges tsconfig paths, reporting clashes', async () => {
      const src = fixtureCopy('angular15-app');
      const ts = fs
        .readFileSync(path.join(src, 'tsconfig.json'), 'utf8')
        .replace(
          '"baseUrl": "./",',
          '"baseUrl": "./",\n    "paths": { "@app/core/*": ["src/app/core/*"], "@acme/ui": ["src/app/ui/index.ts"] },',
        );
      put(src, 'tsconfig.json', ts);
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({
        '@acme/ui': ['libs/shared/ui/src/index.ts'],
        '@app/core/*': ['apps/portal/src/app/core/*'],
      });
      const report = tree.read('docs/migrations/portal.md', 'utf8')!;
      expect(report).toContain('Added to `tsconfig.base.json`: `@app/core/*`.');
      expect(report).toContain(
        '| `@acme/ui` | `libs/shared/ui/src/index.ts` | `apps/portal/src/app/ui/index.ts` |',
      );
    });

    it('reports imports that relied on the source baseUrl', async () => {
      const src = fixtureCopy('angular15-app');
      put(
        src,
        'src/app/feature.ts',
        "import { environment } from 'src/environments/environment';\n",
      );
      await migrateGenerator(tree, { source: src, name: 'portal', rewriteImports: false });
      expect(tree.read('docs/migrations/portal.md', 'utf8')).toContain(
        'These files import through it and need relative imports or a path alias: `src/app/feature.ts`.',
      );
    });

    it('rewrites imports that relied on the source baseUrl to relative paths', async () => {
      const src = fixtureCopy('angular15-app');
      put(
        src,
        'src/app/feature.ts',
        "import { environment } from 'src/environments/environment';\nimport { of } from 'rxjs';\n",
      );
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(tree.read('apps/portal/src/app/feature.ts', 'utf8')).toBe(
        "import { environment } from '../environments/environment';\nimport { of } from 'rxjs';\n",
      );
      const report = tree.read('docs/migrations/portal.md', 'utf8') as string;
      expect(report).not.toContain('These files import through it');
      expect(report).toContain('Rewrote 1 import in 1 copied file (the source was not changed):');
    });

    it('copies a source .eslintrc.json and makes it extend the root config', async () => {
      const src = fixtureCopy('angular15-app');
      putJson(src, '.eslintrc.json', {
        root: true,
        ignorePatterns: ['projects/**/*'],
        overrides: [{ files: ['*.ts'], parserOptions: { project: ['tsconfig.json'] } }],
      });
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(readJson(tree, 'apps/portal/.eslintrc.json')).toEqual({
        extends: ['../../.eslintrc.json'],
        ignorePatterns: ['!**/*', 'projects/**/*'],
        overrides: [{ files: ['*.ts'], parserOptions: { project: ['apps/portal/tsconfig.json'] } }],
      });
    });

    it('leaves another ESLint config format as is and says so', async () => {
      const src = fixtureCopy('angular15-app');
      put(src, '.eslintrc.js', 'module.exports = {};\n');
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(tree.exists('apps/portal/.eslintrc.json')).toBe(false);
      expect(tree.read('docs/migrations/portal.md', 'utf8')).toContain(
        'ESLint config `.eslintrc.js` was copied as is.',
      );
    });

    it('notes Tailwind and PostCSS configs whose relative paths now resolve from the workspace root', async () => {
      const src = fixtureCopy('angular15-app');
      put(src, 'tailwind.config.js', "module.exports = { content: ['./src/**/*.{html,ts}'] };\n");
      put(src, 'postcss.config.js', 'module.exports = { plugins: {} };\n');
      await migrateGenerator(tree, { source: src, name: 'portal' });
      const report = tree.read('docs/migrations/portal.md', 'utf8') ?? '';
      expect(report).toContain(
        '`tailwind.config.js`: Nx runs the build from the workspace root, so relative `content` globs ' +
          "(`./src/**/*.html`) now resolve from there. Anchor them to the app: `join(__dirname, 'src/**/*.{html,ts}')` " +
          "with `const { join } = require('path')`.",
      );
      expect(report).toContain(
        '`postcss.config.js`: relative paths in it now resolve from the workspace root',
      );
    });

    it('fails with the file name when a tsconfig or .eslintrc.json is not valid JSON', async () => {
      const src = fixtureCopy('angular15-app');
      put(src, 'tsconfig.app.json', '{ "extends": "./tsconfig.json", ');
      await expect(migrateGenerator(tree, { source: src, name: 'portal' })).rejects.toThrow(
        /^migrate: could not parse tsconfig\.app\.json \(.+\)\. Fix the JSON in the source \(comments and trailing commas are fine\) and run again\.$/,
      );
      const src2 = fixtureCopy('angular15-app');
      put(src2, 'tsconfig.json', '{ oops');
      await expect(migrateGenerator(workspace(), { source: src2, name: 'portal' })).rejects.toThrow(
        /^migrate: could not parse tsconfig\.json/,
      );
      const src3 = fixtureCopy('angular15-app');
      put(src3, '.eslintrc.json', '{ "root": true,, }');
      await expect(migrateGenerator(workspace(), { source: src3, name: 'portal' })).rejects.toThrow(
        /^migrate: could not parse \.eslintrc\.json/,
      );
    });

    it('never overwrites a workspace dependency and reports the clash', async () => {
      tree.write(
        'package.json',
        JSON.stringify({
          devDependencies: { nx: '~17.0.6', typescript: '~5.1.0' },
          dependencies: { rxjs: '~7.8.0' },
        }),
      );
      await migrateGenerator(tree, { source: FIXTURE, name: 'portal' });
      const pkg = pkgOf(tree);
      expect(pkg.devDependencies.typescript).toBe('~5.1.0');
      expect(tree.read('docs/migrations/portal.md', 'utf8')).toContain(
        '| `typescript` | `~5.1.0`  | `~4.9.4` |',
      );
    });

    it('does not report overlapping ranges as clashes', async () => {
      tree.write(
        'package.json',
        JSON.stringify({
          devDependencies: { nx: '~17.0.6', typescript: '~4.9.5' },
          dependencies: { '@angular/core': '~15.2.0', tslib: '^2.6.0', 'zone.js': '~0.13.0' },
        }),
      );
      await migrateGenerator(tree, { source: FIXTURE, name: 'portal' });
      const report = tree.read('docs/migrations/portal.md', 'utf8') ?? '';
      // ^15.2.0 vs ~15.2.0, ^2.3.0 vs ^2.6.0 and ~4.9.4 vs ~4.9.5 can be satisfied together.
      expect(report).not.toContain('`@angular/core`');
      expect(report).not.toContain('| `tslib`');
      expect(report).not.toContain('| `typescript`');
      // ~0.12.0 vs ~0.13.0 cannot.
      expect(report).toContain('| `zone.js`');
    });

    it('rebases local path dependencies inside the source and holds back the others', async () => {
      const src = fixtureCopy('angular15-app');
      const pkg = readJsonFile<Record<string, Record<string, string>>>(src, 'package.json');
      pkg['dependencies']['@acme/util'] = 'file:packages/util';
      pkg['dependencies']['@acme/shared'] = 'file:../shared';
      pkg['devDependencies']['@acme/tool'] = 'link:./tools/tool';
      putJson(src, 'package.json', pkg);
      put(src, 'packages/util/package.json', '{"name":"@acme/util"}');
      await migrateGenerator(tree, { source: src, name: 'portal' });
      const root = pkgOf(tree);
      expect(root.dependencies['@acme/util']).toBe('file:apps/portal/packages/util');
      expect(root.devDependencies['@acme/tool']).toBe('file:apps/portal/tools/tool');
      expect(root.dependencies['@acme/shared']).toBeUndefined();
      expect(tree.read('docs/migrations/portal.md', 'utf8')).toContain(
        'Not added: `@acme/shared` (`file:../shared`) points outside the source repo.',
      );
    });

    it('merges optionalDependencies like devDependencies and lists the other package fields', async () => {
      const src = fixtureCopy('angular15-app');
      const pkg = readJsonFile<Record<string, unknown>>(src, 'package.json');
      pkg['optionalDependencies'] = { fsevents: '^2.3.2', rxjs: '~7.5.0' };
      pkg['peerDependencies'] = { '@angular/core': '^15.0.0' };
      pkg['overrides'] = { semver: '^7.5.4', webpack: { terser: '5.0.0' } };
      pkg['resolutions'] = { minimist: '1.2.8' };
      putJson(src, 'package.json', pkg);
      tree.write(
        'package.json',
        JSON.stringify({
          devDependencies: { nx: '17.0.6' },
          optionalDependencies: { fsevents: '^1.2.13' },
        }),
      );
      await migrateGenerator(tree, { source: src, name: 'portal' });
      const root = pkgOf(tree);
      expect(root.optionalDependencies).toEqual({ fsevents: '^1.2.13' });
      expect(root.dependencies.rxjs).toBe('~7.8.0');
      const report = tree.read('docs/migrations/portal.md', 'utf8') ?? '';
      expect(report).toContain('| `fsevents`');
      expect(report).toContain('## Other package.json fields');
      expect(report).toContain(
        '`overrides` (not carried over): `semver`: `^7.5.4`, `webpack`: `{"terser":"5.0.0"}`',
      );
      expect(report).toContain('`resolutions` (not carried over): `minimist`: `1.2.8`');
      expect(report).toContain('`peerDependencies` (not added): `@angular/core`: `^15.0.0`');
      expect(report).toContain(
        '`optionalDependencies` (merged like devDependencies): `fsevents`: `^2.3.2`, `rxjs`: `~7.5.0`',
      );
    });

    it('adds a missing optional dependency to optionalDependencies', async () => {
      const src = fixtureCopy('angular15-app');
      const pkg = readJsonFile<Record<string, unknown>>(src, 'package.json');
      pkg['optionalDependencies'] = { fsevents: '^2.3.2' };
      putJson(src, 'package.json', pkg);
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(pkgOf(tree).optionalDependencies).toEqual({ fsevents: '^2.3.2' });
      expect(tree.read('docs/migrations/portal.md', 'utf8')).toContain('- `fsevents`');
    });

    it('writes .browserslistrc from a package.json browserslist', async () => {
      const src = fixtureCopy('angular15-app');
      const pkg = readJsonFile<Record<string, unknown>>(src, 'package.json');
      pkg['browserslist'] = ['last 2 Chrome versions', 'not dead'];
      putJson(src, 'package.json', pkg);
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(tree.read('apps/portal/.browserslistrc', 'utf8')).toBe(
        'last 2 Chrome versions\nnot dead\n',
      );
      expect(tree.read('docs/migrations/portal.md', 'utf8')).toContain(
        'Wrote `apps/portal/.browserslistrc` from the source package.json `browserslist`',
      );
    });

    it('keeps a copied .browserslistrc over the package.json browserslist', async () => {
      const src = fixtureCopy('angular15-app');
      const pkg = readJsonFile<Record<string, unknown>>(src, 'package.json');
      pkg['browserslist'] = ['defaults'];
      putJson(src, 'package.json', pkg);
      put(src, '.browserslistrc', 'last 1 Firefox version\n');
      await migrateGenerator(tree, { source: src, name: 'portal' });
      expect(tree.read('apps/portal/.browserslistrc', 'utf8')).toBe('last 1 Firefox version\n');
    });

    it('fails on an Angular major mismatch before writing anything', async () => {
      tree.write('package.json', JSON.stringify({ dependencies: { '@angular/core': '~16.2.0' } }));
      await expect(migrateGenerator(tree, { source: FIXTURE, name: 'portal' })).rejects.toThrow(
        'migrate: the workspace uses Angular 16 (@angular/core ~16.2.0) but the source uses Angular 15 ' +
          '(@angular/core ^15.2.0). Update the source to Angular 16 first, one major at a time ' +
          '(`ng update @angular/core@16 @angular/cli@16`, and so on)',
      );
      expect(tree.exists('apps/portal')).toBe(false);
    });

    it('a source newer than the workspace is told to bring the workspace up first', async () => {
      tree.write('package.json', JSON.stringify({ dependencies: { '@angular/core': '~15.2.0' } }));
      const src = fixtureCopy('angular15-app');
      const pkg = readJsonFile<{ dependencies: Record<string, string> }>(src, 'package.json');
      pkg.dependencies['@angular/core'] = '^17.3.0';
      putJson(src, 'package.json', pkg);
      await expect(migrateGenerator(tree, { source: src, name: 'portal' })).rejects.toThrow(
        'Bring the workspace to Angular 17 first (one major at a time), or migrate into a ' +
          'workspace that is on Angular 17. Or pass --force-angular',
      );
      expect(tree.exists('apps/portal')).toBe(false);
    });

    it('--force-angular proceeds, keeps the workspace Angular and flags the mismatch', async () => {
      tree.write('package.json', JSON.stringify({ dependencies: { '@angular/core': '~17.3.0' } }));
      await migrateGenerator(tree, { source: FIXTURE, name: 'portal', forceAngular: true });
      const pkg = pkgOf(tree);
      expect(pkg.dependencies['@angular/core']).toBe('~17.3.0');
      expect(pkg.dependencies['@angular/router']).toBeUndefined();
      expect(pkg.dependencies['zone.js']).toBe('~0.12.0');
      const report = tree.read('docs/migrations/portal.md', 'utf8')!;
      expect(report).toContain('## Angular version');
      expect(report).toContain(
        'Angular major mismatch: the workspace has @angular/core `~17.3.0` (Angular 17)',
      );
      expect(report).toContain('Install versions matching Angular 17 for:');
      expect(report).toContain(
        'Not added (they would mix Angular majors): `@angular-devkit/build-angular`, `@angular/animations`',
      );
    });

    it('same Angular major: adds only what is missing', async () => {
      tree.write(
        'package.json',
        JSON.stringify({
          dependencies: { '@angular/core': '~15.1.0', '@angular/common': '~15.1.0' },
          devDependencies: { nx: '17.0.6' },
        }),
      );
      await migrateGenerator(tree, { source: FIXTURE, name: 'portal' });
      const pkg = pkgOf(tree);
      expect(pkg.dependencies['@angular/core']).toBe('~15.1.0');
      expect(pkg.dependencies['@angular/router']).toBe('^15.2.0');
      expect(tree.read('docs/migrations/portal.md', 'utf8')).toContain(
        'Same Angular major: workspace @angular/core `~15.1.0`, source `^15.2.0`.',
      );
    });

    it('refreshes the llm block', async () => {
      const t = workspace();
      t.write('CLAUDE.md', `# CLAUDE.md\n\n${LLM_START}\nold\n${LLM_END}\n`);
      await migrateGenerator(t, { source: FIXTURE, name: 'portal' });
      const md = t.read('CLAUDE.md', 'utf8')!;
      expect(md).toContain('| `portal` | angular | `apps/portal` |');
      expect(md).toContain('`npx nx run portal:release:<env>`');
      expect(md).toContain('`build:portal:prod`');
    });
  });
});
