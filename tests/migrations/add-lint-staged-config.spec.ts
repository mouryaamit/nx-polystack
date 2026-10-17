import { readJson, Tree, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import { LINT_STAGED_CONFIG } from '../../src/lib/utils/lint-staged';
import addLintStagedConfig from '../../src/migrations/add-lint-staged-config/add-lint-staged-config';

function tree(hook?: string): Tree {
  const t = createTreeWithEmptyWorkspace();
  if (hook !== undefined) t.write('.husky/pre-commit', hook);
  return t;
}

describe('add-lint-staged-config migration', () => {
  it('adds the config when the pre-commit hook runs lint-staged without one', async () => {
    const t = tree('npx lint-staged\n');
    await addLintStagedConfig(t);
    expect(readJson(t, 'package.json')['lint-staged']).toEqual({
      '*.{ts,html,scss,json,md}': ['prettier --write'],
      '*.ts': ['eslint --fix'],
    });
    expect(LINT_STAGED_CONFIG['*.ts']).toEqual(['eslint --fix']);
  });

  it('keeps an existing config in package.json or in a config file', async () => {
    const own = tree('npx lint-staged\n');
    updateJson(own, 'package.json', (j) => ({ ...j, 'lint-staged': { '*.js': 'eslint' } }));
    await addLintStagedConfig(own);
    expect(readJson(own, 'package.json')['lint-staged']).toEqual({ '*.js': 'eslint' });

    const file = tree('npx lint-staged\n');
    file.write('.lintstagedrc.json', '{}');
    const before = file.read('package.json', 'utf8');
    await addLintStagedConfig(file);
    expect(file.read('package.json', 'utf8')).toBe(before);
  });

  it('leaves workspaces whose hook does not run lint-staged alone', async () => {
    for (const t of [tree(), tree('npm test\n')]) {
      const before = t.read('package.json', 'utf8');
      await addLintStagedConfig(t);
      expect(t.read('package.json', 'utf8')).toBe(before);
    }
  });

  it('is idempotent and tolerates a missing package.json', async () => {
    const t = tree('npx lint-staged\n');
    await addLintStagedConfig(t);
    const once = t.read('package.json', 'utf8');
    await addLintStagedConfig(t);
    expect(t.read('package.json', 'utf8')).toBe(once);
    const empty = tree('npx lint-staged\n');
    empty.delete('package.json');
    await expect(addLintStagedConfig(empty)).resolves.toBeUndefined();
  });

  it('is registered for 0.18.1', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const manifest = require('../../migrations.json');
    expect(manifest.generators['add-lint-staged-config']).toMatchObject({
      version: '0.18.1',
      implementation: './src/migrations/add-lint-staged-config/add-lint-staged-config',
    });
  });
});
