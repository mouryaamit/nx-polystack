import {
  angularBuildTarget,
  angularProjectTargets,
  angularReleaseTarget,
  angularServeTarget,
  POLYSTACK_BUILD_EXECUTOR,
} from '../../src/lib/utils/angular-project';

const HARDENED = {
  leakCheck: 'fail',
  sourceMaps: 'fail',
  stripComments: true,
  dropConsole: ['log', 'debug', 'warn'],
};

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('angular-project helpers', () => {
  it('build is the Angular browser builder with full options', () => {
    const t = plain(angularBuildTarget('portal'));
    expect(t.executor).toBe('@angular-devkit/build-angular:browser');
    expect(t.options).toMatchObject({
      outputPath: 'dist/apps/portal',
      index: 'apps/portal/src/index.html',
      main: 'apps/portal/src/main.ts',
      polyfills: ['zone.js'],
      tsConfig: 'apps/portal/tsconfig.app.json',
      inlineStyleLanguage: 'scss',
      styles: ['apps/portal/src/styles.scss'],
    });
    expect(t.defaultConfiguration).toBe('production');
  });

  it.each([
    ['production', 'environment.prod.ts'],
    ['uat', 'environment.uat.ts'],
  ])('%s swaps in %s', (config, file) => {
    const t = plain(angularBuildTarget('portal'));
    expect(t.configurations[config].fileReplacements).toEqual([
      { replace: 'environments/portal/environment.ts', with: `environments/portal/${file}` },
    ]);
  });

  it('ships .htaccess as an asset and gives each configuration its own budgets', () => {
    const raw = angularBuildTarget('portal') as {
      options: { assets: unknown[] };
      configurations: Record<string, { budgets: object[] }>;
    };
    expect(raw.options.assets).toEqual(['apps/portal/src/.htaccess']);
    expect(raw.configurations.production.budgets).not.toBe(raw.configurations.uat.budgets);
    expect(raw.configurations.production.budgets[0]).not.toBe(raw.configurations.uat.budgets[0]);
  });

  it('development has no file replacement and keeps source maps', () => {
    const dev = plain(angularBuildTarget('portal')).configurations.development;
    expect(dev.fileReplacements).toBeUndefined();
    expect(dev.sourceMap).toBe(true);
  });

  it('serve maps each configuration to the same build configuration', () => {
    const s = plain(angularServeTarget('portal'));
    expect(s.executor).toBe('@angular-devkit/build-angular:dev-server');
    expect(s.configurations).toEqual({
      production: { browserTarget: 'portal:build:production' },
      uat: { browserTarget: 'portal:build:uat' },
      development: { browserTarget: 'portal:build:development' },
    });
    expect(s.defaultConfiguration).toBe('development');
  });

  it('release wraps build through the plugin executor', () => {
    const r = plain(angularReleaseTarget('portal'));
    expect(r.executor).toBe(POLYSTACK_BUILD_EXECUTOR);
    expect(r.options).toEqual({
      type: 'angular',
      outputPath: 'dist/apps/portal',
      envProject: 'portal',
      buildTarget: 'portal:build',
    });
    expect(r.defaultConfiguration).toBe('dev');
    expect(r.configurations).toEqual({
      dev: { env: 'DEV', buildConfiguration: 'development' },
      uat: { env: 'UAT', buildConfiguration: 'uat', ...HARDENED },
      prod: { env: 'PROD', buildConfiguration: 'production', ...HARDENED },
    });
  });

  it('angularProjectTargets has build, serve, release, clean, typecheck, lint and extract-i18n', () => {
    expect(Object.keys(angularProjectTargets('portal')).sort()).toEqual(
      ['build', 'clean', 'extract-i18n', 'lint', 'release', 'serve', 'typecheck'].sort(),
    );
  });
});
