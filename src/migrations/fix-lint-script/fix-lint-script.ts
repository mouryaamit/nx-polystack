import { readJson, Tree, updateJson } from '@nx/devkit';

import { DEFAULT_LINT_SCRIPT, isRecursiveLintCommand } from '../../generators/preset/generator';

/**
 * v0.8.0: `pstack new` wrote `"lint": "npm run lint"` (and `"lint:fix": "npm run lint --fix"`) into
 * the workspace package.json, so `npm run lint` called itself forever. Replaces only an exactly
 * self-calling `lint` script (and `lint:fix` with it) with `nx run-many -t lint`; any other lint script is left alone.
 */
export default async function fixLintScript(tree: Tree): Promise<void> {
  if (!tree.exists('package.json')) return;
  const scripts = readJson(tree, 'package.json').scripts ?? {};
  const fixLint = typeof scripts.lint === 'string' && isRecursiveLintCommand(scripts.lint);
  if (!fixLint) return;
  // lint:fix ("npm run lint --fix") only recursed through lint; fix it only alongside lint.
  const fixLintFix =
    typeof scripts['lint:fix'] === 'string' && isRecursiveLintCommand(scripts['lint:fix']);
  updateJson(tree, 'package.json', (json) => {
    json.scripts.lint = DEFAULT_LINT_SCRIPT;
    if (fixLintFix) json.scripts['lint:fix'] = `${DEFAULT_LINT_SCRIPT} --fix`;
    return json;
  });
}
