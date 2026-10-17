import { Tree, updateJson } from '@nx/devkit';

export interface AddNpmScriptsOptions {
  /** Overwrite existing scripts without throwing. Default false. */
  force?: boolean;
}

export function addNpmScripts(
  tree: Tree,
  scripts: Record<string, string>,
  opts: AddNpmScriptsOptions = {},
): void {
  updateJson(tree, 'package.json', (pkg: { scripts?: Record<string, string> }) => {
    pkg.scripts = pkg.scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (pkg.scripts[name] !== undefined && !opts.force) {
        throw new Error(
          `addNpmScripts: script "${name}" already exists; pass force=true to overwrite`,
        );
      }
      pkg.scripts[name] = cmd;
    }
    return pkg;
  });
}

export function removeNpmScripts(tree: Tree, names: string[]): void {
  updateJson(tree, 'package.json', (pkg: { scripts?: Record<string, string> }) => {
    if (!pkg.scripts) return pkg;
    for (const name of names) delete pkg.scripts[name];
    return pkg;
  });
}
