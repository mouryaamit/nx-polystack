import * as fs from 'fs';
import * as path from 'path';

import { refreshLlmBlocks } from '../../lib/utils/llm-block';
import { flushChanges, fsTree } from '../../lib/utils/nx-tree';
import { flagBoolean, flagString } from '../args';
import { findWorkspaceRoot } from '../context';
import { CliError, CommandContext } from '../types';

import { loadTypescript, ProvidersResult, tidyStandaloneProviders } from './standalone-providers';
import type { UpgradeDeps } from './upgrade';

/**
 * `pstack upgrade standalone`: moves Angular apps and libraries from NgModules to standalone
 * components with Angular's own schematic (`@angular/core:standalone`, Angular 15.2+), one mode
 * per commit, as Angular's guide does it:
 *
 *   convert-to-standalone → prune-ng-modules → standalone-bootstrap (apps that bootstrap a module)
 *
 * then pstack's own step, standalone-providers: the bootstrap file's importProvidersFrom loses
 * BrowserModule, and the root routing module becomes provideRouter(routes) (standalone-providers.ts).
 * It also runs alone on apps already bootstrapped with bootstrapApplication.
 *
 * And the pstack parts the schematic does not know: the CSP nonce import stays first in main.ts,
 * Angular 21 apps keep zone.js change detection, `prefer-standalone` is turned back on, and with
 * --all the workspace style (nx.json pstack.angular.style) becomes standalone.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const STANDALONE_MODES = [
  'convert-to-standalone',
  'prune-ng-modules',
  'standalone-bootstrap',
] as const;
type Mode = (typeof STANDALONE_MODES)[number];
/** pstack's step after the schematic's modes. */
const PROVIDERS_STEP = 'standalone-providers' as const;
type Step = Mode | typeof PROVIDERS_STEP;

const MODE_TITLE: Record<Step, string> = {
  'convert-to-standalone': 'components, directives and pipes to standalone',
  'prune-ng-modules': 'remove the NgModules nothing needs any more',
  'standalone-bootstrap': 'bootstrapApplication instead of bootstrapModule',
  'standalone-providers': 'provideRouter instead of the root routing module, no BrowserModule',
};

