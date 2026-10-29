import * as fs from 'fs';
import * as path from 'path';

import type * as TS from 'typescript';

import { dropUnusedNamedImport } from './upgrade-standalone';

/**
 * The provider tidy-up after Angular's standalone-bootstrap mode, which leaves NgModule leftovers
 * in `importProvidersFrom(...)`:
 *
 * - `BrowserModule`: `bootstrapApplication` already provides it, so it is dropped;
 * - the root routing module (`@NgModule({ imports: [RouterModule.forRoot(routes, options)],
 *   exports: [RouterModule] })`): becomes `provideRouter(routes, ...features)`, and the module
 *   file becomes a routes file (`app-routing.module.ts` → `app.routes.ts`) exporting the routes.
 *
 * Anything it cannot convert safely (other decorator fields, router options without a feature,
 * other importers of the routing module) is left as it is and named in the notes.
 */

type Ts = typeof TS;

export interface ProvidersResult {
  /** Absolute path → new text (written by the caller). */
  writes: Map<string, string>;
  /** Absolute old path → absolute new path (renamed by the caller, after the writes). */
  renames: Map<string, string>;
  /** What changed, for the log (workspace-relative paths). */
  done: string[];
  /** What was left as it is, and why. */
  notes: string[];
}

/** typescript from the workspace (every Angular workspace has it), else undefined. */
export function loadTypescript(root: string): Ts | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(require.resolve('typescript', { paths: [root] })) as Ts;
  } catch {
    return undefined;
  }
}

interface Feature {
  call: string;
  /** Names the call needs from @angular/router. */
  names: string[];
}

interface RoutingPlan {
  /** The routing module's file. */
  file: string;
  /** The routes file after the change (the same file, or the renamed one). */
  routesFile: string;
  /** The exported routes constant. */
  routesName: string;
  features: Feature[];
  /** New text of the routing file (written at `file`, then renamed to `routesFile`). */
  text: string;
}

const ROUTER_CONFIG_OPTIONS = new Set([
  'onSameUrlNavigation',
  'paramsInheritanceStrategy',
  'urlUpdateStrategy',
  'canceledNavigationResolution',
]);

const SCROLLING_OPTIONS = new Set(['scrollPositionRestoration', 'anchorScrolling']);

const isLiteral = (ts: Ts, n: TS.Expression): boolean =>
  ts.isStringLiteral(n) ||
  ts.isNoSubstitutionTemplateLiteral(n) ||
  n.kind === ts.SyntaxKind.TrueKeyword ||
  n.kind === ts.SyntaxKind.FalseKeyword;

const propName = (ts: Ts, p: TS.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;

/** Named imports of a file: local name → module specifier. */
function namedImports(ts: Ts, sf: TS.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) out.set(el.name.text, st.moduleSpecifier.text);
    }
  }
  return out;
}

