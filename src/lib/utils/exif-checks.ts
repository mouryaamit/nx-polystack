import type { Tree } from '@nx/devkit';

import { keepJsonLayout, loadJsonc } from './json-layout';
import { hasLintStagedConfig } from './lint-staged';
import { CI_FILES } from './quality';

/**
 * Source-image EXIF in a workspace: the root npm scripts, the lint-staged step that cleans staged
 * images (fix) or refuses the commit (check), and the CI step that checks every app's images.
 */

export const EXIF_MODES = ['fix', 'check', 'off'] as const;
export type ExifMode = (typeof EXIF_MODES)[number];

export const EXIF_SCRIPTS = {
  'assets:strip-exif': 'pstack assets strip-exif --all',
  'assets:check-exif': 'pstack assets strip-exif --all --check',
} as const;

export const EXIF_LINT_STAGED_GLOB = '*.{jpg,jpeg,png,webp}';
const LINT_STAGED_COMMAND: Record<Exclude<ExifMode, 'off'>, string> = {
  fix: 'pstack assets strip-exif',
  check: 'pstack assets strip-exif --check',
};
const PSTACK_STEP = /\bpstack\s+assets\s+strip-exif\b/;
const CI_STEP = /assets:check-exif|pstack\s+assets\s+strip-exif/;

export function parseExifMode(input: string | undefined): ExifMode | undefined {
  if (input === undefined) return undefined;
  const v = input.trim();
  if (!(EXIF_MODES as readonly string[]).includes(v)) {
    throw new Error(`--exif must be ${EXIF_MODES.join(', ')} (got "${input}").`);
  }
  return v as ExifMode;
}

function readPkg(tree: Tree): { before: string; pkg: Record<string, unknown> } | null {
  const before = tree.read('package.json', 'utf8');
  if (before === null) return null;
  try {
    return { before, pkg: JSON.parse(before) };
  } catch {
    return null;
  }
}

function writePkg(tree: Tree, before: string, pkg: Record<string, unknown>): void {
  const after = JSON.stringify(pkg, null, 2) + '\n';
  const jsonc = loadJsonc(tree.root);
  tree.write('package.json', (jsonc && keepJsonLayout(jsonc, before, after)) || after);
}

/** Adds the root scripts assets:strip-exif and assets:check-exif where missing; returns them. */
export function addExifScripts(tree: Tree): string[] {
  const read = readPkg(tree);
  if (!read) return [];
  const scripts = { ...((read.pkg['scripts'] as Record<string, string>) ?? {}) };
  // A workspace that already runs pstack assets under other names has what it needs.
  if (Object.values(scripts).some((c) => typeof c === 'string' && PSTACK_STEP.test(c))) return [];
  const added = Object.keys(EXIF_SCRIPTS).filter((name) => scripts[name] === undefined);
  if (added.length === 0) return [];
  for (const name of added) scripts[name] = EXIF_SCRIPTS[name as keyof typeof EXIF_SCRIPTS];
  read.pkg['scripts'] = scripts;
  writePkg(tree, read.before, read.pkg);
  return added;
}

export interface ExifModeResult {
  scripts: string[];
  lintStaged: 'set' | 'removed' | 'unchanged' | 'other-config' | 'no-config';
  ci: { changed: string[]; unknown: string[] };
}

/** package.json lint-staged: the images step for the mode (off removes pstack's step). */
function setLintStaged(tree: Tree, mode: ExifMode): ExifModeResult['lintStaged'] {
  const read = readPkg(tree);
  if (!read) return 'no-config';
  const config = read.pkg['lint-staged'];
  if (config === undefined) return hasLintStagedConfig(tree) ? 'other-config' : 'no-config';
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'other-config';
  const c = config as Record<string, unknown>;
  // pstack's own step, under its glob or another one.
  const key =
    Object.keys(c).find((k) => {
      const v = c[k];
      return (Array.isArray(v) ? v : [v]).some((x) => typeof x === 'string' && PSTACK_STEP.test(x));
    }) ?? (c[EXIF_LINT_STAGED_GLOB] !== undefined ? undefined : EXIF_LINT_STAGED_GLOB);
  if (mode === 'off') {
    if (!key || c[key] === undefined) return 'unchanged';
    delete c[key];
    writePkg(tree, read.before, read.pkg);
    return 'removed';
  }
  if (!key) return 'other-config'; // the images glob runs something else: left alone
  const want = [LINT_STAGED_COMMAND[mode]];
  if (JSON.stringify(c[key]) === JSON.stringify(want)) return 'unchanged';
  c[key] = want;
  writePkg(tree, read.before, read.pkg);
  return 'set';
}

/** The CI step (npm run assets:check-exif) after the affected step; off removes it. */
function setCi(tree: Tree, mode: ExifMode): ExifModeResult['ci'] {
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const file of CI_FILES) {
    const text = tree.read(file, 'utf8');
    if (text === null) continue;
    const lines = text.split('\n');
    const has = lines.findIndex((l) => CI_STEP.test(l));
    if (mode === 'off') {
      if (has >= 0) {
        lines.splice(has, 1);
        tree.write(file, lines.join('\n'));
        changed.push(file);
      }
      continue;
    }
    if (has >= 0) continue;
    const at = lines.findIndex((l) => /nx affected\b/.test(l) && /(- run:|sh ')/.test(l));
    if (at < 0) {
      unknown.push(file);
      continue;
    }
    const indent = /^\s*/.exec(lines[at])?.[0] ?? '';
    const step =
      file === 'Jenkinsfile'
        ? "sh 'npm run assets:check-exif'"
        : '- run: npm run assets:check-exif';
    lines.splice(at + 1, 0, `${indent}${step}`);
    tree.write(file, lines.join('\n'));
    changed.push(file);
  }
  return { changed, unknown };
}

/** `pstack infra --exif=<mode>`: root scripts, lint-staged and CI for source-image EXIF. */
export function setExifMode(tree: Tree, mode: ExifMode): ExifModeResult {
  const scripts = mode === 'off' ? [] : addExifScripts(tree);
  return { scripts, lintStaged: setLintStaged(tree, mode), ci: setCi(tree, mode) };
}
