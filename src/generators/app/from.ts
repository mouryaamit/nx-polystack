import * as fs from 'fs';
import * as path from 'path';

import { names, readJson, Tree, updateJson } from '@nx/devkit';

import { parseAllowlist, serializeAllowlist } from '../../lib/csp/allowlist';
import { GENERATED_MARKER, renderHtaccess, renderNginx } from '../../lib/csp/render';
import { emptyEnvironmentText, emptyJson } from '../../lib/env/empty';
import { configurationFor, FLUTTER_BUILD_EXECUTOR } from '../../lib/release/plan';
import { POLYSTACK_BUILD_EXECUTOR } from '../../lib/utils/angular-project';
import {
  appRoot,
  assertDirOutsideProjects,
  NAME_RE,
  parseDir,
  upTo,
} from '../../lib/utils/app-dir';
import { baseHrefTarget, checkBaseHref, setBaseHref } from '../../lib/utils/base-href';
import { createIgnore, Ignore } from '../../lib/utils/devkit-deps';
import { refreshLlmBlocks } from '../../lib/utils/llm-block';
import { addNpmScripts } from '../../lib/utils/npm-scripts';
import { scanProjects } from '../../lib/utils/project-json-files';
import {
  nextFreePort,
  portProblem,
  serveTargetOf,
  usedServePorts,
} from '../../lib/utils/serve-port';
import { gitListedFiles, isPossibleSecret, shouldSkip, SkipRules } from '../migrate/copy';

export type AppType = 'angular' | 'ionic' | 'flutter';

/** What `pstack app --from` needs to know about the base app (also for its questions). */
export interface BaseApp {
  name: string;
  type: AppType;
  /** Project folder, e.g. apps/web or apps/legacy/web. */
  root: string;
  /** The folder under apps/ that holds it (the --dir default), when it sits under apps/. */
  dir?: string;
  /** Its environments (release configurations / Flutter env files), dev first. */
  envs: string[];
  /** The environment that builds DEV (always kept). */
  devEnv: string;
  /** A release configuration sets a base href. */
  baseHref: boolean;
  tags: string[];
  /** Ionic: the Capacitor appId. */
  appId?: string;
  /** Angular/Ionic: the folder under environments/ with its env files. */
  envProject?: string;
  /** Angular/Ionic: env → its env file name(s) in environments/<envProject>/. */
  envFiles?: Record<string, string[]>;
}

export interface AppFromOptions {
  from: string;
  name: string;
  dir?: string;
  port?: number;
  /** undefined: `/<name>/` when the base app has one; null: none. */
  baseHref?: string | null;
  appId?: string;
  /** Environments to keep (default all; the dev one is always kept). */
  envs?: string[];
  csp?: 'keep' | 'clear';
  tags?: string[];
}

export interface Leftover {
  file: string;
  line: number;
  text: string;
}

export interface AppFromResult {
  base: BaseApp;
  name: string;
  root: string;
  port: number;
  baseHref?: string;
  appId?: string;
  envs: string[];
  leftOut: string[];
  /** Files copied into the new app (relative to the workspace). */
  copied: string[];
  /** Env files written with emptied values. */
  envFiles: string[];
  /** `file: key` of values that were not literals (now ''). */
  expressions: string[];
  /** Spread/shorthand entries left as written (`file: entry`). */
  unkeyed: string[];
  /** Env files whose `environment` is not an object literal: copied as they are. */
  notEmptied: string[];
  /** Paths not copied (build output, caches, ignored files); folders end with "/". */
  skipped: string[];
  /** Possible secrets not copied. */
  secrets: string[];
  leftovers: Leftover[];
  /** Root npm scripts added for the new app. */
  scripts: string[];
}

/** Not copied from the base app (on top of what git ignores). */
export const APP_FROM_SKIP: SkipRules = {
  anyDepth: ['node_modules', '.git', '.dart_tool', '.angular', '.nx', '.gradle'],
  topLevel: ['dist', 'www', 'build', 'coverage', 'out-tsc', 'tmp', '.idea', '.vscode', '.packages'],
  topLevelPatterns: [/^\.flutter-plugins/],
  paths: [
    'ios/Pods',
    'ios/.symlinks',
    'ios/build',
    'ios/Flutter/Generated.xcconfig',
    'ios/Flutter/flutter_export_environment.sh',
    'macos/Pods',
    'android/build',
    'android/app/build',
    'android/local.properties',
    'docs/migrations',
  ],
  pathPatterns: [/(^|\/)flutter\/ephemeral$/i],
};

