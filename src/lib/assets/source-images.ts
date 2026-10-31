import * as path from 'path';

import type { Tree } from '@nx/devkit';

import { IMAGE_EXTS } from '../helpers/strip-exif';
import { ReadProject, scanProjects } from '../utils/project-json-files';

/**
 * The source images an app ships: the asset inputs of its build (Angular/Ionic `assets`, Flutter
 * `assets/`, the pubspec asset entries and `web/`), and assets libraries.
 */

const posix = path.posix;

/** A folder (or file) of images, workspace-relative, with the asset glob that picks files in it. */
export interface ImageSource {
  /** Project it belongs to; '' for --dir folders. */
  owner: string;
  path: string;
  glob?: string;
  ignore?: string[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'tmp',
  'coverage',
  '.git',
  '.nx',
  '.angular',
  '.dart_tool',
  'build',
]);

type Matcher = (file: string, pattern: string) => boolean;
let matcher: Matcher | null | undefined;

/** minimatch from the workspace's (or the plugin's) nx install. */
function loadMinimatch(root: string): Matcher | null {
  if (matcher !== undefined) return matcher;
  for (const from of [root, __dirname]) {
    try {
      const nxPkg = require.resolve('nx/package.json', { paths: [from] });
      const resolved = require.resolve('minimatch', { paths: [path.dirname(nxPkg)] });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(resolved);
      const fn = typeof mod === 'function' ? mod : mod.minimatch;
      if (typeof fn === 'function') {
        matcher = (file, pattern) => fn(file, pattern, { dot: true });
        return matcher;
      }
    } catch {
      // try the next install
    }
  }
  matcher = null;
  return matcher;
}

const normalize = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
const inWorkspace = (p: string) =>
  !p.startsWith('..') && !posix.isAbsolute(p) && !p.split('/').includes('node_modules');

/** Asset entries of a build target's options and configurations. */
function assetEntries(target: Json | undefined): unknown[] {
  if (!target) return [];
  const out: unknown[] = [];
  const opts = isObject(target['options']) ? target['options'] : {};
  if (Array.isArray(opts['assets'])) out.push(...opts['assets']);
  const confs = isObject(target['configurations']) ? target['configurations'] : {};
  for (const c of Object.values(confs)) {
    if (isObject(c) && Array.isArray(c['assets'])) out.push(...c['assets']);
  }
  return out;
}

/** The target the release builds (`buildTarget` of `release`), else `build`. */
function buildTargetOf(project: ReadProject): Json | undefined {
  const targets = isObject(project.json['targets']) ? project.json['targets'] : {};
  const release = targets['release'];
  const ref =
    isObject(release) && isObject(release['options'])
      ? release['options']['buildTarget']
      : undefined;
  if (typeof ref === 'string') {
    const [, name] = ref.split(':');
    if (name && isObject(targets[name])) return targets[name] as Json;
  }
  return isObject(targets['build']) ? (targets['build'] as Json) : undefined;
}

/** `flutter: assets:` entries of a pubspec.yaml (strings, or `- path: x` maps). */
export function pubspecAssets(text: string): string[] {
  const out: string[] = [];
  let inFlutter = false;
  let assetsIndent = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inFlutter = /^flutter:\s*$/.test(line);
      assetsIndent = -1;
      continue;
    }
    if (!inFlutter) continue;
    if (assetsIndent < 0) {
      if (/^\s+assets:\s*$/.test(line)) assetsIndent = indent;
      continue;
    }
    if (indent <= assetsIndent) {
      assetsIndent = /^\s+assets:\s*$/.test(line) ? indent : -1;
      continue;
    }
    const m = /^\s*-\s*(?:path:\s*)?(['"]?)([^'"]+)\1\s*$/.exec(line);
    if (m) out.push(m[2].trim());
  }
  return out;
}

