import type { Tree } from '@nx/devkit';

/**
 * Angular 16+ code an Angular 15 workspace cannot compile: template control flow and `@let`,
 * signal APIs, `@angular/core/rxjs-interop`, and newer providers. Report only: nothing is
 * rewritten.
 */

/** @angular/* exports that Angular 15 does not have, with the version that added them. */
const NEWER_EXPORTS: Record<string, Record<string, number>> = {
  '@angular/core': {
    signal: 16,
    computed: 16,
    effect: 16,
    untracked: 16,
    isSignal: 16,
    DestroyRef: 16,
    ApplicationConfig: 16,
    runInInjectionContext: 16,
    assertInInjectionContext: 16,
    Signal: 16,
    WritableSignal: 16,
    booleanAttribute: 16,
    numberAttribute: 16,
    afterRender: 16,
    afterNextRender: 16,
    provideZoneChangeDetection: 16,
    input: 17,
    output: 17,
    model: 17,
    viewChild: 17,
    viewChildren: 17,
    contentChild: 17,
    contentChildren: 17,
    InputSignal: 17,
    ModelSignal: 17,
    OutputEmitterRef: 17,
    provideExperimentalZonelessChangeDetection: 18,
    linkedSignal: 19,
    resource: 19,
    provideAppInitializer: 19,
    provideZonelessChangeDetection: 20,
    provideBrowserGlobalErrorListeners: 20,
  },
  '@angular/common/http': { withFetch: 16 },
  '@angular/router': {
    withComponentInputBinding: 16,
    withViewTransitions: 17,
    RedirectCommand: 18,
  },
  '@angular/platform-browser': {
    provideClientHydration: 16,
    withEventReplay: 18,
    withIncrementalHydration: 19,
  },
  '@angular/platform-browser/animations/async': { provideAnimationsAsync: 17 },
};

/** Packages (entry points) that Angular 15 does not have. */
const NEWER_PACKAGES: Record<string, number> = {
  '@angular/core/rxjs-interop': 16,
  '@angular/platform-browser/animations/async': 17,
};

/** `@if (`, `@for (`, `@switch (`, `@defer {` / `@defer (`, `@let name =`. */
const CONTROL_FLOW = /(^|[^\w@.])@((if|for|switch)\s*\(|defer\s*[({]|let\s+[A-Za-z_$][\w$]*\s*=)/m;

const IMPORT = /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const ANY_IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

const list = (files: string[], max = 5) =>
  files
    .slice(0, max)
    .map((f) => `\`${f}\``)
    .join(', ') + (files.length > max ? ` and ${files.length - max} more` : '');

/**
 * Notes for Angular 16+ code in the copied files (`copied` is relative to `projectRoot`; notes name
 * workspace paths). `label` prefixes each note (a project name in a workspace migration).
 */
export function angularCodeNotes(
  tree: Tree,
  projectRoot: string,
  copied: string[],
  label = '',
): string[] {
  const controlFlow: string[] = [];
  const apis = new Map<string, Set<string>>();
  const packages = new Map<string, Set<string>>();
  for (const rel of copied) {
    if (!/\.(ts|html)$/.test(rel) || /\.d\.ts$/.test(rel)) continue;
    const text = tree.read(`${projectRoot}/${rel}`, 'utf8');
    if (!text) continue;
    if (rel.endsWith('.html') || /\btemplate\s*:/.test(text)) {
      const source = rel.endsWith('.html') ? text : inlineTemplates(text);
      if (CONTROL_FLOW.test(source)) controlFlow.push(`${projectRoot}/${rel}`);
    }
    if (!rel.endsWith('.ts')) continue;
    for (const m of text.matchAll(IMPORT)) {
      const exports = NEWER_EXPORTS[m[3]];
      if (!exports) continue;
      for (const spec of m[2].split(',')) {
        const name = spec
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          .trim();
        if (exports[name] !== undefined) {
          const key = `${name}|${exports[name]}`;
          apis.set(key, (apis.get(key) ?? new Set()).add(`${projectRoot}/${rel}`));
        }
      }
    }
    for (const m of text.matchAll(ANY_IMPORT)) {
      if (NEWER_PACKAGES[m[1]] !== undefined) {
        packages.set(m[1], (packages.get(m[1]) ?? new Set()).add(`${projectRoot}/${rel}`));
      }
    }
  }

  const prefix = label ? `${label}: ` : '';
  const notes: string[] = [];
  if (controlFlow.length > 0) {
    notes.push(
      `${prefix}Angular 17 template syntax (\`@if\`, \`@for\`, \`@switch\`, \`@defer\`, \`@let\`) ` +
        `in ${list(controlFlow.sort())}. Angular 15 does not compile it: rewrite to ` +
        '`*ngIf`, `*ngFor` and `[ngSwitch]` (`@defer` has no Angular 15 equivalent).',
    );
  }
  const byVersion = new Map<number, { names: string[]; files: Set<string> }>();
  for (const [key, files] of apis) {
    const [name, version] = key.split('|');
    const v = Number(version);
    const entry = byVersion.get(v) ?? { names: [], files: new Set<string>() };
    entry.names.push(name);
    files.forEach((f) => entry.files.add(f));
    byVersion.set(v, entry);
  }
  for (const [v, { names, files }] of [...byVersion].sort(([a], [b]) => a - b)) {
    notes.push(
      `${prefix}Angular ${v}+ APIs ${names
        .sort()
        .map((n) => `\`${n}\``)
        .join(', ')} used in ${list([...files].sort())}. Angular 15 does not have them.`,
    );
  }
  for (const [pkg, files] of [...packages].sort(([a], [b]) => (a < b ? -1 : 1))) {
    notes.push(
      `${prefix}\`${pkg}\` (Angular ${NEWER_PACKAGES[pkg]}+) imported in ${list(
        [...files].sort(),
      )}. Angular 15 does not have it.`,
    );
  }
  return notes;
}

/** The inline `template:` strings of a component file, joined (good enough for a scan). */
function inlineTemplates(ts: string): string {
  const out: string[] = [];
  const re = /\btemplate\s*:\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  for (const m of ts.matchAll(re)) out.push(m[1].slice(1, -1));
  return out.join('\n');
}
