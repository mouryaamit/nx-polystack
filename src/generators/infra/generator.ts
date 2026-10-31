import * as os from 'os';
import * as path from 'path';

import { formatFiles, generateFiles, GeneratorCallback, logger, readJson, Tree } from '@nx/devkit';

import { installSource } from '../../cli/install-source';
import { PLUGIN_GITHUB_REPO, PLUGIN_NAME } from '../../cli/versions';
import { addMissingDependencies, declaredVersion } from '../../lib/utils/dependencies';
import { hasFlutterProject, refreshLlmBlocks } from '../../lib/utils/llm-block';
import {
  EXIF_LINT_STAGED_GLOB,
  ExifMode,
  ExifModeResult,
  parseExifMode,
  setExifMode,
} from '../../lib/utils/exif-checks';
import { addNpmScripts } from '../../lib/utils/npm-scripts';
import { fsTree } from '../../lib/utils/nx-tree';
import {
  addQualityEslintRules,
  addTypecheckNxDefaults,
  addTypecheckScript,
  addTypecheckTargets,
  addTypecheckToCi,
  EslintResult,
  hasTypecheckTargets,
  LINT_STAGED_MODES,
  LintStagedMode,
  qualityEslintDependencies,
  setLintStagedMode,
  TYPECHECK_SCRIPT,
} from '../../lib/utils/quality';

import {
  CiProvider,
  FlutterMode,
  InfraPart,
  parseCiProviders,
  parseFlutterMode,
  parseParts,
  parseUpgradeSchedule,
  parseUpgradeScope,
  PREPUSH_MARKER,
  UPGRADE_CRON,
  UpgradeSchedule,
  UpgradeScope,
} from './options';
import { InfraGeneratorSchema } from './schema.d';

const FILES = path.join(__dirname, 'files');
const PREPUSH = '.husky/pre-push';
const PLACEHOLDERS = ['<conduct-contact>', '<security-contact>'];

/** Files that configure commitlint; when one exists, :infra adds no commitlint.config.js. */
const COMMITLINT_CONFIGS = [
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
];

/** check:prepush as v0.9.0 wrote it (audit first and blocking); see the 0.9.1 migration. */
export const PREPUSH_V0_9_0 = 'npm audit --omit=dev --audit-level=high && secretlint "**/*"';

const AUDIT = 'npm audit --omit=dev --audit-level=high';

export const INFRA_SCRIPTS = {
  'check:cycles': 'node tools/scripts/check-cycles.js',
  'stale-code': 'knip --no-exit-code',
  // The secret scan blocks the push; the audit only warns (advisories without a fix for the
  // workspace's framework major would otherwise block every push). check:audit is the strict one.
  'check:prepush':
    `secretlint "**/*" && (${AUDIT} || echo "npm audit found advisories (warning only).")` +
    ' && echo "Strict dependency audit: npm run check:audit"',
  'check:audit': AUDIT,
} as const;

const COMMITLINT_DEPS = {
  '@commitlint/cli': '^18.0.0',
  '@commitlint/config-conventional': '^18.0.0',
};
const QUALITY_DEPS = {
  knip: '^5.0.0',
  secretlint: '^8.0.0',
  '@secretlint/secretlint-rule-preset-recommend': '^8.0.0',
  husky: '^9.0.0',
};

export interface InfraOptions {
  parts: InfraPart[];
  ci: CiProvider[];
  ciCache: boolean;
  flutter: FlutterMode;
  upgradeSchedule: UpgradeSchedule;
  upgradeScope: UpgradeScope;
  /** Switch the lint-staged ESLint step (unset: leave it). */
  lintStaged?: LintStagedMode;
  /** Source-image EXIF: lint-staged and CI steps (unset: leave them). */
  exif?: ExifMode;
  force: boolean;
}

export interface InfraReport {
  /** New files. */
  written: string[];
  /** Existing files replaced because of --force. */
  overwritten: string[];
  /** Existing files that differ and were kept. */
  skipped: string[];
  /** Existing files whose content already matches. */
  unchanged: string[];
  /** Existing files that :infra appended to (.husky/pre-push). */
  appended: string[];
  /** npm scripts that exist with another command and were kept. */
  keptScripts: string[];
  /** Placeholders in files written by this run. */
  placeholders: Array<{ file: string; placeholder: string }>;
  notes: string[];
  installTask?: GeneratorCallback;
}

/** Validates the schema; throws (with a message fit for the CLI) on a bad value. */
export function normalizeInfraOptions(schema: InfraGeneratorSchema): InfraOptions {
  return {
    parts: parseParts(schema.with),
    ci: parseCiProviders(schema.ci),
    ciCache: !!schema.ciCache,
    flutter: parseFlutterMode(schema.flutter),
    upgradeSchedule: parseUpgradeSchedule(schema.upgradeSchedule),
    upgradeScope: parseUpgradeScope(schema.upgradeScope),
    lintStaged: parseLintStaged(schema.lintStaged),
    exif: parseExifMode(schema.exif),
    force: !!schema.force,
  };
}

