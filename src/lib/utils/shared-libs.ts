import { Tree } from '@nx/devkit';

import { scanProjects } from './project-json-files';

export const SHARED_ASSETS_OUTPUT = 'assets/shared';
/** Files of the shared assets folder that are not app assets (lib config, docs, sources). */
export const SHARED_ASSETS_IGNORE = [
  '**/project.json',
  '**/*.md',
  '**/.gitkeep',
  '**/.eslintrc*',
  '**/tsconfig*.json',
  '**/jest.config.*',
  '**/*.ts',
];

export interface SharedLib {
  /** Workspace-relative folder wired into apps (the project's sourceRoot when it has one). */
  dir: string;
  /** Nx project name of the folder, when it has a project.json. */
  project?: string;
}

export interface SharedLibs {
  assets: SharedLib;
  styles: SharedLib;
  /** Files written (folders created on first use). */
  created: string[];
  notes: string[];
}

const THEME_SCSS =
  '// Shared theme. Apps include this folder in their Sass load path:\n' +
  "//   @use 'theme';\n" +
  '$brand-primary: #3f51b5 !default;\n' +
  '$brand-accent: #ff4081 !default;\n' +
  "$font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif !default;\n";

function folderExists(tree: Tree, dir: string): boolean {
  return tree.exists(dir) && !tree.isFile(dir);
}

/** Workspace-relative path without ./, duplicate or trailing slashes. */
export function normPath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/** Whether `a` is `b` or inside it, or `b` inside `a`. */
function overlaps(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * libs/shared/assets and libs/shared/styles, or a migrated workspace's libs/assets and
 * libs/styles; creates what is missing (seed file and project.json). A folder that is already an
 * Nx project is wired through its sourceRoot.
 */
export function ensureSharedLibs(tree: Tree): SharedLibs {
  const projects = scanProjects(tree);
  const created: string[] = [];
  const notes: string[] = [];

  const pick = (kind: 'assets' | 'styles'): SharedLib => {
    const legacy = `libs/${kind}`;
    const shared = `libs/shared/${kind}`;
    // A new folder never goes inside another project (e.g. libs/shared being a library itself).
    const insideProject = (d: string) =>
      projects.some((p) => p.root !== '.' && d.startsWith(`${p.root}/`));
    const dir = folderExists(tree, shared)
      ? shared
      : folderExists(tree, legacy) || insideProject(shared)
      ? legacy
      : shared;
    const owner = projects.find((p) => p.root === dir);
    if (owner) {
      const src = owner.json['sourceRoot'];
      const inside =
        typeof src === 'string' && normPath(src).startsWith(`${dir}/`) ? normPath(src) : dir;
      if (kind === 'styles' && !tree.exists(`${inside}/_theme.scss`)) {
        notes.push(
          `${inside} has no _theme.scss; apps @use its files by name (e.g. @use 'index';).`,
        );
      }
      return { dir: inside, project: owner.name };
    }
    if (folderExists(tree, dir)) return { dir }; // a plain folder: used as it is

    const name = `shared-${kind}`;
    const seed = kind === 'assets' ? `${dir}/.gitkeep` : `${dir}/_theme.scss`;
    tree.write(seed, kind === 'assets' ? '' : THEME_SCSS);
    created.push(seed);
    const taken = projects.find((p) => p.name === name);
    if (taken) {
      notes.push(`${dir}: no project.json written, the name "${name}" is used by ${taken.root}.`);
      return { dir };
    }
    const depth = dir.split('/').length;
    const json = {
      name,
      $schema: `${'../'.repeat(depth)}node_modules/nx/schemas/project-schema.json`,
      projectType: 'library',
      sourceRoot: dir,
      tags: ['scope:shared', `type:${kind}`],
      targets: {},
    };
    tree.write(`${dir}/project.json`, JSON.stringify(json, null, 2) + '\n');
    created.push(`${dir}/project.json`);
    return { dir, project: name };
  };

  return { assets: pick('assets'), styles: pick('styles'), created, notes };
}

type BuildTarget = { executor?: string; options?: Record<string, unknown> };

const ANGULAR_BROWSER_BUILDER =
  /^(@angular-devkit\/build-angular|@angular\/build|@nx\/angular):(browser|application|browser-esbuild|webpack-browser)$/;

/** The Angular browser build target of a project.json (`build` first), or undefined. */
export function angularBuildTargetOf(json: Record<string, unknown>): BuildTarget | undefined {
  const targets = (json['targets'] ?? {}) as Record<string, BuildTarget>;
  const isAngular = (t: BuildTarget | undefined) =>
    !!t && ANGULAR_BROWSER_BUILDER.test(String(t.executor));
  if (isAngular(targets['build'])) return targets['build'];
  return Object.values(targets).find(isAngular);
}

/**
 * Wires the shared folders into an app's project.json (build assets, Sass include path,
 * implicitDependencies); returns false when it already was.
 */
export function wireSharedLibs(
  json: Record<string, unknown>,
  build: BuildTarget,
  libs: Pick<SharedLibs, 'assets' | 'styles'>,
): boolean {
  let changed = false;
  build.options = build.options ?? {};
  const options = build.options;

  const assets = Array.isArray(options['assets']) ? (options['assets'] as unknown[]) : [];
  const hasAssets = assets.some((a) => {
    const input =
      typeof a === 'string'
        ? a
        : typeof a === 'object' && a !== null
        ? (a as Record<string, unknown>)['input']
        : undefined;
    return typeof input === 'string' && overlaps(input, libs.assets.dir);
  });
  if (!hasAssets) {
    assets.push({
      glob: '**/*',
      input: libs.assets.dir,
      output: SHARED_ASSETS_OUTPUT,
      ignore: [...SHARED_ASSETS_IGNORE],
    });
    options['assets'] = assets;
    changed = true;
  }

  const spo = (options['stylePreprocessorOptions'] ?? {}) as Record<string, unknown>;
  const includePaths = Array.isArray(spo['includePaths']) ? (spo['includePaths'] as string[]) : [];
  if (!includePaths.some((p) => typeof p === 'string' && overlaps(p, libs.styles.dir))) {
    includePaths.push(libs.styles.dir);
    options['stylePreprocessorOptions'] = { ...spo, includePaths };
    changed = true;
  }

  const deps = [libs.assets.project, libs.styles.project].filter((d): d is string => !!d);
  if (deps.length > 0) {
    const implicit = Array.isArray(json['implicitDependencies'])
      ? (json['implicitDependencies'] as string[])
      : [];
    const missing = deps.filter((d) => !implicit.includes(d));
    if (missing.length > 0) {
      json['implicitDependencies'] = [...implicit, ...missing];
      changed = true;
    }
  }
  return changed;
}
