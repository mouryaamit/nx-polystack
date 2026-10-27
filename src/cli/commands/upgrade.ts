import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  filterMigrations,
  fixVersionPrefixes,
  isRevertable,
  keepAngularPackages,
  loadSemver,
  NX_HOP_MAX,
  NX_HOP_MIN,
  NX_HOPS,
  versionOf,
} from '../../lib/upgrade/nx-migrate';
import {
  ANGULAR_PINS,
  AngularPins,
  INJECT_MIGRATION_ANGULAR,
  majorOfSpec,
  MAX_ANGULAR,
  MIN_ANGULAR,
  pinRange,
} from '../../lib/upgrade/pins';
import { withDevkitPin } from '../../lib/utils/devkit-pin';
import {
  keepJsonLayout,
  loadJsonc,
  restoreJsonLayouts,
  snapshotJsonConfigs,
} from '../../lib/utils/json-layout';
import { flagBoolean, flagString } from '../args';
import { findWorkspaceRoot } from '../context';
import { gitStatus } from '../exec';
import { isInteractive, Prompter, terminalPrompter } from '../prompt';
import { CliError, CommandContext } from '../types';
import { compareVersions } from '../versions';

import { runUpgradeStandalone } from './upgrade-standalone';

/**
 * `pstack upgrade angular`: moves the workspace to the next Angular major, one step at a time,
 * with the companion versions of that step (claude/angular-21-plan.md section 3). The recipe is
 * the one the NX-72 walk proved from Angular 15 to 21:
 *
 *   Node (engines/.nvmrc) → nx migrate → install → migrations → Angular second pass when Nx left
 *   Angular behind → build/CLI/lint packages and TypeScript → Ionic (`@ionic/migrate` for 9) →
 *   Capacitor in each app package.json (+ `cap migrate`) → check (build, lint) → one commit.
 */

export interface UpgradeDeps {
  /** Run a command with inherited stdio; throws on a non-zero exit. */
  exec(cmd: string, args: string[], cwd: string, env?: Record<string, string>): void;
  /** Run a command and return its stdout ('' when it fails). */
  capture?(cmd: string, args: string[], cwd: string): string;
  /** Porcelain status text, or null when not a git repo. */
  gitStatus(cwd: string): string | null;
  /** Major version of the Node running pstack. */
  nodeMajor(): number;
  interactive: boolean;
  prompter(): Prompter;
  log(line: string): void;
}

const useShell = (cmd: string): boolean =>
  process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx');

const defaultDeps: UpgradeDeps = {
  exec(cmd, args, cwd, env) {
    const r = spawnSync(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: useShell(cmd),
      env: env ? { ...process.env, ...env } : process.env,
    });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      throw new Error(
        `"${cmd} ${args.join(' ')}" exited with code ${r.status ?? `signal ${r.signal}`}`,
      );
    }
  },
  capture(cmd, args, cwd) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: useShell(cmd) });
    return r.status === 0 ? r.stdout : '';
  },
  gitStatus,
  nodeMajor: () => Number(process.versions.node.split('.')[0]),
  interactive: isInteractive(),
  prompter: terminalPrompter,
  log: (line) => console.log(line),
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function readJsonFile(file: string): Json {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
}

function writeJsonFile(file: string, value: Json): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** Declared version of a package in dependencies, devDependencies or optionalDependencies. */
export function declared(pkg: Json, name: string): string | undefined {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (isObject(deps) && typeof deps[name] === 'string') return deps[name] as string;
  }
  return undefined;
}

