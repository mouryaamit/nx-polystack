import { Tree } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { addProjectTarget, setProjectTags } from '../../src/lib/utils/nx-targets';

describe('addProjectTarget', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write(
      'apps/web/project.json',
      JSON.stringify({ name: 'web', targets: { build: { executor: '@nx/webpack:webpack' } } }),
    );
  });

  it('adds a new target to project.json', () => {
    addProjectTarget(tree, 'apps/web', 'serve', {
      executor: '@nx/webpack:dev-server',
      options: { buildTarget: 'web:build' },
    });
    const cfg = JSON.parse(tree.read('apps/web/project.json')!.toString());
    expect(cfg.targets.serve.executor).toBe('@nx/webpack:dev-server');
  });

  it('throws when target already exists', () => {
    expect(() => addProjectTarget(tree, 'apps/web', 'build', { executor: 'duplicate' })).toThrow(
      /already exists/,
    );
  });
});

describe('setProjectTags', () => {
  let tree: Tree;
  beforeEach(() => {
    tree = createTreeWithEmptyWorkspace({ layout: 'apps-libs' });
    tree.write('apps/web/project.json', JSON.stringify({ name: 'web', tags: ['scope:web'] }));
  });

  it('merges tags without duplicates', () => {
    setProjectTags(tree, 'apps/web', ['scope:web', 'type:app']);
    const cfg = JSON.parse(tree.read('apps/web/project.json')!.toString());
    expect(cfg.tags).toEqual(['scope:web', 'type:app']);
  });
});
