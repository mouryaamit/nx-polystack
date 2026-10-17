import * as fs from 'fs';
import * as path from 'path';

import { Tree, updateJson } from '@nx/devkit';

import { noncePatchMains } from '../../../lib/utils/csp-nonce';
import { addNpmScripts } from '../../../lib/utils/npm-scripts';
import { setProjectTags } from '../../../lib/utils/nx-targets';
import { angularCodeNotes } from '../angular-code-scan';
import {
  appRootTsconfig,
  extendRootEslintConfig,
  fixProjectTsconfig,
  mergeTsPaths,
} from '../angular-config-files';
import { angularAppNpmScripts, angularProjectJson, PathMapper } from '../angular-project-json';
import { serverRenderingError, typeScript4Config } from '../angular17';
import { copyIntoTree, SkipRules } from '../copy';
import {
  angularMismatch,
  angularMismatchMessage,
  DependencySkip,
  mergeDependencies,
} from '../dependencies';
import { upTo } from '../names';
import { browserslistFile, classifyDependencySpec, SpecContext } from '../npm-deps';
import { catalogMissMessage, sourceRootPackage } from '../pnpm';
import {
  PackageJson,
  parseJsonStrict,
  readSourceJson,
  readSourceJsonStrict,
  readSourcePackageJson,
  sourceDependency,
  sourceExists,
} from '../source';

import {
  Detection,
  emptyReportData,
  MigrationAdapter,
  recordCopy,
  MigrationContext,
  MigrationReportData,
} from './types';

export interface AngularTarget {
  builder?: string;
  executor?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
  defaultConfiguration?: string;
  [key: string]: unknown;
}

export interface AngularProject {
  projectType?: string;
  root?: string;
  sourceRoot?: string;
  prefix?: string;
  schematics?: Record<string, unknown>;
  i18n?: Record<string, unknown>;
  architect?: Record<string, AngularTarget>;
  targets?: Record<string, AngularTarget>;
  [key: string]: unknown;
}

export interface AngularWorkspace {
  projects?: Record<string, AngularProject>;
  [key: string]: unknown;
}

export function readAngularWorkspace(sourceDir: string): AngularWorkspace | undefined {
  return readSourceJson<AngularWorkspace>(sourceDir, 'angular.json');
}

/** The angular.json projects with projectType "application", in file order. */
const E2E_BUILDER = /(protractor|cypress|playwright)/;

/** A project that only runs e2e tests (no build target; a protractor/cypress/playwright target). */
export function isE2eOnly(project: AngularProject | undefined): boolean {
  const targets = project?.architect ?? project?.targets ?? {};
  if (targets['build'] !== undefined) return false;
  return Object.values(targets).some((t) =>
    E2E_BUILDER.test(String(t?.builder ?? t?.executor ?? '')),
  );
}

/** e2e-only projects of angular.json: [name, root]. They are not migrated. */
export function e2eProjects(ws: AngularWorkspace | undefined): [string, string][] {
  return Object.entries(ws?.projects ?? {})
    .filter(([, p]) => isE2eOnly(p))
    .map(([n, p]) => [n, normalizeRoot(p.root)]);
}

/** Application projects, without e2e-only ones. */
export function applicationProjects(ws: AngularWorkspace | undefined): [string, AngularProject][] {
  return Object.entries(ws?.projects ?? {}).filter(
    ([, p]) => p?.projectType === 'application' && !isE2eOnly(p),
  );
}

/** Ionic and Capacitor signals; the ionic adapter handles these apps. */
export function ionicSignals(sourceDir: string): string[] {
  const found: string[] = [];
  const pkg = readSourcePackageJson(sourceDir);
  if (sourceDependency(pkg, '@ionic/angular')) found.push('@ionic/angular in package.json');
  for (const f of [
    'capacitor.config.ts',
    'capacitor.config.js',
    'capacitor.config.json',
    'ionic.config.json',
  ]) {
    if (sourceExists(sourceDir, f)) found.push(f);
  }
  return found;
}

const round = (n: number) => Math.round(n * 100) / 100;