/** A relative import specifier → the .ts file it names, when it exists. */
function resolveRelative(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const f of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

/** A relative specifier from one file to another, without the .ts extension. */
function relativeSpec(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  rel = rel.replace(/\.ts$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** router options → provideRouter features; a string names the option it cannot convert. */
function routerFeatures(
  ts: Ts,
  options: TS.Expression | undefined,
  imports: Map<string, string>,
  angularMajor: number,
): Feature[] | string {
  if (!options) return [];
  if (!ts.isObjectLiteralExpression(options)) return 'options that are not an object literal';
  const features: Feature[] = [];
  const scrolling: string[] = [];
  const config: string[] = [];
  for (const p of options.properties) {
    const name = propName(ts, p);
    if (!name || !ts.isPropertyAssignment(p)) return 'a computed or shorthand option';
    const v = p.initializer;
    const isTrue = v.kind === ts.SyntaxKind.TrueKeyword;
    const isFalse = v.kind === ts.SyntaxKind.FalseKeyword;
    const text = v.getText();
    if (name === 'useHash' && (isTrue || isFalse)) {
      if (isTrue) features.push({ call: 'withHashLocation()', names: ['withHashLocation'] });
    } else if (name === 'enableTracing' && (isTrue || isFalse)) {
      if (isTrue) features.push({ call: 'withDebugTracing()', names: ['withDebugTracing'] });
    } else if (name === 'initialNavigation' && ts.isStringLiteral(v)) {
      if (v.text === 'enabledBlocking') {
        features.push({
          call: 'withEnabledBlockingInitialNavigation()',
          names: ['withEnabledBlockingInitialNavigation'],
        });
      } else if (v.text === 'disabled') {
        features.push({
          call: 'withDisabledInitialNavigation()',
          names: ['withDisabledInitialNavigation'],
        });
      } else if (v.text !== 'enabledNonBlocking') {
        return `initialNavigation: ${text}`;
      }
    } else if (name === 'preloadingStrategy' && ts.isIdentifier(v)) {
      // Only strategies from @angular/router: others would need their own import moved.
      if (imports.get(v.text) !== '@angular/router') return `preloadingStrategy: ${text}`;
      features.push({ call: `withPreloading(${v.text})`, names: ['withPreloading', v.text] });
    } else if (name === 'bindToComponentInputs' && (isTrue || isFalse) && angularMajor >= 16) {
      if (isTrue) {
        features.push({
          call: 'withComponentInputBinding()',
          names: ['withComponentInputBinding'],
        });
      }
    } else if (SCROLLING_OPTIONS.has(name) && isLiteral(ts, v)) {
      scrolling.push(`${name}: ${text}`);
    } else if (ROUTER_CONFIG_OPTIONS.has(name) && isLiteral(ts, v)) {
      config.push(`${name}: ${text}`);
    } else {
      return `${name}: ${text}`;
    }
  }
  if (scrolling.length > 0) {
    features.push({
      call: `withInMemoryScrolling({ ${scrolling.join(', ')} })`,
      names: ['withInMemoryScrolling'],
    });
  }
  if (config.length > 0) {
    features.push({
      call: `withRouterConfig({ ${config.join(', ')} })`,
      names: ['withRouterConfig'],
    });
  }
  return features;
}

/** Files under dir (recursive) that import `target` by a relative specifier. */
function importersOf(ts: Ts, dir: string, target: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && p !== target) {
        const sf = ts.createSourceFile(p, fs.readFileSync(p, 'utf8'), ts.ScriptTarget.Latest);
        const hit = sf.statements.some(
          (st) =>
            (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
            st.moduleSpecifier !== undefined &&
            ts.isStringLiteral(st.moduleSpecifier) &&
            resolveRelative(p, st.moduleSpecifier.text) === target,
        );
        if (hit) out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** Removes [start, end) and the line break right after it. */
function cut(text: string, start: number, end: number): string {
  const after = text.slice(end).replace(/^[ \t]*\r?\n/, '');
  return text.slice(0, start) + after;
}

/**
 * The root routing module `name` imported by `bootstrapFile`: a plan to turn it into a routes file,
 * or a reason it stays.
 */
function planRouting(
  ts: Ts,
  bootstrapFile: string,
  name: string,
  spec: string,
  srcDir: string,
  angularMajor: number,
): RoutingPlan | string {
  const file = resolveRelative(bootstrapFile, spec);
  if (!file) return `${name}: ${spec} not found`;
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = namedImports(ts, sf);
  const cls = sf.statements.find(
    (st): st is TS.ClassDeclaration => ts.isClassDeclaration(st) && st.name?.text === name,
  );
  if (!cls) return `${name}: no class ${name} in ${path.basename(file)}`;
  if (cls.members.length > 0) return `${name} has members`;
  const decorators = (ts.canHaveDecorators?.(cls) ? ts.getDecorators?.(cls) : undefined) ?? [];
  if (decorators.length !== 1) return `${name}: not a plain @NgModule`;
  const call = decorators[0].expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== 'NgModule' ||
    call.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(call.arguments[0])
  ) {
    return `${name}: not a plain @NgModule`;
  }
  let forRoot: TS.CallExpression | undefined;
  for (const p of call.arguments[0].properties) {
    const key = propName(ts, p);
    if (!key || !ts.isPropertyAssignment(p) || !ts.isArrayLiteralExpression(p.initializer)) {
      return `${name}: @NgModule has more than imports and exports`;
    }
    const els = p.initializer.elements;
    if (key === 'exports') {
      if (!els.every((e) => ts.isIdentifier(e) && e.text === 'RouterModule')) {
        return `${name} exports more than RouterModule`;
      }
    } else if (key === 'imports') {
      const only = els.length === 1 ? els[0] : undefined;
      if (
        !only ||
        !ts.isCallExpression(only) ||
        !ts.isPropertyAccessExpression(only.expression) ||
        only.expression.expression.getText() !== 'RouterModule' ||
        only.expression.name.text !== 'forRoot'
      ) {
        return `${name} imports more than RouterModule.forRoot(...)`;
      }
      forRoot = only;
    } else {
      return `${name}: @NgModule has ${key}`;
    }
  }
  if (!forRoot || forRoot.arguments.length < 1 || forRoot.arguments.length > 2) {
    return `${name}: no RouterModule.forRoot(routes)`;
  }
  const features = routerFeatures(ts, forRoot.arguments[1], imports, angularMajor);
  if (typeof features === 'string') return `${name}: router option ${features} has no feature`;

  const others = importersOf(ts, srcDir, file).filter((f) => f !== bootstrapFile);
  if (others.length > 0) {
    return `${name} is also imported by ${others.map((f) => path.basename(f)).join(', ')}`;
  }

  // The routes: a const declared in the file (exported if it was not), or an inline array.
  const routesArg = forRoot.arguments[0];
  let routesName = 'routes';
  let out = text;
  const edits: { start: number; end: number; text: string }[] = [];
  if (ts.isIdentifier(routesArg)) {
    const decl = sf.statements.find(
      (st): st is TS.VariableStatement =>
        ts.isVariableStatement(st) &&
        st.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === routesArg.text,
        ),
    );
    if (!decl) return `${name}: ${routesArg.text} is not declared in ${path.basename(file)}`;
    if ((decl.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return `${name}: ${routesArg.text} is not a const`;
    }
    routesName = routesArg.text;
    const exported = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) {
      const at = decl.getStart(sf);
      edits.push({ start: at, end: at, text: 'export ' });
    }
    edits.push({ start: cls.getStart(sf, true), end: cls.getEnd(), text: '' });
  } else if (ts.isArrayLiteralExpression(routesArg)) {
    if (imports.has('routes') || /\broutes\b/.test(text.replace(routesArg.getText(), ''))) {
      return `${name}: inline routes, and the name "routes" is taken`;
    }
    edits.push({
      start: cls.getStart(sf, true),
      end: cls.getEnd(),
      text: `export const routes: Routes = ${routesArg.getText()};`,
    });
  } else {
    return `${name}: routes passed as ${routesArg.getText()}`;
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = e.text
      ? out.slice(0, e.start) + e.text + out.slice(e.end)
      : cut(out, e.start, e.end).replace(/\n{3,}/g, '\n\n');
  }
  out = dropUnusedNamedImport(out, 'NgModule', '@angular/core');
  out = dropUnusedNamedImport(out, 'RouterModule', '@angular/router');
  if (
    /\bRoutes\b/.test(out) &&
    !/import\s*\{[^}]*\bRoutes\b[^}]*\}\s*from\s*['"]@angular\/router['"]/.test(out)
  ) {
    out = addNamedImports(out, ['Routes'], '@angular/router');
  }
  out = `${out.replace(/^\n+/, '').replace(/\n*$/, '')}\n`;

  const m = /^(.*)-routing\.module\.ts$/.exec(path.basename(file));
  const renamed = m ? path.join(path.dirname(file), `${m[1]}.routes.ts`) : file;
  const routesFile = renamed !== file && fs.existsSync(renamed) ? file : renamed;
  return { file, routesFile, routesName, features, text: out };
}

/** Adds names to the named import from `from` (or a new import after the last import). */
export function addNamedImports(text: string, names: string[], from: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${esc}['"];?`);
  const m = re.exec(text);
  if (m) {
    const have = m[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const all = [...have, ...names.filter((n) => !have.includes(n))];
    return text.replace(m[0], `import { ${all.join(', ')} } from '${from}';`);
  }
  const line = `import { ${names.join(', ')} } from '${from}';\n`;
  const imports = [...text.matchAll(/^import\b[^;]*;[ \t]*\n/gm)];
  const last = imports[imports.length - 1];
  if (!last || last.index === undefined) return line + text;
  const at = last.index + last[0].length;
  return text.slice(0, at) + line + text.slice(at);
}

/**
 * Rewrites the `importProvidersFrom(...)` calls of one bootstrap file (main.ts or app.config.ts) of
 * an app. `root` is the workspace root (for the log's relative paths).
 */
export function tidyStandaloneProviders(
  ts: Ts,
  root: string,
  bootstrapFile: string,
  srcDir: string,
  angularMajor: number,
  result: ProvidersResult,
): void {
  const rel = (f: string) => path.relative(root, f).split(path.sep).join('/');
  const text = result.writes.get(bootstrapFile) ?? fs.readFileSync(bootstrapFile, 'utf8');
  const sf = ts.createSourceFile(bootstrapFile, text, ts.ScriptTarget.Latest, true);
  const imports = namedImports(ts, sf);
  if (imports.get('importProvidersFrom') !== '@angular/core') return;

  const calls: TS.CallExpression[] = [];
  const visit = (n: TS.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'importProvidersFrom' &&
      n.parent &&
      ts.isArrayLiteralExpression(n.parent)
    ) {
      calls.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (calls.length === 0) return;

  const edits: { start: number; end: number; text: string }[] = [];
  const routerNames = new Set<string>();
  const dropped: string[] = [];
  const routeImports: { name: string; spec: string }[] = [];
  for (const call of calls) {
    const keep: string[] = [];
    const add: string[] = [];
    for (const arg of call.arguments) {
      if (
        ts.isIdentifier(arg) &&
        arg.text === 'BrowserModule' &&
        imports.get('BrowserModule') === '@angular/platform-browser'
      ) {
        dropped.push('BrowserModule');
        continue;
      }
      const spec = ts.isIdentifier(arg) ? imports.get(arg.text) : undefined;
      if (ts.isIdentifier(arg) && spec?.startsWith('.')) {
        const file = resolveRelative(bootstrapFile, spec);
        const src = file ? fs.readFileSync(file, 'utf8') : '';
        if (/RouterModule\s*\.\s*forRoot\s*\(/.test(src)) {
          const plan = planRouting(ts, bootstrapFile, arg.text, spec, srcDir, angularMajor);
          if (typeof plan === 'string') {
            result.notes.push(`${rel(bootstrapFile)}: ${plan}; left in importProvidersFrom`);
            keep.push(arg.getText());
            continue;
          }
          result.writes.set(plan.file, plan.text);
          if (plan.routesFile !== plan.file) result.renames.set(plan.file, plan.routesFile);
          const routeArgs = [plan.routesName, ...plan.features.map((f) => f.call)];
          add.push(`provideRouter(${routeArgs.join(', ')})`);
          routerNames.add('provideRouter');
          plan.features.forEach((f) => f.names.forEach((n) => routerNames.add(n)));
          dropped.push(arg.text);
          routeImports.push({
            name: plan.routesName,
            spec: relativeSpec(bootstrapFile, plan.routesFile),
          });
          result.done.push(
            `${rel(plan.file)}: ${arg.text} → ${rel(plan.routesFile)} (export const ${
              plan.routesName
            })`,
          );
          continue;
        }
      }
      keep.push(arg.getText());
    }
    if (keep.length === call.arguments.length && add.length === 0) continue;
    const replacement = [
      ...(keep.length > 0 ? [`importProvidersFrom(${keep.join(', ')})`] : []),
      ...add,
    ];
    if (replacement.length > 0) {
      edits.push({ start: call.getStart(sf), end: call.getEnd(), text: replacement.join(', ') });
    } else {
      // Drop the element with its separating comma.
      const arr = call.parent as TS.ArrayLiteralExpression;
      const i = arr.elements.indexOf(call);
      const start = i > 0 ? arr.elements[i - 1].getEnd() : call.getStart(sf);
      const end =
        i > 0
          ? call.getEnd()
          : i + 1 < arr.elements.length
          ? arr.elements[i + 1].getStart(sf)
          : call.getEnd();
      edits.push({ start, end, text: '' });
    }
  }
  if (edits.length === 0) return;
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  for (const n of [...dropped, 'importProvidersFrom']) {
    const from = n === 'importProvidersFrom' ? '@angular/core' : imports.get(n);
    if (from) out = dropUnusedNamedImport(out, n, from);
  }
  if (routerNames.size > 0) out = addNamedImports(out, [...routerNames], '@angular/router');
  for (const r of routeImports) out = addNamedImports(out, [r.name], r.spec);
  result.writes.set(bootstrapFile, out);
  const what = [
    ...dropped.filter((d) => d === 'BrowserModule').map(() => 'BrowserModule dropped'),
    ...(routerNames.has('provideRouter') ? ['provideRouter instead of the routing module'] : []),
  ];
  result.done.unshift(`${rel(bootstrapFile)}: ${what.join(', ')}`);
}
