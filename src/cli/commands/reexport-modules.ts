import * as fs from 'fs';
import * as path from 'path';

import type * as TS from 'typescript';

import { addNamedImports } from './standalone-providers';
import { AngularProject, dropUnusedNamedImport } from './upgrade-standalone';

/*
 * Angular's prune-ng-modules mode deletes an NgModule that only re-exports standalone components
 * and drops it from the `imports` of the modules and components that use it, without importing the
 * components it exported: a template that used them then fails (`'lib-feed' is not a known
 * element`). That happens whenever an app imports a library's NgModule through its tsconfig path.
 *
 * Before that mode, pstack puts the exported components in place of such a module in every
 * `imports` array that names it, imported from the same path (when that path exports them) or,
 * for a relative import, from their own files. The schematic then finds the module unused and
 * deletes it as before.
 */

type Ts = typeof TS;
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** An NgModule that only re-exports standalone components, directives or pipes. */
export interface ReexportModule {
  name: string;
  file: string;
  exports: string[];
}

/** TypeScript files of a folder, spec files included (TestBed imports modules too). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function decoratorCall(
  ts: Ts,
  cls: TS.ClassDeclaration,
  name: string,
): TS.ObjectLiteralExpression | undefined {
  const decorators =
    ts.getDecorators?.(cls) ??
    ((cls as unknown as { decorators?: readonly TS.Decorator[] }).decorators || []);
  for (const d of decorators) {
    const e = d.expression;
    if (
      ts.isCallExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === name &&
      e.arguments.length === 1 &&
      ts.isObjectLiteralExpression(e.arguments[0])
    ) {
      return e.arguments[0];
    }
  }
  return undefined;
}

function prop(ts: Ts, obj: TS.ObjectLiteralExpression, name: string): TS.Expression | undefined {
  for (const p of obj.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === name
    ) {
      return p.initializer;
    }
  }
  return undefined;
}

const emptyArray = (ts: Ts, e: TS.Expression | undefined) =>
  e === undefined || (ts.isArrayLiteralExpression(e) && e.elements.length === 0);

/** Resolves a relative import to a .ts file (x.ts or x/index.ts). */
function resolveTs(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  for (const f of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return undefined;
}

/** The workspace's tsconfig paths, alias → absolute files. */
function aliasFiles(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
    let json: Json;
    try {
      json = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as Json;
    } catch {
      continue;
    }
    const co = json['compilerOptions'];
    if (!isObject(co) || !isObject(co['paths'])) continue;
    for (const [alias, targets] of Object.entries(co['paths'])) {
      if (alias.includes('*') || !Array.isArray(targets) || typeof targets[0] !== 'string')
        continue;
      out.set(alias, path.join(root, targets[0]));
    }
    break;
  }
  return out;
}

/** The files an entry file re-exports (`export * from` / `export { … } from`), one level. */
function reexportedFiles(entry: string): Map<string, string[] | '*'> {
  const out = new Map<string, string[] | '*'>();
  let text: string;
  try {
    text = fs.readFileSync(entry, 'utf8');
  } catch {
    return out;
  }
  for (const m of text.matchAll(/export\s*(\*|\{([^}]*)\})\s*from\s*['"]([^'"]+)['"]/g)) {
    const file = m[3].startsWith('.') ? resolveTs(entry, m[3]) : undefined;
    if (!file) continue;
    const names =
      m[1] === '*'
        ? '*'
        : m[2]
            .split(',')
            .map(
              (n) =>
                n
                  .trim()
                  .split(/\s+as\s+/)
                  .pop() ?? '',
            )
            .filter(Boolean);
    out.set(file, names);
  }
  return out;
}

/** Whether `name`, declared in `file`, is exported by the entry file (itself or one level down). */
function entryExports(entry: string, file: string, name: string): boolean {
  if (path.resolve(entry) === path.resolve(file)) return true;
  const names = reexportedFiles(entry).get(path.resolve(file));
  return names === '*' || (Array.isArray(names) && names.includes(name));
}

/**
 * NgModules under `scope` that only re-export standalone classes: no declarations, providers or
 * bootstrap, and every export a standalone component, directive or pipe of the workspace.
 */
