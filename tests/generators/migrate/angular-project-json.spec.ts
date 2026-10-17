import * as fs from 'fs';
import * as path from 'path';

import { parseJson } from '@nx/devkit';

import type { AngularWorkspace } from '../../../src/generators/migrate/adapters/angular-cli';
import {
  addReleaseTarget,
  angularAppNpmScripts,
  angularProjectJson,
  applicationBuilderTargets,
  mapOptions,
  mapOutputPath,
  mapPath,
  PathMapper,
  releaseConfigurations,
  renameTargetRef,
} from '../../../src/generators/migrate/angular-project-json';

import { FIXTURES } from './helpers';

const HARDENED = {
  leakCheck: 'fail',
  sourceMaps: 'fail',
  stripComments: true,
  dropConsole: ['log', 'debug', 'warn'],
};

const FIXTURE = path.join(FIXTURES, 'angular15-app');

function mapper(over: Partial<PathMapper> = {}): PathMapper {
  return {
    sourceRoot: '',
    projectRoot: 'apps/portal',
    name: 'portal',
    exists: () => true,
    warnings: [],
    ...over,
  };
}

const existsIn = (files: string[]) => (p: string) =>
  files.some((f) => f === p || f.startsWith(`${p}/`));

describe('angular.json → project.json', () => {
  describe('mapPath', () => {
    it('moves repo-root paths under apps/<name>', () => {
      const m = mapper();
      expect(mapPath('src/main.ts', m)).toBe('apps/portal/src/main.ts');
      expect(mapPath('./tsconfig.app.json', m)).toBe('apps/portal/tsconfig.app.json');
      expect(mapPath('src/**/*.html', m)).toBe('apps/portal/src/**/*.html');
      expect(mapPath('!src/**/*.spec.ts', m)).toBe('!apps/portal/src/**/*.spec.ts');
      expect(mapPath('', m)).toBe('apps/portal');
      expect(mapPath('.', m)).toBe('apps/portal');
    });

    it('leaves node_modules, absolute and outside paths, warning about the outside ones', () => {
      const m = mapper();
      expect(mapPath('node_modules/bootstrap/dist/css/bootstrap.css', m)).toBe(
        'node_modules/bootstrap/dist/css/bootstrap.css',
      );
      expect(mapPath('/etc/ssl/cert.pem', m)).toBe('/etc/ssl/cert.pem');
      expect(mapPath('../shared/styles', m)).toBe('../shared/styles');
      expect(m.warnings).toEqual(['"../shared/styles" is outside the source repo; left unchanged']);
    });

    it('with a project root, maps only paths inside it', () => {
      const m = mapper({ sourceRoot: 'projects/shop' });
      expect(mapPath('projects/shop/src/main.ts', m)).toBe('apps/portal/src/main.ts');
      expect(mapPath('projects/shop', m)).toBe('apps/portal');
      expect(mapPath('libs/theme/styles.scss', m)).toBe('libs/theme/styles.scss');
      expect(m.warnings).toEqual([
        '"libs/theme/styles.scss" is outside the project root "projects/shop"; left unchanged',
      ]);
    });
  });

  it('mapOutputPath: dist/<x> → dist/apps/<name>, keeping sub-folders', () => {
    const m = mapper();
    expect(mapOutputPath('dist/legacy-portal', m)).toBe('dist/apps/portal');
    expect(mapOutputPath('dist/legacy-portal/browser', m)).toBe('dist/apps/portal/browser');
    expect(mapOutputPath('./dist', m)).toBe('dist/apps/portal');
    expect(mapOutputPath('src/locale', m)).toBe('apps/portal/src/locale');
  });

  it('renameTargetRef renames only the migrated project', () => {
    expect(renameTargetRef('legacy-portal:build:production', 'legacy-portal', 'portal')).toBe(
      'portal:build:production',
    );
    expect(renameTargetRef('legacy-portal:build', 'legacy-portal', 'portal')).toBe('portal:build');
    expect(renameTargetRef('other:build', 'legacy-portal', 'portal')).toBe('other:build');
    expect(renameTargetRef('legacy-portal-e2e:serve', 'legacy-portal', 'portal')).toBe(
      'legacy-portal-e2e:serve',
    );
  });

  it('mapOptions rewrites every path option and target reference', () => {
    const m = mapper({
      exists: existsIn(['src/polyfills.ts', 'src/assets', 'src/styles.scss', 'src/vendor.js']),
    });
    const out = mapOptions(
      {
        outputPath: 'dist/legacy-portal',
        index: 'src/index.html',
        main: 'src/main.ts',
        polyfills: ['zone.js', 'zone.js/testing', 'src/polyfills.ts'],
        tsConfig: 'tsconfig.app.json',
        karmaConfig: 'karma.conf.js',
        proxyConfig: 'proxy.conf.json',
        ngswConfigPath: 'ngsw-config.json',
        webWorkerTsConfig: 'tsconfig.worker.json',
        assets: [
          'src/assets',
          { glob: '**/*', input: 'src/assets', output: '/assets/' },
          { glob: '**/*', input: 'node_modules/some-pkg/icons', output: '/icons/' },
        ],
        styles: [
          'src/styles.scss',
          '@angular/material/prebuilt-themes/indigo-pink.css',
          'node_modules/bootstrap/dist/css/bootstrap.min.css',
          { input: 'src/styles.scss', bundleName: 'theme', inject: false },
        ],
        scripts: ['src/vendor.js'],
        fileReplacements: [
          {
            replace: 'src/environments/environment.ts',
            with: 'src/environments/environment.prod.ts',
          },
          { src: 'src/a.ts', replaceWith: 'src/b.ts' },
        ],
        stylePreprocessorOptions: { includePaths: ['src/styles', 'node_modules'] },
        lintFilePatterns: ['src/**/*.ts', 'src/**/*.html'],
        browserTarget: 'legacy-portal:build',
        buildTarget: 'legacy-portal:build:production',
        devServerTarget: 'legacy-portal:serve',
        inlineStyleLanguage: 'scss',
        optimization: false,
      },
      'legacy-portal',
      m,
    );
    expect(out).toEqual({
      outputPath: 'dist/apps/portal',
      index: 'apps/portal/src/index.html',
      main: 'apps/portal/src/main.ts',
      polyfills: ['zone.js', 'zone.js/testing', 'apps/portal/src/polyfills.ts'],
      tsConfig: 'apps/portal/tsconfig.app.json',
      karmaConfig: 'apps/portal/karma.conf.js',
      proxyConfig: 'apps/portal/proxy.conf.json',
      ngswConfigPath: 'apps/portal/ngsw-config.json',
      webWorkerTsConfig: 'apps/portal/tsconfig.worker.json',
      assets: [
        'apps/portal/src/assets',
        { glob: '**/*', input: 'apps/portal/src/assets', output: '/assets/' },
        { glob: '**/*', input: 'node_modules/some-pkg/icons', output: '/icons/' },
      ],
      styles: [
        'apps/portal/src/styles.scss',
        '@angular/material/prebuilt-themes/indigo-pink.css',
        'node_modules/bootstrap/dist/css/bootstrap.min.css',
        { input: 'apps/portal/src/styles.scss', bundleName: 'theme', inject: false },
      ],
      scripts: ['apps/portal/src/vendor.js'],
      fileReplacements: [
        {
          replace: 'apps/portal/src/environments/environment.ts',
          with: 'apps/portal/src/environments/environment.prod.ts',
        },
        { src: 'apps/portal/src/a.ts', replaceWith: 'apps/portal/src/b.ts' },
      ],
      stylePreprocessorOptions: { includePaths: ['apps/portal/src/styles', 'node_modules'] },
      lintFilePatterns: ['apps/portal/src/**/*.ts', 'apps/portal/src/**/*.html'],
      browserTarget: 'portal:build',
      buildTarget: 'portal:build:production',
      devServerTarget: 'portal:serve',
      inlineStyleLanguage: 'scss',
      optimization: false,
    });
  });

  it('maps the application-builder path options (browser, server, ssr, prerender, outputPath.base)', () => {
    const m = mapper({ exists: existsIn(['src/main.ts']) });
    expect(
      mapOptions(
        {
          outputPath: { base: 'dist/shop', browser: '', server: 'server' },
          browser: 'src/main.ts',
          server: 'src/main.server.ts',
          ssr: { entry: 'server.ts' },
          prerender: { routesFile: 'routes.txt', discoverRoutes: false },
        },
        'shop',
        m,
      ),
    ).toEqual({
      outputPath: { base: 'dist/apps/portal', browser: '', server: 'server' },
      browser: 'apps/portal/src/main.ts',
      server: 'apps/portal/src/main.server.ts',
      ssr: { entry: 'apps/portal/server.ts' },
      prerender: { routesFile: 'apps/portal/routes.txt', discoverRoutes: false },
    });
    expect(mapOptions({ ssr: false, prerender: true }, 'shop', m)).toEqual({
      ssr: false,
      prerender: true,
    });
  });

  it('maps protractorConfig, configFile, codeCoverageExclude and eslintConfig', () => {
    expect(
      mapOptions(
        {
          protractorConfig: 'e2e/protractor.conf.js',
          configFile: '.stylelintrc.json',
          codeCoverageExclude: ['src/testing/**', 'src/polyfills.ts'],
          eslintConfig: '.eslintrc.json',
        },
        'shop',
        mapper(),
      ),
    ).toEqual({
      protractorConfig: 'apps/portal/e2e/protractor.conf.js',
      configFile: 'apps/portal/.stylelintrc.json',
      codeCoverageExclude: ['apps/portal/src/testing/**', 'apps/portal/src/polyfills.ts'],
      eslintConfig: 'apps/portal/.eslintrc.json',
    });
  });

  it('finds application-builder targets', () => {
    expect(
      applicationBuilderTargets({
        architect: {
          build: { builder: '@angular-devkit/build-angular:application', options: {} },
          serve: { builder: '@angular-devkit/build-angular:dev-server' },
        },
      }),
    ).toEqual([{ target: 'build', builder: '@angular-devkit/build-angular:application' }]);
    expect(
      applicationBuilderTargets({
        architect: {
          build: {
            builder: '@angular-devkit/build-angular:browser-esbuild',
            options: { main: 'src/main.ts' },
          },
        },
      }),
    ).toEqual([]);
    expect(
      applicationBuilderTargets({
        architect: {
          build: {
            builder: '@angular-devkit/build-angular:browser-esbuild',
            options: { browser: 'src/main.ts' },
          },
          ssrbuild: { builder: '@angular/build:application', options: {} },
        },
      }),
    ).toEqual([
      { target: 'build', builder: '@angular-devkit/build-angular:browser-esbuild' },
      { target: 'ssrbuild', builder: '@angular/build:application' },
    ]);
    expect(
      applicationBuilderTargets({
        architect: {
          build: {
            builder: '@angular-devkit/build-angular:browser-esbuild',
            options: {},
            configurations: { production: { ssr: true } },
          },
        },
      }),
    ).toHaveLength(1);
  });

  it('maps a missing file under a source folder as a path, with a warning', () => {
    const m = mapper({ exists: existsIn(['src/main.ts']) });
    expect(mapOptions({ styles: ['src/missing.scss'] }, 'x', m)).toEqual({
      styles: ['apps/portal/src/missing.scss'],
    });
    expect(m.warnings).toEqual([
      '"src/missing.scss" was not found in the source; mapped as a path anyway',
    ]);
  });

  it('index as an object maps its input', () => {
    expect(
      mapOptions({ index: { input: 'src/index.prod.html', output: 'index.html' } }, 'x', mapper()),
    ).toEqual({
      index: { input: 'apps/portal/src/index.prod.html', output: 'index.html' },
    });
  });

  it('release configurations: production → prod, development → dev, others keep their name', () => {
    expect(releaseConfigurations(['production', 'staging', 'development'])).toEqual({
      prod: { env: 'PROD', buildConfiguration: 'production', ...HARDENED },
      staging: { env: 'STAGING', buildConfiguration: 'staging' },
      dev: { env: 'DEV', buildConfiguration: 'development' },
    });
  });

  describe('the ng new fixture', () => {
    const ws = parseJson<AngularWorkspace>(
      fs.readFileSync(path.join(FIXTURE, 'angular.json'), 'utf8'),
    );
    const result = angularProjectJson({
      sourceProject: 'legacy-portal',
      project: ws.projects!['legacy-portal'],
      name: 'portal',
      exists: (rel) => fs.existsSync(path.join(FIXTURE, rel)),
    });

    it('produces the Nx project.json', () => {
      expect(result.warnings).toEqual([]);
      expect(result.addedTargets).toEqual(['release', 'lint']);
      expect(result.releaseConfigurations).toEqual(['prod', 'dev']);
      expect(result.projectJson).toEqual({
        name: 'portal',
        $schema: '../../node_modules/nx/schemas/project-schema.json',
        projectType: 'application',
        prefix: 'app',
        sourceRoot: 'apps/portal/src',
        tags: [],
        generators: { '@schematics/angular:component': { style: 'scss' } },
        targets: {
          build: {
            executor: '@angular-devkit/build-angular:browser',
            outputs: ['{options.outputPath}'],
            options: {
              outputPath: 'dist/apps/portal',
              index: 'apps/portal/src/index.html',
              main: 'apps/portal/src/main.ts',
              polyfills: ['zone.js'],
              tsConfig: 'apps/portal/tsconfig.app.json',
              inlineStyleLanguage: 'scss',
              assets: ['apps/portal/src/favicon.ico', 'apps/portal/src/assets'],
              styles: ['apps/portal/src/styles.scss'],
              scripts: [],
            },
            configurations: {
              production: {
                budgets: [
                  { type: 'initial', maximumWarning: '500kb', maximumError: '1mb' },
                  { type: 'anyComponentStyle', maximumWarning: '2kb', maximumError: '4kb' },
                ],
                fileReplacements: [
                  {
                    replace: 'apps/portal/src/environments/environment.ts',
                    with: 'apps/portal/src/environments/environment.prod.ts',
                  },
                ],
                outputHashing: 'all',
              },
              development: {
                buildOptimizer: false,
                optimization: false,
                vendorChunk: true,
                extractLicenses: false,
                sourceMap: true,
                namedChunks: true,
              },
            },
            defaultConfiguration: 'production',
          },
          serve: {
            executor: '@angular-devkit/build-angular:dev-server',
            configurations: {
              production: { browserTarget: 'portal:build:production' },
              development: { browserTarget: 'portal:build:development' },
            },
            defaultConfiguration: 'development',
          },
          'extract-i18n': {
            executor: '@angular-devkit/build-angular:extract-i18n',
            options: { browserTarget: 'portal:build' },
          },
          test: {
            executor: '@angular-devkit/build-angular:karma',
            options: {
              polyfills: ['zone.js', 'zone.js/testing'],
              tsConfig: 'apps/portal/tsconfig.spec.json',
              inlineStyleLanguage: 'scss',
              assets: ['apps/portal/src/favicon.ico', 'apps/portal/src/assets'],
              styles: ['apps/portal/src/styles.scss'],
              scripts: [],
            },
          },
          release: {
            executor: '@mouryaamit/nx-polystack:build',
            outputs: ['{options.outputPath}'],
            options: {
              type: 'angular',
              outputPath: 'dist/apps/portal',
              envProject: 'portal',
              buildTarget: 'portal:build',
            },
            configurations: {
              prod: { env: 'PROD', buildConfiguration: 'production', ...HARDENED },
              dev: { env: 'DEV', buildConfiguration: 'development' },
            },
            defaultConfiguration: 'dev',
          },
          lint: {
            executor: '@nx/eslint:lint',
            outputs: ['{options.outputFile}'],
            options: { lintFilePatterns: ['apps/portal/src/**/*.ts', 'apps/portal/src/**/*.html'] },
          },
        },
      });
    });
  });

  it('keeps an existing lint target (rewritten) and does not add another', () => {
    const r = angularProjectJson({
      sourceProject: 'shop',
      name: 'portal',
      exists: () => true,
      project: {
        projectType: 'application',
        root: '',
        architect: {
          build: {
            builder: '@angular-devkit/build-angular:browser',
            options: { outputPath: 'dist/shop' },
            configurations: { production: {} },
          },
          lint: {
            builder: '@angular-eslint/builder:lint',
            options: { lintFilePatterns: ['src/**/*.ts'] },
          },
        },
      },
    });
    const targets = r.projectJson['targets'] as Record<
      string,
      { executor: string; options: unknown }
    >;
    expect(targets['lint']).toEqual({
      executor: '@angular-eslint/builder:lint',
      options: { lintFilePatterns: ['apps/portal/src/**/*.ts'] },
    });
    expect(r.addedTargets).toEqual(['release']);
    expect(r.releaseConfigurations).toEqual(['prod']);
    expect(
      (targets['release'] as unknown as { defaultConfiguration: string }).defaultConfiguration,
    ).toBe('prod');
  });

  it('adds no release target without build configurations, and says so', () => {
    const r = angularProjectJson({
      sourceProject: 'shop',
      name: 'portal',
      exists: () => true,
      project: {
        architect: { build: { builder: '@angular-devkit/build-angular:browser', options: {} } },
      },
    });
    expect(r.releaseConfigurations).toEqual([]);
    expect(r.warnings).toEqual([
      'the build target has no configurations; the polystack release target was not added',
    ]);
  });

  it('maps a nested project root and i18n translation files', () => {
    const r = angularProjectJson({
      sourceProject: 'shop',
      name: 'portal',
      exists: () => true,
      project: {
        root: 'projects/shop',
        sourceRoot: 'projects/shop/src',
        i18n: {
          sourceLocale: 'en-US',
          locales: {
            de: 'projects/shop/src/locale/messages.de.xlf',
            fr: { translation: 'projects/shop/src/locale/messages.fr.xlf', baseHref: '/fr/' },
          },
        },
        architect: {},
      },
    });
    expect(r.projectJson['sourceRoot']).toBe('apps/portal/src');
    expect(r.projectJson['i18n']).toEqual({
      sourceLocale: 'en-US',
      locales: {
        de: 'apps/portal/src/locale/messages.de.xlf',
        fr: { translation: 'apps/portal/src/locale/messages.fr.xlf', baseHref: '/fr/' },
      },
    });
  });
});

