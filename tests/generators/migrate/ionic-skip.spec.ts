import { ANGULAR_SKIP } from '../../../src/generators/migrate/adapters/angular-cli';
import { shouldSkip } from '../../../src/generators/migrate/copy';
import { withIonicSkip } from '../../../src/generators/migrate/ionic/skip';

describe('ionic skip rules', () => {
  const rules = withIonicSkip(ANGULAR_SKIP);

  it.each([
    'android/.gradle',
    'android/build',
    'android/app/build',
    'android/capacitor-cordova-android-plugins',
    'android/app/release',
    'android/app/src/main/assets/public',
    'android/app/src/main/assets/capacitor.config.json',
    'android/app/src/main/assets/capacitor.plugins.json',
    'android/local.properties',
    'ios/App/Pods',
    'ios/App/App/public',
    'ios/DerivedData',
    'ios/App/build',
    'ios/App/output',
    'ios/capacitor-cordova-ios-plugins',
    'ios/App/App/capacitor.config.json',
    'ios/App/App/config.xml',
    'ios/xcuserdata',
    'ios/App/App.xcodeproj/xcuserdata',
    'www',
  ])('skips %s', (rel) => {
    expect(shouldSkip(rel, rules)).toBe(true);
  });

  it.each([
    'android/app/src/main/AndroidManifest.xml',
    'android/app/build.gradle',
    'ios/App/App/Info.plist',
    'ios/App/Podfile',
    'ios/App/App.xcodeproj/project.pbxproj',
    'android/app/src/main/assets/fonts',
    'android/capacitor.settings.gradle',
    'src/app/www',
  ])('keeps %s', (rel) => {
    expect(shouldSkip(rel, rules)).toBe(false);
  });

  it('keeps the base rules', () => {
    expect(shouldSkip('node_modules', rules)).toBe(true);
    expect(shouldSkip('package.json', rules)).toBe(true);
  });
});
