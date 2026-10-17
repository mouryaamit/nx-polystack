import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { Tree } from '@nx/devkit';

import { createIgnore, Ignore } from '../../lib/utils/devkit-deps';

/**
 * Which source paths are not copied. Paths are relative to the copied directory, with "/"
 * separators.
 */
export interface SkipRules {
  /** Names skipped at any depth (e.g. node_modules, .git). */
  anyDepth: readonly string[];
  /** Names skipped only directly in the copied directory (e.g. dist, package.json). */
  topLevel: readonly string[];
  /** Exact relative paths (e.g. ios/Pods). */
  paths?: readonly string[];
  /** Name patterns skipped at the top level (e.g. /^\.flutter-plugins/). */
  topLevelPatterns?: readonly RegExp[];
  /** Patterns matched against the whole relative path (e.g. /(^|\/)flutter\/ephemeral$/i). */
  pathPatterns?: readonly RegExp[];
}

/** Skipped by every adapter. */
const COMMON_ANY_DEPTH = ['.git', '.svn'];
const COMMON_PATHS = ['.yarn/cache'];

export function shouldSkip(rel: string, rules: SkipRules): boolean {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (COMMON_ANY_DEPTH.includes(name) || rules.anyDepth.includes(name)) return true;
  if (parts.length === 1) {
    if (rules.topLevel.includes(name)) return true;
    if (rules.topLevelPatterns?.some((re) => re.test(name))) return true;
  }
  if (COMMON_PATHS.includes(rel) || rules.paths?.includes(rel)) return true;
  return rules.pathPatterns?.some((re) => re.test(rel)) ?? false;
}

/** Signing keys, credentials and service configs: never copied, always reported. */
const SECRET_NAMES = new Set([
  '.env',
  '.npmrc',
  'key.properties',
  'google-services.json',
  'GoogleService-Info.plist',
]);
const SECRET_EXTENSIONS = ['.jks', '.keystore', '.p12', '.pem', '.pfx', '.key'];
const SAFE_ENV = new Set(['.env.example', '.env.sample']);

