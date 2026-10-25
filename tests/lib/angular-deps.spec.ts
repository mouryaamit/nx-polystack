import { logger, readJson, updateJson } from '@nx/devkit';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';

import {
  ANGULAR_VERSION,
  angularGeneratorVersions,
  ensureAngularDependencies,
} from '../../src/lib/utils/angular-deps';

describe('ensureAngularDependencies', () => {
  it('adds Angular 15 runtime and build packages when @angular/core is missing', () => {
    const tree = createTreeWithEmptyWorkspace();
    const cb = ensureAngularDependencies(tree);
    const pkg = readJson(tree, 'package.json');
    expect(ANGULAR_VERSION).toBe('~15.2.0');
    for (const dep of [
      '@angular/core',
      '@angular/common',
      '@angular/router',
      '@angular/platform-browser-dynamic',
    ]) {
      expect(pkg.dependencies[dep]).toBe('~15.2.0');
    }
    expect(pkg.dependencies['zone.js']).toBe('~0.12.0');
    expect(pkg.dependencies.rxjs).toBe('~7.8.0');
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~15.2.0');
    expect(pkg.devDependencies['@angular/compiler-cli']).toBe('~15.2.0');
    expect(pkg.devDependencies.typescript).toBe('~4.9.5');
    expect(pkg.devDependencies['@types/node']).toBe('~18.16.9');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~15.2.0');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin-template']).toBe('~15.2.0');
    expect(pkg.devDependencies['@angular-eslint/template-parser']).toBe('~15.2.0');
    expect(pkg.devDependencies['@nx/angular']).toBeDefined();
    expect(typeof cb).toBe('function');
  });

  it('fills in missing build and lint packages at the installed Angular version, without overwriting', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.dependencies = { '@angular/core': '~15.1.0', '@angular/common': '~15.1.0' };
      j.devDependencies = { nx: '17.0.6', typescript: '~4.8.4' };
      return j;
    });
    expect(typeof ensureAngularDependencies(tree)).toBe('function');
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('~15.1.0');
    expect(pkg.devDependencies.typescript).toBe('~4.8.4');
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~15.1.0');
    expect(pkg.devDependencies['@angular/compiler-cli']).toBe('~15.1.0');
    expect(pkg.devDependencies['@nx/angular']).toBe('17.0.6');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~15.2.0');
    // runtime packages are not added unless asked for
    expect(pkg.dependencies['@angular/router']).toBeUndefined();
    expect(pkg.dependencies['@angular/animations']).toBeUndefined();
  });

  it('adds TypeScript 4.9 when Angular 15 is there but TypeScript is not declared', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.dependencies = { '@angular/core': '~15.2.0' };
      delete j.devDependencies?.typescript;
      delete j.dependencies?.typescript;
      return j;
    });
    ensureAngularDependencies(tree);
    expect(readJson(tree, 'package.json').devDependencies.typescript).toBe('~4.9.5');
  });

  it('adds a TypeScript-4-compatible @types/node only when none is declared', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.dependencies = { '@angular/core': '~15.2.0' };
      delete j.devDependencies?.['@types/node'];
      return j;
    });
    ensureAngularDependencies(tree);
    expect(readJson(tree, 'package.json').devDependencies['@types/node']).toBe('~18.16.9');

    const declared = createTreeWithEmptyWorkspace();
    updateJson(declared, 'package.json', (j) => {
      j.dependencies = { '@angular/core': '~15.2.0' };
      j.devDependencies = { ...j.devDependencies, '@types/node': '18.7.1' };
      return j;
    });
    ensureAngularDependencies(declared);
    expect(readJson(declared, 'package.json').devDependencies['@types/node']).toBe('18.7.1');
  });

  it('with includeRuntime, adds the runtime packages generated code imports, at the installed version', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.dependencies = { '@angular/core': '~15.1.0' };
      return j;
    });
    ensureAngularDependencies(tree, { includeRuntime: true });
    const deps = readJson(tree, 'package.json').dependencies;
    expect(deps['@angular/router']).toBe('~15.1.0');
    expect(deps['@angular/platform-browser-dynamic']).toBe('~15.1.0');
    expect(deps['zone.js']).toBe('~0.12.0');
    expect(deps['@angular/animations']).toBeUndefined();
    expect(deps['@angular/forms']).toBeUndefined();
  });

  it.each(['dependencies', 'devDependencies'])(
    'adds nothing for another Angular major in %s and warns about what is missing',
    (field) => {
      const tree = createTreeWithEmptyWorkspace();
      updateJson(tree, 'package.json', (j) => {
        j[field] = { ...j[field], '@angular/core': '~21.2.0' };
        return j;
      });
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const before = readJson(tree, 'package.json');
      expect(ensureAngularDependencies(tree)).toBeUndefined();
      expect(readJson(tree, 'package.json')).toEqual(before);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /Angular 21; the generators support Angular 15, 16, 17, 18, 19, 20.*@angular-devkit\/build-angular/s,
        ),
      );
      warn.mockRestore();
    },
  );

  it('uses the installed nx version for @nx/eslint, else ^17.0.0', () => {
    const withNx = createTreeWithEmptyWorkspace();
    updateJson(withNx, 'package.json', (j) => {
      j.devDependencies = { ...j.devDependencies, nx: '17.3.2' };
      delete j.devDependencies['@nx/eslint'];
      return j;
    });
    ensureAngularDependencies(withNx);
    expect(readJson(withNx, 'package.json').devDependencies['@nx/eslint']).toBe('17.3.2');

    const withoutNx = createTreeWithEmptyWorkspace();
    updateJson(withoutNx, 'package.json', (j) => {
      delete j.devDependencies?.nx;
      delete j.dependencies?.nx;
      delete j.devDependencies?.['@nx/eslint'];
      return j;
    });
    ensureAngularDependencies(withoutNx);
    expect(readJson(withoutNx, 'package.json').devDependencies['@nx/eslint']).toBe('^17.0.0');
  });

  it('major 16: the whole Angular 16 set for a workspace without Angular (pstack new --angular=16)', () => {
    const tree = createTreeWithEmptyWorkspace();
    ensureAngularDependencies(tree, { major: 16 });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/core']).toBe('~16.2.12');
    expect(pkg.dependencies['@angular/router']).toBe('~16.2.12');
    expect(pkg.dependencies['zone.js']).toBe('~0.13.0');
    expect(pkg.devDependencies['@angular-devkit/build-angular']).toBe('~16.2.12');
    expect(pkg.devDependencies['@angular-eslint/eslint-plugin']).toBe('~16.3.1');
    expect(pkg.devDependencies.typescript).toBe('~5.1.6');
    expect(pkg.devDependencies['@types/node']).toBe('~20.10.0');
  });

  it('an Angular 16 workspace gets the missing build, lint and TypeScript 5.1 packages', () => {
    const tree = createTreeWithEmptyWorkspace();
    updateJson(tree, 'package.json', (j) => {
      j.dependencies = { '@angular/core': '~16.2.12' };
      j.devDependencies = { nx: '17.0.6' };
      return j;
    });
    ensureAngularDependencies(tree, { includeRuntime: true });
    const pkg = readJson(tree, 'package.json');
    expect(pkg.dependencies['@angular/router']).toBe('~16.2.12');
    expect(pkg.dependencies['zone.js']).toBe('~0.13.0');
    expect(pkg.devDependencies['@angular/compiler-cli']).toBe('~16.2.12');
    expect(pkg.devDependencies['@angular-eslint/template-parser']).toBe('~16.3.1');
    expect(pkg.devDependencies.typescript).toBe('~5.1.6');
  });

  it('versions per generator major; other majors are refused', () => {
    expect(angularGeneratorVersions(15)).toMatchObject({
      angular: '~15.2.0',
      ionicAngular: '~7.8.0',
      capacitor: '~5.7.0',
    });
    expect(angularGeneratorVersions(16)).toMatchObject({
      angular: '~16.2.12',
      ionicAngular: '~7.8.6',
      capacitor: '^6.0.0',
    });
    expect(angularGeneratorVersions(17)).toMatchObject({
      angular: '~17.3.12',
      zoneJs: '~0.14.0',
      typescript: '~5.4.5',
      angularEslint: '~17.3.0',
      ionicAngular: '~7.8.6',
      capacitor: '^6.0.0',
    });
    expect(angularGeneratorVersions(18)).toEqual({
      angular: '~18.2.14',
      zoneJs: '~0.14.0',
      typescript: '~5.5.4',
      typesNode: '~20.10.0',
      angularEslint: '~18.4.3',
      ionicAngular: '~8.7.11',
      capacitor: '^7.0.0',
    });
    expect(angularGeneratorVersions(19)).toEqual({
      angular: '~19.2.25',
      zoneJs: '~0.15.0',
      typescript: '~5.8.3',
      typesNode: '~20.10.0',
      angularEslint: '~19.8.1',
      ionicAngular: '~8.7.11',
      capacitor: '^7.0.0',
    });
    expect(angularGeneratorVersions(20)).toEqual({
      angular: '~20.3.32',
      zoneJs: '~0.15.0',
      typescript: '~5.9.3',
      typesNode: '~20.10.0',
      angularEslint: '~20.7.0',
      ionicAngular: '~8.7.11',
      capacitor: '^7.0.0',
    });
    expect(() => angularGeneratorVersions(21)).toThrow(
      /not supported by the generators \(15, 16, 17, 18, 19, 20\)/,
    );
  });
});