const FLUTTER_EXECUTOR = FLUTTER_BUILD_EXECUTOR;
const DEV_NAMES = ['dev', 'development'];

type Target = {
  executor?: string;
  options?: Record<string, unknown>;
  configurations?: Record<string, Record<string, unknown>>;
  defaultConfiguration?: string;
};

/** com.example.<name, alphanumerics only>; prefixed with "app" when it would start with a digit. */
export function defaultAppId(name: string): string {
  let segment = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (!/^[a-z]/.test(segment)) segment = `app${segment}`;
  return `com.example.${segment}`;
}

export const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

const CAPACITOR_APP_ID = /(\bappId\s*:\s*)(['"])([^'"\n]*)\2/;

/** The app named `from`, if pstack builds it (Angular/Ionic release target, Flutter flutter-build). */
export function describeBaseApp(tree: Tree, from: string): BaseApp {
  const project = scanProjects(tree).find((p) => p.name === from);
  if (!project) throw new Error(`no project named "${from}" in this workspace.`);
  const { root, json } = project;
  const targets = (json['targets'] ?? {}) as Record<string, Target>;
  const tags = Array.isArray(json['tags']) ? (json['tags'] as string[]) : [];
  const under = root.startsWith('apps/') ? root.slice('apps/'.length).split('/') : undefined;
  const dir = under && under.length > 1 ? under.slice(0, -1).join('/') : undefined;
  const found = baseHrefTarget(json);
  const baseHref = Object.values(found?.target.configurations ?? {}).some(
    (c) => c?.['baseHref'] !== undefined,
  );

  const release = Object.values(targets).find((t) => t.executor === POLYSTACK_BUILD_EXECUTOR);
  if (release) {
    const type = release.options?.['type'] === 'ionic' ? 'ionic' : 'angular';
    const configs = release.configurations ?? {};
    const envs = Object.keys(configs);
    const devEnv =
      envs.find((e) => String(configs[e]?.['env'] ?? '').toUpperCase() === 'DEV') ??
      envs.find((e) => DEV_NAMES.includes(e)) ??
      'dev';
    let appId: string | undefined;
    if (type === 'ionic' && tree.exists(`${root}/capacitor.config.ts`)) {
      appId = CAPACITOR_APP_ID.exec(tree.read(`${root}/capacitor.config.ts`, 'utf-8') ?? '')?.[3];
    }
    const envProject =
      typeof release.options?.['envProject'] === 'string'
        ? (release.options['envProject'] as string)
        : from;
    // The release executor reads environment.<env>.ts (DEV: environment.ts or environment.dev.ts).
    const envFiles: Record<string, string[]> = {};
    for (const e of envs) {
      const env = String(configs[e]?.['env'] ?? e).toLowerCase();
      envFiles[e] =
        e === devEnv || DEV_NAMES.includes(env)
          ? ['environment.ts', 'environment.dev.ts']
          : [`environment.${env}.ts`];
    }
    return {
      name: from,
      type,
      root,
      dir,
      envs: devFirst(envs.includes(devEnv) ? envs : [devEnv, ...envs], devEnv),
      devEnv,
      baseHref,
      tags,
      appId,
      envProject,
      envFiles,
    };
  }

  const flutter = Object.values(targets).some((t) => t.executor === FLUTTER_EXECUTOR);
  if (flutter && tree.exists(`${root}/env`)) {
    const envs = tree
      .children(`${root}/env`)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
    const devEnv = envs.find((e) => DEV_NAMES.includes(e)) ?? 'dev';
    return {
      name: from,
      type: 'flutter',
      root,
      dir,
      envs: devFirst(envs.includes(devEnv) ? envs : [devEnv, ...envs], devEnv),
      devEnv,
      baseHref,
      tags,
    };
  }
  throw new Error(
    `"${from}" is not an app pstack builds: an Angular/Ionic app with a ` +
      `${POLYSTACK_BUILD_EXECUTOR} release target, or a Flutter app with flutter-build targets ` +
      'and an env/ folder.',
  );
}

function devFirst(envs: string[], dev: string): string[] {
  return [dev, ...envs.filter((e) => e !== dev)];
}

/** kebab, snake, camel, Pascal and Title forms of a kebab-case name (unique, longest first). */
export function nameForms(name: string): string[] {
  const n = names(name);
  const title = n.className.replace(/([A-Z])/g, ' $1').trim();
  return [...new Set([name, name.replace(/-/g, '_'), n.propertyName, n.className, title])].sort(
    (a, b) => b.length - a.length,
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** `text` with `from` replaced by `to` where it is a whole path (not part of a longer name). */
function replacePath(text: string, from: string, to: string): string {
  const re = new RegExp(`(?<![\\w.-])${escapeRe(from)}(?![\\w-])`, 'g');
  return text.replace(re, to);
}

/** Replaces each base name form by the new one, as whole words. */
function replaceForms(text: string, base: string, name: string): string {
  const from = nameForms(base);
  const to = new Map(from.map((f) => [f, formLike(f, base, name) ?? f]));
  let out = text;
  for (const f of from) {
    const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(f)}(?![A-Za-z0-9_-])`, 'g');
    out = out.replace(re, to.get(f) ?? f);
  }
  return out;
}

/** The form of `name` matching `form` of `base` (kebab → kebab, Pascal → Pascal, …). */
function formLike(form: string, base: string, name: string): string | undefined {
  const b = names(base);
  const n = names(name);
  const bTitle = b.className.replace(/([A-Z])/g, ' $1').trim();
  const nTitle = n.className.replace(/([A-Z])/g, ' $1').trim();
  if (form === base) return name;
  if (form === base.replace(/-/g, '_')) return name.replace(/-/g, '_');
  if (form === b.propertyName) return n.propertyName;
  // A one-word base name has the same Pascal and Title form: the files renamed this way are
  // titles and display names, so the Title form wins.
  if (form === bTitle) return nTitle;
  if (form === b.className) return n.className;
  return undefined;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Files of the base app to copy, and what is left behind. */
function listFiles(
  tree: Tree,
  root: string,
  rules: SkipRules,
): { files: string[]; skipped: string[]; secrets: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  const secrets: string[] = [];
  const walk = (rel: string) => {
    const dir = rel ? `${root}/${rel}` : root;
    for (const child of [...tree.children(dir)].sort()) {
      const r = rel ? `${rel}/${child}` : child;
      const p = `${root}/${r}`;
      const isFile = tree.isFile(p);
      if (shouldSkip(r, rules)) {
        skipped.push(isFile ? r : `${r}/`);
        continue;
      }
      if (!isFile) {
        walk(r);
        continue;
      }
      if (isPossibleSecret(r)) {
        secrets.push(r);
        continue;
      }
      files.push(r);
    }
  };
  walk('');

  const listed = gitListedFiles(path.join(tree.root, root));
  let ignored: (rel: string) => boolean;
  if (listed) {
    const set = new Set(listed);
    // Files only in the tree (not on disk yet) are kept.
    ignored = (rel) => !set.has(rel) && fs.existsSync(path.join(tree.root, root, rel));
  } else {
    const ig = gitignoreOf(tree, root);
    ignored = (rel) => ig.ignores(rel);
  }
  const kept: string[] = [];
  for (const f of files) {
    if (ignored(f)) skipped.push(f);
    else kept.push(f);
  }
  return { files: kept, skipped: skipped.sort(), secrets };
}

/** The workspace and app .gitignore rules, as seen from the app folder (no git available). */
function gitignoreOf(tree: Tree, root: string): Ignore {
  const ig = createIgnore();
  const rootIgnore = tree.read('.gitignore', 'utf-8');
  if (rootIgnore) {
    // Rules anchored at the workspace root that point into the app.
    for (const line of rootIgnore.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      if (t.startsWith('/') || t.slice(0, -1).includes('/')) {
        const anchored = t.replace(/^\//, '');
        const neg = anchored.startsWith('!');
        const body = neg ? anchored.slice(1) : anchored;
        if (body.startsWith(`${root}/`)) ig.add(`${neg ? '!' : ''}/${body.slice(root.length + 1)}`);
      } else {
        ig.add(t);
      }
    }
  }
  const own = tree.read(`${root}/.gitignore`, 'utf-8');
  if (own) ig.add(own);
  return ig;
}

/**
 * Creates the new app from the base app: copies its files and configuration under the new name,
 * empties its environment values and sets what must differ (port, base href, appId, env set).
 */
export function appFrom(tree: Tree, o: AppFromOptions): AppFromResult {
  const label = 'app --from';
  const base = describeBaseApp(tree, o.from);
  const { name } = o;
  if (!NAME_RE.test(name)) {
    throw new Error(`${label}: --name="${name}" must be kebab-case (e.g. partner-portal).`);
  }
  if (name === base.name)
    throw new Error(`${label}: the new app needs a name other than "${name}".`);
  if (!base.root.includes('/')) {
    throw new Error(
      `${label}: ${base.name} sits in a top-level folder (${base.root}); copy apps that live ` +
        'under a folder such as apps/.',
    );
  }
  const dir = o.dir === '.' ? undefined : parseDir(o.dir ?? base.dir, label);
  const root = appRoot(name, dir);
  if (dir) assertDirOutsideProjects(tree, dir, label);
  if (tree.exists(root))
    throw new Error(`${label}: "${root}" already exists. Pick another --name or --dir.`);
  const projects = scanProjects(tree);
  if (projects.some((p) => p.name === name)) {
    throw new Error(`${label}: a project named "${name}" already exists. Pick another --name.`);
  }
  if (base.envProject) {
    const owner = projects.find((p) =>
      Object.values((p.json['targets'] ?? {}) as Record<string, Target>).some(
        (t) => t.executor === POLYSTACK_BUILD_EXECUTOR && t.options?.['envProject'] === name,
      ),
    );
    if (owner || tree.exists(`environments/${name}`)) {
      throw new Error(
        `${label}: environments/${name} is already in use` +
          `${owner ? ` (by ${owner.name})` : ''}. Pick another --name.`,
      );
    }
  }

  // Port
  const used = usedServePorts(tree);
  let port: number;
  if (o.port !== undefined) {
    const problem = portProblem(o.port);
    if (problem) throw new Error(`${label}: ${problem}.`);
    const owner = used.find((u) => u.port === o.port);
    if (owner)
      throw new Error(`${label}: port ${o.port} is used by ${owner.project}. Pick another --port.`);
    port = o.port;
  } else {
    port = nextFreePort(used.map((u) => u.port));
  }

  // Environments
  const wanted = o.envs ?? base.envs;
  const unknown = wanted.filter((e) => !base.envs.includes(e));
  if (unknown.length > 0) {
    throw new Error(
      `${label}: ${base.name} has no environment ${unknown.join(', ')} (it has ${base.envs.join(
        ', ',
      )}).`,
    );
  }
  const envs = base.envs.filter((e) => e === base.devEnv || wanted.includes(e));
  const leftOut = base.envs.filter((e) => !envs.includes(e));

  // Base href
  let baseHref: string | undefined;
  if (o.baseHref === undefined) baseHref = base.baseHref ? `/${name}/` : undefined;
  else if (o.baseHref !== null) baseHref = o.baseHref;
  if (baseHref !== undefined) {
    try {
      checkBaseHref(baseHref);
    } catch (err) {
      throw new Error(`${label}: ${(err as Error).message}`);
    }
  }

  // Capacitor appId
  let appId: string | undefined;
  if (base.type === 'ionic') {
    appId = o.appId ?? defaultAppId(name);
    if (!APP_ID_RE.test(appId)) {
      throw new Error(
        `${label}: --app-id="${appId}" is not a valid Capacitor appId (reverse-DNS, e.g. com.acme.app).`,
      );
    }
    if (appId === base.appId) {
      throw new Error(`${label}: --app-id must differ from ${base.name}'s (${appId}).`);
    }
  }

  const result: AppFromResult = {
    base,
    name,
    root,
    port,
    baseHref,
    appId,
    envs,
    leftOut,
    copied: [],
    envFiles: [],
    expressions: [],
    unkeyed: [],
    notEmptied: [],
    skipped: [],
    secrets: [],
    leftovers: [],
    scripts: [],
  };

  const baseDepth = base.root.split('/').length;
  const newDepth = root.split('/').length;
  const oldPkg =
    base.type === 'flutter'
      ? /^name:\s*([A-Za-z0-9_]+)/m.exec(tree.read(`${base.root}/pubspec.yaml`, 'utf-8') ?? '')?.[1]
      : undefined;
  const newPkg = name.replace(/-/g, '_');

  const rewrite = (rel: string, text: string): string => {
    let t = text;
    if (baseDepth !== newDepth) {
      const fileDepth = rel.split('/').length - 1;
      const from = baseDepth + fileDepth;
      const re = new RegExp(`(?<![\\w./])((?:\\.\\./){${from}})(?!\\.\\./)`, 'g');
      t = t.replace(re, '../'.repeat(newDepth + fileDepth));
    }
    t = replacePath(t, base.root, root);
    if (base.envProject)
      t = replacePath(t, `environments/${base.envProject}`, `environments/${name}`);
    return t;
  };

  // Ionic native projects carry the base app's appId: added again with cap-add instead.
  const rules =
    base.type === 'ionic'
      ? { ...APP_FROM_SKIP, topLevel: [...APP_FROM_SKIP.topLevel, 'android', 'ios'] }
      : APP_FROM_SKIP;
  const { files, skipped, secrets } = listFiles(tree, base.root, rules);
  result.skipped = skipped;
  result.secrets = secrets;

  for (const rel of files) {
    const src = `${base.root}/${rel}`;
    const dest = `${root}/${rel}`;
    const mode = fileMode(tree, src);

    // Flutter env files: only the kept ones, every value emptied.
    if (base.type === 'flutter' && /^env\/[^/]+\.json$/.test(rel)) {
      const env = rel.slice('env/'.length, -'.json'.length);
      if (!envs.includes(env)) continue;
      let json: unknown;
      try {
        json = JSON.parse(tree.read(src, 'utf-8') ?? '{}');
      } catch (err) {
        throw new Error(`${label}: ${src} is not valid JSON: ${(err as Error).message}`);
      }
      tree.write(dest, JSON.stringify(emptyJson(json), null, 2) + '\n');
      result.envFiles.push(dest);
      continue;
    }

    const buf = tree.read(src);
    if (!buf) continue;
    if (isBinary(buf)) {
      tree.write(dest, buf, mode !== undefined ? { mode } : undefined);
      result.copied.push(dest);
      continue;
    }
    let text = rewrite(rel, buf.toString('utf-8'));
    const file = rel.split('/').pop() ?? rel;

    if (rel === 'project.json') {
      text = projectJson(text, base, o, result);
    } else if (
      rel === 'src/index.html' ||
      rel === 'web/index.html' ||
      rel === 'web/manifest.json'
    ) {
      text = replaceForms(text, base.name, name);
    } else if (rel === 'capacitor.config.ts') {
      text = text.replace(
        CAPACITOR_APP_ID,
        (_m, pre: string, q: string) => `${pre}${q}${appId}${q}`,
      );
      text = text.replace(
        /(\bappName\s*:\s*)(['"])([^'"\n]*)\2/,
        (m, pre: string, q: string, v: string) =>
          `${pre}${q}${replaceForms(v, base.name, name)}${q}`,
      );
    } else if (rel === 'package.json' && base.type === 'ionic') {
      text = text.replace(
        /("name"\s*:\s*")([^"]*)"/,
        (_m, pre: string, v: string) =>
          `${pre}${
            v === base.name || v.startsWith(`${base.name}-`) ? name + v.slice(base.name.length) : v
          }"`,
      );
    } else if (rel === 'pubspec.yaml' && oldPkg) {
      text = text.replace(/^name:\s*[A-Za-z0-9_]+/m, `name: ${newPkg}`);
    } else if (rel === 'csp-allowlist.json' && o.csp === 'clear') {
      let permissionsPolicy: string | undefined;
      try {
        permissionsPolicy = parseAllowlist(JSON.parse(text)).permissionsPolicy;
      } catch {
        permissionsPolicy = undefined;
      }
      const cleared = parseAllowlist({});
      text = serializeAllowlist(permissionsPolicy ? { ...cleared, permissionsPolicy } : cleared);
    }
    if (oldPkg && file.endsWith('.dart')) {
      text = text.replace(
        new RegExp(`(['"])package:${escapeRe(oldPkg)}/`, 'g'),
        `$1package:${newPkg}/`,
      );
    }
    tree.write(dest, text, mode !== undefined ? { mode } : undefined);
    result.copied.push(dest);
  }

  // Angular/Ionic env files live in environments/<envProject>/.
  if (base.envProject) copyAngularEnvFiles(tree, base, name, result);

  // Server configs written by pstack: render them again for the new app.
  if (base.type !== 'flutter') {
    let allowlist;
    try {
      allowlist = parseAllowlist(
        JSON.parse(tree.read(`${root}/csp-allowlist.json`, 'utf-8') ?? '{}'),
      );
    } catch {
      allowlist = undefined;
    }
    if (allowlist) {
      for (const [file, render] of [
        [`${root}/src/.htaccess`, renderHtaccess],
        [`${root}/server/nginx.conf`, renderNginx],
      ] as const) {
        if (tree.exists(file) && (tree.read(file, 'utf-8') ?? '').includes(GENERATED_MARKER)) {
          tree.write(file, render(name, allowlist));
        }
      }
    }
  }

  copyEncryptionKeys(tree, base, name);
  copyTsPaths(tree, base, name, root);
  result.scripts = copyNpmScripts(tree, base, name, leftOut);
  result.leftovers = findLeftovers(tree, base.name, [...result.copied, ...result.envFiles]);
  refreshLlmBlocks(tree);
  return result;
}

function fileMode(tree: Tree, rel: string): number | undefined {
  try {
    const stat = fs.statSync(path.join(tree.root, rel));
    return stat.mode & 0o777;
  } catch {
    return undefined;
  }
}

/** The new project.json: renamed, env set trimmed, port, base href, no domain lock. */
function projectJson(text: string, base: BaseApp, o: AppFromOptions, r: AppFromResult): string {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `app --from: ${base.root}/project.json is not valid JSON: ${(err as Error).message}`,
    );
  }
  json = renameTargets(json, base.name, r.name) as Record<string, unknown>;
  json['name'] = r.name;
  if (typeof json['$schema'] === 'string') {
    json['$schema'] = `${upTo(r.root)}node_modules/nx/schemas/project-schema.json`;
  }
  if (o.tags) json['tags'] = o.tags;
  const targets = (json['targets'] ?? {}) as Record<string, Target>;

  for (const t of Object.values(targets)) {
    if (t.executor !== POLYSTACK_BUILD_EXECUTOR) continue;
    t.options ??= {};
    if (base.envProject) t.options['envProject'] = r.name;
    for (const c of [t.options, ...Object.values(t.configurations ?? {})]) {
      delete c['domains'];
      delete c['includeWww'];
    }
  }

  for (const env of r.leftOut) {
    if (base.type === 'flutter') {
      for (const t of Object.values(targets)) {
        if (t.executor !== FLUTTER_EXECUTOR || !t.configurations) continue;
        for (const [k, c] of Object.entries(t.configurations)) {
          if (k === env || c?.['env'] === env) delete t.configurations[k];
        }
      }
      continue;
    }
    for (const t of Object.values(targets)) {
      if (t.executor !== POLYSTACK_BUILD_EXECUTOR || !t.configurations) continue;
      const key = configurationFor(t, env);
      if (!key) continue;
      const buildConf =
        (t.configurations[key]?.['buildConfiguration'] as string | undefined) ??
        ({ prod: 'production', uat: 'uat' } as Record<string, string>)[env] ??
        env;
      delete t.configurations[key];
      const buildRef = t.options?.['buildTarget'];
      const buildName =
        typeof buildRef === 'string' && buildRef.startsWith(`${r.name}:`)
          ? buildRef.split(':')[1]
          : 'build';
      const build = targets[buildName];
      if (build?.configurations?.[buildConf]) delete build.configurations[buildConf];
      for (const s of Object.values(targets)) {
        if (!s.configurations) continue;
        for (const [k, c] of Object.entries(s.configurations)) {
          const ref = c?.['browserTarget'] ?? c?.['buildTarget'];
          if (typeof ref === 'string' && ref === `${r.name}:${buildName}:${buildConf}`) {
            delete s.configurations[k];
            if (s.defaultConfiguration === k) delete s.defaultConfiguration;
          }
        }
      }
    }
  }

  // A default configuration that was left out would make `nx build <app>` fail.
  for (const t of Object.values(targets)) {
    if (t.defaultConfiguration && !t.configurations?.[t.defaultConfiguration]) {
      delete t.defaultConfiguration;
    }
  }

  const serve = serveTargetOf(json) as Target | undefined;
  if (serve) serve.options = { ...(serve.options ?? {}), port: r.port };

  const found = baseHrefTarget(json);
  if (found) {
    const configs = found.target.configurations ?? {};
    const withHref = Object.keys(configs).filter((k) => configs[k]?.['baseHref'] !== undefined);
    const targetsOf =
      withHref.length > 0 ? withHref : ['uat', 'prod'].filter((k) => configs[k] !== undefined);
    if (r.baseHref !== undefined) setBaseHref(found.target, targetsOf, r.baseHref);
    else if (withHref.length > 0) setBaseHref(found.target, withHref, undefined);
  }
  return JSON.stringify(json, null, 2) + '\n';
}

/** Every string with `<base>:` (a target reference) or `nx … <base>` turned to the new name. */
function renameTargets(value: unknown, base: string, name: string): unknown {
  if (typeof value === 'string') {
    return value
      .replace(new RegExp(`(^|[\\s'"=])${escapeRe(base)}:`, 'g'), `$1${name}:`)
      .replace(
        new RegExp(
          `(\\bnx\\s+(?:run|serve|build|test|lint|export|e2e)\\s+)${escapeRe(base)}(?![\\w-])`,
          'g',
        ),
        `$1${name}`,
      );
  }
  if (Array.isArray(value)) return value.map((v) => renameTargets(v, base, name));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renameTargets(v, base, name)]),
    );
  }
  return value;
}