export function detectAngularCli(sourceDir: string): Detection {
  if (sourceExists(sourceDir, 'nx.json')) {
    return {
      confidence: 0,
      reasons: ['nx.json: an Nx workspace, not a standalone Angular CLI app'],
    };
  }
  const ws = readAngularWorkspace(sourceDir);
  if (!ws) {
    return {
      confidence: 0,
      reasons: [
        sourceExists(sourceDir, 'angular.json')
          ? 'angular.json is not valid JSON'
          : 'no angular.json',
      ],
    };
  }
  // e2e-only projects (app-e2e in older Angular CLI and Ionic repos) do not count.
  const all = Object.entries(ws.projects ?? {})
    .filter(([, p]) => !isE2eOnly(p))
    .map(([n]) => n);
  if (all.length > 1) {
    return {
      confidence: 0,
      reasons: [
        `angular.json has ${all.length} projects (${all.join(', ')}): use the ` +
          'angular-workspace adapter',
      ],
    };
  }
  const apps = applicationProjects(ws);
  if (apps.length > 1) {
    return {
      confidence: 0,
      reasons: [
        `angular.json has ${apps.length} application projects (${apps
          .map(([n]) => n)
          .join(', ')}): multi-project workspaces are not supported yet`,
      ],
    };
  }
  if (apps.length === 0) {
    return { confidence: 0, reasons: ['angular.json has no application project'] };
  }

  const [projectName, project] = apps[0];
  let confidence = 0.5;
  const reasons = [`angular.json with one application project (${projectName})`];

  const core = sourceDependency(readSourcePackageJson(sourceDir), '@angular/core');
  if (core) {
    confidence += 0.3;
    reasons.push(`@angular/core ${core} in package.json`);
  } else {
    reasons.push('no @angular/core in package.json');
  }

  const main = mainPath(project);
  if (sourceExists(sourceDir, main)) {
    confidence += 0.2;
    reasons.push(`${main} present`);
  } else {
    reasons.push(`${main} missing`);
  }

  const ionic = ionicSignals(sourceDir);
  if (ionic.length > 0) {
    confidence = Math.min(confidence, 0.5);
    reasons.push(`Ionic/Capacitor app (${ionic.join(', ')}): see the ionic adapter`);
  }
  return { confidence: round(confidence), reasons };
}

