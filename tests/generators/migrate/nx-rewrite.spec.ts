import {
  depConstraints,
  nxPluginPackage,
  outsidePaths,
  renameExecutor,
  renameTargetReference,
  rewriteEslintConfig,
  rewriteProjectConfig,
} from '../../../src/generators/migrate/nx/rewrite';

describe('Nx config rewrites', () => {
  it('renames @nrwl executors', () => {
    expect(renameExecutor('@nrwl/angular:package')).toBe('@nx/angular:package');
    expect(renameExecutor('@nrwl/workspace:run-commands')).toBe('nx:run-commands');
    expect(renameExecutor('@nrwl/linter:eslint')).toBe('@nx/eslint:lint');
    expect(renameExecutor('@nx/linter:eslint')).toBe('@nx/eslint:lint');
    expect(renameExecutor('@angular-devkit/build-angular:browser')).toBe(
      '@angular-devkit/build-angular:browser',
    );
    expect(nxPluginPackage('@nx/angular:package')).toBe('@nx/angular');
    expect(nxPluginPackage('nx:run-commands')).toBeUndefined();
  });

  it('renames target references of renamed projects only', () => {
    const renames = new Map([['portal', 'acme-portal']]);
    expect(renameTargetReference('portal:build:production', renames)).toBe(
      'acme-portal:build:production',
    );
    expect(renameTargetReference('other:build', renames)).toBe('other:build');
    expect(renameTargetReference('build', renames)).toBe('build');
  });

  it('rewrites name, implicitDependencies, executors, references and dependsOn', () => {
    const dropped: string[] = [];
    const renames = new Map([
      ['portal', 'acme-portal'],
      ['shared-styles', 'acme-shared-styles'],
    ]);
    const out = rewriteProjectConfig(
      {
        $schema: '../../node_modules/nx/schemas/project-schema.json',
        name: 'portal',
        implicitDependencies: ['shared-styles', '!unrelated', 'api', '*'],
        targets: {
          serve: {
            executor: '@nrwl/angular:dev-server',
            options: { proxyConfig: 'apps/portal/proxy.json' },
            configurations: { production: { browserTarget: 'portal:build:production' } },
          },
          e2e: {
            executor: 'nx:run-commands',
            dependsOn: [
              { projects: ['shared-styles', 'api'], target: 'lint' },
              { projects: 'dependencies', target: 'build' },
              '^build',
            ],
            options: { devServerTarget: 'portal:serve' },
          },
        },
      },
      'acme-portal',
      renames,
      (n) => dropped.push(n),
    );
    expect(out).toEqual({
      name: 'acme-portal',
      $schema: '../../node_modules/nx/schemas/project-schema.json',
      implicitDependencies: ['acme-shared-styles', '*'],
      targets: {
        serve: {
          executor: '@nx/angular:dev-server',
          options: { proxyConfig: 'apps/portal/proxy.json' },
          configurations: { production: { browserTarget: 'acme-portal:build:production' } },
        },
        e2e: {
          executor: 'nx:run-commands',
          dependsOn: [
            { projects: ['acme-shared-styles'], target: 'lint' },
            { projects: 'dependencies', target: 'build' },
            '^build',
          ],
          options: { devServerTarget: 'acme-portal:serve' },
        },
      },
    });
    expect(dropped).toEqual(['!unrelated', 'api', 'api']);
  });

  it('renames @nrwl/nx in ESLint configs, overrides included', () => {
    expect(
      rewriteEslintConfig({
        extends: ['../../.eslintrc.json'],
        plugins: ['@nrwl/nx'],
        overrides: [
          {
            files: ['*.ts'],
            extends: ['plugin:@nrwl/nx/angular', 'plugin:@angular-eslint/recommended'],
            rules: { '@nrwl/nx/enforce-module-boundaries': 'error', 'no-console': 'warn' },
          },
        ],
      }),
    ).toEqual({
      extends: ['../../.eslintrc.json'],
      plugins: ['@nx'],
      overrides: [
        {
          files: ['*.ts'],
          extends: ['plugin:@nx/angular', 'plugin:@angular-eslint/recommended'],
          rules: { '@nx/enforce-module-boundaries': 'error', 'no-console': 'warn' },
        },
      ],
    });
  });

  it('lists depConstraints of the root ESLint config', () => {
    expect(
      depConstraints({
        overrides: [
          {
            rules: {
              '@nrwl/nx/enforce-module-boundaries': [
                'error',
                {
                  depConstraints: [
                    { sourceTag: 'scope:portal', onlyDependOnLibsWithTags: ['scope:shared'] },
                  ],
                },
              ],
            },
          },
        ],
      }),
    ).toEqual(['{"sourceTag":"scope:portal","onlyDependOnLibsWithTags":["scope:shared"]}']);
    expect(depConstraints({})).toEqual([]);
  });

  it('lists path options outside the copied projects', () => {
    const exists = (p: string) => ['tools', 'apps', 'libs'].includes(p.split('/')[0]);
    expect(
      outsidePaths(
        {
          targets: {
            build: {
              options: {
                main: 'apps/portal/src/main.ts',
                scripts: ['tools/legacy/analytics.js', 'node_modules/x/y.js'],
                stylePreprocessorOptions: { includePaths: ['libs/theme/src'] },
                assets: [{ input: 'shared-assets/img', glob: '**/*', output: 'img' }],
              },
            },
          },
        },
        ['apps/portal'],
        exists,
      ),
    ).toEqual(['libs/theme/src', 'tools/legacy/analytics.js']);
  });
});
