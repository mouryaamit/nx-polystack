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
 * module and target are always CommonJS / ES2020. `paths` aliases are not resolved.
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
  return (mod: { _compile(code: string, file: string): void }, file: string): void => {
    const source = fs.readFileSync(file, 'utf8');
    const out = ts.transpileModule(source, {
      fileName: file,
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
    mod._compile(out.outputText, file);
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
  if (!file.endsWith('.ts')) return (fn) => fn();
  const ts = loadTypeScript(root, entry);
  const hook = typeScriptHook(ts, workspaceCompilerOptions(ts, root));
  return (fn) => {
    const extensions = (Module as unknown as { _extensions: Record<string, unknown> })._extensions;
    const previous = extensions['.ts'];
    extensions['.ts'] = hook;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete extensions['.ts'];
      else extensions['.ts'] = previous;
    }
  };
}

function resolveEntry(root: string, entry: string): string {
  if (entry.startsWith('.') || path.isAbsolute(entry)) {
    const file = path.resolve(root, entry);
    for (const candidate of [file, `${file}.ts`, `${file}.js`, path.join(file, 'index.js')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return fail(entry, `no such file (looked for ${path.relative(root, file) || file}).`);
  }
  try {
    return require.resolve(entry, { paths: [root] });
  } catch {
    return fail(entry, 'the package is not installed in the workspace.');
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
      Object.defineProperty(copy, k, {
        value: wrap(fn as (...x: unknown[]) => unknown),
        enumerable: true,
      });
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
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = scope(() => require(file));
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
