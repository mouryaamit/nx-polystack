import { logger, Tree } from '@nx/devkit';
import { FsTree, flushChanges, printChanges } from 'nx/src/generators/tree';

export interface RunTreeOptions {
  dryRun: boolean;
  verbose: boolean;
  /** Don't print "Nothing to generate." when nothing changed (the caller reports it). */
  quietWhenUnchanged?: boolean;
}

/** Run `fn` against an FsTree rooted at `root`, print changes, then flush unless dry-run. Returns change count. */
export async function runInTree(
  root: string,
  opts: RunTreeOptions,
  fn: (tree: Tree) => unknown,
): Promise<number> {
  const tree = new FsTree(root, opts.verbose);
  const callback = await fn(tree);
  const changes = tree.listChanges();

  if (changes.length === 0) {
    if (!opts.quietWhenUnchanged) logger.info('Nothing to generate.');
    if (!opts.dryRun && typeof callback === 'function') await callback();
    return 0;
  }

  printChanges(changes);

  if (opts.dryRun) {
    logger.info('\nDry run complete — no files written.');
  } else {
    flushChanges(root, changes);
    logger.info(`\nDone. ${changes.length} file(s) written.`);
    // Nx GeneratorCallback (e.g. install packages): runs only after files are on disk.
    if (typeof callback === 'function') await callback();
  }
  return changes.length;
}
