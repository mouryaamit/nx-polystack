import { logger, readJson, Tree, updateJson, writeJson } from '@nx/devkit';

import { DEFAULT_STAMP, normalizeEnvEncryption } from '../../lib/env-encryption/config';
import {
  readEnvEncryptionBlock,
  writeEnvEncryptionBlock,
} from '../../lib/env-encryption/workspace';
import { flattenApplicationOutput } from '../../lib/release/flat-output';
import { adoptHtaccess, copiesHtaccess, htaccessNote } from '../../lib/release/htaccess-adopt';
import { POLYSTACK_BUILD_EXECUTOR } from '../../lib/utils/angular-project';
import { devkitPinFor, installedVersion, withDevkitPin } from '../../lib/utils/devkit-pin';
import { keepJsonLayout, loadJsonc } from '../../lib/utils/json-layout';
import { readProjects } from '../../lib/utils/project-json-files';
import { addReleaseTarget, angularAppNpmScripts } from '../migrate/angular-project-json';
import { readBuildScripts, shapeReleaseTarget } from '../migrate/nx/build-scripts';
import { applySourceEnvEncryption } from '../migrate/nx/env-encryption';

import { adoptFlutterApp, FlutterCandidate, flutterAdoptCandidates } from './flutter';
import { removeScriptReferences } from './old-script-refs';
import { findOldScripts, recordedScripts } from './old-scripts';
import { readSourcePipeline, SourcePipeline } from './pipeline';

