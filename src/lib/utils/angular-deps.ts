import { GeneratorCallback, logger, Tree } from '@nx/devkit';

import { addMissingDependencies, declaredVersion, majorOf, nxVersion } from './dependencies';

/** Angular line the generated app templates target (NgModule bootstrap, browser builder, browserTarget). */
export const ANGULAR_VERSION = '~15.2.0';
const ANGULAR_MAJOR = 15;

/** Full runtime set for a workspace that has no Angular yet. */
const RUNTIME_ALL = [
  '@angular/animations',
  '@angular/common',
  '@angular/compiler',
  '@angular/core',
  '@angular/forms',
  '@angular/platform-browser',
  '@angular/platform-browser-dynamic',
  '@angular/router',
];

/** Runtime packages the generated app code imports (filled in for an existing Angular 15 workspace). */
const RUNTIME_IMPORTED = [
  '@angular/common',
  '@angular/compiler',
  '@angular/platform-browser',
  '@angular/platform-browser-dynamic',
  '@angular/router',
];

const RUNTIME_SUPPORT: Record<string, string> = {
  rxjs: '~7.8.0',
  tslib: '^2.3.0',
  'zone.js': '~0.12.0',
};

function buildAndLintPackages(angular: string, nx: string): Record<string, string> {
  return {
    '@angular-devkit/build-angular': angular,
    '@angular/cli': angular,
    '@angular/compiler-cli': angular,
    '@nx/angular': nx,
    '@nx/eslint': nx,
    // angular-eslint 15.x works with any Angular 15.x
    '@angular-eslint/eslint-plugin': ANGULAR_VERSION,
    '@angular-eslint/eslint-plugin-template': ANGULAR_VERSION,
    '@angular-eslint/template-parser': ANGULAR_VERSION,
  };
}

/**
 * Dev packages Angular 15 needs at a TypeScript-4-compatible version. Without them npm can hoist a
 * TypeScript 5.x (refused by the Angular 15 compiler: "requires TypeScript >=4.8.2 and <5.0.0") or
 * a latest @types/node, whose `const` type parameters TypeScript 4.9 can't parse (TS1139).
 * Only added when missing; a declared version is never replaced.
 */
const TS4_DEV_PACKAGES: Record<string, string> = {
  typescript: '~4.9.5',
  '@types/node': '~18.16.9',
};

export interface EnsureAngularOptions {
  /** Also add the runtime packages the generated app imports (used by `pstack app`). */
  includeRuntime?: boolean;
}

/**
 * Makes sure an Angular 15 app can build and lint. Packages are only added, never upgraded:
 * - no @angular/core → the whole Angular 15 set (runtime, build, lint, TypeScript ~4.9.5,
 *   @types/node ~18.16.9);
 * - Angular 15 installed → missing build/lint packages at the installed Angular version
 *   (plus the imported runtime packages when `includeRuntime`);
 * - another Angular major → nothing; warns which build/lint packages are missing.
 */
export function ensureAngularDependencies(
  tree: Tree,
  opts: EnsureAngularOptions = {},
): GeneratorCallback | undefined {
  const nx = nxVersion(tree);
  const core = declaredVersion(tree, '@angular/core');

  if (core === undefined) {
    const deps: Record<string, string> = {
      ...Object.fromEntries(RUNTIME_ALL.map((d) => [d, ANGULAR_VERSION])),
      ...RUNTIME_SUPPORT,
    };
    const devDeps = { ...buildAndLintPackages(ANGULAR_VERSION, nx), ...TS4_DEV_PACKAGES };
    return addMissingDependencies(tree, deps, devDeps);
  }

  const devDeps = buildAndLintPackages(core, nx);
  if (majorOf(core) !== ANGULAR_MAJOR) {
    const missing = Object.keys(devDeps).filter(
      (name) => declaredVersion(tree, name) === undefined,
    );
    if (missing.length > 0) {
      logger.warn(
        `nx-polystack: workspace uses Angular ${majorOf(core) ?? core}; generated apps target ` +
          `Angular ${ANGULAR_MAJOR}. Not adding packages automatically — install versions matching ` +
          `your Angular for: ${missing.join(', ')}.`,
      );
    }
    return undefined;
  }

  const deps: Record<string, string> = opts.includeRuntime
    ? { ...Object.fromEntries(RUNTIME_IMPORTED.map((d) => [d, core])), ...RUNTIME_SUPPORT }
    : {};
  return addMissingDependencies(tree, deps, { ...devDeps, ...TS4_DEV_PACKAGES });
}

/**
 * Packages the @nx/angular:package and ng-packagr-lite executors load at build time. Nx's own
 * library generator adds these (versions from @nx/angular 17's utils/versions); without
 * postcss-preset-env the build fails with "Cannot find module".
 */
export function ngPackagrDependencies(angularCore: string | undefined): Record<string, string> {
  const major = angularCore ? majorOf(angularCore) : undefined;
  return {
    // ng-packagr releases don't follow Angular patch numbers, so pin the major only.
    'ng-packagr': `^${major ?? ANGULAR_MAJOR}.0.0`,
    postcss: '^8.4.5',
    'postcss-preset-env': '~7.5.0',
    'postcss-url': '~10.1.3',
    autoprefixer: '^10.4.0',
  };
}
