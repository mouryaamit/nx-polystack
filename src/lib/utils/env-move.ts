import * as path from 'path';

import { readJson, Tree, writeJson } from '@nx/devkit';

import { ENV_DIR, workspaceTsFiles } from './env-alias';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ENV_FILE = /^environment[^/]*\.ts$/;
const RELEASE_EXECUTOR = '@mouryaamit/nx-polystack:build';

export interface MovedAngularEnvFiles {
  /** The folder the env files were in (workspace-relative), when the project had one. */
  from?: string;
  /** environments/<envProject> */
  to: string;
  /** [from, to] file pairs. */
  moved: [string, string][];
  /** Target files that already existed: nothing was moved. */
  conflicts: string[];
  /** Env folders found, when there was more than one: nothing was moved. */
  folders: string[];
  /** file → number of rewritten import specifiers */
  imports: Record<string, number>;
}

/** Every fileReplacements entry of every target (options and configurations). */
function replacementPaths(pj: Json): string[] {
  const out: string[] = [];
  const targets = isObject(pj['targets']) ? (pj['targets'] as Record<string, Json>) : {};
  for (const target of Object.values(targets)) {
    if (!isObject(target)) continue;
    const sets = [
      target['options'],
      ...Object.values(isObject(target['configurations']) ? target['configurations'] : {}),
    ];
    for (const set of sets) {
      const list = isObject(set) ? set['fileReplacements'] : undefined;
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (!isObject(r)) continue;
        for (const key of ['replace', 'with', 'replaceWith']) {
          if (typeof r[key] === 'string') out.push(String(r[key]).replace(/^\.\//, ''));
        }
      }
    }
  }
  return out;
}

/** Replaces every string in json that is a key of `map`. */
function rewriteStrings(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') return map.get(value.replace(/^\.\//, '')) ?? value;
  if (Array.isArray(value)) return value.map((v) => rewriteStrings(v, map));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteStrings(v, map)]));
  }
  return value;
}

/** Import specifiers in TS source: `from '…'`, `import '…'`, `import('…')`, `require('…')`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\2/g;

/**
 * Points relative imports of moved files (`../environments/environment`) at their new place.
 * Returns the number of specifiers changed.
 */
function rewriteImports(tree: Tree, file: string, moved: Map<string, string>): number {
  const text = tree.read(file, 'utf8');
  if (text === null || !text.includes('environment')) return 0;
  const dir = path.posix.dirname(file);
  let count = 0;
  const out = text.replace(SPECIFIER, (whole, lead: string, q: string, spec: string) => {
    if (!spec.startsWith('.')) return whole;
    const target = path.posix.normalize(path.posix.join(dir, spec)).replace(/\.ts$/, '');
    const to = moved.get(target);
    if (!to) return whole;
    let rel = path.posix.relative(dir, to);
    if (!rel.startsWith('.')) rel = `./${rel}`;
    count++;
    return `${lead}${q}${rel}${q}`;
  });
  if (count > 0) tree.write(file, out);
  return count;
}

/**
 * Moves an Angular/Ionic project's environment*.ts files (the folder its fileReplacements use
 * inside the project, e.g. apps/portal/src/environments) to environments/<envProject>/, and points
 * the fileReplacements, the release target's envProject and the workspace's relative imports at
 * them (the @env/* pass of the migration then turns those imports into `@env/<envProject>/…`).
 * Nothing moves when a target file exists already or the project uses more than one env folder.
 */
