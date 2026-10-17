import { formatFiles, GeneratorCallback, logger, Tree } from '@nx/devkit';

import { eslintNote } from '../../generators/infra/generator';
import { addMissingDependencies } from '../../lib/utils/dependencies';
import {
  addQualityEslintRules,
  addTypecheckNxDefaults,
  addTypecheckTargets,
  addTypecheckToCi,
  qualityEslintDependencies,
} from '../../lib/utils/quality';

/**
 * v0.36.0: typecheck targets (tsc --noEmit) on projects with a tsconfig.app/lib.json, cached in
 * nx.json, run by the CI affected step; import/no-unresolved and unused-imports as ESLint
 * warnings with their packages. The commit hook is not changed.
 */
export default async function qualityChecks(tree: Tree): Promise<GeneratorCallback | undefined> {
  const typed = addTypecheckTargets(tree);
  const nxChanged = addTypecheckNxDefaults(tree);
  const ci = addTypecheckToCi(tree);
  const eslint = addQualityEslintRules(tree);
  const install =
    eslint === 'added'
      ? addMissingDependencies(tree, {}, qualityEslintDependencies(tree))
      : undefined;

  if (typed.length > 0) {
    logger.info(
      `quality-checks: typecheck target added to ${typed.join(', ')}. Run ` +
        'npx nx run-many -t typecheck once before merging: libraries are now type-checked as a ' +
        'whole (not only what apps import), and CI runs it for every affected project.',
    );
  }
  if (nxChanged) logger.info('quality-checks: typecheck is cached (nx.json targetDefaults).');
  if (ci.changed.length > 0) {
    logger.info(
      `quality-checks: typecheck added to the CI affected step in ${ci.changed.join(', ')}.`,
    );
  }
  if (ci.unknown.length > 0) {
    logger.info(
      `quality-checks: add typecheck to the nx affected targets in ${ci.unknown.join(', ')} ` +
        'by hand (e.g. nx affected -t lint typecheck test build).',
    );
  }
  if (eslint === 'added') {
    logger.info(
      'quality-checks: ESLint warns on unresolved imports and unused imports (root ' +
        '.eslintrc.json); npm install adds the ESLint plugins.',
    );
  }
  for (const note of eslintNote(eslint)) logger.info(`quality-checks: ${note}`);

  if (typed.length > 0 || nxChanged || ci.changed.length > 0 || eslint === 'added') {
    await formatFiles(tree);
  }
  return install;
}
