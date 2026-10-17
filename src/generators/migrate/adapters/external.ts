import * as fs from 'fs';
import * as Module from 'module';
import * as path from 'path';

import { NAME_RE } from '../names';

import { AnyMigrationAdapter, MIGRATE_API_VERSION } from './types';

import { ADAPTERS } from './index';

/**
 * Adapters a workspace adds to :migrate: nx.json `"pstack": { "migrateAdapters": [...] }` lists
 * workspace-relative .js/.ts files or package names. Each module exports one adapter or a list
 * (as `default`, `adapters`, `adapter`, or the module itself).
 */

export { MIGRATE_API_VERSION };

export interface NxJsonWithPstack {
  pstack?: { migrateAdapters?: unknown };
}

const fail = (entry: string, why: string): never => {
  throw new Error(
    `migrate: nx.json pstack.migrateAdapters entry "${entry}": ${why.replace(/\.?$/, '.')} ` +
      'Fix it, or remove the ' +
      'entry to migrate with the built-in adapters.',
  );
};

/** The listed entries; [] when nx.json has none. Throws on a malformed list. */
export function adapterEntries(nxJson: NxJsonWithPstack | undefined): string[] {
  const list = nxJson?.pstack?.migrateAdapters;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.some((e) => typeof e !== 'string' || e.trim() === '')) {
    throw new Error(
      'migrate: nx.json pstack.migrateAdapters must be a list of file paths or package names.',
    );
  }
  return list.map((e: string) => e.trim());
}

type TsModule = typeof import('typescript');

/**
 * Node's own `module`: `process.getBuiltinModule` (Node 20.16+) bypasses any module registry the
 * host installs (Jest's), so ES modules and our hooks go through Node itself.
 */
type NodeModule = typeof Module & {
  _extensions: Record<string, unknown>;
  _resolveFilename(request: string, parent: unknown, ...rest: unknown[]): string;
};
const nodeModule = ((
  process as unknown as { getBuiltinModule?: (id: string) => unknown }
).getBuiltinModule?.('module') ?? Module) as NodeModule;
/** Node's require, which loads ES modules synchronously on Node 20.19+ and 22.12+. */
const nativeRequire = nodeModule.createRequire(__filename);

const TS_FILE = /\.(ts|mts|cts)$/;

function loadTypeScript(root: string, entry: string): TsModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(require.resolve('typescript', { paths: [root, __dirname] }));
  } catch {
    return fail(
      entry,
      'is a TypeScript file, but the workspace has no `typescript` package to load it.',
    );
  }
}

/**
 * The workspace tsconfig.base.json compilerOptions (decorators, jsx, …) for transpiling adapters;
 * module and target are always CommonJS / ES2020. `paths` are resolved by tsScope (NX-63).
 */
function workspaceCompilerOptions(
  ts: TsModule,
  root: string,
): import('typescript').CompilerOptions {
  const file = ['tsconfig.base.json', 'tsconfig.json']
    .map((f) => path.join(root, f))
    .find((f) => fs.existsSync(f));
  if (!file) return {};
  const read = ts.readConfigFile(file, ts.sys.readFile);
  if (read.error) return {};
  return ts.convertCompilerOptionsFromJson(read.config?.compilerOptions ?? {}, root).options;
}

/** A require hook that transpiles a .ts module to CommonJS with `ts` (exported for tests). */
export function typeScriptHook(ts: TsModule, base: import('typescript').CompilerOptions = {}) {
  return (
    mod: { _compile(code: string, file: string, format?: string): void },
    file: string,
  ): void => {
    const source = fs.readFileSync(file, 'utf8');
    const out = ts.transpileModule(source, {
      // TypeScript always emits ESM for an .mts name; as .ts it follows `module: CommonJS`.
      fileName: file.replace(/\.[mc]ts$/, '.ts'),
      compilerOptions: {
        ...base,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
        inlineSourceMap: true,
        sourceMap: false,
        declaration: false,
        noEmit: false,
        // tslib may not be next to the adapter; verbatimModuleSyntax conflicts with CommonJS.
        importHelpers: false,
        verbatimModuleSyntax: false,
      },
    });
    // The output is CommonJS; the format keeps Node from treating an .mts name as ESM.
    mod._compile(out.outputText, file, 'commonjs');
  };
}

/**
 * Requires `file` with our TypeScript hook installed for .ts files, and only for the time of
 * that require (also for the .ts files it imports). Node's own type stripping or another loader
 * would load an adapter's `import` syntax as ESM, which cannot be required.
 */
