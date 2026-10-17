import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { backupAndOverwrite } from '../../src/lib/utils/filesystem';

describe('backupAndOverwrite', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  });

  it('writes the file when it does not exist', () => {
    const written = backupAndOverwrite(tree, 'foo.txt', 'hello');
    expect(written).toBe(true);
    expect(tree.read('foo.txt')!.toString()).toBe('hello');
    expect(tree.exists('foo.txt.bak')).toBe(false);
  });

  it('backs up and overwrites when content differs', () => {
    tree.write('foo.txt', 'original');
    const written = backupAndOverwrite(tree, 'foo.txt', 'updated');
    expect(written).toBe(true);
    expect(tree.read('foo.txt')!.toString()).toBe('updated');
    expect(tree.read('foo.txt.bak')!.toString()).toBe('original');
  });

  it('returns false and does not write when content is identical', () => {
    tree.write('foo.txt', 'same');
    const written = backupAndOverwrite(tree, 'foo.txt', 'same');
    expect(written).toBe(false);
    expect(tree.exists('foo.txt.bak')).toBe(false);
  });
});