/** environments/<base>/ → environments/<name>/: the kept envs, every value emptied. */
function copyAngularEnvFiles(tree: Tree, base: BaseApp, name: string, r: AppFromResult): void {
  const from = `environments/${base.envProject}`;
  if (!tree.exists(from)) return;
  const leftOutFiles = new Set(r.leftOut.flatMap((e) => base.envFiles?.[e] ?? []));
  for (const file of [...tree.children(from)].sort()) {
    const src = `${from}/${file}`;
    if (!tree.isFile(src)) continue;
    const dest = `environments/${name}/${file}`;
    if (leftOutFiles.has(file)) continue;
    const text = tree.read(src, 'utf-8') ?? '';
    // Helper files (types, shared parts) are copied as they are.
    if (!/\benvironment\b\s*(?::[^=]*)?=/.test(text)) {
      tree.write(dest, text);
      r.copied.push(dest);
      continue;
    }
    if (!/\benvironment\b\s*(?::[^=]*)?=\s*\{/.test(text)) {
      tree.write(dest, text);
      r.copied.push(dest);
      r.notEmptied.push(dest);
      continue;
    }
    const emptied = emptyEnvironmentText(text);
    tree.write(dest, emptied.text);
    r.envFiles.push(dest);
    r.expressions.push(...emptied.expressions.map((k) => `${dest}: ${k}`));
    r.unkeyed.push(...emptied.unkeyed.map((k) => `${dest}: ${k}`));
  }
}

/** nx.json pstack.envEncryption.keys.<base> (key names only) → keys.<name>. */
function copyEncryptionKeys(tree: Tree, base: BaseApp, name: string): void {
  if (!base.envProject || !tree.exists('nx.json')) return;
  const keys = (
    readJson(tree, 'nx.json') as {
      pstack?: { envEncryption?: { keys?: Record<string, string[]> } };
    }
  ).pstack?.envEncryption?.keys;
  const list = keys?.[base.envProject];
  if (!Array.isArray(list) || keys?.[name]) return;
  updateJson(tree, 'nx.json', (json) => {
    json.pstack.envEncryption.keys[name] = [...list];
    return json;
  });
}

/** tsconfig.base.json aliases that point into the base app, for the new app. */
function copyTsPaths(tree: Tree, base: BaseApp, name: string, root: string): void {
  if (!tree.exists('tsconfig.base.json')) return;
  updateJson(tree, 'tsconfig.base.json', (json: Record<string, unknown>) => {
    const opts = (json['compilerOptions'] ?? {}) as Record<string, unknown>;
    const paths = (opts['paths'] ?? {}) as Record<string, string[]>;
    for (const [alias, targets] of Object.entries({ ...paths })) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      const inside = targets.every((t) => t === base.root || t.startsWith(`${base.root}/`));
      if (!inside) continue;
      const next = replaceForms(alias, base.name, name);
      if (next === alias || paths[next]) continue;
      paths[next] = targets.map((t) => root + t.slice(base.root.length));
    }
    return json;
  });
}

