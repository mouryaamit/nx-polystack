import { DEFAULT_DROP_CONSOLE } from '../hardening/options';

import { typecheckTarget } from './quality';

export const POLYSTACK_BUILD_EXECUTOR = '@mouryaamit/nx-polystack:build';

/** release configuration → pipeline env + Angular build configuration */
export const RELEASE_CONFIGURATIONS: Record<string, { env: string; buildConfiguration: string }> = {
  dev: { env: 'DEV', buildConfiguration: 'development' },
  uat: { env: 'UAT', buildConfiguration: 'uat' },
  prod: { env: 'PROD', buildConfiguration: 'production' },
};

/** Release hardening (leak check, source-map guard, comment and console stripping) for UAT/PROD. */
export const RELEASE_HARDENING = {
  leakCheck: 'fail',
  sourceMaps: 'fail',
  stripComments: true,
  dropConsole: DEFAULT_DROP_CONSOLE,
} as const;

/** A release configuration with the hardening options for its env (UAT and PROD only). */
export function withReleaseHardening<T extends { env: string }>(config: T): T {
  const env = config.env.toUpperCase();
  if (env !== 'UAT' && env !== 'PROD') return config;
  return { ...config, ...RELEASE_HARDENING, dropConsole: [...RELEASE_HARDENING.dropConsole] };
}

const budgets = [
  { type: 'initial', maximumWarning: '2mb', maximumError: '5mb' },
  { type: 'anyComponentStyle', maximumWarning: '6kb', maximumError: '10kb' },
];

export type EnvLayout = 'default' | 'per-env';
export const ENV_LAYOUTS: readonly EnvLayout[] = ['default', 'per-env'];
/** The file a per-env app imports; each build configuration replaces it with the app's file. */
export const PER_ENV_ROOT_FILE = 'environments/environment.ts';

/** Options of the generated targets. */
export interface AngularTargetOptions {
  /** `per-env`: environment.{dev,uat,prod}.ts replacing the shared environments/environment.ts. */
  envLayout?: EnvLayout;
  /** Dev-server port. */
  port?: number;
}

function envReplacement(name: string, envFile: string, layout: EnvLayout) {
  return {
    replace: layout === 'per-env' ? PER_ENV_ROOT_FILE : `environments/${name}/environment.ts`,
    with: `environments/${name}/${envFile}`,
  };
}

function optimized(name: string, envFile: string, layout: EnvLayout): Record<string, unknown> {
  return {
    budgets: budgets.map((b) => ({ ...b })),
    fileReplacements: [envReplacement(name, envFile, layout)],
    outputHashing: 'all',
    // Inlined critical CSS loads the stylesheet with an onload handler, which a strict CSP blocks.
    optimization: { scripts: true, styles: { minify: true, inlineCritical: false }, fonts: true },
  };
}

export function angularBuildTarget(
  name: string,
  root = `apps/${name}`,
  layout: EnvLayout = 'default',
): Record<string, unknown> {
  return {
    executor: '@angular-devkit/build-angular:browser',
    outputs: ['{options.outputPath}'],
    options: {
      outputPath: `dist/${root}`,
      index: `${root}/src/index.html`,
      main: `${root}/src/main.ts`,
      polyfills: ['zone.js'],
      tsConfig: `${root}/tsconfig.app.json`,
      inlineStyleLanguage: 'scss',
      assets: [`${root}/src/.htaccess`],
      styles: [`${root}/src/styles.scss`],
      scripts: [],
    },
    configurations: {
      production: optimized(name, 'environment.prod.ts', layout),
      uat: optimized(name, 'environment.uat.ts', layout),
      development: {
        ...(layout === 'per-env'
          ? { fileReplacements: [envReplacement(name, 'environment.dev.ts', layout)] }
          : {}),
        buildOptimizer: false,
        optimization: false,
        vendorChunk: true,
        extractLicenses: false,
        sourceMap: true,
        namedChunks: true,
      },
    },
    defaultConfiguration: 'production',
  };
}

