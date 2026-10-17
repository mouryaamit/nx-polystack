import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { nodeRangeAllowsMajor, workspaceNodeMajor } from '../../src/lib/utils/node-engine';

describe('nodeRangeAllowsMajor', () => {
  it.each([
    ['18.x', 20, false],
    ['18.x', 18, true],
    ['>=18', 20, true],
    ['^18.2.0', 20, false],
    ['~20.11', 20, true],
    ['>=18 <21', 20, true],
    ['>=18 <20', 20, false],
    ['>=18 <20.5', 20, true],
    ['18 || 20', 20, true],
    ['16 - 20', 20, true],
    ['16 - 18', 20, false],
    ['*', 20, true],
    ['>= 18', 20, true],
    ['', 20, true],
    ['>18', 18, false],
    ['>18.x', 18, false],
    ['>18.0.0', 18, true],
    ['>18', 20, true],
    ['>=v18', 20, true],
    ['v20', 20, true],
    ['<21.0.0', 20, true],
    ['<=20', 20, true],
    ['<20.0.0', 20, false],
    ['20.x.x', 20, true],
    ['>=18.0.0-0', 20, true],
    ['<20.0.0-0', 20, false],
    ['x.x', 20, true],
  ])('%s with Node %d → %s', (range, major, expected) => {
    expect(nodeRangeAllowsMajor(range, major)).toBe(expected);
  });

  it('is undefined for ranges it cannot read', () => {
    expect(nodeRangeAllowsMajor('lts', 20)).toBeUndefined();
    expect(nodeRangeAllowsMajor('~>18', 20)).toBeUndefined();
    expect(nodeRangeAllowsMajor('lts || 16', 20)).toBeUndefined();
    expect(nodeRangeAllowsMajor('lts || 20', 20)).toBe(true);
  });
});

describe('workspaceNodeMajor', () => {
  it('reads .nvmrc', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(workspaceNodeMajor(tree)).toBeUndefined();
    tree.write('.nvmrc', '20\n');
    expect(workspaceNodeMajor(tree)).toBe(20);
    tree.write('.nvmrc', 'v18.20.8');
    expect(workspaceNodeMajor(tree)).toBe(18);
    tree.write('.nvmrc', 'v20.11');
    expect(workspaceNodeMajor(tree)).toBe(20);
    tree.write('.nvmrc', '20\r\n');
    expect(workspaceNodeMajor(tree)).toBe(20);
    tree.write('.nvmrc', 'lts/*');
    expect(workspaceNodeMajor(tree)).toBeUndefined();
  });
});