/** The build target's main (or Angular 17+ browser) option, else <sourceRoot>/main.ts. */
export function mainPath(project: AngularProject): string {
  const targets = project.architect ?? project.targets ?? {};
  const options = targets['build']?.options;
  const main = options?.['main'] ?? options?.['browser'];
  if (typeof main === 'string') return main.replace(/^\.\//, '');
  const sourceRoot = project.sourceRoot ?? (project.root ? `${project.root}/src` : 'src');
  return `${sourceRoot}/main.ts`;
}

export const angularCliAdapter: MigrationAdapter = {
  id: 'angular-cli',
  label: 'standalone Angular CLI app',
  detect: detectAngularCli,
  defaultName(sourceDir: string): string | undefined {
    const apps = applicationProjects(readAngularWorkspace(sourceDir));
    return apps.length === 1 ? apps[0][0] : undefined;
  },
  preflight(tree: Tree, ctx: MigrationContext): void {
    const [, project] = theApplication(ctx.sourceDir);
    const ssr = serverRenderingError(project);
    if (ssr) throw new Error(ssr);
    const rootPkg = sourceRootPackage(ctx.sourceDir);
    if (rootPkg.unresolved.length > 0) {
      throw new Error(`migrate: ${catalogMissMessage('package.json', rootPkg.unresolved)}`);
    }
    const mismatch = angularMismatch(tree, rootPkg.pkg);
    if (mismatch && !ctx.forceAngular) {
      throw new Error(`migrate: ${angularMismatchMessage(mismatch)}`);
    }
  },
  migrate: (tree, ctx) => migrateAngularApp(tree, ctx).data,
};

// ── Migration ────────────────────────────────────────────────────────────────

/** Not copied from a standalone app's repo root. */
export const ANGULAR_SKIP: SkipRules = {
  anyDepth: ['node_modules', '.git'],
  topLevel: [
    'dist',
    '.angular',
    '.vscode',
    '.idea',
    'coverage',
    '.nx',
    'out-tsc',
    'tmp',
    // Workspace-level files: rewritten into the workspace instead of copied.
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'angular.json',
    'tsconfig.json',
    'nx.json',
  ],
};

/** Not copied from a project folder inside the repo (angular.json `root` is not ""). */
export const ANGULAR_SKIP_NESTED: SkipRules = {
  anyDepth: ['node_modules', '.git'],
  topLevel: ['dist', '.angular', 'coverage', 'out-tsc', 'tmp'],
};

/** The one application project; throws when there is not exactly one. */
export function theApplication(sourceDir: string): [string, AngularProject] {
  const ws = readAngularWorkspace(sourceDir);
  if (!ws) {
    throw new Error(`migrate: the angular-cli adapter needs an angular.json in ${sourceDir}.`);
  }
  const apps = applicationProjects(ws);
  if (apps.length !== 1) {
    throw new Error(
      `migrate: the angular-cli adapter needs exactly one application project in angular.json; ` +
        `found ${apps.length}${apps.length ? ` (${apps.map(([n]) => n).join(', ')})` : ''}.`,
    );
  }
  return apps[0];
}

const normalizeRoot = (root: string | undefined) =>
  path.posix.normalize((root ?? '').replace(/\\/g, '/')).replace(/^\.\/?$|\/$/g, '');

function writeJson(tree: Tree, file: string, value: unknown): void {
  tree.write(file, JSON.stringify(value, null, 2) + '\n');
}

export interface AngularAppOptions {
  /** Skip rules for a root-level app (default ANGULAR_SKIP). */
  skip?: SkipRules;
  /** Skip rules for an app in a sub-folder (default ANGULAR_SKIP_NESTED). */
  skipNested?: SkipRules;
  /** Source packages not merged into the root package.json, with the reason. */
  dependencySkip?: DependencySkip | DependencySkip[];
  /** Tags for the project (default scope:app, type:app, platform:web). */
  tags?: string[];
  /** Also honour the .gitignore files from this folder down to the source (a workspace root). */
  ignoreFrom?: string;
  /** More paths (relative to the copied folder) not to copy, e.g. packages nested in it. */
  skipPaths?: string[];
  /** The app's package.json as already read (pnpm catalogs resolved); default: read from disk. */
  sourcePkg?: PackageJson;
  /** Prefix for the Angular conversion and code notes (the project, in a workspace import). */
  notesLabel?: string;
}

export interface AngularAppResult {
  data: MigrationReportData;
  releaseConfigurations: string[];
}

export function migrateAngularApp(
  tree: Tree,
  ctx: MigrationContext,
  opts: AngularAppOptions = {},
): AngularAppResult {
  const { sourceDir, name, projectRoot } = ctx;
  const data = emptyReportData();
  const [sourceProject, project] = theApplication(sourceDir);
  const sourceRoot = normalizeRoot(project.root);
  const sourcePkg = opts.sourcePkg ?? sourceRootPackage(sourceDir).pkg;

  // 1. Copy
  // e2e-only projects are not migrated; their folders are not copied into the app.
  const e2e = e2eProjects(readAngularWorkspace(sourceDir));
  const e2eSkip = e2e
    .map(([, r]) => r)
    .filter((r) => r && (sourceRoot === '' || r.startsWith(`${sourceRoot}/`)))
    .map((r) => (sourceRoot ? r.slice(sourceRoot.length + 1) : r));
  const rules = sourceRoot ? opts.skipNested ?? ANGULAR_SKIP_NESTED : opts.skip ?? ANGULAR_SKIP;
  const copy = copyIntoTree(
    tree,
    sourceRoot ? path.join(sourceDir, sourceRoot) : sourceDir,
    projectRoot,
    { ...rules, paths: [...(rules.paths ?? []), ...e2eSkip, ...(opts.skipPaths ?? [])] },
    { maxFiles: ctx.maxFiles, ignoreFrom: opts.ignoreFrom },
  );
  recordCopy(data, copy, sourceRoot);
  if (e2e.length > 0) {
    data.notes.push(
      `e2e project${e2e.length > 1 ? 's' : ''} ${e2e
        .map(([n, r]) => `\`${n}\`${r ? ` (\`${r}\`)` : ''}`)
        .join(', ')} not migrated (e2e projects are not supported yet).`,
    );
  }
  if (sourceRoot) {
    data.notes.push(
      `Only the project folder \`${sourceRoot}\` was copied; files elsewhere in the source repo ` +
        'were not.',
    );
  }

  const mapper: PathMapper = {
    sourceRoot,
    projectRoot,
    name,
    exists: (rel) => sourceExists(sourceDir, rel),
    warnings: [],
  };

  noteBuildConfigs(copy.copied, sourceRoot, data);

  // 2. project.json
  const pj = angularProjectJson({
    sourceProject,
    project,
    name,
    projectRoot,
    exists: mapper.exists,
  });
  writeJson(tree, `${projectRoot}/project.json`, pj.projectJson);
  setProjectTags(tree, projectRoot, opts.tags ?? ['scope:app', 'type:app', 'platform:web']);
  data.notes.push(...pj.warnings.map((w) => `project.json: ${w}`));
  const label = opts.notesLabel ? `${opts.notesLabel} ` : '';
  data.angularNotes.push(...pj.angularNotes.map((n) => `${label}${n}`));
  data.angularNotes.push(...angularCodeNotes(tree, projectRoot, copy.copied, opts.notesLabel));
  const main = (pj.projectJson['targets'] as Record<string, { options?: { main?: unknown } }>)?.[
    'build'
  ]?.options?.main;
  const nonceNote = typeof main === 'string' ? noncePatchMains(tree, [main]) : undefined;
  if (nonceNote) data.notes.push(nonceNote);

  // 3. tsconfig
  migrateTsconfigs(tree, ctx, sourceRoot, copy.copied, mapper, data);

  // 4. ESLint
  migrateEslint(tree, ctx, project.prefix ?? 'app', copy.copied, mapper, data);

  // 5. Dependencies
  const copiedDir = sourceRoot ? path.join(sourceDir, sourceRoot) : sourceDir;
  const specContext: SpecContext = { sourceDir, copiedDir, projectRoot };
  data.installTask = mergeDependencies(
    tree,
    {
      sourceDir,
      sourcePkg,
      classify: (spec) => classifyDependencySpec(spec, specContext),
      copiedLabel: 'migrated project folder',
      angular: true,
      skip: opts.dependencySkip,
    },
    data,
  );

  // Browser support: a package.json browserslist becomes .browserslistrc next to the app.
  writeBrowserslist(tree, ctx, sourcePkg, copy.copied, data);

  // 6. npm scripts
  const targets = pj.projectJson['targets'] as Record<string, unknown>;
  addNpmScripts(
    tree,
    angularAppNpmScripts(name, targets['serve'] !== undefined, pj.releaseConfigurations),
    { force: false },
  );
  data.sourceScripts = { ...(sourcePkg?.scripts ?? {}) };

  // 7. Environments: kept as they are.
  data.nextSteps.push(
    `\`npx nx build ${name}\``,
    `\`npx nx lint ${name}\``,
    `Environments: the app keeps its own \`environment*.ts\` files and fileReplacements. ` +
      `\`pstack env --name=<env>\` adds a new environment to every app, this one included. ` +
      'For build-time env encryption (`nx run ' +
      `${name}:release:<env>\`), move the files to \`environments/${name}/environment.<env>.ts\` ` +
      '(the `pstack app` layout) and point fileReplacements there.',
  );
  return { data, releaseConfigurations: pj.releaseConfigurations };
}

/**
 * The project's tsconfig files: apps/<name>/tsconfig.json from the source root tsconfig.json (when
 * the copy has none), and `extends`/`outDir` of every copied tsconfig*.json fixed for the new folder.
 */
export function migrateProjectTsconfigs(
  tree: Tree,
  ctx: MigrationContext,
  sourceRoot: string,
  copied: string[],
  mapper: PathMapper,
  data: MigrationReportData,
): void {
  const { sourceDir, projectRoot } = ctx;
  const rootTs = readSourceJsonStrict(sourceDir, 'tsconfig.json');
  const appTsconfig = `${projectRoot}/tsconfig.json`;
  if (rootTs && !tree.exists(appTsconfig)) {
    const ts4 = typeScript4Config(appRootTsconfig(rootTs, mapper), appTsconfig);
    writeJson(tree, appTsconfig, ts4.config);
    data.angularNotes.push(...ts4.notes);
  } else if (rootTs) {
    data.notes.push(
      `The project folder has its own tsconfig.json; the source root tsconfig.json was not ` +
        `merged into it. Make it extend \`${upTo(projectRoot)}tsconfig.base.json\`.`,
    );
  }

  for (const rel of copied) {
    if (!/(^|\/)tsconfig[^/]*\.json$/.test(rel) || rel === 'tsconfig.json') continue;
    const file = `${projectRoot}/${rel}`;
    const config = parseJsonStrict(
      tree.read(file, 'utf8') ?? '',
      sourceRoot ? `${sourceRoot}/${rel}` : rel,
    );
    const fixed = fixProjectTsconfig(config, {
      sourceFile: sourceRoot ? `${sourceRoot}/${rel}` : rel,
      sourceRoot,
      projectRoot,
    });
    const ts4 = typeScript4Config(fixed.config, file);
    writeJson(tree, file, ts4.config);
    data.notes.push(...fixed.warnings);
    data.angularNotes.push(...ts4.notes);
  }
}

function migrateTsconfigs(
  tree: Tree,
  ctx: MigrationContext,
  sourceRoot: string,
  copied: string[],
  mapper: PathMapper,
  data: MigrationReportData,
): void {
  migrateProjectTsconfigs(tree, ctx, sourceRoot, copied, mapper, data);
  const { sourceDir, projectRoot } = ctx;
  const rootTs = readSourceJsonStrict(sourceDir, 'tsconfig.json');
  const co = (rootTs?.['compilerOptions'] ?? {}) as Record<string, unknown>;
  const sourcePaths = co['paths'];
  if (sourcePaths && typeof sourcePaths === 'object' && Object.keys(sourcePaths).length > 0) {
    const baseUrl = typeof co['baseUrl'] === 'string' ? (co['baseUrl'] as string) : '.';
    if (!tree.exists('tsconfig.base.json')) writeJson(tree, 'tsconfig.base.json', {});
    updateJson(tree, 'tsconfig.base.json', (json: Record<string, unknown>) => {
      const opts = (json['compilerOptions'] ?? {}) as Record<string, unknown>;
      const merged = mergeTsPaths(
        (opts['paths'] ?? {}) as Record<string, string[]>,
        sourcePaths as Record<string, unknown>,
        baseUrl,
        mapper,
      );
      opts['paths'] = merged.paths;
      json['compilerOptions'] = opts;
      data.tsPathsAdded = merged.added;
      data.tsPathClashes = merged.clashes;
      return json;
    });
    data.notes.push(...mapper.warnings.map((w) => `tsconfig paths: ${w}`));
  }

  // With import rewriting on, the generator rewrites these imports and reports what is left.
  if (typeof co['baseUrl'] === 'string' && !ctx.rewriteImports) {
    const users = baseUrlImports(tree, projectRoot, copiedTs(copied));
    if (users.length > 0) {
      data.notes.push(
        `The source tsconfig set \`baseUrl: "${co['baseUrl']}"\`, which the app no longer has ` +
          '(the workspace base owns it). These files import through it and need relative imports ' +
          `or a path alias: ${users.map((u) => `\`${u}\``).join(', ')}.`,
      );
    }
  }
}

function writeBrowserslist(
  tree: Tree,
  ctx: MigrationContext,
  pkg: PackageJson | undefined,
  copied: string[],
  data: MigrationReportData,
): void {
  if (pkg?.browserslist === undefined) return;
  if (copied.includes('.browserslistrc') || copied.includes('browserslist')) return;
  const content = browserslistFile(pkg.browserslist);
  const file = `${ctx.projectRoot}/.browserslistrc`;
  if (content === undefined) {
    data.notes.push(
      'The source package.json has a `browserslist` value nx-polystack could not read; add ' +
        `\`${file}\` by hand.`,
    );
    return;
  }
  tree.write(file, content);
  data.notes.push(
    `Wrote \`${file}\` from the source package.json \`browserslist\` (the root package.json ` +
      'is shared by every app).',
  );
}

