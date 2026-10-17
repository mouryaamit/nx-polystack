import type { AngularProject, AngularTarget } from './adapters/angular-cli';

/**
 * Angular 17+ sources in an Angular 15 workspace: the application builder (and the
 * `@angular/build` package) are converted to the Angular 15 `@angular-devkit/build-angular`
 * builders; server rendering is refused. Pure functions (no tree, no fs).
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const APPLICATION_BUILDERS = new Set([
  '@angular-devkit/build-angular:application',
  '@angular/build:application',
]);
export const ESBUILD_BROWSER = new Set([
  '@angular-devkit/build-angular:browser-esbuild',
  '@angular/build:browser-esbuild',
]);
/** Options only the Angular 17+ application builder understands. */
const APPLICATION_OPTIONS = ['browser', 'server', 'ssr'];
/** Build options (in the build target or a configuration) that mean server rendering. */
const SSR_OPTIONS = ['server', 'ssr', 'prerender', 'appShell'];
/** Targets that only exist for server rendering. */
const SSR_BUILDER = /:(server|ssr-dev-server|prerender|app-shell)$/;

const BROWSER = '@angular-devkit/build-angular:browser';

/** `@angular/build:<x>` (Angular 18+) → the Angular 15 `@angular-devkit/build-angular:<x>`. */
const RENAMED_BUILDERS: Record<string, string> = {
  '@angular/build:dev-server': '@angular-devkit/build-angular:dev-server',
  '@angular/build:extract-i18n': '@angular-devkit/build-angular:extract-i18n',
  '@angular/build:karma': '@angular-devkit/build-angular:karma',
  '@angular/build:ng-packagr': '@angular-devkit/build-angular:ng-packagr',
};

/** Options of the Angular 15 builders; anything else fails their schema validation. */
const BROWSER_OPTIONS = new Set([
  'assets',
  'main',
  'polyfills',
  'tsConfig',
  'inlineStyleLanguage',
  'stylePreprocessorOptions',
  'optimization',
  'fileReplacements',
  'outputPath',
  'resourcesOutputPath',
  'aot',
  'sourceMap',
  'vendorChunk',
  'commonChunk',
  'baseHref',
  'deployUrl',
  'verbose',
  'progress',
  'i18nMissingTranslation',
  'i18nDuplicateTranslation',
  'localize',
  'watch',
  'outputHashing',
  'poll',
  'deleteOutputPath',
  'preserveSymlinks',
  'extractLicenses',
  'buildOptimizer',
  'namedChunks',
  'subresourceIntegrity',
  'serviceWorker',
  'ngswConfigPath',
  'index',
  'statsJson',
  'budgets',
  'webWorkerTsConfig',
  'crossOrigin',
  'allowedCommonJsDependencies',
  'scripts',
  'styles',
]);
const DEV_SERVER_OPTIONS = new Set([
  'browserTarget',
  'port',
  'host',
  'proxyConfig',
  'ssl',
  'sslKey',
  'sslCert',
  'headers',
  'open',
  'verbose',
  'liveReload',
  'publicHost',
  'allowedHosts',
  'servePath',
  'disableHostCheck',
  'hmr',
  'watch',
  'poll',
]);
const EXTRACT_I18N_OPTIONS = new Set([
  'browserTarget',
  'format',
  'progress',
  'outputPath',
  'outFile',
]);
const KARMA_OPTIONS = new Set([
  'main',
  'tsConfig',
  'karmaConfig',
  'polyfills',
  'assets',
  'scripts',
  'styles',
  'inlineStyleLanguage',
  'stylePreprocessorOptions',
  'include',
  'exclude',
  'sourceMap',
  'progress',
  'watch',
  'poll',
  'preserveSymlinks',
  'browsers',
  'codeCoverage',
  'codeCoverageExclude',
  'fileReplacements',
  'reporters',
  'webWorkerTsConfig',
]);

const ALLOWED: Record<string, Set<string>> = {
  [BROWSER]: BROWSER_OPTIONS,
  '@angular-devkit/build-angular:dev-server': DEV_SERVER_OPTIONS,
  '@angular-devkit/build-angular:extract-i18n': EXTRACT_I18N_OPTIONS,
  '@angular-devkit/build-angular:karma': KARMA_OPTIONS,
};

