import * as path from 'path';

import type { AngularProject } from '../adapters/angular-cli';
import { applicationBuilderTargets, serverRendering } from '../angular17';
import { CAPACITOR_CONFIGS } from '../ionic/capacitor-config';
import {
  isObject,
  Json,
  normalizeConfig,
  normalizeRoot,
  ProjectKind,
  SourceProject,
} from '../nx/workspace-source';
import { readSourceJson, sourceExists } from '../source';

const APP_BUILDERS = new Set([
  '@angular-devkit/build-angular:browser',
  '@angular-devkit/build-angular:browser-esbuild',
]);
const E2E_BUILDER = /(protractor|cypress|playwright)/;

function executorOf(target: unknown): string | undefined {
  if (!isObject(target)) return undefined;
  const e = target['executor'] ?? target['builder'];
  return typeof e === 'string' ? e : undefined;
}

export function classifyAngularProject(sourceDir: string, root: string, config: Json): ProjectKind {
  const targets = isObject(config['targets']) ? (config['targets'] as Json) : {};
  const executors = Object.values(targets).map(executorOf);
  if (config['projectType'] === 'library') return 'lib';
  const build = executorOf(targets['build']);
  // Angular 17+ application builder: converted to the browser builder, unless the app renders
  // on the server.
  const asProject = { targets } as unknown as AngularProject;
  if (serverRendering(asProject) !== undefined) return 'angular-ssr';
  const application = applicationBuilderTargets(asProject).some((t) => t.target === 'build');
  if (build && (APP_BUILDERS.has(build) || application)) {
    const at = (f: string) => (root ? `${root}/${f}` : f);
    if (CAPACITOR_CONFIGS.some((f) => sourceExists(sourceDir, at(f)))) return 'ionic-app';
    // Ionic without Capacitor: a Cordova app (not supported).
    if (['ionic.config.json', 'config.xml'].some((f) => sourceExists(sourceDir, at(f)))) {
      return 'ionic-cordova';
    }
    return 'angular-app';
  }
  if (!build && executors.some((e) => e !== undefined && E2E_BUILDER.test(e))) return 'e2e';
  return 'other';
}

/** The angular.json projects (sorted by name); [] without a readable angular.json. */
export function discoverAngularProjects(sourceDir: string): SourceProject[] {
  const ws = readSourceJson<Json>(sourceDir, 'angular.json');
  const projects = isObject(ws?.['projects']) ? (ws?.['projects'] as Json) : {};
  return Object.entries(projects)
    .filter(([, p]) => isObject(p))
    .map(([name, p]) => {
      const config = normalizeConfig(p as Json);
      const root = normalizeRoot((p as Json)['root'] as string | undefined);
      return {
        name,
        root,
        config,
        origin: 'angular.json' as const,
        kind: classifyAngularProject(sourceDir, root, config),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export interface LibraryInfo {
  /** ng-package.json path (source-relative), when the library has one. */
  ngPackage?: string;
  /** Entry file relative to the library root. */
  entryFile: string;
  /** Build output folders (source-relative) an alias may point at. */
  outputs: string[];
  /** Entry file of a secondary entry point folder (relative to that folder). */
  secondaryEntry: (sub: string) => string;
}

/** The entry file in `dir` (source-relative): ng-package.json lib.entryFile, else the file that exists. */
function entryIn(sourceDir: string, dir: string): string {
  const at = (f: string) => (dir ? `${dir}/${f}` : f);
  const ng = readSourceJson<Json>(sourceDir, at('ng-package.json'));
  const lib = isObject(ng?.['lib']) ? (ng?.['lib'] as Json) : {};
  if (typeof lib['entryFile'] === 'string') return path.posix.normalize(lib['entryFile'] as string);
  return (
    ['src/public-api.ts', 'src/public_api.ts'].find((f) => sourceExists(sourceDir, at(f))) ??
    'src/public-api.ts'
  );
}

export function libraryInfo(sourceDir: string, p: SourceProject): LibraryInfo {
  const targets = isObject(p.config['targets']) ? (p.config['targets'] as Json) : {};
  const options = isObject((targets['build'] as Json | undefined)?.['options'])
    ? ((targets['build'] as Json)['options'] as Json)
    : {};
  const at = (f: string) => (p.root ? `${p.root}/${f}` : f);
  const ngPackage =
    typeof options['project'] === 'string'
      ? path.posix.normalize(options['project'] as string)
      : sourceExists(sourceDir, at('ng-package.json'))
      ? at('ng-package.json')
      : undefined;
  const ng = ngPackage ? readSourceJson<Json>(sourceDir, ngPackage) : undefined;
  const lib = isObject(ng?.['lib']) ? (ng?.['lib'] as Json) : {};
  // ng-packagr's default is src/public_api.ts; Angular CLI generates src/public-api.ts.
  const entryFile =
    typeof lib['entryFile'] === 'string'
      ? (lib['entryFile'] as string)
      : ['src/public-api.ts', 'src/public_api.ts'].find((f) => sourceExists(sourceDir, at(f))) ??
        'src/public_api.ts';
  const outputs = new Set<string>([`dist/${p.name}`]);
  if (ngPackage && typeof ng?.['dest'] === 'string') {
    outputs.add(
      path.posix.normalize(path.posix.join(path.posix.dirname(ngPackage), ng['dest'] as string)),
    );
  }
  return {
    ngPackage,
    entryFile: path.posix.normalize(entryFile),
    outputs: [...outputs].sort(),
    secondaryEntry: (sub) => entryIn(sourceDir, p.root ? `${p.root}/${sub}` : sub),
  };
}