function parseLintStaged(input: string | undefined): LintStagedMode | undefined {
  if (input === undefined) return undefined;
  const v = input.trim();
  if (!(LINT_STAGED_MODES as readonly string[]).includes(v)) {
    throw new Error(`--lint-staged must be ${LINT_STAGED_MODES.join(' or ')} (got "${input}").`);
  }
  return v as LintStagedMode;
}

/** nx.json `affected.defaultBase`, else master. */
export function workspaceBaseBranch(tree: Tree): string {
  try {
    const base = readJson(tree, 'nx.json')?.affected?.defaultBase;
    if (typeof base === 'string' && base.trim()) return base.trim();
  } catch {
    // no or unreadable nx.json
  }
  return 'master';
}

function nxCacheDirectory(tree: Tree): string {
  try {
    const dir = readJson(tree, 'nx.json')?.cacheDirectory;
    if (typeof dir === 'string' && dir.trim()) return dir.trim().replace(/^\.\//, '');
  } catch {
    // fall through
  }
  return '.nx/cache';
}

/** Renders a template folder in memory; returns workspace path → content. */
function render(dir: string, vars: Record<string, unknown>): Map<string, string> {
  // Never flushed: the root only has to be a path that is not the workspace.
  const scratch = fsTree(path.join(os.tmpdir(), `pstack-infra-render-${process.pid}`));
  generateFiles(scratch, path.join(FILES, dir), '.', { ...vars, template: '' });
  const out = new Map<string, string>();
  for (const c of scratch.listChanges()) {
    if (c.type !== 'DELETE' && c.content) out.set(c.path, c.content.toString('utf8'));
  }
  return out;
}

function hasCommitlintConfig(tree: Tree): boolean {
  if (COMMITLINT_CONFIGS.some((f) => tree.exists(f))) return true;
  try {
    return readJson(tree, 'package.json')?.commitlint !== undefined;
  } catch {
    return false;
  }
}

/** Template folders (under files/) for the chosen parts and providers. */
function templateDirs(tree: Tree, o: InfraOptions, report: InfraReport): string[] {
  const dirs: string[] = [];
  const github = o.ci.includes('github-actions');
  if (o.parts.includes('docs')) dirs.push('docs');
  if (o.parts.includes('ci')) {
    dirs.push('ci/common');
    if (github) dirs.push('ci/github-actions');
    if (o.ci.includes('jenkins')) dirs.push('ci/jenkins');
    if (github && !hasCommitlintConfig(tree)) dirs.push('ci/commitlint');
  }
  if (o.parts.includes('quality')) dirs.push('quality');
  if (o.parts.includes('upgrades')) {
    if (github) dirs.push('upgrades');
    else {
      report.notes.push(
        'The dependency-upgrade workflow runs on GitHub Actions only; it was not added because ' +
          '--ci does not include github-actions.',
      );
    }
  }
  return dirs;
}

function placeFile(tree: Tree, file: string, content: string, o: InfraOptions, r: InfraReport) {
  if (file === PREPUSH) {
    placePrePush(tree, content, r);
    return;
  }
  if (!tree.exists(file)) {
    tree.write(file, content);
    r.written.push(file);
    return;
  }
  if (tree.read(file, 'utf8') === content) {
    r.unchanged.push(file);
    return;
  }
  if (o.force) {
    tree.write(file, content);
    r.overwritten.push(file);
    return;
  }
  r.skipped.push(file);
}

/** .husky/pre-push is never replaced: our lines are appended once, after a marker. */
function placePrePush(tree: Tree, content: string, r: InfraReport): void {
  if (!tree.exists(PREPUSH)) {
    tree.write(PREPUSH, content);
    r.written.push(PREPUSH);
    return;
  }
  const current = tree.read(PREPUSH, 'utf8') ?? '';
  if (current.split(/\r?\n/).some((line) => line.trim() === PREPUSH_MARKER)) {
    r.unchanged.push(PREPUSH);
    return;
  }
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  tree.write(PREPUSH, current + sep + content);
  r.appended.push(PREPUSH);
}

function addScripts(tree: Tree, wanted: Record<string, string>, r: InfraReport): void {
  const existing: Record<string, string> = readJson(tree, 'package.json').scripts ?? {};
  const missing: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(wanted)) {
    if (existing[name] === undefined) missing[name] = cmd;
    else if (existing[name] !== cmd) r.keptScripts.push(name);
  }
  // Only missing scripts are passed, so this never needs (or uses) force.
  if (Object.keys(missing).length > 0) addNpmScripts(tree, missing);
}