type TsScope = <T>(fn: () => T) => T;

/**
 * Runs `fn` with our TypeScript hook installed for .ts files, then restores the previous handler.
 * Used for the require of a listed .ts entry and for every call into its adapters, so .ts files
 * they load later (a lazy require or `import()`) transpile the same way.
 */
function tsScope(root: string, entry: string, file: string): TsScope {
  if (!TS_FILE.test(file)) return (fn) => fn();
  const ts = loadTypeScript(root, entry);
  const options = workspaceCompilerOptions(ts, root);
  const hook = typeScriptHook(ts, options);
  const resolvePaths = pathsResolver(options, root);
  return (fn) => {
    const previous = new Map<string, unknown>();
    for (const ext of ['.ts', '.mts', '.cts']) {
      previous.set(ext, nodeModule._extensions[ext]);
      nodeModule._extensions[ext] = hook;
    }
    const resolveFilename = nodeModule._resolveFilename;
    nodeModule._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
      const from = (parent as { filename?: string } | undefined)?.filename;
      const mapped =
        from && !from.split(path.sep).includes('node_modules') ? resolvePaths(request) : undefined;
      if (mapped) {
        for (const candidate of mapped) {
          try {
            return resolveFilename.call(this, candidate, parent, ...rest);
          } catch {
            // try the next target
          }
        }
      }
      return resolveFilename.call(this, request, parent, ...rest);
    };
    try {
      return fn();
    } finally {
      nodeModule._resolveFilename = resolveFilename;
      for (const [ext, h] of previous) {
        if (h === undefined) delete nodeModule._extensions[ext];
        else nodeModule._extensions[ext] = h;
      }
    }
  };
}

/**
 * tsconfig `paths` of the workspace: request → absolute candidates, in order (`*` wildcard; the
 * longest matching prefix wins, as in TypeScript). Undefined when no key matches.
 */
export function pathsResolver(
  options: { paths?: Record<string, string[]>; baseUrl?: string; pathsBasePath?: unknown },
  root: string,
): (request: string) => string[] | undefined {
  const paths = options.paths ?? {};
  const base =
    options.baseUrl ?? (typeof options.pathsBasePath === 'string' ? options.pathsBasePath : root);
  const keys = Object.keys(paths).sort(
    (a, b) => b.replace(/\*.*$/, '').length - a.replace(/\*.*$/, '').length,
  );
  return (request) => {
    if (request.startsWith('.') || path.isAbsolute(request)) return undefined;
    for (const key of keys) {
      const star = key.indexOf('*');
      let rest: string | undefined;
      if (star < 0) rest = request === key ? '' : undefined;
      else {
        const pre = key.slice(0, star);
        const post = key.slice(star + 1);
        if (request.startsWith(pre) && request.endsWith(post) && request.length >= key.length - 1) {
          rest = request.slice(pre.length, request.length - post.length);
        }
      }
      if (rest === undefined) continue;
      return (paths[key] ?? []).map((t) =>
        path.resolve(
          base,
          t.replace('*', () => rest as string),
        ),
      );
    }
    return undefined;
  };
}

/**
 * An .mts / .cts file compiled with the TypeScript hook installed by tsScope (to CommonJS). Not
 * through require: recent Node sends .mts to its own ES module loader, which skips the hook.
 */
function compileTs(file: string): unknown {
  const Ctor = nodeModule as unknown as {
    new (id: string, parent?: unknown): {
      filename: string;
      paths: string[];
      loaded: boolean;
      exports: unknown;
    };
    _nodeModulePaths(dir: string): string[];
  };
  const mod = new Ctor(file);
  mod.filename = file;
  mod.paths = Ctor._nodeModulePaths(path.dirname(file));
  (nodeModule._extensions['.ts'] as (m: unknown, f: string) => void)(mod, file);
  mod.loaded = true;
  return mod.exports;
}

/** ES module by extension or by the nearest package.json `"type": "module"`. */
function isEsmFile(file: string): boolean {
  if (file.endsWith('.mjs')) return true;
  if (!file.endsWith('.js')) return false;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        return (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { type?: string }).type === 'module';
      } catch {
        return false;
      }
    }
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * Loads an adapter module: ES modules, `.mts` and `.cts` through Node's own require (which
 * loads ES modules synchronously on Node 20.19+ / 22.12+), others through the plugin's require.
 */
