import * as path from 'path';

import {
  angularGeneratorVersions,
  workspaceGeneratorVersions,
} from '../../../lib/utils/angular-deps';
import { declaredVersion } from '../../../lib/utils/dependencies';
import { ANGULAR_LIB_VARIANTS, writeAngularLib } from '../angular-lib';
import { caretRange, LibTypeSpec } from '../lib-utils';

/** Ionic line the ionic app type installs on an Angular 15 workspace (16: the step's pin). */
export const IONIC_ANGULAR_VERSION = angularGeneratorVersions(15).ionicAngular;

export const ionicLib: LibTypeSpec = {
  defaultScope: 'ionic',
  platform: 'mobile',
  tsPath: true,
  dirCase: 'kebab',
  variants: ANGULAR_LIB_VARIANTS,
  defaultVariant: 'buildable',
  generate(tree, o) {
    return writeAngularLib(tree, o, {
      srcTemplates: path.join(__dirname, '..', 'files', 'ionic'),
      // @angular/forms and @angular/router are peers of @ionic/angular; match the installed Angular.
      dependencies: (core) => ({
        '@ionic/angular': workspaceGeneratorVersions(tree).ionicAngular,
        '@angular/forms': core,
        '@angular/router': core,
      }),
      // The page component is named <Name>Page.
      componentSuffixes: ['Page', 'Component'],
      peerDependencies: (t) => ({
        '@ionic/angular': caretRange(declaredVersion(t, '@ionic/angular'), '^7.8.0'),
      }),
    });
  },
};
