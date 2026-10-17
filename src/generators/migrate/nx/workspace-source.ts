import * as fs from 'fs';
import * as path from 'path';

import { majorOf } from '../../../lib/utils/dependencies';

import type { AngularProject } from '../adapters/angular-cli';
import { readPubspec } from '../adapters/flutter';
import { applicationBuilderTargets, serverRendering } from '../angular17';
import { gitListedFiles } from '../copy';
import {
  isSourceFile,
  readSourceJsonStrict,
  readSourcePackageJson,
  readSourceText,
  sourceDependency,
  sourceExists,
} from '../source';

/**
 * Read-only view of an Nx source workspace: its projects (from project.json files,
 * workspace.json and angular.json) and what kind each one is.
 */

export type Json = Record<string, unknown>;

export type ProjectKind =
  | 'angular-app'
  | 'lib'
  | 'flutter-app'
  | 'flutter-lib'
  | 'ionic-app'
  | 'ionic-cordova'
  | 'e2e'
  | 'angular-app17'
  | 'angular-ssr'
  | 'root'
  | 'other';

/** Kinds :migrate can import. */
export const SUPPORTED_KINDS: readonly ProjectKind[] = [
  'angular-app',
  'lib',
  'flutter-app',
  'flutter-lib',
  'ionic-app',
];

export const isSupportedKind = (kind: ProjectKind): boolean => SUPPORTED_KINDS.includes(kind);

/** Why a kind cannot be migrated, when that is not obvious from its name. */
const UNSUPPORTED_REASONS: Partial<Record<ProjectKind, string>> = {
  'angular-app17':
    'Angular 17+ application builder in an Nx source: supported from Angular CLI and ' +
    'npm/Yarn/pnpm workspace sources, not Nx ones yet',
  'angular-ssr': 'Angular app with server rendering (SSR, prerender or app shell)',
  'ionic-cordova': 'Ionic app on Cordova: only Capacitor apps are supported',
};

/** Why a kind cannot be migrated, when that is not obvious from its name. */
export const unsupportedReason = (kind: ProjectKind): string | undefined =>
  UNSUPPORTED_REASONS[kind];

/** The kind, with the reason it is not supported when there is one. */
export const describeKind = (kind: ProjectKind): string =>
  UNSUPPORTED_REASONS[kind] ? `${kind}: ${UNSUPPORTED_REASONS[kind]}` : kind;

export interface SourceProject {
  name: string;
  /** POSIX, relative to the source root, no trailing slash; '' for a root project. */
  root: string;
  /** Project configuration with `targets`/`executor` (converted from `architect`/`builder`). */
  config: Json;
  origin: 'project.json' | 'workspace.json' | 'angular.json' | 'package.json';
  kind: ProjectKind;
}

export const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `json[key]` when it is an object, else {}. */
export function objectField(json: Json | undefined, key: string): Json {
  const value = json?.[key];
  return isObject(value) ? value : {};
}

export function normalizeRoot(root: string | undefined): string {
  return path.posix
    .normalize((root ?? '').replace(/\\/g, '/'))
    .replace(/^\.\/?$|\/$/g, '')
    .replace(/^\.\//, '');
}

/** `architect` → `targets`, `builder` → `executor` (inline workspace.json/angular.json configs). */
export function normalizeConfig(raw: Json): Json {
  const { architect, targets, ...rest } = raw;
  const source = (isObject(targets) ? targets : isObject(architect) ? architect : {}) as Json;
  const converted: Json = {};
  for (const [name, target] of Object.entries(source)) {
    if (isObject(target) && target['builder'] !== undefined && target['executor'] === undefined) {
      const { builder, ...t } = target;
      converted[name] = { executor: builder, ...t };
    } else {
      converted[name] = target;
    }
  }
  return { ...rest, targets: converted };
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tmp', 'coverage']);
const skipDir = (name: string) => SKIP_DIRS.has(name) || name.startsWith('.');
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Files under `rel` (relative to it, sorted): the git listing when the source is a git work
 * tree, else a walk. node_modules, dist, tmp, coverage and dot folders are left out either way.
 */
export function listProjectFiles(sourceDir: string, rel: string): string[] {
  const dir = rel ? path.join(sourceDir, ...rel.split('/')) : sourceDir;
  const keep = (file: string) => !file.split('/').slice(0, -1).some(skipDir);
  const listed = gitListedFiles(dir);
  if (listed) return listed.filter(keep);
  const out: string[] = [];
  const visit = (sub: string) => {
    const abs = sub ? path.join(dir, ...sub.split('/')) : dir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => byName(a.name, b.name))) {
      const r = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDir(e.name)) visit(r);
      } else if (e.isFile()) out.push(r);
    }
  };
  visit('');
  return out.sort(byName);
}

