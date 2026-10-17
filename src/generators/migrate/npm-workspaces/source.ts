import * as fs from 'fs';
import * as path from 'path';

import { applicationProjects, readAngularWorkspace } from '../adapters/angular-cli';
import { kebabName } from '../names';
import {
  classifyProject,
  isObject,
  isSupportedKind,
  Json,
  ProjectKind,
  SourceProject,
} from '../nx/workspace-source';
import { pnpmWorkspaceOrNothing, resolveCatalogs, sourceCatalogs } from '../pnpm';
import { isSourceFile, PackageJson, readSourceJson, sourceExists } from '../source';

export { PnpmWorkspace, readPnpmWorkspace, resolveCatalogs, sourceRootPackage } from '../pnpm';

/**
 * Read-only view of an npm / Yarn / pnpm workspaces source: the package folders its root
 * package.json `workspaces` globs (or pnpm-workspace.yaml `packages`) match, and what kind of
 * project each one is.
 */

export type PackageManager = 'npm' | 'Yarn 1' | 'Yarn Berry' | 'pnpm';

export interface WorkspacePackageJson extends PackageJson {
  workspaces?: unknown;
  source?: unknown;
  types?: unknown;
  typings?: unknown;
  bin?: unknown;
}

export interface NpmPackage extends SourceProject {
  /** package.json `name` (the import name of a library); the folder name when it has none. */
  packageName: string;
  pkg: WorkspacePackageJson;
  /** Library entry file, relative to the package folder (libs only). */
  entry?: string;
  /** Package names of the other workspace packages it depends on (any dependency field). */
  workspaceDependencies: string[];
  /** pnpm `catalog:` specs that name no catalog entry ("dep (catalog:x)"). */
  unresolvedCatalogs: string[];
}

/**
 * The package globs: pnpm-workspace.yaml `packages` when that file exists (pnpm ignores the
 * package.json field), else the package.json `workspaces`. undefined when neither lists any.
 */
export function sourceWorkspaceGlobs(sourceDir: string): string[] | undefined {
  if (sourceExists(sourceDir, 'pnpm-workspace.yaml')) {
    return pnpmWorkspaceOrNothing(sourceDir)?.packages;
  }
  return workspaceGlobs(readSourceJson<WorkspacePackageJson>(sourceDir, 'package.json'));
}

/** The `workspaces` globs: an array, or `{ packages: [...] }` (Yarn 1). undefined when absent. */
export function workspaceGlobs(pkg: WorkspacePackageJson | undefined): string[] | undefined {
  const ws = pkg?.workspaces;
  const list = Array.isArray(ws) ? ws : isObject(ws) ? ws['packages'] : undefined;
  if (!Array.isArray(list)) return undefined;
  return list.filter((g): g is string => typeof g === 'string' && g.trim() !== '');
}

export function packageManager(sourceDir: string): PackageManager {
  // Corepack's "packageManager" field ("pnpm@9.12.0", "yarn@4.1.0") names the manager.
  const field = readSourceJson<Json>(sourceDir, 'package.json')?.['packageManager'];
  const named = typeof field === 'string' ? field : '';
  if (
    named.startsWith('pnpm@') ||
    sourceExists(sourceDir, 'pnpm-workspace.yaml') ||
    sourceExists(sourceDir, 'pnpm-lock.yaml')
  ) {
    return 'pnpm';
  }
  if (sourceExists(sourceDir, '.yarnrc.yml') || sourceExists(sourceDir, '.yarn')) {
    return 'Yarn Berry';
  }
  // "yarn@4.1.0" names Berry even without .yarnrc.yml.
  const yarn = /^yarn@(\d+)/.exec(named);
  if (yarn) return Number(yarn[1]) >= 2 ? 'Yarn Berry' : 'Yarn 1';
  return sourceExists(sourceDir, 'yarn.lock') ? 'Yarn 1' : 'npm';
}

const NEVER_ENTER = (name: string) => name === 'node_modules' || name.startsWith('.');

