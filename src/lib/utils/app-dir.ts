import { Tree } from '@nx/devkit';

/** Kebab-case app, folder, report and prefix names. */
export const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Folder levels under apps/ that the project scans (4 levels) reach: apps/a/b/c/<name>. */
export const MAX_DIR_DEPTH = 3;

/** Folder names the workspace .gitignore ignores anywhere. */
const RESERVED_DIRS = ['dist', 'tmp', 'coverage', 'out-tsc'];

/**
 * --dir: kebab-case folder names separated by "/" — apps/<dir>/<name> (at most MAX_DIR_DEPTH) or,
 * for libraries, libs/<scope>/<dir>/<name> (`maxDepth` 2). `label` starts the error messages
 * ("migrate", "app generator", "lib generator").
 */
export function parseDir(
  value: string | undefined,
  label = 'migrate',
  maxDepth = MAX_DIR_DEPTH,
): string | undefined {
  if (value === undefined) return undefined;
  const parts = value.split('/');
  if (value === '' || parts.some((p) => !NAME_RE.test(p))) {
    throw new Error(
      `${label}: --dir="${value}" must be kebab-case folder names separated by "/" ` +
        '(for example legacy or legacy/web).',
    );
  }
  if (parts.length > maxDepth) {
    throw new Error(
      `${label}: --dir="${value}" is too deep: at most ${maxDepth} folder${
        maxDepth > 1 ? 's' : ''
      }, so the workspace scans (4 levels under apps/ and libs/) still find the project.`,
    );
  }
  const reserved = parts.find((p) => RESERVED_DIRS.includes(p));
  if (reserved) {
    throw new Error(
      `${label}: --dir="${value}" uses "${reserved}", which the workspace .gitignore hides; ` +
        'pick another folder name.',
    );
  }
  return value;
}

/** Refuses a --dir whose folders under `base` already hold a project (projects cannot be nested). */
export function assertDirOutsideProjects(
  tree: Tree,
  dir: string,
  label = 'migrate',
  base = 'apps',
): void {
  const parts = dir.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const folder = `${base}/${parts.slice(0, i).join('/')}`;
    if (tree.exists(`${folder}/project.json`) || tree.exists(`${folder}/pubspec.yaml`)) {
      throw new Error(
        `${label}: --dir="${dir}" goes through the project in "${folder}"; projects cannot be ` +
          'nested inside another project. Pick another --dir.',
      );
    }
  }
}

/** apps/<dir>/<name>, or apps/<name> without a dir. */
export const appRoot = (name: string, dir?: string): string =>
  dir ? `apps/${dir}/${name}` : `apps/${name}`;

/** "../" once per segment of a workspace-relative folder ("apps/a/b" → "../../../"). */
export const upTo = (root: string): string => '../'.repeat(root.split('/').length);
