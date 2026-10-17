import { Tree } from '@nx/devkit';

/**
 * Writes newContent to filePath. If a file already exists and content differs,
 * backs up the original to filePath.bak before overwriting.
 * Returns true if the file was written, false if content was identical.
 */
export function backupAndOverwrite(tree: Tree, filePath: string, newContent: string): boolean {
  if (tree.exists(filePath)) {
    const existing = (tree.read(filePath) ?? Buffer.alloc(0)).toString();
    if (existing === newContent) return false;
    tree.write(`${filePath}.bak`, existing);
  }
  tree.write(filePath, newContent);
  return true;
}
