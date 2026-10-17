import { readJson, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import addExecutorPeers from '../../src/migrations/add-executor-peers/add-executor-peers';

describe('add-executor-peers migration', () => {
  it('adds sharp and crypto-js to devDependencies when both are missing', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const cb = await addExecutorPeers(tree);
    const pkg = readJson(tree, 'package.json');
    expect(pkg.devDependencies.sharp).toBe('^0.33.0');
    expect(pkg.devDependencies['crypto-js']).toBe('^4.2.0');
    expect(typeof cb).toBe('function');
  });

  it.each(['dependencies', 'devDependencies'])(
    'adds nothing and returns undefined when both are in %s',
    async (field) => {
      const tree = createTreeWithEmptyWorkspace();
      updateJson(tree, 'package.json', (j) => {
        j[field] = { ...j[field], sharp: '^0.32.0', 'crypto-js': '^4.1.0' };
        return j;
      });
      const before = readJson(tree, 'package.json');
      expect(await addExecutorPeers(tree)).toBeUndefined();
      expect(readJson(tree, 'package.json')).toEqual(before);
    },
  );

  it('adds only the missing one', async () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.dependencies = { ...j.dependencies, sharp: '^0.32.0' };
      return j;
    });
    const cb = await addExecutorPeers(tree);
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies.sharp).toBe('^0.32.0');
    expect(pkg.devDependencies.sharp).toBeUndefined();
    expect(pkg.devDependencies['crypto-js']).toBe('^4.2.0');
    expect(typeof cb).toBe('function');
  });
});