/**
 * Tailwind/PostCSS configs resolve relative paths from the process cwd, which is the workspace
 * root under Nx.
 */
function noteBuildConfigs(copied: string[], sourceRoot: string, data: MigrationReportData): void {
  const at = (f: string) => (sourceRoot ? `${sourceRoot}/${f}` : f);
  for (const f of copied.filter((c) => /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(c))) {
    data.notes.push(
      `\`${at(f)}\`: Nx runs the build from the workspace root, so relative \`content\` globs ` +
        '(`./src/**/*.html`) now resolve from there. Anchor them to the app: `join(__dirname, ' +
        "'src/**/*.{html,ts}')` with `const { join } = require('path')`.",
    );
  }
  for (const f of copied.filter((c) =>
    /^(postcss\.config\.(js|cjs|mjs|json)|\.postcssrc(\.json)?)$/.test(c),
  )) {
    data.notes.push(
      `\`${at(f)}\`: relative paths in it now resolve from the workspace root; anchor them with ` +
        '`__dirname` as for Tailwind.',
    );
  }
}

const copiedTs = (copied: string[]) => copied.filter((f) => f.endsWith('.ts'));

/**
 * Copied files with non-relative imports through the source `baseUrl` (src/…, app/…,
 * environments/…, plus `extraPrefixes` such as the projects folder).
 */