function loadModule(entry: string, file: string, scope: TsScope): unknown {
  try {
    if (/\.(mts|cts)$/.test(file)) return scope(() => compileTs(file));
    return scope(() => (isEsmFile(file) ? nativeRequire(file) : require(file)));
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === 'ERR_REQUIRE_ASYNC_MODULE') {
      return fail(
        entry,
        'is an ES module with top-level await; adapters are loaded synchronously, so move the ' +
          'await into the adapter functions.',
      );
    }
    if (code === 'ERR_REQUIRE_ESM') {
      return fail(
        entry,
        `is an ES module; loading it needs Node 20.19+ or 22.12+ (this is Node ${process.versions.node}).`,
      );
    }
    throw err;
  }
}

function resolveEntry(root: string, entry: string): string {
  if (entry.startsWith('.') || path.isAbsolute(entry)) {
    const file = path.resolve(root, entry);
    const candidates = [
      file,
      ...['.ts', '.js', '.mts', '.cts', '.mjs', '.cjs'].map((ext) => `${file}${ext}`),
      ...['index.js', 'index.mjs', 'index.ts'].map((f) => path.join(file, f)),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return fail(entry, `no such file (looked for ${path.relative(root, file) || file}).`);
  }
  try {
    return require.resolve(entry, { paths: [root] });
  } catch {
    // An ESM-only package has no `require` export: resolve it through its exports (NX-63).
    return (
      resolveEsmPackage(root, entry) ??
      fail(entry, 'the package is not installed in the workspace.')
    );
  }
}

type Exports = string | null | Exports[] | { [key: string]: Exports };
const CONDITIONS = new Set(['node', 'require', 'import', 'module', 'default']);

/** One target of a package `exports` value for the conditions above (object order wins). */
function exportTarget(value: Exports): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = exportTarget(v);
      if (t) return t;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, v] of Object.entries(value)) {
    if (CONDITIONS.has(key)) {
      const t = exportTarget(v);
      if (t) return t;
    }
  }
  return undefined;
}

/** `<name>[/<subpath>]` of an installed package, read from its package.json `exports`/`module`/`main`. */
function resolveEsmPackage(root: string, entry: string): string | undefined {
  const parts = entry.split('/');
  const nameLength = entry.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLength).join('/');
  const sub = parts.slice(nameLength).join('/');
  for (let dir = root; ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, 'node_modules', name);
    const pkgFile = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgFile)) {
      let pkg: { exports?: Exports; module?: string; main?: string };
      try {
        pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      } catch {
        return undefined;
      }
      const key = sub ? `./${sub}` : '.';
      let target: string | undefined;
      const ex = pkg.exports;
      if (ex !== undefined) {
        const map =
          ex &&
          typeof ex === 'object' &&
          !Array.isArray(ex) &&
          Object.keys(ex).some((k) => k.startsWith('.'))
            ? (ex as { [k: string]: Exports })
            : { '.': ex };
        if (map[key] !== undefined) target = exportTarget(map[key]);
        else {
          // Subpath patterns: "./*" → "./dist/*.js".
          for (const [k, v] of Object.entries(map)) {
            const star = k.indexOf('*');
            if (star < 0) continue;
            const pre = k.slice(0, star);
            const post = k.slice(star + 1);
            if (key.startsWith(pre) && key.endsWith(post) && key.length >= k.length - 1) {
              const hit = exportTarget(v);
              const part = key.slice(pre.length, key.length - post.length);
              target = hit?.replace(/\*/g, () => part);
              break;
            }
          }
        }
      } else if (!sub) target = pkg.module ?? pkg.main ?? 'index.js';
      else target = sub;
      if (!target) return undefined;
      const file = path.resolve(pkgDir, target);
      return fs.existsSync(file) ? file : undefined;
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}

function adaptersOf(mod: unknown): unknown[] {
  const m = mod as Record<string, unknown> | undefined;
  const picked = m?.['default'] ?? m?.['adapters'] ?? m?.['adapter'] ?? m;
  return Array.isArray(picked) ? picked : [picked];
}

