import { logger, readJson, Tree } from '@nx/devkit';

import { POLYSTACK_BUILD_EXECUTOR } from '../../lib/utils/angular-project';
import { patchMainInTree } from '../../lib/utils/csp-nonce';
import { projectJsonFiles } from '../../lib/utils/project-json-files';

/**
 * v0.24.0: Angular and Ionic apps with the polystack release target import the library's CSP
 * nonce patch first in main.ts. Local nonce patch imports are kept.
 */
interface Target {
  executor?: string;
  options?: Record<string, unknown>;
}

export default function addCspNonceImport(tree: Tree): void {
  const changed: string[] = [];
  for (const file of projectJsonFiles(tree, '')) {
    let project: { name?: string; targets?: Record<string, Target> };
    try {
      project = readJson(tree, file);
    } catch {
      continue;
    }
    const name = project.name ?? file.split('/').slice(-2, -1)[0];
    const targets = project.targets ?? {};
    const release = Object.values(targets).find(
      (t) =>
        t.executor === POLYSTACK_BUILD_EXECUTOR &&
        ['angular', 'ionic'].includes(String(t.options?.['type'])),
    );
    if (!release) continue;
    const buildTarget = String(release.options?.['buildTarget'] ?? `${name}:build`);
    const [owner, target] = buildTarget.split(':');
    const build = owner === name ? targets[target ?? 'build'] : undefined;
    const main = build?.options?.['main'];
    if (typeof main !== 'string' || !tree.exists(main)) continue;
    const before = tree.read(main, 'utf8');
    // Local nonce patches stay: an update only adds the library import before them.
    patchMainInTree(tree, main, { replaceLocal: false });
    if (tree.read(main, 'utf8') !== before) changed.push(main);
  }
  if (changed.length > 0) {
    logger.info(
      `add-csp-nonce-import: ${changed.join(
        ', ',
      )} now import '@mouryaamit/nx-polystack/runtime/csp-nonce' first.`,
    );
  }
}
