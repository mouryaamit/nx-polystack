import { GeneratorCallback, readJson, Tree } from '@nx/devkit';

import { ngPackagrDependencies } from '../../lib/utils/angular-deps';
import { addMissingDependencies, declaredVersion } from '../../lib/utils/dependencies';

const PACKAGE_EXECUTORS = new Set(['@nx/angular:package', '@nx/angular:ng-packagr-lite']);

/** project.json files under apps/ and libs/ (any depth; skips node_modules and dot dirs). */
function projectJsonFiles(tree: Tree, dir: string): string[] {
  if (!tree.exists(dir) || tree.isFile(dir)) return [];
  const found: string[] = [];
  for (const child of tree.children(dir)) {
    if (child === 'node_modules' || child.startsWith('.')) continue;
    const p = `${dir}/${child}`;
    if (tree.isFile(p)) {
      if (child === 'project.json') found.push(p);
    } else {
      found.push(...projectJsonFiles(tree, p));
    }
  }
  return found;
}

function hasPackageBuild(tree: Tree, file: string): boolean {
  try {
    const targets = readJson(tree, file).targets ?? {};
    return Object.values(targets).some((t) =>
      PACKAGE_EXECUTORS.has((t as { executor?: string }).executor ?? ''),
    );
  } catch {
    return false;
  }
}

/**
 * v0.6.1: buildable/publishable Angular libs from v0.6.0 fail with "Cannot find module
 * 'postcss-preset-env'" because the PostCSS packages the Nx package executors load were never
 * added. Adds whatever is missing when any project uses those executors; never upgrades.
 */
export default async function addLibBuildDependencies(
  tree: Tree,
): Promise<GeneratorCallback | undefined> {
  const files = [...projectJsonFiles(tree, 'libs'), ...projectJsonFiles(tree, 'apps')];
  if (!files.some((f) => hasPackageBuild(tree, f))) return undefined;
  return addMissingDependencies(
    tree,
    {},
    ngPackagrDependencies(declaredVersion(tree, '@angular/core')),
  );
}
