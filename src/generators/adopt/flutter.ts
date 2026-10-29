import * as fs from 'fs';
import * as path from 'path';

import { Tree } from '@nx/devkit';

import { htaccessSourcePath } from '../../lib/release/htaccess';
import { flutterEnvFile } from '../../lib/utils/env-files';
import { readProjects } from '../../lib/utils/project-json-files';
import { releaseConfigName } from '../migrate/angular-project-json';
import { appFieldInScript, BuildScriptInfo } from '../migrate/nx/build-scripts';

import { SourcePipeline } from './pipeline';

/**
 * pstack adopt for Flutter apps: a web build that runs `flutter build web` itself (run-commands,
 * often through the workspace's own build script) becomes the plugin's flutter-build target, with
 * the env files and the .htaccess under environments/<app>/ and the script's post-build steps
 * (CSP nonce, HTML comments) as options. Mobile and serve targets are left as they are.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const code = (s: string) => `\`${s}\``;

export const FLUTTER_BUILD_EXECUTOR = '@mouryaamit/nx-polystack:flutter-build';

export interface FlutterCandidate {
  name: string;
  root: string;
  /** The target that builds the web app (e.g. build-web). */
  webTarget?: string;
  /** Why it is left alone. */
  reason?: string;
}

/** Commands of a run-commands target: options and every configuration. */
function commandsOf(target: Json): { config?: string; cmd: string; cwd: string }[] {
  const out: { config?: string; cmd: string; cwd: string }[] = [];
  const baseCwd = isObject(target['options']) ? target['options']['cwd'] : undefined;
  const add = (o: unknown, config?: string) => {
    if (!isObject(o)) return;
    const c0 = typeof o['cwd'] === 'string' ? o['cwd'] : baseCwd;
    const cwd = typeof c0 === 'string' ? c0 : '.';
    if (typeof o['command'] === 'string') out.push({ config, cmd: o['command'] as string, cwd });
    if (Array.isArray(o['commands'])) {
      for (const c of o['commands'] as unknown[]) {
        const cmd = typeof c === 'string' ? c : isObject(c) ? c['command'] : undefined;
        if (typeof cmd === 'string') out.push({ config, cmd, cwd });
      }
    }
  };
  add(target['options']);
  const configs = isObject(target['configurations']) ? (target['configurations'] as Json) : {};
  for (const [name, c] of Object.entries(configs)) add(c, name);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The older generated wrapper (tools/scripts/flutter/flutter-build.js): pstack update moves it. */
const LEGACY_WRAPPER = /\bflutter-build\.(?:c|m)?js\b/;

/** True when a command builds this app's web output (directly or through a build script). */
export function buildsWeb(cmd: string, name: string): boolean {
  if (/\bflutter\s+build\s+web\b/.test(cmd)) return true;
  if (!/\bnode\s+\S+\.(?:c|m)?js\b/.test(cmd) || LEGACY_WRAPPER.test(cmd)) return false;
  const target = flag(cmd, ['target', 'platform']);
  if (target !== undefined && target !== 'web') return false;
  return new RegExp(`--(?:project|app)(?:=|\\s+)(['"]?)${escapeRe(name)}\\1(?=\\s|$)`).test(cmd);
}

/** Flutter apps (pubspec.yaml next to project.json) whose web build does not use the plugin. */
export function flutterAdoptCandidates(tree: Tree): FlutterCandidate[] {
  const out: FlutterCandidate[] = [];
  for (const { name, root, json } of readProjects(tree)) {
    if (!tree.exists(`${root}/pubspec.yaml`) || json['projectType'] === 'library') continue;
    const targets = isObject(json['targets']) ? (json['targets'] as Record<string, Json>) : {};
    if (
      Object.values(targets).some(
        (t) =>
          isObject(t) &&
          (t['executor'] === FLUTTER_BUILD_EXECUTOR ||
            commandsOf(t).some((c) => LEGACY_WRAPPER.test(c.cmd))),
      )
    )
      continue;
    const web = Object.entries(targets).find(
      ([, t]) =>
        isObject(t) &&
        t['executor'] === 'nx:run-commands' &&
        commandsOf(t).some((c) => buildsWeb(c.cmd, name)),
    )?.[0];
    out.push(
      web
        ? { name, root, webTarget: web }
        : { name, root, reason: 'no run-commands target that runs `flutter build web`' },
    );
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A flag's value; undefined when missing or an interpolation (`{args.env}`, `${env}`). */
function flag(cmd: string, names: string[]): string | undefined {
  for (const n of names) {
    const m = new RegExp(`(?:^|\\s)--?${n}(?:=|\\s+)(['"]?)([^\\s'"]+)\\1`).exec(cmd);
    if (m) return /[{}$]/.test(m[2]) ? undefined : m[2];
  }
  return undefined;
}

const ENV_NAME: Record<string, string> = { development: 'dev', production: 'prod' };
const envName = (e: string) => ENV_NAME[e] ?? releaseConfigName(e);

export interface FlutterAdoptOutcome {
  /** Release env names of the new web target (dev, prod, …). */
  envs: string[];
  /** npm scripts to set. */
  scripts: Record<string, string>;
  notes: string[];
}

/** Workspace-relative path in a command (`--output /abs/dist/x` or `dist/x`); undefined outside. */
function workspacePath(root: string, p: string | undefined): string | undefined {
  if (!p || p.includes('$')) return undefined;
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return rel && !rel.startsWith('..') ? rel : undefined;
}

/**
 * Moves one Flutter app's web build to the flutter-build executor. Envs come from the old target's
 * configurations and the npm scripts that build the app; dist and base href from the build script
 * (per-app map) or the flutter command; env files from <root>/env/<env>.json (`{}` when there was
 * none: the old build passed no defines); the .htaccess from <root>/web/.htaccess.
 */
export function adoptFlutterApp(
  tree: Tree,
  app: FlutterCandidate & { webTarget: string },
  scripts: Record<string, string>,
  buildScripts: BuildScriptInfo,
  pipeline: SourcePipeline,
): FlutterAdoptOutcome {
  const { name, root, webTarget } = app;
  const notes: string[] = [];
  const pjPath = `${root}/project.json`;
  const pj = JSON.parse(tree.read(pjPath, 'utf8') ?? '{}') as Json;
  const targets = pj['targets'] as Record<string, Json>;
  const old = targets[webTarget];
  const commands = commandsOf(old);

  // The npm scripts that build this app through the workspace's build script.
  const custom = Object.entries(buildScripts.customBuilds).filter(([, cmd]) =>
    buildsWeb(cmd, name),
  );
  const scriptTexts = buildScripts.customScripts
    .map((s) => {
      try {
        return fs.readFileSync(path.join(tree.root, ...s.split('/')), 'utf8');
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  // Envs: --env of the old configurations and of the npm scripts; else the config names. The
  // names they were written with (production, prod) are kept to find the env files.
  const envs = new Set<string>();
  const rawNames = new Map<string, Set<string>>();
  const explicitEnvFile = new Map<string, string>();
  const addEnv = (raw: string, cmd?: string, cwd = '.') => {
    const env = envName(raw);
    envs.add(env);
    rawNames.set(env, new Set([...(rawNames.get(env) ?? []), raw, env]));
    const file = cmd ? flag(cmd, ['dart-define-from-file']) : undefined;
    if (file && !explicitEnvFile.has(env)) explicitEnvFile.set(env, path.posix.join(cwd, file));
  };
  for (const { config, cmd, cwd } of commands) {
    const e = flag(cmd, ['env']) ?? config;
    if (e) addEnv(e, cmd, cwd);
    if (config && e !== config) rawNames.get(envName(e as string))?.add(config);
  }
  for (const [, cmd] of custom) {
    const e = flag(cmd, ['env', 'configuration', 'c']);
    if (e) addEnv(e);
  }
  if (envs.size === 0) addEnv('prod');
  const envList = [...envs].sort((a, b) => order(a) - order(b) || a.localeCompare(b));

  // dist and base href.
  const fromScripts = (field: string) =>
    scriptTexts.map((t) => appFieldInScript(t, name, field)).find((v) => v !== undefined);
  const flutterRun = commands.find((c) => /\bflutter\s+build\s+web\b/.test(c.cmd));
  const flutterCmd = flutterRun?.cmd;
  const output = flutterCmd ? flag(flutterCmd, ['output', 'o']) : undefined;
  const dist =
    workspacePath(tree.root, fromScripts('dist')) ??
    workspacePath(
      tree.root,
      output && flutterRun ? path.resolve(tree.root, flutterRun.cwd, output) : undefined,
    ) ??
    `dist/${root}/web`;
  const hrefs = { ...(buildScripts.baseHrefs.get(name) ?? {}) };
  const cmdHref = flutterCmd ? flag(flutterCmd, ['base-href']) : undefined;
  if (cmdHref && !hrefs['*']) hrefs['*'] = cmdHref;

  // Text of everything that stays as it was: a file those still name is copied, not moved.
  const stays = [
    JSON.stringify(Object.fromEntries(Object.entries(targets).filter(([k]) => k !== webTarget))),
    JSON.stringify(
      readPackageScripts(
        tree,
        custom.map(([k]) => k),
      ),
    ),
  ].join('\n');
  const stillUsed = (file: string) => {
    const rel = file.slice(root.length + 1);
    return stays.includes(rel) || stays.includes(file);
  };

  // Env files: the --dart-define-from-file the old command passed, else <root>/env/<env>.json
  // under any name the env had (prod, production) → environments/<app>/environment.<env>.json.
  for (const env of envList) {
    const to = flutterEnvFile(name, env);
    if (tree.exists(to)) continue;
    const explicit = explicitEnvFile.get(env);
    const candidates = [
      ...(explicit ? [explicit] : []),
      ...[...(rawNames.get(env) ?? [env])].map((r) => `${root}/env/${r}.json`),
    ].map((f) => path.posix.normalize(f));
    const from = candidates.find((f) => !f.startsWith('..') && tree.exists(f) && tree.isFile(f));
    if (from) {
      tree.write(to, tree.read(from) as Buffer);
      if (stillUsed(from)) {
        notes.push(`${code(from)} copied to ${code(to)} (kept: another target still uses it)`);
      } else {
        tree.delete(from);
        notes.push(`${code(from)} moved to ${code(to)}`);
      }
    } else {
      tree.write(to, '{}\n');
      notes.push(
        `${code(to)} created empty (no ${code(`${root}/env/${env}.json`)}; add the app's ` +
          '--dart-define values there)',
      );
    }
  }

  // .htaccess: web/.htaccess → environments/<app>/htaccess.<env>.
  const htSource = `${root}/web/.htaccess`;
  let htaccess = false;
  if (tree.exists(htSource)) {
    htaccess = true;
    const content = tree.read(htSource) as Buffer;
    const written: string[] = [];
    const kept: string[] = [];
    for (const env of envList) {
      const file = htaccessSourcePath(name, env);
      if (tree.exists(file)) kept.push(file);
      else {
        tree.write(file, content);
        written.push(file);
      }
    }
    tree.delete(htSource);
    notes.push(
      `${code(htSource)} became ${written.map(code).join(', ') || 'nothing new'}` +
        (kept.length > 0 ? ` (kept ${kept.map(code).join(', ')})` : '') +
        ' (each web build copies its own env file as `.htaccess`)',
    );
  } else if (envList.some((e) => tree.exists(htaccessSourcePath(name, e)))) {
    htaccess = true;
  }

  // The new target. The script's post-build steps apply only to an app it built.
  const viaScript =
    custom.length > 0 || commands.some((c) => /\bnode\s+\S+\.(?:c|m)?js\b/.test(c.cmd));
  const options: Json = { target: 'web', dist };
  if (!htaccess) options['htaccess'] = false;
  if (viaScript && pipeline.nonce) {
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
  if (viaScript && pipeline.stripHtmlComments) options['stripHtmlComments'] = true;
  const configurations: Record<string, Json> = {};
  for (const env of envList) {
    const href = hrefs[env] ?? hrefs['*'];
    configurations[env] = href && href !== '/' ? { env, baseHref: href } : { env };
  }
  const target: Json = {
    executor: FLUTTER_BUILD_EXECUTOR,
    options,
    configurations,
    defaultConfiguration: envList.includes('dev') ? 'dev' : envList[0],
  };
  // Same key, same place in targets.
  pj['targets'] = Object.fromEntries(
    Object.entries(targets).map(([k, v]) => [k, k === webTarget ? target : v]),
  );
  tree.write(pjPath, `${JSON.stringify(pj, null, 2)}\n`);
  notes.push(
    `${code(webTarget)} builds with flutter-build into ${code(dist)} (${envList.join(', ')})` +
      (Object.values(configurations).some((c) => c['baseHref'])
        ? `, base href ${code(String(hrefs[envList[0]] ?? hrefs['*']))}`
        : ''),
  );
  const others = Object.entries(targets)
    .filter(([k, t]) => k !== webTarget && isObject(t) && t['executor'] === 'nx:run-commands')
    .map(([k]) => k);
  if (others.length > 0) {
    notes.push(
      `left as they were: ${others.map(code).join(', ')} (run-commands; the plugin's ` +
        'flutter-build can run apk / ios builds too, with the same env files)',
    );
  }

  // npm scripts: the ones that built through the script now run the target; standard names for
  // envs no script covered.
  const covered = new Set<string>();
  for (const [key, cmd] of custom) {
    const e = flag(cmd, ['env', 'configuration', 'c']);
    const env = e ? envName(e) : envList[0];
    if (!envList.includes(env)) continue;
    scripts[key] = `nx run ${name}:${webTarget}:${env}`;
    covered.add(env);
  }
  for (const env of envList) {
    if (!covered.has(env) && scripts[`build:${name}:${env}`] === undefined) {
      scripts[`build:${name}:${env}`] = `nx run ${name}:${webTarget}:${env}`;
    }
  }
  return { envs: envList, scripts, notes };
}

const ORDER = ['dev', 'uat', 'prod'];
const order = (e: string) => (ORDER.includes(e) ? ORDER.indexOf(e) : ORDER.length);

/** The workspace's npm scripts, without the ones adopt rewrites. */
function readPackageScripts(tree: Tree, rewritten: string[]): Record<string, string> {
  if (!tree.exists('package.json')) return {};
  try {
    const all = (JSON.parse(tree.read('package.json', 'utf8') ?? '{}').scripts ?? {}) as Record<
      string,
      string
    >;
    return Object.fromEntries(Object.entries(all).filter(([k]) => !rewritten.includes(k)));
  } catch {
    return {};
  }
}
