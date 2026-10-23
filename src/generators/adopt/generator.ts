import { logger, readJson, Tree, updateJson, writeJson } from '@nx/devkit';

import { DEFAULT_STAMP, normalizeEnvEncryption } from '../../lib/env-encryption/config';
import {
  readEnvEncryptionBlock,
  writeEnvEncryptionBlock,
} from '../../lib/env-encryption/workspace';
import { adoptHtaccess, htaccessNote } from '../../lib/release/htaccess-adopt';
import { POLYSTACK_BUILD_EXECUTOR } from '../../lib/utils/angular-project';
import { readProjects } from '../../lib/utils/project-json-files';
import { addReleaseTarget, angularAppNpmScripts } from '../migrate/angular-project-json';
import { readBuildScripts, shapeReleaseTarget } from '../migrate/nx/build-scripts';
import { applySourceEnvEncryption } from '../migrate/nx/env-encryption';

import { readSourcePipeline, SourcePipeline } from './pipeline';

export interface AdoptGeneratorSchema {
  /** Apps to adopt (default: every Angular app without a release target). */
  projects?: string[];
  /** Point the apps' build:<app>:<env> npm scripts at the release target (default true). */
  scripts?: boolean;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const code = (s: string) => `\`${s}\``;

/** Angular builders whose apps the release executor builds (it runs them through buildTarget). */
const ANGULAR_APP_BUILDERS =
  /^(@angular-devkit\/build-angular:(browser|browser-esbuild|application)|@angular\/build:application|@nx\/angular:(webpack-browser|browser-esbuild|application))$/;

export const ADOPT_REPORT = 'docs/migrations/adopt.md';

export interface AdoptResult {
  adopted: string[];
  skipped: string[];
  notes: string[];
  scripts: Record<string, string>;
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
  const targetsKey = /"targets"\s*:\s*\{/.exec(text);
  if (release !== undefined && targetsKey) {
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
  for (const [key, cmd] of Object.entries(wanted)) {
    if (current[key] === cmd) continue;
    if (current[key] === undefined || custom[key] !== undefined) out[key] = cmd;
  }
  return out;
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

function report(result: AdoptResult, pipeline: SourcePipeline, customScripts: string[]): string {
  const lines = ['# pstack adopt', ''];
  lines.push(
    `Apps moved to the polystack \`release\` target: ${
      result.adopted.length > 0 ? result.adopted.map(code).join(', ') : 'none'
    }.`,
    '',
  );
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
            }, ${pipeline.nonce.addMeta ? 'adds' : 'no'} csp-nonce meta`
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
      'Check before switching CI: build one app both ways for each env and compare ' +
        '`dist/apps/<app>` (index.html, the .htaccess, the encrypted env values in main.js). ' +
        `The old scripts (${customScripts.map(code).join(', ')}) are left in place.`,
      '',
    );
  }
  if (result.notes.length > 0) lines.push('## Notes', '', ...result.notes.map((n) => `- ${n}`), '');
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
  const result: AdoptResult = { adopted: [], skipped: [], notes: [], scripts: {} };
  let candidates = adoptCandidates(tree);
  if (options.projects && options.projects.length > 0) {
    const wanted = new Set(options.projects);
    const known = new Set(candidates.map((c) => c.name));
    const unknown = options.projects.filter((p) => !known.has(p));
    if (unknown.length > 0) {
      throw new Error(
        `adopt: ${unknown.map((p) => `"${p}"`).join(', ')} ${
          unknown.length === 1 ? 'is not an Angular app' : 'are not Angular apps'
        } that builds without the plugin (candidates: ${[...known].join(', ') || 'none'})`,
      );
    }
    candidates = candidates.filter((c) => wanted.has(c.name));
  }
  for (const c of candidates.filter((c) => c.reason)) {
    result.skipped.push(`${code(c.name)}: ${c.reason}`);
  }
  candidates = candidates.filter((c) => !c.reason);
  if (candidates.length === 0) {
    logger.info('adopt: no Angular app builds without the plugin; nothing to do.');
    return result;
  }

  const pkg = tree.exists('package.json')
    ? readJson<{ scripts?: Record<string, string> }>(tree, 'package.json')
    : {};
  const names = candidates.map((c) => c.name);
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
  if (buildScripts.unread.length > 0) {
    result.notes.push(
      `Base hrefs for ${buildScripts.unread.map(code).join(', ')} could not be read from the ` +
        "build scripts; set `baseHref` on their release target's configurations.",
    );
  }
  if (tree.exists('package.json')) setScriptsInPlace(tree, scripts);
  result.scripts = scripts;

  tree.write(ADOPT_REPORT, report(result, pipeline, buildScripts.customScripts));
  logger.info(
    `adopt: ${result.adopted.length} app(s) now build with nx run <app>:release:<env> ` +
      `(${result.adopted.join(', ')}). Report: ${ADOPT_REPORT}`,
  );
  for (const s of result.skipped) logger.warn(`adopt: not changed: ${s.replace(/`/g, '')}`);
  return result;
}