const CAPACITOR_FILES = ['capacitor.config.ts', 'capacitor.config.js', 'capacitor.config.json'];
const ANGULAR_APP_EXECUTORS = new Set([
  '@angular-devkit/build-angular:browser',
  '@angular-devkit/build-angular:browser-esbuild',
  '@nx/angular:webpack-browser',
  '@nrwl/angular:webpack-browser',
  '@nx/angular:browser-esbuild',
  '@nrwl/angular:browser-esbuild',
]);
const LIB_BUILD_EXECUTORS = new Set([
  'nx:run-commands',
  ...['@nx', '@nrwl'].flatMap((scope) => [
    `${scope}/angular:package`,
    `${scope}/angular:ng-packagr-lite`,
    `${scope}/js:tsc`,
    `${scope}/js:swc`,
    `${scope}/workspace:run-commands`,
    `${scope}/rollup:rollup`,
    `${scope}/esbuild:esbuild`,
    `${scope}/vite:build`,
    `${scope}/webpack:webpack`,
    `${scope}/node:package`,
  ]),
]);
const E2E_EXECUTOR = /^@(nx|nrwl)\/(cypress|playwright):/;

function targetsOf(config: Json): Record<string, Json> {
  const t = config['targets'];
  return (isObject(t) ? t : {}) as Record<string, Json>;
}

function executorOf(target: unknown): string | undefined {
  return isObject(target) && typeof target['executor'] === 'string'
    ? (target['executor'] as string)
    : undefined;
}

export interface ClassifyOptions {
  /**
   * Angular 17+ application-builder apps can be migrated (converted to the browser builder):
   * true for angular.json projects of npm/Yarn/pnpm workspace packages; Nx sources say false.
   */
  applicationBuilder?: boolean;
}

export function classifyProject(
  sourceDir: string,
  root: string,
  config: Json,
  opts: ClassifyOptions = {},
): ProjectKind {
  if (root === '') return 'root';
  const at = (f: string) => `${root}/${f}`;
  const pubspec = readSourceText(sourceDir, at('pubspec.yaml'));
  if (pubspec !== undefined) {
    return readPubspec(pubspec).flutterSdk && isSourceFile(sourceDir, at('lib/main.dart'))
      ? 'flutter-app'
      : 'flutter-lib';
  }
  const targets = targetsOf(config);
  const isApp = config['projectType'] === 'application';
  const asProject = { targets } as unknown as AngularProject;
  const application = applicationBuilderTargets(asProject);
  if (application.length > 0) {
    if (serverRendering(asProject) !== undefined) return 'angular-ssr';
    if (!opts.applicationBuilder) return 'angular-app17';
  }
  const build = executorOf(targets['build']);
  const applicationBuild = application.some((t) => t.target === 'build');
  if (isApp) {
    if (build && (ANGULAR_APP_EXECUTORS.has(build) || applicationBuild)) {
      // Angular + Capacitor (Ionic or not) → ionic-app; Ionic without Capacitor is a Cordova app.
      if (CAPACITOR_FILES.some((f) => sourceExists(sourceDir, at(f)))) return 'ionic-app';
      if (['ionic.config.json', 'config.xml'].some((f) => sourceExists(sourceDir, at(f)))) {
        return 'ionic-cordova';
      }
      return 'angular-app';
    }
    const executors = Object.values(targets).map(executorOf);
    if (!build && executors.some((e) => e !== undefined && E2E_EXECUTOR.test(e))) return 'e2e';
    return 'other';
  }
  if (config['projectType'] === 'library') {
    return build === undefined || LIB_BUILD_EXECUTORS.has(build) ? 'lib' : 'other';
  }
  return 'other';
}

