import * as fs from 'fs';
import * as path from 'path';

import { Tree } from '@nx/devkit';

import { isSourceFile, readSourceJson } from '../source';

/**
 * Import rewriting after a migration: the copied code still imports with the paths it had in the
 * source. Relative imports that reach into another project that moved, imports through the
 * source tsconfig `baseUrl`, and `@nrwl/*` packages are rewritten in the copies (never in the
 * source); what cannot be resolved is listed.
 */

/** One copied folder: where it came from, where it went, and its files. */
export interface ImportMove {
  /** Absolute source folder (OS separators). */
  from: string;
  /** Folder in the workspace tree. */
  to: string;
  /** Copied files, relative to the folder. */
  files: string[];
}

export type RewriteKind =
  | 'cross-project'
  | 'base-url'
  | 'nrwl'
  | 'node-modules'
  /** Angular templateUrl / styleUrl / styleUrls (NX-60). */
  | 'resource'
  /** A bare Sass path that resolved through the source load paths (NX-61). */
  | 'sass-load-path';

export interface ImportRewrite {
  /** File in the workspace tree. */
  file: string;
  kind: RewriteKind;
  before: string;
  after: string;
}

export interface UnresolvedImport {
  file: string;
  spec: string;
  why: string;
}

export interface ImportRewriteResult {
  rewritten: ImportRewrite[];
  unresolved: UnresolvedImport[];
  /** Files that import another project's file below its entry (a relative path was kept). */
  deepImports: { file: string; spec: string }[];
  /** `@nx/*` packages the rewritten imports use that the workspace package.json does not declare. */
  missingPackages: string[];
  /**
   * `--config` batches (NX-62): imports of earlier entries that pointed into a project this entry
   * brought in, rewritten after this entry's copy (they are part of this entry's rollback).
   */
  resolvedEarlier?: ImportRewrite[];
}

/** Reasons an import is listed that a later `--config` entry's copy can make resolvable (NX-62). */
export const LATER_RESOLVABLE = new Set([
  'points outside the imported projects',
  'resolves through the source `baseUrl` to a file that was not imported',
  'resolves through the source Sass load paths to a file that was not imported',
]);

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SCSS = /\.scss$/;

/**
 * Module specifiers in TS/JS: from, import(), side-effect imports, require(), require.resolve(),
 * and the jest / vitest module mocks.
 */
