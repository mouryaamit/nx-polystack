import { GeneratorCallback, Tree } from '@nx/devkit';

import { ensureAngularDependencies } from '../../lib/utils/angular-deps';
import { declaredVersion, ensureLintDependencies } from '../../lib/utils/dependencies';

/**
 * v0.4.1: workspaces from earlier `pstack new` lack the ESLint packages their root config needs,
 * and Angular apps lack @nx/angular / @angular-eslint/*. Adds whatever is missing; never upgrades.
 */
export default async function addLintDependencies(
  tree: Tree,
): Promise<GeneratorCallback | undefined> {
  const callbacks: GeneratorCallback[] = [];
  const lint = ensureLintDependencies(tree);
  if (lint) callbacks.push(lint);
  if (declaredVersion(tree, '@angular/core') !== undefined) {
    const angular = ensureAngularDependencies(tree);
    if (angular) callbacks.push(angular);
  }
  if (callbacks.length === 0) return undefined;
  return async () => {
    for (const cb of callbacks) await cb();
  };
}
