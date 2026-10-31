import * as path from 'path';

import type { Tree } from '@nx/devkit';

import { scriptClosure } from '../../generators/adopt/old-scripts';
import { imageFiles, projectImageSources, selectImageSources } from '../assets/source-images';
import { keepJsonLayout, loadJsonc } from '../utils/json-layout';
import { ReadProject, scanProjects } from '../utils/project-json-files';
import {
  isAngularProject,
  templatesConfigChange,
  typecheckTargetChange,
  typecheckTsconfig,
} from '../utils/quality';

/**
 * Workspace scripts that do a job pstack now does itself, found by what their text does (not by
 * their name): stripping EXIF from source images (`pstack assets strip-exif`) and type-checking
 * without a build (`nx run-many -t typecheck`). Their callers (npm scripts, run-commands targets,
 * git hooks, lint-staged, CI) are pointed at pstack, so the scripts can go. A script that does
 * more than that one job is left, with what else it does.
 */

const posix = path.posix;

export type ToolJob = 'strip-exif' | 'typecheck';

export interface ToolScript {
  job: ToolJob;
  /** Workspace-relative entry file. */
  script: string;
  /** Entry and what it loads. */
  files: string[];
  /** What else it does (non-empty: left as it is). */
  more: string[];
  /** strip-exif: folders named in the script (workspace-relative, existing). */
  dirs: string[];
  /** typecheck: tsconfig files named in the script. */
  tsconfigs: string[];
  /** typecheck: walks projects for tsconfig.app.json / tsconfig.lib.json. */
  walks: ('app' | 'lib')[];
  /** typecheck: runs ngc (templates). */
  templates: boolean;
  /** `--flags` the script reads from its arguments. */
  flags: string[];
}