const CODE_IMPORT =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire(?:\.resolve)?\s*\(\s*|\b(?:jest|vi)\.(?:mock|unmock|doMock|requireActual|requireMock|importActual|importMock|createMockFromModule)\s*\(\s*)(['"])([^'"\n]+)\2/g;
/** Sass module rules; each quoted path in them is a candidate. */
const SCSS_RULE = /@(?:use|import|forward)\s+[^;{}]+/g;
const QUOTED = /(['"])([^'"\n]+)\1/g;
/** Angular component resources: templateUrl / styleUrl values and styleUrls entries (NX-60). */
const RESOURCE_URL = /(\b(?:templateUrl|styleUrl)\s*:\s*)(['"`])([^'"`\n]+)\2/g;
const RESOURCE_LIST = /(\bstyleUrls\s*:\s*\[)([^\]]*)\]/g;
/** Sass paths that are never files under a load path: built-ins, URLs, plain CSS imports. */
const SASS_NOT_BARE = /^(?:~|\/|sass:|[a-z][a-z0-9+.-]*:|\/\/)|\.css$/i;

/** @nrwl/* packages without an @nx/* successor. */
const NRWL_KEEP = new Set(['@nrwl/nx-cloud', '@nrwl/tao', '@nrwl/cli']);
/** @nrwl/* packages whose @nx/* successor has another name. */
const NRWL_RENAMED: Record<string, string> = { 'nx-plugin': 'plugin' };

const toPosix = (p: string) => p.split(path.sep).join('/');
const isRelative = (s: string) => s === '.' || s === '..' || /^\.\.?\//.test(s);
/** How a module specifier can resolve to a file (a folder only through its index). */
const CODE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '/index.ts',
  '/index.tsx',
  '/index.d.ts',
  '/index.js',
  '/index.jsx',
  '/index.mjs',
  '/package.json',
];

/** ESM-style TypeScript imports name the emitted `.js` file: `./greet.js` for `greet.ts`. */
const JS_EXT = /\.(js|jsx|mjs|cjs)$/;
const TS_FOR_JS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts'];

function codeCandidates(p: string): string[] {
  const out = CODE_SUFFIXES.map((s) => p + s);
  if (JS_EXT.test(p)) {
    const bare = p.replace(JS_EXT, '');
    out.push(...TS_FOR_JS.map((s) => bare + s));
  }
  return out;
}

/** Files a Sass path can name: as is, with an extension, a partial, or a folder index. */
function sassCandidates(p: string): string[] {
  const dir = path.posix.dirname(p);
  const base = path.posix.basename(p);
  const partial = (ext: string) => `${dir}/_${base}${ext}`;
  return [
    p,
    `${p}.scss`,
    `${p}.sass`,
    `${p}.css`,
    partial('.scss'),
    partial('.sass'),
    `${p}/_index.scss`,
    `${p}/index.scss`,
  ];
}

/** What a specifier names: a module, a Sass path, or an exact file (Angular resources). */
type Mode = 'code' | 'sass' | 'resource';

const candidates = (p: string, mode: Mode) =>
  mode === 'sass' ? sassCandidates(p) : mode === 'resource' ? [p] : codeCandidates(p);

interface Tsconfig {
  compilerOptions?: { baseUrl?: unknown; paths?: Record<string, unknown> };
  extends?: unknown;
}

/** The source tsconfig `baseUrl` (absolute, posix) and `paths` keys a file sees. */
interface BaseUrlInfo {
  baseUrl?: string;
  pathKeys: string[];
}

export interface RewriteOptions {
  /** Absolute source repo root. */
  sourceDir: string;
  /** The folders this run copied: only their files are rewritten. */
  moves: ImportMove[];
  /** Folders other `--config` entries copied: imports may resolve into them (NX-62). */
  otherMoves?: ImportMove[];
  /** Only these imports (`file\0spec`) are looked at; everything else is left alone (NX-62). */
  only?: Set<string>;
}

export function rewriteImports(tree: Tree, opts: RewriteOptions): ImportRewriteResult {
  const result: ImportRewriteResult = {
    rewritten: [],
    unresolved: [],
    deepImports: [],
    missingPackages: [],
  };
  const seen = new Set<string>();
  const deepSeen = new Set<string>();
  const sourceRoot = toPosix(path.resolve(opts.sourceDir));
  const norm = (list: ImportMove[]) =>
    list
      .map((m) => ({ ...m, from: toPosix(path.resolve(m.from)) }))
      .sort((a, b) => b.from.length - a.from.length);
  const moves = norm(opts.moves);
  const known = norm([...opts.moves, ...(opts.otherMoves ?? [])]);
  const only = opts.only;
  const moveOf = (abs: string) => known.find((m) => abs === m.from || abs.startsWith(`${m.from}/`));
  const mapPath = (abs: string): string | undefined => {
    const m = moveOf(abs);
    if (!m) return undefined;
    const rest = abs.slice(m.from.length);
    return path.posix.normalize(`${m.to}${rest}`).replace(/\/$/, '');
  };

  const wsBaseUrl = workspaceBaseUrl(tree);
  const aliases = workspaceAliases(tree, wsBaseUrl);
  const baseUrls = baseUrlReader(sourceRoot);
  /** The tree path resolves to a file (copied, or already in the workspace). */
  const inTree = (p: string, mode: Mode) =>
    candidates(p, mode).some((c) => tree.exists(c) && tree.isFile(c));
  const statCache = new Map<string, boolean>();
  const isSourceFileAbs = (abs: string) => {
    let hit = statCache.get(abs);
    if (hit === undefined) {
      hit = fs.statSync(abs, { throwIfNoEntry: false })?.isFile() ?? false;
      statCache.set(abs, hit);
    }
    return hit;
  };
  const dependencyNames = sourceDependencyNames(sourceRoot);
  const nxPackages = new Set<string>();
  const sourceLoadPaths = sourceSassLoadPaths(sourceRoot, moves);
  const workspaceLoadPaths = workspaceSassLoadPaths(tree);

  // Sass load paths in the moved projects that do not exist in the workspace (NX-61).
  for (const move of only ? [] : moves) {
    const pj = `${move.to}/project.json`;
    for (const p of projectLoadPaths(tree, pj)) {
      if (p === 'node_modules' || p.startsWith('node_modules/')) continue;
      if (!tree.exists(p)) leave(pj, p, 'Sass load path that does not exist in the workspace');
    }
  }

  for (const move of moves) {
    for (const rel of move.files) {
      const code = CODE.test(rel) && !rel.endsWith('.d.ts');
      const scss = SCSS.test(rel);
      if (!code && !scss) continue;
      const file = `${move.to}/${rel}`;
      const text = tree.read(file, 'utf8');
      if (text === null) continue;
      const sourceFile = `${move.from}/${rel}`;
      const sourceDirOfFile = path.posix.dirname(sourceFile);
      const treeDirOfFile = path.posix.dirname(file);

      const relativeTo = (target: string) => {
        let r = path.posix.relative(treeDirOfFile, target);
        if (!r.startsWith('.')) r = `./${r}`;
        return r;
      };
      const viaAlias = (target: string) =>
        aliases.get(target) ?? aliases.get(target.replace(/\.(ts|tsx|js|mjs|cjs)$/, ''));

      /** New specifier for `spec`, or undefined to keep it. */
      const rewrite = (spec: string, mode: Mode): string | undefined => {
        if (only && !only.has(`${file}\0${spec}`)) return undefined;
        const sass = mode !== 'code';
        if (!sass) {
          const nrwl = /^@nrwl\/([^/]+)(.*)$/.exec(spec);
          if (nrwl) {
            if (NRWL_KEEP.has(`@nrwl/${nrwl[1]}`)) {
              leave(file, spec, 'no `@nx/*` successor; replace it by hand');
              return undefined;
            }
            const pkg = `@nx/${NRWL_RENAMED[nrwl[1]] ?? nrwl[1]}`;
            nxPackages.add(pkg);
            return record(file, 'nrwl', spec, `${pkg}${nrwl[2]}`);
          }
        }
        if (isRelative(spec)) {
          // A ?query or #hash (`./tpl.html?raw`) is kept as it is.
          const cut = spec.search(/[?#]/);
          const bareSpec = cut < 0 ? spec : spec.slice(0, cut);
          const tail = cut < 0 ? '' : spec.slice(cut);
          const abs = path.posix.normalize(`${sourceDirOfFile}/${bareSpec}`).replace(/\/$/, '');
          const trailing = bareSpec.endsWith('/') ? '/' : '';
          const asIs = path.posix.normalize(`${treeDirOfFile}/${bareSpec}`).replace(/\/$/, '');
          // The source's root node_modules is the workspace's root node_modules.
          if (abs.startsWith(`${sourceRoot}/node_modules/`)) {
            const target = abs.slice(sourceRoot.length + 1);
            const kept = relativeTo(target) + trailing + tail;
            return kept === spec ? undefined : record(file, 'node-modules', spec, kept);
          }
          // Inside the same copied folder the path is unchanged. Only a file that exists in the
          // source but was not copied (a project that was not selected, a skipped folder) is a
          // problem; text that resolves nowhere (a comment, a generated file) is left alone.
          if (moveOf(abs)?.to === move.to) {
            const copied = inTree(mapPath(abs) as string, mode);
            if (!copied && candidates(abs, mode).some((c) => isSourceFileAbs(c))) {
              leave(file, spec, 'points to a file that was not copied');
            }
            return undefined;
          }
          const target = mapPath(abs);
          if (target === undefined || !inTree(target, mode)) {
            // Still resolves in the workspace (an Nx root file such as jest.preset.js): keep it.
            if (inTree(asIs, mode)) return undefined;
            leave(
              file,
              spec,
              target === undefined
                ? 'points outside the imported projects'
                : 'points to a file that was not copied',
            );
            return undefined;
          }
          const kept = relativeTo(target) + trailing + tail;
          if (kept === spec) return undefined;
          const alias = sass || tail ? undefined : viaAlias(target);
          if (alias) return record(file, 'cross-project', spec, alias);
          if (!sass && !deepSeen.has(`${file}\0${kept}`)) {
            deepSeen.add(`${file}\0${kept}`);
            result.deepImports.push({ file, spec: kept });
          }
          return record(file, mode === 'resource' ? 'resource' : 'cross-project', spec, kept);
        }
        if (sass || spec.startsWith('~')) return undefined;
        const info = baseUrls(sourceDirOfFile);
        if (!info.baseUrl || matchesPathKey(spec, info.pathKeys)) return undefined;
        const abs = path.posix.normalize(`${info.baseUrl}/${spec}`).replace(/\/$/, '');
        if (!abs.startsWith(`${sourceRoot}/`)) return undefined;
        // A file, or a folder with an index; a bare folder (cypress/) is not a module.
        const local = codeCandidates(abs).some((c) => isSourceFileAbs(c));
        if (dependencyNames.has(packageOf(spec))) {
          if (local) {
            leave(
              file,
              spec,
              'names both a dependency and a file under the source `baseUrl`; check which one it means',
            );
          }
          return undefined;
        }
        if (!local) return undefined;
        const target = mapPath(abs);
        if (target === undefined || !inTree(target, 'code')) {
          leave(
            file,
            spec,
            'resolves through the source `baseUrl` to a file that was not imported',
          );
          return undefined;
        }
        if (wsBaseUrl !== undefined && path.posix.normalize(`${wsBaseUrl}/${spec}`) === target) {
          return undefined; // still resolves through the workspace baseUrl
        }
        const alias = moveOf(abs)?.to === move.to ? undefined : viaAlias(target);
        return record(file, 'base-url', spec, alias ?? relativeTo(target));
      };

      /**
       * A bare Sass path, resolved like Sass: from the stylesheet's folder, then through the
       * source load paths (NX-61). Kept when it still resolves to the same file in the workspace.
       */
      const rewriteBare = (spec: string): string | undefined => {
        if (only && !only.has(`${file}\0${spec}`)) return undefined;
        const exists = (abs: string) => sassCandidates(abs).some((c) => isSourceFileAbs(c));
        const own = path.posix.normalize(`${sourceDirOfFile}/${spec}`);
        let abs: string | undefined;
        let viaLoadPath = false;
        if (exists(own)) abs = own;
        else {
          for (const dir of sourceLoadPaths(sourceFile)) {
            const candidate = path.posix.normalize(`${dir}/${spec}`);
            if (exists(candidate)) {
              abs = candidate;
              viaLoadPath = true;
              break;
            }
          }
        }
        if (abs === undefined) return undefined;
        // The source's node_modules is the workspace's (a common `includePaths: ["node_modules"]`).
        if (abs.startsWith(`${sourceRoot}/node_modules/`)) return undefined;
        if (!viaLoadPath && moveOf(abs)?.to === move.to) return undefined;
        const target = mapPath(abs);
        if (target === undefined || !inTree(target, 'sass')) {
          leave(
            file,
            spec,
            viaLoadPath
              ? 'resolves through the source Sass load paths to a file that was not imported'
              : 'points to a file that was not copied',
          );
          return undefined;
        }
        const loadPaths = workspaceLoadPaths(treeDirOfFile);
        // Sass takes the first folder where the path exists.
        const first = [treeDirOfFile, ...loadPaths]
          .map((dir) => path.posix.normalize(`${dir}/${spec}`))
          .find((there) => inTree(there, 'sass'));
        if (first === target) return undefined;
        return record(file, 'sass-load-path', spec, relativeTo(target));
      };

      let next = text;
      if (code) {
        next = next.replace(CODE_IMPORT, (whole, lead: string, q: string, spec: string) => {
          const r = rewrite(spec, 'code');
          return r === undefined ? whole : `${lead}${q}${r}${q}`;
        });
        const resource = (whole: string, q: string, spec: string) => {
          if (!isRelative(spec)) return whole;
          const r = rewrite(spec, 'resource');
          return r === undefined ? whole : `${q}${r}${q}`;
        };
        next = next.replace(
          RESOURCE_URL,
          (whole, lead: string, q: string, spec: string) =>
            `${lead}${resource(`${q}${spec}${q}`, q, spec)}`,
        );
        next = next.replace(
          RESOURCE_LIST,
          (whole, lead: string, list: string) =>
            `${lead}${list.replace(QUOTED, (w, q: string, spec: string) => resource(w, q, spec))}]`,
        );
      } else {
        next = next.replace(SCSS_RULE, (whole) => {
          // Only the URL list: `with (...)` values, `as`, `show` and `hide` are not paths.
          const end = whole.search(/\s(?:with|as|show|hide)\b/);
          const rule = end < 0 ? whole : whole.slice(0, end);
          const rest = end < 0 ? '' : whole.slice(end);
          return `${rule.replace(QUOTED, (whole, q: string, spec: string) => {
            if (isRelative(spec)) {
              const r = rewrite(spec, 'sass');
              return r === undefined ? whole : `${q}${r}${q}`;
            }
            if (SASS_NOT_BARE.test(spec) || /url\(\s*$/.test(rule.slice(0, rule.indexOf(whole))))
              return whole;
            const r = rewriteBare(spec);
            return r === undefined ? whole : `${q}${r}${q}`;
          })}${rest}`;
        });
      }
      if (next !== text) tree.write(file, next);
    }
  }
  if (nxPackages.size > 0) {
    const declared = treeDependencyNames(tree);
    result.missingPackages = [...nxPackages].filter((p) => !declared.has(p)).sort();
  }
  return result;

  function record(file: string, kind: RewriteKind, before: string, after: string): string {
    const key = `${file}\0${before}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.rewritten.push({ file, kind, before, after });
    }
    return after;
  }

  function leave(file: string, spec: string, why: string): void {
    const key = `${file}\0${spec}\0left`;
    if (seen.has(key)) return;
    seen.add(key);
    result.unresolved.push({ file, spec, why });
  }
}

/** The package a bare specifier names: "@scope/name" or "name". */
function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Dependencies declared in the source root package.json (any field). */
function sourceDependencyNames(sourceRoot: string): Set<string> {
  const pkg = readSourceJson<Record<string, unknown>>(sourceRoot, 'package.json') ?? {};
  const out = new Set<string>();
  for (const f of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const v = pkg[f];
    if (v && typeof v === 'object') for (const k of Object.keys(v)) out.add(k);
  }
  return out;
}

function treeDependencyNames(tree: Tree): Set<string> {
  const out = new Set<string>();
  if (!tree.exists('package.json')) return out;
  try {
    const pkg = JSON.parse(tree.read('package.json', 'utf8') ?? '{}') as Record<string, unknown>;
    for (const f of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const v = pkg[f];
      if (v && typeof v === 'object') for (const k of Object.keys(v)) out.add(k);
    }
  } catch {
    // An unreadable package.json lists nothing.
  }
  return out;
}

function matchesPathKey(spec: string, keys: string[]): boolean {
  return keys.some((k) =>
    k.endsWith('*') ? spec.startsWith(k.slice(0, -1)) : spec === k || spec.startsWith(`${k}/`),
  );
}

/** Workspace aliases with one file target: target (with and without extension, index folder) → alias. */
function workspaceAliases(tree: Tree, baseUrl: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!tree.exists('tsconfig.base.json')) return out;
  let json: Tsconfig;
  try {
    json = JSON.parse(tree.read('tsconfig.base.json', 'utf8') ?? '{}') as Tsconfig;
  } catch {
    return out;
  }
  for (const [alias, targets] of Object.entries(json.compilerOptions?.paths ?? {})) {
    if (alias.includes('*') || !Array.isArray(targets) || targets.length !== 1) continue;
    const t = path.posix.normalize(`${baseUrl ?? '.'}/${String(targets[0])}`);
    const bare = t.replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
    for (const key of [t, bare, bare.endsWith('/index') ? bare.slice(0, -6) : undefined]) {
      if (key && !out.has(key)) out.set(key, alias);
    }
  }
  return out;
}

function workspaceBaseUrl(tree: Tree): string | undefined {
  if (!tree.exists('tsconfig.base.json')) return undefined;
  try {
    const json = JSON.parse(tree.read('tsconfig.base.json', 'utf8') ?? '{}') as Tsconfig;
    const b = json.compilerOptions?.baseUrl;
    return typeof b === 'string' ? path.posix.normalize(b.replace(/^\.\/?/, '') || '.') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For a source folder: the nearest tsconfig.json (or the root tsconfig.base.json) with a
 * `baseUrl`, following relative `extends`. Cached per folder.
 */
function baseUrlReader(sourceRoot: string): (dir: string) => BaseUrlInfo {
  const cache = new Map<string, BaseUrlInfo>();
  const fromConfig = (file: string, depth = 0): BaseUrlInfo | undefined => {
    const dir = path.posix.dirname(file);
    const json = readSourceJson<Tsconfig>(dir, path.posix.basename(file));
    if (!json) return undefined;
    const keys = Object.keys(json.compilerOptions?.paths ?? {});
    const b = json.compilerOptions?.baseUrl;
    if (typeof b === 'string') {
      return { baseUrl: path.posix.normalize(`${dir}/${b}`).replace(/\/$/, ''), pathKeys: keys };
    }
    const ext = json.extends;
    if (typeof ext === 'string' && isRelative(ext) && depth < 5) {
      const target = path.posix.normalize(`${dir}/${ext.endsWith('.json') ? ext : `${ext}.json`}`);
      const inner = fromConfig(target, depth + 1);
      if (inner) return { baseUrl: inner.baseUrl, pathKeys: [...keys, ...inner.pathKeys] };
    }
    return keys.length > 0 ? { pathKeys: keys } : undefined;
  };
  const lookup = (dir: string): BaseUrlInfo => {
    const hit = cache.get(dir);
    if (hit) return hit;
    let info: BaseUrlInfo | undefined;
    const own = isSourceFile(dir, 'tsconfig.json') ? fromConfig(`${dir}/tsconfig.json`) : undefined;
    if (own?.baseUrl) info = own;
    else if (dir === sourceRoot || !dir.startsWith(`${sourceRoot}/`)) {
      const base = isSourceFile(dir, 'tsconfig.base.json')
        ? fromConfig(`${dir}/tsconfig.base.json`)
        : undefined;
      info = base?.baseUrl
        ? base
        : { pathKeys: [...(own?.pathKeys ?? []), ...(base?.pathKeys ?? [])] };
    } else {
      const parent = lookup(path.posix.dirname(dir));
      info = { baseUrl: parent.baseUrl, pathKeys: [...(own?.pathKeys ?? []), ...parent.pathKeys] };
    }
    cache.set(dir, info);
    return info;
  };
  return lookup;
}

type Json = Record<string, unknown>;

/** stylePreprocessorOptions.includePaths of every target (options and configurations). */
function includePathsOf(targets: unknown): string[] {
  const out: string[] = [];
  if (!targets || typeof targets !== 'object') return out;
  for (const target of Object.values(targets as Json)) {
    if (!target || typeof target !== 'object') continue;
    const t = target as Json;
    const blocks = [
      t['options'],
      ...Object.values((t['configurations'] as Json | undefined) ?? {}),
    ];
    for (const block of blocks) {
      const spo = (block as Json | undefined)?.['stylePreprocessorOptions'] as Json | undefined;
      const list = spo?.['includePaths'];
      if (Array.isArray(list)) for (const p of list) if (typeof p === 'string') out.push(p);
    }
  }
  return out;
}

/**
 * Source Sass load paths per stylesheet (NX-61): the includePaths of the source project that owns
 * the file — the angular.json project with the longest root containing it, or the project.json at
 * a copied folder — resolved against the source root. Sass only uses the owning project's paths.
 */
function sourceSassLoadPaths(
  sourceRoot: string,
  moves: { from: string }[],
): (absFile: string) => string[] {
  const projects: { root: string; paths: string[] }[] = [];
  const abs = (p: string) => path.posix.normalize(`${sourceRoot}/${p}`).replace(/\/$/, '');
  const angular = readSourceJson<{ projects?: Json }>(sourceRoot, 'angular.json');
  for (const project of Object.values(angular?.projects ?? {})) {
    const p = project as Json | undefined;
    const root = typeof p?.['root'] === 'string' ? (p['root'] as string) : '';
    projects.push({
      root: root ? abs(root) : sourceRoot,
      paths: includePathsOf(p?.['architect'] ?? p?.['targets']).map(abs),
    });
  }
  for (const m of moves) {
    const pj = readSourceJson<{ targets?: Json }>(m.from, 'project.json');
    if (pj) projects.push({ root: m.from, paths: includePathsOf(pj.targets).map(abs) });
  }
  projects.sort((a, b) => b.root.length - a.root.length);
  return (absFile) => {
    const owner = projects.find((p) => absFile.startsWith(`${p.root}/`));
    return owner ? [...new Set(owner.paths)] : [];
  };
}

/** includePaths of one workspace project.json (workspace-relative, normalised). */
function projectLoadPaths(tree: Tree, projectJson: string): string[] {
  if (!tree.exists(projectJson)) return [];
  try {
    const json = JSON.parse(tree.read(projectJson, 'utf8') ?? '{}') as { targets?: Json };
    return [
      ...new Set(
        includePathsOf(json.targets).map((p) => path.posix.normalize(p).replace(/\/$/, '')),
      ),
    ];
  } catch {
    return [];
  }
}

/** For a workspace folder: the Sass load paths of the project that owns it (nearest project.json). */
function workspaceSassLoadPaths(tree: Tree): (dir: string) => string[] {
  const cache = new Map<string, string[]>();
  const lookup = (dir: string): string[] => {
    const hit = cache.get(dir);
    if (hit) return hit;
    let out: string[];
    if (tree.exists(`${dir}/project.json`)) out = projectLoadPaths(tree, `${dir}/project.json`);
    else if (dir === '.' || dir === '' || !dir.includes('/')) out = [];
    else out = lookup(path.posix.dirname(dir));
    cache.set(dir, out);
    return out;
  };
  return lookup;
}
