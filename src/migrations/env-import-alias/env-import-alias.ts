import { logger, Tree } from '@nx/devkit';

import { applyEnvAlias, ENV_ALIAS, ENV_ALIAS_TARGET } from '../../lib/utils/env-alias';

/**
 * v1.2.7: env files are imported through the `@env/*` alias instead of a relative path into the
 * root environments/ folder, which `@nx/enforce-module-boundaries` refuses from Nx 18 on.
 * Adds the alias to tsconfig.base.json and rewrites the imports; the files stay where they are.
 */
export default function envImportAlias(tree: Tree): void {
  const report = applyEnvAlias(tree);
  if (report.state === 'no-environments') return;
  if (report.state === 'conflict') {
    logger.warn(
      `env-import-alias: tsconfig maps "${ENV_ALIAS}" to something other than ` +
        `"${ENV_ALIAS_TARGET}"; env imports were left relative. They fail ` +
        '@nx/enforce-module-boundaries from Nx 18 on.',
    );
    return;
  }
  if (report.state === 'no-tsconfig') {
    logger.warn(
      'env-import-alias: no readable tsconfig.base.json; env imports were left relative.',
    );
    return;
  }
  const files = Object.keys(report.files);
  if (report.state === 'added') logger.info(`env-import-alias: added "${ENV_ALIAS}" to tsconfig.`);
  if (files.length > 0) {
    logger.info(`env-import-alias: env imports now use @env/ in ${files.join(', ')}.`);
  }
}
