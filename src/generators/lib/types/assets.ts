import * as path from 'path';

import { generateFiles } from '@nx/devkit';

import { LibTypeSpec, templateVars, writeLibProjectJson } from '../lib-utils';

export const assetsLib: LibTypeSpec = {
  defaultScope: 'shared',
  platform: 'any',
  tsPath: false,
  dirCase: 'kebab',
  generate(tree, o) {
    generateFiles(
      tree,
      path.join(__dirname, '..', 'files', 'assets'),
      o.projectRoot,
      templateVars(o),
    );
    tree.write(`${o.projectRoot}/assets/.gitkeep`, '');
    writeLibProjectJson(tree, o, { sourceRoot: `${o.projectRoot}/assets`, targets: {} });
    return undefined;
  },
};
