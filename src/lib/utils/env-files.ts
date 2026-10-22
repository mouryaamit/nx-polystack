import { Tree } from '@nx/devkit';

import { EnvLayout, PER_ENV_ROOT_FILE } from './angular-project';

/**
 * environments/<app>/environment.ts (dev), .uat.ts and .prod.ts; in the per-env layout
 * environment.dev.ts instead of environment.ts, plus the shared environments/environment.ts
 * (created when missing) that the app imports and its build configurations replace.
 */
export function generateAngularEnvFiles(
  tree: Tree,
  projectName: string,
  layout: EnvLayout = 'default',
): void {
  const base = `environments/${projectName}`;
  tree.write(
    layout === 'per-env' ? `${base}/environment.dev.ts` : `${base}/environment.ts`,
    `export const environment = {\n  production: false,\n  envName: 'dev',\n};\n`,
  );
  tree.write(
    `${base}/environment.uat.ts`,
    `export const environment = {\n  production: false,\n  envName: 'uat',\n};\n`,
  );
  tree.write(
    `${base}/environment.prod.ts`,
    `export const environment = {\n  production: true,\n  envName: 'prod',\n};\n`,
  );
  if (layout === 'per-env' && !tree.exists(PER_ENV_ROOT_FILE)) {
    tree.write(
      PER_ENV_ROOT_FILE,
      "// Replaced at build time by each app's environments/<app>/environment.<env>.ts\n" +
        '// (fileReplacements in its project.json). Only the shape matters here.\n' +
        `export const environment = {\n  production: false,\n  envName: 'dev',\n};\n`,
    );
  }
}

/** Every env file of a project lives in environments/<envProject>/ (Angular, Ionic and Flutter). */
export const ENV_ROOT = 'environments';

/** environments/<envProject>/environment.<env>.json: a Flutter app's --dart-define-from-file. */
export function flutterEnvFile(envProject: string, env: string): string {
  return `${ENV_ROOT}/${envProject}/environment.${env}.json`;
}

/** The env names of a Flutter app's environment.<env>.json files, sorted. */
export function flutterEnvNames(tree: Tree, envProject: string): string[] {
  const dir = `${ENV_ROOT}/${envProject}`;
  if (!tree.exists(dir) || tree.isFile(dir)) return [];
  return tree
    .children(dir)
    .map((f) => /^environment\.(.+)\.json$/.exec(f)?.[1])
    .filter((e): e is string => e !== undefined && tree.isFile(flutterEnvFile(envProject, e)))
    .sort();
}

export interface FlutterEnvFilesOptions {
  /** Leave env files that already exist in the tree as they are. */
  keepExisting?: boolean;
  /** Write `{}` instead of the example values (for apps with their own configuration). */
  empty?: boolean;
}

/** environments/<name>/environment.{dev,uat,prod}.json; returns the files written. */
export function generateFlutterEnvFiles(
  tree: Tree,
  projectName: string,
  opts: FlutterEnvFilesOptions = {},
): string[] {
  const files: Record<string, object> = {
    dev: { FLUTTER_ENV: 'dev', API_BASE_URL: 'https://dev.example.com' },
    uat: { FLUTTER_ENV: 'uat', API_BASE_URL: 'https://uat.example.com' },
    prod: { FLUTTER_ENV: 'prod', API_BASE_URL: 'https://example.com' },
  };
  const written: string[] = [];
  for (const [env, content] of Object.entries(files)) {
    const file = flutterEnvFile(projectName, env);
    if (opts.keepExisting && tree.exists(file)) continue;
    tree.write(file, opts.empty ? '{}\n' : JSON.stringify(content, null, 2) + '\n');
    written.push(file);
  }
  return written;
}

export interface MovedEnvFiles {
  /** [from, to] pairs. */
  moved: [string, string][];
  /** Files left where they were: the target already existed. */
  kept: string[];
}

/**
 * Moves a Flutter app's <root>/env/<env>.json files to environments/<envProject>/
 * environment.<env>.json (an existing target is never replaced; the file then stays).
 */
export function moveFlutterEnvFiles(tree: Tree, root: string, envProject: string): MovedEnvFiles {
  const out: MovedEnvFiles = { moved: [], kept: [] };
  const dir = `${root}/env`;
  if (!tree.exists(dir) || tree.isFile(dir)) return out;
  for (const f of [...tree.children(dir)].sort()) {
    const m = /^(.+)\.json$/.exec(f);
    const from = `${dir}/${f}`;
    if (!m || !tree.isFile(from)) continue;
    const to = flutterEnvFile(envProject, m[1]);
    if (tree.exists(to)) {
      out.kept.push(from);
      continue;
    }
    tree.write(to, tree.read(from) as Buffer);
    tree.delete(from);
    out.moved.push([from, to]);
  }
  return out;
}
