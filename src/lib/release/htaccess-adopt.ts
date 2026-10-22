import { readJson, Tree, writeJson } from '@nx/devkit';

import { htaccessSourcePath } from './htaccess';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const RELEASE_EXECUTOR = '@mouryaamit/nx-polystack:build';

export interface AdoptHtaccessResult {
  /** The .htaccess the build target copied (workspace-relative), when there was one. */
  source?: string;
  /** environments/<envProject>/htaccess.<env> files written. */
  written: string[];
  /** Files that already existed and were kept. */
  kept: string[];
  /** The release target got htaccess: false (no .htaccess was built before). */
  disabled: boolean;
  /** Release envs without an htaccess.<env> while others have one (nothing was written). */
  missing: string[];
}

/** The workspace path a build `assets` entry copies when it is a .htaccess file, else undefined. */
function htaccessAsset(entry: unknown): string | undefined {
  if (typeof entry === 'string') return /(^|\/)\.htaccess$/.test(entry) ? entry : undefined;
  if (isObject(entry) && entry['glob'] === '.htaccess' && typeof entry['input'] === 'string') {
    return `${(entry['input'] as string).replace(/\/+$/, '')}/.htaccess`;
  }
  return undefined;
}

/** Drops .htaccess entries from an assets list; returns the paths they copied. */
function dropHtaccessAssets(options: unknown): string[] {
  if (!isObject(options) || !Array.isArray(options['assets'])) return [];
  const found: string[] = [];
  options['assets'] = (options['assets'] as unknown[]).filter((a) => {
    const p = htaccessAsset(a);
    if (p) found.push(p);
    return p === undefined;
  });
  return found;
}

/**
 * Moves an app to environment-specific .htaccess files, keeping what its release builds contain:
 * the .htaccess its build target copied becomes environments/<envProject>/htaccess.<env> for every
 * release env (identical copies) and leaves the build assets; an app that built none gets
 * htaccess: false on its release target. Existing env files are never replaced.
 */
export function adoptHtaccess(tree: Tree, projectJsonPath: string): AdoptHtaccessResult {
  const result: AdoptHtaccessResult = { written: [], kept: [], disabled: false, missing: [] };
  const pj = readJson<Json>(tree, projectJsonPath);
  const targets = isObject(pj['targets']) ? (pj['targets'] as Record<string, Json>) : {};
  const release = Object.values(targets).find((t) => t['executor'] === RELEASE_EXECUTOR);
  if (!release) return result;
  const options = isObject(release['options']) ? release['options'] : (release['options'] = {});
  if (options['htaccess'] === false) return result;

  // The Angular target the release builds (options.buildTarget "project:target[:config]").
  const buildTargetName =
    typeof options['buildTarget'] === 'string'
      ? String(options['buildTarget']).split(':')[1] ?? 'build'
      : 'build';
  const build = targets[buildTargetName] ?? targets['build'];
  const copied = [
    ...dropHtaccessAssets(build?.['options']),
    ...Object.values(
      isObject(build?.['configurations']) ? (build?.['configurations'] as Json) : {},
    ).flatMap((c) => dropHtaccessAssets(c)),
  ];
  const source = copied.find((p) => tree.exists(p) && tree.isFile(p));
  const envProject = String(options['envProject'] ?? pj['name']);
  const configs = isObject(release['configurations']) ? (release['configurations'] as Json) : {};
  const envs = [
    ...new Set(
      Object.entries(configs).map(([name, c]) =>
        String((isObject(c) ? c['env'] : undefined) ?? name).toLowerCase(),
      ),
    ),
  ];

  const existing = envs.filter((env) => tree.exists(htaccessSourcePath(envProject, env)));
  if (!source && existing.length > 0) {
    // Already on env files (an app made by pstack app 1.5.1 or later, or by hand): kept as is.
    result.kept.push(...existing.map((env) => htaccessSourcePath(envProject, env)));
    result.missing = envs.filter((env) => !existing.includes(env));
  } else if (!source || envs.length === 0) {
    options['htaccess'] = false;
    result.disabled = true;
  } else {
    result.source = source;
    const content = tree.read(source) as Buffer;
    for (const env of envs) {
      const file = htaccessSourcePath(envProject, env);
      if (tree.exists(file)) {
        result.kept.push(file);
        continue;
      }
      tree.write(file, content);
      result.written.push(file);
    }
    // Moved: the build no longer copies it, and the env files are the only copies.
    tree.delete(source);
  }
  writeJson(tree, projectJsonPath, pj);
  return result;
}

/** What adoptHtaccess did, as a migration report note (none when nothing changed). */
export function htaccessNote(r: AdoptHtaccessResult, name: string, notes: string[]): void {
  const code = (s: string) => `\`${s}\``;
  if (r.disabled) {
    notes.push(
      'release builds make no `.htaccess` (`htaccess: false`: the app had none); for one, add ' +
        `${code(`environments/${name}/htaccess.<env>`)} for each env and remove the option`,
    );
  } else if (r.missing.length > 0) {
    notes.push(
      `no ${r.missing.map((e) => code(`htaccess.${e}`)).join(', ')} next to ` +
        `${r.kept.map(code).join(', ')}; release builds of ${r.missing.join(', ')} fail until it ` +
        'is added (`pstack csp` writes it)',
    );
  } else if (r.source) {
    notes.push(
      `${code(r.source)} became the env files ${[...r.written, ...r.kept].map(code).join(', ')} ` +
        '(each release build copies its own env file as `.htaccess`)',
    );
  }
}