/** Root npm scripts of the base app (`serve:web`, `build:web:uat`, …) for the new app. */
function copyNpmScripts(tree: Tree, base: BaseApp, name: string, leftOut: string[]): string[] {
  if (!tree.exists('package.json')) return [];
  const scripts = (readJson(tree, 'package.json').scripts ?? {}) as Record<string, string>;
  const add: Record<string, string> = {};
  for (const [key, cmd] of Object.entries(scripts)) {
    // <verb>:<app>[:<env>…]: only the app segment is the app's name.
    const parts = key.split(':');
    if (parts[1] !== base.name) continue;
    if (parts.slice(2).some((p) => leftOut.includes(p))) continue;
    const newKey = [parts[0], name, ...parts.slice(2)].join(':');
    if (scripts[newKey] !== undefined) continue;
    add[newKey] = renameTargets(cmd, base.name, name) as string;
  }
  if (Object.keys(add).length > 0) addNpmScripts(tree, add, { force: false });
  return Object.keys(add);
}

const MAX_LEFTOVERS = 50;

/** Lines of the written text files that still name the base app. */
function findLeftovers(tree: Tree, base: string, files: string[]): Leftover[] {
  const forms = nameForms(base);
  const re = new RegExp(`(?<![A-Za-z0-9_-])(${forms.map(escapeRe).join('|')})(?![A-Za-z0-9_-])`);
  const out: Leftover[] = [];
  for (const file of files) {
    const buf = tree.read(file);
    if (!buf || isBinary(buf)) continue;
    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        out.push({ file, line: i + 1, text: lines[i].trim().slice(0, 120) });
        if (out.length >= MAX_LEFTOVERS) return out;
      }
    }
  }
  return out;
}