describe('addReleaseTarget', () => {
  it('adds release configurations from the build configurations and keeps outputPath', () => {
    const targets: Record<string, unknown> = {
      build: {
        options: { outputPath: 'dist/apps/portal' },
        configurations: { production: {}, development: {}, qa: {} },
      },
    };
    const warnings: string[] = [];
    expect(addReleaseTarget(targets, 'portal', (w) => warnings.push(w))).toEqual([
      'prod',
      'dev',
      'qa',
    ]);
    expect(targets['release']).toMatchObject({
      executor: '@mouryaamit/nx-polystack:build',
      options: {
        outputPath: 'dist/apps/portal',
        envProject: 'portal',
        buildTarget: 'portal:build',
      },
      configurations: { prod: { env: 'PROD', buildConfiguration: 'production', ...HARDENED } },
      defaultConfiguration: 'dev',
    });
    expect(warnings).toEqual([]);
  });

  it('warns and adds nothing without build configurations or with a release target', () => {
    const warnings: string[] = [];
    expect(addReleaseTarget({ build: {} }, 'a', (w) => warnings.push(w))).toEqual([]);
    expect(addReleaseTarget({ release: {}, build: {} }, 'a', (w) => warnings.push(w))).toEqual([]);
    expect(warnings).toEqual([
      'the build target has no configurations; the polystack release target was not added',
      'the source already has a "release" target; the polystack release target was not added',
    ]);
  });
});