function subfolders(sourceDir: string, rel: string): string[] {
  try {
    return fs
      .readdirSync(rel ? path.join(sourceDir, ...rel.split('/')) : sourceDir, {
        withFileTypes: true,
      })
      .filter((e) => e.isDirectory() && !NEVER_ENTER(e.name))
      .map((e) => (rel ? `${rel}/${e.name}` : e.name));
  } catch {
    return [];
  }
}

/** One glob segment ("*", "pkg-*", "web") against a folder name. */
function segmentMatches(segment: string, name: string): boolean {
  const re = new RegExp(
    `^${segment
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`,
  );
  return re.test(name);
}

/** Folders (relative to the source, POSIX) one glob matches. */
function expandGlob(sourceDir: string, glob: string): string[] {
  const segments = path.posix
    .normalize(glob.replace(/\\/g, '/'))
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return [];
  let current = [''];
  for (const segment of segments) {
    const next = new Set<string>();
    for (const dir of current) {
      if (segment === '**') {
        const stack = [dir];
        while (stack.length > 0) {
          const d = stack.pop() as string;
          next.add(d);
          stack.push(...subfolders(sourceDir, d));
        }
      } else if (!segment.includes('*')) {
        const rel = dir ? `${dir}/${segment}` : segment;
        if (!NEVER_ENTER(segment) && fs.existsSync(path.join(sourceDir, ...rel.split('/')))) {
          next.add(rel);
        }
      } else {
        for (const sub of subfolders(sourceDir, dir)) {
          if (segmentMatches(segment, sub.split('/').pop() as string)) next.add(sub);
        }
      }
    }
    current = [...next];
  }
  return current.filter((d) => d !== '');
}

/** Package folders: matched by a glob, not by a "!" glob, holding a package.json. Sorted. */
export function expandWorkspaceGlobs(sourceDir: string, globs: string[]): string[] {
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (const glob of globs) {
    const negated = glob.startsWith('!');
    for (const dir of expandGlob(sourceDir, negated ? glob.slice(1) : glob)) {
      (negated ? excluded : included).add(dir);
    }
  }
  return [...included]
    .filter((d) => !excluded.has(d) && isSourceFile(sourceDir, `${d}/package.json`))
    .sort();
}

const NOT_A_LIB_DEPENDENCY = [
  'react',
  'react-dom',
  'vue',
  'svelte',
  'next',
  'nuxt',
  'express',
  'fastify',
  'koa',
  '@nestjs/core',
  '@hapi/hapi',
];

