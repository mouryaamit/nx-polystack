import * as path from 'path';

import { ANGULAR_LIB_VARIANTS, writeAngularLib } from '../angular-lib';
import { LibTypeSpec } from '../lib-utils';

/** PII masking starter: maskPii(), the piiMask pipe and the masking directive. */
export const piiLib: LibTypeSpec = {
  defaultScope: 'shared',
  platform: 'web',
  tsPath: true,
  dirCase: 'kebab',
  variants: ANGULAR_LIB_VARIANTS,
  defaultVariant: 'buildable',
  generate(tree, o) {
    return writeAngularLib(tree, o, { srcTemplates: path.join(__dirname, '..', 'files', 'pii') });
  },
};