const builderOf = (t: AngularTarget | undefined): string | undefined => {
  const b = t?.builder ?? t?.executor;
  return typeof b === 'string' ? b : undefined;
};

const targetsOf = (project: AngularProject): Record<string, AngularTarget> =>
  (project.architect ?? project.targets ?? {}) as Record<string, AngularTarget>;

const optionSets = (t: AngularTarget): Json[] =>
  [t.options ?? {}, ...Object.values(t.configurations ?? {})].filter(isObject);

export interface ApplicationBuilderTarget {
  target: string;
  builder: string;
}

/**
 * Targets that use the Angular 17+ application builder: `:application`, or `:browser-esbuild`
 * given application-builder options (browser, server, ssr) in its options or configurations.
 */
export function applicationBuilderTargets(project: AngularProject): ApplicationBuilderTarget[] {
  const found: ApplicationBuilderTarget[] = [];
  for (const [target, t] of Object.entries(targetsOf(project))) {
    const builder = builderOf(t);
    if (builder === undefined) continue;
    const usesApplicationOptions = optionSets(t).some((o) =>
      APPLICATION_OPTIONS.some((k) => o[k] !== undefined),
    );
    if (
      APPLICATION_BUILDERS.has(builder) ||
      (ESBUILD_BROWSER.has(builder) && usesApplicationOptions)
    ) {
      found.push({ target, builder });
    }
  }
  return found;
}

/**
 * Why an application-builder project is a server-rendered app (undefined when it is not): its
 * build sets server, ssr, prerender or appShell (in the options or a configuration, unless set
 * to false), or it has a server, ssr-dev-server, prerender or app-shell target. Projects without
 * an application-builder target (Angular 15 Universal apps among them) are not checked: they keep
 * their builders.
 */
export function serverRendering(project: AngularProject): string | undefined {
  const targets = targetsOf(project);
  const application = applicationBuilderTargets(project);
  if (application.length === 0) return undefined;
  for (const { target } of application) {
    for (const o of optionSets(targets[target])) {
      const key = SSR_OPTIONS.find((k) => o[k] !== undefined && o[k] !== false);
      if (key) return `target "${target}" sets "${key}"`;
    }
  }
  for (const [target, t] of Object.entries(targets)) {
    const builder = builderOf(t);
    if (builder && SSR_BUILDER.test(builder)) return `target "${target}" uses ${builder}`;
  }
  return undefined;
}

/** The refusal for a server-rendered app, or undefined. */
export function serverRenderingError(project: AngularProject): string | undefined {
  const why = serverRendering(project);
  return why === undefined
    ? undefined
    : `migrate: the app renders on the server (${why}). Angular SSR apps are not supported: ` +
        'remove server rendering from the source (or migrate a copy without it) and run ' +
        'migrate again.';
}

export interface Angular17Conversion {
  project: AngularProject;
  /** What changed or was dropped, for the report. */
  notes: string[];
}

/**
 * The project with Angular 17+ builders converted for an Angular 15 workspace (a copy; the
 * input is unchanged). Paths are not mapped here: angularProjectJson maps them afterwards.
 * Call serverRenderingError first; server options left in a build are dropped with a note.
 */