function installedVersion(root: string, name: string): string | undefined {
  const file = path.join(root, 'node_modules', name, 'package.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const v = readJsonFile(file)['version'];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The workspace's Angular major: installed @angular/core, else the declared one. */
export function workspaceAngularMajor(root: string): number | undefined {
  const pkg = readJsonFile(path.join(root, 'package.json'));
  return (
    majorOfSpec(installedVersion(root, '@angular/core')) ??
    majorOfSpec(declared(pkg, '@angular/core'))
  );
}

/** Build, CLI and lint packages that move with the Angular major (only those declared). */
const ANGULAR_BUILD_PACKAGES = [
  '@angular-devkit/build-angular',
  '@angular/build',
  '@angular/cli',
  '@angular/compiler-cli',
  '@angular/language-service',
  '@angular-devkit/core',
  '@angular-devkit/schematics',
  '@schematics/angular',
];
const ANGULAR_ESLINT_PACKAGES = [
  'angular-eslint',
  '@angular-eslint/builder',
  '@angular-eslint/eslint-plugin',
  '@angular-eslint/eslint-plugin-template',
  '@angular-eslint/template-parser',
  '@angular-eslint/schematics',
];

/** Framework packages released with @angular/core (same version numbers). */
const ANGULAR_FRAMEWORK_PACKAGES = [
  '@angular/animations',
  '@angular/common',
  '@angular/compiler',
  '@angular/core',
  '@angular/elements',
  '@angular/forms',
  '@angular/localize',
  '@angular/platform-browser',
  '@angular/platform-browser-dynamic',
  '@angular/platform-server',
  '@angular/router',
  '@angular/service-worker',
  '@angular/upgrade',
];

/** True when an exact or ~/^ version is an older release than the pin (same major or not). */
function belowPin(spec: string, pin: string): boolean {
  const v = spec.replace(/^[~^=]/, '');
  if (!/^\d+\.\d+\.\d+$/.test(v) || !/^\d+\.\d+\.\d+$/.test(pin)) return false;
  return compareVersions(v, pin) < 0;
}

/**
 * `pkg@~pin` for every declared Angular framework package older than the step's pinned release.
 * `nx migrate` picks the newest Angular it knows, which can be an earlier patch than the one
 * pstack tested (the later patches carry security fixes).
 */
export function frameworkPatchSpecs(pkg: Json, pins: AngularPins): string[] {
  const out: string[] = [];
  for (const name of ANGULAR_FRAMEWORK_PACKAGES) {
    const has = declared(pkg, name);
    if (has !== undefined && belowPin(has, pins.angular)) out.push(`${name}@~${pins.angular}`);
  }
  return out;
}

/**
 * `pkg@range` for every declared build/CLI/lint package and TypeScript whose major (or, for
 * TypeScript, version) is not the step's. Empty when everything already matches.
 */
export function buildPackageSpecs(pkg: Json, major: number, pins: AngularPins): string[] {
  const out: string[] = [];
  const want = (name: string, pin: string) => {
    const has = declared(pkg, name);
    if (has === undefined) return;
    if (majorOfSpec(has) !== majorOfSpec(pin) || belowPin(has, pin)) {
      out.push(`${name}@${pinRange(pin)}`);
    }
  };
  for (const name of ANGULAR_BUILD_PACKAGES) want(name, pins.angular);
  for (const name of ANGULAR_ESLINT_PACKAGES) want(name, pins.angularEslint);
  const packagr = declared(pkg, 'ng-packagr');
  if (packagr !== undefined && majorOfSpec(packagr) !== major) {
    out.push(`ng-packagr@^${major}.0.0`);
  }
  const ts = declared(pkg, 'typescript');
  if (ts !== undefined && ts.replace(/^[~^]/, '') !== pins.typescript) {
    out.push(`typescript@~${pins.typescript}`);
  }
  return out;
}

/** package.json files of the apps that declare @capacitor/* (Capacitor lives per app). */
export function capacitorApps(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const sub = path.join(dir, entry.name);
      const pkgFile = path.join(sub, 'package.json');
      if (fs.existsSync(pkgFile)) {
        try {
          const pkg = readJsonFile(pkgFile);
          const all = { ...(pkg['dependencies'] as Json), ...(pkg['devDependencies'] as Json) };
          if (Object.keys(all).some((k) => k.startsWith('@capacitor/'))) found.push(sub);
        } catch {
          // not JSON: not an app package
        }
      }
      walk(sub, depth + 1);
    }
  };
  walk(path.join(root, 'apps'), 1);
  return found.sort();
}

/** Sets every @capacitor/* of an app package.json to ^<major>.0.0; true when something changed. */
export function pinCapacitor(appDir: string, major: number): boolean {
  const file = path.join(appDir, 'package.json');
  const pkg = readJsonFile(file);
  let changed = false;
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (!isObject(deps)) continue;
    for (const k of Object.keys(deps)) {
      if (k.startsWith('@capacitor/') && majorOfSpec(deps[k] as string) !== major) {
        deps[k] = `^${major}.0.0`;
        changed = true;
      }
    }
  }
  if (changed) writeJsonFile(file, pkg);
  return changed;
}

