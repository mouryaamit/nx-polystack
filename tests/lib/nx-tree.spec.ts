import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { flushChanges, fsTree } from '../../src/lib/utils/nx-tree';

describe('nx-tree: the workspace nx FsTree behind one module', () => {
  it('reads, records and flushes changes under the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pstack-nx-tree-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'one');
    const tree = fsTree(root);
    expect(tree.read('a.txt', 'utf8')).toBe('one');
    tree.write('b/c.txt', 'two');
    const changes = tree.listChanges();
    expect(changes.map((c) => c.path)).toEqual(['b/c.txt']);
    expect(fs.existsSync(path.join(root, 'b/c.txt'))).toBe(false);
    flushChanges(root, changes);
    expect(fs.readFileSync(path.join(root, 'b/c.txt'), 'utf8')).toBe('two');
  });
});
