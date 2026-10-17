import { logger, Tree } from '@nx/devkit';

const WORKFLOWS = '.github/workflows';

/**
 * Action versions the plugin's workflows used, and the first version of each that runs on
 * Node 24 (GitHub deprecated Node 20 for actions). Only these exact refs are moved.
 */
export const NODE24_ACTIONS: Readonly<Record<string, { from: string; to: string }>> = {
  'actions/checkout': { from: 'v4', to: 'v5' },
  'actions/setup-node': { from: 'v4', to: 'v5' },
  'actions/cache': { from: 'v4', to: 'v5' },
  'nrwl/nx-set-shas': { from: 'v4', to: 'v5' },
  'peter-evans/create-pull-request': { from: 'v6', to: 'v8' },
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** `uses:` lines of the listed actions at their old major moved to the Node 24 major. */
export function bumpWorkflowActions(text: string): string {
  let out = text;
  for (const [action, { from, to }] of Object.entries(NODE24_ACTIONS)) {
    const re = new RegExp(`(\\buses:\\s*['"]?${escapeRegExp(action)})@${from}(?![\\w.])`, 'g');
    out = out.replace(re, `$1@${to}`);
  }
  return out;
}

/**
 * v1.0.2: GitHub runs Node 20 actions on Node 24 and has deprecated them. Workflows the plugin
 * generated (CI, PR title, dependency upgrade) move to the actions' Node 24 majors:
 * checkout/setup-node/cache/nx-set-shas v5 and create-pull-request v8. Other actions and pinned
 * SHAs are left alone.
 */
export default async function githubActionsNode24(tree: Tree): Promise<void> {
  if (!tree.exists(WORKFLOWS)) return;
  const changed: string[] = [];
  for (const name of tree.children(WORKFLOWS)) {
    const file = `${WORKFLOWS}/${name}`;
    if (!/\.ya?ml$/.test(name) || !tree.isFile(file)) continue;
    const text = tree.read(file, 'utf-8') ?? '';
    const next = bumpWorkflowActions(text);
    if (next !== text) {
      tree.write(file, next);
      changed.push(file);
    }
  }
  if (changed.length > 0) {
    logger.info(
      `github-actions-node24: ${changed.join(', ')} moved to the Node 24 action versions.`,
    );
  }
}