/** engines.node and .nvmrc for a Node major; true when something changed. */
export function pinNode(root: string, node: number): boolean {
  const pkgFile = path.join(root, 'package.json');
  const pkg = readJsonFile(pkgFile);
  const engines = isObject(pkg['engines']) ? (pkg['engines'] as Json) : {};
  const range = `>=${node}.12.0 <${node + 1}.0.0`;
  let changed = false;
  if (engines['node'] !== undefined && majorOfSpec(engines['node'] as string) !== node) {
    pkg['engines'] = { ...engines, node: range };
    writeJsonFile(pkgFile, pkg);
    changed = true;
  }
  const nvmrc = path.join(root, '.nvmrc');
  if (fs.existsSync(nvmrc) && majorOfSpec(fs.readFileSync(nvmrc, 'utf8').trim()) !== node) {
    fs.writeFileSync(nvmrc, `${node}\n`);
    changed = true;
  }
  return changed;
}

function declaredNodeMajor(root: string): number | undefined {
  const nvmrc = path.join(root, '.nvmrc');
  if (fs.existsSync(nvmrc)) return majorOfSpec(fs.readFileSync(nvmrc, 'utf8').trim());
  const engines = readJsonFile(path.join(root, 'package.json'))['engines'];
  return isObject(engines) ? majorOfSpec(engines['node'] as string | undefined) : undefined;
}

/** .ts files under apps/ and libs/ (no node_modules, no dot folders). */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(path.join(root, 'apps'));
  walk(path.join(root, 'libs'));
  return out;
}

const HTTP_CLIENT_IMPORTED = /import\s*(type\s*)?\{[^}]*\bHttpClientModule\b[^}]*\}\s*from/;

/**
 * Angular 18's HttpClientModule migration drops the import and moves the module to
 * provideHttpClient(), but leaves `HttpClientModule` in an NgModule's `exports` (a shared module
 * that re-exported it), which then fails to compile. Removes those leftover references from array
 * literals in files that no longer import it. Returns the files changed (workspace-relative).
 */
export function repairHttpClientModule(root: string): string[] {
  const changed: string[] = [];
  for (const file of sourceFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/\bHttpClientModule\b/.test(text) || HTTP_CLIENT_IMPORTED.test(text)) continue;
    const fixed = text.replace(/\[([^[\]]*)\]/g, (whole, inner: string) => {
      if (!/\bHttpClientModule\b/.test(inner)) return whole;
      const items = inner
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== '' && x !== 'HttpClientModule');
      return `[${items.join(', ')}]`;
    });
    if (fixed !== text) {
      fs.writeFileSync(file, fixed);
      changed.push(path.relative(root, file));
    }
  }
  return changed;
}

/**
 * nx migrate with the CLI that works: the newest Nx CLI it downloads checks provenance (which older
 * releases fail) and can fail to look versions up; the workspace's own Nx then runs it.
 */
function nxMigrate(
  root: string,
  args: string[],
  deps: UpgradeDeps,
  say: (line: string) => void,
  attempts: (Record<string, string> | undefined)[],
): void {
  let last: Error | undefined;
  for (const [i, env] of attempts.entries()) {
    try {
      deps.exec('npx', ['nx', 'migrate', ...args, '--interactive=false'], root, env);
      return;
    } catch (e) {
      last = e as Error;
      if (i < attempts.length - 1) {
        say(
          `nx migrate failed (${last.message}); retrying with ${Object.entries(
            attempts[i + 1] ?? {},
          )
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}`,
        );
      }
    }
  }
  throw last;
}

/** @nx/devkit pinned to `nx` when the workspace declares it otherwise; true when changed. */
function pinDeclaredDevkit(root: string, nx: string): boolean {
  const file = path.join(root, 'package.json');
  const pkg = readJsonFile(file);
  const spec = declared(pkg, '@nx/devkit');
  if (spec === undefined || spec === nx) return false;
  writeJsonFile(file, withDevkitPin(pkg, nx));
  return true;
}

/**
 * After a step: the JSON files keep their own layout (only values changed), Markdown and binary
 * files nx migrate text-replaced are put back.
 */
