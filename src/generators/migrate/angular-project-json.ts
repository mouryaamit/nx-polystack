import * as path from 'path';

import { flattenApplicationOutput } from '../../lib/release/flat-output';
import { angularReleaseTarget, withReleaseHardening } from '../../lib/utils/angular-project';

import type { AngularProject, AngularTarget } from './adapters/angular-cli';
import { convertAngular17Project } from './angular17';
import { APPLICATION_BUILDER_MAJOR } from './dependencies';

export { applicationBuilderTargets } from './angular17';
export type { ApplicationBuilderTarget } from './angular17';

/**
 * angular.json project → Nx project.json, as a pure function (no tree, no fs).
 *
 * Paths in angular.json are relative to the Angular workspace root (the source repo root);
 * in project.json they are relative to the Nx workspace root. The project's files move from
 * the project `root` ("" for a standalone app) to apps/<name>.
 */

export interface PathMapper {
  /** Source project root ("" for `ng new`), POSIX, no trailing slash. */
  sourceRoot: string;
  /** apps/<name> */
  projectRoot: string;
  name: string;
  /**
   * Whether a path (relative to the source repo root) exists in the source. Used for options
   * that take either a file or a package name (polyfills, styles, scripts, assets).
   */
  exists: (sourceRelPath: string) => boolean;
  /** Collects paths that could not be mapped (left unchanged). */
  warnings: string[];
  /** Other copied projects: source name → new name (for "<project>:<target>" references). */
  renames?: ReadonlyMap<string, string>;
}

function normalize(p: string): string {
  const n = path.posix.normalize(p.replace(/\\/g, '/'));
  return n === '.' ? '' : n.replace(/^\.\//, '').replace(/\/$/, '');
}

function warn(m: PathMapper, message: string): void {
  if (!m.warnings.includes(message)) m.warnings.push(message);
}

/** A path relative to the source repo root → relative to the Nx workspace root. */
export function mapPath(p: string, m: PathMapper): string {
  const negated = p.startsWith('!');
  const raw = negated ? p.slice(1) : p;
  const mapped = mapPlain(raw, m);
  return negated ? `!${mapped}` : mapped;
}

function mapPlain(p: string, m: PathMapper): string {
  if (path.posix.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) return p;
  const n = normalize(p);
  if (n === 'node_modules' || n.startsWith('node_modules/')) return p;
  if (n.startsWith('../')) {
    warn(m, `"${p}" is outside the source repo; left unchanged`);
    return p;
  }
  if (m.sourceRoot === '') return n ? `${m.projectRoot}/${n}` : m.projectRoot;
  if (n === m.sourceRoot) return m.projectRoot;
  if (n.startsWith(`${m.sourceRoot}/`))
    return `${m.projectRoot}/${n.slice(m.sourceRoot.length + 1)}`;
  warn(m, `"${p}" is outside the project root "${m.sourceRoot}"; left unchanged`);
  return p;
}

/** A file path or a package specifier: mapped only when it exists in the source. */
function mapPathOrPackage(p: string, m: PathMapper): string {
  const n = normalize(p);
  if (n.startsWith('node_modules/')) return p;
  if (m.exists(n)) return mapPath(p, m);
  // A missing file under a source directory (e.g. "src/missing.scss") is still a path.
  const first = n.split('/')[0];
  if (n.includes('/') && !first.startsWith('@') && m.exists(first)) {
    warn(m, `"${p}" was not found in the source; mapped as a path anyway`);
    return mapPath(p, m);
  }
  return p;
}

/** dist/<x>[/rest] → dist/apps/<name>[/rest]; other paths are mapped like any path. */
export function mapOutputPath(p: string, m: PathMapper): string {
  const n = normalize(p);
  if (n === 'dist') return `dist/${m.projectRoot}`;
  const dist = /^dist\/[^/]+(\/.*)?$/.exec(n);
  if (dist) return `dist/${m.projectRoot}${dist[1] ?? ''}`;
  return mapPath(p, m);
}

/** "<old project>:<target>[:<config>]" → "<name>:…". Other projects' targets are left alone. */
export function renameTargetRef(value: string, oldProject: string, name: string): string {
  return value.startsWith(`${oldProject}:`) ? `${name}${value.slice(oldProject.length)}` : value;
}

/** Options that are always a path. */
const PATH_OPTIONS = [
  'main',
  'browser',
  'server',
  'protractorConfig',
  'configFile',
  'eslintConfig',
  'tsConfig',
  'karmaConfig',
  'proxyConfig',
  'ngswConfigPath',
  'webWorkerTsConfig',
];

/** Options whose array entries are a path or a package, as a string or an { input } object. */
const ENTRY_OPTIONS = ['assets', 'styles', 'scripts'];

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Rewrites the path and target options of one options/configuration object (a copy). */
export function mapOptions(options: Json, oldProject: string, m: PathMapper): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(options)) {
    out[key] = mapOption(key, value, oldProject, m);
  }
  return out;
}