export function convertAngular17Project(
  project: AngularProject,
  projectName: string,
): Angular17Conversion {
  const notes: string[] = [];
  const note = (n: string) => {
    if (!notes.includes(n)) notes.push(n);
  };
  const key = project.architect ? 'architect' : project.targets ? 'targets' : undefined;
  if (!key) return { project, notes };
  const application = new Set(applicationBuilderTargets(project).map((a) => a.target));
  const angular17 =
    application.size > 0 ||
    Object.values(targetsOf(project)).some((t) => builderOf(t)?.startsWith('@angular/build:'));
  const buildTargetName = application.has('build') ? 'build' : [...application][0] ?? 'build';
  const buildConfigs = Object.keys(targetsOf(project)[buildTargetName]?.configurations ?? {});
  const sourceRoot =
    project.sourceRoot ?? (project.root ? `${String(project.root).replace(/\/$/, '')}/src` : 'src');
  const projectRoot = project.root ? String(project.root).replace(/\/$/, '') : '';
  const at = (f: string) => (projectRoot ? `${projectRoot}/${f}` : f);

  const targets: Record<string, AngularTarget> = {};
  for (const [name, t] of Object.entries(targetsOf(project))) {
    const builder = builderOf(t);
    const field = t.builder !== undefined ? 'builder' : 'executor';
    if (builder !== undefined && application.has(name)) {
      note(
        `target "${name}": ${builder} became ${BROWSER} (the workspace builds with Angular 15). ` +
          'The output is written to `outputPath` itself, not to a `browser/` folder inside it.',
      );
      targets[name] = convertTarget(t, field, BROWSER, (o, config) =>
        browserOptions(o, config, { sourceRoot, at, target: name, projectName }, note),
      );
      continue;
    }
    const renamed = builder !== undefined ? RENAMED_BUILDERS[builder] : undefined;
    if (builder?.startsWith('@angular/build:') && renamed === undefined) {
      note(
        `target "${name}": ${builder} does not exist in Angular 15; the target was kept but ` +
          'cannot run. Replace it (a karma or jest test target, for instance).',
      );
      targets[name] = t;
      continue;
    }
    const newBuilder = renamed ?? builder ?? '';
    const allowed = ALLOWED[newBuilder];
    const usesBuildTarget = optionSets(t).some((o) => o['buildTarget'] !== undefined);
    // Angular 15 targets are kept; a buildTarget (Angular 16+), or any dev-server, extract-i18n or
    // karma target of an Angular 17+ project, is checked against the Angular 15 schema.
    if (
      renamed === undefined &&
      !(allowed && newBuilder !== BROWSER && (usesBuildTarget || angular17))
    ) {
      targets[name] = t;
      continue;
    }
    if (renamed) note(`target "${name}": ${builder} became ${renamed}.`);
    const converted = convertTarget(t, field, newBuilder, (o, config) => {
      const where =
        config === undefined ? `target "${name}"` : `target "${name}" configuration "${config}"`;
      const out: Json = {};
      for (const [k, v] of Object.entries(o)) {
        if (k === 'buildTarget' && allowed?.has('browserTarget')) {
          out['browserTarget'] = v;
          note(`target "${name}": \`buildTarget\` became \`browserTarget\`.`);
        } else if (allowed && !allowed.has(k)) {
          note(`${where}: option \`${k}\` dropped (Angular 15 has no such option).`);
        } else if (k === 'assets' && Array.isArray(v)) {
          out[k] = withAssetOutput(v);
        } else if (NESTED[k]) {
          out[k] = nested(k, v, where, note, newBuilder.endsWith(':karma'));
        } else {
          out[k] = v;
        }
      }
      return out;
    });
    if (allowed?.has('browserTarget')) {
      // Angular 17+ defaults buildTarget; the Angular 15 builders need browserTarget.
      const configs = Object.values(converted.configurations ?? {});
      const inOptions =
        isObject(converted.options) && converted.options['browserTarget'] !== undefined;
      // Without a defaultConfiguration, a run with no configuration reads only the options.
      const inEveryConfig =
        converted.defaultConfiguration !== undefined &&
        configs.length > 0 &&
        configs.every((c) => isObject(c) && c['browserTarget'] !== undefined);
      if (!inOptions && !inEveryConfig) {
        const dev =
          newBuilder.endsWith(':dev-server') && buildConfigs.includes('development')
            ? ':development'
            : '';
        const ref = `${projectName}:${buildTargetName}${dev}`;
        converted.options = { ...(converted.options ?? {}), browserTarget: ref };
        note(
          `target "${name}": \`browserTarget\` added, pointing at the ${buildTargetName} target` +
            `${dev ? ' (development configuration)' : ''} (Angular 15 needs it).`,
        );
      }
    }
    targets[name] = converted;
  }
  if (angular17) for (const n of i18nNotes(project.i18n)) note(n);
  return { project: { ...project, [key]: targets }, notes };
}

/** Asset objects need `output` in Angular 15; the application builder defaults it to the root. */
const withAssetOutput = (assets: unknown[]): unknown[] =>
  assets.map((a) => (isObject(a) && a['output'] === undefined ? { ...a, output: '/' } : a));

/** Object options whose keys Angular 15 restricts (its schemas reject other keys). */
const NESTED: Record<string, Record<string, string[] | true>> = {
  stylePreprocessorOptions: { includePaths: true },
  optimization: { scripts: true, styles: ['minify', 'inlineCritical'], fonts: ['inline'] },
  sourceMap: { scripts: true, styles: true, hidden: true, vendor: true },
};

