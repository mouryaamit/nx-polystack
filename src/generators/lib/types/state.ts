import * as path from 'path';

import { logger, names } from '@nx/devkit';

import { majorOf } from '../../../lib/utils/dependencies';
import { writeAngularLib } from '../angular-lib';
import { LibTypeSpec } from '../lib-utils';

export const STATE_VARIANTS = ['simple-service', 'ngrx'] as const;

/** NgRx line that supports Angular 15. */
export const NGRX_VERSION = '~15.4.0';
/** NgRx line for each Angular major the state lib installs it for. */
const NGRX_BY_ANGULAR: Record<number, string> = { 14: '~14.3.0', 15: NGRX_VERSION };
const NGRX_PACKAGES = ['@ngrx/store', '@ngrx/effects'];

/** NgRx runtime packages for the installed Angular, or none (with a warning) off Angular 14–15. */
function ngrxDependencies(angularCore: string): Record<string, string> {
  const ngrx = NGRX_BY_ANGULAR[majorOf(angularCore) ?? 0];
  if (ngrx) return Object.fromEntries(NGRX_PACKAGES.map((p) => [p, ngrx]));
  logger.warn(
    `nx-polystack: workspace uses Angular ${majorOf(angularCore) ?? angularCore}; the ngrx ` +
      `state lib installs NgRx for Angular 14 and 15 only. Not adding packages automatically — ` +
      `install versions matching your Angular for: ${NGRX_PACKAGES.join(', ')}.`,
  );
  return {};
}

/** The NgRx peer range a buildable state lib declares (^<line>.0 of the major's NgRx). */
function ngrxPeers(core: string): Record<string, string> {
  const ngrx = NGRX_BY_ANGULAR[majorOf(core) ?? 0];
  return ngrx ? Object.fromEntries(NGRX_PACKAGES.map((p) => [p, ngrx.replace('~', '^')])) : {};
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
      peerDependencies: ngrx ? (_t, core) => ngrxPeers(core) : undefined,
    });
  },
};