function mapOption(key: string, value: unknown, oldProject: string, m: PathMapper): unknown {
  if (key === 'outputPath' && typeof value === 'string') return mapOutputPath(value, m);
  if (key === 'outputPath' && isObject(value) && typeof value['base'] === 'string') {
    // Application builder: { base, browser, server, media }; only base is a path.
    return { ...value, base: mapOutputPath(value['base'] as string, m) };
  }
  if (key === 'ssr' && isObject(value) && typeof value['entry'] === 'string') {
    return { ...value, entry: mapPath(value['entry'] as string, m) };
  }
  if (key === 'prerender' && isObject(value) && typeof value['routesFile'] === 'string') {
    return { ...value, routesFile: mapPath(value['routesFile'] as string, m) };
  }
  // Application builder: `serviceWorker` is the ngsw-config.json path (the browser builder's is a
  // boolean, with the path in ngswConfigPath).
  if (key === 'serviceWorker' && typeof value === 'string') return mapPath(value, m);
  if (PATH_OPTIONS.includes(key) && typeof value === 'string') return mapPath(value, m);
  if (key === 'index') {
    if (typeof value === 'string') return mapPath(value, m);
    if (isObject(value) && typeof value['input'] === 'string') {
      return { ...value, input: mapPath(value['input'] as string, m) };
    }
    return value;
  }
  if (key === 'polyfills') {
    if (typeof value === 'string') return mapPathOrPackage(value, m);
    if (Array.isArray(value)) {
      return value.map((v) => (typeof v === 'string' ? mapPathOrPackage(v, m) : v));
    }
    return value;
  }
  if (ENTRY_OPTIONS.includes(key) && Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') return mapPathOrPackage(entry, m);
      if (isObject(entry) && typeof entry['input'] === 'string') {
        return { ...entry, input: mapPathOrPackage(entry['input'] as string, m) };
      }
      return entry;
    });
  }
  if (key === 'fileReplacements' && Array.isArray(value)) {
    return value.map((r) => {
      if (!isObject(r)) return r;
      const out: Json = { ...r };
      for (const k of ['replace', 'with', 'src', 'replaceWith']) {
        if (typeof out[k] === 'string') out[k] = mapPath(out[k] as string, m);
      }
      return out;
    });
  }
  if (key === 'stylePreprocessorOptions' && isObject(value)) {
    const includePaths = value['includePaths'];
    return Array.isArray(includePaths)
      ? {
          ...value,
          includePaths: includePaths.map((p) => (typeof p === 'string' ? mapPath(p, m) : p)),
        }
      : value;
  }
  if ((key === 'lintFilePatterns' || key === 'codeCoverageExclude') && Array.isArray(value)) {
    return value.map((p) => (typeof p === 'string' ? mapPath(p, m) : p));
  }
  if (/Target$/.test(key) && typeof value === 'string') {
    const own = renameTargetRef(value, oldProject, m.name);
    if (own !== value || !m.renames) return own;
    const project = value.split(':')[0];
    const renamed = m.renames.get(project);
    return renamed ? `${renamed}${value.slice(project.length)}` : value;
  }
  return value;
}

/** Release configuration name for an Angular build configuration. */
export function releaseConfigName(buildConfiguration: string): string {
  if (buildConfiguration === 'production') return 'prod';
  if (buildConfiguration === 'development') return 'dev';
  return buildConfiguration;
}

/** release target configurations derived from the build configurations, in build order. */
export function releaseConfigurations(
  buildConfigurations: string[],
): Record<string, { env: string; buildConfiguration: string }> {
  return Object.fromEntries(
    buildConfigurations.map((c) => {
      const release = releaseConfigName(c);
      return [release, withReleaseHardening({ env: release.toUpperCase(), buildConfiguration: c })];
    }),
  );
}

