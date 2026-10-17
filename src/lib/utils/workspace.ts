import { readJson, Tree } from '@nx/devkit';

const FALLBACK_NPM_SCOPE = 'mouryaamit';

/** `x` from a root package.json named `@x/...`; else the default scope. */
export function workspaceNpmScope(tree: Tree): string {
  if (!tree.exists('package.json')) return FALLBACK_NPM_SCOPE;
  const name = readJson(tree, 'package.json').name;
  const m = typeof name === 'string' ? /^@([^/]+)\//.exec(name) : null;
  return m ? m[1] : FALLBACK_NPM_SCOPE;
}
