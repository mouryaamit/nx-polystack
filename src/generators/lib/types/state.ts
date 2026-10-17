import * as path from 'path';

import { logger, names } from '@nx/devkit';

import { majorOf } from '../../../lib/utils/dependencies';
import { writeAngularLib } from '../angular-lib';
import { LibTypeSpec } from '../lib-utils';

export const STATE_VARIANTS = ['simple-service', 'ngrx'] as const;

/** NgRx line that supports Angular 15. */
export const NGRX_VERSION = '~15.4.0';
const NGRX_PACKAGES = ['@ngrx/store', '@ngrx/effects'];

/** NgRx runtime packages for the installed Angular, or none (with a warning) off Angular 15. */
function ngrxDependencies(angularCore: string): Record<string, string> {
  if (majorOf(angularCore) === 15) {
    return Object.fromEntries(NGRX_PACKAGES.map((p) => [p, NGRX_VERSION]));
  }
  logger.warn(
    `nx-polystack: workspace uses Angular ${majorOf(angularCore) ?? angularCore}; the ngrx ` +
      `state lib targets Angular 15 (NgRx ${NGRX_VERSION}). Not adding packages automatically — ` +
      `install versions matching your Angular for: ${NGRX_PACKAGES.join(', ')}.`,
  );
  return {};
}

export const stateLib: LibTypeSpec = {
  defaultScope: 'shared',
  platform: 'web',
  tsPath: true,
  dirCase: 'kebab',
  variants: STATE_VARIANTS,
  defaultVariant: 'simple-service',
  rejectedVariants: {
    'signal-store':
      'needs Angular 16+ (signals); the generated libs target Angular 15. ' +
      'Use --variant=simple-service or ngrx.',
  },
  generate(tree, o) {
    const ngrx = o.variant === 'ngrx';
    return writeAngularLib(tree, o, {
      srcTemplates: path.join(__dirname, '..', 'files', 'state', o.variant ?? 'simple-service'),
      // --variant picks the state flavour, so the build kind is fixed.
      build: 'buildable',
      vars: { constantName: names(o.name).constantName },
      dependencies: ngrx ? ngrxDependencies : undefined,
      peerDependencies: ngrx
        ? (_t, core) =>
            majorOf(core) === 15 ? Object.fromEntries(NGRX_PACKAGES.map((p) => [p, '^15.4.0'])) : {}
        : undefined,
    });
  },
};
