import * as fs from 'fs';
import * as path from 'path';

import type * as TS from 'typescript';

import { ionicAngularImport, ionicStandaloneImport } from '../../lib/utils/angular-deps';
import {
  iconExportName,
  ionTagClass,
  moduleExports,
  STATIC_ION_CLASSES,
} from '../../lib/utils/ionic-tags';

import { addNamedImports, loadTypescript } from './standalone-providers';
import {
  AngularProject,
  dropUnusedNamedImport,
  standaloneMain,
  tsFiles,
} from './upgrade-standalone';

/**
 * The `ionic-standalone` step of `pstack upgrade standalone` (default since v1.18.0): moves an
 * Ionic app that bootstraps with `bootstrapApplication` from Ionic's lazy build (`IonicModule`) to Ionic's
 * standalone components:
 *
 * 1. `importProvidersFrom(IonicModule.forRoot(config))` → `provideIonicAngular(config)` in
 *    `main.ts` / `app/app.config.ts`;
 * 2. each standalone component drops `IonicModule` from `imports` and imports the `Ion*` classes
 *    of the `ion-*` tags in its template (plus `IonRouterLink` / `IonRouterLinkWithHref` next to
 *    `routerLink`);
 * 3. other names imported from Ionic's NgModule entry move to the standalone entry;
 * 4. `<ion-icon name="literal">` names are registered with `addIcons` in the component constructor;
 * 5. the ionicons svg asset leaves the build options when no icon name is left that `addIcons`
 *    could not register.
 *
 * All or nothing per app: when one file cannot be converted safely, none of the app's files change
 * and the reasons are reported. An app with no `IonicModule` left is not touched (a rerun changes
 * nothing).
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

export interface IonicContext {
  ts: Ts;
  root: string;
  /** Angular major of the workspace. */
  major: number;
  /** Where the standalone components come from. */
  standaloneEntry: string;
  /** Entries whose imports move to the standalone entry. */
  moving: ReadonlySet<string>;
  /** `Ion*` classes the standalone entry exports. */
  classes: ReadonlySet<string>;
  /** Every name the standalone entry exports, when it is installed. */
  exports?: ReadonlySet<string>;
  /** `ionicons/icons` export names, when installed. */
  icons?: ReadonlySet<string>;
}

export interface IonicAppResult {
  /** Absolute path → new text; empty when the app is skipped. */
  writes: Map<string, string>;
  done: string[];
  notes: string[];
  /** Why the app is left as it is (no file changed). */
  reasons: string[];
}

interface AppScan extends IonicAppResult {
  /** Icon names addIcons cannot register (bound, unknown, or outside an ion-icon name). */
  loose: string[];
  /** provideIonicAngular is (or will be) in the app's providers. */
  providers: boolean;
}

/** The context for an Angular major, with the installed Ionic and ionicons exports when present. */
export function ionicContext(ts: Ts, root: string, major: number): IonicContext {
  const standaloneEntry = ionicStandaloneImport(major);
  const moving = new Set([ionicAngularImport(major)]);
  // Ionic 9 has no /standalone entry; @ionic/migrate moves those imports, this catches leftovers.
  if (standaloneEntry !== '@ionic/angular/standalone') moving.add('@ionic/angular/standalone');
  moving.delete(standaloneEntry);
  const exports = moduleExports(ts, root, standaloneEntry);
  const installed = exports ? [...exports].filter((n) => /^Ion[A-Z]/.test(n)) : [];
  return {
    ts,
    root,
    major,
    standaloneEntry,
    moving,
    classes: installed.length > 0 ? new Set(installed) : STATIC_ION_CLASSES,
    exports,
    icons: moduleExports(ts, root, 'ionicons/icons'),
  };
}

/** The source folder of a project: <root>/src, or the project root when it has no src. */
export function projectSrc(root: string, project: AngularProject): string {
  const src = path.join(root, project.root, 'src');
  return fs.existsSync(src) ? src : path.join(root, project.root);
}

