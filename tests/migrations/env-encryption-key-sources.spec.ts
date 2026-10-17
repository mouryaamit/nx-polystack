import { readJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import migrate from '../../src/migrations/env-encryption-key-sources/env-encryption-key-sources';

describe('env-encryption-key-sources migration', () => {
  it('rewrites keySource as keySources and keeps the rest', () => {
    const tree = createTreeWithEmptyWorkspace();
    tree.write(
      'nx.json',
      JSON.stringify({
        pstack: { envEncryption: { mode: 'all', keySource: 'commit', publicKeys: ['a'] } },
      }),
    );
    migrate(tree);
    const block = readJson(tree, 'nx.json').pstack.envEncryption;
    expect(block.keySources).toEqual(['commit']);
    expect(block).not.toHaveProperty('keySource');
    expect(block.publicKeys).toEqual(['a']);
  });

  it('leaves workspaces without the block or already migrated alone', () => {
    const tree = createTreeWithEmptyWorkspace();
    const before = tree.read('nx.json', 'utf8');
    migrate(tree);
    expect(tree.read('nx.json', 'utf8')).toBe(before);

    tree.write(
      'nx.json',
      JSON.stringify({ pstack: { envEncryption: { mode: 'all', keySources: ['salt'] } } }),
    );
    const migrated = tree.read('nx.json', 'utf8');
    migrate(tree);
    expect(tree.read('nx.json', 'utf8')).toBe(migrated);
  });
});