function tidyAfterMigrate(
  root: string,
  snapshot: Map<string, string>,
  deps: UpgradeDeps,
  say: (line: string) => void,
): void {
  const jsonc = loadJsonc(root);
  if (jsonc) {
    const kept = restoreJsonLayouts(root, snapshot, jsonc);
    if (kept.length > 0) say(`kept the layout of ${kept.length} JSON file(s); only values changed`);
  }
  const changed = (deps.capture?.('git', ['diff', '--name-only'], root) ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const revert = changed.filter((f) => isRevertable(root, f));
  if (revert.length > 0) {
    deps.exec('git', ['checkout', '--', ...revert], root);
    say(`put back what nx migrate rewrote in Markdown and binary files: ${revert.join(', ')}`);
  }
}

/** What one step does, in order (the dry-run plan and the log headings). */
export function stepPlan(from: number, to: number, root: string): string[] {
  const pins = ANGULAR_PINS[to];
  const pkg = readJsonFile(path.join(root, 'package.json'));
  const lines: string[] = [];
  if (declaredNodeMajor(root) !== undefined && declaredNodeMajor(root) !== pins.node) {
    lines.push(`Node: engines.node and .nvmrc → ${pins.node}`);
  }
  lines.push(
    to === 16 && pins.nx === ANGULAR_PINS[from].nx
      ? `nx migrate @angular/core@${pins.angular} (Nx stays ${pins.nx})`
      : `nx migrate ${pins.nx}`,
  );
  lines.push('npm install, then the migrations nx migrate wrote (migrations.json)');
  lines.push(`if Angular is still below ${to}: nx migrate @angular/core@${pins.angular} again`);
  lines.push(`Angular framework packages below ${pins.angular} to ~${pins.angular}`);
  lines.push(
    `build, CLI and lint packages to Angular ${to}, angular-eslint ${pinRange(
      pins.angularEslint,
    )}, ` + `TypeScript ~${pins.typescript} (only the declared ones that differ)`,
  );
  if (to === INJECT_MIGRATION_ANGULAR) {
    lines.push(
      'constructor injection to inject(): nx g @angular/core:inject (prefer-inject lint rule)',
    );
  }
  const ionic = declared(pkg, '@ionic/angular');
  if (ionic !== undefined) {
    lines.push(
      pins.ionic === '9' && (majorOfSpec(ionic) ?? 0) < 9
        ? 'Ionic 9 through npx @ionic/migrate --force (imports, CSS, packages)'
        : `@ionic/angular ${pinRange(pins.ionic)}`,
    );
  }
  for (const app of capacitorApps(root)) {
    lines.push(
      `Capacitor ${pins.capacitor} in ${path.relative(root, app)}/package.json` +
        ' (npm install there; cap migrate when it has native projects)',
    );
  }
  return lines;
}

interface StepOptions {
  root: string;
  from: number;
  to: number;
  check: boolean;
  commit: boolean;
}

function runStep(o: StepOptions, deps: UpgradeDeps): void {
  const { root, to } = o;
  const pins = ANGULAR_PINS[to];
  const say = (line: string) => deps.log(`\n▶ Angular ${to}: ${line}`);
  const npm = (args: string[], cwd = root) => deps.exec('npm', args, cwd);
  const npx = (args: string[], cwd = root, env?: Record<string, string>) =>
    deps.exec('npx', args, cwd, env);
  const runMigrations = () => {
    if (!fs.existsSync(path.join(root, 'migrations.json'))) return;
    say('running migrations.json');
    npx(['nx', 'migrate', '--run-migrations', '--if-exists']);
    fs.rmSync(path.join(root, 'migrations.json'), { force: true });
  };

  const snapshot = snapshotJsonConfigs(root);
  const attempts = [
    undefined,
    { NX_SKIP_PROVENANCE_CHECK: 'true' },
    { NX_MIGRATE_USE_LOCAL: 'true' },
  ];
  const afterMigrate = () => {
    const file = path.join(root, 'package.json');
    const pkg = readJsonFile(file);
    if (fixVersionPrefixes(pkg).length > 0) writeJsonFile(file, pkg);
    const nx = (declared(readJsonFile(file), 'nx') ?? '').replace(/^[\^~=]/, '');
    if (/^\d+\.\d+\.\d+$/.test(nx) && pinDeclaredDevkit(root, nx))
      say(`@nx/devkit pinned to ${nx}`);
  };

  if (pinNode(root, pins.node)) say(`engines.node and .nvmrc set to Node ${pins.node}`);

  if (to === 16 && pins.nx === ANGULAR_PINS[o.from].nx) {
    say(`nx migrate @angular/core@${pins.angular}`);
    nxMigrate(root, [`@angular/core@${pins.angular}`], deps, say, attempts);
  } else {
    say(`nx migrate ${pins.nx}`);
    nxMigrate(root, [pins.nx], deps, say, attempts);
  }
  afterMigrate();
  say('npm install');
  npm(['install']);
  runMigrations();

  // Nx 22 treats the Angular 21 bump as optional and skips it without prompts.
  const core = majorOfSpec(installedVersion(root, '@angular/core'));
  if (core !== undefined && core < to) {
    say(`Angular is ${core} after nx migrate; nx migrate @angular/core@${pins.angular}`);
    npx(['nx', 'migrate', `@angular/core@${pins.angular}`, '--interactive=false']);
    npm(['install']);
    runMigrations();
  }

  const repaired = repairHttpClientModule(root);
  if (repaired.length > 0) {
    say(
      `removed leftover HttpClientModule references (Angular 18 migration): ${repaired.join(', ')}`,
    );
  }

  const framework = frameworkPatchSpecs(readJsonFile(path.join(root, 'package.json')), pins);
  if (framework.length > 0) {
    say(`Angular framework packages to ${pins.angular}: ${framework.join(' ')}`);
    npm(['install', ...framework]);
  }

  const specs = buildPackageSpecs(readJsonFile(path.join(root, 'package.json')), to, pins);
  if (specs.length > 0) {
    say(`build, CLI, lint packages and TypeScript: ${specs.join(' ')}`);
    npm(['install', '--save-dev', ...specs]);
  }

  if (to === INJECT_MIGRATION_ANGULAR) {
    // angular-eslint 20 makes prefer-inject an error; Angular's own migration rewrites the
    // constructors. If it cannot run, the check below reports the lint errors.
    say('constructor injection to inject(): nx g @angular/core:inject');
    try {
      npx(['nx', 'g', '@angular/core:inject', '--path=./', '--interactive=false']);
    } catch (e) {
      deps.log(
        `  the inject migration failed (${(e as Error).message}); run ` +
          '"npx nx g @angular/core:inject --path=./" yourself, or fix the prefer-inject lint errors.',
      );
    }
  }

  const ionic = declared(readJsonFile(path.join(root, 'package.json')), '@ionic/angular');
  if (ionic !== undefined) {
    if (pins.ionic === '9' && (majorOfSpec(ionic) ?? 0) < 9) {
      // It only acts below 9 (so it runs instead of installing 9) and refuses a dirty tree
      // without --force; the step's changes are committed together below.
      say('Ionic 9: npx @ionic/migrate --force');
      npx(['-y', '@ionic/migrate', '--force'], root, { CI: '1' });
      npm(['install']);
    } else if (pins.ionic !== '9' && majorOfSpec(ionic) !== majorOfSpec(pins.ionic)) {
      say(`@ionic/angular ${pinRange(pins.ionic)}`);
      npm(['install', `@ionic/angular@${pinRange(pins.ionic)}`]);
    }
  }

  for (const app of capacitorApps(root)) {
    if (!pinCapacitor(app, pins.capacitor)) continue;
    const rel = path.relative(root, app);
    say(`Capacitor ${pins.capacitor} in ${rel}`);
    npm(['install', '--prefix', rel]);
    if (['android', 'ios'].some((d) => fs.existsSync(path.join(app, d)))) {
      npx(['cap', 'migrate', '--noprompt'], app, { CI: '1' });
    }
  }

  tidyAfterMigrate(root, snapshot, deps, say);

  if (o.check) {
    say('check: nx run-many -t build lint');
    npx(['nx', 'run-many', '-t', 'build', 'lint']);
  }
  if (o.commit) {
    say('commit');
    deps.exec('git', ['add', '-A'], root);
    deps.exec(
      'git',
      ['commit', '-m', `chore: upgrade to Angular ${to} (pstack upgrade angular)`],
      root,
    );
  }
}

/** pstack upgrade angular [--to=N] [--yes] [--skip-check] [--no-commit] [--dry-run] */
export async function runUpgrade(
  ctx: CommandContext,
  deps: UpgradeDeps = defaultDeps,
): Promise<number> {
  const what = ctx.positionals[0];
  if (what === 'nx') return runUpgradeNx(ctx, deps);
  if (what === 'standalone') return runUpgradeStandalone(ctx, deps);
  if (what !== 'angular') {
    throw new CliError(
      'pstack upgrade takes what to upgrade: "pstack upgrade angular", "pstack upgrade nx" or ' +
        `"pstack upgrade standalone"${what ? ` (got "${what}")` : ''}.`,
    );
  }
  const root = findWorkspaceRoot(ctx.cwd);
  if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
    throw new CliError(
      'run "pstack upgrade angular" inside an Nx workspace (nx.json, package.json).',
    );
  }
  const current = workspaceAngularMajor(root);
  if (current === undefined) throw new CliError('this workspace has no @angular/core.');
  if (current < MIN_ANGULAR || current > MAX_ANGULAR) {
    throw new CliError(
      `the workspace is on Angular ${current}; pstack upgrades from ${MIN_ANGULAR} to ${MAX_ANGULAR}.`,
    );
  }
  if (current === MAX_ANGULAR) {
    const pkg = readJsonFile(path.join(root, 'package.json'));
    const pins = ANGULAR_PINS[current];
    const behind = [
      ...frameworkPatchSpecs(pkg, pins),
      ...buildPackageSpecs(pkg, current, pins).filter((spec) =>
        ANGULAR_BUILD_PACKAGES.some((name) => spec.startsWith(`${name}@`)),
      ),
    ];
    if (behind.length === 0) {
      deps.log(
        `The workspace is on Angular ${current}, the newest pstack supports. Nothing to do.`,
      );
    } else {
      deps.log(
        `The workspace is on Angular ${current}, the newest pstack supports, but its Angular ` +
          `packages are older than ${pins.angular}, the release pstack tested (later patches ` +
          `carry security fixes). Update them with:\n  npm install ${behind.join(' ')}`,
      );
    }
    return 0;
  }
  const toFlag = flagString(ctx.flags, 'to');
  if (ctx.flags['to'] === true) throw new CliError('--to needs a major, e.g. --to=18');
  let target = toFlag === undefined ? current + 1 : Number(toFlag);
  if (!Number.isInteger(target) || target <= current || target > MAX_ANGULAR) {
    throw new CliError(
      `--to must be an Angular major from ${current + 1} to ${MAX_ANGULAR} (got "${toFlag}").`,
    );
  }
  const yes = flagBoolean(ctx.flags, 'yes') || flagBoolean(ctx.flags, 'y');
  const check = !flagBoolean(ctx.flags, 'skipCheck');
  const commit = !flagBoolean(ctx.flags, 'noCommit');
  if (!commit && target > current + 1) {
    // The next step needs a clean tree; without the commit there is none.
    deps.log(`--no-commit: only the Angular ${current + 1} step runs; commit it, then run again.`);
    target = current + 1;
  }

  for (let from = current; from < target; from++) {
    const to = from + 1;
    deps.log(`\nAngular ${from} → ${to}:`);
    for (const line of stepPlan(from, to, root)) deps.log(`  - ${line}`);
    if (check) deps.log('  - check: nx run-many -t build lint');
    if (commit) deps.log('  - one commit for the step');
  }
  if (ctx.dryRun) {
    deps.log('\nDry run: nothing was changed.');
    return 0;
  }

  const status = deps.gitStatus(root);
  if (status === null) {
    throw new CliError('pstack upgrade angular needs a git repository (each step is one commit).');
  }
  if (status.trim() !== '') {
    throw new CliError('commit or stash your changes first; each upgrade step is its own commit.');
  }

  for (let from = current; from < target; from++) {
    const to = from + 1;
    const node = ANGULAR_PINS[to].node;
    if (deps.nodeMajor() !== node) {
      throw new CliError(
        `the Angular ${to} step runs on Node ${node} (the workspace declares it for that step); ` +
          `this is Node ${deps.nodeMajor()}. Switch (e.g. nvm use ${node}) and run it again.`,
      );
    }
    if (from > current && !yes) {
      if (!deps.interactive) {
        deps.log(`\nStopped after Angular ${from}. Run again (or pass --yes) for the next step.`);
        return 0;
      }
      const p = deps.prompter();
      const answer = (
        await p.ask(`Angular ${from} is done. Continue to Angular ${to}? (y/N)`, 'n')
      ).toLowerCase();
      p.close();
      if (answer !== 'y' && answer !== 'yes') {
        deps.log(`Stopped at Angular ${from}.`);
        return 0;
      }
    }
    runStep({ root, from, to, check, commit }, deps);
    deps.log(`\n✔ Angular ${to} done.`);
  }
  return 0;
}

