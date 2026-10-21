import type { FileChange, Tree } from '@nx/devkit';

/**
 * The file-system Tree from the workspace's own nx, the one place nx-polystack reaches into nx
 * internals. `@nx/devkit` does not export FsTree, flushChanges or printChanges; they live in
 * `nx/src/generators/tree` from Nx 17 to 22. A layout change in a later Nx shows up here, with a
 * message, instead of as a crash in every command that writes files.
 */
interface NxTreeModule {
  FsTree: new (root: string, isVerbose: boolean) => Tree;
  flushChanges: (root: string, changes: FileChange[]) => void;
  printChanges: (changes: FileChange[]) => void;
}

let cached: NxTreeModule | undefined;

function nxTree(): NxTreeModule {
  if (cached) return cached;
  let mod: Partial<NxTreeModule>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('nx/src/generators/tree');
  } catch (err) {
    throw new Error(
      `nx-polystack: could not load nx/src/generators/tree from the workspace's nx ` +
        `(${(err as Error).message}). nx-polystack supports Nx 17 to 22.`,
    );
  }
  if (
    typeof mod.FsTree !== 'function' ||
    typeof mod.flushChanges !== 'function' ||
    typeof mod.printChanges !== 'function'
  ) {
    throw new Error(
      'nx-polystack: this nx version has no FsTree/flushChanges/printChanges in ' +
        'nx/src/generators/tree. nx-polystack supports Nx 17 to 22.',
    );
  }
  cached = mod as NxTreeModule;
  return cached;
}

/** A Tree over the files under `root` (changes stay in memory until flushChanges). */
export function fsTree(root: string, verbose = false): Tree {
  return new (nxTree().FsTree)(root, verbose);
}

export function flushChanges(root: string, changes: FileChange[]): void {
  nxTree().flushChanges(root, changes);
}

export function printChanges(changes: FileChange[]): void {
  nxTree().printChanges(changes);
}
