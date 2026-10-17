import { parseJson, readJson, Tree } from '@nx/devkit';

import { declaredVersion, Deps } from './dependencies';
import { hasLintStagedConfig } from './lint-staged';
import { scanProjects } from './project-json-files';

// ── typecheck ────────────────────────────────────────────────────────────────

/** `typecheck` target: tsc without output over the project's app or lib tsconfig. */
export function typecheckTarget(tsconfig: string) {
  return {
    executor: 'nx:run-commands',
    options: { command: `tsc --noEmit -p ${tsconfig}` },
  };
}

/** The tsconfig a project's typecheck uses (tsconfig.app.json, else tsconfig.lib.json), if any. */
export function typecheckTsconfig(tree: Tree, root: string): string | undefined {
  const base = root === '.' ? '' : `${root}/`;
  return [`${base}tsconfig.app.json`, `${base}tsconfig.lib.json`].find((f) => tree.exists(f));
}

/** Adds a typecheck target to the project at `root` when it has none; returns whether it did. */
export function addTypecheckTarget(tree: Tree, root: string): boolean {
  const file = root === '.' ? 'project.json' : `${root}/project.json`;
  const tsconfig = typecheckTsconfig(tree, root);
  if (!tsconfig || !tree.exists(file)) return false;
  let json: Record<string, unknown>;
  try {
    json = readJson(tree, file); // project.json may hold comments
  } catch {
    return false;
  }
  const targets = (json['targets'] ?? {}) as Record<string, unknown>;
  if (targets['typecheck'] !== undefined) return false;
  json['targets'] = { ...targets, typecheck: typecheckTarget(tsconfig) };
  tree.write(file, JSON.stringify(json, null, 2) + '\n');
  return true;
}

/** Adds typecheck targets to every project that has a tsconfig.app/lib.json and no target. */
export function addTypecheckTargets(tree: Tree): string[] {
  return scanProjects(tree)
    .filter((p) => addTypecheckTarget(tree, p.root))
    .map((p) => p.name);
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
  if (changed) tree.write('nx.json', JSON.stringify(nx, null, 2) + '\n');
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

const args = process.argv.slice(2);
if (!args.some((a) => !a.startsWith('-'))) process.exit(0);
let eslint;
try {
  eslint = require.resolve('eslint/bin/eslint.js', { paths: [process.cwd()] });
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
