import {
  cordovaPlugins,
  isNativePackage,
  nativeClassifier,
  packageOfSpecifier,
  splitNativePackages,
} from '../../../src/generators/migrate/ionic/packages';

import { putJson, tmpSource } from './helpers';

describe('ionic native packages', () => {
  it.each([
    ['@capacitor/core', true],
    ['@capacitor/cli', true],
    ['@capacitor-community/sqlite', true],
    ['@capacitor-firebase/authentication', true],
    ['@capawesome/capacitor-file-picker', true],
    ['@capawesome-team/capacitor-nfc', true],
    ['@revenuecat/purchases-capacitor', true],
    ['capacitor-secure-storage-plugin', true],
    ['cordova-plugin-device', true],
    ['cordova-sqlite-storage', true],
    ['@awesome-cordova-plugins/core', true],
    ['@ionic-native/core', true],
    ['@ionic/angular', false],
    ['@ionic/pwa-elements', false],
    ['@angular/core', false],
  ])('%s → %s', (name, native) => {
    expect(isNativePackage(name)).toBe(native);
  });

  it('also treats installed packages with a capacitor or cordova section as native', () => {
    const src = tmpSource();
    putJson(src, 'node_modules/@capgo/updater/package.json', { capacitor: { ios: {} } });
    putJson(src, 'node_modules/@x/legacy/package.json', { cordova: { id: 'x' } });
    putJson(src, 'node_modules/lodash/package.json', { name: 'lodash' });
    const isNative = nativeClassifier(src);
    expect(isNative('@capgo/updater')).toBe(true);
    expect(isNative('@x/legacy')).toBe(true);
    expect(isNative('lodash')).toBe(false);
    expect(isNative('not-installed')).toBe(false);
  });

  it('splits every dependency field, each package once (dependencies first)', () => {
    const { native, names } = splitNativePackages({
      dependencies: { '@angular/core': '~15.2.0', '@capacitor/core': '5.7.0' },
      devDependencies: {
        '@capacitor/cli': '5.7.0',
        '@capacitor/core': '5.6.0',
        typescript: '~4.9.4',
      },
      optionalDependencies: { 'cordova-plugin-file': '8.0.0' },
    });
    expect(native).toEqual({
      dependencies: { '@capacitor/core': '5.7.0' },
      devDependencies: { '@capacitor/cli': '5.7.0' },
      optionalDependencies: { 'cordova-plugin-file': '8.0.0' },
    });
    expect(names).toEqual(['@capacitor/cli', '@capacitor/core', 'cordova-plugin-file']);
  });

  it('narrows the split with keep', () => {
    const { names } = splitNativePackages(
      { dependencies: { '@capacitor/core': '5.7.0', '@capacitor/camera': '5.0.0' } },
      isNativePackage,
      (n) => n !== '@capacitor/camera',
    );
    expect(names).toEqual(['@capacitor/core']);
  });

  it('lists Cordova plugins once', () => {
    expect(
      cordovaPlugins({
        dependencies: { 'cordova-plugin-device': '2.1.0', '@capacitor/core': '5.7.0' },
        devDependencies: { 'cordova-plugin-file': '8.0.0', 'cordova-plugin-device': '2.1.0' },
      }),
    ).toEqual(['cordova-plugin-device', 'cordova-plugin-file']);
  });

  it('names the package of an import specifier', () => {
    expect(packageOfSpecifier('@capacitor/core')).toBe('@capacitor/core');
    expect(packageOfSpecifier('@awesome-cordova-plugins/camera/ngx')).toBe(
      '@awesome-cordova-plugins/camera',
    );
    expect(packageOfSpecifier('capacitor-plugin/dist/x')).toBe('capacitor-plugin');
  });
});
