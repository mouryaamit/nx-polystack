import * as path from 'path';

import { generateFiles, logger } from '@nx/devkit';

import { LibTypeSpec, templateVars, writeLibProjectJson } from '../lib-utils';

export const flutterLib: LibTypeSpec = {
  defaultScope: 'flutter',
  platform: 'flutter',
  tsPath: false,
  dirCase: 'snake',
  generate(tree, o) {
    generateFiles(
      tree,
      path.join(__dirname, '..', 'files', 'flutter'),
      o.projectRoot,
      templateVars(o),
    );
    const run = (command: string) => ({
      executor: 'nx:run-commands',
      options: { command, cwd: o.projectRoot },
    });
    writeLibProjectJson(tree, o, {
      sourceRoot: `${o.projectRoot}/lib`,
      targets: { analyze: run('flutter analyze'), test: run('flutter test') },
    });
    logger.info(
      `Add ${o.snakeName} to an app's pubspec.yaml dependencies:\n\n` +
        `  ${o.snakeName}:\n    path: ../../${o.projectRoot}\n`,
    );
    return undefined;
  },
};