function nested(
  key: string,
  value: unknown,
  where: string,
  note: (n: string) => void,
  karma = false,
): unknown {
  if (!isObject(value)) return value;
  // Angular 15 karma source maps have no `hidden`.
  const shape =
    karma && key === 'sourceMap' ? { scripts: true, styles: true, vendor: true } : NESTED[key];
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    const sub = shape[k];
    if (sub === undefined) {
      note(`${where}: \`${key}.${k}\` dropped (Angular 15 has no such option).`);
    } else if (Array.isArray(sub) && isObject(v)) {
      const kept: Json = {};
      for (const [sk, sv] of Object.entries(v)) {
        if (sub.includes(sk)) kept[sk] = sv;
        else note(`${where}: \`${key}.${k}.${sk}\` dropped (Angular 15 has no such option).`);
      }
      out[k] = kept;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Angular 17.2+ i18n `subPath`: Angular 15 ignores it, so localized output folders change. */
function i18nNotes(i18n: unknown): string[] {
  if (!isObject(i18n)) return [];
  const withSubPath: string[] = [];
  if (isObject(i18n['sourceLocale']) && i18n['sourceLocale']['subPath'] !== undefined) {
    withSubPath.push('sourceLocale');
  }
  const locales = i18n['locales'];
  if (isObject(locales)) {
    for (const [l, v] of Object.entries(locales)) {
      if (isObject(v) && v['subPath'] !== undefined) withSubPath.push(l);
    }
  }
  return withSubPath.length === 0
    ? []
    : [
        `i18n \`subPath\` (${withSubPath.join(', ')}) is Angular 17.2+: Angular 15 writes each ` +
          'locale to a folder named after the locale.',
      ];
}

function convertTarget(
  t: AngularTarget,
  field: 'builder' | 'executor',
  builder: string,
  fix: (o: Json, config: string | undefined) => Json,
): AngularTarget {
  const out: AngularTarget = { ...t, [field]: builder };
  if (isObject(t.options)) out.options = fix(t.options, undefined);
  if (isObject(t.configurations)) {
    out.configurations = Object.fromEntries(
      Object.entries(t.configurations).map(([c, o]) => [c, isObject(o) ? fix(o, c) : o]),
    );
  }
  return out;
}

interface BrowserContext {
  sourceRoot: string;
  at: (f: string) => string;
  target: string;
  projectName: string;
}

/** Application-builder options → browser-builder options (one options or configuration object). */
function browserOptions(
  o: Json,
  config: string | undefined,
  c: BrowserContext,
  note: (n: string) => void,
): Json {
  const where = config === undefined ? `target "${c.target}"` : `configuration "${config}"`;
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'browser') {
      if (o['main'] === undefined) out['main'] = v;
    } else if (k === 'outputPath' && isObject(v)) {
      if (typeof v['base'] === 'string') out['outputPath'] = v['base'];
      // `browser: ""` (files at the base, as the browser builder writes them) needs no note.
      if ((v['browser'] !== undefined && v['browser'] !== '') || v['media'] !== undefined) {
        note(`${where}: \`outputPath\` sub-folders (browser, media) dropped; only \`base\` kept.`);
      }
    } else if (k === 'index' && isObject(v)) {
      // Angular 15 takes { input, output } too; other keys (preloadInitial) are dropped.
      if (typeof v['input'] === 'string') {
        out['index'] =
          v['output'] === undefined ? v['input'] : { input: v['input'], output: v['output'] };
      }
      const extra = Object.keys(v).filter((x) => x !== 'input' && x !== 'output');
      if (extra.length > 0) {
        note(`${where}: \`index\` ${extra.map((x) => `\`${x}\``).join(', ')} dropped.`);
      }
    } else if (k === 'index' && v === false) {
      note(`${where}: \`index: false\` dropped (the browser builder needs an index.html).`);
    } else if (k === 'serviceWorker' && typeof v === 'string') {
      out['serviceWorker'] = true;
      out['ngswConfigPath'] = v;
    } else if (k === 'assets' && Array.isArray(v)) {
      // The browser builder needs `output` on every asset object; the application builder
      // defaults it to the output root.
      out['assets'] = withAssetOutput(v);
    } else if (k === 'polyfills' && typeof v === 'string') {
      out['polyfills'] = [v];
    } else if (NESTED[k]) {
      out[k] = nested(k, v, where, note);
    } else if (BROWSER_OPTIONS.has(k)) {
      out[k] = v;
    } else {
      note(
        `${where}: option \`${k}\` dropped (the Angular 15 browser builder has no such option).`,
      );
    }
  }
  if (config === undefined) {
    // Required by the browser builder; the application builder has defaults for them.
    if (out['main'] === undefined) out['main'] = `${c.sourceRoot}/main.ts`;
    if (out['index'] === undefined) out['index'] = `${c.sourceRoot}/index.html`;
    if (out['outputPath'] === undefined) out['outputPath'] = `dist/${c.projectName}`;
    if (out['tsConfig'] === undefined) out['tsConfig'] = c.at('tsconfig.app.json');
    // The application builder always compiles ahead of time.
    if (out['aot'] === undefined) out['aot'] = true;
  } else if (out['optimization'] === false && out['buildOptimizer'] === undefined) {
    // A development configuration: the browser builder's build optimizer defaults to on.
    out['buildOptimizer'] = false;
    if (out['vendorChunk'] === undefined) out['vendorChunk'] = true;
    if (out['namedChunks'] === undefined) out['namedChunks'] = true;
  }
  return out;
}

