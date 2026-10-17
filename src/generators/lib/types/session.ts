import * as path from 'path';

import { ANGULAR_LIB_VARIANTS, writeAngularLib } from '../angular-lib';
import { LibTypeSpec } from '../lib-utils';

/** Session / idle timeout starter: SessionTimeoutService, warning component, cross-tab sync. */
export const sessionLib: LibTypeSpec = {
  defaultScope: 'shared',
  platform: 'web',
  tsPath: true,
  dirCase: 'kebab',
  variants: ANGULAR_LIB_VARIANTS,
  defaultVariant: 'buildable',
  generate(tree, o) {
    return writeAngularLib(tree, o, {
      srcTemplates: path.join(__dirname, '..', 'files', 'session'),
    });
  },
};