/** Whether the project's sources still import IonicModule from @ionic/angular (spec files aside). */
function usesIonicModule(root: string, project: AngularProject): boolean {
  return tsFiles(projectSrc(root, project)).some((f) => {
    const text = fs.readFileSync(f, 'utf8');
    return /\bIonicModule\b/.test(text) && /['"]@ionic\/angular(\/lazy)?['"]/.test(text);
  });
}

/** An app whose sources still import IonicModule from @ionic/angular (spec files aside). */
export function isIonicApp(root: string, project: AngularProject): boolean {
  return project.app && usesIonicModule(root, project);
}

/** A library whose sources still import IonicModule from @ionic/angular (spec files aside). */
export function isIonicLib(root: string, project: AngularProject): boolean {
  return !project.app && usesIonicModule(root, project);
}

export interface TemplateTag {
  name: string;
  attrs: { name: string; value?: string }[];
}

/** Opening tags of an HTML template with their attributes (quoted values may hold `>`). */
export function scanTags(html: string): TemplateTag[] {
  const out: TemplateTag[] = [];
  let i = 0;
  while ((i = html.indexOf('<', i)) >= 0) {
    const m = /^<([a-zA-Z][\w-]*)/.exec(html.slice(i, i + 200));
    if (!m) {
      i++;
      continue;
    }
    let j = i + m[0].length;
    const attrs: TemplateTag['attrs'] = [];
    while (j < html.length) {
      while (j < html.length && /\s/.test(html[j])) j++;
      if (html[j] === '>') {
        j++;
        break;
      }
      if (html.startsWith('/>', j)) {
        j += 2;
        break;
      }
      const a = /^[^\s=>"'/]+/.exec(html.slice(j));
      if (!a) {
        j++;
        continue;
      }
      j += a[0].length;
      let k = j;
      while (k < html.length && /\s/.test(html[k])) k++;
      let value: string | undefined;
      if (html[k] === '=') {
        k++;
        while (k < html.length && /\s/.test(html[k])) k++;
        const q = html[k];
        if (q === '"' || q === "'") {
          const end = html.indexOf(q, k + 1);
          value = html.slice(k + 1, end < 0 ? html.length : end);
          j = end < 0 ? html.length : end + 1;
        } else {
          const u = /^[^\s>]+/.exec(html.slice(k));
          value = u ? u[0] : '';
          j = k + value.length;
        }
      }
      attrs.push({ name: a[0], value });
    }
    out.push({ name: m[1], attrs });
    i = j;
  }
  return out;
}

const ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface TemplateNeeds {
  classes: Set<string>;
  /** kebab-case icon names to register. */
  icons: Set<string>;
}

/** The Ion* classes and icons a template needs; problems go to reasons, loose icon names to loose. */
function templateNeeds(
  c: IonicContext,
  html: string,
  where: string,
  reasons: string[],
  loose: string[],
): TemplateNeeds {
  const needs: TemplateNeeds = { classes: new Set(), icons: new Set() };
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const found = [...clean.matchAll(/<(ion-[a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  const tags = scanTags(clean);
  const scanned = tags.filter((t) => t.name.startsWith('ion-'));
  if (scanned.length !== found.length) {
    reasons.push(`${where}: the template's ion-* tags could not be read reliably`);
    return needs;
  }
  const need = (cls: string, what: string) => {
    if (c.classes.has(cls)) needs.classes.add(cls);
    else reasons.push(`${where}: ${what} has no standalone ${cls} in ${c.standaloneEntry}`);
  };
  for (const tag of tags) {
    const ion = tag.name.startsWith('ion-');
    if (ion) need(ionTagClass(tag.name), `<${tag.name}>`);
    const bare = (n: string) => n.replace(/^\[(attr\.)?/, '').replace(/\]$/, '');
    if (tag.attrs.some((a) => bare(a.name) === 'routerLink')) {
      if (ion) need('IonRouterLink', `routerLink on <${tag.name}>`);
      else if (tag.name === 'a') need('IonRouterLinkWithHref', 'routerLink on <a>');
    }
    if (!ion) continue;
    for (const a of tag.attrs) {
      const name = bare(a.name);
      const shown = `${where}: <${tag.name} ${a.name}${
        a.value !== undefined ? `="${a.value}"` : ''
      }>`;
      if (tag.name === 'ion-icon' && ['name', 'ios', 'md'].includes(name)) {
        let literal: string | undefined;
        if (a.name.startsWith('[')) {
          literal = /^\s*'([^']*)'\s*$/.exec(a.value ?? '')?.[1];
        } else if (a.value !== undefined && !a.value.includes('{{')) {
          literal = a.value;
        }
        if (literal === undefined) loose.push(`${shown} (bound name)`);
        else if (!ICON_NAME.test(literal)) loose.push(`${shown} (not an icon name)`);
        else if (c.icons && !c.icons.has(iconExportName(literal)))
          loose.push(`${shown} (not in ionicons/icons)`);
        else needs.icons.add(literal);
      } else if (
        (tag.name === 'ion-icon' && name === 'icon') ||
        (tag.name !== 'ion-icon' && /icon$/i.test(name))
      ) {
        loose.push(`${shown} (icon name outside ion-icon name)`);
      }
    }
  }
  return needs;
}

/** The decorator call (`Component`, `NgModule`, …) a node sits in, if any. */
function enclosingDecorator(ts: Ts, node: TS.Node): string | undefined {
  for (let n: TS.Node | undefined = node; n; n = n.parent) {
    if (ts.isDecorator(n)) {
      const e = n.expression;
      return ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : '?';
    }
  }
  return undefined;
}

const propName = (ts: Ts, p: TS.ObjectLiteralElementLike): string | undefined =>
  p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;

/** Leading whitespace of the line a node starts on. */
function indentOf(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/** The edit that registers icons in a class constructor; a string is why it cannot. */
function iconEdit(
  ts: Ts,
  sf: TS.SourceFile,
  cls: TS.ClassDeclaration,
  icons: [string, string][],
): Edit | string | undefined {
  const text = sf.text;
  const fmt = ([key, local]: [string, string]) => (key === local ? key : `${key}: ${local}`);
  let existing: TS.CallExpression | undefined;
  const find = (n: TS.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'addIcons'
    ) {
      existing = n;
    }
    if (!existing) ts.forEachChild(n, find);
  };
  find(cls);
  if (existing) {
    const obj = existing.arguments[0];
    if (existing.arguments.length !== 1 || !ts.isObjectLiteralExpression(obj)) {
      return 'its addIcons call does not take an object literal';
    }
    const have = new Set(obj.properties.map((p) => propName(ts, p)));
    const add = icons.filter(([key]) => !have.has(key));
    if (add.length === 0) return undefined;
    const props = [...obj.properties.map((p) => p.getText(sf)), ...add.map(fmt)];
    return { start: obj.getStart(sf), end: obj.getEnd(), text: `{ ${props.join(', ')} }` };
  }
  const line = `addIcons({ ${icons.map(fmt).join(', ')} });`;
  const memberIndent =
    cls.members.length > 0
      ? indentOf(text, cls.members[0].getStart(sf))
      : `${indentOf(text, cls.getStart(sf))}  `;
  const ctor = cls.members.find(
    (m): m is TS.ConstructorDeclaration => ts.isConstructorDeclaration(m) && m.body !== undefined,
  );
  if (ctor?.body) {
    const first = ctor.body.statements[0];
    const superFirst =
      first !== undefined &&
      ts.isExpressionStatement(first) &&
      ts.isCallExpression(first.expression) &&
      first.expression.expression.kind === ts.SyntaxKind.SuperKeyword;
    if (superFirst) {
      const at = first.getEnd();
      return { start: at, end: at, text: `\n${indentOf(text, first.getStart(sf))}${line}` };
    }
    if (first) {
      const at = first.getStart(sf);
      return { start: at, end: at, text: `${line}\n${indentOf(text, at)}` };
    }
    const ci = indentOf(text, ctor.getStart(sf));
    return {
      start: ctor.body.getStart(sf),
      end: ctor.body.getEnd(),
      text: `{\n${ci}  ${line}\n${ci}}`,
    };
  }
  if (cls.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) {
    return 'it extends another class and has no constructor to register icons in';
  }
  const ctorText = `constructor() {\n${memberIndent}  ${line}\n${memberIndent}}`;
  let anchor: TS.ClassElement | undefined;
  for (const m of cls.members) {
    if (!ts.isPropertyDeclaration(m)) break;
    anchor = m;
  }
  if (anchor) {
    return { start: anchor.getEnd(), end: anchor.getEnd(), text: `\n\n${memberIndent}${ctorText}` };
  }
  const at = cls.members.pos;
  const after = cls.members.length > 0 ? '\n' : '';
  return { start: at, end: at, text: `\n${memberIndent}${ctorText}\n${after}` };
}

/** Converts one source file of an app into app (writes, done, reasons). */
function convertFile(c: IonicContext, file: string, app: AppScan): void {
  const { ts } = c;
  const rel = path.relative(c.root, file).split(path.sep).join('/');
  const text = fs.readFileSync(file, 'utf8');
  // Icon names in code (overlay buttons, toasts, …) only work through the svg asset.
  for (const m of text.matchAll(/\b\w*[iI]con\s*:\s*['"`]([^'"`]*)['"`]/g)) {
    app.loose.push(`${rel}: ${m[0]} (icon name in code)`);
  }
  if (/\bprovideIonicAngular\s*\(/.test(text)) app.providers = true;
  if (!/@ionic\/angular|@Component\s*\(/.test(text)) return;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const reasons: string[] = [];
  const edits: Edit[] = [];
  const what: string[] = [];

  // Imports from Ionic's entries.
  const merged = new Map<string, string>();
  const standaloneDecls: TS.ImportDeclaration[] = [];
  const movingDecls: TS.ImportDeclaration[] = [];
  const moved: string[] = [];
  let ionicModule: string | undefined;
  let lastImport: TS.ImportDeclaration | undefined;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    lastImport = st;
    const spec = st.moduleSpecifier.text;
    const moving = c.moving.has(spec);
    if (!moving && spec !== c.standaloneEntry) continue;
    const clause = st.importClause;
    if (
      !clause ||
      clause.name ||
      !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    ) {
      if (moving) reasons.push(`${rel}: the import from '${spec}' is not a named import`);
      continue;
    }
    for (const el of clause.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === 'IonicModule') {
        if (el.propertyName) reasons.push(`${rel}: IonicModule is imported under another name`);
        ionicModule = el.name.text;
        continue;
      }
      if (moving && c.exports && !c.exports.has(imported)) {
        reasons.push(`${rel}: ${imported} is not exported by ${c.standaloneEntry}`);
      }
      if (moving) moved.push(el.name.text);
      const elText = clause.isTypeOnly ? `type ${el.getText(sf)}` : el.getText(sf);
      if (!merged.has(el.name.text)) merged.set(el.name.text, elText);
    }
    (moving ? movingDecls : standaloneDecls).push(st);
  }

  // Where IonicModule is used.
  const componentRefs = new Map<TS.ClassDeclaration, TS.ArrayLiteralExpression>();
  const forRoots: TS.CallExpression[] = [];
  if (ionicModule) {
    const local = ionicModule;
    const visit = (n: TS.Node) => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isIdentifier(n) && n.text === local) {
        const p = n.parent;
        const decorator = enclosingDecorator(ts, n);
        const isImportsArray =
          ts.isArrayLiteralExpression(p) &&
          ts.isPropertyAssignment(p.parent) &&
          propName(ts, p.parent) === 'imports';
        if (isImportsArray && decorator === 'Component') {
          let cls: TS.Node | undefined = p;
          while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent;
          if (cls) componentRefs.set(cls as TS.ClassDeclaration, p as TS.ArrayLiteralExpression);
        } else if (
          ts.isPropertyAccessExpression(p) &&
          p.name.text === 'forRoot' &&
          ts.isCallExpression(p.parent) &&
          p.parent.expression === p &&
          ts.isCallExpression(p.parent.parent) &&
          ts.isIdentifier(p.parent.parent.expression) &&
          p.parent.parent.expression.text === 'importProvidersFrom' &&
          ts.isArrayLiteralExpression(p.parent.parent.parent) &&
          ['main.ts', 'app.config.ts'].includes(path.basename(file))
        ) {
          forRoots.push(p.parent);
        } else if (decorator === 'NgModule') {
          reasons.push(`${rel}: an NgModule still imports IonicModule`);
        } else {
          reasons.push(
            `${rel}: IonicModule is used outside a component's imports or importProvidersFrom`,
          );
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  // provideIonicAngular instead of IonicModule.forRoot.
  const added = new Set<string>();
  const swaps = new Map<TS.CallExpression, TS.CallExpression[]>();
  for (const f of forRoots) {
    const call = f.parent as TS.CallExpression;
    swaps.set(call, [...(swaps.get(call) ?? []), f]);
  }
  for (const [call, roots] of swaps) {
    const keep = call.arguments.filter((a) => !roots.includes(a as TS.CallExpression));
    const provides = roots.map(
      (r) => `provideIonicAngular(${r.arguments.map((a) => a.getText(sf)).join(', ')})`,
    );
    const parts = [
      ...(keep.length > 0
        ? [`importProvidersFrom(${keep.map((a) => a.getText(sf)).join(', ')})`]
        : []),
      ...provides,
    ];
    edits.push({ start: call.getStart(sf), end: call.getEnd(), text: parts.join(', ') });
    added.add('provideIonicAngular');
    app.providers = true;
    what.push('provideIonicAngular() instead of IonicModule.forRoot()');
  }

  // Components.
  const icons: [string, string][] = [];
  const iconImports = new Set<string>();
  for (const cls of sf.statements.filter(ts.isClassDeclaration)) {
    const decorators = (ts.canHaveDecorators?.(cls) ? ts.getDecorators?.(cls) : undefined) ?? [];
    const dec = decorators.find(
      (d) =>
        ts.isCallExpression(d.expression) &&
        ts.isIdentifier(d.expression.expression) &&
        d.expression.expression.text === 'Component',
    );
    if (!dec) continue;
    const name = cls.name?.text ?? 'a component';
    const where = `${rel} (${name})`;
    const meta = (dec.expression as TS.CallExpression).arguments[0];
    if (!meta || !ts.isObjectLiteralExpression(meta)) {
      reasons.push(`${where}: @Component metadata is not an object literal`);
      continue;
    }
    const props = new Map<string, TS.ObjectLiteralElementLike>();
    for (const p of meta.properties) {
      const key = propName(ts, p);
      if (key) props.set(key, p);
    }
    const value = (key: string) => {
      const p = props.get(key);
      return p && ts.isPropertyAssignment(p) ? p.initializer : p ? null : undefined;
    };
    const literal = (e: TS.Expression | null | undefined) =>
      e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;
    let html: string | undefined;
    let templateRange: [number, number] | undefined;
    const tpl = value('template');
    const url = value('templateUrl');
    if (tpl !== undefined) {
      html = literal(tpl);
      if (html === undefined) {
        reasons.push(`${where}: the template is built at runtime`);
        continue;
      }
      if (tpl) templateRange = [tpl.getStart(sf), tpl.getEnd()];
    } else if (url !== undefined) {
      const u = literal(url);
      const f = u !== undefined ? path.resolve(path.dirname(file), u) : undefined;
      if (!f || !fs.existsSync(f)) {
        reasons.push(`${where}: template ${u ?? url?.getText(sf) ?? '?'} not found`);
        continue;
      }
      html = fs.readFileSync(f, 'utf8');
    }
    const needs = html
      ? templateNeeds(c, html, where, reasons, app.loose)
      : { classes: new Set<string>(), icons: new Set<string>() };
    const ionicArray = componentRefs.get(cls);
    if (needs.classes.size === 0 && needs.icons.size === 0 && !ionicArray) continue;
    const standalone = value('standalone');
    const isStandalone =
      standalone?.kind === ts.SyntaxKind.TrueKeyword || (standalone === undefined && c.major >= 19);
    if (!isStandalone) {
      reasons.push(`${where}: not a standalone component`);
      continue;
    }
    const importsValue = value('imports');
    if (importsValue === null || (importsValue && !ts.isArrayLiteralExpression(importsValue))) {
      reasons.push(`${where}: imports is not an array literal`);
      continue;
    }
    const importsInit = importsValue as TS.ArrayLiteralExpression | undefined;
    const existing = importsInit ? importsInit.elements.map((e) => e.getText(sf)) : [];
    const ionClasses = [...needs.classes].sort();
    const next = [
      ...existing.filter((e) => e !== ionicModule),
      ...ionClasses.filter((n) => !existing.includes(n)),
    ];
    if (importsInit) {
      if (next.join() !== existing.join()) {
        edits.push({
          start: importsInit.getStart(sf),
          end: importsInit.getEnd(),
          text: `[${next.join(', ')}]`,
        });
      }
    } else if (next.length > 0) {
      const after = props.get('standalone') ?? props.get('selector');
      const at = after ? after.getEnd() : meta.getStart(sf) + 1;
      const ind = indentOf(text, (after ?? meta.properties[0] ?? meta).getStart(sf));
      edits.push({
        start: at,
        end: at,
        text: after ? `,\n${ind}imports: [${next.join(', ')}]` : ` imports: [${next.join(', ')}],`,
      });
    }
    ionClasses.forEach((n) => added.add(n));
    const parts = [
      ...(ionicArray ? ['IonicModule out'] : []),
      ...(ionClasses.length > 0 ? [ionClasses.join(', ')] : []),
    ];
    if (needs.icons.size > 0) {
      // A local name an icon import would shadow gets an alias.
      const outside = templateRange
        ? text.slice(0, templateRange[0]) + text.slice(templateRange[1])
        : text;
      const mine: [string, string][] = [];
      for (const kebab of [...needs.icons].sort()) {
        const key = iconExportName(kebab);
        let local = key;
        if (new RegExp(`\\b${key}\\b`).test(outside)) local = `${key}Icon`;
        if (local !== key && new RegExp(`\\b${local}\\b`).test(outside)) {
          reasons.push(`${where}: icon ${kebab} clashes with names in the file`);
          continue;
        }
        mine.push([key, local]);
      }
      const e = iconEdit(ts, sf, cls, mine);
      if (typeof e === 'string') {
        reasons.push(`${where}: ${e}`);
        continue;
      }
      if (e) {
        edits.push(e);
        icons.push(...mine);
        mine.forEach(([key, local]) => iconImports.add(key === local ? key : `${key} as ${local}`));
        parts.push(`addIcons(${mine.map(([k]) => k).join(', ')})`);
      }
    }
    what.push(`${name}: ${parts.join('; ')}`);
  }

  if (reasons.length > 0) {
    app.reasons.push(...reasons);
    return;
  }
  if (edits.length === 0 && movingDecls.length === 0) return;
  if (moved.length > 0) what.push(`${moved.join(', ')} from ${c.standaloneEntry}`);

  // One import from the standalone entry, where the first Ionic import was.
  for (const n of added) if (!merged.has(n)) merged.set(n, n);
  const decls = [...standaloneDecls, ...movingDecls].sort((a, b) => a.pos - b.pos);
  const typeOnly = [...merged.values()].every((v) => v.startsWith('type '));
  const line =
    merged.size === 0
      ? ''
      : typeOnly
      ? `import type { ${[...merged.values()].map((v) => v.slice(5)).join(', ')} } from '${
          c.standaloneEntry
        }';`
      : `import { ${[...merged.values()].join(', ')} } from '${c.standaloneEntry}';`;
  decls.forEach((d, i) => {
    let end = d.getEnd();
    if (i > 0 || !line) end += /^\r?\n/.exec(text.slice(end))?.[0].length ?? 0;
    edits.push({ start: d.getStart(sf), end, text: i === 0 ? line : '' });
  });
  if (decls.length === 0 && line) {
    const at = lastImport ? lastImport.getEnd() : 0;
    edits.push({ start: at, end: at, text: lastImport ? `\n${line}` : `${line}\n` });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  if (icons.length > 0) {
    out = addNamedImports(out, ['addIcons'], 'ionicons');
    out = addNamedImports(out, [...iconImports], 'ionicons/icons');
  }
  if (swaps.size > 0) out = dropUnusedNamedImport(out, 'importProvidersFrom', '@angular/core');
  if (out === text) return;
  app.writes.set(file, out);
  app.done.push(`${rel}: ${what.join('; ')}`);
}

/** Spec files of a directory tree (not converted; reported when they use IonicModule). */
function specFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.spec.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The workspace's tsconfig paths (tsconfig.base.json, else tsconfig.json). */
function tsconfigPaths(root: string): Json {
  for (const name of ['tsconfig.base.json', 'tsconfig.json']) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as Json;
      const co = json['compilerOptions'];
      if (isObject(co) && isObject(co['paths'])) return co['paths'];
    } catch {
      // no such tsconfig, or not plain JSON
    }
  }
  return {};
}

/** Import aliases (tsconfig paths) that point into a library. */
function libAliases(paths: Json, lib: AngularProject): string[] {
  return Object.entries(paths)
    .filter(
      ([, targets]) =>
        Array.isArray(targets) &&
        targets.some(
          (t) => typeof t === 'string' && t.replace(/^\.\//, '').startsWith(`${lib.root}/`),
        ),
    )
    .map(([alias]) => alias.replace(/\/\*$/, ''));
}

/** The aliases among these that some file imports (or re-exports from). */
function importedAliases(files: string[], aliases: string[]): string[] {
  const texts = files.map((f) => fs.readFileSync(f, 'utf8'));
  return aliases.filter((alias) => {
    const esc = alias.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const re = new RegExp(`from\\s*['"]${esc}(/[^'"]*)?['"]`);
    return texts.some((t) => re.test(t));
  });
}

/** Import aliases of libraries whose sources still use IonicModule. */
function ionicModuleLibAliases(root: string, libs: AngularProject[]): string[] {
  const withModule = libs.filter((l) =>
    tsFiles(path.join(root, l.root)).some((f) =>
      /\bIonicModule\b/.test(fs.readFileSync(f, 'utf8')),
    ),
  );
  if (withModule.length === 0) return [];
  const paths = tsconfigPaths(root);
  return withModule.flatMap((l) => libAliases(paths, l));
}

/** Spec files of a project that still use IonicModule, as a note (they are not converted). */
function specNote(c: IonicContext, src: string): string | undefined {
  const specs = specFiles(src).filter((f) => /\bIonicModule\b/.test(fs.readFileSync(f, 'utf8')));
  if (specs.length === 0) return undefined;
  return (
    `${specs
      .map((f) => path.relative(c.root, f).split(path.sep).join('/'))
      .join(', ')}: spec files still use IonicModule (left as they are; ` +
    'TestBed can use provideIonicAngular() and the components instead)'
  );
}

export interface IonicLibResult extends IonicAppResult {
  /** Icon names addIcons cannot register; the apps using the library keep the svg asset. */
  loose: string[];
}

/**
 * Converts one Ionic library (nothing is written here): its components import the Ion* classes
 * they use, Ionic imports move to the standalone entry, ion-icon names go through addIcons. No
 * providers and no assets: those belong to the apps.
 */
export function convertIonicLib(c: IonicContext, project: AngularProject): IonicLibResult {
  const src = projectSrc(c.root, project);
  const lib: AppScan = {
    writes: new Map(),
    done: [],
    notes: [],
    reasons: [],
    loose: [],
    providers: true,
  };
  for (const f of tsFiles(src)) convertFile(c, f, lib);
  if (lib.reasons.length > 0) return { ...lib, writes: new Map(), done: [] };
  const note = specNote(c, src);
  if (note) lib.notes.push(note);
  if (lib.loose.length > 0) {
    lib.notes.push(
      `icon names addIcons does not register: ${lib.loose.join('; ')} ` +
        '(apps using the library keep the ionicons svg asset)',
    );
  }
  return lib;
}

/** Converts one Ionic app (nothing is written here; see IonicAppResult). */
export function convertIonicApp(
  c: IonicContext,
  project: AngularProject,
  libs: AngularProject[] = [],
  libLoose: string[] = [],
): IonicAppResult {
  const src = path.join(c.root, project.root, 'src');
  const app: AppScan = {
    writes: new Map(),
    done: [],
    notes: [],
    reasons: [],
    loose: [],
    providers: false,
  };
  const files = tsFiles(src);
  for (const f of files) convertFile(c, f, app);
  if (!app.providers) {
    app.reasons.push(
      `${project.root}/src: no importProvidersFrom(IonicModule.forRoot()) in main.ts or app/app.config.ts to replace`,
    );
  }
  for (const alias of importedAliases(files, ionicModuleLibAliases(c.root, libs))) {
    app.reasons.push(`${project.root}: imports ${alias}, a library that still uses IonicModule`);
  }
  if (app.reasons.length > 0) return { ...app, writes: new Map(), done: [] };
  app.loose.push(...libLoose);

  const note = specNote(c, src);
  if (note) app.notes.push(note);

  // The ionicons svg asset: only needed for icon names addIcons does not register.
  const pjFile = path.join(c.root, project.root, 'project.json');
  let pj: Json | undefined;
  try {
    pj = JSON.parse(fs.readFileSync(pjFile, 'utf8')) as Json;
  } catch {
    pj = undefined;
  }
  const targets = pj && isObject(pj['targets']) ? pj['targets'] : {};
  const build = isObject(targets['build']) ? targets['build'] : {};
  const options = isObject(build['options']) ? build['options'] : {};
  const assets = Array.isArray(options['assets']) ? (options['assets'] as unknown[]) : [];
  const isIconAsset = (a: unknown) =>
    (typeof a === 'string' ? a : isObject(a) ? String(a['input'] ?? '') : '').includes(
      'ionicons/dist/ionicons/svg',
    );
  if (assets.some(isIconAsset)) {
    if (app.loose.length > 0) {
      app.notes.push(
        `${project.root}/project.json: ionicons svg asset kept, for icon names addIcons does not ` +
          `register: ${app.loose.join('; ')}`,
      );
    } else {
      options['assets'] = assets.filter((a) => !isIconAsset(a));
      app.writes.set(pjFile, JSON.stringify(pj, null, 2) + '\n');
      app.done.push(
        `${project.root}/project.json: ionicons svg asset removed (icons come from addIcons)`,
      );
    }
  } else if (app.loose.length > 0) {
    app.notes.push(`icon names addIcons does not register: ${app.loose.join('; ')}`);
  }
  return app;
}

export interface IonicStepOptions {
  /** Libraries on IonicModule to convert along with the apps. */
  ionicLibs?: AngularProject[];
  /**
   * Every project of the workspace; a library converts only when no project that stays on
   * IonicModule uses it. Defaults to the apps and libraries passed.
   */
  workspace?: AngularProject[];
}

/**
 * The ionic-standalone step on these apps (and, with options.ionicLibs, libraries): writes the
 * changes of every project that converts safely, reports the others, and returns the files
 * written (workspace-relative).
 *
 * No app mixes the two Ionic builds: an app converts only when every library it imports that uses
 * IonicModule converts too, and a library converts only when no project that stays on IonicModule
 * imports it.
 */
export function runIonicStep(
  root: string,
  apps: AngularProject[],
  libs: AngularProject[],
  angularMajor: number,
  say: (line: string) => void,
  log: (line: string) => void,
  options: IonicStepOptions = {},
): string[] {
  const ts = loadTypescript(root);
  if (!ts) {
    log('  typescript is not installed in the workspace; ionic-standalone skipped.');
    return [];
  }
  const c = ionicContext(ts, root, angularMajor);
  if (!c.exports) {
    log(`  ${c.standaloneEntry} is not installed; the built-in list of Ionic components is used.`);
  }
  const ionicLibs = (options.ionicLibs ?? []).filter((l) => isIonicLib(root, l));
  const unique = (ps: AngularProject[]) =>
    ps.filter((p, i) => ps.findIndex((q) => q.root === p.root) === i);
  const workspace = unique(options.workspace ?? [...apps, ...libs, ...ionicLibs]);
  const moduleLibs = unique([...libs, ...ionicLibs]).filter((l) => isIonicLib(root, l));

  const stepApps: AngularProject[] = [];
  for (const p of apps) {
    if (!standaloneMain(root, p)) {
      log(`  ${p.name}: still bootstraps an NgModule; ionic-standalone skipped.`);
      continue;
    }
    if (isIonicApp(root, p)) stepApps.push(p);
  }

  // Which Ionic libraries each project imports (through tsconfig paths).
  const paths = tsconfigPaths(root);
  const imports = new Map<AngularProject, AngularProject[]>();
  for (const p of workspace) {
    const files = tsFiles(projectSrc(root, p));
    imports.set(
      p,
      moduleLibs.filter(
        (l) => l.root !== p.root && importedAliases(files, libAliases(paths, l)).length > 0,
      ),
    );
  }
  const usesOf = (p: AngularProject) => imports.get(p) ?? [];

  const libResults = new Map(ionicLibs.map((l) => [l, convertIonicLib(c, l)] as const));
  const ok = new Set(ionicLibs.filter((l) => libResults.get(l)?.reasons.length === 0));
  const libReasons = new Map(ionicLibs.map((l) => [l, libResults.get(l)?.reasons ?? []]));
  /** Icon names the converting libraries an app uses (directly or not) cannot register. */
  const looseFor = (p: AngularProject): string[] => {
    const seen = new Set<AngularProject>();
    const walk = (q: AngularProject) => {
      for (const l of usesOf(q)) {
        if (ok.has(l) && !seen.has(l)) {
          seen.add(l);
          walk(l);
        }
      }
    };
    walk(p);
    return [...seen].flatMap((l) => libResults.get(l)?.loose ?? []);
  };
  let appResults = new Map<AngularProject, IonicAppResult>();
  for (;;) {
    const left = moduleLibs.filter((l) => !ok.has(l));
    appResults = new Map(
      stepApps.map((a) => [a, convertIonicApp(c, a, left, looseFor(a))] as const),
    );
    const converting = new Set<AngularProject>([
      ...ok,
      ...stepApps.filter((a) => appResults.get(a)?.reasons.length === 0),
    ]);
    let changed = false;
    for (const l of [...ok]) {
      const leftUsed = usesOf(l).filter((m) => !ok.has(m));
      const stuck = workspace.filter(
        (q) =>
          q.root !== l.root &&
          !converting.has(q) &&
          (isIonicApp(root, q) || isIonicLib(root, q)) &&
          usesOf(q).includes(l),
      );
      if (leftUsed.length === 0 && stuck.length === 0) continue;
      ok.delete(l);
      changed = true;
      libReasons.set(l, [
        ...leftUsed.map((m) => `${l.root}: imports ${m.name}, a library that stays on IonicModule`),
        ...(stuck.length > 0
          ? [
              `${l.root}: used by ${stuck.map((q) => q.name).join(', ')}, which stay${
                stuck.length === 1 ? 's' : ''
              } on IonicModule`,
            ]
          : []),
      ]);
    }
    if (!changed) break;
  }

  const written: string[] = [];
  const write = (p: AngularProject, r: IonicAppResult) => {
    for (const [file, text] of r.writes) {
      fs.writeFileSync(file, text);
      written.push(path.relative(root, file).split(path.sep).join('/'));
    }
    for (const d of r.done) say(d);
    for (const n of r.notes) log(`  ${n}`);
  };
  const leave = (p: AngularProject, reasons: string[]) => {
    log(`  ${p.name}: left on IonicModule (no file changed):`);
    for (const reason of reasons) log(`    - ${reason}`);
  };
  for (const l of ionicLibs) {
    const r = libResults.get(l);
    if (ok.has(l) && r) write(l, r);
    else leave(l, libReasons.get(l) ?? []);
  }
  for (const a of stepApps) {
    const r = appResults.get(a);
    if (!r) continue;
    if (r.reasons.length > 0) leave(a, r.reasons);
    else write(a, r);
  }
  if (written.length === 0) say('nothing to change');
  return written;
}
