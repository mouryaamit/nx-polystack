import { readJson, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import sharpSecurityUpdate, {
  needsSharpUpdate,
} from '../../src/migrations/sharp-security-update/sharp-security-update';

describe('sharp-security-update migration (v0.39.3)', () => {
  it.each([
    ['^0.33.0', true],
    ['~0.34.2', true],
    ['0.35.4', true],
    ['^0.35.5', false],
    ['^0.36.0', false],
    ['latest', false],
    ['file:../sharp', false],
    [undefined, false],
  ])('%s needs an update: %s', (spec, expected) => {
    expect(needsSharpUpdate(spec)).toBe(expected);
  });

  it('moves sharp to ^0.35.5 where it is declared, nothing else', async () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => ({
      ...j,
      devDependencies: { sharp: '^0.33.0', nx: '17.0.6' },
    }));
    await sharpSecurityUpdate(tree);
    await sharpSecurityUpdate(tree);
    expect(readJson(tree, 'package.json').devDependencies).toEqual({
      sharp: '^0.35.5',
      nx: '17.0.6',
    });
  });

  it('does not add sharp', async () => {
    const tree = createTreeWithEmptyWorkspace();
    const before = tree.read('package.json', 'utf-8');
    await sharpSecurityUpdate(tree);
    expect(tree.read('package.json', 'utf-8')).toBe(before);
  });
});
