import { logger, Tree } from '@nx/devkit';

import { LINT_STAGED_ESLINT_JS, LINT_STAGED_ESLINT_SCRIPT } from '../../lib/utils/quality';

/** The line of the earlier script that ESLint 8+ refuses (bin/eslint.js is not exported). */
const OLD_RESOLVE = "require.resolve('eslint/bin/eslint.js'";

/**
 * v1.10.4: the lint-staged warn script resolved `eslint/bin/eslint.js`, which ESLint 8 and later
 * do not export, so every commit with staged *.ts files failed with "ESLint is not installed".
 * Rewrites the script when it is the plugin's own (edited copies are left alone).
 */
export default async function lintStagedEslintResolve(tree: Tree): Promise<void> {
  const text = tree.read(LINT_STAGED_ESLINT_SCRIPT, 'utf8');
  if (text === null || !text.includes('Written by nx-polystack') || !text.includes(OLD_RESOLVE)) {
    return;
  }
  tree.write(LINT_STAGED_ESLINT_SCRIPT, LINT_STAGED_ESLINT_JS);
  logger.info(`lint-staged-eslint-resolve: ${LINT_STAGED_ESLINT_SCRIPT} finds ESLint 8+ again.`);
}
