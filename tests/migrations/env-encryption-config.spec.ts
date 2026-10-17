import { readJson, Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import envEncryptionConfig from '../../src/migrations/env-encryption-config/env-encryption-config';

describe('env-encryption-config migration (0.25.0)', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
  });

  it('moves encrypt-keys.json into nx.json (listed mode) and removes it', () => {
    tree.write(
      'tools/config/encrypt-keys.json',
      JSON.stringify({ _doc: 'x', _default: ['password', 'iv'], web: ['password', 'uname'] }),
    );
    tree.write('.gitignore', 'node_modules\n');
    envEncryptionConfig(tree);
    expect(tree.exists('tools/config/encrypt-keys.json')).toBe(false);
    expect(readJson(tree, 'nx.json').pstack.envEncryption).toMatchObject({
      mode: 'listed',
      cipher: 'cryptojs',
      keySources: ['commit'],
      metaName: 'x-build',
      keys: { default: ['password', 'iv'], web: ['password', 'uname'] },
    });
    expect(tree.read('.gitignore', 'utf8')).toBe('node_modules\n.env.local\n');
  });

  it('writes defaults without a legacy file and keeps an existing block', () => {
    envEncryptionConfig(tree);
    expect(readJson(tree, 'nx.json').pstack.envEncryption.keys).toEqual({ default: [] });
    tree.write('tools/config/encrypt-keys.json', '{"_default":["x"]}');
    envEncryptionConfig(tree);
    expect(readJson(tree, 'nx.json').pstack.envEncryption.keys.default).toEqual([]);
    expect(tree.exists('tools/config/encrypt-keys.json')).toBe(true);
    expect(tree.read('.gitignore', 'utf8')!.match(/\.env\.local/g)).toHaveLength(1);
  });

  it("keeps encrypting nothing for the preset's empty keys file", () => {
    tree.write('tools/config/encrypt-keys.json', '{}');
    envEncryptionConfig(tree);
    expect(readJson(tree, 'nx.json').pstack.envEncryption.keys).toEqual({ default: [] });
    expect(tree.exists('tools/config/encrypt-keys.json')).toBe(false);
  });

  it('keeps an unreadable legacy file', () => {
    tree.write('tools/config/encrypt-keys.json', '{ not json');
    envEncryptionConfig(tree);
    expect(tree.exists('tools/config/encrypt-keys.json')).toBe(true);
    expect(readJson(tree, 'nx.json').pstack.envEncryption.mode).toBe('listed');
  });

  it('keeps other pstack settings in nx.json', () => {
    tree.write('nx.json', JSON.stringify({ npmScope: 'acme', pstack: { other: 1 } }));
    envEncryptionConfig(tree);
    const nx = readJson(tree, 'nx.json');
    expect(nx.npmScope).toBe('acme');
    expect(nx.pstack.other).toBe(1);
  });
});