export function moveAngularEnvFiles(
  tree: Tree,
  projectJsonPath: string,
  envProject: string,
): MovedAngularEnvFiles {
  const projectRoot = path.posix.dirname(projectJsonPath);
  const to = `${ENV_DIR}/${envProject}`;
  const result: MovedAngularEnvFiles = { to, moved: [], conflicts: [], folders: [], imports: {} };
  const pj = readJson<Json>(tree, projectJsonPath);

  const folders = [
    ...new Set(
      replacementPaths(pj)
        .filter((p) => p.startsWith(`${projectRoot}/`) && ENV_FILE.test(path.posix.basename(p)))
        .map((p) => path.posix.dirname(p)),
    ),
  ].sort();
  if (folders.length === 0) return result;
  if (folders.length > 1) {
    result.folders = folders;
    return result;
  }
  const from = folders[0];
  result.from = from;
  if (!tree.exists(from) || tree.isFile(from)) return result;

  const files = tree
    .children(from)
    .filter((f) => ENV_FILE.test(f) && tree.isFile(`${from}/${f}`))
    .sort();
  result.conflicts = files.map((f) => `${to}/${f}`).filter((t) => tree.exists(t));
  if (files.length === 0 || result.conflicts.length > 0) return result;

  const paths = new Map<string, string>();
  const modules = new Map<string, string>();
  for (const f of files) {
    const src = `${from}/${f}`;
    const dest = `${to}/${f}`;
    tree.write(dest, tree.read(src) as Buffer);
    tree.delete(src);
    result.moved.push([src, dest]);
    paths.set(src, dest);
    modules.set(src.replace(/\.ts$/, ''), dest.replace(/\.ts$/, ''));
  }

  const updated = rewriteStrings(pj, paths) as Json;
  const targets = isObject(updated['targets']) ? (updated['targets'] as Record<string, Json>) : {};
  for (const target of Object.values(targets)) {
    if (target?.['executor'] !== RELEASE_EXECUTOR) continue;
    const options = isObject(target['options']) ? target['options'] : (target['options'] = {});
    options['envProject'] = envProject;
  }
  writeJson(tree, projectJsonPath, updated);

  for (const file of workspaceTsFiles(tree)) {
    const n = rewriteImports(tree, file, modules);
    if (n > 0) result.imports[file] = n;
  }
  return result;
}

/**
 * Runs the moves a migration recorded in `envMoves` (after import rewriting) and adds a report note
 * for each project that had env files.
 */
export function applyEnvMoves(
  tree: Tree,
  data: {
    notes: string[];
    envMoves?: { projectJson: string; envProject: string; label?: string }[];
  },
  move = true,
): void {
  for (const m of data.envMoves ?? []) {
    if (!tree.exists(m.projectJson)) continue;
    const note = move
      ? envMoveNote(moveAngularEnvFiles(tree, m.projectJson, m.envProject))
      : keptNote(tree, m.projectJson, m.envProject);
    if (!note) continue;
    data.notes.push(m.label ? `${m.label}: ${note}` : `${note[0].toUpperCase()}${note.slice(1)}.`);
  }
}

/** With imports left as they are (--no-rewrite-imports), env files stay; says where they belong. */
function keptNote(tree: Tree, projectJsonPath: string, envProject: string): string | undefined {
  const projectRoot = path.posix.dirname(projectJsonPath);
  const inProject = replacementPaths(readJson<Json>(tree, projectJsonPath)).some(
    (p) => p.startsWith(`${projectRoot}/`) && ENV_FILE.test(path.posix.basename(p)),
  );
  if (!inProject) return undefined;
  return (
    'env files were left in the project (imports are not rewritten with --no-rewrite-imports); ' +
    `polystack apps keep them in \`${ENV_DIR}/${envProject}/\` (move them, then update ` +
    'fileReplacements, the imports and the release envProject)'
  );
}

/** What moveAngularEnvFiles did, as a migration report note (none when nothing was found). */
export function envMoveNote(r: MovedAngularEnvFiles): string | undefined {
  const code = (s: string) => `\`${s}\``;
  if (r.folders.length > 1) {
    return (
      `env files were left in place: the fileReplacements use more than one folder ` +
      `(${r.folders.map(code).join(', ')}); move them to ${code(`${r.to}/`)} by hand`
    );
  }
  if (r.conflicts.length > 0) {
    return (
      `env files were left in ${code(`${r.from}/`)}: ${r.conflicts.map(code).join(', ')} ` +
      'already exist (compare them, then move the rest by hand)'
    );
  }
  if (r.moved.length === 0) return undefined;
  const files = Object.keys(r.imports);
  return (
    `env files moved from ${code(`${r.from}/`)} to ${code(`${r.to}/`)} ` +
    `(${r.moved.map(([f]) => code(path.posix.basename(f))).join(', ')}); fileReplacements updated` +
    (files.length > 0 ? `, imports updated in ${files.map(code).join(', ')}` : '')
  );
}
