import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import libGenerator from '../../src/generators/lib/generator';
import { LibType } from '../../src/generators/lib/schema.d';

describe('lib generator validation', () => {
  let tree: Tree;

  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'package.json',
      JSON.stringify({ name: '@acme/source', devDependencies: { nx: '17.0.6' } }),
    );
    tree.write('tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: {} } }));
  });

  it.each(['android-native', 'ios-native'] as LibType[])(
    '%s is planned for a later release',
    async (type) => {
      await expect(libGenerator(tree, { name: 'core', type })).rejects.toThrow(
        /planned for a later release/,
      );
    },
  );

  it('explains that auth-interceptor was removed (interceptors are project-specific)', async () => {
    await expect(
      libGenerator(tree, { name: 'auth', type: 'auth-interceptor' as LibType }),
    ).rejects.toThrow(/auth-interceptor was removed in 0\.24\.0.*project-specific/);
    expect(tree.exists('libs/shared/auth')).toBe(false);
  });

  it('rejects an unknown or missing type', async () => {
    await expect(libGenerator(tree, { name: 'core', type: 'vue' as LibType })).rejects.toThrow(
      /unknown --type="vue"/,
    );
    await expect(
      libGenerator(tree, { name: 'core', type: undefined as unknown as LibType }),
    ).rejects.toThrow(/--type is required/);
  });

  it.each(['Core', 'core_lib', '1core', 'core-', ''])(
    'rejects the non-kebab name "%s"',
    async (name) => {
      await expect(libGenerator(tree, { name, type: 'ts' })).rejects.toThrow(/kebab-case/);
    },
  );

  it('rejects a non-kebab scope or prefix', async () => {
    await expect(
      libGenerator(tree, { name: 'core', type: 'ts', scope: 'My_Scope' }),
    ).rejects.toThrow(/--scope/);
    await expect(
      libGenerator(tree, { name: 'core', type: 'angular', prefix: 'Bad Prefix' }),
    ).rejects.toThrow(/--prefix/);
  });

  it('fails when the directory already exists', async () => {
    tree.write('libs/shared/core/README.md', 'x');
    await expect(libGenerator(tree, { name: 'core', type: 'ts' })).rejects.toThrow(
      /"libs\/shared\/core" already exists/,
    );
  });

  it('fails when the lib was generated before', async () => {
    await libGenerator(tree, { name: 'core', type: 'assets' });
    await expect(libGenerator(tree, { name: 'core', type: 'assets' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('fails when the import alias is already mapped', async () => {
    tree.write(
      'tsconfig.base.json',
      JSON.stringify({
        compilerOptions: { paths: { '@acme/shared-core': ['elsewhere/index.ts'] } },
      }),
    );
    await expect(libGenerator(tree, { name: 'core', type: 'ts' })).rejects.toThrow(
      /"@acme\/shared-core" is already mapped/,
    );
    expect(tree.exists('libs/shared/core/project.json')).toBe(false);
  });

  it('fails when a project with the same name exists elsewhere', async () => {
    tree.write('apps/x/project.json', JSON.stringify({ name: 'shared-core', root: 'apps/x' }));
    await expect(libGenerator(tree, { name: 'core', type: 'assets' })).rejects.toThrow(
      /project named "shared-core" already exists/,
    );
  });
});
