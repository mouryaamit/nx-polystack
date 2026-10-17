import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { addTsPath, removeTsPath } from '../../src/lib/utils/ts-paths';

describe('addTsPath / removeTsPath', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'tsconfig.base.json',
      JSON.stringify({
        compilerOptions: {
          paths: { '@scope/existing': ['libs/existing/src/index.ts'] },
        },
      }),
    );
  });

  it('adds a path mapping', () => {
    addTsPath(tree, '@mouryaamit/foo', 'libs/shared/foo/src/index.ts');
    const cfg = JSON.parse(tree.read('tsconfig.base.json')!.toString());
    expect(cfg.compilerOptions.paths['@mouryaamit/foo']).toEqual([
      'libs/shared/foo/src/index.ts',
    ]);
  });

  it('refuses to overwrite an existing alias', () => {
    expect(() => addTsPath(tree, '@scope/existing', 'libs/other/src/index.ts')).toThrow(
      /already mapped/,
    );
  });

  it('removes a path mapping', () => {
    removeTsPath(tree, '@scope/existing');
    const cfg = JSON.parse(tree.read('tsconfig.base.json')!.toString());
    expect(cfg.compilerOptions.paths['@scope/existing']).toBeUndefined();
  });
});