/**
 * Adds the polystack `release` target (configurations from the build configurations) to
 * project.json targets, in place. Returns the release configuration names; [] with a warning
 * when there is already a release target, no build target or no build configurations.
 */
export function addReleaseTarget(
  targets: Json,
  name: string,
  warnFn: (message: string) => void,
  projectRoot = `apps/${name}`,
): string[] {
  const build = targets['build'] as Json | undefined;
  const configurations = build?.['configurations'];
  const buildConfigs = isObject(configurations) ? Object.keys(configurations) : [];
  if (targets['release'] !== undefined) {
    warnFn('the source already has a "release" target; the polystack release target was not added');
    return [];
  }
  if (!build) {
    warnFn('no "build" target; the polystack release target was not added');
    return [];
  }
  if (buildConfigs.length === 0) {
    warnFn('the build target has no configurations; the polystack release target was not added');
    return [];
  }
  const release = angularReleaseTarget(name) as Json & { options: Json };
  const outputPath = (build['options'] as Json | undefined)?.['outputPath'];
  // The application builder may give { base, browser }; the release reads index.html from the
  // base or its browser/ folder.
  const base = isObject(outputPath) ? outputPath['base'] : outputPath;
  release.options['outputPath'] = typeof base === 'string' ? base : `dist/${projectRoot}`;
  const configs = releaseConfigurations(buildConfigs);
  const names = Object.keys(configs);
  release['configurations'] = configs;
  release['defaultConfiguration'] = names.includes('dev') ? 'dev' : names[0];
  targets['release'] = release;
  // The application builder would put the app in <base>/browser/; release builds are flat.
  if (flattenApplicationOutput(build, release.options['outputPath'] as string) === 'set') {
    warnFn('`build` outputPath.browser set to "" (no `browser/` folder in the output)');
  }
  return names;
}

/** Root npm scripts for a migrated Angular app (same style as `pstack app`). */
export function angularAppNpmScripts(
  name: string,
  hasServe: boolean,
  releaseNames: string[],
): Record<string, string> {
  const scripts: Record<string, string> = {};
  if (hasServe) scripts[`serve:${name}`] = `nx serve ${name}`;
  for (const env of releaseNames) scripts[`build:${name}:${env}`] = `nx run ${name}:release:${env}`;
  if (releaseNames.includes('prod')) {
    scripts[`build:${name}:prod:secure`] = `nx run ${name}:release:prod --secure`;
    scripts[`build:${name}:prod:secure:sri`] = `nx run ${name}:release:prod --secure --sri`;
  }
  return scripts;
}

const BUILDERS_WITH_OUTPUT_PATH =
  /^(@angular-devkit\/build-angular:(browser|browser-esbuild|application|server|ng-packagr)|@angular\/build:application)$/;

function convertTarget(target: AngularTarget, oldProject: string, m: PathMapper): Json {
  const { builder, executor, options, configurations, defaultConfiguration, ...rest } = target;
  const out: Json = { executor: builder ?? executor };
  // ng-packagr: `project` is the ng-package.json path.
  const ngPackagr = /:ng-packagr$/.test(String(out['executor'] ?? ''));
  const withProject = (o: Json): Json =>
    ngPackagr && typeof o['project'] === 'string'
      ? { ...o, project: mapPath(o['project'] as string, m) }
      : o;
  const mappedOptions = options ? withProject(mapOptions(options, oldProject, m)) : undefined;
  if (
    rest['outputs'] === undefined &&
    typeof out['executor'] === 'string' &&
    BUILDERS_WITH_OUTPUT_PATH.test(out['executor'] as string) &&
    mappedOptions?.['outputPath'] !== undefined
  ) {
    out['outputs'] = [
      isObject(mappedOptions['outputPath']) ? '{options.outputPath.base}' : '{options.outputPath}',
    ];
  }
  for (const [k, v] of Object.entries(rest)) out[k] = v;
  if (mappedOptions) out['options'] = mappedOptions;
  if (configurations) {
    out['configurations'] = Object.fromEntries(
      Object.entries(configurations).map(([c, o]) => [
        c,
        isObject(o) ? withProject(mapOptions(o, oldProject, m)) : o,
      ]),
    );
  }
  if (defaultConfiguration !== undefined) out['defaultConfiguration'] = defaultConfiguration;
  return out;
}

