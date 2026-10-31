import { parseJson, readJson, Tree } from '@nx/devkit';

import { declaredVersion, Deps } from './dependencies';
import { keepJsonLayout, loadJsonc } from './json-layout';
import { hasLintStagedConfig } from './lint-staged';
import { scanProjects } from './project-json-files';

// ── typecheck ────────────────────────────────────────────────────────────────

/**
 * `typecheck` target: tsc without output over the project's app or lib tsconfig. Angular
 * projects also get a `templates` configuration (`nx run <p>:typecheck:templates`) that runs ngc
 * without output, which checks the templates as the tsconfig's angularCompilerOptions ask.
 */
export function typecheckTarget(tsconfig: string, opts: { templates?: boolean } = {}) {
  return {
    executor: 'nx:run-commands',
    options: { command: `tsc --noEmit -p ${tsconfig}` },
    ...(opts.templates ? { configurations: templatesConfiguration(tsconfig) } : {}),
  };
}

function templatesConfiguration(tsconfig: string) {
  return { templates: { command: `ngc --noEmit -p ${tsconfig}` } };
}

/** The tsconfig a project's typecheck uses (tsconfig.app.json, else tsconfig.lib.json), if any. */
export function typecheckTsconfig(tree: Tree, root: string): string | undefined {
  const base = root === '.' ? '' : `${root}/`;
  return [`${base}tsconfig.app.json`, `${base}tsconfig.lib.json`].find((f) => tree.exists(f));
}

const ANGULAR_EXECUTOR =
  /^(?:@angular-devkit\/build-angular|@angular\/build|@nx\/angular|@nrwl\/angular|@mouryaamit\/nx-polystack:build$)/;

/**
 * An Angular (or Ionic) project: one of its tsconfig files sets angularCompilerOptions, or a target
 * runs an Angular builder or the polystack release build.
 */
export function isAngularProject(tree: Tree, root: string, json: Record<string, unknown>): boolean {
  const base = root === '.' ? '' : `${root}/`;
  for (const f of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.lib.json']) {
    if (/"angularCompilerOptions"/.test(tree.read(`${base}${f}`, 'utf8') ?? '')) return true;
  }
  const targets = (json['targets'] ?? {}) as Record<string, { executor?: unknown }>;
  return Object.values(targets).some(
    (t) => typeof t?.executor === 'string' && ANGULAR_EXECUTOR.test(t.executor),
  );
}

/** What adding a target did: added, already there, nothing to add, or left (comments). */
export type TargetChange = 'added' | 'exists' | 'none' | 'comments';

/**
 * Writes a project.json change: plain JSON is rewritten keeping its layout; JSON with comments is
 * left as it is ('comments'), since a rewrite would drop them.
 */
function updateProjectJson(
  tree: Tree,
  root: string,
  change: (json: Record<string, unknown>) => TargetChange,
): TargetChange {
  const file = root === '.' ? 'project.json' : `${root}/project.json`;
  const before = tree.read(file, 'utf8');
  if (before === null) return 'none';
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(before);
  } catch {
    try {
      json = readJson(tree, file);
    } catch {
      return 'none';
    }
    // Readable but with comments: say whether a change was needed, write nothing.
    const result = change(json);
    return result === 'added' ? 'comments' : result;
  }
  const result = change(json);
  if (result !== 'added') return result;
  const after = JSON.stringify(json, null, 2) + '\n';
  const jsonc = loadJsonc(tree.root);
  tree.write(file, (jsonc && keepJsonLayout(jsonc, before, after)) || after);
  return 'added';
}

/** Adds a typecheck target to the project at `root` when it has none. */
export function typecheckTargetChange(tree: Tree, root: string): TargetChange {
  const tsconfig = typecheckTsconfig(tree, root);
  if (!tsconfig) return 'none';
  return updateProjectJson(tree, root, (json) => {
    const targets = (json['targets'] ?? {}) as Record<string, unknown>;
    if (targets['typecheck'] !== undefined) return 'exists';
    const templates = isAngularProject(tree, root, json);
    json['targets'] = { ...targets, typecheck: typecheckTarget(tsconfig, { templates }) };
    return 'added';
  });
}