function validate(entry: string, a: unknown, taken: Map<string, string>): AnyMigrationAdapter {
  const x = a as Record<string, unknown> | undefined;
  if (!x || typeof x !== 'object') return fail(entry, 'does not export an adapter object.');
  const id = x['id'];
  if (typeof id !== 'string' || !NAME_RE.test(id)) {
    return fail(entry, `adapter id ${JSON.stringify(id)} must be kebab-case.`);
  }
  if (x['apiVersion'] !== MIGRATE_API_VERSION) {
    return fail(
      entry,
      `adapter "${id}" declares apiVersion ${JSON.stringify(x['apiVersion'])}; this nx-polystack ` +
        `supports apiVersion ${MIGRATE_API_VERSION}. Update the adapter or nx-polystack.`,
    );
  }
  const owner = taken.get(id);
  if (owner) return fail(entry, `adapter id "${id}" is already used by ${owner}.`);
  if (x['kind'] !== undefined && x['kind'] !== 'app' && x['kind'] !== 'workspace') {
    return fail(entry, `adapter "${id}" has kind ${JSON.stringify(x['kind'])} (app or workspace).`);
  }
  for (const fn of ['detect', 'defaultName', 'migrate'] as const) {
    if (typeof x[fn] !== 'function') return fail(entry, `adapter "${id}" has no ${fn}() function.`);
  }
  if (x['kind'] === 'workspace' && typeof x['preflight'] !== 'function') {
    return fail(entry, `workspace adapter "${id}" has no preflight() function.`);
  }
  if (x['preflight'] !== undefined && typeof x['preflight'] !== 'function') {
    return fail(entry, `adapter "${id}" has a preflight that is not a function.`);
  }
  if (typeof x['label'] !== 'string' || x['label'] === '') {
    return fail(entry, `adapter "${id}" has no label.`);
  }
  taken.set(id, `"${entry}"`);
  return x as unknown as AnyMigrationAdapter;
}

/**
 * The adapter with its errors (from defaultName, preflight, migrate) prefixed by its id and entry,
 * so a failure inside an external adapter is not taken for an nx-polystack one.
 */
function guarded(entry: string, a: AnyMigrationAdapter, scope: TsScope): AnyMigrationAdapter {
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      try {
        return scope(() => fn.apply(a, args));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const prefix = `adapter "${a.id}" (${entry}): `;
        if (message.startsWith(prefix)) throw err;
        const wrapped = new Error(`${prefix}${message.replace(/^migrate: /, '')}`);
        if (err instanceof Error) wrapped.stack = err.stack;
        throw wrapped;
      }
    };
  // Object.create keeps the adapter's prototype (class instances, getters for id or label).
  const copy = Object.create(a) as Record<string, unknown>;
  for (const k of ['detect', 'defaultName', 'preflight', 'migrate']) {
    const fn = (a as unknown as Record<string, unknown>)[k];
    if (typeof fn === 'function') {
      let value = wrap(fn as (...x: unknown[]) => unknown);
      if (k === 'migrate') {
        // The install task runs later: keep the TypeScript hook and paths around it too.
        const migrate = value;
        value = (...args: unknown[]) => {
          const data = migrate(...args) as { installTask?: () => unknown } | undefined;
          const task = data?.installTask;
          if (data && typeof task === 'function') {
            data.installTask = () => scope(() => task.call(data));
          }
          return data;
        };
      }
      Object.defineProperty(copy, k, { value, enumerable: true });
    }
  }
  return copy as unknown as AnyMigrationAdapter;
}

/** Reads nx.json for the adapter list: undefined when missing; throws when it is not JSON. */
export function parseNxJson(text: string | null | undefined): NxJsonWithPstack | undefined {
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text) as NxJsonWithPstack;
  } catch (err) {
    throw new Error(
      `migrate: nx.json is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

/** Loads and checks the workspace's external adapters. Throws, naming the entry, on any problem. */
export function loadExternalAdapters(
  root: string,
  nxJson: NxJsonWithPstack | undefined,
): AnyMigrationAdapter[] {
  const entries = adapterEntries(nxJson);
  if (entries.length === 0) return [];
  const taken = new Map<string, string>(ADAPTERS.map((a) => [a.id, 'a built-in adapter']));
  const out: AnyMigrationAdapter[] = [];
  for (const entry of entries) {
    const file = resolveEntry(root, entry);
    const scope = tsScope(root, entry, file);
    let mod: unknown;
    try {
      mod = loadModule(entry, file, scope);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('migrate: nx.json')) throw err;
      fail(entry, `could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
    const list = adaptersOf(mod);
    if (list.length === 0) fail(entry, 'exports an empty adapter list.');
    for (const a of list) out.push(guarded(entry, validate(entry, a, taken), scope));
  }
  return out;
}
