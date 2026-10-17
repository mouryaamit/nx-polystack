import { LibTypeSpec } from '../lib-utils';
import { LibType } from '../schema.d';

import { angularLib } from './angular';
import { designTokensLib } from './design-tokens';
import { assetsLib } from './assets';
import { flutterLib } from './flutter';
import { ionicLib } from './ionic';
import { piiLib } from './pii';
import { sessionLib } from './session';
import { stateLib } from './state';
import { stylesLib } from './styles';
import { tsLib } from './ts';

/** Implemented lib types. */
export const LIB_TYPES: Partial<Record<LibType, LibTypeSpec>> = {
  ts: tsLib,
  angular: angularLib,
  ionic: ionicLib,
  flutter: flutterLib,
  assets: assetsLib,
  styles: stylesLib,
  state: stateLib,
  'design-tokens': designTokensLib,
  session: sessionLib,
  pii: piiLib,
};

/** Listed in the schema, implementation pending. */
export const PENDING_LIB_TYPES: readonly LibType[] = [];

/** Waiting for native app support. */
export const PLANNED_LIB_TYPES: readonly LibType[] = ['android-native', 'ios-native'];
