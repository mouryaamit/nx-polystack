import * as path from 'path';

import type { Tree } from '@nx/devkit';

/** Original bytes of each path a run touched; null when the path did not exist. */
export type Originals = Map<string, Buffer | null>;

/**
 * Tree path as the Nx tree stores it: forward slashes, no leading "./" or "/"; an absolute path
 * under `root` is made relative to it, as the tree does.
 */
export function normalizeTreePath(p: string, root?: string): string {
  if (root && path.isAbsolute(p)) {
    const rel = path.relative(root, p);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) p = rel;
  }
  const n = path.posix
    .normalize(p.replace(/\\/g, '/'))
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
  return n === '.' ? '' : n;
}

function filesUnder(tree: Tree, dir: string): string[] {
  const out: string[] = [];
  for (const child of tree.children(dir)) {
    const p = dir ? `${dir}/${child}` : child;
    if (tree.isFile(p)) out.push(p);
    else out.push(...filesUnder(tree, p));
  }
  return out;
}

/**
 * A Tree that forwards everything to `tree` and records, on the first write, delete, rename or
 * mode change of each file, its content before the run (null when it did not exist). Deleting or
 * renaming a folder records every file in it.
 */
export function recordingTree(tree: Tree): { tree: Tree; originals: Originals } {
  const originals: Originals = new Map();
  const rememberFile = (key: string) => {
    if (!originals.has(key)) originals.set(key, tree.isFile(key) ? tree.read(key) : null);
  };
  /** Paths (files) the operation on `p` touches. */
  const touched = (p: string): string[] => {
    const key = normalizeTreePath(p, tree.root);
    if (tree.exists(key) && !tree.isFile(key)) return filesUnder(tree, key);
    return [key];
  };
  const remember = (p: string) => touched(p).forEach(rememberFile);

  const proxy: Tree = {
    get root() {
      return tree.root;
    },
    read: tree.read.bind(tree) as Tree['read'],
    exists: (p) => tree.exists(p),
    isFile: (p) => tree.isFile(p),
    children: (p) => tree.children(p),
    listChanges: () => tree.listChanges(),
    write: (p, content, options) => {
      remember(p);
      tree.write(p, content, options);
    },
    delete: (p) => {
      remember(p);
      tree.delete(p);
    },
    rename: (from, to) => {
      const fromKey = normalizeTreePath(from, tree.root);
      const toKey = normalizeTreePath(to, tree.root);
      for (const file of touched(fromKey)) {
        rememberFile(file);
        rememberFile(toKey + file.slice(fromKey.length));
      }
      tree.rename(from, to);
    },
    changePermissions: (p, mode) => {
      remember(p);
      tree.changePermissions(p, mode);
    },
  };
  return { tree: proxy, originals };
}