const PLUGIN = '@mouryaamit/nx-polystack';

/** Where the plugin is declared, so `upgrade nx` can take it out and put it back. */
function pluginPin(pkg: Json): { field: string; spec: string } | undefined {
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (isObject(deps) && typeof deps[PLUGIN] === 'string') {
      return { field, spec: deps[PLUGIN] as string };
    }
  }
  return undefined;
}

/** The workspace's Nx major: installed nx, else the declared one. */
export function workspaceNxMajor(root: string): number | undefined {
  const pkg = readJsonFile(path.join(root, 'package.json'));
  return majorOfSpec(versionOf(root, pkg, 'nx'));
}

interface NxStepOptions {
  root: string;
  to: number;
  last: boolean;
  /** The plugin pin taken out before the first step, put back after the last. */
  plugin?: { field: string; spec: string };
  check: boolean;
  commit: boolean;
}

/** What one Nx step does (dry-run plan and log headings). */
export function nxStepPlan(to: number, last: boolean, plugin: boolean): string[] {
  const lines = [
    `nx migrate ${NX_HOPS[to]} (Angular and its packages stay where they are)`,
    'npm install, then the migrations nx migrate wrote (Angular ones left out)',
    'JSON files keep their layout; Markdown and binary files nx migrate rewrote are put back',
  ];
  if (last) {
    lines.push(
      plugin
        ? `nx-polystack back in package.json, @nx/devkit pinned to ${NX_HOPS[to]}`
        : `@nx/devkit pinned to ${NX_HOPS[to]} when declared`,
    );
  }
  return lines;
}

