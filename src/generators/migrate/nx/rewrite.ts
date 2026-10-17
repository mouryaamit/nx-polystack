import { isObject, Json } from './workspace-source';

/** Nx 15/16 executor names → the Nx 17 ones the workspace has. */
export function renameExecutor(executor: string): string {
  if (executor === '@nrwl/workspace:run-commands') return 'nx:run-commands';
  if (executor === '@nrwl/linter:eslint' || executor === '@nx/linter:eslint') {
    return '@nx/eslint:lint';
  }
  const m = /^@nrwl\/([^:]+):(.+)$/.exec(executor);
  return m ? `@nx/${m[1]}:${m[2]}` : executor;
}

/** "@nx/angular:package" → "@nx/angular"; undefined for other executors. */
export function nxPluginPackage(executor: string): string | undefined {
  return /^(@nx\/[^:]+):/.exec(executor)?.[1];
}

/** "<project>:<target>[:<config>]" with the project renamed when it is in `renames`. */
export function renameTargetReference(value: string, renames: ReadonlyMap<string, string>): string {
  const i = value.indexOf(':');
  if (i <= 0) return value;
  const to = renames.get(value.slice(0, i));
  return to ? `${to}${value.slice(i)}` : value;
}

const TARGET_REF = /^(buildTarget|browserTarget|devServerTarget|serverTarget)$/;

function renameRefs(options: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (!isObject(options)) return options;
  const out: Json = {};
  for (const [k, v] of Object.entries(options)) {
    out[k] = TARGET_REF.test(k) && typeof v === 'string' ? renameTargetReference(v, renames) : v;
  }
  return out;
}

type DropFn = (name: string) => void;

const KEEP_NAMES = new Set(['*', 'self', 'dependencies']);

/** A project name (optionally "!"-negated) renamed; undefined, reported, when it is not copied. */
function renameName(
  n: string,
  renames: ReadonlyMap<string, string>,
  onDrop: DropFn,
): string | undefined {
  const negated = n.startsWith('!');
  const bare = negated ? n.slice(1) : n;
  if (KEEP_NAMES.has(bare)) return n;
  const to = renames.get(bare);
  if (to === undefined) {
    onDrop(n);
    return undefined;
  }
  return negated ? `!${to}` : to;
}

function renameNames(
  list: unknown[],
  renames: ReadonlyMap<string, string>,
  onDrop: DropFn,
): unknown[] {
  return list.flatMap((n) => {
    if (typeof n !== 'string') return [n];
    const to = renameName(n, renames, onDrop);
    return to === undefined ? [] : [to];
  });
}

function rewriteTarget(
  target: unknown,
  renames: ReadonlyMap<string, string>,
  onDrop: DropFn,
): unknown {
  if (!isObject(target)) return target;
  const out: Json = { ...target };
  if (typeof out['executor'] === 'string')
    out['executor'] = renameExecutor(out['executor'] as string);
  if (out['options'] !== undefined) out['options'] = renameRefs(out['options'], renames);
  if (isObject(out['configurations'])) {
    out['configurations'] = Object.fromEntries(
      Object.entries(out['configurations'] as Json).map(([c, o]) => [c, renameRefs(o, renames)]),
    );
  }
  if (Array.isArray(out['dependsOn'])) {
    out['dependsOn'] = (out['dependsOn'] as unknown[]).flatMap((d) => {
      if (!isObject(d) || d['projects'] === undefined) return [d];
      const projects = d['projects'];
      if (Array.isArray(projects)) {
        const kept = renameNames(projects, renames, onDrop);
        return kept.length > 0 ? [{ ...d, projects: kept }] : [];
      }
      if (typeof projects !== 'string') return [d];
      const to = renameName(projects, renames, onDrop);
      return to === undefined ? [] : [{ ...d, projects: to }];
    });
  }
  return out;
}

/**
 * Source project configuration → workspace project.json: `name` first, implicitDependencies,
 * executors, target references and dependsOn projects follow `renames`. Names of projects that
 * are not in `renames` (not copied) are removed and passed to `onDrop`.
 */
export function rewriteProjectConfig(
  config: Json,
  name: string,
  renames: ReadonlyMap<string, string>,
  onDrop: DropFn = () => undefined,
): Json {
  const rest: Json = { ...config };
  delete rest['name'];
  const out: Json = { name, ...rest };
  if (Array.isArray(out['implicitDependencies'])) {
    out['implicitDependencies'] = renameNames(
      out['implicitDependencies'] as unknown[],
      renames,
      onDrop,
    );
  }
  if (isObject(out['targets'])) {
    out['targets'] = Object.fromEntries(
      Object.entries(out['targets'] as Json).map(([t, target]) => [
        t,
        rewriteTarget(target, renames, onDrop),
      ]),
    );
  }
  return out;
}

