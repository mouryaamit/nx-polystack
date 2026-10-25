import { GeneratorCallback, logger, Tree } from '@nx/devkit';

import { ANGULAR_PINS, pinRange } from '../upgrade/pins';

import { addMissingDependencies, declaredVersion, majorOf, nxVersion } from './dependencies';

/** Angular line a workspace without Angular gets by default (NgModule bootstrap, browser builder). */
export const ANGULAR_VERSION = '~15.2.0';
export const ANGULAR_MAJOR = 15;

/**
 * Angular majors the generators write for: `pstack new --angular=<major>`, and `pstack app` / `:lib`
 * fill in packages for a workspace on one of them. One major is added per public release.
 */
export const GENERATOR_ANGULAR_MAJORS: readonly number[] = [15, 16, 17, 18, 19, 20];

/**
 * From this major, generated apps provide HttpClient with `provideHttpClient(withInterceptorsFromDi())`
 * (Angular 18 deprecates HttpClientModule; its own migration writes the same providers).
 */
export const PROVIDE_HTTP_CLIENT_MAJOR = 18;

/**
 * From this major, components, directives and pipes are standalone unless they say otherwise, so
 * generated NgModule declarations get `standalone: false` (what Angular 19's own migration writes),
 * and their ESLint configs turn off angular-eslint 19's `prefer-standalone` (as Nx 20.2's migration does).
 */
export const STANDALONE_FALSE_MAJOR = 19;

/**
 * From this major, angular-eslint's recommended config makes `prefer-inject` an error. The generated
 * code injects with `inject()` on every major; `pstack migrate` into such a workspace turns the rule
 * off when the copied code still uses constructor parameter injection.
 */
export const PREFER_INJECT_MAJOR = 20;

/** Versions the generators add for one Angular major (only where a package is missing). */
export interface AngularGeneratorVersions {
  angular: string;
  zoneJs: string;
  typescript: string;
  typesNode: string;
  angularEslint: string;
  ionicAngular: string;
  capacitor: string;
}

const ZONE_JS: Record<number, string> = {
  15: '~0.12.0',
  16: '~0.13.0',
  17: '~0.14.0',
  18: '~0.14.0',
  19: '~0.15.0',
  20: '~0.15.0',
};
/** @types/node the major's TypeScript can parse (a latest one uses newer syntax: TS1139). */
const TYPES_NODE: Record<number, string> = {
  15: '~18.16.9',
  16: '~20.10.0',
  17: '~20.10.0',
  18: '~20.10.0',
  19: '~20.10.0',
  20: '~20.10.0',
};

export function angularGeneratorVersions(major: number): AngularGeneratorVersions {
  if (major === 15) {
    // Kept as released: angular-eslint 15.x works with any Angular 15.x.
    return {
      angular: ANGULAR_VERSION,
      zoneJs: ZONE_JS[15],
      typescript: '~4.9.5',
      typesNode: TYPES_NODE[15],
      angularEslint: ANGULAR_VERSION,
      ionicAngular: '~7.8.0',
      capacitor: '~5.7.0',
    };
  }
  const pins = ANGULAR_PINS[major];
  if (!pins || !GENERATOR_ANGULAR_MAJORS.includes(major)) {
    throw new Error(
      `Angular ${major} is not supported by the generators (${GENERATOR_ANGULAR_MAJORS.join(
        ', ',
      )}).`,
    );
  }
  return {
    angular: `~${pins.angular}`,
    zoneJs: ZONE_JS[major],
    typescript: `~${pins.typescript}`,
    typesNode: TYPES_NODE[major],
    angularEslint: pinRange(pins.angularEslint),
    ionicAngular: pinRange(pins.ionic),
    capacitor: `^${pins.capacitor}.0.0`,
  };
}

/**
 * The generator versions for the workspace's Angular (the declared @angular/core), or for Angular
 * 15 when there is none or the major is not one the generators support.
 */
export function workspaceGeneratorVersions(tree: Tree): AngularGeneratorVersions {
  return angularGeneratorVersions(workspaceGeneratorMajor(tree));
}

