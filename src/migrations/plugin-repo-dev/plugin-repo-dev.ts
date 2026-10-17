import { logger, Tree } from '@nx/devkit';

import { installSource } from '../../cli/install-source';
import { LEGACY_GITHUB_REPOS, PLUGIN_GITHUB_REPO } from '../../cli/versions';

const WORKFLOWS = '.github/workflows';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The earlier repo name as a whole word: not the package name (@…), not a longer repo name. */
const LEGACY = new RegExp(
  `(?<![@\\w.-])(?:${LEGACY_GITHUB_REPOS.map(escapeRegExp).join('|')})(?![\\w-])`,
  'g',
);

/** Text with the earlier repo name replaced by the development repo. */
export function renamePluginRepo(text: string): string {
  return text.replace(LEGACY, PLUGIN_GITHUB_REPO);
}

/**
 * v0.38.2: the plugin repo is now example-org/private-plugin. GitHub workflows that name the
 * earlier repo (the dependency-upgrade workflow reads its releases) point at the new name.
 * `pstack update` itself moves the package.json pin.
 */
export default async function pluginRepoDev(tree: Tree): Promise<void> {
  // In the npm build the earlier name is the public repo: nothing to point elsewhere.
  if (installSource().kind === 'npm' || !tree.exists(WORKFLOWS)) return;
  const changed: string[] = [];
  for (const name of tree.children(WORKFLOWS)) {
    const file = `${WORKFLOWS}/${name}`;
    if (!/\.ya?ml$/.test(name) || !tree.isFile(file)) continue;
    const text = tree.read(file, 'utf-8') ?? '';
    const next = renamePluginRepo(text);
    if (next !== text) {
      tree.write(file, next);
      changed.push(file);
    }
  }
  if (changed.length > 0) {
    logger.info(`plugin-repo-dev: ${changed.join(', ')} now name ${PLUGIN_GITHUB_REPO}.`);
  }
}
