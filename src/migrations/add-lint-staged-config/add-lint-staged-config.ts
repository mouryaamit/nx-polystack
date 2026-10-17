import { Tree, updateJson } from '@nx/devkit';

import { hasLintStagedConfig, LINT_STAGED_CONFIG } from '../../lib/utils/lint-staged';

/**
 * v0.18.1: `pstack new` wrote a husky pre-commit hook running `npx lint-staged` but no lint-staged
 * config, so the first commit after the initial one failed ("No valid configuration found"). Adds
 * the config to package.json when the hook runs lint-staged and nothing configures it.
 */
export default async function addLintStagedConfig(tree: Tree): Promise<void> {
  if (!tree.exists('package.json')) return;
  const hook = tree.read('.husky/pre-commit', 'utf8') ?? '';
  if (!/\blint-staged\b/.test(hook) || hasLintStagedConfig(tree)) return;
  updateJson(tree, 'package.json', (json) => ({
    ...json,
    'lint-staged': { ...LINT_STAGED_CONFIG },
  }));
}