/** Executors used in a (rewritten) project configuration. */
export function executorsOf(config: Json): string[] {
  const targets = isObject(config['targets']) ? (config['targets'] as Json) : {};
  return Object.values(targets)
    .map((t) => (isObject(t) && typeof t['executor'] === 'string' ? (t['executor'] as string) : ''))
    .filter(Boolean);
}

const ESLINT_PLUGIN = (p: unknown) => (p === '@nrwl/nx' ? '@nx' : p);
const ESLINT_EXTENDS = (e: unknown) =>
  typeof e === 'string' ? e.replace(/^plugin:@nrwl\/nx\//, 'plugin:@nx/') : e;
const ESLINT_RULE = (r: string) => r.replace(/^@nrwl\/nx\//, '@nx/');

/** `@nrwl/nx` plugin, `plugin:@nrwl/nx/*` extends and `@nrwl/nx/*` rules → `@nx`, recursively. */
export function rewriteEslintConfig(config: Json): Json {
  const out: Json = { ...config };
  if (Array.isArray(out['plugins']))
    out['plugins'] = (out['plugins'] as unknown[]).map(ESLINT_PLUGIN);
  if (Array.isArray(out['extends']))
    out['extends'] = (out['extends'] as unknown[]).map(ESLINT_EXTENDS);
  else if (typeof out['extends'] === 'string') out['extends'] = ESLINT_EXTENDS(out['extends']);
  if (isObject(out['rules'])) {
    out['rules'] = Object.fromEntries(
      Object.entries(out['rules'] as Json).map(([k, v]) => [ESLINT_RULE(k), v]),
    );
  }
  if (Array.isArray(out['overrides'])) {
    out['overrides'] = (out['overrides'] as unknown[]).map((o) =>
      isObject(o) ? rewriteEslintConfig(o) : o,
    );
  }
  return out;
}

const BOUNDARIES = /^@(nx|nrwl\/nx)\/enforce-module-boundaries$/;

/** depConstraints of every enforce-module-boundaries rule, as JSON strings. */
export function depConstraints(config: Json): string[] {
  const out: string[] = [];
  const visit = (c: Json) => {
    if (isObject(c['rules'])) {
      for (const [rule, value] of Object.entries(c['rules'] as Json)) {
        if (!BOUNDARIES.test(rule) || !Array.isArray(value) || !isObject(value[1])) continue;
        const constraints = (value[1] as Json)['depConstraints'];
        if (Array.isArray(constraints)) out.push(...constraints.map((x) => JSON.stringify(x)));
      }
    }
    if (Array.isArray(c['overrides'])) {
      for (const o of c['overrides'] as unknown[]) if (isObject(o)) visit(o);
    }
  };
  visit(config);
  return out;
}

/** Option keys whose string values (or array entries, or { input } entries) are paths. */
const PATH_KEYS = new Set([
  'main',
  'index',
  'tsConfig',
  'polyfills',
  'styles',
  'scripts',
  'assets',
  'karmaConfig',
  'jestConfig',
  'eslintConfig',
  'lintFilePatterns',
  'project',
  'proxyConfig',
  'ngswConfigPath',
  'includePaths',
  'replace',
  'with',
]);

/**
 * Path-valued options that point outside every copied project root (globs cut at the first
 * `*`), keeping only those whose first segment exists (`exists`, relative to the workspace or
 * source root) so package names are not reported. Sorted, unique.
 */
export function outsidePaths(
  config: Json,
  copiedRoots: string[],
  exists: (p: string) => boolean,
): string[] {
  const found = new Set<string>();
  const check = (value: string) => {
    const p = value.replace(/^!/, '').split('*')[0].replace(/\/$/, '');
    if (!p.includes('/') || p.startsWith('node_modules/') || p.startsWith('@')) return;
    if (copiedRoots.some((r) => p === r || p.startsWith(`${r}/`))) return;
    if (exists(p.split('/')[0])) found.add(p);
  };
  const visit = (key: string, value: unknown) => {
    if (PATH_KEYS.has(key)) {
      if (typeof value === 'string') check(value);
      else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string') check(v);
          else if (isObject(v) && typeof v['input'] === 'string') check(v['input'] as string);
        }
      }
    }
    if (Array.isArray(value)) value.forEach((v) => visit('', v));
    else if (isObject(value)) for (const [k, v] of Object.entries(value)) visit(k, v);
  };
  visit('', config['targets']);
  return [...found].sort();
}
