import { createTree } from '@nx/devkit/testing';

import { recordingTree } from '../../../src/generators/migrate/rollback/recording-tree';

describe('recordingTree', () => {
  it('keeps the first original of each path, null for new files', () => {
    const base = createTree();
    base.write('a.txt', 'one');
    const { tree, originals } = recordingTree(base);
    tree.write('a.txt', 'two');
    tree.write('a.txt', 'three');
    tree.write('./b/c.txt', 'new');
    expect(originals.get('a.txt')?.toString()).toBe('one');
    expect(originals.get('b/c.txt')).toBeNull();
    expect(base.read('a.txt', 'utf-8')).toBe('three');
    expect(base.read('b/c.txt', 'utf-8')).toBe('new');
  });

  it('records deleted files, files of deleted folders and both sides of a rename', () => {
    const base = createTree();
    base.write('d/x.txt', 'x');
    base.write('d/y/z.txt', 'z');
    base.write('r.txt', 'r');
    const { tree, originals } = recordingTree(base);
    tree.delete('d');
    tree.rename('r.txt', 's.txt');
    expect([...originals.keys()].sort()).toEqual(['d/x.txt', 'd/y/z.txt', 'r.txt', 's.txt']);
    expect(originals.get('d/y/z.txt')?.toString()).toBe('z');
    expect(originals.get('r.txt')?.toString()).toBe('r');
    expect(originals.get('s.txt')).toBeNull();
    expect(base.exists('d/x.txt')).toBe(false);
    expect(base.read('s.txt', 'utf-8')).toBe('r');
  });

  it('forwards reads, listings and the root', () => {
    const base = createTree();
    base.write('a/b.txt', 'b');
    const { tree, originals } = recordingTree(base);
    expect(tree.root).toBe(base.root);
    expect(tree.read('a/b.txt', 'utf-8')).toBe('b');
    expect(tree.read('a/b.txt')?.toString()).toBe('b');
    expect(tree.exists('a')).toBe(true);
    expect(tree.isFile('a/b.txt')).toBe(true);
    expect(tree.children('a')).toEqual(['b.txt']);
    expect(tree.listChanges()).toEqual(base.listChanges());
    expect(originals.size).toBe(0);
  });
});
