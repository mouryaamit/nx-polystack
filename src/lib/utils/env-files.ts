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

export interface FlutterEnvFilesOptions {
  /** Leave env/<env>.json files that already exist in the tree as they are. */
  keepExisting?: boolean;
  /** Write `{}` instead of the example values (for apps with their own configuration). */
  empty?: boolean;
  /** Project root (default apps/<name>). */
  root?: string;
}

/** apps/<name>/env/{dev,uat,prod}.json; returns the files written. */
export function generateFlutterEnvFiles(
  tree: Tree,
  projectName: string,
  opts: FlutterEnvFilesOptions = {},
): string[] {
  const base = `${opts.root ?? `apps/${projectName}`}/env`;
  const files: Record<string, object> = {
    dev: { FLUTTER_ENV: 'dev', API_BASE_URL: 'https://dev.example.com' },
    uat: { FLUTTER_ENV: 'uat', API_BASE_URL: 'https://uat.example.com' },
    prod: { FLUTTER_ENV: 'prod', API_BASE_URL: 'https://example.com' },
  };
  const written: string[] = [];
  for (const [env, content] of Object.entries(files)) {
    const file = `${base}/${env}.json`;
    if (opts.keepExisting && tree.exists(file)) continue;
    tree.write(file, opts.empty ? '{}\n' : JSON.stringify(content, null, 2) + '\n');
    written.push(file);
  }
  return written;
}