describe('angularAppNpmScripts', () => {
  it('serve, one build per release configuration, and the secure prod builds', () => {
    expect(angularAppNpmScripts('portal', true, ['prod', 'dev'])).toEqual({
      'serve:portal': 'nx serve portal',
      'build:portal:prod': 'nx run portal:release:prod',
      'build:portal:dev': 'nx run portal:release:dev',
      'build:portal:prod:secure': 'nx run portal:release:prod --secure',
      'build:portal:prod:secure:sri': 'nx run portal:release:prod --secure --sri',
    });
    expect(angularAppNpmScripts('x', false, [])).toEqual({});
  });
});

describe('angularProjectJson for libraries and other roots', () => {
  it('converts an ng-packagr library to libs/<name> without a release target', () => {
    const r = angularProjectJson({
      sourceProject: 'ui-kit',
      name: 'ui-kit',
      projectRoot: 'libs/ui-kit',
      exists: () => true,
      project: {
        projectType: 'library',
        root: 'projects/ui-kit',
        sourceRoot: 'projects/ui-kit/src',
        prefix: 'lib',
        architect: {
          build: {
            builder: '@angular-devkit/build-angular:ng-packagr',
            options: { project: 'projects/ui-kit/ng-package.json' },
            configurations: {
              production: { tsConfig: 'projects/ui-kit/tsconfig.lib.prod.json' },
              development: { tsConfig: 'projects/ui-kit/tsconfig.lib.json' },
            },
            defaultConfiguration: 'production',
          },
        },
      },
    });
    const pj = r.projectJson as Record<string, any>;
    expect(pj.projectType).toBe('library');
    expect(pj.$schema).toBe('../../node_modules/nx/schemas/project-schema.json');
    expect(pj.sourceRoot).toBe('libs/ui-kit/src');
    expect(pj.targets.build.options.project).toBe('libs/ui-kit/ng-package.json');
    expect(pj.targets.build.configurations.production.tsConfig).toBe(
      'libs/ui-kit/tsconfig.lib.prod.json',
    );
    expect(pj.targets.release).toBeUndefined();
    expect(r.releaseConfigurations).toEqual([]);
    expect(pj.targets.lint.options.lintFilePatterns).toEqual([
      'libs/ui-kit/src/**/*.ts',
      'libs/ui-kit/src/**/*.html',
    ]);
  });

  it('maps an app under projects/ to the given root', () => {
    const r = angularProjectJson({
      sourceProject: 'admin',
      name: 'admin',
      projectRoot: 'apps/admin',
      exists: () => true,
      project: {
        projectType: 'application',
        root: 'projects/admin',
        sourceRoot: 'projects/admin/src',
        architect: {
          build: {
            builder: '@angular-devkit/build-angular:browser',
            options: { outputPath: 'dist/admin', main: 'projects/admin/src/main.ts' },
            configurations: { production: {}, development: {} },
          },
        },
      },
    });
    const pj = r.projectJson as Record<string, any>;
    expect(pj.targets.build.options).toEqual({
      outputPath: 'dist/apps/admin',
      main: 'apps/admin/src/main.ts',
    });
    expect(r.releaseConfigurations).toEqual(['prod', 'dev']);
  });
});