export interface AdoptGeneratorSchema {
  /** Apps to adopt (default: every Angular app without a release target). */
  projects?: string[];
  /** Point the apps' build:<app>:<env> npm scripts at the release target (default true). */
  scripts?: boolean;
  /**
   * Delete the old build pipeline scripts nothing uses any more (after the apps are adopted;
   * also on its own, in a workspace adopted earlier).
   */
  removeOldScripts?: boolean;
  /**
   * Where the report goes (workspace-relative), or false for none. Saved as nx.json
   * `pstack.adopt.report`, which later runs read; default docs/migrations/adopt.md.
   */
  report?: string | false;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const code = (s: string) => `\`${s}\``;

/** Angular builders whose apps the release executor builds (it runs them through buildTarget). */
const ANGULAR_APP_BUILDERS =
  /^(@angular-devkit\/build-angular:(browser|browser-esbuild|application)|@angular\/build:application|@nx\/angular:(webpack-browser|browser-esbuild|application))$/;

export const ADOPT_REPORT = 'docs/migrations/adopt.md';

/** nx.json `pstack.adopt.report`: a path, false, or undefined. */
function savedReport(tree: Tree): string | false | undefined {
  if (!tree.exists('nx.json')) return undefined;
  const v = (readJson(tree, 'nx.json') as Json)?.['pstack'] as Json | undefined;
  const r = isObject(v?.['adopt']) ? (v?.['adopt'] as Json)['report'] : undefined;
  return typeof r === 'string' || r === false ? r : undefined;
}

/** Writes nx.json `pstack.adopt.report`, keeping the rest of the file's layout. */
function saveReport(tree: Tree, value: string | false): void {
  if (!tree.exists('nx.json')) return;
  const before = tree.read('nx.json', 'utf8') ?? '';
  const json = JSON.parse(before) as Json;
  const pstack = isObject(json['pstack']) ? (json['pstack'] as Json) : {};
  const adopt = isObject(pstack['adopt']) ? (pstack['adopt'] as Json) : {};
  json['pstack'] = { ...pstack, adopt: { ...adopt, report: value } };
  const after = JSON.stringify(json, null, 2);
  const jsonc = loadJsonc(tree.root);
  tree.write('nx.json', (jsonc && keepJsonLayout(jsonc, before, after)) || `${after}\n`);
}

/**
 * The report file for this run (null: none). `--report` wins and is saved in nx.json; else the
 * saved setting; else docs/migrations/adopt.md. A report at the default path moves to the new one.
 */
export function resolveReport(tree: Tree, option: string | false | undefined): string | null {
  let value: string | false | undefined = option;
  if (typeof value === 'string') {
    value = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (value.endsWith('/')) value += 'pstack-adopt.md';
    if (
      !value ||
      value.startsWith('/') ||
      /^[A-Za-z]:/.test(value) ||
      value.split('/').includes('..')
    ) {
      throw new Error(`adopt: --report must be a path inside the workspace (got "${option}")`);
    }
  }
  const saved = savedReport(tree);
  if (value !== undefined && value !== saved) {
    saveReport(tree, value);
    logger.info(
      `adopt: report ${
        value === false ? 'turned off' : `goes to ${value}`
      } (nx.json pstack.adopt.report).`,
    );
  }
  const chosen = value ?? saved ?? ADOPT_REPORT;
  if (chosen === false) return null;
  if (chosen !== ADOPT_REPORT && tree.exists(ADOPT_REPORT) && !tree.exists(chosen)) {
    tree.rename(ADOPT_REPORT, chosen);
    logger.info(`adopt: moved ${ADOPT_REPORT} to ${chosen}.`);
  }
  return chosen;
}

export interface AdoptResult {
  adopted: string[];
  skipped: string[];
  notes: string[];
  scripts: Record<string, string>;
  /** Old pipeline scripts deleted (removeOldScripts). */
  removed: string[];
  /** Scripts under tools/ nothing starts, outside the old pipeline (left in place). */
  unreferenced: string[];
  /** removeOldScripts looked (so the report's "Old scripts" section is current). */
  oldScriptsChecked?: boolean;
  /** What still named the removed scripts and was edited (`file:line: what`). */
  referencesEdited?: string[];
  /** Mentions of removed scripts left for a person to look at (`file:line`). */
  referencesReview?: string[];
  /** Flutter apps (also in adopted) whose web build moved to the flutter-build executor. */
  flutter?: string[];
  /** Apps already on the plugin whose build still copied a .htaccess, moved to the env files. */
  htaccessMoved?: string[];
}

/** Angular apps of the workspace that build without the plugin: build target, no release target. */
export function adoptCandidates(tree: Tree): { name: string; root: string; reason?: string }[] {
  const out: { name: string; root: string; reason?: string }[] = [];
  for (const { name, root, json } of readProjects(tree)) {
    const targets = isObject(json['targets']) ? (json['targets'] as Record<string, Json>) : {};
    const build = targets['build'];
    if (!isObject(build) || !ANGULAR_APP_BUILDERS.test(String(build['executor'] ?? ''))) continue;
    if (json['projectType'] === 'library') continue;
    if (
      Object.values(targets).some((t) => isObject(t) && t['executor'] === POLYSTACK_BUILD_EXECUTOR)
    )
      continue;
    out.push({
      name,
      root,
      reason: targets['release'] !== undefined ? 'has its own "release" target' : undefined,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Apps already on the plugin's release target whose build still copies a .htaccess (added by hand
 * or copied from another app's project.json): the .htaccess becomes environments/<app>/htaccess.<env>
 * as adopt does for the apps it moves, and leaves the build assets.
 */
export function strayHtaccessApps(tree: Tree): { name: string; root: string }[] {
  return readProjects(tree)
    .filter(({ json }) => copiesHtaccess(json as Json))
    .map(({ name, root }) => ({ name, root }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function moveStrayHtaccess(
  tree: Tree,
  apps: { name: string; root: string }[],
  result: AdoptResult,
): void {
  result.htaccessMoved = [];
  for (const { name, root } of apps) {
    const pjPath = `${root}/project.json`;
    const original = tree.read(pjPath, 'utf8') ?? '';
    const notes: string[] = [];
    const moved = adoptHtaccess(tree, pjPath);
    htaccessNote(moved, name, notes);
    if (notes.length === 0) {
      // The env files were all there already: only the build's asset entry went.
      notes.push(
        `the build no longer copies a \`.htaccess\`; kept ${moved.kept.map(code).join(', ')}`,
      );
    }
    keepFormatting(tree, pjPath, original);
    result.htaccessMoved.push(name);
    result.notes.push(...notes.map((n) => `${code(name)}: ${n}`));
    logger.info(`adopt: ${name}: ${notes.join('; ').replace(/`/g, '') || '.htaccess moved'}`);
  }
}

/** The build stamp time zone the workspace's own script used (e.g. Asia/Kolkata). */
function setStampTimezone(tree: Tree, timezone: string, notes: string[]): void {
  const cfg = normalizeEnvEncryption(readEnvEncryptionBlock(tree));
  writeEnvEncryptionBlock(tree, {
    ...cfg,
    stamp: { ...DEFAULT_STAMP, ...(cfg.stamp ?? {}), timezone },
  });
  notes.push(
    `Env encryption: build stamp time zone ${code(timezone)}, as the build script wrote it.`,
  );
}

/** Index of the brace that closes the one at `open` (strings skipped), or -1. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i;
  }
  return -1;
}

/**
 * Rewrites a project.json that adopt changed as a small edit of its original text (the .htaccess
 * asset removed, the release target added at the end of targets) so the rest keeps its layout.
 * Leaves the plain JSON write when the edit does not give the same JSON.
 */
function keepFormatting(tree: Tree, file: string, original: string): void {
  const wanted = tree.read(file, 'utf8') ?? '';
  let target: Json;
  try {
    target = JSON.parse(wanted) as Json;
  } catch {
    return;
  }
  let text = original
    .replace(/,\s*\{[^{}]*"glob"\s*:\s*"\.htaccess"[^{}]*\}/g, '')
    .replace(/\{[^{}]*"glob"\s*:\s*"\.htaccess"[^{}]*\}\s*,?\s*/g, '')
    .replace(/,\s*"[^"]*\/\.htaccess"/g, '')
    .replace(/"[^"]*\/\.htaccess"\s*,?\s*/g, '');
  const release = (target['targets'] as Json | undefined)?.['release'];
  // An app already on the plugin keeps its release target where it is (only an asset left).
  let hadRelease: boolean;
  try {
    const before = (JSON.parse(original) as Json)['targets'];
    hadRelease = isObject(before) && before['release'] !== undefined;
  } catch {
    return;
  }
  const targetsKey = /"targets"\s*:\s*\{/.exec(text);
  if (release !== undefined && !hadRelease && targetsKey) {
    const open = targetsKey.index + targetsKey[0].length - 1;
    const close = closingBrace(text, open);
    if (close < 0) return;
    const keyIndent = /\n([ \t]+)"[^"]+"\s*:/.exec(text.slice(open, close))?.[1] ?? '    ';
    const unit = keyIndent.length >= 4 ? keyIndent.slice(0, keyIndent.length / 2) : '  ';
    const body = JSON.stringify(release, null, unit).replace(/\n/g, `\n${keyIndent}`);
    const before = text.slice(0, close).replace(/\s*$/, '');
    const closeIndent = keyIndent.slice(unit.length);
    text = `${before},\n${keyIndent}"release": ${body}\n${closeIndent}${text.slice(close)}`;
  }
  try {
    if (JSON.stringify(JSON.parse(text)) === JSON.stringify(target)) tree.write(file, text);
  } catch {
    // Keep the plain JSON write.
  }
}

/** Release target options and configurations that do what the workspace's own build script did. */
function applyPipeline(release: Json, pipeline: SourcePipeline, notes: string[]): void {
  const options = release['options'] as Json;
  if (pipeline.nonce) {
    options['secure'] = true;
    const n = pipeline.nonce;
    const nonce: Json = {};
    if (n.placeholder) nonce['placeholder'] = n.placeholder;
    if (n.tags) nonce['tags'] = n.tags;
    if (n.position) nonce['position'] = n.position;
    if (n.replaceTokens.length > 0) nonce['replaceTokens'] = n.replaceTokens;
    if (!n.addMeta) nonce['addMeta'] = false;
    if (n.ngCspNonce) nonce['ngCspNonce'] = n.ngCspNonce;
    if (Object.keys(nonce).length > 0) options['nonce'] = nonce;
  }
  if (pipeline.stripHtmlComments) options['stripHtmlComments'] = true;
  const configurations = isObject(release['configurations'])
    ? (release['configurations'] as Record<string, Json>)
    : {};
  for (const config of Object.values(configurations)) {
    const env = String(config['env'] ?? '').toUpperCase();
    if (env !== 'UAT' && env !== 'PROD') continue;
    if (pipeline.obfuscate) config['obfuscate'] = pipeline.obfuscate;
    if (pipeline.obfuscateOptions) config['obfuscateOptions'] = pipeline.obfuscateOptions as Json;
    if (!pipeline.stripComments) delete config['stripComments'];
    if (!pipeline.dropConsole) delete config['dropConsole'];
  }
  void notes;
}

/**
 * The npm scripts of an adopted app: build:<app>:<env> → nx run <app>:release:<env> when the
 * script built through the workspace's own build script (or is missing), plus the secure ones.
 */
function appScripts(
  name: string,
  releases: string[],
  current: Record<string, string>,
  custom: Record<string, string>,
): Record<string, string> {
  const wanted = angularAppNpmScripts(name, false, releases);
  const out: Record<string, string> = {};
  // Scripts under other names that built this app through the workspace's script
  // (build:<app>:production …) keep their names and run the release target.
  const covered = new Set<string>();
  for (const [key, cmd] of Object.entries(custom)) {
    if (wanted[key] !== undefined || flagValue(cmd, ['project', 'app']) !== name) continue;
    const e = flagValue(cmd, ['env', 'configuration', 'c']);
    const env = e ? ENV_ALIAS[e] ?? e : undefined;
    if (!env || !releases.includes(env)) continue;
    out[key] = `nx run ${name}:release:${env}`;
    covered.add(env);
  }
  for (const [key, cmd] of Object.entries(wanted)) {
    if (current[key] === cmd) continue;
    const env = /^build:[^:]+:([\w-]+)$/.exec(key)?.[1];
    if (env && covered.has(env) && current[key] === undefined) continue;
    if (current[key] === undefined || custom[key] !== undefined) out[key] = cmd;
  }
  return out;
}

const ENV_ALIAS: Record<string, string> = { development: 'dev', production: 'prod' };

function flagValue(cmd: string, names: string[]): string | undefined {
  for (const n of names) {
    const m = new RegExp(`(?:^|\\s)--?${n}(?:=|\\s+)(['"]?)([^\\s'"]+)\\1`).exec(cmd);
    if (m) return m[2];
  }
  return undefined;
}

/**
 * Sets npm scripts in package.json without reformatting the rest of the file: existing scripts
 * are changed in place, new ones go after the app's last build script (or at the end of scripts).
 */
export function setScriptsInPlace(tree: Tree, scripts: Record<string, string>): void {
  if (Object.keys(scripts).length === 0) return;
  const before = tree.read('package.json', 'utf8') ?? '';
  let text = before;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const added: [string, string][] = [];
  for (const [key, cmd] of Object.entries(scripts)) {
    const re = new RegExp(`("${esc(key)}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`);
    if (re.test(text))
      text = text.replace(re, (_m, lead: string) => `${lead}${JSON.stringify(cmd)}`);
    else added.push([key, cmd]);
  }
  for (const [key, cmd] of added) {
    const app = /^build:([^:]+):/.exec(key)?.[1];
    const lines = text.split('\n');
    const scriptsStart = lines.findIndex((l) => /^\s*"scripts"\s*:\s*\{/.test(l));
    if (scriptsStart < 0) break;
    let scriptsEnd = scriptsStart + 1;
    while (scriptsEnd < lines.length && !/^\s*\}/.test(lines[scriptsEnd])) scriptsEnd++;
    let anchor = -1;
    for (let i = scriptsStart + 1; i < scriptsEnd; i++) {
      if (app && new RegExp(`^\\s*"build:${esc(app)}:`).test(lines[i])) anchor = i;
    }
    if (anchor < 0) anchor = scriptsEnd - 1;
    const indent = /^(\s*)/.exec(lines[anchor])?.[1] ?? '    ';
    const isLast = !/,\s*$/.test(lines[anchor]);
    if (isLast) lines[anchor] = `${lines[anchor].replace(/\s*$/, '')},`;
    lines.splice(
      anchor + 1,
      0,
      `${indent}${JSON.stringify(key)}: ${JSON.stringify(cmd)}${isLast ? '' : ','}`,
    );
    text = lines.join('\n');
  }
  // Fall back to a plain JSON write when the text edit did not give the scripts asked for.
  let ok = false;
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    ok = Object.entries(scripts).every(([k, v]) => parsed.scripts?.[k] === v);
  } catch {
    ok = false;
  }
  if (ok) {
    tree.write('package.json', text);
    return;
  }
  updateJson(tree, 'package.json', (pkg) => {
    pkg.scripts = { ...(pkg.scripts ?? {}), ...scripts };
    return pkg;
  });
}

/**
 * @nx/devkit pinned to the installed nx in package.json (text edit, layout kept): the plugin's
 * devkit peer otherwise resolves to the newest Nx on the next install.
 */
function pinDevkit(tree: Tree, notes: string[]): void {
  if (!tree.exists('package.json')) return;
  const nx = installedVersion(tree.root, 'nx');
  const before = tree.read('package.json', 'utf8') ?? '';
  let pkg: Json;
  try {
    pkg = JSON.parse(before) as Json;
  } catch {
    return;
  }
  const version = devkitPinFor(pkg, nx);
  if (!version) return;
  const jsonc = loadJsonc(tree.root);
  const after = JSON.stringify(withDevkitPin(pkg, version), null, 2);
  tree.write('package.json', (jsonc && keepJsonLayout(jsonc, before, after)) || `${after}\n`);
  notes.push(
    `\`@nx/devkit\` pinned to ${version} (the workspace's Nx)` +
      (installedVersion(tree.root, '@nx/devkit') === version ? '.' : '; run npm install.'),
  );
}

/** The configurations of a project's plugin release target. */
function releaseEnvs(pj: Json): string[] {
  const release = (pj['targets'] as Record<string, Json> | undefined)?.['release'];
  if (!isObject(release) || release['executor'] !== POLYSTACK_BUILD_EXECUTOR) return [];
  return Object.keys((release['configurations'] as Json | undefined) ?? {});
}

/**
 * Sets `build:all:<env>` scripts that run a workspace script to `nx run-many -t release -c
 * <env>` (for the envs the release targets have) in `out`; returns the scripts they ran.
 */
function buildAllScripts(
  scripts: Record<string, string>,
  envs: Set<string>,
  out: Record<string, string>,
): string[] {
  const replaced: string[] = [];
  for (const [key, cmd] of Object.entries(scripts)) {
    const env = /^build:all:([\w-]+)$/.exec(key)?.[1];
    if (!env || !envs.has(env) || /^\s*(npx\s+)?nx\s/.test(cmd)) continue;
    out[key] = `nx run-many -t release -c ${env}`;
    const file = /\bnode\s+(['"]?)([\w./-]+\.(?:c|m)?js)\1/.exec(cmd)?.[2];
    if (file) replaced.push(file.replace(/^\.\//, ''));
  }
  return replaced;
}

/**
 * In a workspace whose Angular apps all build with the release target already: build:all:<env>
 * scripts still running the workspace's own script move to nx run-many. Returns those scripts.
 */
function switchBuildAll(tree: Tree, options: AdoptGeneratorSchema, result: AdoptResult): string[] {
  if (options.scripts === false || (options.projects && options.projects.length > 0)) return [];
  if (!tree.exists('package.json')) return [];
  const pkg = readJson<{ scripts?: Record<string, string> }>(tree, 'package.json');
  const envs = new Set(readProjects(tree).flatMap(({ json }) => releaseEnvs(json as Json)));
  const scripts: Record<string, string> = {};
  const replaced = buildAllScripts(pkg.scripts ?? {}, envs, scripts);
  if (replaced.length === 0) return [];
  setScriptsInPlace(tree, scripts);
  result.scripts = scripts;
  logger.info(
    `adopt: ${Object.keys(scripts).join(', ')} now run every release target (nx run-many).`,
  );
  return [...new Set(replaced)].sort();
}

/** Deletes the old pipeline scripts nothing uses any more (see old-scripts.ts). */
function removeOldScripts(
  tree: Tree,
  oldScripts: string[],
  result: AdoptResult,
  file: string | null,
): void {
  const from = [file, ADOPT_REPORT].find((f): f is string => !!f && tree.exists(f));
  const previous = from ? tree.read(from, 'utf8') ?? '' : '';
  const recorded = recordedScripts(previous);
  const found = findOldScripts(tree, [...oldScripts, ...recorded]);
  for (const f of found.removable) tree.delete(f);
  result.oldScriptsChecked = true;
  result.removed = found.removable;
  result.unreferenced = found.unreferenced;
  // What still names them (and the ones an earlier run removed): ignore files, config lists,
  // comments and docs. The adopt report keeps its record.
  const gone = [...new Set([...found.removable, ...recorded.filter((r) => !tree.exists(r))])];
  const refs = removeScriptReferences(
    tree,
    gone.sort(),
    [file, ADOPT_REPORT].filter((f): f is string => !!f),
  );
  result.referencesEdited = refs.edited;
  result.referencesReview = refs.review;
  logger.info(
    found.removable.length > 0
      ? `adopt: removed the old build scripts nothing uses any more: ${found.removable.join(', ')}`
      : 'adopt: no old build script left to remove.',
  );
  if (found.unreferenced.length > 0) {
    logger.info(
      `adopt: not part of the old build, nothing starts them; left in place: ${found.unreferenced.join(
        ', ',
      )}`,
    );
  }
  if (refs.edited.length > 0) {
    logger.info(`adopt: references to the removed scripts:\n  ${refs.edited.join('\n  ')}`);
  }
  if (refs.review.length > 0) {
    logger.info(
      `adopt: still named in code (not edited; look at these): ${refs.review.join(', ')}`,
    );
  }
}

function referenceLines(result: AdoptResult): string[] {
  const edited = result.referencesEdited ?? [];
  const review = result.referencesReview ?? [];
  const lines: string[] = [];
  if (edited.length > 0) {
    lines.push('References to them that were removed or rewritten:', '');
    lines.push(...edited.map((e) => `- ${e.replace(/^([^:]+:\d+|[^:]+)/, (m) => code(m))}`), '');
  }
  if (review.length > 0) {
    lines.push(`Still named here (not edited): ${review.map(code).join(', ')}.`, '');
  }
  return lines;
}

function removalLines(result: AdoptResult): string[] {
  if (result.removed.length === 0 && result.unreferenced.length === 0) {
    return result.oldScriptsChecked
      ? [
          '## Old scripts',
          '',
          'None left: no old build script is still in the workspace.',
          '',
          ...referenceLines(result),
        ]
      : [];
  }
  const lines = ['## Old scripts', ''];
  if (result.removed.length > 0) {
    lines.push(`Removed (nothing uses them any more): ${result.removed.map(code).join(', ')}.`, '');
  }
  if (result.unreferenced.length > 0) {
    lines.push(
      'Nothing starts these, but they are not part of the old build, so they were left: ' +
        `${result.unreferenced.map(code).join(', ')}.`,
      '',
    );
  }
  lines.push(...referenceLines(result));
  return lines;
}

function appendRemovalReport(tree: Tree, result: AdoptResult, file: string | null): void {
  if (!file) return;
  const scripts = Object.entries(result.scripts);
  const lines = [
    ...(scripts.length > 0
      ? ['## build:all scripts', '', ...scripts.map(([k, v]) => `- ${code(k)}: ${code(v)}`), '']
      : []),
    ...removalLines(result),
  ];
  if (lines.length === 0) return;
  const previous = tree.exists(file) ? tree.read(file, 'utf8') ?? '' : '# pstack adopt\n';
  let kept = previous.replace(/\n## Old scripts\n[\s\S]*?(?=\n## |$)/, '\n');
  if (scripts.length > 0) kept = kept.replace(/\n## build:all scripts\n[\s\S]*?(?=\n## |$)/, '\n');
  tree.write(file, `${kept.replace(/\n*$/, '\n\n')}${lines.join('\n')}`);
}

function report(result: AdoptResult, pipeline: SourcePipeline, customScripts: string[]): string {
  const lines = ['# pstack adopt', ''];
  const flutter = result.flutter ?? [];
  const angular = result.adopted.filter((a) => !flutter.includes(a));
  lines.push(
    `Apps moved to the polystack \`release\` target: ${
      angular.length > 0 ? angular.map(code).join(', ') : 'none'
    }.`,
    '',
  );
  if (flutter.length > 0) {
    lines.push(
      `Flutter apps whose web build moved to the \`flutter-build\` executor: ${flutter
        .map(code)
        .join(', ')}.`,
      '',
    );
  }
  if (result.skipped.length > 0) {
    lines.push('## Not changed', '', ...result.skipped.map((s) => `- ${s}`), '');
  }
  if (customScripts.length > 0) {
    lines.push(
      '## The workspace build script',
      '',
      `Read: ${pipeline.scripts.map(code).join(', ')}. The release target was set to do the same:`,
      '',
      `- CSP nonce: ${
        pipeline.nonce
          ? `on (\`secure\`), placeholder ${code(pipeline.nonce.placeholder ?? 'default')}, tags ${
              pipeline.nonce.tags ?? 'all'
            }, position ${pipeline.nonce.position ?? 'end'}${
              pipeline.nonce.replaceTokens.length > 0
                ? `, replaces ${pipeline.nonce.replaceTokens.map(code).join(', ')}`
                : ''
            }, ${pipeline.nonce.addMeta ? 'adds' : 'no'} csp-nonce meta${
              pipeline.nonce.ngCspNonce
                ? `, ngCspNonce on ${code(`<${pipeline.nonce.ngCspNonce}>`)}`
                : ''
            }`
          : 'none found'
      }`,
      `- HTML comments stripped in every env: ${pipeline.stripHtmlComments ? 'yes' : 'no'}`,
      `- UAT/PROD comment stripping: ${pipeline.stripComments ? 'yes' : 'no'}; obfuscation: ${
        pipeline.obfuscate
          ? `yes (${pipeline.obfuscate}${
              pipeline.obfuscateOptions
                ? ` with ${code(JSON.stringify(pipeline.obfuscateOptions))}`
                : ''
            })`
          : 'no'
      }; console removal: ${pipeline.dropConsole ? 'yes' : 'no'}`,
      '',
      'Check before switching CI: `pstack adopt --compare --app=<app> --base=<commit before adopt>` ' +
        'builds an app both ways for each env and compares the output (files, .htaccess, nonce, ' +
        'encrypted env values, obfuscation, image metadata).',
      '',
      `Old build scripts: ${customScripts.map(code).join(', ') || 'none'}.` +
        (result.removed.length > 0
          ? ''
          : ' They are left in place; `pstack adopt --remove-old-scripts` deletes the ones nothing ' +
            'uses any more.'),
      '',
    );
  }
  if (result.notes.length > 0) lines.push('## Notes', '', ...result.notes.map((n) => `- ${n}`), '');
  lines.push(...removalLines(result));
  const scripts = Object.entries(result.scripts);
  if (scripts.length > 0) {
    lines.push('## npm scripts', '', ...scripts.map(([k, v]) => `- ${code(k)}: ${code(v)}`), '');
  }
  return lines.join('\n');
}

/**
 * pstack adopt: moves the Angular apps of this workspace that still build with their own scripts
 * to the plugin's release target, in place. Each app gets a release target (base hrefs, env folder
 * and the post-build steps read from the workspace's build script), its .htaccess becomes
 * environments/<app>/htaccess.<env>, the workspace's env encryption is mirrored in nx.json, and its
 * build:<app>:<env> npm scripts call nx run <app>:release:<env>. Old scripts are not deleted.
 */
export default async function adoptGenerator(
  tree: Tree,
  options: AdoptGeneratorSchema = {},
): Promise<AdoptResult> {
  const result: AdoptResult = {
    adopted: [],
    skipped: [],
    notes: [],
    scripts: {},
    removed: [],
    unreferenced: [],
  };
  const reportFile = resolveReport(tree, options.report);
  let candidates = adoptCandidates(tree);
  let flutter: FlutterCandidate[] = flutterAdoptCandidates(tree);
  let stray = strayHtaccessApps(tree);
  if (options.projects && options.projects.length > 0) {
    const wanted = new Set(options.projects);
    stray = stray.filter((a) => wanted.has(a.name));
    const strayNames = new Set(stray.map((a) => a.name));
    const known = new Set([...candidates, ...flutter].map((c) => c.name));
    const unknown = options.projects.filter((p) => !known.has(p) && !strayNames.has(p));
    if (unknown.length > 0) {
      throw new Error(
        `adopt: ${unknown.map((p) => `"${p}"`).join(', ')} ${
          unknown.length === 1 ? 'is not an app' : 'are not apps'
        } that builds without the plugin (candidates: ${[...known].join(', ') || 'none'})`,
      );
    }
    candidates = candidates.filter((c) => wanted.has(c.name));
    flutter = flutter.filter((c) => wanted.has(c.name));
  }
  moveStrayHtaccess(tree, stray, result);
  // A Flutter app without a web build to move is only reported when it was asked for.
  const named = new Set(options.projects ?? []);
  for (const c of [...candidates, ...flutter.filter((f) => named.has(f.name))].filter(
    (c) => c.reason,
  )) {
    result.skipped.push(`${code(c.name)}: ${c.reason}`);
  }
  candidates = candidates.filter((c) => !c.reason);
  const flutterApps = flutter.filter(
    (c): c is FlutterCandidate & { webTarget: string } => !c.reason && !!c.webTarget,
  );
  // nx.json is written as plain JSON (env encryption, report setting); its layout is put back at
  // the end (only the changed values move).
  const layouts = new Map<string, string>();
  for (const f of ['nx.json']) {
    const text = tree.exists(f) ? tree.read(f, 'utf8') : null;
    if (text !== null) layouts.set(f, text);
  }
  if (candidates.length === 0 && flutterApps.length === 0) {
    // Adopted earlier (before adopt moved build:all, or app by app): move it now.
    const replaced = result.skipped.length === 0 ? switchBuildAll(tree, options, result) : [];
    if (options.removeOldScripts) removeOldScripts(tree, replaced, result, reportFile);
    if (replaced.length > 0 || options.removeOldScripts) {
      appendRemovalReport(tree, result, reportFile);
      return result;
    }
    if (result.htaccessMoved.length > 0) return result;
    logger.info('adopt: no Angular or Flutter app builds without the plugin; nothing to do.');
    return result;
  }

  const pkg = tree.exists('package.json')
    ? readJson<{ scripts?: Record<string, string> }>(tree, 'package.json')
    : {};
  const names = [...candidates, ...flutterApps].map((c) => c.name);
  const buildScripts = readBuildScripts(tree.root, pkg.scripts, names);
  const pipeline = readSourcePipeline(tree.root, buildScripts.customScripts);

  // Before any release target exists: the encryption settings apply to every release build.
  const encryption = applySourceEnvEncryption(tree, tree.root, result.notes);
  if (encryption?.applied && pipeline.timezone)
    setStampTimezone(tree, pipeline.timezone, result.notes);

  const scripts: Record<string, string> = {};
  for (const { name, root } of candidates) {
    const pjPath = `${root}/project.json`;
    const pj = readJson<Json>(tree, pjPath);
    const targets = pj['targets'] as Json;
    const notes: string[] = [];
    const releases = addReleaseTarget(targets, name, (w) => notes.push(w), root);
    if (releases.length === 0) {
      result.skipped.push(`${code(name)}: ${notes.join('; ')}`);
      continue;
    }
    shapeReleaseTarget(targets, name, buildScripts, notes);
    applyPipeline(targets['release'] as Json, pipeline, notes);
    // The application builder would put the app in <base>/browser/: release builds are flat.
    const releaseOptions = ((targets['release'] as Json)['options'] ?? {}) as Json;
    const buildName = String(releaseOptions['buildTarget'] ?? `${name}:build`).split(':')[1];
    const flat = flattenApplicationOutput(targets[buildName]);
    if (flat === 'set') {
      notes.push(
        `${code(buildName)} outputPath.browser set to "" (no \`browser/\` folder in the output)`,
      );
    } else if (flat === 'ssr') {
      notes.push(`${code(buildName)} renders on a server; the release build refuses it`);
    }
    const original = tree.read(pjPath, 'utf8') ?? '';
    writeJson(tree, pjPath, pj);
    htaccessNote(adoptHtaccess(tree, pjPath), name, notes);
    keepFormatting(tree, pjPath, original);
    result.adopted.push(name);
    result.notes.push(...notes.map((n) => `${code(name)}: ${n}`));
    if (options.scripts !== false) {
      Object.assign(
        scripts,
        appScripts(name, releases, pkg.scripts ?? {}, buildScripts.customBuilds),
      );
    }
  }
  for (const app of flutterApps) {
    const out = adoptFlutterApp(tree, app, {}, buildScripts, pipeline);
    result.adopted.push(app.name);
    result.flutter = [...(result.flutter ?? []), app.name];
    result.notes.push(...out.notes.map((n) => `${code(app.name)}: ${n}`));
    if (options.scripts !== false) Object.assign(scripts, out.scripts);
  }
  const unread = buildScripts.unread.filter((n) => !flutterApps.some((f) => f.name === n));
  if (unread.length > 0) {
    result.notes.push(
      `Base hrefs for ${unread.map(code).join(', ')} could not be read from the ` +
        "build scripts; set `baseHref` on their release target's configurations.",
    );
  }
  // build:all:<env> through the workspace's own script: every app now builds with its release
  // target, so nx builds them all (only when every candidate was adopted).
  const replacedAll: string[] = [];
  if (options.scripts !== false && (!options.projects || options.projects.length === 0)) {
    const envs = new Set(
      result.adopted.flatMap((name) => {
        const c = candidates.find((x) => x.name === name);
        return c ? releaseEnvs(readJson<Json>(tree, `${c.root}/project.json`)) : [];
      }),
    );
    replacedAll.push(...buildAllScripts(pkg.scripts ?? {}, envs, scripts));
  }
  if (tree.exists('package.json')) setScriptsInPlace(tree, scripts);
  result.scripts = scripts;
  pinDevkit(tree, result.notes);

  const oldScripts = [...new Set([...buildScripts.customScripts, ...replacedAll])].sort();
  if (options.removeOldScripts) removeOldScripts(tree, oldScripts, result, reportFile);
  if (reportFile) tree.write(reportFile, report(result, pipeline, oldScripts));
  const flutterNames = result.flutter ?? [];
  const angularNames = result.adopted.filter((a) => !flutterNames.includes(a));
  logger.info(
    `adopt: ${angularNames.length} app(s) now build with nx run <app>:release:<env> ` +
      `(${angularNames.join(', ')})` +
      (flutterNames.length > 0
        ? `; Flutter web builds on flutter-build: ${flutterNames.join(', ')}`
        : '') +
      '.' +
      (reportFile ? ` Report: ${reportFile}` : ''),
  );
  for (const s of result.skipped) logger.warn(`adopt: not changed: ${s.replace(/`/g, '')}`);
  restoreLayouts(tree, layouts);
  return result;
}

/** Files of `before` that changed get their old layout back, with only the values changed. */
function restoreLayouts(tree: Tree, before: Map<string, string>): void {
  const jsonc = loadJsonc(tree.root);
  if (!jsonc) return;
  for (const [file, text] of before) {
    const now = tree.exists(file) ? tree.read(file, 'utf8') : null;
    if (now === null || now === text) continue;
    const kept = keepJsonLayout(jsonc, text, now);
    if (kept !== null && kept !== now) tree.write(file, kept);
  }
}
