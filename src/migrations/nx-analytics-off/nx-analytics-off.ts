import { logger, Tree } from '@nx/devkit';

import { keepJsonLayout, loadJsonc } from '../../lib/utils/json-layout';

/**
 * v1.11.3: Nx 22 asks on the first command whether to share usage data, and records the answer
 * as nx.json `analytics`. Sets it to false in workspaces that have not answered, so the prompt
 * does not stop local runs or scripts. An answer already in nx.json is kept.
 */
export default async function nxAnalyticsOff(tree: Tree): Promise<void> {
  if (!tree.exists('nx.json')) return;
  const before = tree.read('nx.json', 'utf8') ?? '';
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(before) as Record<string, unknown>;
  } catch {
    logger.warn('nx-analytics-off: nx.json is not plain JSON; add "analytics": false by hand.');
    return;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return;
  if (json['analytics'] !== undefined) return;
  json['analytics'] = false;
  const after = JSON.stringify(json, null, 2);
  const jsonc = loadJsonc(tree.root);
  tree.write('nx.json', (jsonc && keepJsonLayout(jsonc, before, after)) || `${after}\n`);
  logger.info(
    'nx-analytics-off: nx.json "analytics": false (Nx no longer asks to share usage data).',
  );
}
