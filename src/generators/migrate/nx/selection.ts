import * as path from 'path';

import { readPubspec } from '../adapters/flutter';
import { readSourceJsonStrict, readSourceText, sourceExists } from '../source';

import {
  describeKind,
  isObject,
  isSupportedKind,
  Json,
  listProjectFiles,
  objectField,
  ownerOf,
  SourceProject,
} from './workspace-source';

/** Alias → targets relative to the source root (POSIX, normalized). */
export type AliasMap = Record<string, string[]>;

/** tsconfig.base.json (else tsconfig.json) `paths`, resolved against `baseUrl`. */
export function readSourceAliases(sourceDir: string): AliasMap {
  const file = sourceExists(sourceDir, 'tsconfig.base.json')
    ? 'tsconfig.base.json'
    : 'tsconfig.json';
  const ts = readSourceJsonStrict<Json>(sourceDir, file);
  const co = objectField(ts, 'compilerOptions');
  const baseUrl = typeof co['baseUrl'] === 'string' ? (co['baseUrl'] as string) : '.';
  const paths = isObject(co['paths']) ? (co['paths'] as Json) : {};
  const out: AliasMap = {};
  for (const [alias, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    out[alias] = targets
      .filter((t): t is string => typeof t === 'string')
      .map((t) => path.posix.normalize(path.posix.join(baseUrl, t)).replace(/^\.\//, ''));
  }
  return out;
}

/** Targets an import specifier resolves to through the aliases (exact, else longest `*` prefix). */
export function resolveAlias(spec: string, aliases: AliasMap): string[] {
  if (aliases[spec]) return aliases[spec];
  let best: { prefix: number; targets: string[] } | undefined;
  for (const [alias, targets] of Object.entries(aliases)) {
    const star = alias.indexOf('*');
    if (star === -1) continue;
    const pre = alias.slice(0, star);
    const post = alias.slice(star + 1);
    if (spec.length < pre.length + post.length || !spec.startsWith(pre) || !spec.endsWith(post)) {
      continue;
    }
    if (best && pre.length <= best.prefix) continue;
    const mid = spec.slice(pre.length, spec.length - post.length);
    best = { prefix: pre.length, targets: targets.map((t) => t.replace('*', mid)) };
  }
  return best?.targets ?? [];
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

/** Module specifiers in a TS/JS file (static, side-effect and dynamic imports, re-exports, require). */
export function importSpecifiers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IMPORT_RE)) out.add(m[2]);
  return [...out].sort();
}

const CODE_FILE = /\.(ts|tsx|mts|js|mjs)$/;

/** Names of the projects `project` depends on (implicit, alias imports, pubspec paths), sorted. */
export function directDependencies(
  sourceDir: string,
  project: SourceProject,
  projects: SourceProject[],
  aliases: AliasMap,
): string[] {
  const names = new Set<string>(projects.map((p) => p.name));
  const deps = new Set<string>();
  const implicit = project.config['implicitDependencies'];
  if (Array.isArray(implicit)) {
    for (const d of implicit) {
      if (typeof d === 'string' && !d.startsWith('!') && names.has(d)) deps.add(d);
    }
  }
  for (const file of listProjectFiles(sourceDir, project.root)) {
    if (!CODE_FILE.test(file) || file.endsWith('.d.ts')) continue;
    const full = project.root ? `${project.root}/${file}` : file;
    // A file of a project nested in this one (e.g. projects/ under a root app) is not its own.
    const owner = ownerOf(projects, full);
    if (owner && owner.name !== project.name) continue;
    const text = readSourceText(sourceDir, full) ?? '';
    for (const spec of importSpecifiers(text)) {
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      for (const target of resolveAlias(spec, aliases)) {
        const owner = ownerOf(projects, target);
        if (owner) deps.add(owner.name);
      }
    }
  }
  const pubspec = readSourceText(sourceDir, `${project.root}/pubspec.yaml`);
  if (pubspec !== undefined) {
    for (const dep of readPubspec(pubspec).pathDependencies) {
      const target = path.posix.normalize(path.posix.join(project.root, dep.path));
      const owner = ownerOf(projects, target);
      if (owner) deps.add(owner.name);
    }
  }
  deps.delete(project.name);
  return [...deps].sort();
}

export interface SelectInput {
  sourceDir: string;
  projects: SourceProject[];
  /** --projects; undefined or empty means every supported project. */
  requested?: string[];
  noDeps: boolean;
  /** Aliases for the closure (default: the source tsconfig paths). */
  aliases?: AliasMap;
}

/**
 * The projects to copy: source name → the projects that need it ([] when it was selected).
 * Throws for unknown or unsupported selections, and for needed projects that cannot be copied.
 */
export function selectProjects(input: SelectInput): Map<string, string[]> {
  const byName = new Map(input.projects.map((p) => [p.name, p]));
  const project = (n: string): SourceProject => {
    const p = byName.get(n);
    if (!p) throw new Error(`migrate: unknown source project "${n}".`);
    return p;
  };
  const q = (n: string) => `"${n}"`;
  let start: string[];
  if (input.requested && input.requested.length > 0) {
    const requested = [...new Set(input.requested)];
    const unknown = requested.filter((n) => !byName.has(n));
    if (unknown.length > 0) {
      throw new Error(
        `migrate: unknown project${unknown.length > 1 ? 's' : ''} ${unknown.map(q).join(', ')} ` +
          `in --projects. Projects in the source: ${[...byName.keys()].join(', ')}.`,
      );
    }
    const unsupported = requested.filter((n) => !isSupportedKind(project(n).kind));
    if (unsupported.length > 0) {
      throw new Error(
        `migrate: ${unsupported
          .map((n) => `${q(n)} (${describeKind(project(n).kind)})`)
          .join(', ')} ` +
          'cannot be migrated yet. Supported: Angular apps, Ionic and Capacitor Angular apps, Angular/TS libs and Flutter projects.',
      );
    }
    start = requested;
  } else {
    start = input.projects.filter((p) => isSupportedKind(p.kind)).map((p) => p.name);
    if (start.length === 0) {
      throw new Error(
        'migrate: the source has no project nx-polystack can migrate yet (Angular apps, ' +
          'Angular/TS libs, Flutter projects).',
      );
    }
  }

  const chosen = new Map<string, string[]>(start.map((n) => [n, []]));
  if (input.noDeps) return chosen;

  const aliases = input.aliases ?? readSourceAliases(input.sourceDir);
  const blocked = new Map<string, string[]>();
  const queue = [...start];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const dep of directDependencies(input.sourceDir, project(name), input.projects, aliases)) {
      const kind = project(dep).kind;
      if (!isSupportedKind(kind)) {
        blocked.set(dep, [...(blocked.get(dep) ?? []), name]);
        continue;
      }
      const needers = chosen.get(dep);
      if (needers === undefined) {
        chosen.set(dep, [name]);
        queue.push(dep);
      } else if (needers.length > 0 && !needers.includes(name)) {
        needers.push(name);
        needers.sort();
      }
    }
  }
  if (blocked.size > 0) {
    const lines = [...blocked].map(
      ([dep, needers]) =>
        `${q(dep)} (${project(dep).kind}) is needed by ${[...new Set(needers)].sort().join(', ')}`,
    );
    throw new Error(
      `migrate: ${lines.join('; ')} but cannot be migrated yet. Pass --no-deps to copy only the ` +
        'projects you name (their imports of it will not resolve).',
    );
  }
  return chosen;
}