export function angularServeTarget(name: string, port?: number): Record<string, unknown> {
  return {
    executor: '@angular-devkit/build-angular:dev-server',
    ...(port !== undefined ? { options: { port } } : {}),
    configurations: {
      production: { browserTarget: `${name}:build:production` },
      uat: { browserTarget: `${name}:build:uat` },
      development: { browserTarget: `${name}:build:development` },
    },
    defaultConfiguration: 'development',
  };
}

export function angularReleaseTarget(name: string, root = `apps/${name}`): Record<string, unknown> {
  return {
    executor: POLYSTACK_BUILD_EXECUTOR,
    outputs: ['{options.outputPath}'],
    options: {
      type: 'angular',
      outputPath: `dist/${root}`,
      envProject: name,
      buildTarget: `${name}:build`,
    },
    configurations: Object.fromEntries(
      Object.entries(RELEASE_CONFIGURATIONS).map(([k, v]) => [k, withReleaseHardening({ ...v })]),
    ),
    defaultConfiguration: 'dev',
  };
}

export const CLEAN_EXECUTOR = '@mouryaamit/nx-polystack:clean';

/**
 * `clean` target: removes dist/<root> and coverage/<root> (and runs flutter clean for Flutter).
 * A project at the workspace root (`.`) uses dist/<name> and coverage/<name>.
 */
export function cleanTarget(
  root: string,
  opts: { flutter?: boolean; outputs?: string[]; name?: string } = {},
) {
  const key = root === '.' || root === '' ? opts.name ?? 'app' : root;
  const paths = [...new Set([...(opts.outputs ?? [`dist/${key}`]), `coverage/${key}`])];
  return {
    executor: CLEAN_EXECUTOR,
    options: { paths, ...(opts.flutter ? { flutter: true } : {}) },
  };
}

/** Targets of a generated Angular app; `root` defaults to apps/<name>. */
export function angularProjectTargets(
  name: string,
  root = `apps/${name}`,
  opts: AngularTargetOptions = {},
): Record<string, unknown> {
  return {
    build: angularBuildTarget(name, root, opts.envLayout ?? 'default'),
    serve: angularServeTarget(name, opts.port),
    release: angularReleaseTarget(name, root),
    clean: cleanTarget(root),
    typecheck: typecheckTarget(`${root}/tsconfig.app.json`),
    lint: {
      executor: '@nx/eslint:lint',
      outputs: ['{options.outputFile}'],
      options: { lintFilePatterns: [`${root}/src/**/*.ts`, `${root}/src/**/*.html`] },
    },
    'extract-i18n': {
      executor: '@angular-devkit/build-angular:extract-i18n',
      options: { browserTarget: `${name}:build` },
    },
  };
}

export const CAPACITOR_EXECUTOR = '@mouryaamit/nx-polystack:capacitor';

/** Ionic app: Angular targets with an ionic release, plus Capacitor sync/open/add (--platform=android|ios). */
export function ionicProjectTargets(
  name: string,
  root = `apps/${name}`,
  opts: AngularTargetOptions = {},
): Record<string, unknown> {
  const targets = angularProjectTargets(name, root, opts);
  const release = targets['release'] as { options: Record<string, unknown> };
  release.options['type'] = 'ionic';
  const build = targets['build'] as { options: { assets: unknown[] } };
  // ion-icon loads its SVGs from /svg at runtime.
  build.options.assets.push({
    glob: '**/*.svg',
    input: 'node_modules/ionicons/dist/ionicons/svg',
    output: './svg',
  });
  // The capacitor executor defaults to dist/apps/<name>; a nested app tells it where its build is.
  const webDir = `dist/${root}`;
  const extra = webDir === `dist/apps/${name}` ? {} : { webDir };
  for (const command of ['sync', 'open', 'add']) {
    targets[`cap-${command}`] = { executor: CAPACITOR_EXECUTOR, options: { command, ...extra } };
  }
  return targets;
}
