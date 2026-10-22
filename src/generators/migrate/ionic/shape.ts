import { spawnSync } from 'child_process';
import * as path from 'path';

import { GeneratorCallback, readJson, Tree, updateJson } from '@nx/devkit';

import { workspaceGeneratorVersions } from '../../../lib/utils/angular-deps';
import { CAPACITOR_EXECUTOR, POLYSTACK_BUILD_EXECUTOR } from '../../../lib/utils/angular-project';
import { addMissingDependencies, declaredVersion, majorOf } from '../../../lib/utils/dependencies';
import { addNpmScripts } from '../../../lib/utils/npm-scripts';
import type { IonicReport } from '../adapters/types';
import { importSpecifiers } from '../nx/selection';
import { PackageJson, sourceDependency } from '../source';

import { rewriteCapacitorConfig } from './capacitor-config';
import {
  cordovaPlugins,
  DEP_FIELDS,
  isNativePackage,
  isWebCodeFile,
  packageOfSpecifier,
  splitNativePackages,
} from './packages';

export interface IonicShapeInput {
  /** Workspace project name. */
  name: string;
  /** Workspace folder of the app (project.json and the copied files are there). */
  appRoot: string;
  /** The package.json the app's packages come from (source root). */
  sourcePkg: PackageJson | undefined;
  /** Which packages are native (default: by name). */
  isNative?: (name: string) => boolean;
  /**
   * Native packages this app gets (default: all). Used when an Nx import has several Ionic apps;
   * the others are reported as left to the other apps.
   */
  forThisApp?: (name: string) => boolean;
  /** Native packages that also stay in the root package.json (the copied code imports them). */
  alsoAtRoot: ReadonlySet<string>;
  /** Release configuration names (dev, prod, …) for the android/ios npm scripts. */
  releaseConfigurations: string[];
}

export interface IonicShapeResult {
  report: IonicReport;
  /** `npm install` in the app folder; undefined when no native packages were written. */
  installApp?: GeneratorCallback;
  /** Packages added to the root package.json (Ionic's Angular peers), sorted. */
  rootPackagesAdded: string[];
}

/** Angular packages @ionic/angular needs (peer dependencies) besides what every Angular app has. */
const IONIC_ANGULAR_PEERS = ['@angular/forms', '@angular/router'];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const DROPPED = /^(@nxext\/capacitor|@nxext\/ionic-angular|@ionic\/angular-toolkit):/;
const IONICONS_ASSET = {
  glob: '**/*.svg',
  input: 'node_modules/ionicons/dist/ionicons/svg',
  output: './svg',
};
const PLATFORMS = ['android', 'ios'];

const inside = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/** `outputPath` as a string: the string form, or the `base` of the object form. */
function outputOf(options: unknown): string | undefined {
  if (!isObject(options)) return undefined;
  const out = options['outputPath'];
  if (typeof out === 'string') return out;
  if (isObject(out) && typeof out['base'] === 'string') return out['base'];
  return undefined;
}

function setOutput(options: Json, value: string): void {
  const out = options['outputPath'];
  if (isObject(out)) out['base'] = value;
  else options['outputPath'] = value;
}

/** Options objects of a target: its options and every configuration. */
function optionSets(target: Json | undefined): Json[] {
  if (!target) return [];
  const sets: Json[] = [];
  if (isObject(target['options'])) sets.push(target['options']);
  if (isObject(target['configurations'])) {
    for (const c of Object.values(target['configurations'])) if (isObject(c)) sets.push(c);
  }
  return sets;
}

