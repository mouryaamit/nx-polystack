import { Tree } from '@nx/devkit';

/** lint-staged config for the husky pre-commit hook `pstack new` writes (`npx lint-staged`). */
export const LINT_STAGED_CONFIG: Readonly<Record<string, string[]>> = {
  '*.{ts,html,scss,json,md}': ['prettier --write'],
  '*.ts': ['eslint --fix'],
};

const CONFIG_FILES = [
  '.lintstagedrc',
  '.lintstagedrc.json',
  '.lintstagedrc.yaml',
  '.lintstagedrc.yml',
  '.lintstagedrc.mjs',
  '.lintstagedrc.cjs',
  '.lintstagedrc.js',
  'lint-staged.config.js',
  'lint-staged.config.mjs',
  'lint-staged.config.cjs',
];

/** True when the workspace configures lint-staged (package.json key or a config file). */
export function hasLintStagedConfig(tree: Tree): boolean {
  if (CONFIG_FILES.some((f) => tree.exists(f))) return true;
  try {
    const pkg = JSON.parse(tree.read('package.json', 'utf8') ?? '{}');
    return pkg['lint-staged'] !== undefined;
  } catch {
    return false;
  }
}