const CSP_NONCE_IMPORT = /^import ['"]@mouryaamit\/nx-polystack\/runtime\/csp-nonce['"];?[ \t]*\n/m;

export interface AngularProject {
  name: string;
  /** Workspace-relative root, e.g. apps/web. */
  root: string;
  app: boolean;
}

/** project.json files under apps/ and libs/ (5 levels), as name → root. */
export function workspaceProjects(root: string): AngularProject[] {
  const out: AngularProject[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5 || !fs.existsSync(dir)) return;
    const file = path.join(dir, 'project.json');
    if (fs.existsSync(file)) {
      try {
        const pj = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
        const rel = path.relative(root, dir).split(path.sep).join('/');
        out.push({
          name: typeof pj['name'] === 'string' ? pj['name'] : rel.replace(/\//g, '-'),
          root: rel,
          app: pj['projectType'] === 'application' || rel.startsWith('apps/'),
        });
      } catch {
        // not a readable project.json
      }
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  };
  walk(path.join(root, 'apps'), 0);
  walk(path.join(root, 'libs'), 0);
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') && !e.name.endsWith('.spec.ts'))
        out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Whether any source file of the project declares an NgModule the schematic still has work on.
 * Two kinds do not count, because the schematic keeps them and a rerun would change nothing:
 * - a root routing module (RouterModule.forRoot) of an app already on bootstrapApplication (the
 *   standalone-providers step turns it into provideRouter);
 * - a module that only provides services (providers, no declarations or bootstrap).
 */
export function hasNgModules(root: string, project: AngularProject): boolean {
  const bootstrapped = standaloneMain(root, project) !== undefined;
  return tsFiles(path.join(root, project.root, 'src')).some((f) => {
    const text = fs.readFileSync(f, 'utf8');
    if (!/@NgModule\s*\(/.test(text)) return false;
    if (bootstrapped && /RouterModule\s*\.\s*forRoot\s*\(/.test(text)) return false;
    return !providersOnly(text);
  });
}

/** An NgModule file whose modules declare and bootstrap nothing but provide something. */
export function providersOnly(text: string): boolean {
  const nonEmpty = (key: string) => new RegExp(`\\b${key}\\s*:\\s*\\[\\s*[^\\]\\s]`).test(text);
  return !nonEmpty('declarations') && !/\bbootstrap\s*:/.test(text) && nonEmpty('providers');
}

/** The app's main.ts (src/main.ts) when it calls bootstrapApplication. */
function standaloneMain(root: string, project: AngularProject): string | undefined {
  if (!project.app) return undefined;
  const main = path.join(root, project.root, 'src', 'main.ts');
  return fs.existsSync(main) && /\bbootstrapApplication\s*\(/.test(fs.readFileSync(main, 'utf8'))
    ? main
    : undefined;
}

/** main.ts and app.config.ts of an app, when they use importProvidersFrom. */
function providerFiles(root: string, project: AngularProject): string[] {
  return [
    path.join(root, project.root, 'src', 'main.ts'),
    path.join(root, project.root, 'src', 'app', 'app.config.ts'),
  ].filter(
    (f) => fs.existsSync(f) && /\bimportProvidersFrom\s*\(/.test(fs.readFileSync(f, 'utf8')),
  );
}

/**
 * The standalone-providers step on these apps: writes the changes, renames routing modules to
 * routes files, and returns the files to tidy.
 */
export function runProvidersStep(
  root: string,
  apps: AngularProject[],
  angularMajor: number,
  say: (line: string) => void,
  log: (line: string) => void,
): string[] {
  const ts = loadTypescript(root);
  if (!ts) {
    log('  typescript is not installed in the workspace; standalone-providers skipped.');
    return [];
  }
  const result: ProvidersResult = { writes: new Map(), renames: new Map(), done: [], notes: [] };
  for (const p of apps) {
    if (!standaloneMain(root, p)) continue;
    for (const f of providerFiles(root, p)) {
      tidyStandaloneProviders(ts, root, f, path.join(root, p.root, 'src'), angularMajor, result);
    }
  }
  for (const [file, text] of result.writes) fs.writeFileSync(file, text);
  for (const [from, to] of result.renames) fs.renameSync(from, to);
  for (const d of result.done) say(d);
  for (const n of result.notes) log(`  ${n}`);
  if (result.done.length === 0) say('nothing to change');
  return [...result.writes.keys()]
    .map((f) => result.renames.get(f) ?? f)
    .map((f) => path.relative(root, f).split(path.sep).join('/'));
}

/** The project's main.ts (src/main.ts) when it bootstraps an NgModule. */
function moduleBootstrapMain(root: string, project: AngularProject): string | undefined {
  const main = path.join(root, project.root, 'src', 'main.ts');
  return fs.existsSync(main) && /\bbootstrapModule\s*\(/.test(fs.readFileSync(main, 'utf8'))
    ? main
    : undefined;
}

/** Moves the CSP nonce side-effect import (and the comment right above it) to the top again. */
export function keepNonceImportFirst(text: string): string {
  const m = CSP_NONCE_IMPORT.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index);
  // Already first: only comments and blank lines before it.
  if (/^(\s*(\/\/[^\n]*)?\n)*\s*$/.test(before)) return text;
  const comment = /(^|\n)(\/\/ [^\n]*nonce[^\n]*\n)$/i.exec(before);
  const head = comment ? comment[2] : '';
  const rest = before.slice(0, before.length - head.length) + text.slice(m.index + m[0].length);
  return `${head}${m[0]}\n${rest.replace(/^\n+/, '')}`;
}

/**
 * Angular 21 is zoneless by default. When a standalone main.ts or app.config.ts does not provide
 * zone change detection, adds `provideZoneChangeDetection()` to the first `providers: [` after
 * `bootstrapApplication(` in main.ts. Returns the new text, or undefined when it could not.
 */
export function addZoneProvider(main: string): string | undefined {
  if (/provideZoneChangeDetection\s*\(/.test(main)) return main;
  const call = main.search(/\bbootstrapApplication\s*\(/);
  if (call < 0) return undefined;
  const providers = /providers\s*:\s*\[/.exec(main.slice(call));
  if (!providers) return undefined;
  const at = call + providers.index + providers[0].length;
  let out = `${main.slice(0, at)}provideZoneChangeDetection(), ${main.slice(at)}`;
  const core = /import\s*\{([^}]*)\}\s*from\s*['"]@angular\/core['"];?/.exec(out);
  if (core) {
    // The schematic drops bootstrapModule's applicationProviders but keeps their import.
    const names = core[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    if (!names.includes('provideZoneChangeDetection')) names.push('provideZoneChangeDetection');
    out = out.replace(core[0], `import { ${names.join(', ')} } from '@angular/core';`);
  } else {
    out = `import { provideZoneChangeDetection } from '@angular/core';\n${out}`;
  }
  return out;
}

/**
 * Removes a named import that nothing else in the file uses (the bootstrap schematic leaves
 * `platformBrowserDynamic` behind), and the import line when it was the only name.
 */
export function dropUnusedNamedImport(text: string, name: string, from: string): string {
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const line = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${esc(from)}['"];?[ \\t]*\\n?`);
  const m = line.exec(text);
  if (!m) return text;
  const names = m[1]
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (!names.includes(name)) return text;
  const rest = text.slice(0, m.index) + text.slice(m.index + m[0].length);
  if (new RegExp(`\\b${esc(name)}\\b`).test(rest)) return text;
  const keep = names.filter((n) => n !== name);
  const replacement = keep.length > 0 ? `import { ${keep.join(', ')} } from '${from}';\n` : '';
  return text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
}

/**
 * ESLint --fix (import order) then Prettier on the rewritten main.ts files, so the commit holds them
 * formatted: the schematic and the fix-ups add and drop imports, and a pre-commit hook that runs
 * Prettier before ESLint would leave blank lines behind. Best effort: a workspace without either
 * tool, or with lint errors left, keeps going (the check reports real problems).
 */
export function tidyMains(
  root: string,
  files: string[],
  deps: { exec(cmd: string, args: string[], cwd: string): unknown },
  say: (line: string) => void,
): void {
  if (files.length === 0) return;
  const done: string[] = [];
  for (const [tool, args] of [
    ['eslint', ['--fix', ...files]],
    ['prettier', ['--write', ...files]],
  ] as const) {
    try {
      deps.exec('npx', ['--no-install', tool, ...args], root);
      done.push(tool);
    } catch {
      say(`${tool} could not tidy ${files.join(', ')} (left as written)`);
    }
  }
  if (done.length > 0) say(`${files.join(', ')}: tidied with ${done.join(' and ')}`);
}

/** Removes `@angular-eslint/prefer-standalone: off` from a project's .eslintrc.json. */
export function enablePreferStandalone(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  let json: Json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  } catch {
    return false;
  }
  let changed = false;
  const strip = (rules: unknown) => {
    if (isObject(rules) && rules['@angular-eslint/prefer-standalone'] === 'off') {
      delete rules['@angular-eslint/prefer-standalone'];
      changed = true;
    }
  };
  strip(json['rules']);
  if (Array.isArray(json['overrides'])) {
    for (const o of json['overrides']) if (isObject(o)) strip(o['rules']);
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  return changed;
}

function saveStandaloneStyle(root: string): void {
  const file = path.join(root, 'nx.json');
  if (!fs.existsSync(file)) return;
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  const pstack = isObject(json['pstack']) ? json['pstack'] : {};
  const angular = isObject(pstack['angular']) ? pstack['angular'] : {};
  json['pstack'] = { ...pstack, angular: { ...angular, style: 'standalone' } };
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

/** Refreshes the generated AI-assistant blocks (CLAUDE.md, …) on disk; returns the files written. */
export function refreshLlmFiles(root: string): string[] {
  try {
    const tree = fsTree(root);
    const changed = refreshLlmBlocks(tree);
    flushChanges(root, tree.listChanges());
    return changed;
  } catch {
    return [];
  }
}

function angularCoreVersion(root: string): string | undefined {
  const file = path.join(root, 'node_modules', '@angular', 'core', 'package.json');
  if (!fs.existsSync(file)) return undefined;
  const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as Json)['version'];
  return typeof v === 'string' ? v : undefined;
}

/** pstack upgrade standalone --all | --project=<a,b> [--skip-check] [--no-commit] [--dry-run] */
export async function runUpgradeStandalone(
  ctx: CommandContext,
  deps: UpgradeDeps,
): Promise<number> {
  const root = findWorkspaceRoot(ctx.cwd);
  if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
    throw new CliError(
      'run "pstack upgrade standalone" inside an Nx workspace (nx.json, package.json).',
    );
  }
  const core = angularCoreVersion(root);
  if (!core) throw new CliError('@angular/core is not installed; run npm install first.');
  const [major, minor] = core.split('.').map(Number);
  if (major < 15 || (major === 15 && minor < 2)) {
    throw new CliError(
      `Angular's standalone migration needs Angular 15.2 or later (installed: ${core}).`,
    );
  }

  const all = flagBoolean(ctx.flags, 'all');
  if (ctx.flags['project'] === true)
    throw new CliError('--project needs names, e.g. --project=web');
  const wanted = flagString(ctx.flags, 'project')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (all === (wanted !== undefined && wanted.length > 0)) {
    throw new CliError(
      'pass --all (every Angular app and library) or --project=<a,b> (those projects).',
    );
  }
  const projects = workspaceProjects(root);
  let targets: AngularProject[];
  if (all) {
    targets = projects.filter((p) => hasNgModules(root, p));
  } else {
    const unknown = (wanted ?? []).filter((n) => !projects.some((p) => p.name === n));
    if (unknown.length > 0) {
      throw new CliError(
        `no project named ${unknown.map((n) => `"${n}"`).join(', ')}. ` +
          `Projects: ${projects.map((p) => p.name).join(', ')}.`,
      );
    }
    targets = projects.filter((p) => wanted?.includes(p.name) && hasNgModules(root, p));
    for (const n of wanted ?? []) {
      if (!targets.some((p) => p.name === n)) deps.log(`${n}: no NgModules, nothing to convert.`);
    }
  }
  const selected = all ? projects : projects.filter((p) => wanted?.includes(p.name));
  const bootstrapApps = targets.filter((p) => p.app && moduleBootstrapMain(root, p));
  // Apps for the providers step: those the bootstrap mode converts, and those already on
  // bootstrapApplication that still use importProvidersFrom.
  const providerApps = selected.filter(
    (p) =>
      bootstrapApps.includes(p) ||
      (standaloneMain(root, p) !== undefined && providerFiles(root, p).length > 0),
  );
  if (targets.length === 0 && providerApps.length === 0) {
    deps.log('No NgModules in the selected projects; nothing to do.');
    return 0;
  }
  const paths = all ? ['./'] : targets.map((p) => p.root);
  const modes: Step[] = [
    ...(targets.length > 0
      ? STANDALONE_MODES.filter((m) => m !== 'standalone-bootstrap' || bootstrapApps.length > 0)
      : []),
    ...(providerApps.length > 0 ? [PROVIDERS_STEP] : []),
  ];
  const check = !flagBoolean(ctx.flags, 'skipCheck');
  const commit = !flagBoolean(ctx.flags, 'noCommit');

  const names = [...new Set([...targets, ...providerApps].map((p) => p.name))];
  deps.log(`Standalone migration (Angular ${core}) of ${names.join(', ')}:`);
  modes.forEach((m, i) => {
    const where = m === PROVIDERS_STEP ? providerApps.map((p) => `${p.root}/src`) : paths;
    deps.log(`  ${i + 1}. ${m}: ${MODE_TITLE[m]} (${where.join(', ')})`);
  });
  deps.log(
    '  then: CSP nonce import kept first in main.ts, prefer-standalone back on' +
      (major >= 21 ? ', zone change detection kept (Angular 21)' : '') +
      (all ? ', nx.json pstack.angular.style = standalone' : ''),
  );
  if (check) deps.log('  check after each mode: nx run-many -t build lint');
  if (commit) deps.log('  one commit per mode');
  if (ctx.dryRun) {
    deps.log('\nDry run: nothing was changed.');
    return 0;
  }
  // The schematic converts bootstrapped components only in its last mode, so the lint rule comes
  // back on once every mode has run (not after convert-to-standalone).
  const schematicModes = modes.filter((m) => m !== PROVIDERS_STEP);
  const lastMode = schematicModes[schematicModes.length - 1];
  if (!commit && modes.length > 1) {
    deps.log('--no-commit: only the first mode runs; commit it, then run again.');
    modes.splice(1);
  }

  const status = deps.gitStatus(root);
  if (status === null) {
    throw new CliError('pstack upgrade standalone needs a git repository (one commit per mode).');
  }
  if (status.trim() !== '') {
    throw new CliError('commit or stash your changes first; each mode is its own commit.');
  }

  for (const mode of modes) {
    const say = (line: string) => deps.log(`\n▶ ${mode}: ${line}`);
    if (mode === PROVIDERS_STEP) {
      const changed = runProvidersStep(root, providerApps, major, say, deps.log);
      if (changed.length === 0) continue;
      tidyMains(root, changed, deps, say);
    }
    for (const p of mode === PROVIDERS_STEP ? [] : paths) {
      say(`nx g @angular/core:standalone --path=${p} --mode=${mode}`);
      deps.exec(
        'npx',
        [
          'nx',
          'g',
          '@angular/core:standalone',
          `--path=${p}`,
          `--mode=${mode}`,
          '--interactive=false',
        ],
        root,
      );
    }
    if (mode === lastMode) {
      for (const p of targets) {
        if (enablePreferStandalone(path.join(root, p.root, '.eslintrc.json'))) {
          say(`${p.root}/.eslintrc.json: prefer-standalone back on`);
        }
      }
    }
    if (mode === 'convert-to-standalone') {
      if (all) {
        saveStandaloneStyle(root);
        say('nx.json pstack.angular.style = standalone (new apps and libraries follow it)');
        const llm = refreshLlmFiles(root);
        if (llm.length > 0) say(`${llm.join(', ')}: workspace block says standalone components`);
      }
    }
    if (mode === 'standalone-bootstrap') {
      for (const p of bootstrapApps) {
        const main = path.join(root, p.root, 'src', 'main.ts');
        if (!fs.existsSync(main)) continue;
        let text = fs.readFileSync(main, 'utf8');
        const first = keepNonceImportFirst(text);
        if (first !== text) say(`${p.root}/src/main.ts: CSP nonce import moved back to the top`);
        text = first;
        const tidy = dropUnusedNamedImport(
          text,
          'platformBrowserDynamic',
          '@angular/platform-browser-dynamic',
        );
        if (tidy !== text)
          say(`${p.root}/src/main.ts: unused platformBrowserDynamic import removed`);
        text = tidy;
        if (major >= 21) {
          const config = path.join(root, p.root, 'src', 'app', 'app.config.ts');
          const elsewhere =
            fs.existsSync(config) &&
            /provideZoneChangeDetection/.test(fs.readFileSync(config, 'utf8'));
          if (!elsewhere) {
            const zoned = addZoneProvider(text);
            if (zoned === undefined) {
              deps.log(
                `  ${p.root}/src/main.ts: add provideZoneChangeDetection() to the ` +
                  'bootstrapApplication providers yourself (Angular 21 is zoneless by default).',
              );
            } else if (zoned !== text) {
              say(
                `${p.root}/src/main.ts: provideZoneChangeDetection() added to the providers (Angular 21)`,
              );
              text = zoned;
            }
          }
        }
        fs.writeFileSync(main, text);
      }
      tidyMains(
        root,
        bootstrapApps
          .map((p) => path.join(p.root, 'src', 'main.ts'))
          .filter((f) => fs.existsSync(path.join(root, f))),
        deps,
        say,
      );
    }
    // A mode can find nothing to change (a rerun, or modules the schematic leaves as they are).
    if (deps.gitStatus(root)?.trim() === '') {
      say('no changes');
      continue;
    }
    if (check) {
      say('check: nx run-many -t build lint');
      deps.exec('npx', ['nx', 'run-many', '-t', 'build', 'lint'], root);
    }
    if (commit) {
      say('commit');
      deps.exec('git', ['add', '-A'], root);
      deps.exec(
        'git',
        ['commit', '-m', `chore: standalone ${mode} (pstack upgrade standalone)`],
        root,
      );
    }
  }
  if (targets.some((p) => fs.existsSync(path.join(root, p.root, 'capacitor.config.ts')))) {
    deps.log(
      "\nIonic apps keep IonicModule (Ionic's lazy build works with standalone components). " +
        "Moving to Ionic's standalone components is Ionic's codemod: " +
        'https://github.com/ionic-team/ionic-angular-standalone-codemods',
    );
  }
  deps.log('\n✔ Standalone migration done.');
  return 0;
}