export function isPossibleSecret(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  if (SAFE_ENV.has(name)) return false;
  if (SECRET_NAMES.has(name) || name.startsWith('.env.')) return true;
  return SECRET_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export const DEFAULT_MAX_FILES = 20000;

export interface CopyOptions {
  /** Fail when more files than this would be copied. Default 20000. */
  maxFiles?: number;
  /**
   * Repo root that contains `sourceDir` (absolute). Outside a git work tree, the .gitignore
   * files from there down to `sourceDir` apply too, as git would apply them.
   */
  ignoreFrom?: string;
  /** Leave files the tree already has (listed in `existing`) instead of overwriting them. */
  keepExisting?: boolean;
}

export interface CopyResult {
  /** Copied files, relative to the copied directory. */
  copied: string[];
  /** Skipped paths; directories end with "/" and are not descended into. */
  skipped: string[];
  /** Possible secrets that were not copied. */
  secrets: string[];
  /** The file list came from git (tracked + untracked, not ignored). */
  git: boolean;
  /** With `keepExisting`: files left as the tree had them (not copied). */
  existing?: string[];
  /** Not a git work tree, but the source's .gitignore files were honoured. */
  gitignore: boolean;
  /** The copied source folder (absolute) and its folder in the workspace, for import rewriting. */
  from?: string;
  to?: string;
}

interface IgnoreScope {
  /** Directory (relative to the copied root) the .gitignore lives in; '' for the root. */
  base: string;
  /** For a .gitignore above the copied root: the path from its folder to the copied root. */
  outer?: string;
  rules: Ignore;
}

/** .gitignore files of the folders from `repoRoot` down to (not including) `sourceDir`. */
function ancestorGitignores(repoRoot: string, sourceDir: string): IgnoreScope[] {
  const rel = path.relative(repoRoot, sourceDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return [];
  const parts = rel.split(path.sep);
  const scopes: IgnoreScope[] = [];
  for (let i = 0; i < parts.length; i++) {
    const dir = path.join(repoRoot, ...parts.slice(0, i));
    const file = path.join(dir, '.gitignore');
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      scopes.push({
        base: '',
        outer: parts.slice(i).join('/'),
        rules: createIgnore().add(fs.readFileSync(file, 'utf8')),
      });
    } catch {
      // no .gitignore here
    }
  }
  return scopes;
}

/** Loads `<dir>/.gitignore` from the source, if present. */
function readGitignore(sourceDir: string, rel: string): IgnoreScope | undefined {
  const file = path.join(sourceDir, ...(rel ? rel.split('/') : []), '.gitignore');
  try {
    if (!fs.lstatSync(file).isFile()) return undefined;
    return { base: rel, rules: createIgnore().add(fs.readFileSync(file, 'utf8')) };
  } catch {
    return undefined;
  }
}

/** True when any enclosing .gitignore ignores `rel` (directories are tested with a trailing "/"). */
function ignoredBy(scopes: IgnoreScope[], rel: string, isDir: boolean): boolean {
  return scopes.some(({ base, outer, rules }) => {
    const local = outer ? `${outer}/${rel}` : base ? rel.slice(base.length + 1) : rel;
    return local !== '' && rules.ignores(isDir ? `${local}/` : local);
  });
}

function runGit(dir: string, args: string[]): string | undefined {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // Read-only: no index refresh, no lock files in the source.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return r.status === 0 && !r.error ? r.stdout : undefined;
}

/**
 * When `dir` is inside a git work tree: the files git tracks or would track (tracked, plus
 * untracked that are not ignored), relative to `dir`, sorted. Otherwise undefined.
 */
export function gitListedFiles(dir: string): string[] | undefined {
  if (runGit(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return undefined;
  const out = runGit(dir, ['ls-files', '-co', '--exclude-standard', '-z', '--', '.']);
  if (out === undefined) return undefined;
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Copies `sourceDir` into the tree at `destDir`, byte for byte (Buffers, so binary files are
 * preserved) and with each file's mode. The source is only read. In a git work tree only the
 * files git lists are considered. Skip rules and the secrets list apply either way; symbolic
 * links are skipped and listed.
 */
export function copyIntoTree(
  tree: Tree,
  sourceDir: string,
  destDir: string,
  rules: SkipRules,
  opts: CopyOptions = {},
): CopyResult {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const listed = gitListedFiles(sourceDir);
  const result: CopyResult = {
    copied: [],
    skipped: [],
    secrets: [],
    git: listed !== undefined,
    gitignore: false,
    from: sourceDir,
    to: destDir,
  };
  const skipped = new Set<string>();

  const copyFile = (rel: string, abs: string, stat: fs.Stats): void => {
    if (result.copied.length >= maxFiles) {
      throw new Error(
        `migrate: the source has more than ${maxFiles} files to copy after the skip lists. ` +
          'Clean it up (build output, vendored dependencies, generated files) or raise --max-files.',
      );
    }
    if (opts.keepExisting && tree.exists(`${destDir}/${rel}`)) {
      (result.existing ??= []).push(rel);
      return;
    }
    tree.write(`${destDir}/${rel}`, fs.readFileSync(abs), { mode: stat.mode & 0o777 });
    result.copied.push(rel);
  };

  /** Classifies one entry; returns true when it may be copied / descended into. */
  const admit = (rel: string, stat: fs.Stats): boolean => {
    if (stat.isSymbolicLink()) {
      skipped.add(`${rel} (symlink)`);
      return false;
    }
    if (shouldSkip(rel, rules)) {
      skipped.add(stat.isDirectory() ? `${rel}/` : rel);
      return false;
    }
    if (stat.isFile() && isPossibleSecret(rel)) {
      result.secrets.push(rel);
      return false;
    }
    return true;
  };

  if (listed) {
    for (const rel of listed) {
      // Any skipped ancestor folder skips the file (reported once, as the folder).
      const parts = rel.split('/');
      let ok = true;
      for (let i = 1; i < parts.length && ok; i++) {
        const dir = parts.slice(0, i).join('/');
        if (shouldSkip(dir, rules)) {
          skipped.add(`${dir}/`);
          ok = false;
        }
      }
      if (!ok) continue;
      const abs = path.join(sourceDir, ...parts);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue; // tracked but deleted from the work tree
      }
      if (admit(rel, stat) && stat.isFile()) copyFile(rel, abs, stat);
    }
  } else {
    // Not a git work tree: honour the source's .gitignore files ourselves, so generated and
    // machine-specific files (local.properties, Generated.xcconfig, *.iml, …) stay behind.
    const visit = (rel: string, scopes: IgnoreScope[]): void => {
      const abs = rel ? path.join(sourceDir, ...rel.split('/')) : sourceDir;
      const own = readGitignore(sourceDir, rel);
      if (own) result.gitignore = true;
      const active = own ? [...scopes, own] : scopes;
      const entries = fs.readdirSync(abs).sort(byName);
      for (const name of entries) {
        const childRel = rel ? `${rel}/${name}` : name;
        const childAbs = path.join(abs, name);
        const stat = fs.lstatSync(childAbs);
        if (!stat.isSymbolicLink() && ignoredBy(active, childRel, stat.isDirectory())) {
          skipped.add(stat.isDirectory() ? `${childRel}/` : childRel);
          continue;
        }
        if (!admit(childRel, stat)) continue;
        if (stat.isDirectory()) visit(childRel, active);
        else if (stat.isFile()) copyFile(childRel, childAbs, stat);
      }
    };
    const outer = opts.ignoreFrom ? ancestorGitignores(opts.ignoreFrom, sourceDir) : [];
    if (outer.length > 0) result.gitignore = true;
    visit('', outer);
  }

  result.skipped = [...skipped].sort(byName);
  result.secrets.sort(byName);
  return result;
}