const dependencyNames = (pkg: WorkspacePackageJson): string[] => [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

/** The library entry file (relative to the package folder), or undefined when none is found. */
export function libEntry(
  sourceDir: string,
  root: string,
  pkg: WorkspacePackageJson,
): string | undefined {
  const at = (f: string) => `${root}/${f}`;
  const isFile = (f: string) => isSourceFile(sourceDir, at(f));
  const clean = (f: string) => path.posix.normalize(f.replace(/\\/g, '/')).replace(/^\.\//, '');

  const ngPackage = readSourceJson<Json>(sourceDir, at('ng-package.json'));
  const lib = isObject(ngPackage?.['lib']) ? (ngPackage?.['lib'] as Json) : {};
  const candidates: string[] = [];
  if (typeof lib['entryFile'] === 'string') candidates.push(clean(lib['entryFile']));
  if (typeof pkg.source === 'string' && /\.tsx?$/.test(pkg.source))
    candidates.push(clean(pkg.source));
  for (const field of [pkg.types, pkg.typings]) {
    if (typeof field !== 'string' || !field.endsWith('.d.ts')) continue;
    const rel = clean(field).replace(/\.d\.ts$/, '.ts');
    candidates.push(rel.replace(/^(dist|lib|build|out)\//, 'src/'), rel);
  }
  candidates.push('src/index.ts', 'index.ts');
  return candidates.find((c) => !c.startsWith('..') && isFile(c));
}

/** angular.json application (browser or application builder) → angular-app / ionic-app / …; else lib / other. */
export function classifyPackage(
  sourceDir: string,
  root: string,
  pkg: WorkspacePackageJson,
): { kind: ProjectKind; entry?: string } {
  const ngDir = path.join(sourceDir, ...root.split('/'));
  if (sourceExists(sourceDir, `${root}/angular.json`)) {
    const apps = applicationProjects(readAngularWorkspace(ngDir));
    if (apps.length !== 1) return { kind: 'other' };
    const [, project] = apps[0];
    const architect = (project.architect ?? project.targets ?? {}) as Record<string, Json>;
    const targets: Json = {};
    for (const [name, t] of Object.entries(architect)) {
      if (!isObject(t)) continue;
      const { builder, ...rest } = t;
      targets[name] = { executor: rest['executor'] ?? builder, ...rest };
    }
    return {
      kind: classifyProject(
        sourceDir,
        root,
        { projectType: 'application', targets },
        { applicationBuilder: true },
      ),
    };
  }
  if (pkg.bin !== undefined) return { kind: 'other' };
  if (dependencyNames(pkg).some((d) => NOT_A_LIB_DEPENDENCY.includes(d))) return { kind: 'other' };
  const entry = libEntry(sourceDir, root, pkg);
  return entry ? { kind: 'lib', entry } : { kind: 'other' };
}

/** Every workspace package, with its kind and the workspace packages it depends on. */
export function discoverPackages(sourceDir: string): NpmPackage[] {
  const globs = sourceWorkspaceGlobs(sourceDir) ?? [];
  const catalogs = sourceCatalogs(sourceDir);
  const found = expandWorkspaceGlobs(sourceDir, globs).map((root) => {
    const raw = readSourceJson<WorkspacePackageJson>(sourceDir, `${root}/package.json`) ?? {};
    const { pkg, unresolved } = resolveCatalogs(raw, catalogs);
    const packageName =
      typeof pkg.name === 'string' && pkg.name ? pkg.name : (root.split('/').pop() as string);
    return {
      root,
      pkg,
      packageName,
      unresolved,
      ...classifyPackage(sourceDir, root, pkg),
    };
  });
  const names = uniqueNames(found);
  const byPackage = new Map(found.map((f, i) => [f.packageName, i]));
  return found.map((f, i) => {
    const workspaceDependencies = [
      ...new Set(dependencyNames(f.pkg).filter((d) => d !== f.packageName && byPackage.has(d))),
    ].sort();
    // Only importable packages join the closure; a dependency on a config package (eslint-config,
    // tsconfig) or a server is reported instead of blocking the import.
    const implicit = workspaceDependencies
      .map((d) => byPackage.get(d) as number)
      .filter((j) => isSupportedKind(found[j].kind))
      .map((j) => names[j])
      .sort();
    return {
      name: names[i],
      root: f.root,
      config: { implicitDependencies: implicit },
      origin: 'package.json' as const,
      kind: f.kind,
      packageName: f.packageName,
      pkg: f.pkg,
      entry: f.entry,
      workspaceDependencies,
      unresolvedCatalogs: f.unresolved,
    };
  });
}

/**
 * Project names: the package name without its scope ("@acme/web" → "web"); when two packages
 * would share one, the scope is kept ("acme-utils", "other-utils"), then the folder path.
 */
function uniqueNames(found: { root: string; packageName: string }[]): string[] {
  const short = found.map(
    (f) => kebabName(f.packageName.replace(/^@[^/]+\//, '')) || kebabName(f.root),
  );
  const count = (list: string[], n: string) => list.filter((x) => x === n).length;
  const scoped = short.map((n, i) =>
    count(short, n) > 1 ? kebabName(found[i].packageName.replace(/^@/, '').replace('/', '-')) : n,
  );
  return scoped.map((n, i) => (count(scoped, n) > 1 ? kebabName(found[i].root) : n));
}