/** Adds a typecheck target to the project at `root` when it has none; returns whether it did. */
export function addTypecheckTarget(tree: Tree, root: string): boolean {
  return typecheckTargetChange(tree, root) === 'added';
}

/**
 * Adds typecheck targets to every project that has a tsconfig.app/lib.json and no target; returns
 * their names. Projects whose project.json holds comments are left and listed in `comments`.
 */
export function addTypecheckTargets(tree: Tree, comments: string[] = []): string[] {
  const added: string[] = [];
  for (const p of scanProjects(tree)) {
    const change = typecheckTargetChange(tree, p.root);
    if (change === 'added') added.push(p.name);
    if (change === 'comments') comments.push(p.name);
  }
  return added;
}

/** Whether any project has a typecheck target (the root typecheck script then has work). */
export function hasTypecheckTargets(tree: Tree): boolean {
  return scanProjects(tree).some(
    (p) => ((p.json['targets'] ?? {}) as Record<string, unknown>)['typecheck'] !== undefined,
  );
}

/**
 * The `templates` configuration on an Angular project's typecheck target as pstack writes it
 * (`tsc --noEmit -p <tsconfig>`, no configurations of that name). Other typecheck targets are
 * the workspace's own and are left alone.
 */
export function templatesConfigChange(tree: Tree, root: string): TargetChange {
  return updateProjectJson(tree, root, (json) => {
    const targets = (json['targets'] ?? {}) as Record<string, Record<string, unknown>>;
    const t = targets['typecheck'];
    const command = (t?.['options'] as Record<string, unknown> | undefined)?.['command'];
    const m = typeof command === 'string' ? /^tsc --noEmit -p (\S+)$/.exec(command) : null;
    if (!t || t['executor'] !== 'nx:run-commands' || !m) return 'none';
    if (!isAngularProject(tree, root, json)) return 'none';
    const configs = (t['configurations'] ?? {}) as Record<string, unknown>;
    if (configs['templates'] !== undefined) return 'exists';
    t['configurations'] = { ...configs, ...templatesConfiguration(m[1]) };
    return 'added';
  });
}

/** `analyze` target of a Flutter project (flutter analyze in the project folder). */
export function analyzeTarget(root: string) {
  return { executor: 'nx:run-commands', options: { command: 'flutter analyze', cwd: root } };
}

/** Adds `analyze` to a Flutter project (a pubspec.yaml next to its project.json) without one. */
export function analyzeTargetChange(tree: Tree, root: string): TargetChange {
  const base = root === '.' ? '' : `${root}/`;
  if (!tree.exists(`${base}pubspec.yaml`)) return 'none';
  return updateProjectJson(tree, root, (json) => {
    const targets = (json['targets'] ?? {}) as Record<string, unknown>;
    if (targets['analyze'] !== undefined) return 'exists';
    json['targets'] = { ...targets, analyze: analyzeTarget(root) };
    return 'added';
  });
}

/** The root npm script that type-checks every project. */
export const TYPECHECK_SCRIPT = 'nx run-many -t typecheck';

/**
 * Adds the root `typecheck` npm script when there is none. 'exists' when it already runs the
 * typecheck targets, 'other' when the workspace's own `typecheck` script does something else.
 */
export function addTypecheckScript(tree: Tree): 'added' | 'exists' | 'other' | 'none' {
  const before = tree.read('package.json', 'utf8');
  if (before === null) return 'none';
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(before);
  } catch {
    return 'none';
  }
  const current = pkg.scripts?.['typecheck'];
  if (current !== undefined) {
    return /\bnx\s+run-many\b.*(?:-t|--targets?)[ =]typecheck\b/.test(current) ? 'exists' : 'other';
  }
  pkg.scripts = { ...(pkg.scripts ?? {}), typecheck: TYPECHECK_SCRIPT };
  const after = JSON.stringify(pkg, null, 2) + '\n';
  const jsonc = loadJsonc(tree.root);
  tree.write('package.json', (jsonc && keepJsonLayout(jsonc, before, after)) || after);
  return 'added';
}