export function findReexportModules(
  ts: Ts,
  files: string[],
  scope: string[],
  angularMajor: number,
): ReexportModule[] {
  const standalone = new Map<string, string[]>();
  const modules: { name: string; file: string; exports: string[] }[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/@(Component|Directive|Pipe|NgModule)\s*\(/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isClassDeclaration(st) || !st.name) continue;
      for (const kind of ['Component', 'Directive', 'Pipe']) {
        const obj = decoratorCall(ts, st, kind);
        if (!obj) continue;
        const flag = prop(ts, obj, 'standalone');
        const isStandalone =
          flag?.kind === ts.SyntaxKind.TrueKeyword || (flag === undefined && angularMajor >= 19);
        if (isStandalone)
          standalone.set(st.name.text, [...(standalone.get(st.name.text) ?? []), file]);
      }
      const mod = decoratorCall(ts, st, 'NgModule');
      if (!mod) continue;
      const exp = prop(ts, mod, 'exports');
      if (
        !emptyArray(ts, prop(ts, mod, 'declarations')) ||
        !emptyArray(ts, prop(ts, mod, 'providers')) ||
        prop(ts, mod, 'bootstrap') !== undefined ||
        !exp ||
        !ts.isArrayLiteralExpression(exp) ||
        exp.elements.length === 0 ||
        !exp.elements.every((e) => ts.isIdentifier(e))
      ) {
        continue;
      }
      modules.push({
        name: st.name.text,
        file,
        exports: exp.elements.map((e) => (e as TS.Identifier).text),
      });
    }
  }
  const inScope = (f: string) =>
    scope.some((s) => {
      const rel = path.relative(s, f);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  return modules.filter(
    (m) => inScope(m.file) && m.exports.every((e) => standalone.get(e)?.length === 1),
  );
}

export interface ReexportResult {
  /** Workspace-relative files written. */
  changed: string[];
  /** One line per replacement, for the log. */
  done: string[];
  /** Places left as they were, and why. */
  notes: string[];
}

/**
 * Replaces re-exporting NgModules in the `imports` arrays of the workspace's modules and
 * components with the classes they export (see the file comment). Writes the files.
 */
export function inlineReexportModules(
  ts: Ts,
  root: string,
  projects: AngularProject[],
  scope: string[],
  angularMajor: number,
): ReexportResult {
  const files = [...new Set(projects.flatMap((p) => sourceFiles(path.join(root, p.root))))];
  const absScope = scope.map((s) => path.resolve(root, s));
  const modules = findReexportModules(ts, files, absScope, angularMajor);
  const result: ReexportResult = { changed: [], done: [], notes: [] };
  if (modules.length === 0) return result;
  const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
  const aliases = aliasFiles(root);

  // Where each exported class is declared.
  const classFile = new Map<string, string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/export\s+(?:default\s+)?class\s+(\w+)/g)) {
      if (!classFile.has(m[1])) classFile.set(m[1], file);
    }
  }

  for (const file of files) {
    let text = fs.readFileSync(file, 'utf8');
    const touched = modules.filter(
      (m) => m.file !== file && new RegExp(`\\b${m.name}\\b`).test(text),
    );
    if (touched.length === 0) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const edits: Edit[] = [];
    const imports: { names: string[]; from: string; drop: string; spec: string }[] = [];
    for (const m of touched) {
      // The import of the module, and where it comes from.
      let spec: string | undefined;
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const nb = st.importClause?.namedBindings;
        if (!nb || !ts.isNamedImports(nb)) continue;
        if (nb.elements.some((e) => !e.propertyName && e.name.text === m.name)) {
          spec = st.moduleSpecifier.text;
        }
      }
      if (spec === undefined) continue;
      const target = spec.startsWith('.') ? resolveTs(file, spec) : aliases.get(spec);
      if (!target) continue;
      const fromModuleFile = path.resolve(target) === path.resolve(m.file);
      if (!fromModuleFile && !entryExports(target, m.file, m.name)) continue;

      // Every use must sit in a decorator's imports array.
      const uses: TS.Identifier[] = [];
      let other = false;
      const visit = (n: TS.Node) => {
        if (ts.isImportDeclaration(n)) return;
        if (ts.isIdentifier(n) && n.text === m.name) {
          const arr = n.parent;
          const okArray =
            ts.isArrayLiteralExpression(arr) &&
            ts.isPropertyAssignment(arr.parent) &&
            ts.isIdentifier(arr.parent.name) &&
            arr.parent.name.text === 'imports';
          if (okArray) uses.push(n);
          else other = true;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (other || uses.length === 0) {
        if (other) {
          result.notes.push(
            `${rel(file)}: ${
              m.name
            } is used outside an imports array; left (Angular's prune may drop it)`,
          );
        }
        continue;
      }

      // Where the exported classes come from: the same path when it exports them, else their files.
      const byFrom = new Map<string, string[]>();
      let unresolved: string | undefined;
      for (const e of m.exports) {
        const declared = classFile.get(e);
        if (!declared) {
          unresolved = e;
          break;
        }
        let from: string;
        if (!fromModuleFile && entryExports(target, declared, e)) from = spec;
        else {
          let r = path.relative(path.dirname(file), declared).split(path.sep).join('/');
          r = r.replace(/\.ts$/, '');
          from = r.startsWith('.') ? r : `./${r}`;
          if (!spec.startsWith('.')) {
            unresolved = e;
            break;
          }
        }
        byFrom.set(from, [...(byFrom.get(from) ?? []), e]);
      }
      if (unresolved) {
        result.notes.push(
          `${rel(file)}: ${m.name} left (${unresolved} is not exported where it is imported from)`,
        );
        continue;
      }
      const clash = m.exports.find(
        (e) =>
          new RegExp(`\\b${e}\\b`).test(text) &&
          ![...byFrom.entries()].some(
            ([from, names]) =>
              names.includes(e) &&
              new RegExp(
                `import\\s*\\{[^}]*\\b${e}\\b[^}]*\\}\\s*from\\s*['"]${from.replace(
                  /[.*+?^${}()|[\]\\/]/g,
                  '\\$&',
                )}['"]`,
              ).test(text),
          ),
      );
      if (clash) {
        result.notes.push(`${rel(file)}: ${m.name} left (${clash} is already a name in the file)`);
        continue;
      }
      for (const id of uses) {
        const arr = id.parent as TS.ArrayLiteralExpression;
        const present = new Set(
          arr.elements.filter((x) => ts.isIdentifier(x)).map((x) => (x as TS.Identifier).text),
        );
        const add = m.exports.filter((e) => !present.has(e));
        edits.push({ start: id.getStart(sf), end: id.getEnd(), text: add.join(', ') });
        if (add.length === 0) {
          // Remove the element and its comma.
          const i = arr.elements.indexOf(id);
          const next = arr.elements[i + 1];
          const prev = arr.elements[i - 1];
          edits[edits.length - 1] = next
            ? { start: id.getStart(sf), end: next.getStart(sf), text: '' }
            : prev
            ? { start: prev.getEnd(), end: id.getEnd(), text: '' }
            : { start: id.getStart(sf), end: id.getEnd(), text: '' };
        }
      }
      for (const [from, names] of byFrom) imports.push({ names, from, drop: m.name, spec });
      result.done.push(
        `${rel(file)}: imports ${m.exports.join(', ')} instead of ${
          m.name
        } (Angular's prune drops the module, not what it exported)`,
      );
    }
    if (edits.length === 0) continue;
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
    }
    for (const i of imports) text = addNamedImports(text, i.names, i.from);
    for (const i of imports) text = dropUnusedNamedImport(text, i.drop, i.spec);
    fs.writeFileSync(file, text);
    result.changed.push(rel(file));
  }
  return result;
}

