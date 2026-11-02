import * as fs from 'fs';
import * as path from 'path';

import type * as TS from 'typescript';

/**
 * Ionic's standalone components by tag: `ion-foo-bar` is the class `IonFooBar`, exported from the
 * standalone entry (`@ionic/angular/standalone` on Ionic 7.5–8, `@ionic/angular` on Ionic 9). The
 * names are read from the workspace's installed entry when it is there (`moduleExports`), else
 * taken from the built-in list below.
 */

type Ts = typeof TS;
type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Standalone component classes of Ionic 7.8–9 (fallback when the package is not installed). */
export const STATIC_ION_CLASSES: ReadonlySet<string> = new Set([
  'IonAccordion',
  'IonAccordionGroup',
  'IonActionSheet',
  'IonAlert',
  'IonApp',
  'IonAvatar',
  'IonBackButton',
  'IonBackdrop',
  'IonBadge',
  'IonBreadcrumb',
  'IonBreadcrumbs',
  'IonButton',
  'IonButtons',
  'IonCard',
  'IonCardContent',
  'IonCardHeader',
  'IonCardSubtitle',
  'IonCardTitle',
  'IonCheckbox',
  'IonChip',
  'IonCol',
  'IonContent',
  'IonDatetime',
  'IonDatetimeButton',
  'IonFab',
  'IonFabButton',
  'IonFabList',
  'IonFooter',
  'IonGrid',
  'IonHeader',
  'IonIcon',
  'IonImg',
  'IonInfiniteScroll',
  'IonInfiniteScrollContent',
  'IonInput',
  'IonInputPasswordToggle',
  'IonItem',
  'IonItemDivider',
  'IonItemGroup',
  'IonItemOption',
  'IonItemOptions',
  'IonItemSliding',
  'IonLabel',
  'IonList',
  'IonListHeader',
  'IonLoading',
  'IonMenu',
  'IonMenuButton',
  'IonMenuToggle',
  'IonModal',
  'IonNav',
  'IonNavLink',
  'IonNote',
  'IonPicker',
  'IonPickerColumn',
  'IonPickerColumnOption',
  'IonPickerLegacy',
  'IonPopover',
  'IonProgressBar',
  'IonRadio',
  'IonRadioGroup',
  'IonRange',
  'IonRefresher',
  'IonRefresherContent',
  'IonReorder',
  'IonReorderGroup',
  'IonRippleEffect',
  'IonRouterLink',
  'IonRouterLinkWithHref',
  'IonRouterOutlet',
  'IonRow',
  'IonSearchbar',
  'IonSegment',
  'IonSegmentButton',
  'IonSegmentContent',
  'IonSegmentView',
  'IonSelect',
  'IonSelectModal',
  'IonSelectOption',
  'IonSkeletonText',
  'IonSpinner',
  'IonSplitPane',
  'IonTab',
  'IonTabBar',
  'IonTabButton',
  'IonTabs',
  'IonText',
  'IonTextarea',
  'IonThumbnail',
  'IonTitle',
  'IonToast',
  'IonToggle',
  'IonToolbar',
]);

/** `ion-foo-bar` → `IonFooBar`. */
export function ionTagClass(tag: string): string {
  return tag
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** `arrow-back-outline` → `arrowBackOutline` (the export name in `ionicons/icons`). */
export function iconExportName(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** The `types` path of a package.json `exports` entry (string or nested conditions). */
function exportTypes(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.endsWith('.d.ts') ? entry : undefined;
  if (!isObject(entry)) return undefined;
  if (typeof entry['types'] === 'string') return entry['types'];
  for (const v of Object.values(entry)) {
    const t = exportTypes(v);
    if (t) return t;
  }
  return undefined;
}

function readJson(file: string): Json | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return isObject(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The .d.ts file a module specifier (`pkg` or `pkg/sub`) resolves to under `root`/node_modules. */
export function moduleTypesFile(root: string, spec: string): string | undefined {
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const sub = spec.slice(pkg.length);
  const dir = path.join(root, 'node_modules', pkg);
  const pj = readJson(path.join(dir, 'package.json'));
  if (!pj) return undefined;
  const candidates: string[] = [];
  if (isObject(pj['exports'])) {
    const t = exportTypes(pj['exports'][`.${sub}`]);
    if (t) candidates.push(path.join(dir, t));
  }
  const subPj = sub ? readJson(path.join(dir, sub, 'package.json')) : pj;
  for (const key of ['types', 'typings']) {
    const t = subPj?.[key];
    if (typeof t === 'string') candidates.push(path.join(dir, sub, t));
  }
  candidates.push(path.join(dir, sub, 'index.d.ts'));
  return candidates.find((f) => fs.existsSync(f));
}

function relativeDts(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
  return [`${base}.d.ts`, path.join(base, 'index.d.ts')].find((f) => fs.existsSync(f));
}

/**
 * The names a module exports, read from its installed .d.ts files (following `export *` and
 * re-exports); undefined when the module is not installed in the workspace.
 */
export function moduleExports(ts: Ts, root: string, spec: string): Set<string> | undefined {
  const entry = moduleTypesFile(root, spec);
  if (!entry) return undefined;
  const names = new Set<string>();
  const seen = new Set<string>();
  const exported = (n: TS.Node) =>
    (ts.canHaveModifiers?.(n) ? ts.getModifiers?.(n) : undefined)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false;
  const read = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st)) {
        if (st.exportClause && ts.isNamedExports(st.exportClause)) {
          for (const el of st.exportClause.elements) names.add(el.name.text);
        } else if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
          const s = st.moduleSpecifier.text;
          const next = s.startsWith('.') ? relativeDts(file, s) : moduleTypesFile(root, s);
          if (next) read(next);
        }
      } else if (ts.isVariableStatement(st) && exported(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) names.add(d.name.text);
        }
      } else if (
        (ts.isClassDeclaration(st) ||
          ts.isFunctionDeclaration(st) ||
          ts.isInterfaceDeclaration(st) ||
          ts.isTypeAliasDeclaration(st) ||
          ts.isEnumDeclaration(st)) &&
        st.name &&
        exported(st)
      ) {
        names.add(st.name.text);
      }
    }
  };
  read(entry);
  return names;
}