/**
 * Nx 20+ TypeScript-solution workspaces infer their own typecheck targets through the
 * `@nx/js/typescript` plugin; pstack then adds none.
 */
export function infersTypecheck(tree: Tree): boolean {
  if (!tree.exists('nx.json')) return false;
  let nx: Record<string, unknown>;
  try {
    nx = readJson(tree, 'nx.json');
  } catch {
    return false;
  }
  const plugins = Array.isArray(nx['plugins']) ? (nx['plugins'] as unknown[]) : [];
  return plugins.some((p) => {
    const name = typeof p === 'string' ? p : (p as { plugin?: unknown })?.plugin;
    if (name !== '@nx/js/typescript') return false;
    const opts = typeof p === 'object' ? (p as { options?: Record<string, unknown> }).options : {};
    const tc = opts?.['typecheck'];
    // The plugin infers typecheck unless typecheck is false.
    return tc !== false;
  });
}

export const TYPECHECK_TARGET_DEFAULTS = {
  cache: true,
  inputs: [
    'default',
    '^production',
    '{workspaceRoot}/tsconfig.base.json',
    // App env files live in the workspace-root environments/ folder (no project owns them).
    '{workspaceRoot}/environments/**/*',
  ],
};

/** nx.json: typecheck cached (targetDefaults, and cacheableOperations when the workspace uses them). */
export function addTypecheckNxDefaults(tree: Tree): boolean {
  if (!tree.exists('nx.json')) return false;
  let nx: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    nx = readJson(tree, 'nx.json');
  } catch {
    return false;
  }
  let changed = false;
  nx['targetDefaults'] = nx['targetDefaults'] ?? {};
  if (nx['targetDefaults']['typecheck'] === undefined) {
    // Nx refuses an input it does not know: ^production only when the workspace defines it.
    const named = (nx['namedInputs'] ?? {}) as Record<string, unknown>;
    const own = named['default'] ? 'default' : '{projectRoot}/**/*';
    const deps = named['production'] ? ['^production'] : named['default'] ? ['^default'] : [];
    const rest = TYPECHECK_TARGET_DEFAULTS.inputs.filter((i) => i.startsWith('{workspaceRoot}'));
    nx['targetDefaults']['typecheck'] = { cache: true, inputs: [own, ...deps, ...rest] };
    changed = true;
  }
  for (const runner of Object.values<Record<string, any>>(nx['tasksRunnerOptions'] ?? {})) {
    // eslint-disable-line @typescript-eslint/no-explicit-any
    const ops = runner?.['options']?.['cacheableOperations'];
    if (Array.isArray(ops) && !ops.includes('typecheck')) {
      ops.push('typecheck');
      changed = true;
    }
  }
  if (changed) {
    const before = tree.read('nx.json', 'utf8') ?? '';
    const after = JSON.stringify(nx, null, 2) + '\n';
    const jsonc = loadJsonc(tree.root);
    tree.write('nx.json', (jsonc && keepJsonLayout(jsonc, before, after)) || after);
  }
  return changed;
}

// ── CI ───────────────────────────────────────────────────────────────────────

export const CI_FILES = ['.github/workflows/ci.yml', 'Jenkinsfile'];
const AFFECTED_STEP = /nx affected -t lint test build\b/;

/** Adds typecheck to the affected step of the CI files; returns [changed, without the step]. */
export function addTypecheckToCi(tree: Tree): { changed: string[]; unknown: string[] } {
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const file of CI_FILES) {
    const text = tree.read(file, 'utf8');
    if (text === null) continue;
    if (/nx affected[^\n]*-t [^\n]*typecheck/.test(text)) continue;
    if (!AFFECTED_STEP.test(text)) {
      unknown.push(file);
      continue;
    }
    tree.write(
      file,
      text.replace(
        new RegExp(AFFECTED_STEP.source, 'g'),
        'nx affected -t lint typecheck test build',
      ),
    );
    changed.push(file);
  }
  return { changed, unknown };
}

