import * as path from 'path';

import { logger, readJson, Tree } from '@nx/devkit';

import { readPackageVersion, selfPackageRoot } from '../../cli/context';

import { declaredVersion, nxVersion } from './dependencies';
import { flutterEnvNames } from './env-files';
import { workspaceNpmScope } from './workspace';

/**
 * The managed instruction block for AI assistants: a generated description of the workspace,
 * kept between two HTML-comment markers in CLAUDE.md / AGENTS.md / copilot-instructions.md.
 *
 * The rendered Markdown is already in the shape Prettier prints (aligned tables, blank lines
 * between blocks), so formatting the file never changes the block, and nothing here runs
 * Prettier itself — text outside the block stays byte-for-byte as the user wrote it.
 */

export const LLM_START = '<!-- nx-polystack:start -->';
export const LLM_END = '<!-- nx-polystack:end -->';

export type LlmProvider = 'claude' | 'agents' | 'copilot';

export interface LlmTarget {
  file: string;
  /** First line of a newly created file. */
  title: string;
}

export const LLM_PROVIDERS: Readonly<Record<LlmProvider, LlmTarget>> = {
  claude: { file: 'CLAUDE.md', title: '# CLAUDE.md' },
  agents: { file: 'AGENTS.md', title: '# AGENTS.md' },
  copilot: { file: '.github/copilot-instructions.md', title: '# GitHub Copilot instructions' },
};

const PROVIDER_ORDER: readonly LlmProvider[] = ['claude', 'agents', 'copilot'];

/** Older `--llm` values from the preset. */
const PROVIDER_ALIASES: Readonly<Record<string, LlmProvider>> = {
  codex: 'agents',
  'openai-gpt': 'agents',
};

/** Comma-separated (or listed) provider names → canonical providers, deduped, in a fixed order. */
export function normalizeProviders(input: string | string[] | undefined): LlmProvider[] {
  const raw = (Array.isArray(input) ? input : (input ?? '').split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (raw.length === 0) return [...PROVIDER_ORDER];
  const wanted = new Set<LlmProvider>();
  for (const value of raw) {
    const provider = (PROVIDER_ORDER as readonly string[]).includes(value)
      ? (value as LlmProvider)
      : PROVIDER_ALIASES[value];
    if (!provider) {
      throw new Error(
        `llm: unknown provider "${value}". Supported: ${PROVIDER_ORDER.join(', ')} ` +
          `(aliases: ${Object.keys(PROVIDER_ALIASES).join(', ')} → agents).`,
      );
    }
    wanted.add(provider);
  }
  return PROVIDER_ORDER.filter((p) => wanted.has(p));
}

// ── Marker upsert ────────────────────────────────────────────────────────────

function occurrences(text: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    at.push(i);
  }
  return at;
}

/** Whether `content` has any nx-polystack marker (well-formed or not). */
export function hasLlmMarkers(content: string): boolean {
  return content.includes(LLM_START) || content.includes(LLM_END);
}

/**
 * New file content with `body` inside the managed block:
 * - no file → title + block; markers → only the block content is replaced;
 * - no markers → a blank line and the block are appended;
 * - malformed markers → throws (naming the file).
 */
