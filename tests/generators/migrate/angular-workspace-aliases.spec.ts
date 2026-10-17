import {
  aliasesToSource,
  rerootAliases,
} from '../../../src/generators/migrate/angular-workspace/aliases';
import { rewriteNgPackage } from '../../../src/generators/migrate/angular-workspace/ng-package';

describe('angular workspace aliases', () => {
  const libs = [
    { root: 'projects/ui-kit', entryFile: 'src/public-api.ts', outputs: ['dist/ui-kit'] },
  ];

  it('points dist aliases at the library source', () => {
    expect(
      aliasesToSource(
        { 'ui-kit': ['dist/ui-kit'], 'ui-kit/*': ['dist/ui-kit/*'], util: ['projects/util/src'] },
        libs,
      ),
    ).toEqual({
      'ui-kit': ['projects/ui-kit/src/public-api.ts'],
      'ui-kit/*': ['projects/ui-kit/*/src/public-api.ts'],
      util: ['projects/util/src'],
    });
  });

  it('re-roots aliases into the new folders and lists the rest', () => {
    const projects = [
      { root: 'projects/ui-kit', newRoot: 'libs/ui-kit' },
      { root: '', newRoot: 'apps/portal' },
    ];
    expect(
      rerootAliases(
        {
          'ui-kit': ['projects/ui-kit/src/public-api.ts'],
          env: ['src/environments/environment.ts'],
          ext: ['../shared/index.ts'],
          gone: ['projects/other/src/index.ts'],
        },
        projects,
        ['projects'],
      ),
    ).toEqual({
      mapped: {
        'ui-kit': ['libs/ui-kit/src/public-api.ts'],
        env: ['apps/portal/src/environments/environment.ts'],
      },
      unmapped: ['ext', 'gone'],
    });
  });

  it('rewrites ng-package.json for libs/<name>', () => {
    expect(
      rewriteNgPackage(
        {
          $schema: '../../node_modules/ng-packagr/ng-package.schema.json',
          dest: '../../dist/ui-kit',
          lib: { entryFile: 'src/public-api.ts' },
        },
        'libs/ui-kit/ng-package.json',
        'dist/libs/ui-kit',
      ),
    ).toEqual({
      $schema: '../../node_modules/ng-packagr/ng-package.schema.json',
      dest: '../../dist/libs/ui-kit',
      lib: { entryFile: 'src/public-api.ts' },
    });
  });

  it('maps secondary entry points to their own entry files', () => {
    const lib = {
      root: 'projects/ui-kit',
      entryFile: 'src/public-api.ts',
      outputs: ['dist/ui-kit'],
      secondaryEntry: (sub: string) => (sub === 'testing' ? 'index.ts' : 'src/public-api.ts'),
    };
    expect(
      aliasesToSource(
        { 'ui-kit/testing': ['dist/ui-kit/testing'], 'ui-kit/*': ['dist/ui-kit/*'] },
        [lib],
      ),
    ).toEqual({
      'ui-kit/testing': ['projects/ui-kit/testing/index.ts'],
      'ui-kit/*': ['projects/ui-kit/*/src/public-api.ts'],
    });
  });

  it('keeps node_modules targets and never gives build output to the root app', () => {
    expect(
      rerootAliases(
        {
          '@angular/*': ['./node_modules/@angular/*'],
          other: ['dist/other'],
          env: ['src/environments/environment.ts'],
        },
        [{ root: '', newRoot: 'apps/portal' }],
        ['projects', 'dist', 'out-tsc', 'tmp'],
      ),
    ).toEqual({
      mapped: {
        '@angular/*': ['node_modules/@angular/*'],
        env: ['apps/portal/src/environments/environment.ts'],
      },
      unmapped: ['other'],
    });
  });
});