/** The workspace's Angular major when the generators support it, else 15 (the default). */
export function workspaceGeneratorMajor(tree: Tree): number {
  const major = majorOf(declaredVersion(tree, '@angular/core') ?? '');
  return major !== undefined && GENERATOR_ANGULAR_MAJORS.includes(major) ? major : ANGULAR_MAJOR;
}

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

/** Runtime packages the generated app code imports (filled in for an existing Angular workspace). */
const RUNTIME_IMPORTED = [
  '@angular/common',
  '@angular/compiler',
  '@angular/platform-browser',
  '@angular/platform-browser-dynamic',
  '@angular/router',
];

function runtimeSupport(v: AngularGeneratorVersions): Record<string, string> {
  return { rxjs: '~7.8.0', tslib: '^2.3.0', 'zone.js': v.zoneJs };
}

function buildAndLintPackages(
  angular: string,
  nx: string,
  v: AngularGeneratorVersions,
): Record<string, string> {
  return {
    '@angular-devkit/build-angular': angular,
    '@angular/cli': angular,
    '@angular/compiler-cli': angular,
    '@nx/angular': nx,
    '@nx/eslint': nx,
    '@angular-eslint/eslint-plugin': v.angularEslint,
    '@angular-eslint/eslint-plugin-template': v.angularEslint,
    '@angular-eslint/template-parser': v.angularEslint,
  };
}

/**
 * TypeScript and @types/node at the versions the major's compiler accepts. Without them npm can
 * hoist a newer TypeScript (Angular 15 refuses 5.x, Angular 16 refuses 5.2+) or a latest
 * @types/node whose syntax that TypeScript can't parse (TS1139).
 * Only added when missing; a declared version is never replaced.
 */
function typeScriptPackages(v: AngularGeneratorVersions): Record<string, string> {
  return { typescript: v.typescript, '@types/node': v.typesNode };
}

export interface EnsureAngularOptions {
  /** Also add the runtime packages the generated app imports (used by `pstack app`). */
  includeRuntime?: boolean;
  /** Angular major for a workspace without @angular/core (default 15; `pstack new --angular`). */
  major?: number;
}

/**
 * Makes sure a generated Angular app or library can build and lint. Packages are only added,
 * never upgraded:
 * - no @angular/core → the whole set for `major` (default 15): runtime, build, lint, TypeScript
 *   and @types/node;
 * - a generator major installed (15–20) → missing build/lint packages at the installed Angular
 *   version (plus the imported runtime packages when `includeRuntime`);
 * - another Angular major → nothing; warns which build/lint packages are missing.
 */
export function ensureAngularDependencies(
  tree: Tree,
  opts: EnsureAngularOptions = {},
): GeneratorCallback | undefined {
  const nx = nxVersion(tree);
  const core = declaredVersion(tree, '@angular/core');

  if (core === undefined) {
    const v = angularGeneratorVersions(opts.major ?? ANGULAR_MAJOR);
    const deps: Record<string, string> = {
      ...Object.fromEntries(RUNTIME_ALL.map((d) => [d, v.angular])),
      ...runtimeSupport(v),
    };
    const devDeps = { ...buildAndLintPackages(v.angular, nx, v), ...typeScriptPackages(v) };
    return addMissingDependencies(tree, deps, devDeps);
  }

  const major = majorOf(core);
  if (major === undefined || !GENERATOR_ANGULAR_MAJORS.includes(major)) {
    const devDeps = buildAndLintPackages(core, nx, angularGeneratorVersions(ANGULAR_MAJOR));
    const missing = Object.keys(devDeps).filter(
      (name) => declaredVersion(tree, name) === undefined,
    );
    if (missing.length > 0) {
      logger.warn(
        `nx-polystack: workspace uses Angular ${major ?? core}; the generators support Angular ` +
          `${GENERATOR_ANGULAR_MAJORS.join(', ')}. Not adding packages automatically — install ` +
          `versions matching your Angular for: ${missing.join(', ')}.`,
      );
    }
    return undefined;
  }

  const v = angularGeneratorVersions(major);
  const deps: Record<string, string> = opts.includeRuntime
    ? { ...Object.fromEntries(RUNTIME_IMPORTED.map((d) => [d, core])), ...runtimeSupport(v) }
    : {};
  return addMissingDependencies(tree, deps, {
    ...buildAndLintPackages(core, nx, v),
    ...typeScriptPackages(v),
  });
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