const BUILD_DRIVER =
  /\b(?:npx\s+)?nx\s+(?:build|run-many\s[^`'"]*\bbuild\b|run\s+[^`'"\s]+:build)|\bng\s+build\b/;
const IMAGE_LIB =
  /(?:require\(\s*|from\s+|import\(\s*)['"](sharp|piexifjs|exiftool-vendored|jpeg-autorotate|exifr)['"]/;
const EXIF_INTENT = /exif|metadata|piexif\.remove/i;
/** Image extensions the script looks for (also written as a regex: `jpe?g`). */
const IMAGE_EXT = /jpe\??g|\bpng\b|\bwebp\b/i;
const WALKS_DIRS = /\breaddir(?:Sync)?\s*\(|\bglob(?:Sync)?\s*\(|\bfast-glob\b|\bwalk\w*\s*\(/;
const IMAGE_MORE: [RegExp, string][] = [
  [/\.resize\s*\(/, 'resizes images'],
  [/\.composite\s*\(/, 'composites images'],
  [/\.(?:avif|toFormat|heif|gif|tiff)\s*\(/, 'converts image formats'],
  [/\bimagemin\b/, 'compresses images (imagemin)'],
  [/\.(?:extend|sharpen|blur|trim|flatten|modulate|tint|grayscale|greyscale)\s*\(/, 'edits images'],
];

const TSC =
  /(?:^|[\s'"`([,])(?:npx\s+)?(?:\.\/)?(?:node_modules\/\.bin\/)?tsc(?:\.cmd)?(?=[\s'"`,)\]]|$)|typescript\/bin\/tsc/m;
const NGC =
  /(?:^|[\s'"`([,])(?:npx\s+)?ngc(?=[\s'"`,)\]]|$)|@angular\/compiler-cli\/bundles\/src\/bin\/ngc/m;
const NO_EMIT = /--noEmit\b|noEmit\s*:\s*true/;
const TS_API = /\bcreateProgram\s*\(/;
const TS_DIAG = /getPreEmitDiagnostics\s*\(/;
const TSCONFIG_LITERAL =
  /(?:^|[\s'"`=(,[])((?:\.\/)?(?:[\w@.${}-]+\/)*tsconfig(?:\.[\w-]+)?\.json)(?=[\s'"`),\]]|$)/gm;

/** What else a type-check script does, from its text. */
function typecheckMore(text: string): string[] {
  const more: string[] = [];
  const readsSources = /\breadFile(?:Sync)?\s*\(/.test(text) && /\.tsx?['"`)]/.test(text);
  const importPattern =
    /\/[^/\n]*\bimport\b[^/\n]*\/[gimsuy]*|new RegExp\([^)]*\bimport\b|['"`][^'"`\n]*\bfrom\s+['"`]/;
  if (readsSources && importPattern.test(text)) more.push('checks import statements itself');
  for (const line of text.split('\n')) {
    if (/\bwriteFile(?:Sync)?\s*\(/.test(line) && !/tsconfig/i.test(line)) {
      more.push('writes files');
      break;
    }
  }
  if (BUILD_DRIVER.test(text)) more.push('runs a build');
  return more;
}

const isDir = (tree: Tree, p: string) => tree.exists(p) && !tree.isFile(p);
const normalize = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');

/**
 * The code of a script without its comments, so what a comment mentions (".withMetadata() is not
 * used", "without a build") does not count as what the script does. `//` after a `:` (URLs) stays.
 */
export function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * Folder literals of a script that exist in the workspace (workspace-relative). A `../` literal is
 * read against the script's folder (`path.join(__dirname, '../../apps/web/src/assets')`).
 */
function dirLiterals(
  tree: Tree,
  script: string,
  text: string,
  mapPath?: (p: string) => string | undefined,
): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/['"`]((?:\.\/)?[\w@.-]+(?:\/[\w@.-]+)+\/?)['"`]/g)) {
    let p = normalize(m[1]).replace(/\/$/, '');
    if (p.startsWith('../')) p = normalize(posix.join(posix.dirname(script), p));
    if (p.startsWith('..')) continue;
    if (p.startsWith('node_modules') || p.startsWith('dist')) continue;
    const at = isDir(tree, p) ? p : mapPath?.(p);
    if (at && isDir(tree, at)) out.add(at);
  }
  return [...out].sort();
}

/**
 * What a script does, when its job is one pstack does: null for anything else. `mapPath` maps a
 * path written for the source repo to the workspace (pstack migrate).
 */
export function classifyToolScript(
  tree: Tree,
  script: string,
  mapPath?: (p: string) => string | undefined,
): ToolScript | null {
  const files = [...scriptClosure(tree, [script])].sort();
  const raw = files.map((f) => tree.read(f, 'utf8') ?? '').join('\n');
  // What the script does is read from its code; why (EXIF) may only be said in a comment.
  const text = codeOnly(raw);
  const flags = [...new Set([...text.matchAll(/['"`](--[a-z][\w-]*)/g)].map((m) => m[1]))].sort();
  const base = { script, files, flags, dirs: [], tsconfigs: [], walks: [], templates: false };

  if (
    IMAGE_LIB.test(text) &&
    EXIF_INTENT.test(raw) &&
    IMAGE_EXT.test(text) &&
    WALKS_DIRS.test(text)
  ) {
    const more = IMAGE_MORE.filter(([re]) => re.test(text)).map(([, why]) => why);
    if (BUILD_DRIVER.test(text)) more.push('runs a build');
    if (/withMetadata\s*\(/.test(text)) more.push('keeps metadata (withMetadata)');
    return { ...base, job: 'strip-exif', more, dirs: dirLiterals(tree, script, text, mapPath) };
  }

  const tsc = TSC.test(text) && NO_EMIT.test(text);
  const api = TS_API.test(text) && TS_DIAG.test(text);
  const ngc = NGC.test(text) && NO_EMIT.test(text);
  if (tsc || api || ngc) {
    const tsconfigs = new Set<string>();
    const walks = new Set<'app' | 'lib'>();
    for (const m of text.matchAll(TSCONFIG_LITERAL)) {
      const p = normalize(m[1]);
      if (p.includes('$')) {
        // A path built in a template: the script walks folders for that file name.
        if (p.endsWith('tsconfig.app.json')) walks.add('app');
        else if (p.endsWith('tsconfig.lib.json')) walks.add('lib');
      } else if (p.includes('/')) {
        const at = tree.exists(p) ? p : mapPath?.(p);
        if (at && tree.exists(at)) tsconfigs.add(at);
      } else if (p === 'tsconfig.app.json') walks.add('app');
      else if (p === 'tsconfig.lib.json') walks.add('lib');
    }
    // `${dir}/tsconfig.app.json` built from a folder walk.
    if (/tsconfig\.app\.json/.test(text) && WALKS_DIRS.test(text)) walks.add('app');
    if (/tsconfig\.lib\.json/.test(text) && WALKS_DIRS.test(text)) walks.add('lib');
    const more = typecheckMore(text);
    return {
      ...base,
      job: 'typecheck',
      more,
      tsconfigs: [...tsconfigs].sort(),
      walks: [...walks].sort(),
      templates: ngc,
    };
  }
  return null;
}

// ── callers ──────────────────────────────────────────────────────────────────

export interface ScriptCall {
  /** File the call is in. */
  file: string;
  /** Where in it: `scripts.x`, `targets.t`, `lint-staged "*.jpg"`, `line N`. */
  where: string;
  script: string;
  args: string[];
  /** The `node <script> args` text as written. */
  text: string;
}

/** Text files that run commands: package.json, project.json, hooks, lint-staged, CI. */
function callerFiles(tree: Tree): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'dist', 'tmp', 'coverage', '.git', '.nx', '.angular']);
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const name of tree.children(dir)) {
      if (skip.has(name)) continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (!tree.isFile(rel)) {
        walk(rel, depth + 1);
        continue;
      }
      const b = posix.basename(rel);
      if (
        b === 'package.json' ||
        b === 'project.json' ||
        /^Jenkinsfile/.test(b) ||
        /^(\.gitlab-ci|azure-pipelines|bitbucket-pipelines)\.ya?ml$/.test(b) ||
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel) ||
        /^\.husky\/[^/]+$/.test(rel) ||
        /^\.lintstagedrc(\.json)?$/.test(b)
      ) {
        out.push(rel);
      }
    }
  };
  walk('', 0);
  return out.sort();
}

const CALL =
  /(?:\bnpx\s+)?\bnode\s+(['"]?)((?:\.\/)?[\w@./-]+\.(?:c|m)?js)\1((?:[ \t]+(?!&&|\|\|)[^\s;&|<>]+)*)/g;

/** `node <file>.js args` calls in a command string, the file resolved against `cwd`. */
function callsIn(command: string, cwd: string): { script: string; args: string[]; text: string }[] {
  const out: { script: string; args: string[]; text: string }[] = [];
  for (const m of command.matchAll(CALL)) {
    const script = normalize(cwd ? posix.join(cwd, m[2]) : m[2]);
    const args = (m[3] ?? '')
      .trim()
      .split(/[ \t]+/)
      .filter(Boolean)
      .map(unquote);
    out.push({ script, args, text: m[0] });
  }
  return out;
}

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2');

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every `node <script>` call of the workspace's command files. */
export function findScriptCalls(tree: Tree): ScriptCall[] {
  const calls: ScriptCall[] = [];
  for (const file of callerFiles(tree)) {
    const text = tree.read(file, 'utf8') ?? '';
    if (!/\bnode\s/.test(text)) continue;
    const add = (where: string, command: string, cwd = '') => {
      for (const c of callsIn(command, cwd)) calls.push({ file, where, ...c });
    };
    if (file.endsWith('.json')) {
      let json: Json;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }
      if (posix.basename(file) === 'package.json') {
        for (const [k, v] of Object.entries(isObject(json['scripts']) ? json['scripts'] : {})) {
          if (typeof v === 'string') add(`scripts.${k}`, v);
        }
        lintStagedCalls(json['lint-staged'], add);
      } else if (posix.basename(file) === 'project.json') {
        for (const [t, target] of Object.entries(
          isObject(json['targets']) ? json['targets'] : {},
        )) {
          if (!isObject(target) || !isObject(target['options'])) continue;
          const o = target['options'];
          const cwd = typeof o['cwd'] === 'string' ? normalize(o['cwd']) : '';
          for (const c of runCommands(o)) add(`targets.${t}`, c, cwd);
        }
      } else {
        lintStagedCalls(json, add);
      }
      continue;
    }
    text.split('\n').forEach((line, i) => add(`line ${i + 1}`, line));
  }
  return calls;
}

function lintStagedCalls(config: unknown, add: (where: string, command: string) => void): void {
  if (!isObject(config)) return;
  for (const [glob, cmds] of Object.entries(config)) {
    for (const c of Array.isArray(cmds) ? cmds : [cmds]) {
      if (typeof c === 'string') add(`lint-staged "${glob}"`, c);
    }
  }
}

function runCommands(o: Json): string[] {
  const out: string[] = [];
  if (typeof o['command'] === 'string') out.push(o['command']);
  if (Array.isArray(o['commands'])) {
    for (const c of o['commands']) {
      if (typeof c === 'string') out.push(c);
      else if (isObject(c) && typeof c['command'] === 'string') out.push(c['command']);
    }
  }
  return out;
}

// ── new commands ─────────────────────────────────────────────────────────────

/** A new command for a call, or why the call is left. */
export type Mapped = { command: string; projects?: ReadProject[] } | { leave: string };

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** `pstack assets strip-exif …` for an EXIF script call. */
export function exifCommand(
  tree: Tree,
  job: ToolScript,
  call: { args: string[]; where: string },
  mapPath?: (p: string) => string | undefined,
): Mapped {
  const lintStaged = call.where.startsWith('lint-staged');
  const dirs: string[] = [];
  const extra: string[] = [];
  for (const a of call.args) {
    const flag = /^--(dir|path|src|folder|input)=(.+)$/.exec(a);
    const value = flag ? flag[2] : a.startsWith('-') ? undefined : a;
    if (value !== undefined) {
      if (lintStaged) return { leave: `takes arguments in lint-staged (${call.args.join(' ')})` };
      for (const v of value.split(',')) {
        const p = normalize(v).replace(/\/$/, '');
        const at = isDir(tree, p) ? p : mapPath?.(p);
        if (!at || !isDir(tree, at)) return { leave: `argument ${a} is not a folder pstack knows` };
        dirs.push(at);
      }
    } else if (a === '--check' || a === '--dry-run') {
      if (!job.flags.includes(a)) return { leave: `passes ${a}, which the script does not read` };
      extra.push(a);
    } else {
      return { leave: `passes ${a}, which pstack cannot map` };
    }
  }
  if (lintStaged) return { command: 'pstack assets strip-exif' };
  const folders = dirs.length > 0 ? dirs : job.dirs;
  if (folders.length === 0) return { leave: 'could not tell which folders it cleans' };
  if (folders.every((d) => d === 'dist' || d.startsWith('dist/'))) {
    return { leave: 'cleans dist/ (the release build already strips image metadata)' };
  }
  const tail = extra.length ? ` ${extra.join(' ')}` : '';
  // The same images as --all, or as some apps, else exactly these folders.
  const want = imageFiles(
    tree,
    folders.map((p) => ({ owner: '', path: p })),
  );
  const allFiles = imageFiles(tree, selectImageSources(tree, { all: true }));
  if (want.length > 0 && sameSet(want, allFiles) && sameSet(folders, folderSet(tree, true))) {
    return { command: `pstack assets strip-exif --all${tail}` };
  }
  const apps = appsOwning(tree, folders);
  if (apps) return { command: `pstack assets strip-exif --app=${apps.join(',')}${tail}` };
  return { command: `pstack assets strip-exif --dir=${folders.join(',')}${tail}` };
}

/** The existing source folders of --all. */
function folderSet(tree: Tree, all: boolean): string[] {
  return [
    ...new Set(
      selectImageSources(tree, { all })
        .map((s) => s.path)
        .filter((p) => isDir(tree, p)),
    ),
  ];
}

/** Apps whose existing source folders are exactly these folders, if any. */
function appsOwning(tree: Tree, folders: string[]): string[] | null {
  const projects = scanProjects(tree).filter((p) => p.json['projectType'] === 'application');
  const owners: string[] = [];
  const covered = new Set<string>();
  for (const p of projects) {
    const own = [...new Set(projectImageSources(tree, p).map((s) => s.path))].filter((d) =>
      isDir(tree, d),
    );
    if (own.length > 0 && own.every((d) => folders.includes(d))) {
      owners.push(p.name);
      own.forEach((d) => covered.add(d));
    }
  }
  return owners.length > 0 && sameSet([...covered], folders) ? owners.sort() : null;
}

/** Projects with a typecheck (or a tsconfig it would check). */
function typedProjects(tree: Tree): ReadProject[] {
  return scanProjects(tree).filter((p) => {
    const t = isObject(p.json['targets']) ? p.json['targets'] : {};
    return t['typecheck'] !== undefined || typecheckTsconfig(tree, p.root) !== undefined;
  });
}

const KINDS: Record<string, (tree: Tree, p: ReadProject) => boolean> = {
  angular: (tree, p) => isAngularProject(tree, p.root, p.json),
  ionic: (tree, p) =>
    tree.exists(`${p.root}/capacitor.config.ts`) || tree.exists(`${p.root}/ionic.config.json`),
  web: (tree, p) => !KINDS['ionic'](tree, p),
  app: (_tree, p) => p.json['projectType'] === 'application',
  apps: (_tree, p) => p.json['projectType'] === 'application',
  lib: (_tree, p) => p.json['projectType'] === 'library',
  libs: (_tree, p) => p.json['projectType'] === 'library',
};

/** `nx run-many -t typecheck …` for a type-check script call. */
export function typecheckCommand(
  tree: Tree,
  job: ToolScript,
  call: { args: string[]; where: string },
): Mapped {
  if (call.where.startsWith('lint-staged'))
    return { leave: 'runs from lint-staged (gets file names)' };
  const typed = typedProjects(tree);
  // The projects the script checks.
  let chosen = typed.filter((p) => {
    const tsconfig = typecheckTsconfig(tree, p.root);
    if (job.tsconfigs.some((t) => posix.dirname(t) === (p.root === '.' ? '.' : p.root)))
      return true;
    if (!tsconfig) return false;
    return (
      (job.walks.includes('app') && tsconfig.endsWith('tsconfig.app.json')) ||
      (job.walks.includes('lib') && tsconfig.endsWith('tsconfig.lib.json'))
    );
  });
  let byName = false;
  for (const a of call.args) {
    const named = /^--(?:app|apps|project|projects)=(.+)$/.exec(a);
    const kind = /^--([a-z]+)$/.exec(a);
    if (named || !a.startsWith('-')) {
      const names = (named ? named[1] : a).split(',');
      const unknown = names.filter((n) => !chosen.some((p) => p.name === n));
      if (unknown.length) return { leave: `names ${unknown.join(', ')}, which it does not check` };
      chosen = chosen.filter((p) => names.includes(p.name));
      byName = true;
    } else if (kind && KINDS[kind[1]] && job.flags.includes(a)) {
      chosen = chosen.filter((p) => KINDS[kind[1]](tree, p));
    } else {
      return { leave: `passes ${a}, which pstack cannot map` };
    }
  }
  if (chosen.length === 0) return { leave: 'could not tell which projects it checks' };
  const missing = chosen.filter((p) => {
    const t = isObject(p.json['targets']) ? p.json['targets'] : {};
    return t['typecheck'] === undefined && !typecheckTsconfig(tree, p.root);
  });
  if (missing.length) return { leave: `${missing.map((p) => p.name).join(', ')} have no tsconfig` };
  const templates = job.templates ? ' -c templates' : '';
  const names = chosen.map((p) => p.name).sort();
  // Projects named on the command line stay named, even when they are all there is today.
  if (
    !byName &&
    sameSet(
      names,
      typed.map((p) => p.name),
    )
  )
    return { command: `nx run-many -t typecheck${templates}`, projects: chosen };
  if (names.length === 1)
    return {
      command: `nx run ${names[0]}:typecheck${templates ? ':templates' : ''}`,
      projects: chosen,
    };
  // A tag that selects exactly these projects, so new ones join.
  const tags = new Set(
    chosen.flatMap((p) => (Array.isArray(p.json['tags']) ? (p.json['tags'] as string[]) : [])),
  );
  for (const tag of [...tags].sort()) {
    const tagged = typed.filter(
      (p) => Array.isArray(p.json['tags']) && (p.json['tags'] as string[]).includes(tag),
    );
    if (
      sameSet(
        tagged.map((p) => p.name),
        names,
      )
    ) {
      return {
        command: `nx run-many -t typecheck --projects=tag:${tag}${templates}`,
        projects: chosen,
      };
    }
  }
  return {
    command: `nx run-many -t typecheck -p ${names.join(',')}${templates}`,
    projects: chosen,
  };
}

// ── rewrite ──────────────────────────────────────────────────────────────────

export interface ToolScriptOutcome {
  script: string;
  job: ToolJob;
  /** Calls pointed at pstack: `file where: old → new`. */
  rewritten: string[];
  /** Calls (or the script) left, with why. */
  left: string[];
  /** Every call was rewritten: nothing runs the script any more. */
  replaced: boolean;
}

/** Rewrites one call in a command file. */
function rewriteCall(tree: Tree, call: ScriptCall, command: string): boolean {
  const before = tree.read(call.file, 'utf8');
  if (before === null) return false;
  const replace = (s: string) => s.split(call.text).join(command);
  if (!call.file.endsWith('.json')) {
    const lines = before.split('\n');
    const n = Number(/^line (\d+)$/.exec(call.where)?.[1]) - 1;
    if (!(n >= 0) || !lines[n]?.includes(call.text)) return false;
    lines[n] = replace(lines[n]);
    tree.write(call.file, lines.join('\n'));
    return true;
  }
  let json: Json;
  try {
    json = JSON.parse(before);
  } catch {
    return false;
  }
  let done = false;
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string' && v.includes(call.text)) {
      done = true;
      return replace(v);
    }
    if (Array.isArray(v)) return v.map(visit);
    if (isObject(v)) {
      for (const k of Object.keys(v)) v[k] = visit(v[k]);
    }
    return v;
  };
  const [head, ...rest] = call.where.split('.');
  if (head === 'scripts' && isObject(json['scripts'])) {
    const k = rest.join('.');
    json['scripts'][k] = visit(json['scripts'][k]);
  } else if (head === 'targets' && isObject(json['targets'])) {
    const k = rest.join('.');
    json['targets'][k] = visit(json['targets'][k]);
  } else if (call.where.startsWith('lint-staged')) {
    const glob = /^lint-staged "(.*)"$/.exec(call.where)?.[1] ?? '';
    const cfg = posix.basename(call.file) === 'package.json' ? json['lint-staged'] : json;
    if (isObject(cfg)) cfg[glob] = visit(cfg[glob]);
  }
  if (!done) return false;
  const after = JSON.stringify(json, null, 2) + '\n';
  const jsonc = loadJsonc(tree.root);
  tree.write(call.file, (jsonc && keepJsonLayout(jsonc, before, after)) || after);
  return true;
}

/**
 * Adds the typecheck target (and its templates configuration) where pstack can; returns the
 * projects that still lack what the command runs.
 */
function typecheckTargetsFor(tree: Tree, projects: ReadProject[], templates: boolean): string[] {
  const missing: string[] = [];
  for (const p of [...new Map(projects.map((x) => [x.root, x])).values()]) {
    typecheckTargetChange(tree, p.root);
    if (templates) templatesConfigChange(tree, p.root);
    const file = p.root === '.' ? 'project.json' : `${p.root}/project.json`;
    let json: Json = {};
    try {
      json = JSON.parse(tree.read(file, 'utf8') ?? '{}');
    } catch {
      missing.push(p.name);
      continue;
    }
    const tc = isObject(json['targets']) ? json['targets']['typecheck'] : undefined;
    const ok =
      isObject(tc) &&
      (!templates ||
        (isObject(tc['configurations']) && tc['configurations']['templates'] !== undefined));
    if (!ok) missing.push(p.name);
  }
  return missing;
}

export interface ReplaceOptions {
  /** Only these scripts (workspace-relative); default every called script under any folder. */
  only?: (script: string) => boolean;
  /** Source path → workspace path (pstack migrate). */
  mapPath?: (p: string) => string | undefined;
}

/**
 * Finds the scripts that strip EXIF from source images or type-check without a build, and points
 * every call of them at pstack. A script whose calls cannot all be mapped, or that does more, is
 * left (its calls too) and reported.
 */
export function replaceToolScripts(tree: Tree, opts: ReplaceOptions = {}): ToolScriptOutcome[] {
  const calls = findScriptCalls(tree).filter((c) => tree.exists(c.script));
  const scripts = [...new Set(calls.map((c) => c.script))].filter(
    (s) => !opts.only || opts.only(s),
  );
  const outcomes: ToolScriptOutcome[] = [];
  for (const script of scripts.sort()) {
    const job = classifyToolScript(tree, script, opts.mapPath);
    if (!job) continue;
    const mine = calls.filter((c) => c.script === script);
    const out: ToolScriptOutcome = {
      script,
      job: job.job,
      rewritten: [],
      left: [],
      replaced: false,
    };
    outcomes.push(out);
    if (job.more.length > 0) {
      out.left.push(
        `does more than ${job.job === 'typecheck' ? 'type-check' : 'strip EXIF'}: ${job.more.join(
          ', ',
        )}`,
      );
      continue;
    }
    const mapped = mine.map((c) => ({
      call: c,
      m:
        job.job === 'strip-exif'
          ? exifCommand(tree, job, c, opts.mapPath)
          : typecheckCommand(tree, job, c),
    }));
    const leave = mapped.filter((x) => 'leave' in x.m);
    if (leave.length > 0) {
      // All or nothing: the script stays while anything still runs it.
      for (const x of leave)
        out.left.push(`${x.call.file} ${x.call.where}: ${(x.m as { leave: string }).leave}`);
      continue;
    }
    // The typecheck targets (and templates configurations) the new commands run.
    const missing = typecheckTargetsFor(
      tree,
      mapped.flatMap((x) => ('projects' in x.m ? x.m.projects ?? [] : [])),
      job.templates,
    );
    if (missing.length > 0) {
      out.left.push(
        `no typecheck${job.templates ? ' templates configuration' : ''} target in ${missing.join(
          ', ',
        )}`,
      );
      continue;
    }
    for (const { call, m } of mapped) {
      const command = (m as { command: string }).command;
      if (rewriteCall(tree, call, command)) {
        out.rewritten.push(`${call.file} ${call.where}: ${call.text.trim()} → ${command}`);
      } else {
        out.left.push(`${call.file} ${call.where}: could not be rewritten`);
      }
    }
    out.replaced = out.left.length === 0;
  }
  return outcomes;
}
