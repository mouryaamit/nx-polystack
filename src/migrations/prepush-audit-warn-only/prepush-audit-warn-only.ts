import { readJson, Tree, updateJson } from '@nx/devkit';

import { INFRA_SCRIPTS, PREPUSH_V0_9_0 } from '../../generators/infra/generator';

/**
 * v0.9.1: the v0.9.0 `check:prepush` ran `npm audit` first and blocked the push on any high
 * advisory, including ones with no fix for the workspace's framework major. In workspaces that have
 * `check:prepush`, rewrites it only when it is exactly the v0.9.0 default (secret scan first and
 * blocking, audit warn-only), and adds the strict `check:audit` when missing.
 */
export default async function prepushAuditWarnOnly(tree: Tree): Promise<void> {
  if (!tree.exists('package.json')) return;
  const scripts = readJson(tree, 'package.json').scripts ?? {};
  if (typeof scripts['check:prepush'] !== 'string') return;
  const rewrite = scripts['check:prepush'] === PREPUSH_V0_9_0;
  const addAudit = scripts['check:audit'] === undefined;
  if (!rewrite && !addAudit) return;
  updateJson(tree, 'package.json', (json) => {
    if (rewrite) json.scripts['check:prepush'] = INFRA_SCRIPTS['check:prepush'];
    if (addAudit) json.scripts['check:audit'] = INFRA_SCRIPTS['check:audit'];
    return json;
  });
}