// ── ESLint ───────────────────────────────────────────────────────────────────

export const QUALITY_RULES = {
  'import/no-unresolved': 'warn',
  'unused-imports/no-unused-imports': 'warn',
} as const;

export const QUALITY_ESLINT_OVERRIDE = {
  files: ['*.ts', '*.tsx'],
  plugins: ['import', 'unused-imports'],
  settings: {
    'import/resolver': { typescript: { alwaysTryTypes: true, project: 'tsconfig.base.json' } },
  },
  rules: { ...QUALITY_RULES },
};

/** ESLint config files other than .eslintrc.json that the override cannot be merged into. */
const OTHER_ESLINT_CONFIGS = [
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslintrc',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
];

export type EslintResult = 'added' | 'present' | 'no-json-config' | 'has-comments';

/** Adds the quality override to the root .eslintrc.json unless one of its rules is configured. */
export function addQualityEslintRules(tree: Tree): EslintResult {
  const text = tree.read('.eslintrc.json', 'utf8');
  if (text === null) {
    return OTHER_ESLINT_CONFIGS.some((f) => tree.exists(f)) ? 'no-json-config' : 'present';
  }
  if (Object.keys(QUALITY_RULES).some((rule) => text.includes(`"${rule}"`))) return 'present';
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(text);
  } catch {
    try {
      parseJson(text);
      return 'has-comments'; // valid with comments: rewriting would drop them
    } catch {
      return 'no-json-config';
    }
  }
  const overrides = Array.isArray(config['overrides']) ? (config['overrides'] as unknown[]) : [];
  const override = JSON.parse(JSON.stringify(QUALITY_ESLINT_OVERRIDE));
  // Angular CLI style workspaces keep their paths in tsconfig.json.
  if (!tree.exists('tsconfig.base.json') && tree.exists('tsconfig.json')) {
    override.settings['import/resolver'].typescript.project = 'tsconfig.json';
  }
  overrides.push(override);
  config['overrides'] = overrides;
  tree.write('.eslintrc.json', JSON.stringify(config, null, 2) + '\n');
  return 'added';
}

/** eslint-plugin-unused-imports major matching @typescript-eslint (its peer). */
export function unusedImportsVersion(tree: Tree): string {
  const ts =
    ['@typescript-eslint/eslint-plugin', '@typescript-eslint/parser', 'typescript-eslint']
      .map((p) => declaredVersion(tree, p))
      .find((v) => v !== undefined && /\d/.test(v)) ?? '';
  const major = Number(/(\d+)/.exec(ts)?.[1] ?? '5');
  if (major >= 8) return '^4.1.4';
  if (major >= 6) return '^3.2.0';
  return '^2.0.0';
}

/** Packages the quality ESLint override needs. */
export function qualityEslintDependencies(tree: Tree): Deps {
  return {
    'eslint-plugin-import': '^2.29.1',
    'eslint-import-resolver-typescript': '^3.6.1',
    'eslint-plugin-unused-imports': unusedImportsVersion(tree),
  };
}

// ── lint-staged ──────────────────────────────────────────────────────────────

export const LINT_STAGED_ESLINT_SCRIPT = 'tools/scripts/lint-staged-eslint.js';
export const LINT_STAGED_MODES = ['warn', 'block'] as const;
export type LintStagedMode = (typeof LINT_STAGED_MODES)[number];

/** The ESLint step of each mode (extra flags are appended). */
export const LINT_STAGED_ESLINT_COMMAND: Record<LintStagedMode, string> = {
  warn: `node ${LINT_STAGED_ESLINT_SCRIPT} --fix`,
  block: 'eslint --fix',
};