export function applyIonicShape(tree: Tree, input: IonicShapeInput): IonicShapeResult {
  const { name, appRoot } = input;
  const isNative = input.isNative ?? isNativePackage;
  // The Capacitor executor's default web build folder.
  const executorDefault = `dist/apps/${name}`;
  const dist = appRoot.startsWith('apps/') ? `dist/${appRoot}` : executorDefault;
  const ionic = sourceDependency(input.sourcePkg, '@ionic/angular');
  const report: IonicReport = {
    project: name,
    packagePath: `${appRoot}/package.json`,
    ionic,
    capacitor: sourceDependency(input.sourcePkg, '@capacitor/core'),
    workspaceCapacitor: majorOf(workspaceGeneratorVersions(tree).capacitor),
    nativePackages: [],
    alsoAtRoot: [],
    otherApps: [],
    platforms: PLATFORMS.filter((p) => tree.exists(`${appRoot}/${p}`)),
    cordovaPlugins: cordovaPlugins(input.sourcePkg),
    droppedTargets: [],
  };

  // 1. project.json
  let webOutput = dist;
  updateJson(tree, `${appRoot}/project.json`, (pj: Json) => {
    const targets = (isObject(pj['targets']) ? pj['targets'] : {}) as Record<string, Json>;
    const build = isObject(targets['build']) ? targets['build'] : undefined;
    // Only the polystack release target: a source target named "release" is left alone.
    const release =
      isObject(targets['release']) && targets['release']['executor'] === POLYSTACK_BUILD_EXECUTOR
        ? targets['release']
        : undefined;
    const buildOptions = isObject(build?.['options']) ? (build?.['options'] as Json) : undefined;

    const out = outputOf(release?.['options']) ?? outputOf(buildOptions);
    const sets = [...optionSets(build), ...optionSets(release)];
    const moved = sets
      .map((o) => outputOf(o))
      .filter((o): o is string => typeof o === 'string' && inside(o, appRoot));
    if (moved.length > 0) {
      report.outputPathMoved = moved[0];
      for (const o of sets) {
        const value = outputOf(o);
        if (value !== undefined && inside(value, appRoot)) setOutput(o, dist);
      }
    }
    if (out !== undefined && !inside(out, appRoot)) webOutput = out;
    if (release && isObject(release['options'])) (release['options'] as Json)['type'] = 'ionic';

    if (buildOptions && ionic) {
      const assets = Array.isArray(buildOptions['assets']) ? buildOptions['assets'] : [];
      const hasIonicons = assets.some((a) =>
        (typeof a === 'string' ? a : String((a as Json)['input'] ?? '')).includes('ionicons'),
      );
      if (!hasIonicons) buildOptions['assets'] = [...assets, IONICONS_ASSET];
    }

    for (const [target, config] of Object.entries(targets)) {
      const executor = String(config?.['executor'] ?? '');
      if (DROPPED.test(executor)) {
        delete targets[target];
        report.droppedTargets.push(`${target} (${executor})`);
      }
    }
    report.droppedTargets.sort();
    for (const command of ['sync', 'open', 'add']) {
      targets[`cap-${command}`] = {
        executor: CAPACITOR_EXECUTOR,
        options: webOutput === executorDefault ? { command } : { command, webDir: webOutput },
      };
    }
    pj['targets'] = targets;
    const tags = Array.isArray(pj['tags']) ? (pj['tags'] as string[]) : [];
    const mobile = tags.map((t) => (t === 'platform:web' ? 'platform:mobile' : t));
    if (!mobile.some((t) => t.startsWith('platform:'))) mobile.push('platform:mobile');
    pj['tags'] = mobile;
    return pj;
  });

  // 2. webDir
  report.webDir = rewriteCapacitorConfig(tree, appRoot, path.posix.relative(appRoot, webOutput));

  // 3. Native packages → the app's package.json (Capacitor finds plugins there)
  const forThisApp = input.forThisApp ?? (() => true);
  const all = splitNativePackages(input.sourcePkg, isNative).names;
  const split = splitNativePackages(input.sourcePkg, isNative, forThisApp);
  report.nativePackages = split.names;
  report.otherApps = all.filter((n) => !split.names.includes(n));
  report.alsoAtRoot = split.names.filter((n) => input.alsoAtRoot.has(n));
  let installApp: GeneratorCallback | undefined;
  if (split.names.length > 0) {
    const file = `${appRoot}/package.json`;
    const pkg: Json = tree.exists(file)
      ? readJson(tree, file)
      : { name: `${name}-native`, private: true };
    const declared = new Set(
      DEP_FIELDS.flatMap((f) => Object.keys((pkg[f] as Record<string, string>) ?? {})),
    );
    for (const field of DEP_FIELDS) {
      const entries = Object.entries(split.native[field]).filter(([n]) => !declared.has(n));
      if (entries.length === 0) continue;
      pkg[field] = {
        ...((pkg[field] as Record<string, string>) ?? {}),
        ...Object.fromEntries(entries),
      };
    }
    tree.write(file, JSON.stringify(pkg, null, 2) + '\n');
    const appDir = path.join(tree.root, appRoot);
    installApp = () => {
      const r = spawnSync('npm', ['install'], {
        cwd: appDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
      if (r.error || r.status !== 0) {
        throw new Error(
          `npm install failed in ${appRoot} (Capacitor packages). Run "npm install" there; ` +
            'the cap-* targets also install them on first use.',
        );
      }
    };
  }

  // 4. Ionic's Angular peers, at the workspace's Angular version (sources often rely on hoisting).
  const rootPackagesAdded: string[] = [];
  const core = declaredVersion(tree, '@angular/core');
  if (ionic && core) {
    const missing = IONIC_ANGULAR_PEERS.filter((p) => declaredVersion(tree, p) === undefined);
    if (missing.length > 0) {
      addMissingDependencies(tree, Object.fromEntries(missing.map((p) => [p, core])), {});
      rootPackagesAdded.push(...missing.sort());
    }
  }

  // 5. npm scripts (never overwriting)
  const existing = readJson(tree, 'package.json').scripts ?? {};
  const scripts: Record<string, string> = {};
  for (const env of input.releaseConfigurations) {
    for (const platform of PLATFORMS) {
      scripts[
        `build:${name}:${env}:${platform}`
      ] = `nx run ${name}:release:${env} && nx run ${name}:cap-sync --platform=${platform}`;
    }
  }
  for (const platform of PLATFORMS) {
    scripts[`open:${name}:${platform}`] = `nx run ${name}:cap-open --platform=${platform}`;
  }
  addNpmScripts(
    tree,
    Object.fromEntries(Object.entries(scripts).filter(([k]) => existing[k] === undefined)),
  );

  return { report, installApp, rootPackagesAdded };
}

const WALK_SKIP = new Set(['node_modules', 'android', 'ios', 'dist', 'www']);

/** Native packages imported by the code files under `dir` in the tree. */
export function nativeImports(
  tree: Tree,
  dir: string,
  isNative: (name: string) => boolean = isNativePackage,
): Set<string> {
  const found = new Set<string>();
  const visit = (rel: string) => {
    for (const child of tree.children(rel)) {
      const at = `${rel}/${child}`;
      if (tree.isFile(at)) {
        if (!isWebCodeFile(at)) continue;
        for (const spec of importSpecifiers(tree.read(at, 'utf8') ?? '')) {
          const pkg = packageOfSpecifier(spec);
          if (isNative(pkg)) found.add(pkg);
        }
      } else if (!WALK_SKIP.has(child)) {
        visit(at);
      }
    }
  };
  visit(dir);
  return found;
}