function runNxStep(o: NxStepOptions, deps: UpgradeDeps): void {
  const { root, to } = o;
  const version = NX_HOPS[to];
  const say = (line: string) => deps.log(`\n▶ Nx ${to}: ${line}`);
  const pkgFile = path.join(root, 'package.json');
  const snapshot = snapshotJsonConfigs(root);
  const before = readJsonFile(pkgFile);

  say(`nx migrate ${version}`);
  nxMigrate(root, [version], deps, say, [
    { NX_SKIP_PROVENANCE_CHECK: 'true' },
    { NX_MIGRATE_USE_LOCAL: 'true' },
  ]);

  const after = readJsonFile(pkgFile);
  const kept = keepAngularPackages(before, after);
  if (o.last) {
    if (o.plugin) {
      const deps2 = isObject(after[o.plugin.field]) ? (after[o.plugin.field] as Json) : {};
      after[o.plugin.field] = { ...deps2, [PLUGIN]: o.plugin.spec };
    }
    const pinned = withDevkitPin(after, version);
    if (o.plugin || declared(after, '@nx/devkit') !== undefined) Object.assign(after, pinned);
  }
  writeJsonFile(pkgFile, after);
  if (kept.length > 0) say(`kept Angular's packages where they were: ${kept.join(', ')}`);

  const keptVersion = (name: string) => versionOf(root, before, name);
  const dropped = filterMigrations(
    path.join(root, 'migrations.json'),
    keptVersion,
    loadSemver(root),
  );
  if (dropped.length > 0) say(`left out the Angular migrations: ${dropped.join(', ')}`);

  say('npm install');
  deps.exec('npm', ['install'], root);
  if (fs.existsSync(path.join(root, 'migrations.json'))) {
    say('running migrations.json');
    deps.exec('npx', ['nx', 'migrate', '--run-migrations', '--if-exists'], root);
    fs.rmSync(path.join(root, 'migrations.json'), { force: true });
  }
  tidyAfterMigrate(root, snapshot, deps, say);

  if (o.check) {
    say('check: nx run-many -t build');
    deps.exec('npx', ['nx', 'run-many', '-t', 'build'], root);
  }
  if (o.commit) {
    say('commit');
    deps.exec('git', ['add', '-A'], root);
    deps.exec('git', ['commit', '-m', `chore: upgrade to Nx ${version} (pstack upgrade nx)`], root);
  }
}