export interface ProjectJsonInput {
  /** The project's key in angular.json. */
  sourceProject: string;
  project: AngularProject;
  /** The new app/project name. */
  name: string;
  exists: (sourceRelPath: string) => boolean;
  /** Workspace folder (default apps/<name>). */
  projectRoot?: string;
  /** Other copied projects: source name → new name. */
  renames?: ReadonlyMap<string, string>;
  /**
   * Angular major the workspace builds with (default 15). Below 17 the application builder does
   * not exist, so Angular 17+ builders are converted to the browser builder; from 17 they are kept.
   */
  angularMajor?: number;
}

export interface ProjectJsonResult {
  projectJson: Json;
  /** Release configuration names (for npm scripts); empty when no release target was added. */
  releaseConfigurations: string[];
  /** Targets added by the migration. */
  addedTargets: string[];
  warnings: string[];
  /** Angular 17+ builders converted for Angular 15: what changed or was dropped. */
  angularNotes: string[];
}

export function angularProjectJson(input: ProjectJsonInput): ProjectJsonResult {
  const { sourceProject, name } = input;
  // Angular 17+ builders → the Angular 15 ones, only for workspaces without the application
  // builder (server-rendered apps are refused before this).
  const converted =
    (input.angularMajor ?? 15) < APPLICATION_BUILDER_MAJOR
      ? convertAngular17Project(input.project, sourceProject)
      : { project: input.project, notes: [] };
  const project = converted.project;
  const projectRoot = input.projectRoot ?? `apps/${name}`;
  const library = project.projectType === 'library';
  const m: PathMapper = {
    sourceRoot: normalize(project.root ?? ''),
    projectRoot,
    name,
    exists: input.exists,
    warnings: [],
    renames: input.renames,
  };

  const targets: Json = {};
  for (const [t, target] of Object.entries(project.architect ?? project.targets ?? {})) {
    targets[t] = convertTarget(target, sourceProject, m);
  }
  const sourceRoot = mapPath(
    project.sourceRoot ?? (m.sourceRoot ? `${m.sourceRoot}/src` : 'src'),
    m,
  );

  const addedTargets: string[] = [];
  const releaseNames = library
    ? []
    : addReleaseTarget(targets, name, (w) => warn(m, w), projectRoot);
  if (releaseNames.length > 0) addedTargets.push('release');

  if (targets['lint'] === undefined) {
    targets['lint'] = {
      executor: '@nx/eslint:lint',
      outputs: ['{options.outputFile}'],
      options: { lintFilePatterns: [`${sourceRoot}/**/*.ts`, `${sourceRoot}/**/*.html`] },
    };
    addedTargets.push('lint');
  }

  const projectJson: Json = {
    name,
    $schema: `${'../'.repeat(
      projectRoot.split('/').length,
    )}node_modules/nx/schemas/project-schema.json`,
    projectType: library ? 'library' : 'application',
  };
  if (project.prefix !== undefined) projectJson['prefix'] = project.prefix;
  projectJson['sourceRoot'] = sourceRoot;
  projectJson['tags'] = [];
  if (project.schematics !== undefined) projectJson['generators'] = project.schematics;
  if (isObject(project.i18n)) projectJson['i18n'] = mapI18n(project.i18n, m);
  projectJson['targets'] = targets;

  return {
    projectJson,
    releaseConfigurations: releaseNames,
    addedTargets,
    warnings: m.warnings,
    angularNotes: converted.notes,
  };
}

/** Project-level i18n: locale translation files are paths. */
function mapI18n(i18n: Json, m: PathMapper): Json {
  const locales = i18n['locales'];
  if (!isObject(locales)) return i18n;
  const mapped: Json = {};
  for (const [locale, value] of Object.entries(locales)) {
    const mapEntry = (v: unknown): unknown => (typeof v === 'string' ? mapPath(v, m) : v);
    if (typeof value === 'string' || Array.isArray(value)) {
      mapped[locale] = Array.isArray(value) ? value.map(mapEntry) : mapEntry(value);
    } else if (isObject(value)) {
      const t = value['translation'];
      mapped[locale] =
        t === undefined
          ? value
          : { ...value, translation: Array.isArray(t) ? t.map(mapEntry) : mapEntry(t) };
    } else {
      mapped[locale] = value;
    }
  }
  return { ...i18n, locales: mapped };
}
