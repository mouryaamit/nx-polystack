import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { addNpmScripts, removeNpmScripts } from '../../src/lib/utils/npm-scripts';

describe('addNpmScripts', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: { existing: 'echo hi' } }));
  });

  it('merges new scripts into root package.json', () => {
    addNpmScripts(tree, { 'serve:web': 'nx serve web', 'build:web:dev': 'nx build web' });
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.scripts).toMatchObject({
      existing: 'echo hi',
      'serve:web': 'nx serve web',
      'build:web:dev': 'nx build web',
    });
  });

  it('errors on collision unless force=true', () => {
    expect(() => addNpmScripts(tree, { existing: 'overwrite' })).toThrow(/exists/);
    addNpmScripts(tree, { existing: 'overwrite' }, { force: true });
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.scripts.existing).toBe('overwrite');
  });
});

describe('removeNpmScripts', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('package.json', JSON.stringify({ scripts: { 'serve:web': 'x', lint: 'y' } }));
  });

  it('deletes named scripts', () => {
    removeNpmScripts(tree, ['serve:web']);
    const pkg = JSON.parse(tree.read('package.json')!.toString());
    expect(pkg.scripts).toEqual({ lint: 'y' });
  });
});
