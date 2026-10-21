import * as path from 'path';

import type { TsPathClash } from './adapters/types';
import { mapPath, PathMapper } from './angular-project-json';
import { upTo } from './names';

/**
 * tsconfig and ESLint config rewrites for a migrated Angular app, as pure functions.
 * File paths are POSIX and relative to the source repo root (inputs) or the Nx workspace
 * root (outputs).
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** "./x" style relative path from directory `fromDir` to `to` (both workspace-relative). */
function relativeFrom(fromDir: string, to: string): string {
  const r = path.posix.relative(fromDir, to);
  return r.startsWith('.') ? r : `./${r}`;
}

/** compilerOptions the app tsconfig drops: the workspace base owns them. */
const DROPPED_COMPILER_OPTIONS = ['baseUrl', 'paths', 'outDir'];

/**
 * The source root tsconfig.json → apps/<name>/tsconfig.json: extends the workspace base,
 * keeps everything else except baseUrl, paths and outDir.
 */
export function appRootTsconfig(source: Json, m: PathMapper): Json {
  // Its relative paths were relative to the source repo root; now to apps/<name>.
  const local: PathMapper = { ...m, warnings: [] };
  const rebase = (p: unknown) =>
    typeof p === 'string' ? relativeFrom(m.projectRoot, mapPath(p, local)) : p;
  const out: Json = { extends: `${upTo(m.projectRoot)}tsconfig.base.json` };
  for (const [k, v] of Object.entries(source)) {
    if (k === 'extends') continue;
    if (k === 'compilerOptions' && isObject(v)) {
      const co: Json = {};
      for (const [o, ov] of Object.entries(v)) {
        if (DROPPED_COMPILER_OPTIONS.includes(o)) continue;
        co[o] =
          o === 'typeRoots' && Array.isArray(ov)
            ? ov.filter((t) => !isNodeModulesTypes(t)).map(rebase)
            : ov;
      }
      // A root tsconfig without moduleResolution got TypeScript's default for its module
      // (`preserve` → bundler, as Angular 20+ `ng new` writes it). Extending tsconfig.base.json
      // would replace that default with the base's (often "node"), which breaks the build.
      if (
        source['extends'] === undefined &&
        co['moduleResolution'] === undefined &&
        String(co['module'] ?? '').toLowerCase() === 'preserve'
      ) {
        co['moduleResolution'] = 'bundler';
      }
      out[k] = co;
    } else if ((k === 'include' || k === 'files' || k === 'exclude') && Array.isArray(v)) {
      out[k] = v.map(rebase);
    } else if (k === 'references' && Array.isArray(v)) {
      out[k] = v.map((r) => (isObject(r) ? { ...r, path: rebase(r['path']) } : r));
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** "node_modules/@types" (any spelling): it does not move with the app. */
function isNodeModulesTypes(p: unknown): boolean {
  return (
    typeof p === 'string' &&
    path.posix.normalize(p.replace(/\\/g, '/')).replace(/\/$/, '') === 'node_modules/@types'
  );
}

export interface ProjectTsconfigInput {
  /** The file's path in the source repo, e.g. "tsconfig.app.json" or "projects/x/tsconfig.app.json". */
  sourceFile: string;
  /** The source project root ("" for `ng new`). */
  sourceRoot: string;
  /** apps/<name> */
  projectRoot: string;
}

/**
 * Fixes `extends` and `outDir` of a project tsconfig (tsconfig.app.json, tsconfig.spec.json, …)
 * for its new location. `extends` pointing at the source root tsconfig.json now points at
 * apps/<name>/tsconfig.json; `outDir` becomes <workspace>/dist/out-tsc.
 */
export function fixProjectTsconfig(
  config: Json,
  input: ProjectTsconfigInput,
): { config: Json; warnings: string[] } {
  const warnings: string[] = [];
  const out: Json = { ...config };
  const rel = input.sourceRoot
    ? path.posix.relative(input.sourceRoot, input.sourceFile)
    : input.sourceFile;
  const newFile = `${input.projectRoot}/${rel}`;
  const newDir = path.posix.dirname(newFile);

  const ext = config['extends'];
  if (typeof ext === 'string' && (ext.startsWith('./') || ext.startsWith('../'))) {
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(input.sourceFile), ext),
    );
    const insideProject =
      input.sourceRoot === ''
        ? !resolved.startsWith('../')
        : resolved.startsWith(`${input.sourceRoot}/`);
    if (resolved === 'tsconfig.json') {
      out['extends'] = relativeFrom(newDir, `${input.projectRoot}/tsconfig.json`);
    } else if (!insideProject) {
      warnings.push(`${input.sourceFile}: extends "${ext}" is outside the project; left unchanged`);
    }
  }

  const co = config['compilerOptions'];
  if (isObject(co) && typeof co['outDir'] === 'string') {
    out['compilerOptions'] = { ...co, outDir: relativeFrom(newDir, 'dist/out-tsc') };
  }
  return { config: out, warnings };
}

export interface TsPathsMerge {
  /** The merged paths for tsconfig.base.json. */
  paths: Record<string, string[]>;
  added: string[];
  clashes: TsPathClash[];
}

/**
 * Merges the source tsconfig `paths` into the workspace's. Source targets are relative to the
 * source baseUrl; they are mapped to workspace-root paths. Existing aliases are never
 * overwritten; an alias mapped to different targets is a clash.
 */
export function mergeTsPaths(
  workspace: Record<string, string[]>,
  source: Record<string, unknown>,
  sourceBaseUrl: string,
  m: PathMapper,
): TsPathsMerge {
  const paths: Record<string, string[]> = { ...workspace };
  const added: string[] = [];
  const clashes: TsPathClash[] = [];
  for (const [alias, targets] of Object.entries(source)) {
    const list = (Array.isArray(targets) ? targets : [targets]).filter(
      (t): t is string => typeof t === 'string',
    );
    const mapped = list.map((t) => mapPath(path.posix.join(sourceBaseUrl || '.', t), m));
    const existing = paths[alias];
    if (existing === undefined) {
      paths[alias] = mapped;
      added.push(alias);
    } else if (JSON.stringify(existing) !== JSON.stringify(mapped)) {
      clashes.push({ alias, workspace: existing, source: mapped });
    }
  }
  return { paths, added, clashes };
}

/**
 * A copied source .eslintrc.json made to extend the workspace root config: no `root`, the root
 * config first in `extends`, "!**\/*" un-ignoring the app's files (the root ignores everything),
 * and parserOptions.project paths mapped to the workspace root.
 */
export function extendRootEslintConfig(config: Json, m: PathMapper): Json {
  const rest = Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'root'));
  const out: Json = {};
  const ext = rest['extends'];
  const extendsList = Array.isArray(ext) ? [...ext] : typeof ext === 'string' ? [ext] : [];
  const rootConfig = `${upTo(m.projectRoot)}.eslintrc.json`;
  out['extends'] = [
    rootConfig,
    ...extendsList.filter((e) => e !== rootConfig && e !== '../../.eslintrc.json'),
  ];
  const ignore = Array.isArray(rest['ignorePatterns']) ? (rest['ignorePatterns'] as unknown[]) : [];
  out['ignorePatterns'] = ['!**/*', ...ignore.filter((p) => p !== '!**/*')];
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'extends' || k === 'ignorePatterns') continue;
    out[k] = k === 'overrides' && Array.isArray(v) ? v.map((o) => mapParserProject(o, m)) : v;
  }
  if (isObject(rest['parserOptions']))
    out['parserOptions'] = mapParserProject({ parserOptions: rest['parserOptions'] }, m)[
      'parserOptions'
    ];
  return out;
}

function mapParserProject(override: unknown, m: PathMapper): unknown {
  if (!isObject(override) || !isObject(override['parserOptions'])) return override;
  const po = override['parserOptions'];
  const project = po['project'];
  const mapOne = (p: unknown) => (typeof p === 'string' ? mapPath(p, m) : p);
  if (project === undefined) return override;
  return {
    ...override,
    parserOptions: {
      ...po,
      project: Array.isArray(project) ? project.map(mapOne) : mapOne(project),
    },
  };
}
