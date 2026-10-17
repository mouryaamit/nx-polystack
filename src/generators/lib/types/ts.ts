import * as path from 'path';

import { generateFiles, Tree } from '@nx/devkit';

import { ensureLintDependencies } from '../../../lib/utils/dependencies';
import {
  lintTarget,
  LibTypeSpec,
  NormalizedLibOptions,
  templateVars,
  writeLibProjectJson,
} from '../lib-utils';

const TS_FILES = path.join(__dirname, '..', 'files', 'ts');

/** Strict tsconfig.json / tsconfig.lib.json and .eslintrc.json of a framework-free TS lib. */
export function writeTsLibConfig(tree: Tree, o: NormalizedLibOptions): void {
  generateFiles(tree, path.join(TS_FILES, 'config'), o.projectRoot, templateVars(o));
}

export const tsLib: LibTypeSpec = {
  defaultScope: 'shared',
  platform: 'any',
  tsPath: true,
  dirCase: 'kebab',
  generate(tree: Tree, o: NormalizedLibOptions) {
    writeTsLibConfig(tree, o);
    generateFiles(tree, path.join(TS_FILES, 'sample'), o.projectRoot, templateVars(o));
    writeLibProjectJson(tree, o, {
      sourceRoot: `${o.projectRoot}/src`,
      targets: { lint: lintTarget(o, ['**/*.ts']) },
    });
    return ensureLintDependencies(tree);
  },
};
