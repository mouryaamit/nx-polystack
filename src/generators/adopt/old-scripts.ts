import * as path from 'path';

import { Tree } from '@nx/devkit';

/**
 * The workspace's own build scripts that `pstack adopt` replaced, found by following what each
 * script runs, and whether anything still uses them.
 */

const JS = /\.(?:c|m)?js$/;
const posix = path.posix;

/** Workspace-relative .js files a script's text runs or loads (only those that exist). */
export function scriptReferences(tree: Tree, rel: string | null, text: string): string[] {
  const dir = rel ? posix.dirname(rel) : '.';
  const out = new Set<string>();
  const add = (p: string) => {
    const n = posix.normalize(p.replace(/^\.\//, ''));
    const file = JS.test(n) ? n : `${n}.js`;
    if (!file.startsWith('..') && tree.exists(file)) out.add(file);
  };
  // node tools/scripts/x.js …
  for (const m of text.matchAll(/\bnode\s+(['"]?)([\w./-]+\.(?:c|m)?js)\1/g)) add(m[2]);
  // require('./x'), import … from './x', import './x' and import('./x')
  for (const m of text.matchAll(
    /(?:\brequire\(\s*|\bfrom\s+|\bimport\(\s*|\bimport\s+)['"](\.{1,2}\/[\w./-]+)['"]/g,
  )) {
    add(posix.join(dir, m[1]));
  }
  // path.join('tools', 'scripts', 'x.js') or path.join(__dirname, 'x.js')
  for (const m of text.matchAll(/\bpath\.(?:join|resolve)\(([^()]*)\)/g)) {
    const parts = [...m[1].matchAll(/['"]([\w./-]+)['"]/g)].map((p) => p[1]);
    if (parts.length === 0 || !JS.test(parts[parts.length - 1])) continue;
    add(/__dirname/.test(m[1]) ? posix.join(dir, ...parts) : posix.join(...parts));
  }
  // A bare 'tools/…/x.js' string (spawn arguments, config files).
  for (const m of text.matchAll(/['"`]((?:\.\/)?tools\/[\w./-]+\.(?:c|m)?js)['"`]/g)) add(m[1]);
  return [...out].sort();
}

/** `entries` and every script they run or load, transitively. */
export function scriptClosure(tree: Tree, entries: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (rel: string) => {
    if (seen.has(rel) || !tree.exists(rel)) return;
    seen.add(rel);
    const text = tree.read(rel, 'utf8') ?? '';
    for (const ref of scriptReferences(tree, rel, text)) visit(ref);
  };
  for (const e of entries) visit(e);
  return seen;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tmp', 'coverage', '.git', '.nx', '.angular']);

function walk(tree: Tree, dir: string, keep: (rel: string) => boolean, out: string[], depth = 0) {
  if (depth > 8) return;
  for (const name of tree.children(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = dir === '.' || dir === '' ? name : `${dir}/${name}`;
    if (tree.isFile(rel)) {
      if (keep(rel)) out.push(rel);
    } else {
      walk(tree, rel, keep, out, depth + 1);
    }
  }
}

/** App and library code (outside tools/) that can import a script from tools/. */
const SOURCE = /^(?!tools\/).+\.(?:[cm]?[jt]sx?)$/;

/**
 * Text files that can start or load a script: package.json, project.json, CI, git hooks, and the
 * apps' and libraries' own code (an app importing tools/scripts/x.js at runtime).
 */
function entryTexts(tree: Tree): { file: string; text: string }[] {
  const files: string[] = [];
  walk(
    tree,
    '.',
    (rel) => {
      const base = posix.basename(rel);
      return (
        (SOURCE.test(rel) && !/\.d\.ts$/.test(rel)) ||
        base === 'package.json' ||
        base === 'project.json' ||
        /^Jenkinsfile/.test(base) ||
        /^(\.gitlab-ci|azure-pipelines|bitbucket-pipelines)\.ya?ml$/.test(base) ||
        /^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel) ||
        /^\.husky\/[^/]+$/.test(rel) ||
        /^\.lintstagedrc/.test(base)
      );
    },
    files,
  );
  return files.map((file) => ({ file, text: tree.read(file, 'utf8') ?? '' }));
}

/** Scripts under tools/ that something outside tools/ still starts (and what they load). */
export function liveScripts(tree: Tree): Set<string> {
  const entries = new Set<string>();
  for (const { file, text } of entryTexts(tree)) {
    for (const ref of scriptReferences(tree, file, text)) entries.add(ref);
  }
  return scriptClosure(tree, [...entries]);
}

/** Every .js file under tools/. */
export function toolScripts(tree: Tree): string[] {
  const out: string[] = [];
  if (tree.exists('tools')) walk(tree, 'tools', (rel) => JS.test(rel), out);
  return out.sort();
}

/** A script that builds apps itself: runs nx/ng build for a project. */
const BUILD_DRIVER =
  /\b(?:npx\s+)?nx\s+(?:build|run-many\s[^`'"]*\bbuild\b|run\s+[^`'"\s]+:build)|\bng\s+build\b/;

/** A script that runs the per-app npm build scripts (`npm run build:<app>:<env>`). */
const RUNS_BUILD_SCRIPTS = /\bnpm\b[^\n]{0,30}['"`]run['"`]|\bnpm\s+run\s+build:/;

/** Workspace-relative script paths named in backticks in a report (`tools/scripts/build.js`). */
export function recordedScripts(report: string): string[] {
  // Not the scripts a report listed as left in place (not part of the old build).
  const text = report.replace(/^Nothing starts these[^\n]*$/gm, '');
  return [
    ...new Set(
      [...text.matchAll(/`((?:\.\/)?tools\/[\w./-]+\.(?:c|m)?js)\b[^`]*`/g)].map((m) =>
        posix.normalize(m[1]),
      ),
    ),
  ].sort();
}

export interface OldScripts {
  /** Old build pipeline files nothing uses any more: safe to delete. */
  removable: string[];
  /** Scripts under tools/ nothing starts that are not part of the old pipeline: left in place. */
  unreferenced: string[];
}

/**
 * The old build pipeline: the scripts recorded as replaced by adopt (`recorded`), plus any
 * unused script under tools/ that runs an Angular build, with everything they run or load. Of
 * those, the files nothing else uses (package.json, project.json, CI, git hooks, and the scripts
 * those start) can go.
 */
export function findOldScripts(tree: Tree, recorded: string[]): OldScripts {
  const live = liveScripts(tree);
  const all = toolScripts(tree);
  const unused = all.filter((f) => !live.has(f));
  const drivers = unused.filter((f) => {
    const text = tree.read(f, 'utf8') ?? '';
    return BUILD_DRIVER.test(text) || RUNS_BUILD_SCRIPTS.test(text);
  });
  const entries = [...new Set([...recorded.filter((r) => tree.exists(r)), ...drivers])];
  // A script that only starts drivers (build-all.js running npm run build:<app>:<env> or
  // build.js) belongs to the pipeline too.
  for (const f of unused) {
    if (entries.includes(f)) continue;
    const reached = scriptClosure(tree, [f]);
    if ([...reached].some((r) => r !== f && entries.includes(r))) entries.push(f);
  }
  const pipeline = scriptClosure(tree, entries);
  const removable = [...pipeline].filter((f) => !live.has(f)).sort();
  const unreferenced = unused.filter((f) => !pipeline.has(f)).sort();
  return { removable, unreferenced };
}
