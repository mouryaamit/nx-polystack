import * as fs from 'fs';
import * as path from 'path';

import { releaseConfigName } from '../angular-project-json';

import { isObject, Json, objectField } from './workspace-source';

/**
 * What a source's root npm scripts say about building its apps: base hrefs per environment
 * (from `nx build … --base-href` flags, or from a plain map in a custom build script) and which
 * scripts build through a custom script (`node tools/scripts/build.js --project=x --env=uat`).
 */

export interface BuildScriptInfo {
  /** Source project → release configuration (dev, uat, prod, …) → base href. */
  baseHrefs: Map<string, Record<string, string>>;
  /** npm scripts that build through a custom script: name → command. */
  customBuilds: Record<string, string>;
  /** Custom build script files (source-relative), sorted. */
  customScripts: string[];
  /** Projects a custom script builds whose base hrefs could not be read. */
  unread: string[];
}

const ENV_NAME: Record<string, string> = {
  development: 'dev',
  production: 'prod',
};
const releaseName = (env: string) => ENV_NAME[env] ?? releaseConfigName(env);

const flag = (cmd: string, names: string[]): string | undefined => {
  for (const n of names) {
    const m = new RegExp(`(?:^|\\s)--?${n}(?:=|\\s+)(['"]?)([^\\s'"]+)\\1`).exec(cmd);
    if (m) return m[2];
  }
  return undefined;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `{ … }` text starting at `open` (balanced braces, quotes skipped). */
function objectAt(text: string, open: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
}

/** `project: '/x/'` or `project: { uat: '/x/', … }` at the top level of a map's text. */
function hrefsInMap(map: string, project: string): Record<string, string> | undefined {
  const key = `(?:^|[\\s,{])(['"]?)${escape(project)}\\1\\s*:\\s*`;
  const str = new RegExp(`${key}(['"\`])(\\/[^'"\`]*)\\2`, 'm').exec(map);
  if (str) return { '*': str[3] };
  const obj = new RegExp(`${key}\\{([^{}]*)\\}`, 'm').exec(map);
  if (!obj) return undefined;
  const out: Record<string, string> = {};
  for (const m of obj[2].matchAll(/(['"]?)(\w+)\1\s*:\s*(['"`])(\/[^'"`]*)\3/g)) {
    out[releaseName(m[2])] = m[4];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Base hrefs for `project` in a script's text, read only from maps whose name says base href
 * (`const BASE_HREF = { project: '/x/' }`, `baseHrefs: { project: { uat: '/x/' } }`). Values must
 * start with "/". Undefined when there is none, or when two maps disagree.
 */
export function baseHrefsInScript(
  text: string,
  project: string,
): Record<string, string> | undefined {
  const found: Record<string, string>[] = [];
  for (const m of text.matchAll(/[\w$]*base[_-]?hrefs?[\w$]*['"]?\s*[:=]\s*\{/gi)) {
    const map = objectAt(text, (m.index ?? 0) + m[0].length - 1);
    const hrefs = map ? hrefsInMap(map, project) : undefined;
    if (hrefs) found.push(hrefs);
  }
  if (found.length === 0) return undefined;
  const first = JSON.stringify(found[0]);
  return found.every((f) => JSON.stringify(f) === first) ? found[0] : undefined;
}

export function readBuildScripts(
  sourceDir: string,
  scripts: Record<string, string> | undefined,
  projects: string[],
): BuildScriptInfo {
  const info: BuildScriptInfo = {
    baseHrefs: new Map(),
    customBuilds: {},
    customScripts: [],
    unread: [],
  };
  const names = new Set(projects);
  const texts = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!texts.has(rel)) {
      try {
        texts.set(rel, fs.readFileSync(path.join(sourceDir, ...rel.split('/')), 'utf8'));
      } catch {
        texts.set(rel, undefined);
      }
    }
    return texts.get(rel);
  };
  const set = (project: string, env: string, href: string) => {
    const hrefs = info.baseHrefs.get(project) ?? {};
    hrefs[env] = href;
    info.baseHrefs.set(project, hrefs);
  };
  const customProjects = new Map<string, string>();

  for (const [name, cmd] of Object.entries(scripts ?? {})) {
    if (typeof cmd !== 'string') continue;
    // nx build <p> / nx run <p>:build[:<c>] / ng build <p>, with --configuration and --base-href.
    const direct = /\b(?:nx|ng)\s+(?:build\s+([\w.-]+)|run\s+([\w.-]+):build(?::([\w-]+))?)/.exec(
      cmd,
    );
    if (direct) {
      const project = direct[1] ?? direct[2];
      const href = flag(cmd, ['base-href', 'baseHref']);
      const config = direct[3] ?? flag(cmd, ['configuration', 'c']);
      if (names.has(project) && href) set(project, config ? releaseName(config) : '*', href);
      continue;
    }
    const node = /\bnode\s+(['"]?)([^\s'"]+\.(?:c|m)?js)\1/.exec(cmd);
    if (!node || !/build/i.test(`${name} ${node[2]}`)) continue;
    const script = path.posix.normalize(node[2].replace(/^\.\//, ''));
    const project = flag(cmd, ['project', 'app']);
    if (!project || (!names.has(project) && project !== 'all')) continue;
    info.customBuilds[name] = cmd;
    if (!info.customScripts.includes(script)) info.customScripts.push(script);
    const env = flag(cmd, ['env', 'configuration', 'c']);
    const targets = project === 'all' ? [...names] : [project];
    for (const p of targets) {
      customProjects.set(p, script);
      const hrefs =
        read(script) !== undefined ? baseHrefsInScript(read(script) as string, p) : undefined;
      if (!hrefs) continue;
      for (const [e, href] of Object.entries(hrefs)) {
        if (e === '*' && env) set(p, releaseName(env), href);
        else set(p, e, href);
      }
    }
  }
  info.customScripts.sort();
  info.unread = [...customProjects.keys()].filter((p) => !info.baseHrefs.has(p)).sort();
  return info;
}

/**
 * The release target of a migrated app: the env folder its fileReplacements use
 * (environments/<x>/…), and base hrefs from the source's build scripts.
 */
export function shapeReleaseTarget(
  targets: Json,
  sourceName: string,
  scripts: BuildScriptInfo,
  notes: string[],
): void {
  const release = targets['release'];
  if (!isObject(release) || !isObject(release['options'])) return;
  const options = release['options'] as Json;
  const envProject = envFolderOf(objectField(targets, 'build'));
  if (envProject && envProject !== options['envProject']) options['envProject'] = envProject;
  const hrefs = scripts.baseHrefs.get(sourceName);
  if (!hrefs) return;
  const configurations = isObject(release['configurations'])
    ? (release['configurations'] as Record<string, Json>)
    : {};
  const applied: string[] = [];
  for (const [name, config] of Object.entries(configurations)) {
    const href = hrefs[name] ?? hrefs['*'];
    if (!href || href === '/' || !isObject(config)) continue;
    config['baseHref'] = href;
    applied.push(`${name}: ${href}`);
  }
  if (applied.length > 0) {
    notes.push(`release target base hrefs from the source build scripts: ${applied.join(', ')}`);
  }
}

/** "environments/<x>/environment.prod.ts" in the build's fileReplacements → "<x>". */
export function envFolderOf(build: Json): string | undefined {
  const sets = [build['options'], ...Object.values(objectField(build, 'configurations'))];
  for (const set of sets) {
    const replacements = isObject(set) ? set['fileReplacements'] : undefined;
    if (!Array.isArray(replacements)) continue;
    for (const r of replacements) {
      const w = isObject(r) ? r['with'] ?? r['replaceWith'] : undefined;
      const m = typeof w === 'string' ? /^(?:\.\/)?environments\/([^/]+)\/[^/]+$/.exec(w) : null;
      if (m) return m[1];
    }
  }
  return undefined;
}
