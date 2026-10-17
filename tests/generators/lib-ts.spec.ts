import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';

describe('lib generator --type=ts', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it('creates a strict framework-free lib under libs/shared/<name>', async () => {
    await libGenerator(tree, { name: 'util', type: 'ts' });
    const root = 'libs/shared/util';
    expect(tree.read(`${root}/src/index.ts`, 'utf8')).toContain("export * from './lib/util';");
    expect(tree.read(`${root}/src/lib/util.ts`, 'utf8')).toContain('export function util()');

    const ts = readJson(tree, `${root}/tsconfig.json`);
    expect(ts.extends).toBe('../../../tsconfig.base.json');
    expect(ts.files).toEqual([]);
    expect(ts.include).toEqual([]);
    expect(ts.references).toEqual([{ path: './tsconfig.lib.json' }]);
    for (const flag of [
      'strict',
      'noImplicitOverride',
      'noPropertyAccessFromIndexSignature',
      'noImplicitReturns',
      'noFallthroughCasesInSwitch',
      'forceConsistentCasingInFileNames',
    ]) {
      expect(ts.compilerOptions[flag]).toBe(true);
    }

    const lib = readJson(tree, `${root}/tsconfig.lib.json`);
    expect(lib.compilerOptions).toEqual({
      outDir: '../../../dist/out-tsc',
      declaration: true,
      types: [],
    });
    expect(lib.include).toEqual(['src/**/*.ts']);
    expect(lib.exclude).toContain('src/**/*.spec.ts');

    const eslint = readJson(tree, `${root}/.eslintrc.json`);
    expect(eslint.extends).toEqual(['../../../.eslintrc.json']);
    expect(eslint.ignorePatterns).toEqual(['!**/*']);
    expect(eslint.overrides).toEqual([{ files: ['*.ts'], rules: {} }]);
  });

  it('writes project.json with a lint target and default tags', async () => {
    await libGenerator(tree, { name: 'util', type: 'ts', tags: ['team:core', 'scope:shared'] });
    const pj = readJson(tree, 'libs/shared/util/project.json');
    expect(pj.name).toBe('shared-util');
    expect(pj.$schema).toBe('../../../node_modules/nx/schemas/project-schema.json');
    expect(pj.sourceRoot).toBe('libs/shared/util/src');
    expect(pj.projectType).toBe('library');
    expect(pj.tags).toEqual(['scope:shared', 'type:ts', 'platform:any', 'team:core']);
    expect(pj.targets).toEqual({
      lint: {
        executor: '@nx/eslint:lint',
        outputs: ['{options.outputFile}'],
        options: { lintFilePatterns: ['libs/shared/util/**/*.ts'] },
      },
      typecheck: {
        executor: 'nx:run-commands',
        options: { command: 'tsc --noEmit -p libs/shared/util/tsconfig.lib.json' },
      },
    });
  });

  it('maps @<npmScope>/<scope>-<name> to src/index.ts', async () => {
    await libGenerator(tree, { name: 'util', type: 'ts' });
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toEqual({
      '@acme/shared-util': ['libs/shared/util/src/index.ts'],
    });
  });

  it('falls back to the mouryaamit npm scope when the root package is unscoped', async () => {
    tree.write(
      'package.json',
      JSON.stringify({ name: 'plain', devDependencies: { nx: '17.0.6' } }),
    );
    await libGenerator(tree, { name: 'util', type: 'ts', scope: 'core' });
    expect(tree.exists('libs/core/util/project.json')).toBe(true);
    expect(readJson(tree, 'libs/core/util/project.json').name).toBe('core-util');
    expect(readJson(tree, 'tsconfig.base.json').compilerOptions.paths).toHaveProperty(
      '@mouryaamit/core-util',
    );
  });

  it('adds the lint packages when missing and returns an install callback', async () => {
    const cb = await libGenerator(tree, { name: 'util', type: 'ts' });
    expect(readJson(tree, 'package.json').devDependencies['@nx/eslint']).toBe('17.0.6');
    expect(typeof cb).toBe('function');
  });

  it('uses camelCase for multi-word names in the placeholder export', async () => {
    await libGenerator(tree, { name: 'date-utils', type: 'ts' });
    expect(tree.read('libs/shared/date-utils/src/lib/date-utils.ts', 'utf8')).toContain(
      'export function dateUtils()',
    );
  });
});