export function upsertBlock(existing: string | null, body: string, target: LlmTarget): string {
  const block = `${LLM_START}\n\n${body}\n\n${LLM_END}`;
  if (existing === null) return `${target.title}\n\n${block}\n`;

  const starts = occurrences(existing, LLM_START);
  const ends = occurrences(existing, LLM_END);
  if (starts.length === 0 && ends.length === 0) {
    if (existing.trim() === '') return `${block}\n`;
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${sep}${block}\n`;
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error(
      `llm: ${target.file} has malformed nx-polystack markers (expected one "${LLM_START}" ` +
        `followed by one "${LLM_END}"). Fix or remove them, then run again.`,
    );
  }
  return existing.slice(0, starts[0]) + block + existing.slice(ends[0] + LLM_END.length);
}

// ── Workspace scan ───────────────────────────────────────────────────────────

export type LlmAppType = 'angular' | 'ionic' | 'flutter';

export interface LlmApp {
  name: string;
  type: LlmAppType;
  root: string;
  commands: string[];
  /** Root package.json scripts for this app (`serve:<app>`, `build:<app>:…`). */
  scripts: string[];
}

export interface LlmLib {
  name: string;
  /** Value of the `type:*` tag. */
  type: string | undefined;
  root: string;
  /** tsconfig.base.json paths aliases whose target is inside the lib root. */
  aliases: string[];
}

export interface LlmWorkspace {
  npmScope: string;
  nxVersion?: string;
  angularVersion?: string;
  pluginVersion: string;
  apps: LlmApp[];
  environments: string[];
  libs: LlmLib[];
  /** Root npm scripts added by `pstack infra` that the workspace has (check:cycles, …). */
  checks?: string[];
}

/** The `pstack infra` npm scripts the block describes, in display order. */
const INFRA_CHECKS: ReadonlyArray<[string, string]> = [
  ['check:cycles', 'fail on new project dependency cycles'],
  ['stale-code', 'report unused files, exports and dependencies (knip)'],
  [
    'check:prepush',
    'secret scan (blocking) and a warn-only dependency audit; the pre-push hook runs it',
  ],
  ['check:audit', 'strict dependency audit (fails on high or critical advisories)'],
];

export interface FoundProject {
  root: string;
  json: Record<string, unknown>;
}

const byKey =
  <T>(key: (t: T) => string) =>
  (a: T, b: T): number =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/**
 * Visits the directories under `top` (depth ≤ 4), skipping node_modules and dot-directories.
 * `visit` returns true to stop descending into that directory.
 */
function walkDirs(tree: Tree, top: string, visit: (dir: string) => boolean): void {
  const step = (dir: string, depth: number): void => {
    if (visit(dir) || depth === 0) return;
    for (const c of tree.children(dir)) {
      if (c === 'node_modules' || c.startsWith('.') || tree.isFile(`${dir}/${c}`)) continue;
      step(`${dir}/${c}`, depth - 1);
    }
  };
  if (tree.exists(top) && !tree.isFile(top)) step(top, 4);
}

const isProjectRoot = (tree: Tree, dir: string): boolean =>
  tree.exists(`${dir}/project.json`) && tree.isFile(`${dir}/project.json`);

/**
 * project.json files under `top` (depth ≤ 4), skipping node_modules and dot-directories.
 * Walks the tree instead of getProjects(), which needs Nx's native file globbing.
 */
/** Projects (folders with a project.json) under `top`, at any depth up to four levels. */
export function findProjects(tree: Tree, top: string): FoundProject[] {
  const found: FoundProject[] = [];
  walkDirs(tree, top, (dir) => {
    if (!isProjectRoot(tree, dir)) return false;
    try {
      found.push({ root: dir, json: readJson(tree, `${dir}/project.json`) });
    } catch {
      // unreadable project.json — leave it out
    }
    return true;
  });
  return found;
}

/** True when a pubspec.yaml exists under apps/ or libs/ (same walk as the project scan). */
export function hasFlutterProject(tree: Tree): boolean {
  let found = false;
  for (const top of ['apps', 'libs']) {
    walkDirs(tree, top, (dir) => {
      if (found) return true;
      if (tree.exists(`${dir}/pubspec.yaml`)) found = true;
      return found || isProjectRoot(tree, dir);
    });
  }
  return found;
}

type Targets = Record<string, { executor?: unknown; configurations?: Record<string, unknown> }>;

function targetsOf(p: FoundProject): Targets {
  const t = p.json['targets'];
  return t && typeof t === 'object' ? (t as Targets) : {};
}

function projectName(p: FoundProject): string {
  const name = p.json['name'];
  return typeof name === 'string' && name ? name : path.posix.basename(p.root);
}

/**
 * App type from its files first (pubspec.yaml → Flutter, capacitor.config.* → Ionic), then from
 * its targets, so hand-written workspaces that use nx:run-commands are detected too.
 */
function appType(tree: Tree, root: string, targets: Targets): LlmAppType {
  if (tree.exists(`${root}/pubspec.yaml`)) return 'flutter';
  if (
    targets['cap-sync'] ||
    tree.exists(`${root}/capacitor.config.ts`) ||
    tree.exists(`${root}/capacitor.config.json`)
  ) {
    return 'ionic';
  }
  const flutter = Object.values(targets).some(
    (t) => t?.executor === '@mouryaamit/nx-polystack:flutter-build',
  );
  return flutter ? 'flutter' : 'angular';
}

const configs = (t: Targets[string] | undefined): string[] =>
  Object.keys(t?.configurations ?? {}).sort();

/** Angular build configurations that are build modes rather than environments. */
const NON_ENV_CONFIGS = new Set(['development']);

/**
 * Environment names for one app:
 * - Angular/Ionic: `release` configurations, else `build` configurations minus `development`;
 * - Flutter: `build-web` configurations, else its environments/<name>/environment.<env>.json files,
 *   else (hand-written run-commands apps) the names of its `env/*.json` files.
 */
function appEnvironments(
  tree: Tree,
  name: string,
  root: string,
  type: LlmAppType,
  targets: Targets,
): string[] {
  if (type === 'flutter') {
    const fromTarget = configs(targets['build-web']);
    if (fromTarget.length) return fromTarget;
    const fromEnvRoot = flutterEnvNames(tree, name);
    if (fromEnvRoot.length) return fromEnvRoot;
    const dir = `${root}/env`;
    if (!tree.exists(dir) || tree.isFile(dir)) return [];
    return tree
      .children(dir)
      .filter((f) => f.endsWith('.json') && tree.isFile(`${dir}/${f}`))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  }
  const release = configs(targets['release']);
  if (release.length) return release;
  return configs(targets['build']).filter((c) => !NON_ENV_CONFIGS.has(c));
}

function appCommands(name: string, type: LlmAppType, targets: Targets): string[] {
  const cmds: string[] = [];
  if (targets['serve']) cmds.push(`npx nx serve ${name}`);
  if (type === 'flutter') {
    const web = targets['build-web'];
    if (web) cmds.push(`npx nx run ${name}:build-web${configs(web).length ? ':<env>' : ''}`);
  } else if (targets['release']) {
    cmds.push(`npx nx run ${name}:release:<env>`);
  } else if (targets['build']) {
    cmds.push(`npx nx build ${name}${configs(targets['build']).length ? ' -c <config>' : ''}`);
  }
  if (targets['cap-sync']) cmds.push(`npx nx run ${name}:cap-sync`);
  return cmds;
}

/** Root package.json scripts named `serve:<app>…`, `build:<app>…` or `open:<app>…`. */
function appScripts(scripts: Record<string, unknown>, name: string): string[] {
  const re = new RegExp(`^(serve|build|open):${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:|$)`);
  return Object.keys(scripts)
    .filter((s) => re.test(s))
    .sort();
}

function rootScripts(tree: Tree): Record<string, unknown> {
  if (!tree.exists('package.json')) return {};
  try {
    const scripts = readJson(tree, 'package.json').scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch {
    return {};
  }
}

function tsPaths(tree: Tree): Record<string, unknown> {
  if (!tree.exists('tsconfig.base.json')) return {};
  try {
    const paths = readJson(tree, 'tsconfig.base.json').compilerOptions?.paths;
    return paths && typeof paths === 'object' ? paths : {};
  } catch {
    return {};
  }
}

function aliasesFor(root: string, paths: Record<string, unknown>): string[] {
  const inside = (t: unknown) => {
    if (typeof t !== 'string') return false;
    const p = t.replace(/^\.\//, '');
    return p === root || p.startsWith(`${root}/`);
  };
  return Object.entries(paths)
    .filter(([, targets]) => (Array.isArray(targets) ? targets : [targets]).some(inside))
    .map(([alias]) => alias)
    .sort();
}

function packageVersions(tree: Tree): { nx?: string; angular?: string } {
  if (!tree.exists('package.json')) return {};
  const installedNx = tree.exists('node_modules/nx/package.json');
  return {
    nx: installedNx || declaredVersion(tree, 'nx') ? nxVersion(tree) : undefined,
    angular: declaredVersion(tree, '@angular/core'),
  };
}

/** This plugin's own version, from its package.json. */
export function pluginVersion(): string {
  return readPackageVersion(path.join(selfPackageRoot(__dirname), 'package.json'));
}

/** Names of the projects under apps/ and libs/ (project.json `name`, else the folder name). */
export function workspaceProjectNames(tree: Tree): string[] {
  return [...findProjects(tree, 'apps'), ...findProjects(tree, 'libs')].map(projectName);
}

export function scanWorkspace(tree: Tree): LlmWorkspace {
  const envs = new Set<string>();
  const scripts = rootScripts(tree);
  const apps: LlmApp[] = findProjects(tree, 'apps').map((p) => {
    const targets = targetsOf(p);
    const name = projectName(p);
    const type = appType(tree, p.root, targets);
    appEnvironments(tree, name, p.root, type, targets).forEach((e) => envs.add(e));
    return {
      name,
      type,
      root: p.root,
      commands: appCommands(name, type, targets),
      scripts: appScripts(scripts, name),
    };
  });

  const paths = tsPaths(tree);
  const libs: LlmLib[] = findProjects(tree, 'libs').map((p) => {
    const tags = Array.isArray(p.json['tags']) ? (p.json['tags'] as unknown[]) : [];
    const typeTag = tags.find((t): t is string => typeof t === 'string' && t.startsWith('type:'));
    return {
      name: projectName(p),
      type: typeTag?.slice('type:'.length) || undefined,
      root: p.root,
      aliases: aliasesFor(p.root, paths),
    };
  });

  const versions = packageVersions(tree);
  return {
    npmScope: workspaceNpmScope(tree),
    nxVersion: versions.nx,
    angularVersion: versions.angular,
    pluginVersion: pluginVersion(),
    apps: apps.sort(byKey((a) => a.name)),
    environments: [...envs].sort(),
    libs: libs.sort(byKey((l) => l.name)),
    checks: INFRA_CHECKS.map(([name]) => name).filter((name) => typeof scripts[name] === 'string'),
  };
}

// ── Render ───────────────────────────────────────────────────────────────────

const NONE = '—';

const code = (s: string) => `\`${s}\``;

/** Plain text when it cannot be read as Markdown syntax; else a code span. */
const word = (s: string | undefined) => (!s ? NONE : /^[a-z0-9-]+$/i.test(s) ? s : code(s));

/** A table aligned the way Prettier prints it, so formatting leaves it unchanged. */
function table(header: string[], rows: string[][]): string {
  const cells = rows.map((r) => r.map((c) => c.replace(/\|/g, '\\|')));
  const widths = header.map((h, i) => Math.max(3, h.length, ...cells.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

/** The Markdown between the markers (no trailing newline). */
export function renderBlock(ws: LlmWorkspace): string {
  const out: string[] = [];

  out.push('## nx-polystack workspace');
  out.push(
    `Generated by nx-polystack v${ws.pluginVersion} from the workspace files. Do not edit between ` +
      'the `nx-polystack` markers; add your own notes outside them. Refresh with `pstack llm`.',
  );

  out.push('### Workspace');
  out.push(
    [
      `- npm scope: ${code(`@${ws.npmScope}`)}`,
      ws.nxVersion ? `- Nx: ${code(ws.nxVersion)}` : '',
      ws.angularVersion ? `- Angular: ${code(ws.angularVersion)}` : '',
      `- nx-polystack: ${code(ws.pluginVersion)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  out.push('### Apps');
  out.push(
    ws.apps.length === 0
      ? 'No apps yet. Add one with `pstack app --type=angular --name=<name>`.'
      : table(
          ['Project', 'Type', 'Root', 'Commands'],
          ws.apps.map((a) => [
            code(a.name),
            a.type,
            code(a.root),
            a.commands.length ? a.commands.map(code).join(', ') : NONE,
          ]),
        ),
  );

  const withScripts = ws.apps.filter((a) => a.scripts.length > 0);
  if (withScripts.length > 0) {
    out.push('### npm scripts');
    out.push(
      'Run with `npm run <script>`.\n\n' +
        withScripts.map((a) => `- ${code(a.name)}: ${a.scripts.map(code).join(', ')}`).join('\n'),
    );
  }

  out.push('### Environments');
  out.push(
    (ws.environments.length === 0 ? 'None found.' : ws.environments.map(code).join(', ')) +
      '\n\nBuild an app for one with `npx nx run <app>:release:<env>` (Angular, Ionic) or ' +
      '`npx nx run <app>:build-web:<env>` (Flutter). Add one with `pstack env --name=<env>`.',
  );

  out.push('### Libraries');
  out.push(
    ws.libs.length === 0
      ? 'No libraries yet. Add one with `pstack lib --type=<type> --name=<name>`.'
      : table(
          ['Project', 'Type', 'Root', 'Import'],
          ws.libs.map((l) => [
            code(l.name),
            word(l.type),
            code(l.root),
            l.aliases.length ? l.aliases.map(code).join(', ') : NONE,
          ]),
        ),
  );

  out.push('### Commands');
  out.push(
    [
      '- `pstack app --type=<angular|ionic|flutter> --name=<name>`: add an app',
      '- `pstack lib --type=<type> --name=<name>`: add a library',
      '- `pstack env --name=<env>`: add an environment to every app',
      '- `pstack update`: upgrade nx-polystack and run its migrations',
      '- `pstack llm`: refresh this block',
      '- `pstack infra`: add repo docs, CI gates, quality checks and the upgrade workflow',
      '- `npx nx affected -t lint,build`: lint and build what changed',
      '- `npm run lint`: lint the workspace',
      ...INFRA_CHECKS.filter(([name]) => ws.checks?.includes(name)).map(
        ([name, what]) => `- \`npm run ${name}\`: ${what}`,
      ),
    ].join('\n'),
  );

  out.push('### Rules');
  out.push(
    [
      '- Never commit plaintext secrets. Environment files are encrypted at build time.',
      '- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, …).',
      '- Design-token outputs are generated by `npx nx build <tokens-lib>`. Edit the token JSON, ' +
        'not the outputs.',
      '- Add apps and libs with the generators so tags, tsconfig paths and npm scripts stay ' +
        'consistent.',
    ].join('\n'),
  );

  return out.join('\n\n');
}

// ── Write ────────────────────────────────────────────────────────────────────

function readText(tree: Tree, file: string): string | null {
  return tree.exists(file) ? tree.read(file, 'utf8') ?? '' : null;
}

/**
 * Writes the block into each provider's file (creating or appending as needed). Every file is
 * checked before any is written, so malformed markers leave all files untouched. Returns the
 * files whose content changed.
 */
export function writeLlmBlocks(tree: Tree, providers: LlmProvider[]): string[] {
  const body = renderBlock(scanWorkspace(tree));
  const planned = providers.map((p) => {
    const target = LLM_PROVIDERS[p];
    const before = readText(tree, target.file);
    return { file: target.file, before, after: upsertBlock(before, body, target) };
  });
  const changed = planned.filter((p) => p.after !== p.before);
  for (const p of changed) tree.write(p.file, p.after);
  return changed.map((p) => p.file);
}

/**
 * Regenerates the block in the provider files that already have the markers; files without
 * them are never touched. A file with malformed markers is reported and skipped. Call it after
 * formatFiles. Returns the files whose content changed.
 */
export function refreshLlmBlocks(tree: Tree): string[] {
  const managed = PROVIDER_ORDER.map((p) => LLM_PROVIDERS[p]).filter((t) => {
    const content = readText(tree, t.file);
    return content !== null && hasLlmMarkers(content);
  });
  if (managed.length === 0) return [];

  const body = renderBlock(scanWorkspace(tree));
  const changed: string[] = [];
  for (const target of managed) {
    const before = readText(tree, target.file) ?? '';
    let after: string;
    try {
      after = upsertBlock(before, body, target);
    } catch (err) {
      logger.warn(`${err instanceof Error ? err.message : String(err)} Skipped.`);
      continue;
    }
    if (after !== before) {
      tree.write(target.file, after);
      changed.push(target.file);
    }
  }
  return changed;
}