export function baseUrlImports(
  tree: Tree,
  projectRoot: string,
  files: string[],
  extraPrefixes: string[] = [],
): string[] {
  const prefixes = ['src', 'app', 'environments', ...extraPrefixes]
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp(`(?:from|import\\()\\s*['"](?:${prefixes})/`);
  return files
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => re.test(tree.read(`${projectRoot}/${f}`, 'utf8') ?? ''));
}

const OTHER_ESLINT = /^(\.eslintrc(\.(js|cjs|yaml|yml))?|eslint\.config\.(js|mjs|cjs))$/;

export function migrateEslint(
  tree: Tree,
  ctx: MigrationContext,
  prefix: string,
  copied: string[],
  mapper: PathMapper,
  data: MigrationReportData,
): void {
  const file = `${ctx.projectRoot}/.eslintrc.json`;
  if (tree.exists(file)) {
    const local: PathMapper = { ...mapper, warnings: [] };
    const label = mapper.sourceRoot ? `${mapper.sourceRoot}/.eslintrc.json` : '.eslintrc.json';
    const config = parseJsonStrict(tree.read(file, 'utf8') ?? '', label);
    writeJson(tree, file, extendRootEslintConfig(config, local));
    data.notes.push(...local.warnings.map((w) => `.eslintrc.json: ${w}`));
    return;
  }
  const other = copied.filter((f) => OTHER_ESLINT.test(f));
  if (other.length > 0) {
    data.notes.push(
      `ESLint config ${other.map((f) => `\`${f}\``).join(', ')} was copied as is. Convert it to ` +
        `\`.eslintrc.json\` extending \`${upTo(
          ctx.projectRoot,
        )}.eslintrc.json\` so \`nx lint\` uses ` +
        'the workspace rules.',
    );
    return;
  }
  const template = fs.readFileSync(
    path.join(__dirname, '..', '..', 'app', 'files', 'angular', '.eslintrc.json__template__'),
    'utf8',
  );
  tree.write(
    file,
    template
      .replace(/"prefix": "app"/g, `"prefix": ${JSON.stringify(prefix)}`)
      .replace(/<%= up %>/g, upTo(ctx.projectRoot)),
  );
}