/**
 * Writes the chosen parts into the tree and updates package.json (missing scripts and
 * dependencies only). Does not format, refresh the llm block or log; returns what it did.
 */
export function applyInfra(tree: Tree, schema: InfraGeneratorSchema): InfraReport {
  const o = normalizeInfraOptions(schema);
  const report: InfraReport = {
    written: [],
    overwritten: [],
    skipped: [],
    unchanged: [],
    appended: [],
    keptScripts: [],
    placeholders: [],
    notes: [],
  };

  const source = installSource();
  const vars = {
    baseBranch: workspaceBaseBranch(tree),
    cacheDirectory: nxCacheDirectory(tree),
    ciCache: o.ciCache,
    flutter: o.flutter === 'on' || (o.flutter === 'auto' && hasFlutterProject(tree)),
    upgradeSchedule: o.upgradeSchedule,
    upgradeCron: UPGRADE_CRON[o.upgradeSchedule],
    upgradeScope: o.upgradeScope,
    pluginName: PLUGIN_NAME,
    pluginRepo: source.kind === 'github' ? source.repo : PLUGIN_GITHUB_REPO,
    pluginFromGithub: source.kind === 'github',
    prepushMarker: PREPUSH_MARKER,
  };

  const rendered = new Map<string, string>();
  for (const dir of templateDirs(tree, o, report)) {
    for (const [file, content] of render(dir, vars)) rendered.set(file, content);
  }
  for (const file of [...rendered.keys()].sort()) {
    placeFile(tree, file, rendered.get(file) ?? '', o, report);
  }

  for (const file of [...report.written, ...report.overwritten].sort()) {
    const content = tree.read(file, 'utf8') ?? '';
    for (const placeholder of PLACEHOLDERS) {
      if (content.includes(placeholder)) report.placeholders.push({ file, placeholder });
    }
  }

  // package.json: scripts and dependencies, only when missing.
  if (tree.exists('package.json')) {
    const scripts: Record<string, string> = {};
    const devDeps: Record<string, string> = {};
    if (o.parts.includes('ci')) {
      scripts['check:cycles'] = INFRA_SCRIPTS['check:cycles'];
      if (o.ci.includes('github-actions')) Object.assign(devDeps, COMMITLINT_DEPS);
    }
    if (o.parts.includes('quality')) {
      scripts['stale-code'] = INFRA_SCRIPTS['stale-code'];
      scripts['check:prepush'] = INFRA_SCRIPTS['check:prepush'];
      scripts['check:audit'] = INFRA_SCRIPTS['check:audit'];
      // Without husky the pre-push hook never runs.
      if (declaredVersion(tree, 'husky') === undefined) scripts['prepare'] = 'husky';
      Object.assign(devDeps, QUALITY_DEPS);
      if (applyQualityChecks(tree, report) === 'added') {
        Object.assign(devDeps, qualityEslintDependencies(tree));
      }
    }
    if (o.exif) exifNotes(setExifMode(tree, o.exif), o.exif, report);
    if (o.lintStaged) {
      const r = setLintStagedMode(tree, o.lintStaged);
      if (r === 'set')
        report.notes.push(
          `lint-staged: ESLint now ${
            o.lintStaged === 'warn'
              ? 'reports without blocking the commit'
              : 'blocks the commit on errors'
          }.`,
        );
      else if (r === 'other-config')
        report.notes.push(
          'lint-staged is configured outside package.json; change its ESLint step by hand (node tools/scripts/lint-staged-eslint.js reports without blocking).',
        );
      else if (r === 'no-config')
        report.notes.push('No lint-staged config found; --lint-staged changed nothing.');
      else if (r === 'no-eslint-step')
        report.notes.push('lint-staged has no ESLint step; --lint-staged changed nothing.');
    }
    addScripts(tree, scripts, report);
    report.keptScripts = report.keptScripts.filter((s) => s !== 'prepare');
    report.installTask = addMissingDependencies(tree, {}, devDeps);
  }

  const github = o.ci.includes('github-actions');
  if (
    github &&
    source.kind === 'github' &&
    (o.parts.includes('ci') || o.parts.includes('upgrades')) &&
    [...report.written, ...report.overwritten].some((f) => f.startsWith('.github/workflows/'))
  ) {
    report.notes.push(
      `Add a repository secret PSTACK_REPO_TOKEN (read access to ${source.repo}) so the ` +
        'workflows can install the private nx-polystack plugin' +
        (o.parts.includes('upgrades') ? ' and the upgrade workflow can find its releases.' : '.'),
    );
  }
  return report;
}