/** compilerOptions that need TypeScript 5 (Angular 15 builds with TypeScript 4.8/4.9). */
const TS5_REPLACED: Record<string, Record<string, string>> = {
  moduleResolution: { bundler: 'node' },
  module: { preserve: 'es2022' },
  target: { es2023: 'es2022', es2024: 'es2022' },
};
/** lib entries TypeScript 4.9 does not have: ES2023+ (es2023 → es2022; es2023.array … dropped). */
const NEWER_LIB = /^es202[3-9]/i;
const TS5_ONLY = [
  'verbatimModuleSyntax',
  'allowImportingTsExtensions',
  'customConditions',
  'resolvePackageJsonExports',
  'resolvePackageJsonImports',
  'isolatedDeclarations',
  'erasableSyntaxOnly',
  'noUncheckedSideEffectImports',
  'rewriteRelativeImportExtensions',
  'libReplacement',
];

/** A tsconfig with TypeScript 5-only compilerOptions changed or removed (a copy), and what changed. */
export function typeScript4Config(config: Json, file: string): { config: Json; notes: string[] } {
  const co = config['compilerOptions'];
  if (!isObject(co)) return { config, notes: [] };
  const notes: string[] = [];
  const out: Json = {};
  for (const [k, v] of Object.entries(co)) {
    const replaced = typeof v === 'string' ? TS5_REPLACED[k]?.[v.toLowerCase()] : undefined;
    if (replaced) {
      out[k] = replaced;
      notes.push(`${file}: \`${k}: "${v}"\` became \`"${replaced}"\` (TypeScript 4.9).`);
    } else if (
      k === 'lib' &&
      Array.isArray(v) &&
      v.some((l) => typeof l === 'string' && NEWER_LIB.test(l))
    ) {
      const lib: unknown[] = [];
      for (const l of v) {
        const fixed =
          typeof l === 'string' && NEWER_LIB.test(l) ? (l.includes('.') ? undefined : 'es2022') : l;
        if (
          fixed !== undefined &&
          !lib.some((x) => String(x).toLowerCase() === String(fixed).toLowerCase())
        )
          lib.push(fixed);
      }
      out[k] = lib;
      notes.push(`${file}: \`lib\` ES2023+ entries replaced (TypeScript 4.9 has up to ES2022).`);
    } else if (TS5_ONLY.includes(k)) {
      notes.push(`${file}: \`${k}\` removed (TypeScript 5 only).`);
    } else {
      out[k] = v;
    }
  }
  // TypeScript 4.9 would resolve modules the Classic way without it once `preserve` is gone.
  if (out['module'] === 'es2022' && String(co['module']).toLowerCase() === 'preserve') {
    if (out['moduleResolution'] === undefined) out['moduleResolution'] = 'node';
  }
  return notes.length === 0
    ? { config, notes }
    : { config: { ...config, compilerOptions: out }, notes };
}