/**
 * Angular's standalone schematic imports a class it moves into a component from the file that
 * declares it, also across projects (`../../../../libs/feed/src/lib/feed/feed.page`): Nx's
 * enforce-module-boundaries rule rejects that. Such an import goes back to the library's tsconfig
 * path when that path exports every name it imports (merged into an existing import from the
 * path). Writes the files; returns one line per file changed.
 */
export function aliasCrossProjectImports(root: string, projects: AngularProject[]): string[] {
  const aliases = aliasFiles(root);
  if (aliases.size === 0) return [];
  const within = (f: string, p: AngularProject) => {
    const r = path.relative(path.join(root, p.root), f);
    return !r.startsWith('..') && !path.isAbsolute(r);
  };
  const owner = (f: string) =>
    projects.filter((p) => within(f, p)).sort((a, b) => b.root.length - a.root.length)[0];
  const done: string[] = [];
  for (const p of projects) {
    for (const file of sourceFiles(path.join(root, p.root))) {
      if (owner(file) !== p) continue;
      let text = fs.readFileSync(file, 'utf8');
      const before = text;
      const moved: string[] = [];
      for (const m of [
        ...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]*)['"];?[ \t]*\n?/g),
      ]) {
        const target = resolveTs(file, m[2]);
        if (!target) continue;
        const other = owner(target);
        if (!other || other === p) continue;
        const names = m[1]
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean);
        if (names.length === 0 || names.some((n) => /\s+as\s+|^type\s/.test(n))) continue;
        const alias = [...aliases.entries()].find(
          ([, entry]) => within(entry, other) && names.every((n) => entryExports(entry, target, n)),
        )?.[0];
        if (!alias) continue;
        text = text.replace(m[0], '');
        text = addNamedImports(text, names, alias);
        moved.push(`${names.join(', ')} from ${alias}`);
      }
      if (text === before) continue;
      fs.writeFileSync(file, text);
      done.push(
        `${path.relative(root, file).split(path.sep).join('/')}: imports ${moved.join('; ')} ` +
          '(not by a relative path into another project)',
      );
    }
  }
  return done;
}