function exifNotes(r: ExifModeResult, mode: ExifMode, report: InfraReport): void {
  if (r.scripts.length > 0) {
    report.notes.push(`npm scripts ${r.scripts.join(', ')} (pstack assets strip-exif) added.`);
  }
  if (r.lintStaged === 'set') {
    report.notes.push(
      mode === 'fix'
        ? 'lint-staged: staged images lose EXIF/XMP/IPTC on commit (pstack assets strip-exif).'
        : 'lint-staged: commits with images that carry EXIF/XMP/IPTC are refused.',
    );
  }
  if (r.lintStaged === 'removed') report.notes.push("lint-staged: pstack's image step removed.");
  if (r.lintStaged === 'other-config') {
    report.notes.push(
      `lint-staged is configured outside package.json (or ${EXIF_LINT_STAGED_GLOB} runs something ` +
        'else); add `pstack assets strip-exif` for staged images by hand.',
    );
  }
  if (r.ci.changed.length > 0) {
    report.notes.push(
      mode === 'off'
        ? `CI image check removed from ${r.ci.changed.join(', ')}.`
        : `CI checks source images (npm run assets:check-exif) in ${r.ci.changed.join(', ')}.`,
    );
  }
  if (r.ci.unknown.length > 0) {
    report.notes.push(
      `Add \`npm run assets:check-exif\` to ${r.ci.unknown.join(
        ', ',
      )} by hand (no nx affected step found).`,
    );
  }
}

/** typecheck targets and nx.json defaults, the import/unused-imports ESLint rules (warn). */
export function applyQualityChecks(tree: Tree, report: { notes: string[] }): EslintResult {
  const commented: string[] = [];
  const typed = addTypecheckTargets(tree, commented);
  addTypecheckNxDefaults(tree);
  if (commented.length > 0) {
    report.notes.push(
      `The project.json of ${commented.join(', ')} holds comments, so no typecheck target was ` +
        'written there; add it by hand.',
    );
  }
  const script = hasTypecheckTargets(tree) ? addTypecheckScript(tree) : 'none';
  if (script === 'other') {
    report.notes.push(
      `The root "typecheck" npm script does something else; ${TYPECHECK_SCRIPT} type-checks ` +
        'every project.',
    );
  }
  if (typed.length > 0) {
    report.notes.push(
      `typecheck target added to ${typed.join(', ')}. Run npx nx run-many -t typecheck once ` +
        'before merging: libraries are now type-checked as a whole, not only what apps import.',
    );
  }
  const ci = addTypecheckToCi(tree);
  if (ci.changed.length > 0) {
    report.notes.push(`typecheck added to the CI affected step in ${ci.changed.join(', ')}.`);
  }
  if (ci.unknown.length > 0) {
    report.notes.push(
      `Add typecheck to the nx affected targets in ${ci.unknown.join(', ')} by hand ` +
        '(e.g. nx affected -t lint typecheck test build).',
    );
  }
  const eslint = addQualityEslintRules(tree);
  report.notes.push(...eslintNote(eslint));
  return eslint;
}

/** Note for an ESLint config the quality rules could not be added to. */
export function eslintNote(result: EslintResult): string[] {
  const rules =
    'import/no-unresolved (TypeScript resolver) and unused-imports/no-unused-imports as warnings';
  if (result === 'no-json-config') {
    return [`The ESLint config is not .eslintrc.json; add ${rules} by hand.`];
  }
  if (result === 'has-comments') {
    return [`.eslintrc.json has comments, which a rewrite would drop; add ${rules} by hand.`];
  }
  return [];
}

function logReport(r: InfraReport): void {
  const lines = (files: string[]) => files.map((f) => `  ${f}`).join('\n');
  if (r.appended.length > 0) {
    logger.info(`Appended the pre-push checks to:\n${lines(r.appended)}`);
  }
  if (r.keptScripts.length > 0) {
    logger.info(
      `Kept existing npm scripts (not changed):\n${lines(r.keptScripts)}\n` +
        'Check that they still run what CI and the hooks expect.',
    );
  }
  if (r.placeholders.length > 0) {
    logger.info(
      `Fill in:\n${r.placeholders.map((p) => `  ${p.placeholder} in ${p.file}`).join('\n')}`,
    );
  }
  for (const note of r.notes) logger.info(note);
  if (r.skipped.length > 0) {
    logger.info(`Kept existing files (pass --force to overwrite):\n${lines(r.skipped)}`);
  }
}

export default async function infraGenerator(
  tree: Tree,
  schema: InfraGeneratorSchema,
): Promise<GeneratorCallback | undefined> {
  const report = applyInfra(tree, schema);
  if (!schema.skipFormat) await formatFiles(tree);
  // After formatting: Prettier must not touch the text around the block.
  refreshLlmBlocks(tree);
  logReport(report);
  return report.installTask;
}
