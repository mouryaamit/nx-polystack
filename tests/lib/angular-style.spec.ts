import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  resolveAngularStyle,
  saveWorkspaceAngularStyle,
  workspaceAngularStyle,
} from '../../src/lib/utils/angular-style';

describe('angular style', () => {
  it('defaults to module, saves standalone keeping other nx.json keys, and resolves flags', () => {
    const tree = createTreeWithEmptyWorkspace();
    expect(workspaceAngularStyle(tree)).toBe('module');
    const nx = JSON.parse(tree.read('nx.json', 'utf8') ?? '{}');
    tree.write('nx.json', JSON.stringify({ ...nx, pstack: { adopt: { report: false } } }));
    saveWorkspaceAngularStyle(tree, 'standalone');
    const saved = JSON.parse(tree.read('nx.json', 'utf8') ?? '{}');
    expect(saved.pstack).toEqual({ adopt: { report: false }, angular: { style: 'standalone' } });
    expect(workspaceAngularStyle(tree)).toBe('standalone');
    expect(resolveAngularStyle(tree, {}, 'x')).toBe('standalone');
    expect(resolveAngularStyle(tree, { module: true }, 'x')).toBe('module');
    expect(() => resolveAngularStyle(tree, { module: true, standalone: true }, 'x')).toThrow(
      'x: pass --standalone or --module, not both.',
    );
  });
});