/**
 * pstack upgrade nx [--to=16|17] [--skip-check] [--no-commit] [--dry-run]: moves an Nx 15 or 16
 * workspace to Nx 17 (where the plugin loads), one major per commit, Angular unchanged.
 */
export async function runUpgradeNx(
  ctx: CommandContext,
  deps: UpgradeDeps = defaultDeps,
): Promise<number> {
  const root = findWorkspaceRoot(ctx.cwd);
  if (!root || !fs.existsSync(path.join(root, 'package.json'))) {
    throw new CliError('run "pstack upgrade nx" inside an Nx workspace (nx.json, package.json).');
  }
  const current = workspaceNxMajor(root);
  if (current === undefined) throw new CliError('this workspace has no nx in package.json.');
  if (current >= NX_HOP_MAX) {
    deps.log(
      `The workspace is on Nx ${current}; nx-polystack loads on it. Later Nx versions come with ` +
        'the Angular majors: pstack upgrade angular.',
    );
    return 0;
  }
  if (current < NX_HOP_MIN) {
    throw new CliError(
      `the workspace is on Nx ${current}; pstack upgrade nx starts from Nx ${NX_HOP_MIN}. ` +
        `Move it to Nx ${NX_HOP_MIN} with nx migrate first.`,
    );
  }
  const angular = workspaceAngularMajor(root);
  if (angular !== undefined && angular < MIN_ANGULAR) {
    throw new CliError(
      `the workspace is on Angular ${angular}; Nx ${NX_HOP_MAX} needs Angular ${MIN_ANGULAR} or later.`,
    );
  }
  const toFlag = flagString(ctx.flags, 'to');
  if (ctx.flags['to'] === true) throw new CliError('--to needs a major, e.g. --to=17');
  let target = toFlag === undefined ? NX_HOP_MAX : Number(toFlag);
  if (!Number.isInteger(target) || target <= current || target > NX_HOP_MAX) {
    throw new CliError(
      `--to must be an Nx major from ${current + 1} to ${NX_HOP_MAX} (got "${toFlag}").`,
    );
  }
  const check = !flagBoolean(ctx.flags, 'skipCheck');
  const commit = !flagBoolean(ctx.flags, 'noCommit');
  const plugin = pluginPin(readJsonFile(path.join(root, 'package.json')));
  if (!commit && target > current + 1) {
    if (plugin) {
      throw new CliError(
        '--no-commit runs one step, but nx-polystack has to come out of package.json until the ' +
          `last one (Nx ${NX_HOP_MAX}); run without --no-commit (each step is its own commit).`,
      );
    }
    deps.log(`--no-commit: only the Nx ${current + 1} step runs; commit it, then run again.`);
    target = current + 1;
  }

  if (plugin) {
    deps.log(
      `\nnx-polystack (${plugin.spec}) needs Nx ${NX_HOP_MAX}: it comes out of package.json for the ` +
        'steps and goes back after the last one.',
    );
  }
  for (let to = current + 1; to <= target; to++) {
    deps.log(`\nNx ${to - 1} → ${to}:`);
    for (const line of nxStepPlan(to, to === target, !!plugin)) deps.log(`  - ${line}`);
    if (check) deps.log('  - check: nx run-many -t build');
    if (commit) deps.log('  - one commit for the step');
  }
  if (ctx.dryRun) {
    deps.log('\nDry run: nothing was changed.');
    return 0;
  }

  const status = deps.gitStatus(root);
  if (status === null) {
    throw new CliError('pstack upgrade nx needs a git repository (each step is one commit).');
  }
  if (status.trim() !== '') {
    throw new CliError('commit or stash your changes first; each upgrade step is its own commit.');
  }
  if (deps.nodeMajor() < 18) {
    throw new CliError(
      `Nx ${NX_HOP_MAX} needs Node 18 or later; this is Node ${deps.nodeMajor()}.`,
    );
  }

  if (plugin) {
    // The plugin's peers (nx and @nx/devkit 17+) make every npm install of an older Nx fail.
    const file = path.join(root, 'package.json');
    const text = fs.readFileSync(file, 'utf8');
    const pkg = readJsonFile(file);
    delete (pkg[plugin.field] as Json)[PLUGIN];
    const jsonc = loadJsonc(root);
    const after = JSON.stringify(pkg, null, 2);
    fs.writeFileSync(file, (jsonc && keepJsonLayout(jsonc, text, after)) || `${after}\n`);
  }
  for (let to = current + 1; to <= target; to++) {
    runNxStep({ root, to, last: to === NX_HOP_MAX, plugin, check, commit }, deps);
    deps.log(`\n✔ Nx ${NX_HOPS[to]} done.`);
  }
  if (plugin && target < NX_HOP_MAX) {
    deps.log(
      `\nnx-polystack stays out of package.json until the workspace is on Nx ${NX_HOP_MAX}; ` +
        `add it back with: npm i -D ${PLUGIN}@${plugin.spec} @nx/devkit@${NX_HOPS[NX_HOP_MAX]}`,
    );
  }
  if (plugin && target === NX_HOP_MAX) {
    deps.log(
      `\nnx-polystack ${plugin.spec} is back; "pstack update" moves it to the newest release.`,
    );
  }
  return 0;
}