/**
 * Name Nx gives a project.json without `name`. Nx 16+: the folder name, lower-cased. Nx 15: the
 * path with the leading apps/libs folder (nx.json `workspaceLayout`) removed, "/" → "-".
 */
export function defaultProjectName(
  root: string,
  nxMajor: number | undefined,
  layout: Json,
): string {
  if (nxMajor === undefined || nxMajor >= 16) {
    return (root.split('/').pop() ?? root).toLowerCase();
  }
  const dirs = [layout['appsDir'] ?? 'apps', layout['libsDir'] ?? 'libs'].map((d) =>
    normalizeRoot(String(d)),
  );
  const prefix = dirs.find((d) => d && (root === d || root.startsWith(`${d}/`)));
  const rest = prefix ? root.slice(prefix.length + 1) : root;
  return (rest || root).replace(/\//g, '-').toLowerCase();
}

function projectJsonFiles(sourceDir: string): string[] {
  return listProjectFiles(sourceDir, '').filter(
    (f) => f === 'project.json' || f.endsWith('/project.json'),
  );
}

/**
 * Every project in the source, sorted by name. A workspace.json (else an angular.json) with
 * `projects` lists them all, as Nx 15 reads it; otherwise the project.json files are found by
 * walking the repo. A name or a root is taken by its first definition only.
 */
export function discoverProjects(sourceDir: string): SourceProject[] {
  const version = sourceNxVersion(sourceDir);
  const nxMajor = version ? majorOf(version) : undefined;
  const layout = objectField(readSourceJsonStrict<Json>(sourceDir, 'nx.json'), 'workspaceLayout');
  const found = new Map<string, SourceProject>();
  const roots = new Set<string>();
  const add = (
    name: string | undefined,
    rawRoot: string,
    raw: Json,
    origin: SourceProject['origin'],
  ) => {
    const root = normalizeRoot(rawRoot);
    const projectName = name ?? (root ? defaultProjectName(root, nxMajor, layout) : '');
    if (!projectName || found.has(projectName) || (root && roots.has(root))) return;
    const config = normalizeConfig(raw);
    roots.add(root);
    found.set(projectName, {
      name: projectName,
      root,
      config,
      origin,
      kind: classifyProject(sourceDir, root, config),
    });
  };

  const listed = (['workspace.json', 'angular.json'] as const)
    .map((origin) => ({
      origin,
      projects: readSourceJsonStrict<Json>(sourceDir, origin)?.['projects'],
    }))
    .find((w) => isObject(w.projects));
  if (listed) {
    for (const [name, entry] of Object.entries(listed.projects as Json)) {
      if (typeof entry === 'string') {
        const root = normalizeRoot(entry);
        const raw = readSourceJsonStrict<Json>(
          sourceDir,
          root ? `${root}/project.json` : 'project.json',
        );
        if (raw) add(name, root, raw, 'project.json');
      } else if (isObject(entry)) {
        add(
          name,
          typeof entry['root'] === 'string' ? (entry['root'] as string) : '',
          entry,
          listed.origin,
        );
      }
    }
  } else {
    for (const file of projectJsonFiles(sourceDir)) {
      const raw = readSourceJsonStrict<Json>(sourceDir, file) ?? {};
      const dir = path.posix.dirname(file);
      add(
        typeof raw['name'] === 'string' ? (raw['name'] as string) : undefined,
        dir === '.' ? '' : dir,
        raw,
        'project.json',
      );
    }
  }
  return [...found.values()].sort((a, b) => byName(a.name, b.name));
}

/** The source's Nx version range (nx, else @nrwl/workspace, else @nx/workspace). */
export function sourceNxVersion(sourceDir: string): string | undefined {
  const pkg = readSourcePackageJson(sourceDir);
  return (
    sourceDependency(pkg, 'nx') ??
    sourceDependency(pkg, '@nrwl/workspace') ??
    sourceDependency(pkg, '@nx/workspace')
  );
}

/** The project whose root contains `file` (longest root wins). */
export function ownerOf<T extends { root: string }>(projects: T[], file: string): T | undefined {
  let best: T | undefined;
  for (const p of projects) {
    if (!p.root) continue;
    if (
      (file === p.root || file.startsWith(`${p.root}/`)) &&
      (!best || p.root.length > best.root.length)
    ) {
      best = p;
    }
  }
  return best;
}
