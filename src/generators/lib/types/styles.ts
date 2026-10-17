import * as path from 'path';

import { generateFiles } from '@nx/devkit';

import { LibTypeSpec, templateVars, writeLibProjectJson } from '../lib-utils';

export const stylesLib: LibTypeSpec = {
  defaultScope: 'shared',
  platform: 'web',
  tsPath: false,
  dirCase: 'kebab',
  generate(tree, o) {
    generateFiles(
      tree,
      path.join(__dirname, '..', 'files', 'styles'),
      o.projectRoot,
      templateVars(o),
    );
    writeLibProjectJson(tree, o, { sourceRoot: `${o.projectRoot}/src`, targets: {} });
    return undefined;
  },
};