/**
 * Runs the workspace's ESLint (never npx or a shell: paths with spaces stay one argument) on the
 * staged files. Lint problems (exit 1) are reported without blocking the commit; ESLint that
 * cannot be found or crashes (exit 2) still blocks.
 */
export const LINT_STAGED_ESLINT_JS = `#!/usr/bin/env node
// Written by nx-polystack. lint-staged runs it for staged *.ts files: ESLint fixes what it can and
// reports the rest without blocking the commit.
const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
if (!args.some((a) => !a.startsWith('-'))) process.exit(0);
let eslint;
try {
  // ESLint 8+ does not export bin/eslint.js; its package.json (always exported) names the bin.
  const pkgFile = require.resolve('eslint/package.json', { paths: [process.cwd()] });
  const bin = require(pkgFile).bin;
  eslint = path.join(path.dirname(pkgFile), (bin && (bin.eslint || bin)) || 'bin/eslint.js');
} catch {
  console.error('lint-staged-eslint: ESLint is not installed in this workspace (npm install).');
  process.exit(2);
}
const r = spawnSync(process.execPath, [eslint, ...args], { stdio: 'inherit' });
if (r.error) {
  console.error('lint-staged-eslint: could not run ESLint: ' + r.error.message);
  process.exit(2);
}
if (r.status === 1) {
  console.warn(
    '\\nESLint found problems (shown above); the commit is not blocked. ' +
      'To block commits on ESLint errors: pstack infra --lint-staged=block',
  );
  process.exit(0);
}
process.exit(r.status === null ? 2 : r.status);
`;

/** An ESLint step of lint-staged: [prefix, extra flags], or null. */
function eslintStep(cmd: string): string | null {
  const script = new RegExp(
    `^node\\s+(?:\\./)?${LINT_STAGED_ESLINT_SCRIPT.replace(/[./]/g, '\\$&')}(?=\\s|$)`,
  );
  const m = script.exec(cmd) ?? /^(?:npx\s+(?:--no-install\s+|--no\s+)?)?eslint(?=\s|$)/.exec(cmd);
  if (!m) return null;
  return cmd
    .slice(m[0].length)
    .trim()
    .split(/\s+/)
    .filter((f) => f && f !== '--fix')
    .join(' ');
}

export type LintStagedResult =
  | 'set'
  | 'unchanged'
  | 'other-config'
  | 'no-config'
  | 'no-eslint-step';

/**
 * Switches the ESLint steps of the package.json lint-staged config to the mode, keeping their
 * other flags and every other command (and writes the warn script).
 */
export function setLintStagedMode(tree: Tree, mode: LintStagedMode): LintStagedResult {
  if (!tree.exists('package.json')) return 'no-config';
  const pkg = JSON.parse(tree.read('package.json', 'utf8') ?? '{}');
  const config = pkg['lint-staged'];
  if (config === undefined) return hasLintStagedConfig(tree) ? 'other-config' : 'no-config';
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'other-config';

  let changed = false;
  let found = false;
  for (const [glob, cmds] of Object.entries(config as Record<string, unknown>)) {
    const list = Array.isArray(cmds) ? cmds : [cmds];
    const next = list.map((c) => {
      if (typeof c !== 'string') return c;
      const flags = eslintStep(c.trim());
      if (flags === null) return c;
      found = true;
      return [LINT_STAGED_ESLINT_COMMAND[mode], flags].filter(Boolean).join(' ');
    });
    if (JSON.stringify(next) !== JSON.stringify(list)) {
      (config as Record<string, unknown>)[glob] = Array.isArray(cmds) ? next : next[0];
      changed = true;
    }
  }
  if (!found) return 'no-eslint-step';
  if (mode === 'warn' && tree.read(LINT_STAGED_ESLINT_SCRIPT, 'utf8') !== LINT_STAGED_ESLINT_JS) {
    tree.write(LINT_STAGED_ESLINT_SCRIPT, LINT_STAGED_ESLINT_JS);
    changed = true;
  }
  if (!changed) return 'unchanged';
  tree.write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  return 'set';
}
