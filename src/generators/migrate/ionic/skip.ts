import type { SkipRules } from '../copy';

/** Native build output and machine-local files under android/ and ios/ (paths relative to the app). */
const NATIVE_OUTPUT: readonly RegExp[] = [
  // Gradle and Android Studio output, signed bundles, generated Cordova plugin project
  /^android\/(\.gradle|\.idea|build|app\/build|app\/release|capacitor-cordova-android-plugins)$/,
  // Web assets and config that `cap sync` copies in
  /^android\/app\/src\/main\/assets\/(public|capacitor\.config\.json|capacitor\.plugins\.json)$/,
  /^android\/local\.properties$/,
  // CocoaPods, Xcode output, generated Cordova plugin project, copied web assets and config
  /^ios\/(App\/Pods|App\/build|App\/output|DerivedData|capacitor-cordova-ios-plugins)$/,
  /^ios\/App\/App\/(public|capacitor\.config\.json|config\.xml)$/,
  /^ios\/(.*\/)?xcuserdata$/,
];

/** `rules` plus the native build output and Ionic's default web output (`www`). */
export function withIonicSkip(rules: SkipRules): SkipRules {
  return {
    ...rules,
    topLevel: [...rules.topLevel, 'www'],
    pathPatterns: [...(rules.pathPatterns ?? []), ...NATIVE_OUTPUT],
  };
}