/** The image sources of one project. */
export function projectImageSources(tree: Tree, project: ReadProject): ImageSource[] {
  const owner = project.name;
  const root = project.root === '.' ? '' : project.root;
  const at = (p: string) => normalize(root ? `${root}/${p}` : p);
  const sources: ImageSource[] = [];
  const tags = Array.isArray(project.json['tags']) ? (project.json['tags'] as string[]) : [];
  if (tags.includes('type:assets')) {
    const sourceRoot = project.json['sourceRoot'];
    sources.push({
      owner,
      path: normalize(typeof sourceRoot === 'string' ? sourceRoot : root || '.'),
    });
    return sources;
  }
  if (tree.exists(at('pubspec.yaml'))) {
    if (tree.exists(at('assets'))) sources.push({ owner, path: at('assets') });
    for (const a of pubspecAssets(tree.read(at('pubspec.yaml'), 'utf8') ?? '')) {
      sources.push({ owner, path: at(a.replace(/\/$/, '')) });
    }
    const targets = isObject(project.json['targets']) ? project.json['targets'] : {};
    const web = Object.entries(targets).some(
      ([name, t]) =>
        name === 'build-web' ||
        (isObject(t) && isObject(t['options']) && t['options']['target'] === 'web'),
    );
    if (web && tree.exists(at('web'))) sources.push({ owner, path: at('web') });
    return sources;
  }
  for (const entry of assetEntries(buildTargetOf(project))) {
    if (typeof entry === 'string') {
      const p = normalize(entry);
      if (inWorkspace(p)) sources.push({ owner, path: p });
    } else if (isObject(entry) && typeof entry['input'] === 'string') {
      const p = normalize(entry['input'] as string);
      if (!inWorkspace(p)) continue;
      sources.push({
        owner,
        path: p,
        glob: typeof entry['glob'] === 'string' ? entry['glob'] : undefined,
        ignore: Array.isArray(entry['ignore']) ? (entry['ignore'] as string[]) : undefined,
      });
    }
  }
  return sources;
}

/** Projects whose images `--all` covers: apps and assets libraries. */
function coveredByAll(project: ReadProject): boolean {
  const tags = Array.isArray(project.json['tags']) ? (project.json['tags'] as string[]) : [];
  return project.json['projectType'] === 'application' || tags.includes('type:assets');
}

export interface SourceSelection {
  apps?: string[];
  all?: boolean;
  dirs?: string[];
}

/**
 * The image sources a selection names: `apps` (their sources), `all` (every app and assets lib),
 * `dirs` (extra folders). Throws for an unknown app or a folder that does not exist.
 */
export function selectImageSources(tree: Tree, sel: SourceSelection): ImageSource[] {
  const projects = scanProjects(tree);
  const sources: ImageSource[] = [];
  if (sel.all) {
    for (const p of projects.filter(coveredByAll)) sources.push(...projectImageSources(tree, p));
  }
  for (const app of sel.apps ?? []) {
    const p = projects.find((x) => x.name === app);
    if (!p) throw new Error(`no project named "${app}"`);
    sources.push(...projectImageSources(tree, p));
  }
  for (const d of sel.dirs ?? []) {
    const p = normalize(d);
    if (!tree.exists(p)) throw new Error(`${d} does not exist`);
    sources.push({ owner: '', path: p });
  }
  return sources;
}

function walk(tree: Tree, dir: string, out: string[], depth = 0): void {
  if (depth > 20) return;
  for (const name of tree.children(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (tree.isFile(rel)) out.push(rel);
    else walk(tree, rel, out, depth + 1);
  }
}

/** The image files (workspace-relative, sorted, each once) of the sources. */
export function imageFiles(tree: Tree, sources: ImageSource[]): string[] {
  const files = new Set<string>();
  const match = loadMinimatch(tree.root);
  for (const s of sources) {
    if (!tree.exists(s.path)) continue;
    const found: string[] = [];
    if (tree.isFile(s.path)) found.push(s.path);
    else walk(tree, s.path === '.' ? '' : s.path, found);
    for (const f of found) {
      if (!IMAGE_EXTS.has(posix.extname(f).toLowerCase())) continue;
      if (match && (s.glob || s.ignore)) {
        const rel = s.path === '.' ? f : posix.relative(s.path, f);
        if (s.glob && !match(rel, s.glob)) continue;
        if (s.ignore?.some((i) => match(rel, i))) continue;
      }
      files.add(f);
    }
  }
  return [...files].sort();
}
