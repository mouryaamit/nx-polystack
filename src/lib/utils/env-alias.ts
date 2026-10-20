import * as path from 'path';

import { readJson, Tree, updateJson } from '@nx/devkit';

/**
 * Env files live in the root `environments/` folder, which is not part of any Nx project. From
 * Nx 18 on, `@nx/enforce-module-boundaries` refuses relative imports of files outside a project
 * ("External resources cannot be imported using a relative or absolute path"), so apps import
 * them through this tsconfig path alias instead: `@env/<app>/environment`.
 * Angular resolves the alias to the same file, so `fileReplacements` and the release build's env
 * encryption keep working unchanged.
 */
export const ENV_ALIAS = '@env/*';
export const ENV_ALIAS_TARGET = 'environments/*';
export const ENV_DIR = 'environments';

export type EnvAliasState = 'added' | 'present' | 'conflict' | 'no-tsconfig';

function tsconfigFile(tree: Tree): string | undefined {
  if (tree.exists('tsconfig.base.json')) return 'tsconfig.base.json';
  if (tree.exists('tsconfig.json')) return 'tsconfig.json';
  return undefined;
}

function readPaths(tree: Tree, file: string): Record<string, string[]> | undefined {
  try {
    return readJson(tree, file)?.compilerOptions?.paths;
  } catch {
    return undefined;
  }
}

/** Whether `@env/*` maps to `environments/*` (without changing anything). */
export function hasEnvAlias(tree: Tree): boolean {
  const file = tsconfigFile(tree);
  const target = file ? readPaths(tree, file)?.[ENV_ALIAS] : undefined;
  return Array.isArray(target) && target.length === 1 && target[0] === ENV_ALIAS_TARGET;
}

/**
 * Adds `"@env/*": ["environments/*"]` to tsconfig.base.json (or tsconfig.json). An `@env/*`
 * mapped elsewhere is left alone and reported as a conflict.
 */
export function ensureEnvAlias(tree: Tree): EnvAliasState {
  const file = tsconfigFile(tree);
  if (!file) return 'no-tsconfig';
  try {
    readJson(tree, file);
  } catch {
    return 'no-tsconfig';
  }
  if (readPaths(tree, file)?.[ENV_ALIAS]) return hasEnvAlias(tree) ? 'present' : 'conflict';
  updateJson(tree, file, (json: Record<string, unknown>) => {
    const opts = (json['compilerOptions'] ?? {}) as Record<string, unknown>;
    opts['paths'] = { ...((opts['paths'] as object) ?? {}), [ENV_ALIAS]: [ENV_ALIAS_TARGET] };
    json['compilerOptions'] = opts;
    return json;
  });
  return 'added';
}

/** The import specifier for a file under environments/ (path without extension). */
export function envAliasImport(underEnvironments: string): string {
  return `@env/${underEnvironments.replace(/^environments\//, '').replace(/\.ts$/, '')}`;
}

/** Import specifiers in TS source: `from '…'`, `import '…'`, `import('…')`, `require('…')`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\2/g;

/**
 * Rewrites the imports in `file` that point into environments/ (relative, or baseUrl-style
 * `environments/…`) to the `@env/…` alias. Files inside environments/ keep their own imports.
 * Returns the number of specifiers changed.
 */
export function rewriteEnvImports(tree: Tree, file: string): number {
  if (file === ENV_DIR || file.startsWith(`${ENV_DIR}/`)) return 0;
  const text = tree.read(file, 'utf8');
  if (text === null || !text.includes(ENV_DIR)) return 0;
  const dir = path.posix.dirname(file);
  let count = 0;
  const out = text.replace(SPECIFIER, (whole, lead: string, q: string, spec: string) => {
    let target: string | undefined;
    if (spec.startsWith('.')) target = path.posix.normalize(path.posix.join(dir, spec));
    else if (spec.startsWith(`${ENV_DIR}/`)) target = spec;
    if (!target || !target.startsWith(`${ENV_DIR}/`) || target === ENV_DIR) return whole;
    count++;
    return `${lead}${q}${envAliasImport(target)}${q}`;
  });
  if (count > 0) tree.write(file, out);
  return count;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'tmp',
  'coverage',
  '.git',
  '.nx',
  '.angular',
  ENV_DIR,
]);

/** Every .ts file outside environments/, node_modules and build output. */
export function workspaceTsFiles(tree: Tree, dir = ''): string[] {
  const out: string[] = [];
  for (const name of tree.children(dir)) {
    const p = dir ? `${dir}/${name}` : name;
    if (tree.isFile(p)) {
      if (/\.(m|c)?ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
    } else if (!SKIP_DIRS.has(name) && !(dir === '' && name.startsWith('.'))) {
      out.push(...workspaceTsFiles(tree, p));
    }
  }
  return out;
}

export interface EnvAliasReport {
  state: EnvAliasState | 'no-environments';
  /** file → number of rewritten imports */
  files: Record<string, number>;
}

/**
 * Adds the alias (when environments/ exists) and moves every import of an env file to it. With a
 * conflicting `@env/*`, nothing is rewritten.
 */
export function applyEnvAlias(tree: Tree): EnvAliasReport {
  if (!tree.exists(ENV_DIR) || tree.isFile(ENV_DIR)) return { state: 'no-environments', files: {} };
  const state = ensureEnvAlias(tree);
  const files: Record<string, number> = {};
  if (state === 'conflict' || state === 'no-tsconfig') return { state, files };
  for (const f of workspaceTsFiles(tree)) {
    const n = rewriteEnvImports(tree, f);
    if (n > 0) files[f] = n;
  }
  return { state, files };
}