/** The report printed after (or, with --dry-run, instead of) creating the app. */
export function appFromReport(r: AppFromResult): string {
  const lines: string[] = [];
  lines.push(
    `${r.name} (${r.root}) from ${r.base.name}: ${r.copied.length} file(s) copied, ` +
      `${r.envFiles.length} env file(s) with every value emptied.`,
  );
  lines.push(
    `  port ${r.port}${r.baseHref ? `, base href ${r.baseHref}` : ''}${
      r.appId ? `, appId ${r.appId}` : ''
    }`,
  );
  lines.push(
    `  environments: ${r.envs.join(', ')}${
      r.leftOut.length ? ` (left out: ${r.leftOut.join(', ')})` : ''
    }`,
  );
  if (r.scripts.length > 0) lines.push(`  npm scripts: ${r.scripts.join(', ')}`);
  if (r.expressions.length > 0) {
    lines.push('  Values that were not literals, now empty strings:');
    for (const e of r.expressions) lines.push(`    ${e}`);
  }
  if (r.notEmptied.length > 0) {
    lines.push(
      '  NOT emptied (the environment is not an object literal; values copied as they are):',
    );
    for (const e of r.notEmptied) lines.push(`    ${e}`);
  }
  if (r.unkeyed.length > 0) {
    lines.push('  Entries left as written (spread / shorthand):');
    for (const e of r.unkeyed) lines.push(`    ${e}`);
  }
  if (r.secrets.length > 0) lines.push(`  Not copied (possible secrets): ${r.secrets.join(', ')}`);
  if (r.skipped.length > 0) {
    const shown = r.skipped.slice(0, 20);
    lines.push(
      `  Not copied (build output, caches, ignored files): ${shown.join(', ')}` +
        (r.skipped.length > shown.length ? `, … (${r.skipped.length - shown.length} more)` : ''),
    );
  }
  if (r.leftovers.length > 0) {
    lines.push(`  Still naming ${r.base.name} (review these):`);
    for (const l of r.leftovers) lines.push(`    ${l.file}:${l.line}  ${l.text}`);
    if (r.leftovers.length >= MAX_LEFTOVERS) lines.push('    … (first 50 shown)');
  }
  lines.push('Next:');
  lines.push(
    `  - fill in the env files (every value is empty, production is false): ${
      r.base.type === 'flutter' ? `${r.root}/env/*.json` : `environments/${r.name}/`
    }`,
  );
  if (r.base.type !== 'flutter') {
    lines.push(
      `  - encrypted keys and domain locks: pstack encryption --app=${r.name} --domains=<env>=<hosts>`,
    );
  }
  if (
    r.base.type === 'flutter' &&
    r.copied.some((f) => f.startsWith(`${r.root}/android/`) || f.startsWith(`${r.root}/ios/`))
  ) {
    lines.push(
      `  - android/ and ios/ still use ${r.base.name}'s applicationId / bundle id: change them ` +
        `before installing ${r.name} next to ${r.base.name}`,
    );
  }
  if (r.base.type === 'ionic' && r.skipped.some((s) => s === 'android/' || s === 'ios/')) {
    lines.push(
      `  - native projects were not copied (they hold ${r.base.name}'s appId): ` +
        `nx run ${r.name}:cap-add --platform=android|ios`,
    );
  }
  lines.push(`  - nx run ${r.name}:serve`);
  return lines.join('\n');
}
